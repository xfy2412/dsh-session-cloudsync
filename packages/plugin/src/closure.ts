/**
 * 会话闭包规划：根会话 + 全部子代理后代，子先父后。
 *
 * 只做纯计算，不碰持久化。`syncOnce` 用它决定推送顺序与跳过原因；
 * `/api/session-cloudsync/workspaces` 用同一棵树生成同步列表。
 *
 * @module dsh-session-cloudsync/closure
 */

/** 规划需要的会话头字段。 */
export interface ClosureHeader {
  /** 会话 id。 */
  readonly id: string
  /** 创建时间，用于同层稳定排序。 */
  readonly createdAt: number
  /** 会话工作目录；白名单按它匹配。 */
  readonly cwd?: string
  /** `subagent` 表示子代理会话；fork 没有这个字段。 */
  readonly origin?: string
  /** 父会话；子代理与 fork 都会写。 */
  readonly parentSession?: string
  /** DSH 记录的委托深度（本模块用父链自算，不依赖它）。 */
  readonly delegationDepth?: number
}

/** 带会话头的快照。 */
export interface ClosureSnapshot {
  /** DSH 持久化快照的头。 */
  readonly header: ClosureHeader
}

/** 一个根及其后代。 */
export interface ClosureRoot<T> {
  /** 根会话。 */
  readonly root: T
  /** 后代，按深度从深到浅排序。 */
  readonly descendants: readonly { readonly snapshot: T; readonly depth: number }[]
}

/** 一棵会话树。 */
export interface SessionTree<T> {
  /** 所有非子代理会话（含 fork）作为根。 */
  readonly roots: readonly ClosureRoot<T>[]
  /** 找不到根或父链损坏的子代理。 */
  readonly orphans: readonly { readonly snapshot: T; readonly reason: string }[]
}

/** 闭包规划选项。 */
export interface ClosureOptions {
  /** 是否把子代理后代一起同步。 */
  readonly includeSubagents: boolean
  /** 用户选中的根会话 id；缺省表示全选（底层兼容）。 */
  readonly selectedSessionIds?: readonly string[]
}

/** 计划同步的会话。 */
export interface PlannedSession<T> {
  /** 原始快照。 */
  readonly snapshot: T
  /** 所属根会话 id。 */
  readonly rootId: string
  /** 到根的父链深度；根为 0。 */
  readonly depth: number
  /** 是否是子代理。 */
  readonly isSubagent: boolean
}

/** 不参与本轮同步的会话。 */
export interface SkippedSession<T> {
  /** 原始快照。 */
  readonly snapshot: T
  /** 可读原因，直接进状态视图。 */
  readonly reason: string
}

/** 规划结果。 */
export interface ClosurePlan<T> {
  /** 推送顺序：每个根的后代（深到浅）在前，根最后。 */
  readonly planned: readonly PlannedSession<T>[]
  /** 跳过的会话与原因。 */
  readonly skipped: readonly SkippedSession<T>[]
}

/**
 * 把路径规范化成比较键。
 *
 * Windows 路径大小写不敏感、`\` 与 `/` 等价；其他平台保留大小写。
 * 只做字符串规范化，不做 realpath——工作区注册表给的已经是规范路径。
 *
 * @param value - 工作区路径或会话 cwd。
 * @returns 比较键。
 */
export function pathKeyOf(value: string): string {
  const normalized = value.trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 把快照按父链聚成根 + 后代。
 *
 * 只有 `origin === 'subagent'` 的会话算后代；fork 虽然也有
 * `parentSession`，但它是独立根。父链缺失或成环的会话进入 orphan。
 *
 * @param snapshots - 全部本地会话快照。
 * @returns 根列表与孤儿列表。
 */
export function buildSessionTree<T extends ClosureSnapshot>(snapshots: readonly T[]): SessionTree<T> {
  const byId = new Map<string, T>()
  for (const snapshot of snapshots) byId.set(snapshot.header.id, snapshot)

  const roots = new Map<string, { root: T; descendants: Array<{ snapshot: T; depth: number }> }>()
  for (const snapshot of snapshots) {
    if (snapshot.header.origin !== 'subagent') roots.set(snapshot.header.id, { root: snapshot, descendants: [] })
  }

  const orphans: Array<{ snapshot: T; reason: string }> = []
  for (const snapshot of snapshots) {
    if (snapshot.header.origin !== 'subagent') continue
    const resolved = resolveSubagent(snapshot, byId)
    if ('reason' in resolved) {
      orphans.push({ snapshot, reason: resolved.reason })
      continue
    }
    const entry = roots.get(resolved.root.header.id)
    if (entry === undefined) {
      orphans.push({ snapshot, reason: '父链没有落到任何根会话' })
      continue
    }
    entry.descendants.push({ snapshot, depth: resolved.depth })
  }

  for (const entry of roots.values()) {
    entry.descendants.sort((left, right) =>
      right.depth - left.depth
      || left.snapshot.header.createdAt - right.snapshot.header.createdAt
      || left.snapshot.header.id.localeCompare(right.snapshot.header.id),
    )
  }

  return {
    roots: [...roots.values()].map((entry) => ({ root: entry.root, descendants: entry.descendants })),
    orphans,
  }
}

/**
 * 按白名单与子代理开关生成推送计划。
 *
 * 子代理跟随根的 cwd 判定白名单：根不在白名单时，整棵子树都不推。
 *
 * @param snapshots - 全部本地会话快照。
 * @param options - 子代理开关与工作区白名单。
 * @returns 推送顺序与跳过原因。
 */
export function planSessionClosure<T extends ClosureSnapshot>(
  snapshots: readonly T[],
  options: ClosureOptions,
): ClosurePlan<T> {
  const tree = buildSessionTree(snapshots)
  const planned: PlannedSession<T>[] = []
  const skipped: SkippedSession<T>[] = [...tree.orphans]
  const selected = options.selectedSessionIds === undefined
    ? undefined
    : new Set(options.selectedSessionIds)

  for (const { root, descendants } of tree.roots) {
    if (selected !== undefined && !selected.has(root.header.id)) {
      skipped.push({ snapshot: root, reason: '根会话未选中' })
      for (const descendant of descendants) {
        skipped.push({ snapshot: descendant.snapshot, reason: '根会话未选中' })
      }
      continue
    }
    if (options.includeSubagents) {
      for (const descendant of descendants) {
        planned.push({
          snapshot: descendant.snapshot,
          rootId: root.header.id,
          depth: descendant.depth,
          isSubagent: true,
        })
      }
    } else {
      for (const descendant of descendants) {
        skipped.push({ snapshot: descendant.snapshot, reason: '子代理会话未启用' })
      }
    }
    planned.push({ snapshot: root, rootId: root.header.id, depth: 0, isSubagent: false })
  }

  return { planned, skipped }
}

/**
 * 沿父链找到一个非子代理根。
 * @param start - 子代理快照。
 * @param byId - 全部快照索引。
 * @returns 根与深度，或失败原因。
 */
function resolveSubagent<T extends ClosureSnapshot>(
  start: T,
  byId: ReadonlyMap<string, T>,
): { readonly root: T; readonly depth: number } | { readonly reason: string } {
  let current = start
  let depth = 0
  const seen = new Set<string>()
  while (current.header.origin === 'subagent') {
    if (seen.has(current.header.id)) return { reason: '子代理父链成环' }
    seen.add(current.header.id)
    const parentId = current.header.parentSession
    if (parentId === undefined) return { reason: '子代理缺少 parentSession' }
    const parent = byId.get(parentId)
    if (parent === undefined) return { reason: `找不到父会话 ${parentId}` }
    current = parent
    depth += 1
  }
  return { root: current, depth }
}
