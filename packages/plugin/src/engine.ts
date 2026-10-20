/**
 * M3 推送引擎：枚举本地会话，把事件批次推到自部署服务端。
 *
 * 不做拉取、不做客户端 UI；只负责“本地 → 服务端”的增量追加。链的第 0 个
 * 条目是封好的会话头（seq=-1），事件批次从下标 1 开始；服务端只存不透明
 * 密文，不解析内容。
 *
 * @module dsh-session-sync/engine
 */
import {
  DEFAULT_BATCH_BYTES,
  DEFAULT_BATCH_EVENTS,
  headerChainHash,
  headerMetaOf,
  openEventBatch,
  openHeader,
  planEventBatches,
  sealEventBatch,
  sealHeader,
  type SessionHeaderLike,
  type SessionHeaderMeta,
  type SyncEvent,
} from '../../shared/src/batches.ts'
import { deriveMasterKey, sha256 } from '../../shared/src/crypto.ts'
import {
  sessionKeyOf,
  type SealedFrame,
  type SealedFrameRef,
} from '../../shared/src/sealed-frame.ts'
import { pathAllowed, planSessionClosure } from './closure.ts'

/** 服务端会话头/快照里本引擎需要的字段。 */
export interface SnapshotLike {
  readonly header: SessionHeaderLike & { readonly id: string; readonly cwd?: string }
  readonly eventCount?: number
  readonly sizeBytes?: number
}

/** 读句柄的最小接口。 */
export interface ReadHandleLike {
  readonly header: SessionHeaderLike & { readonly id: string }
  readonly inheritedEventCount?: number
  read(): Promise<{ readonly events: readonly SyncEvent[] }>
  close(): Promise<void>
}

/** persistence 服务的最小接口。 */
export interface PersistenceLike {
  list(): Promise<readonly SnapshotLike[]>
  open(id: string, access: 'read'): Promise<ReadHandleLike>
}

/** 写句柄的最小接口。 */
export interface WriteHandleLike extends ReadHandleLike {
  append(events: readonly SyncEvent[]): Promise<void>
  flush(): Promise<void>
}

/** 创建本地会话头的字段。 */
export interface CreateHeaderLike {
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd: string
  readonly isSeeded: boolean
  readonly delegationDepth: number
  readonly agentPreset?: string
  readonly parentSession?: string
  readonly origin?: string
}

/** 创建会话的选项。 */
export interface CreateOptions {
  readonly inheritedEventCount?: number
}

/** 拉取所需的 persistence 接口。 */
export interface PullPersistenceLike {
  stat(id: string): Promise<SnapshotLike | undefined>
  create(header: CreateHeaderLike, options?: CreateOptions): Promise<WriteHandleLike>
  open(id: string, access: 'read' | 'write'): Promise<WriteHandleLike>
}

/** sessions 服务的最小接口。 */
export interface SessionsLike<Session> {
  get(id: string): Session | undefined
  flush(session: Session): Promise<boolean>
}

/** 一次同步的配置。 */
export interface EngineConfig {
  /** 服务端基地址，例如 `http://127.0.0.1:8787`。 */
  readonly serverUrl: string
  /** 设备 token。 */
  readonly token: string
  /** 同步口令；不落盘。 */
  readonly passphrase: string
  /** 可选：base64 的 16 字节 KDF 盐；缺省由服务端地址派生。 */
  readonly salt?: string
  /** 是否同步子代理会话，默认 true。 */
  readonly includeSubagents?: boolean
  /** 允许同步的工作区路径；空数组表示不采集任何会话。 */
  readonly workspaceAllowlist?: readonly string[]
  /** 单批事件上限，默认 50。 */
  readonly batchEvents?: number
  /** 单批规范 JSON 字节上限，默认 256 KiB。 */
  readonly batchBytes?: number
}

/** 日志接口。 */
export interface SyncLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 引擎依赖。 */
export interface SyncDeps<Session> {
  readonly persistence: PersistenceLike
  readonly sessions: SessionsLike<Session>
  readonly config: EngineConfig
  readonly logger?: SyncLogger
  /** 测试可替换；默认全局 fetch。 */
  readonly fetch?: typeof fetch
  /**
   * 判断事件尾巴是否还有未闭合的 turn；DSH 宿主传
   * `interruptedTurnClosers(events).length > 0`。缺省按闭合处理。
   */
  readonly isTailOpen?: (events: readonly SyncEvent[]) => boolean
}

/** 单个会话的同步结果。 */
export interface SessionSyncReport {
  readonly sessionId: string
  readonly status: 'pushed' | 'up-to-date' | 'remote-ahead' | 'lease-held' | 'skipped' | 'error'
  readonly batches?: number
  readonly bytes?: number
  readonly error?: string
  readonly kind?: SyncErrorKind
  /** 本地尾巴是否还有未闭合的 turn；只在读到事件后可知。 */
  readonly tailOpen?: boolean
}

/** 一次同步的总结果。 */
export interface SyncReport {
  readonly configured: boolean
  readonly reason?: string
  readonly sessions: readonly SessionSyncReport[]
}

/** 拉取依赖。 */
export interface PullDeps<Session> {
  readonly persistence: PullPersistenceLike
  readonly sessions: SessionsLike<Session>
  readonly config: EngineConfig
  /** 拉取到本地时使用的 workspace 路径。 */
  readonly workspacePath: string
  /** 拉取完成后挂回工作区；失败由调用方处理。 */
  readonly attach?: (sessionId: string) => Promise<void>
  readonly logger?: SyncLogger
  readonly fetch?: typeof fetch
  /** 在第一次本地写入之前落盘 pending 记录。 */
  readonly beforeApply?: (sessionId: string, targetSeq: number) => Promise<void>
  /** 本地追加、flush、attach 全部成功后清除 pending。 */
  readonly afterApply?: (sessionId: string) => Promise<void>
}

/** 一次未完成的拉取。 */
export interface PendingApply {
  readonly sessionId: string
  readonly targetSeq: number
  readonly at: number
}

/** 拉取游标。 */
export interface PullState {
  /** 已处理到的服务端 revision；0 表示从头扫描。 */
  readonly revision: number
  /** 上次崩溃前未完成的会话。 */
  readonly pending?: PendingApply
}

/** 单个会话的拉取结果。 */
export interface PullSessionReport {
  readonly sessionId: string
  readonly status: 'pulled' | 'up-to-date' | 'partial' | 'local-active' | 'local-ahead' | 'tombstone' | 'error'
  readonly applied?: number
  readonly error?: string
  readonly kind?: SyncErrorKind
}

/** 一次拉取的总结果。 */
export interface PullReport {
  readonly configured: boolean
  readonly reason?: string
  readonly sessions: readonly PullSessionReport[]
  readonly revision: number
}

/** 服务端 manifest 中本引擎需要的字段。 */
interface RemoteManifest {
  readonly sessionId: string
  readonly formatVersion: number
  readonly createdAt: number
  readonly lastSeq: number
  readonly tailOpen?: boolean
  readonly safeThroughSeq?: number
  readonly frames: readonly SealedFrameRef[]
  readonly updatedAt: number
  readonly deletedAt?: number
}

/** 服务端错误。 */
export class SyncHttpError extends Error {
  /** HTTP 状态码。 */
  readonly status: number
  /** 服务端错误码（如果有）。 */
  readonly code: string | undefined

  /**
   * @param message - 错误说明。
   * @param status - HTTP 状态码。
   * @param code - 服务端错误码。
   */
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'SyncHttpError'
    this.status = status
    this.code = code
  }
}

/**
 * 规范化服务端地址。
 * @param url - 配置里的地址。
 * @returns 去掉末尾斜杠的地址。
 */
function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/u, '')
}

/** 同步错误的粗分类，供退避与 UI 文案使用。 */
export type SyncErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'lease-held'
  | 'diverged'
  | 'gone'
  | 'quota'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'crypto'
  | 'format'
  | 'config'
  | 'unknown'

/** 分类后的错误。 */
export interface ClassifiedSyncError {
  readonly kind: SyncErrorKind
  readonly message: string
  readonly retryable: boolean
}

/**
 * 把异常归类成稳定的错误种类。
 * @param error - 同步过程中抛出的异常。
 * @returns 种类、可读消息与是否值得自动重试。
 */
export function classifySyncError(error: unknown): ClassifiedSyncError {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof SyncHttpError) {
    switch (error.status) {
      case 401: return { kind: 'auth', message, retryable: false }
      case 403: return { kind: 'forbidden', message, retryable: false }
      case 404: return { kind: 'not-found', message, retryable: false }
      case 410: return { kind: 'gone', message, retryable: false }
      case 507: return { kind: 'quota', message, retryable: true }
      case 429: return { kind: 'rate-limited', message, retryable: true }
      default: break
    }
    if (error.status === 409) {
      if (error.code === 'lease-held') return { kind: 'lease-held', message, retryable: true }
      if (error.code === 'diverged') return { kind: 'diverged', message, retryable: false }
      return { kind: 'format', message, retryable: false }
    }
    if (error.status >= 500) return { kind: 'server', message, retryable: true }
    return { kind: 'unknown', message, retryable: true }
  }
  if (/认证失败|keyId|明文哈希|解密|密钥/u.test(message)) return { kind: 'crypto', message, retryable: false }
  if (/seq|manifest|格式|会话头|批次/u.test(message)) return { kind: 'format', message, retryable: false }
  if (/fetch failed|ECONN|ETIMEDOUT|timeout|network|socket|ENOTFOUND/u.test(message)) return { kind: 'network', message, retryable: true }
  if (/未配置|配置/u.test(message)) return { kind: 'config', message, retryable: false }
  return { kind: 'unknown', message, retryable: true }
}

/**
 * 由服务端地址派生缺省盐；同一服务端的设备得到同一把盐。
 * @param base - 规范化后的服务端地址。
 * @returns 16 字节盐。
 */
function defaultSalt(base: string): Buffer {
  return Buffer.from(sha256(`dsh-session-sync/v1|${base}`).slice(0, 32), 'hex')
}

/**
 * 解析配置里的盐；缺省时按服务端地址派生。
 * @param config - 同步配置。
 * @param base - 规范化后的服务端地址。
 * @returns 16 字节盐。
 */
function resolveSalt(config: EngineConfig, base: string): Buffer {
  if (config.salt === undefined || config.salt === '') return defaultSalt(base)
  const salt = Buffer.from(config.salt, 'base64')
  if (salt.length !== 16) throw new Error('salt 必须是 base64 的 16 字节值')
  return salt
}

/**
 * 发一个请求并解析 JSON。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param path - 路径（以 `/` 开头）。
 * @param token - 设备 token。
 * @param init - 额外请求参数。
 * @returns 状态码与响应体。
 */
async function requestJson(
  fetchImpl: typeof fetch,
  base: string,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text === '' ? undefined : JSON.parse(text) as unknown,
  }
}

/**
 * 从响应体里取错误信息。
 * @param body - 响应体。
 * @returns 错误码与消息。
 */
function errorOf(body: unknown): { code?: string; message: string } {
  if (body === null || typeof body !== 'object') return { message: '服务端返回了非 JSON 错误' }
  const error = (body as Record<string, unknown>)['error']
  if (error === null || typeof error !== 'object') return { message: '服务端返回了未知错误' }
  const record = error as Record<string, unknown>
  return {
    ...typeof record['code'] === 'string' ? { code: record['code'] } : {},
    message: typeof record['message'] === 'string' ? record['message'] : '服务端返回了未知错误',
  }
}

/**
 * 读取远端 manifest；404 视为不存在。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param sessionId - 会话 id。
 * @returns manifest 或 undefined。
 */
async function readManifest(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  sessionId: string,
): Promise<RemoteManifest | undefined> {
  const { status, body } = await requestJson(fetchImpl, base, `/v1/sessions/${encodeURIComponent(sessionId)}/manifest`, token)
  if (status === 404) return undefined
  if (status !== 200) {
    const error = errorOf(body)
    throw new SyncHttpError(error.message, status, error.code)
  }
  if (body === null || typeof body !== 'object') throw new Error('manifest 响应不是对象')
  const value = (body as Record<string, unknown>)['value']
  if (value === null || typeof value !== 'object') throw new Error('manifest 响应缺少 value')
  const manifest = (value as Record<string, unknown>)['manifest']
  if (manifest === null || typeof manifest !== 'object') throw new Error('manifest 响应缺少 manifest')
  const record = manifest as Record<string, unknown>
  if (!Array.isArray(record['frames'])) throw new Error('manifest.frames 不是数组')
  return manifest as RemoteManifest
}

/**
 * 上传一个封好的 blob。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param sealed - 封好的条目。
 */
async function uploadBlob(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  sealed: SealedFrame,
): Promise<void> {
  const response = await fetchImpl(`${base}/v1/blobs?kind=frame`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    body: sealed.bytes,
  })
  const text = await response.text()
  if (response.status !== 200 && response.status !== 201) {
    const body = text === '' ? undefined : JSON.parse(text) as unknown
    const error = errorOf(body)
    throw new SyncHttpError(error.message, response.status, error.code)
  }
}

/**
 * 申请会话租约。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param sessionId - 会话 id。
 * @returns 是否拿到租约；409 返回 false。
 */
async function acquireLease(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  sessionId: string,
): Promise<boolean> {
  const { status, body } = await requestJson(fetchImpl, base, `/v1/sessions/${encodeURIComponent(sessionId)}/lease`, token, { method: 'POST' })
  if (status === 200) return true
  if (status === 409 && errorOf(body).code === 'lease-held') return false
  const error = errorOf(body)
  throw new SyncHttpError(error.message, status, error.code)
}

/**
 * 释放会话租约；失败不覆盖主错误。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param sessionId - 会话 id。
 */
async function releaseLease(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  sessionId: string,
): Promise<void> {
  try {
    await fetchImpl(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/lease`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
  } catch {
    // 租约到期会自然释放；释放失败不改变本次同步结果。
  }
}

/**
 * 追加批次。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param sessionId - 会话 id。
 * @param input - 追加参数。
 */
async function appendFrames(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  sessionId: string,
  input: {
    readonly baseIndex: number
    readonly baseChainHash: string | null
    readonly createdAt: number
    readonly formatVersion: number
    readonly frames: readonly SealedFrameRef[]
    readonly tailOpen?: boolean
    readonly safeThroughSeq?: number
  },
): Promise<void> {
  const { status, body } = await requestJson(
    fetchImpl,
    base,
    `/v1/sessions/${encodeURIComponent(sessionId)}/append`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
  if (status !== 200) {
    const error = errorOf(body)
    throw new SyncHttpError(error.message, status, error.code)
  }
}

function batchOptions(config: EngineConfig): { maxEvents?: number; maxBytes?: number } {
  return {
    ...config.batchEvents === undefined ? {} : { maxEvents: config.batchEvents },
    ...config.batchBytes === undefined ? {} : { maxBytes: config.batchBytes },
  }
}

/**
 * 一段事件的安全边界：尾巴闭合时是最后一个事件；开放时是最后一个
 * `turn/end`（没有则 -1）。
 * @param events - 完整本地事件。
 * @param tailOpen - 尾巴是否开放。
 * @returns 安全边界 seq。
 */
export function safeThroughSeqOf(events: readonly SyncEvent[], tailOpen: boolean): number {
  if (events.length === 0) return -1
  if (!tailOpen) return events[events.length - 1]!.seq
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if ((event as { readonly type?: unknown }).type === 'turn/end') return event.seq
  }
  return -1
}

/**
 * 同步一个会话。
 * @param deps - 引擎依赖。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param sessionKey - 会话密钥。
 * @param snapshot - 本地会话快照。
 * @returns 会话同步结果。
 */
async function syncSession<Session>(
  deps: SyncDeps<Session>,
  fetchImpl: typeof fetch,
  base: string,
  sessionKey: Buffer,
  snapshot: SnapshotLike,
): Promise<SessionSyncReport> {
  const header = snapshot.header
  const sessionId = String(header.id)

  const live = deps.sessions.get(sessionId)
  if (live !== undefined) await deps.sessions.flush(live)

  const handle = await deps.persistence.open(sessionId, 'read')
  let events: readonly SyncEvent[]
  try {
    const read = await handle.read()
    events = read.events
    if (!Array.isArray(events)) throw new Error('持久化返回的事件不是数组')
  } finally {
    await handle.close()
  }

  const meta = headerMetaOf(handle.header, handle.inheritedEventCount)
  const localLast = events.length === 0 ? -1 : events[events.length - 1]!.seq
  const tailOpen = deps.isTailOpen?.(events) ?? false
  let safeThroughSeq = safeThroughSeqOf(events, tailOpen)
  const remote = await readManifest(fetchImpl, base, deps.config.token, sessionId)

  if (remote !== undefined && remote.deletedAt !== undefined) {
    return { sessionId, status: 'skipped', error: '远端已有墓碑', tailOpen }
  }
  if (remote !== undefined) {
    if (remote.createdAt !== meta.createdAt) throw new Error('远端会话的 createdAt 与本地不一致')
    if (remote.formatVersion !== meta.formatVersion) throw new Error('远端会话的格式代际与本地不一致')
    const head = remote.frames[0]
    if (head === undefined || head.chainHash !== headerChainHash(meta)) throw new Error('远端会话头与本地不一致（diverged）')
    if (localLast < remote.lastSeq) return { sessionId, status: 'remote-ahead', tailOpen }
    if (remote.safeThroughSeq !== undefined) safeThroughSeq = Math.max(safeThroughSeq, remote.safeThroughSeq)
  }

  const sealedEntries: SealedFrame[] = []
  let baseIndex: number
  let baseChainHash: string | null
  let pushedBatches = 0

  if (remote === undefined) {
    const headerEntry = sealHeader(meta, sessionId, sessionKey)
    sealedEntries.push(headerEntry)
    const batches = planEventBatches(events, -1, batchOptions(deps.config))
    batches.forEach((batch, offset) => {
      sealedEntries.push(sealEventBatch(batch.events, sessionId, offset + 1, sessionKey))
    })
    pushedBatches = batches.length
    baseIndex = -1
    baseChainHash = null
  } else {
    const batches = planEventBatches(events, remote.lastSeq, batchOptions(deps.config))
    if (batches.length === 0) return { sessionId, status: 'up-to-date', tailOpen }
    batches.forEach((batch, offset) => {
      sealedEntries.push(sealEventBatch(batch.events, sessionId, remote.frames.length + offset, sessionKey))
    })
    pushedBatches = batches.length
    baseIndex = remote.frames.length - 1
    baseChainHash = remote.frames[remote.frames.length - 1]!.chainHash
  }

  for (const entry of sealedEntries) await uploadBlob(fetchImpl, base, deps.config.token, entry)

  const leased = await acquireLease(fetchImpl, base, deps.config.token, sessionId)
  if (!leased) return { sessionId, status: 'lease-held', tailOpen }
  try {
    await appendFrames(fetchImpl, base, deps.config.token, sessionId, {
      baseIndex,
      baseChainHash,
      createdAt: meta.createdAt,
      formatVersion: meta.formatVersion,
      frames: sealedEntries.map((entry) => entry.ref),
      tailOpen,
      safeThroughSeq,
    })
  } finally {
    await releaseLease(fetchImpl, base, deps.config.token, sessionId)
  }

  return {
    sessionId,
    status: 'pushed',
    batches: pushedBatches,
    bytes: sealedEntries.reduce((total, entry) => total + entry.ref.bytes, 0),
    tailOpen,
  }
}

/**
 * 执行一次推送；单个会话失败不影响其他会话。
 * @param deps - 引擎依赖。
 * @returns 汇总结果。
 */
export async function syncOnce<Session>(deps: SyncDeps<Session>): Promise<SyncReport> {
  const config = deps.config
  if (config.serverUrl.trim() === '' || config.token.trim() === '' || config.passphrase === '') {
    return { configured: false, reason: 'serverUrl / token / passphrase 未配置全', sessions: [] }
  }
  const allowlist = config.workspaceAllowlist ?? []
  if (allowlist.length === 0) {
    return { configured: false, reason: 'workspaceAllowlist 未配置', sessions: [] }
  }
  const base = normalizeBase(config.serverUrl)
  if (base === '') return { configured: false, reason: 'serverUrl 非法', sessions: [] }
  const salt = resolveSalt(config, base)
  const master = deriveMasterKey(config.passphrase, salt)
  const fetchImpl = deps.fetch ?? fetch
  const snapshots = await deps.persistence.list()
  const plan = planSessionClosure(snapshots, {
    includeSubagents: config.includeSubagents !== false,
    workspaceAllowlist: allowlist,
  })
  const sessions: SessionSyncReport[] = []

  for (const skipped of plan.skipped) {
    sessions.push({ sessionId: String(skipped.snapshot.header.id), status: 'skipped', error: skipped.reason })
  }

  for (const entry of plan.planned) {
    const sessionId = String(entry.snapshot.header.id)
    try {
      const sessionKey = sessionKeyOf(master, sessionId)
      sessions.push(await syncSession(deps, fetchImpl, base, sessionKey, entry.snapshot))
    } catch (error: unknown) {
      const classified = classifySyncError(error)
      deps.logger?.warn(`dsh-session-sync: ${sessionId} 同步失败：${classified.message}`)
      sessions.push({ sessionId, status: 'error', error: classified.message, kind: classified.kind })
    }
  }

  return { configured: true, sessions }
}

/** 游标里的一个会话变更。 */
interface CursorSession {
  readonly sessionId: string
  readonly revision: number
  readonly deletedAt: number | null
}

/** 游标里的墓碑。 */
interface CursorTombstone {
  readonly sessionId: string
  readonly deletedAt: number
}

/** 游标响应。 */
interface CursorValue {
  readonly revision: number
  readonly sessions: readonly CursorSession[]
  readonly tombstones: readonly CursorTombstone[]
  readonly hasMore: boolean
}

/**
 * 读取服务端游标。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param since - 已处理的 revision。
 * @returns 游标响应。
 */
async function readCursor(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  since: number,
): Promise<CursorValue> {
  const { status, body } = await requestJson(fetchImpl, base, `/v1/cursor?since=${since}&limit=200`, token)
  if (status !== 200) {
    const error = errorOf(body)
    throw new SyncHttpError(error.message, status, error.code)
  }
  if (body === null || typeof body !== 'object') throw new Error('cursor 响应不是对象')
  const value = (body as Record<string, unknown>)['value']
  if (value === null || typeof value !== 'object') throw new Error('cursor 响应缺少 value')
  const record = value as Record<string, unknown>
  if (!Array.isArray(record['sessions']) || !Array.isArray(record['tombstones'])) throw new Error('cursor 响应缺少数组')
  return value as CursorValue
}

/**
 * 下载一个 blob。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param sha256 - 密文哈希。
 * @returns blob 字节。
 */
async function downloadBlob(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  sha256: string,
): Promise<Buffer> {
  const response = await fetchImpl(`${base}/v1/blobs/${sha256}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (response.status !== 200) {
    const text = await response.text()
    throw new SyncHttpError(text === '' ? `blob ${sha256} 下载失败` : text, response.status)
  }
  return Buffer.from(await response.arrayBuffer())
}

/**
 * 下载并解开 `(localLast, safeThroughSeq]` 区间的事件。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param sessionId - 会话 id。
 * @param frames - manifest 的全部条目（含 header）。
 * @param localLast - 本地已有的最后一个 seq。
 * @param safe - 安全边界。
 * @param sessionKey - 会话密钥。
 * @returns 按 seq 升序的事件。
 */
async function downloadSafeEvents(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  sessionId: string,
  frames: readonly SealedFrameRef[],
  localLast: number,
  safe: number,
  sessionKey: Buffer,
): Promise<SyncEvent[]> {
  const events: SyncEvent[] = []
  for (const frame of frames.slice(1)) {
    if (frame.seqFrom > safe) break
    if (frame.seqTo <= localLast) continue
    const sealed = await downloadBlob(fetchImpl, base, token, frame.blobSha256)
    for (const event of openEventBatch(sealed, frame, sessionId, sessionKey)) {
      if (event.seq > localLast && event.seq <= safe) events.push(event)
    }
  }
  events.sort((left, right) => left.seq - right.seq)
  events.forEach((event, offset) => {
    if (event.seq !== localLast + offset + 1) throw new Error(`拉取到的事件 seq 不连续：期望 ${localLast + offset + 1}，实际 ${event.seq}`)
  })
  return events
}

/**
 * 预先读好的远端会话头：拉取排序与真正的 apply 复用同一份数据。
 */
interface LoadedRemote {
  /** manifest。 */
  readonly remote: RemoteManifest
  /** 解开的会话头；墓碑没有。 */
  readonly meta?: SessionHeaderMeta
}

/**
 * 读取 manifest 并解开会话头。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param master - 主密钥。
 * @param sessionId - 会话 id。
 * @returns manifest 与会话头。
 */
async function loadRemoteHeader(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  master: Buffer,
  sessionId: string,
): Promise<LoadedRemote> {
  const remote = await readManifest(fetchImpl, base, token, sessionId)
  if (remote === undefined) throw new Error('游标指向的会话没有 manifest')
  if (remote.deletedAt !== undefined) return { remote }
  const sessionKey = sessionKeyOf(master, sessionId)
  const headerRef = remote.frames[0]
  if (headerRef === undefined) throw new Error('manifest 缺少会话头')
  const headerSealed = await downloadBlob(fetchImpl, base, token, headerRef.blobSha256)
  const meta = openHeader(headerSealed, headerRef, sessionId, sessionKey)
  if (meta.createdAt !== remote.createdAt) throw new Error('会话头 createdAt 与 manifest 不一致')
  if (meta.formatVersion !== remote.formatVersion) throw new Error('会话头 formatVersion 与 manifest 不一致')
  return { remote, meta }
}

/**
 * 拉取一个会话。
 * @param deps - 拉取依赖。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param master - 主密钥。
 * @param sessionId - 会话 id。
 * @param preloaded - 已读取的 manifest/会话头；缺省现读。
 * @returns 会话拉取结果。
 */
async function pullSession<Session>(
  deps: PullDeps<Session>,
  fetchImpl: typeof fetch,
  base: string,
  master: Buffer,
  sessionId: string,
  preloaded?: LoadedRemote,
): Promise<PullSessionReport> {
  const loaded = preloaded ?? await loadRemoteHeader(fetchImpl, base, deps.config.token, master, sessionId)
  const remote = loaded.remote
  if (remote.deletedAt !== undefined) return { sessionId, status: 'tombstone' }
  const meta = loaded.meta
  if (meta === undefined) throw new Error('缺少会话头')

  const sessionKey = sessionKeyOf(master, sessionId)
  const headerRef = remote.frames[0]
  if (headerRef === undefined) throw new Error('manifest 缺少会话头')

  const safe = remote.safeThroughSeq ?? remote.lastSeq
  if (!Number.isSafeInteger(safe) || safe < -1 || safe > remote.lastSeq) throw new Error('manifest 的 safeThroughSeq 非法')

  const live = deps.sessions.get(sessionId)
  if (live !== undefined) return { sessionId, status: 'local-active' }

  const local = await deps.persistence.stat(sessionId)
  if (local !== undefined) {
    const handle = await deps.persistence.open(sessionId, 'write')
    try {
      const read = await handle.read()
      const localMeta = headerMetaOf(handle.header, handle.inheritedEventCount)
      if (headerChainHash(localMeta) !== headerRef.chainHash) throw new Error('本地会话头与远端不一致（diverged）')
      const localLast = read.events.length === 0 ? -1 : read.events[read.events.length - 1]!.seq
      if (localLast > safe) return { sessionId, status: 'local-ahead' }
      if (localLast === safe) {
        await deps.attach?.(sessionId)
        return { sessionId, status: 'up-to-date' }
      }
      const events = await downloadSafeEvents(fetchImpl, base, deps.config.token, sessionId, remote.frames, localLast, safe, sessionKey)
      if (events.length === 0) throw new Error(`远端承诺到 ${safe}，但没有拉到新事件`)
      await deps.beforeApply?.(sessionId, safe)
      await handle.append(events)
      await handle.flush()
      await deps.attach?.(sessionId)
      await deps.afterApply?.(sessionId)
      return {
        sessionId,
        status: safe < remote.lastSeq ? 'partial' : 'pulled',
        applied: events.length,
      }
    } finally {
      await handle.close()
    }
  }

  const events = await downloadSafeEvents(fetchImpl, base, deps.config.token, sessionId, remote.frames, -1, safe, sessionKey)
  const header: CreateHeaderLike = {
    version: meta.formatVersion,
    id: sessionId,
    createdAt: meta.createdAt,
    cwd: deps.workspacePath,
    isSeeded: meta.isSeeded,
    delegationDepth: meta.delegationDepth,
    ...meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
    ...meta.parentSession === undefined ? {} : { parentSession: meta.parentSession },
    ...meta.origin === undefined ? {} : { origin: meta.origin },
  }
  const options = meta.isSeeded ? { inheritedEventCount: meta.inheritedEventCount ?? 0 } : undefined
  await deps.beforeApply?.(sessionId, safe)
  const handle = await deps.persistence.create(header, options)
  try {
    if (events.length > 0) await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  await deps.attach?.(sessionId)
  await deps.afterApply?.(sessionId)
  return {
    sessionId,
    status: safe < remote.lastSeq ? 'partial' : 'pulled',
    applied: events.length,
  }
}

/**
 * 执行一次拉取；失败时不推进 revision，下一次会重试同一批。
 * @param deps - 拉取依赖。
 * @param state - 已处理的 revision。
 * @returns 汇总与新的 revision。
 */
export async function pullOnce<Session>(deps: PullDeps<Session>, state: PullState = { revision: 0 }): Promise<PullReport> {
  const config = deps.config
  if (config.serverUrl.trim() === '' || config.token.trim() === '' || config.passphrase === '') {
    return {
      configured: false,
      reason: 'serverUrl / token / passphrase 未配置全',
      sessions: [],
      revision: state.revision,
    }
  }
  const allowlist = config.workspaceAllowlist ?? []
  if (allowlist.length === 0) {
    return { configured: false, reason: 'workspaceAllowlist 未配置', sessions: [], revision: state.revision }
  }
  if (deps.workspacePath.trim() === '') {
    return { configured: false, reason: 'workspacePath 未配置', sessions: [], revision: state.revision }
  }
  if (!pathAllowed(deps.workspacePath, allowlist)) {
    return { configured: false, reason: 'workspacePath 不在同步白名单', sessions: [], revision: state.revision }
  }
  const base = normalizeBase(config.serverUrl)
  if (base === '') return { configured: false, reason: 'serverUrl 非法', sessions: [], revision: state.revision }
  const salt = resolveSalt(config, base)
  const master = deriveMasterKey(config.passphrase, salt)
  const fetchImpl = deps.fetch ?? fetch

  const reports: PullSessionReport[] = []
  let revision = state.revision

  // 上次崩溃留下的 pending：先把它补完，再继续游标。
  if (state.pending !== undefined) {
    try {
      reports.push(await pullSession(deps, fetchImpl, base, master, state.pending.sessionId))
      await deps.afterApply?.(state.pending.sessionId)
    } catch (error: unknown) {
      const classified = classifySyncError(error)
      deps.logger?.warn(`dsh-session-sync: 恢复 ${state.pending.sessionId} 失败：${classified.message}`)
      reports.push({ sessionId: state.pending.sessionId, status: 'error', error: classified.message, kind: classified.kind })
      return { configured: true, sessions: reports, revision: state.revision }
    }
  }

  for (let page = 0; page < 20; page += 1) {
    const cursor = await readCursor(fetchImpl, base, config.token, revision)
    const prepared: Array<{ readonly sessionId: string; readonly loaded: LoadedRemote }> = []
    for (const change of cursor.sessions) {
      if (change.deletedAt !== null) {
        reports.push({ sessionId: change.sessionId, status: 'tombstone' })
        continue
      }
      try {
        prepared.push({
          sessionId: change.sessionId,
          loaded: await loadRemoteHeader(fetchImpl, base, config.token, master, change.sessionId),
        })
      } catch (error: unknown) {
        const classified = classifySyncError(error)
        deps.logger?.warn(`dsh-session-sync: 读取 ${change.sessionId} 的会话头失败：${classified.message}`)
        reports.push({ sessionId: change.sessionId, status: 'error', error: classified.message, kind: classified.kind })
        return { configured: true, sessions: reports, revision: state.revision }
      }
    }

    // 子代理先建、根后建：深度从大到小。同级按创建时间，保证稳定。
    prepared.sort((left, right) =>
      (right.loaded.meta?.delegationDepth ?? -1) - (left.loaded.meta?.delegationDepth ?? -1)
      || (left.loaded.meta?.createdAt ?? 0) - (right.loaded.meta?.createdAt ?? 0)
      || left.sessionId.localeCompare(right.sessionId))

    for (const item of prepared) {
      if (item.loaded.remote.deletedAt !== undefined) {
        reports.push({ sessionId: item.sessionId, status: 'tombstone' })
        continue
      }
      try {
        reports.push(await pullSession(deps, fetchImpl, base, master, item.sessionId, item.loaded))
      } catch (error: unknown) {
        const classified = classifySyncError(error)
        deps.logger?.warn(`dsh-session-sync: 拉取 ${item.sessionId} 失败：${classified.message}`)
        reports.push({ sessionId: item.sessionId, status: 'error', error: classified.message, kind: classified.kind })
        // 一个会话失败后立即停止：pending 只有一条，继续应用下一个会话会覆盖
        // 前一个未完成的恢复记录（下一次启动就补不回来了）。
        return { configured: true, sessions: reports, revision: state.revision }
      }
    }
    for (const tombstone of cursor.tombstones) {
      reports.push({ sessionId: tombstone.sessionId, status: 'tombstone' })
    }
    const maxRevision = Math.max(
      revision,
      ...cursor.sessions.map((change) => change.revision),
      ...cursor.tombstones.map((tombstone) => tombstone.deletedAt),
    )
    if (!cursor.hasMore) {
      revision = Math.max(cursor.revision, maxRevision)
      break
    }
    revision = maxRevision
    if (revision <= state.revision) break
  }

  return { configured: true, sessions: reports, revision }
}

/** 导出默认值，便于配置/测试。 */
export { DEFAULT_BATCH_BYTES, DEFAULT_BATCH_EVENTS }
