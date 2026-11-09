/**
 * 同步规划：把本地快照与远端摘要归类成“每会话最多一个方向”的任务。
 *
 * 本模块只做纯计算，不读持久化、不发请求。真正的扫描由宿主把 local/remote
 * 两份摘要喂进来，执行器再按 action 调用 push/pull。
 *
 * @module dsh-session-cloudsync/sync-plan
 */
import { buildSessionTree, type ClosureHeader, type ClosureSnapshot } from './closure.ts'

/** 规划需要的本地快照：除闭包头外还需要格式代际与文件修订。 */
export interface LocalPlanSnapshot extends ClosureSnapshot {
  readonly header: ClosureHeader & { readonly version: number }
  /** DSH 的 opaque 文件修订；list() 不返回 eventCount，靠它判断本地是否变化。 */
  readonly revision?: string
  /**
   * 本地日志的物理字节数；JSONL 后端会提供。追加型日志上它比 revision 可靠：
   * 历史代际会话的 revision 会随整个存储根变化，字节数只随本会话追加而变。
   */
  readonly sizeBytes?: number
  /** 已由宿主补读的最末事件序号；只在无法用 revision/receipt 判断时使用。 */
  readonly lastSeq?: number
  /** 旧后端可能提供；当前 JSONL list() 通常不提供。 */
  readonly eventCount?: number
}

/** 远端摘要里规划需要的字段。 */
export interface RemoteSessionSummary {
  readonly sessionId: string
  readonly formatVersion: number
  readonly createdAt: number
  readonly lastSeq: number
  readonly headChainHash: string
  readonly workspaceKey?: string | null
  readonly safeThroughSeq?: number
  readonly tailOpen?: boolean
  readonly parentSession?: string | null
  readonly origin?: string | null
  readonly delegationDepth?: number | null
  readonly deletedAt?: number | null
}

/** 本地同步 receipt：证明这个会话上次已经对齐到哪里。 */
export interface SyncReceipt {
  readonly sessionId: string
  /** 上次 receipt 记录时的本地 opaque revision；旧 receipt 可能没有。 */
  readonly localRevision?: string
  /**
   * 上次 receipt 记录时的本地日志字节数。追加型日志上字节数不变就等价于
   * 没有新事件，比 revision 可靠：历史代际会话的 revision 末尾混入了整个
   * 存储根的语料指纹，别的会话一写就会变，会把会话误判成“本地领先”。
   */
  readonly localSizeBytes?: number
  readonly localEventCount: number
  readonly localLastSeq: number
  readonly remoteLastSeq: number
  readonly remoteHeadChainHash: string
  readonly formatVersion: number
  readonly checkedAt: number
}

/** 规划动作。 */
export type SyncAction = 'push' | 'pull' | 'none'

/** 一个会话的规划结果。 */
export interface SyncPlanEntry {
  readonly sessionId: string
  readonly rootId: string
  readonly parentSession?: string
  readonly depth: number
  readonly isSubagent: boolean
  readonly action: SyncAction
  readonly reason: 'local-ahead' | 'remote-ahead' | 'local-missing' | 'remote-missing' | 'up-to-date' | 'blocked'
  readonly localLastSeq?: number
  readonly remoteLastSeq?: number
  readonly remoteHeadChainHash?: string
  readonly local?: LocalPlanSnapshot
  readonly remote?: RemoteSessionSummary
  readonly error?: string
}

/** 规划结果。 */
export interface SyncPlan {
  readonly entries: readonly SyncPlanEntry[]
}

/** 规划输入。 */
export interface SyncPlanInput {
  /** 本地全部快照；必须来自 ctx.sessionPersistence.list()。 */
  readonly local: readonly LocalPlanSnapshot[]
  /** 远端摘要；可以包含未选中会话。 */
  readonly remote: readonly RemoteSessionSummary[]
  /** 用户选中的根会话。 */
  readonly selectedRoots: readonly string[]
  /** 是否包含子代理。 */
  readonly includeSubagents: boolean
  /** 已绑定到本机的远端 workspaceKey；用于发现远端-only 根。 */
  readonly boundWorkspaceKeys?: ReadonlySet<string>
  /** 上次成功对齐的 receipt。 */
  readonly receipts?: Readonly<Record<string, SyncReceipt>>
}

/**
 * 本地快照的最末事件序号。
 * @param snapshot - 本地快照。
 * @returns 序号；没有事件时为 -1。
 */
function localLastSeqOf(snapshot: LocalPlanSnapshot, receipt?: SyncReceipt): number {
  if (snapshot.lastSeq !== undefined) return snapshot.lastSeq
  if (snapshot.eventCount !== undefined) return snapshot.eventCount - 1
  return receipt?.localLastSeq ?? -1
}

/**
 * 远端摘要是否和 receipt 记录一致。
 * @param receipt - 上次 receipt。
 * @param remote - 远端摘要。
 * @returns 远端是否未变。
 */
function remoteUnchanged(receipt: SyncReceipt, remote: RemoteSessionSummary): boolean {
  return receipt.remoteLastSeq === remote.lastSeq
    && (receipt.remoteHeadChainHash === '' || receipt.remoteHeadChainHash === remote.headChainHash)
}

/**
 * 本地文件是否和 receipt 记录一致。
 * @param receipt - 上次 receipt。
 * @param snapshot - 当前本地快照。
 * @returns true/false；无法判断时为 undefined。
 */
function localUnchanged(receipt: SyncReceipt, snapshot: LocalPlanSnapshot): boolean | undefined {
  // 优先用字节数：JSONL 是追加型日志，字节数不变就是没有新事件。不能用
  // revision 判等——历史代际会话的 revision 会带上整个存储根的语料指纹，
  // 别的会话一写它就变，把整批老会话误判成“本地领先”（全部待上传）。
  if (receipt.localSizeBytes !== undefined && snapshot.sizeBytes !== undefined) {
    return receipt.localSizeBytes === snapshot.sizeBytes
  }
  if (receipt.localRevision !== undefined && snapshot.revision !== undefined) {
    return receipt.localRevision === snapshot.revision
  }
  if (snapshot.eventCount !== undefined) return receipt.localEventCount === snapshot.eventCount
  // 旧 receipt 没有 revision；远端未变时按已同步处理，下一轮 receipt 会补 revision。
  return undefined
}

/**
 * 从本地树构建 root/depth 索引。
 * @param local - 本地快照。
 * @param selectedRoots - 选中的根。
 * @param includeSubagents - 是否包含子代理。
 * @returns 选中的条目与 root 顺序。
 */
function localEntries(
  local: readonly LocalPlanSnapshot[],
  selectedRoots: readonly string[],
  includeSubagents: boolean,
): { readonly entries: Map<string, { rootId: string; depth: number; isSubagent: boolean }>; readonly rootOrder: readonly string[] } {
  const tree = buildSessionTree(local)
  const selected = new Set(selectedRoots)
  const entries = new Map<string, { rootId: string; depth: number; isSubagent: boolean }>()
  const rootOrder: string[] = []
  for (const root of tree.roots) {
    const id = String(root.root.header.id)
    if (!selected.has(id)) continue
    rootOrder.push(id)
    entries.set(id, { rootId: id, depth: 0, isSubagent: false })
    if (!includeSubagents) continue
    for (const descendant of root.descendants) {
      entries.set(String(descendant.snapshot.header.id), {
        rootId: id,
        depth: descendant.depth,
        isSubagent: true,
      })
    }
  }
  return { entries, rootOrder }
}

/**
 * 规划一轮同步。
 * @param input - 本地/远端摘要、选择与 receipt。
 * @returns 每个会话的规划结果；同一 session 只会有一个 action。
 */
export function planSync(input: SyncPlanInput): SyncPlan {
  const localById = new Map(input.local.map((snapshot) => [String(snapshot.header.id), snapshot]))
  const remoteById = new Map(input.remote.map((summary) => [summary.sessionId, summary]))
  const { entries: selectedLocal, rootOrder } = localEntries(input.local, input.selectedRoots, input.includeSubagents)
  const bound = input.boundWorkspaceKeys ?? new Set<string>()
  const entries: SyncPlanEntry[] = []
  const handled = new Set<string>()

  /**
   * 把一条本地会话转成规划结果。
   * @param sessionId - 会话 id。
   * @param meta - root/depth 元数据。
   */
  const addLocal = (sessionId: string, meta: { rootId: string; depth: number; isSubagent: boolean }): void => {
    if (handled.has(sessionId)) return
    handled.add(sessionId)
    const snapshot = localById.get(sessionId)
    if (snapshot === undefined) return
    const remote = remoteById.get(sessionId)
    const localLastSeq = localLastSeqOf(snapshot)
    if (remote === undefined) {
      entries.push({
        sessionId,
        rootId: meta.rootId,
        depth: meta.depth,
        isSubagent: meta.isSubagent,
        action: 'push',
        reason: 'remote-missing',
        localLastSeq,
        local: snapshot,
      })
      return
    }
    if (remote.deletedAt !== undefined && remote.deletedAt !== null) {
      entries.push({
        sessionId,
        rootId: meta.rootId,
        depth: meta.depth,
        isSubagent: meta.isSubagent,
        action: 'none',
        reason: 'blocked',
        localLastSeq,
        remoteLastSeq: remote.lastSeq,
        remoteHeadChainHash: remote.headChainHash,
        local: snapshot,
        remote,
        error: '远端已有墓碑',
      })
      return
    }
    if (remote.createdAt !== snapshot.header.createdAt || remote.formatVersion !== snapshot.header.version) {
      entries.push({
        sessionId,
        rootId: meta.rootId,
        depth: meta.depth,
        isSubagent: meta.isSubagent,
        action: 'none',
        reason: 'blocked',
        localLastSeq,
        remoteLastSeq: remote.lastSeq,
        remoteHeadChainHash: remote.headChainHash,
        local: snapshot,
        remote,
        error: '生命周期或格式代际不一致',
      })
      return
    }
    const receipt = input.receipts?.[sessionId]
    const localLast = localLastSeqOf(snapshot, receipt)
    const localKnown = snapshot.lastSeq !== undefined || snapshot.eventCount !== undefined
    const localSame = receipt === undefined ? undefined : localUnchanged(receipt, snapshot)
    let action: SyncAction
    let reason: SyncPlanEntry['reason']
    if (receipt !== undefined) {
      const remoteSame = remoteUnchanged(receipt, remote)
      if (remoteSame && localSame !== false) {
        action = 'none'
        reason = 'up-to-date'
      } else if (remoteSame) {
        action = 'push'
        reason = 'local-ahead'
      } else if (localSame === true) {
        action = 'pull'
        reason = 'remote-ahead'
      } else if (localKnown) {
        action = localLast === remote.lastSeq ? 'none' : localLast < remote.lastSeq ? 'pull' : 'push'
        reason = action === 'none' ? 'up-to-date' : action === 'pull' ? 'remote-ahead' : 'local-ahead'
      } else if (receipt.localLastSeq === remote.lastSeq) {
        action = 'none'
        reason = 'up-to-date'
      } else {
        action = receipt.localLastSeq < remote.lastSeq ? 'pull' : 'push'
        reason = action === 'pull' ? 'remote-ahead' : 'local-ahead'
      }
    } else if (localKnown) {
      action = localLast === remote.lastSeq ? 'none' : localLast < remote.lastSeq ? 'pull' : 'push'
      reason = action === 'none' ? 'up-to-date' : action === 'pull' ? 'remote-ahead' : 'local-ahead'
    } else {
      // 宿主没有补读到 lastSeq：保守地按远端领先处理，执行前仍会读本地校验。
      action = 'pull'
      reason = 'remote-ahead'
    }
    entries.push({
      sessionId,
      rootId: meta.rootId,
      depth: meta.depth,
      isSubagent: meta.isSubagent,
      action,
      reason,
      localLastSeq: localLast,
      remoteLastSeq: remote.lastSeq,
      remoteHeadChainHash: remote.headChainHash,
      local: snapshot,
      remote,
    })
  }

  for (const rootId of rootOrder) {
    const meta = selectedLocal.get(rootId)
    if (meta !== undefined) addLocal(rootId, meta)
  }
  for (const [sessionId, meta] of selectedLocal) {
    if (sessionId !== meta.rootId) addLocal(sessionId, meta)
  }

  // 远端-only 会话：本地不存在，沿 parentSession 找已选中的根；找不到时
  // 只在它落在一个已绑定的 workspaceKey 上才作为新根拉取。
  for (const remote of input.remote) {
    if (handled.has(remote.sessionId) || localById.has(remote.sessionId)) continue
    if (remote.deletedAt !== undefined && remote.deletedAt !== null) continue
    let current: RemoteSessionSummary | undefined = remote
    const chain: string[] = []
    let rootId = remote.sessionId
    let depth = 0
    while (current?.parentSession !== undefined && current.parentSession !== null) {
      chain.push(current.parentSession)
      depth += 1
      const parent = remoteById.get(current.parentSession)
      if (parent === undefined) break
      current = parent
      rootId = parent.sessionId
      if (selectedLocal.has(rootId)) break
    }
    const parentSelected = selectedLocal.has(rootId)
    const rootWorkspaceKey = remoteById.get(rootId)?.workspaceKey ?? remote.workspaceKey
    const workspaceBound = typeof rootWorkspaceKey === 'string' && bound.has(rootWorkspaceKey)
    if (!parentSelected && !workspaceBound) continue
    const parentSession = remote.parentSession ?? undefined
    entries.push({
      sessionId: remote.sessionId,
      rootId: parentSelected ? rootId : remote.sessionId,
      ...parentSession === undefined ? {} : { parentSession },
      depth: parentSelected ? depth : 0,
      isSubagent: remote.origin === 'subagent',
      action: 'pull',
      reason: 'local-missing',
      remoteLastSeq: remote.lastSeq,
      remoteHeadChainHash: remote.headChainHash,
      remote,
    })
    handled.add(remote.sessionId)
  }

  // 稳定展示顺序：根顺序 → 深度 → sessionId；执行器可以另按方向排序。
  const rootOrdinal = new Map(rootOrder.map((id, index) => [id, index]))
  entries.sort((left, right) => {
    const leftRoot = rootOrdinal.get(left.rootId) ?? Number.MAX_SAFE_INTEGER
    const rightRoot = rootOrdinal.get(right.rootId) ?? Number.MAX_SAFE_INTEGER
    return leftRoot - rightRoot
      || left.depth - right.depth
      || left.sessionId.localeCompare(right.sessionId)
  })
  return { entries }
}
