/**
 * M3 推送引擎：枚举本地会话，把事件批次推到自部署服务端。
 *
 * 不做拉取、不做客户端 UI；只负责“本地 → 服务端”的增量追加。链的第 0 个
 * 条目是封好的会话头（seq=-1），事件批次从下标 1 开始；服务端只存不透明
 * 密文，不解析内容。
 *
 * @module dsh-session-cloudsync/engine
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  DEFAULT_BATCH_BYTES,
  DEFAULT_BATCH_EVENTS,
  eventBatchHash,
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
import { stableStringify } from '../../shared/src/chain.ts'
import { deriveMasterKey, sha256 } from '../../shared/src/crypto.ts'
import {
  sessionKeyOf,
  type SealedFrame,
  type SealedFrameRef,
} from '../../shared/src/sealed-frame.ts'
import { planSessionClosure } from './closure.ts'

/** 服务端会话头/快照里本引擎需要的字段。 */
export interface SnapshotLike {
  readonly header: SessionHeaderLike & { readonly id: string; readonly cwd?: string }
  readonly eventCount?: number
  readonly sizeBytes?: number
}

/** 读句柄的最小接口。 */
export interface ReadHandleLike {
  readonly header: SessionHeaderLike & { readonly id: string; readonly cwd?: string }
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
  /** 本地排除的根会话 id；子代理跟随根。 */
  readonly excludedSessionIds?: readonly string[]
  /** 单批事件上限，默认 50。 */
  readonly batchEvents?: number
  /** 单批规范 JSON 字节上限，默认 256 KiB。 */
  readonly batchBytes?: number
  /** 单次 HTTP 读取超时（毫秒），默认 10s。 */
  readonly requestTimeoutMs?: number
  /** 当前 DSH 进程的 clientInstanceId；用于租约 owner。 */
  readonly clientId?: string
}

/** 默认单次 HTTP 读取超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/**
 * 当前引擎使用的 clientInstanceId。
 * @param config - 引擎配置。
 * @returns 配置值或测试用固定十六进制 id。
 */
export function clientIdOf(config: EngineConfig): string {
  return config.clientId ?? '0000000000000000'
}

/**
 * 给每次 fetch 加读取超时；调用方已有 signal 时尊重它。
 * @param fetchImpl - 底层 fetch。
 * @param timeoutMs - 超时毫秒；缺省 10s。
 * @returns 带超时信号的 fetch。
 */
function withRequestTimeout(fetchImpl: typeof fetch, timeoutMs?: number): typeof fetch {
  const ms = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signal = init?.signal ?? AbortSignal.timeout(ms)
    return fetchImpl(input, { ...init, signal })
  }) as typeof fetch
}

/** 日志接口。 */
export interface SyncLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 一轮同步中某个会话的实时阶段。 */
export interface SyncProgress {
  /** 会话 id。 */
  readonly sessionId: string
  /** 推送或拉取。 */
  readonly direction: 'push' | 'pull'
  /** 当前阶段。 */
  readonly phase: 'start' | 'progress' | 'transferred' | 'committed' | 'done' | 'error'
  /** 0–1 的粗粒度进度。 */
  readonly progress: number
  /** 本方向计划处理的事件数。 */
  readonly totalEvents?: number
  /** 本方向已完成的事件数。 */
  readonly doneEvents?: number
  /** 本方向计划处理的批次数。 */
  readonly totalBatches?: number
  /** 本方向已完成的批次数。 */
  readonly doneBatches?: number
  /** 本方向计划传输的密文字节数。 */
  readonly bytes?: number
  /** 本方向已传输的密文字节数。 */
  readonly doneBytes?: number
  /** 失败说明。 */
  readonly error?: string
  /** 本次推送的批次数量（完成时）。 */
  readonly batches?: number
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
  /** 实时阶段回调；不抛异常，调用方负责容错。 */
  readonly onProgress?: (progress: SyncProgress) => void
  /** 由根会话的本机 cwd 解析 workspaceKey；V2 推送必需。 */
  readonly workspaceKeyOf: (sessionId: string, cwd: string) => string | undefined
}

/** 单个会话的同步结果。 */
export interface SessionSyncReport {
  readonly sessionId: string
  readonly status: 'pushed' | 'up-to-date' | 'remote-ahead' | 'skipped' | 'error'
  readonly batches?: number
  readonly bytes?: number
  /** 本次计划上传的事件数。 */
  readonly totalEvents?: number
  /** 本次已完成上传的事件数。 */
  readonly doneEvents?: number
  /** 等待拉取的事件数（例如 push 看到 remote-ahead）。 */
  readonly pendingEvents?: number
  readonly error?: string
  readonly kind?: SyncErrorKind
  /** 本地尾巴是否还有未闭合的 turn；只在读到事件后可知。 */
  readonly tailOpen?: boolean
  /** 最后 cwd 是否在工作区外；只做本地警告，不影响哈希/同步身份。 */
  readonly cwdNonPortable?: boolean
  /** 会话生命周期，用于把阻塞决定绑定到具体一代会话。 */
  readonly createdAt?: number
  readonly formatVersion?: number
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
  /** V2：由远端 workspaceKey 解析本机落点；未映射返回 undefined。 */
  readonly workspacePathOf: (workspaceKey: string) => string | undefined
  /** 拉取完成后挂回工作区；失败由调用方处理。 */
  readonly attach?: (sessionId: string, workspacePath?: string) => Promise<void>
  readonly logger?: SyncLogger
  readonly fetch?: typeof fetch
  /** 在第一次本地写入之前落盘 pending 记录。 */
  readonly beforeApply?: (sessionId: string, targetSeq: number) => Promise<void>
  /**
   * 本地追加/flush 完成后清除 pending。`pullOnce` 会把工作区挂载延后到
   * 整轮 apply 结束，因此这里不代表已经 attach。
   */
  readonly afterApply?: (sessionId: string) => Promise<void>
  /** 实时阶段回调；不抛异常，调用方负责容错。 */
  readonly onProgress?: (progress: SyncProgress) => void
}

/** 接收端 cwd 修正的依赖。 */
export interface CorrectCwdDeps<Session> {
  readonly persistence: PullPersistenceLike
  readonly sessions: SessionsLike<Session>
  readonly config: EngineConfig
  /** 本机目标工作区根；必须是已存在的 canonical workspace path。 */
  readonly targetPath: string
  readonly fetch?: typeof fetch
  readonly logger?: SyncLogger
}

/** 接收端 cwd 修正结果。 */
export interface CwdCorrectionResult {
  readonly ok: boolean
  readonly status: 'corrected' | 'already-portable' | 'needs-sync' | 'lease-held' | 'attached' | 'error'
  readonly message?: string
}

/** 一个等待人工处理、不能继续写入的会话。 */
export interface BlockedSessionState {
  readonly sessionId: string
  readonly createdAt: number
  readonly formatVersion: number
  readonly kind: SyncErrorKind
  readonly message: string
  readonly at: number
}

/** 用户对一个分叉会话的人工决定。 */
export interface BlockedDecision {
  readonly sessionId: string
  readonly createdAt: number
  readonly formatVersion: number
  readonly action: 'ignore' | 'force'
  readonly message: string
  readonly at: number
}

/** 一次未完成的拉取。 */
export interface PendingApply {
  readonly sessionId: string
  readonly targetSeq: number
  readonly at: number
}

/** 未映射的远端会话；持久化后即使游标越过也能继续提示和回填。 */
export interface UnmappedSessionState {
  /** 远端会话 id。 */
  readonly sessionId: string
  /** 远端 manifest 的 workspaceKey。 */
  readonly workspaceKey: string
  /** 该会话在服务端 cursor 里的 revision；回填从这里之前重放。 */
  readonly revision: number
  /** 会话创建时间（若有）。 */
  readonly createdAt?: number
  /** 会话格式代际（若有）。 */
  readonly formatVersion?: number
  /** 第一次记录的时间。 */
  readonly at: number
}

/** 拉取游标。 */
export interface PullState {
  /** 已处理到的服务端 revision；0 表示从头扫描。 */
  readonly revision: number
  /** 上次崩溃前未完成的会话。 */
  readonly pending?: PendingApply
  /** 等待用户决定 cwd 修正/跳过的会话 id。 */
  readonly cwdPending?: readonly string[]
  /** 已分叉、等待人工处理的会话。 */
  readonly blocked?: readonly BlockedSessionState[]
  /** 用户已经选择忽略或强行写入的会话；抑制重复阻塞。 */
  readonly blockedDecisions?: readonly BlockedDecision[]
  /** 等待映射的远端会话；映射完成后用于回填。 */
  readonly unmapped?: readonly UnmappedSessionState[]
}

/** 单个会话的拉取结果。 */
export interface PullSessionReport {
  readonly sessionId: string
  readonly status: 'pulled' | 'up-to-date' | 'partial' | 'local-active' | 'local-ahead' | 'tombstone' | 'unmapped' | 'excluded' | 'error'
  readonly applied?: number
  /** 本次计划处理/已经安全可见的事件数。 */
  readonly totalEvents?: number
  /** 仍未处理的事件数（开放尾等待安全边界、local-active 等）。 */
  readonly pendingEvents?: number
  readonly error?: string
  readonly kind?: SyncErrorKind
  /** 远端 manifest 的 workspaceKey（若有）。 */
  readonly workspaceKey?: string
  /** 最后 cwd 是否在工作区外；只做本地警告，不影响哈希/同步身份。 */
  readonly cwdNonPortable?: boolean
  /** 会话生命周期，用于把阻塞决定绑定到具体一代会话。 */
  readonly createdAt?: number
  readonly formatVersion?: number
  /** 该会话在 cursor 里的 revision；仅未映射会话回填使用。 */
  readonly revision?: number
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
  readonly workspaceKey?: string
  readonly tailOpen?: boolean
  readonly safeThroughSeq?: number
  readonly frames: readonly SealedFrameRef[]
  readonly batches?: readonly SealedFrameRef[]
  readonly batchCount?: number
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
  if (/diverged|分叉/u.test(message)) return { kind: 'diverged', message, retryable: false }
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
  return Buffer.from(sha256(`dsh-session-cloudsync/v1|${base}`).slice(0, 32), 'hex')
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
  const refs = record['batches']
  if (!Array.isArray(refs)) throw new Error('manifest.batches 不是数组')
  return { ...record, frames: refs } as unknown as RemoteManifest
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
  clientId: string,
  input: {
    readonly baseIndex: number
    readonly baseChainHash: string | null
    readonly createdAt: number
    readonly formatVersion: number
    readonly frames: readonly SealedFrameRef[]
    readonly workspaceKey?: string
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
      headers: { 'content-type': 'application/json', 'x-client-id': clientId },
      body: JSON.stringify({ ...input, batches: input.frames }),
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
 * 取会话最后一条 `working-directory/change` 的 cwd。
 * @param events - 完整事件。
 * @returns 最后 cwd；没有 change 事件时为 undefined。
 */
export function lastWorkingDirectoryOf(events: readonly SyncEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { readonly type?: unknown; readonly data?: unknown }
    if (event.type !== 'working-directory/change') continue
    if (event.data === null || typeof event.data !== 'object') continue
    const cwd = (event.data as { readonly cwd?: unknown }).cwd
    if (typeof cwd === 'string') return cwd
  }
  return undefined
}

/**
 * cwd 是否位于工作区根之下（根自身也算）。
 * @param root - 本地工作区根。
 * @param cwd - 待检查路径。
 * @returns 是否在根内。
 */
export function cwdInsideWorkspace(root: string, cwd: string): boolean {
  if (root === '' || cwd === '') return false
  if (!isAbsolute(root) || !isAbsolute(cwd)) return false
  const rel = relative(resolve(root), resolve(cwd))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * 最后 cwd 是否在工作区外；没有 cwd 事件时视为 portable。
 * @param events - 完整事件。
 * @param root - 本地工作区根。
 * @returns 是否 nonPortable。
 */
export function cwdNonPortableOf(events: readonly SyncEvent[], root: string): boolean {
  const cwd = lastWorkingDirectoryOf(events)
  return cwd !== undefined && !cwdInsideWorkspace(root, cwd)
}

/**
 * 发一次实时阶段；回调异常不能打断同步。
 * @param deps - 带可选 onProgress 的依赖。
 * @param progress - 当前阶段。
 */
function notifyProgress(
  deps: { readonly onProgress?: (progress: SyncProgress) => void },
  progress: SyncProgress,
): void {
  try {
    deps.onProgress?.(progress)
  } catch {
    // UI 进度不是同步正确性的一部分。
  }
}

/**
 * 按远端批次边界收集本地连续事件；缺 seq 视为分叉。
 * @param bySeq - 本地事件索引。
 * @param seqFrom - 起始 seq。
 * @param seqTo - 结束 seq。
 * @returns 连续事件。
 */
function localEventRange(
  bySeq: ReadonlyMap<number, SyncEvent>,
  seqFrom: number,
  seqTo: number,
): SyncEvent[] {
  const events: SyncEvent[] = []
  for (let seq = seqFrom; seq <= seqTo; seq += 1) {
    const event = bySeq.get(seq)
    if (event === undefined) throw new Error(`本地缺少事件 seq ${seq}（diverged）`)
    events.push(event)
  }
  return events
}

/**
 * 校验远端共享前缀与本地 raw 事件一致。
 *
 * 本地和远端都不做 cwd 投影，因此直接按远端批次边界对 raw 事件算哈希。
 * 本地末尾落在远端批次中间时，下载该批次并比较重叠事件，不能跳过校验。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端基地址。
 * @param token - 设备 token。
 * @param sessionId - 会话 id。
 * @param sessionKey - 会话密钥。
 * @param remote - 远端 manifest。
 * @param localEvents - 本地完整事件。
 */
async function verifySharedPrefix(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  sessionId: string,
  sessionKey: Buffer,
  remote: RemoteManifest,
  localEvents: readonly SyncEvent[],
): Promise<void> {
  const localLast = localEvents.length === 0 ? -1 : localEvents[localEvents.length - 1]!.seq
  if (localLast < 0) return

  const bySeq = new Map<number, SyncEvent>()
  for (const event of localEvents) {
    if (bySeq.has(event.seq)) throw new Error(`本地事件 seq ${event.seq} 重复（diverged）`)
    bySeq.set(event.seq, event)
  }

  // 第 0 个引用是会话头，不是事件批次。
  for (const frame of remote.frames.slice(1)) {
    if (frame.seqFrom > localLast) break
    if (frame.seqTo <= localLast) {
      const local = localEventRange(bySeq, frame.seqFrom, frame.seqTo)
      if (eventBatchHash(local) !== frame.chainHash) {
        throw new Error(`共享前缀批次 ${frame.index} 不一致（diverged）`)
      }
      continue
    }

    // 本地末尾落在这个远端批次中间：下载该批次，比较重叠段。
    const sealed = await downloadBlob(fetchImpl, base, token, frame.blobSha256)
    const remoteEvents = openEventBatch(sealed, frame, sessionId, sessionKey)
    for (const remoteEvent of remoteEvents) {
      if (remoteEvent.seq > localLast) break
      const local = bySeq.get(remoteEvent.seq)
      if (local === undefined) throw new Error(`本地缺少事件 seq ${remoteEvent.seq}（diverged）`)
      if (stableStringify(local) !== stableStringify(remoteEvent)) {
        throw new Error(`共享前缀事件 seq ${remoteEvent.seq} 不一致（diverged）`)
      }
    }
  }
}

/**
 * 同步一个会话。
 * @param deps - 引擎依赖。
 * @param fetchImpl - fetch 实现。
 * @param base - 服务端地址。
 * @param sessionKey - 会话密钥。
 * @param snapshot - 本地会话快照。
 * @param workspaceKey - 该根会话的逻辑工作区 key；V2 必需。
 * @returns 会话同步结果。
 */
async function syncSession<Session>(
  deps: SyncDeps<Session>,
  fetchImpl: typeof fetch,
  base: string,
  sessionKey: Buffer,
  snapshot: SnapshotLike,
  isRoot: boolean,
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
  const cwd = handle.header.cwd ?? ''
  const localLast = events.length === 0 ? -1 : events[events.length - 1]!.seq
  const tailOpen = deps.isTailOpen?.(events) ?? false
  const cwdNonPortable = cwdNonPortableOf(events, cwd)
  let safeThroughSeq = safeThroughSeqOf(events, tailOpen)
  const remote = await readManifest(fetchImpl, base, deps.config.token, sessionId)

  // 已经有远端 manifest 的会话沿用远端 key：映射到本地路径后，旧会话不会
  // 因为路径的推送身份变化而被判成 diverged；新会话才使用本地解析的 key。
  const workspaceKey = isRoot
    ? (remote?.workspaceKey ?? deps.workspaceKeyOf(sessionId, cwd))
    : undefined
  if (isRoot && workspaceKey === undefined) {
    return { sessionId, status: 'skipped', error: 'workspaceKey 未解析（unmapped）', tailOpen, ...cwdNonPortable ? { cwdNonPortable } : {} }
  }

  if (remote !== undefined && remote.deletedAt !== undefined) {
    return { sessionId, status: 'skipped', error: '远端已有墓碑', tailOpen, ...cwdNonPortable ? { cwdNonPortable } : {} }
  }
  if (remote !== undefined) {
    if (remote.createdAt !== meta.createdAt) throw new Error('远端会话的 createdAt 与本地不一致')
    if (remote.formatVersion !== meta.formatVersion) throw new Error('远端会话的格式代际与本地不一致')
    if (remote.workspaceKey !== workspaceKey) throw new Error('远端会话的 workspaceKey 与本地不一致（diverged）')
    const head = remote.frames[0]
    if (head === undefined || head.chainHash !== headerChainHash(meta)) throw new Error('远端会话头与本地不一致（diverged）')
    await verifySharedPrefix(fetchImpl, base, deps.config.token, sessionId, sessionKey, remote, events)
    if (localLast < remote.lastSeq) {
      return {
        sessionId,
        status: 'remote-ahead',
        totalEvents: 0,
        doneEvents: 0,
        pendingEvents: remote.lastSeq - localLast,
        tailOpen,
        ...cwdNonPortable ? { cwdNonPortable } : {},
      }
    }
    if (remote.safeThroughSeq !== undefined) safeThroughSeq = Math.max(safeThroughSeq, remote.safeThroughSeq)
  }

  const uploadSteps: Array<{ readonly entry: SealedFrame; readonly events: number }> = []
  let baseIndex: number
  let baseChainHash: string | null
  let pushedBatches = 0
  let totalEvents = 0

  if (remote === undefined) {
    const headerEntry = sealHeader(meta, sessionId, sessionKey)
    uploadSteps.push({ entry: headerEntry, events: 0 })
    const batches = planEventBatches(events, -1, batchOptions(deps.config))
    batches.forEach((batch, offset) => {
      totalEvents += batch.events.length
      uploadSteps.push({
        entry: sealEventBatch(batch.events, sessionId, offset + 1, sessionKey),
        events: batch.events.length,
      })
    })
    pushedBatches = batches.length
    baseIndex = -1
    baseChainHash = null
  } else {
    const batches = planEventBatches(events, remote.lastSeq, batchOptions(deps.config))
    if (batches.length === 0) {
      return { sessionId, status: 'up-to-date', totalEvents: 0, doneEvents: 0, tailOpen, ...cwdNonPortable ? { cwdNonPortable } : {} }
    }
    batches.forEach((batch, offset) => {
      totalEvents += batch.events.length
      uploadSteps.push({
        entry: sealEventBatch(batch.events, sessionId, remote.frames.length + offset, sessionKey),
        events: batch.events.length,
      })
    })
    pushedBatches = batches.length
    baseIndex = remote.frames.length - 1
    baseChainHash = remote.frames[remote.frames.length - 1]!.chainHash
  }

  const totalBytes = uploadSteps.reduce((total, step) => total + step.entry.ref.bytes, 0)
  let doneEvents = 0
  let doneBatches = 0
  let doneBytes = 0
  const notifyUpload = (): void => {
    notifyProgress(deps, {
      sessionId,
      direction: 'push',
      phase: 'progress',
      progress: totalEvents === 0 ? 1 : doneEvents / totalEvents,
      totalEvents,
      doneEvents,
      totalBatches: pushedBatches,
      doneBatches,
      bytes: totalBytes,
      doneBytes,
    })
  }
  notifyUpload()
  for (const step of uploadSteps) {
    await uploadBlob(fetchImpl, base, deps.config.token, step.entry)
    doneBytes += step.entry.ref.bytes
    if (step.events > 0) {
      doneEvents += step.events
      doneBatches += 1
    }
    notifyUpload()
  }
  const sealedEntries = uploadSteps.map((step) => step.entry)

  await appendFrames(fetchImpl, base, deps.config.token, sessionId, clientIdOf(deps.config), {
    baseIndex,
    baseChainHash,
    createdAt: meta.createdAt,
    formatVersion: meta.formatVersion,
    frames: sealedEntries.map((entry) => entry.ref),
    ...workspaceKey === undefined ? {} : { workspaceKey },
    tailOpen,
    safeThroughSeq,
  })

  return {
    sessionId,
    status: 'pushed',
    batches: pushedBatches,
    bytes: totalBytes,
    totalEvents,
    doneEvents: totalEvents,
    tailOpen,
    ...cwdNonPortable ? { cwdNonPortable } : {},
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
  const base = normalizeBase(config.serverUrl)
  if (base === '') return { configured: false, reason: 'serverUrl 非法', sessions: [] }
  const salt = resolveSalt(config, base)
  const master = deriveMasterKey(config.passphrase, salt)
  const fetchImpl = withRequestTimeout(deps.fetch ?? fetch, deps.config.requestTimeoutMs)
  const snapshots = await deps.persistence.list()
  const plan = planSessionClosure(snapshots, {
    includeSubagents: config.includeSubagents !== false,
    excludedSessionIds: config.excludedSessionIds ?? [],
  })
  const sessions: SessionSyncReport[] = []

  for (const skipped of plan.skipped) {
    sessions.push({ sessionId: String(skipped.snapshot.header.id), status: 'skipped', error: skipped.reason })
  }

  for (const entry of plan.planned) {
    const sessionId = String(entry.snapshot.header.id)
    notifyProgress(deps, { sessionId, direction: 'push', phase: 'start', progress: 0 })
    try {
      const sessionKey = sessionKeyOf(master, sessionId)
      const report = await syncSession(deps, fetchImpl, base, sessionKey, entry.snapshot, entry.depth === 0)
      sessions.push(report)
      notifyProgress(deps, {
        sessionId, direction: 'push',
        phase: report.status === 'error' ? 'error' : 'done',
        progress: report.status === 'error' ? 0 : 1,
        ...report.totalEvents === undefined ? {} : { totalEvents: report.totalEvents },
        ...report.doneEvents === undefined ? {} : { doneEvents: report.doneEvents },
        ...report.batches === undefined ? {} : {
          batches: report.batches,
          totalBatches: report.batches,
          doneBatches: report.batches,
        },
        ...report.bytes === undefined ? {} : { bytes: report.bytes, doneBytes: report.bytes },
        ...report.error === undefined ? {} : { error: report.error },
      })
    } catch (error: unknown) {
      const classified = classifySyncError(error)
      deps.logger?.warn(`dsh-session-cloudsync: ${sessionId} 同步失败：${classified.message}`)
      sessions.push({
        sessionId,
        status: 'error',
        error: classified.message,
        kind: classified.kind,
        ...entry.snapshot.header.createdAt === undefined ? {} : { createdAt: entry.snapshot.header.createdAt },
        ...entry.snapshot.header.version === undefined ? {} : { formatVersion: entry.snapshot.header.version },
      })
      notifyProgress(deps, { sessionId, direction: 'push', phase: 'error', progress: 0, error: classified.message })
    }
  }

  return { configured: true, sessions }
}

/** 连接测试结果。 */
export interface SyncTestResult {
  /** 服务端可达且 `/v1/health` 响应正常。 */
  readonly ok: boolean
  /** 失败分类。 */
  readonly kind?: SyncErrorKind
  /** 可读说明。 */
  readonly message?: string
  /** 成功时服务端报告的版本。 */
  readonly version?: string
  /** 成功时服务端报告的协议版本。 */
  readonly protocol?: number
}

/**
 * 测试服务端地址是否可达；只请求公开的 `/v1/health`。
 *
 * 不读取已保存的配置，也不携带设备 token：首启向导第 1 步只关心“地址通不通”，
 * 凭据是否有效由后续同步阶段的认证错误来暴露。
 *
 * @param serverUrl - 待测试的服务端地址（来自当前输入，而不是配置文件）。
 * @param fetchImpl - fetch 实现（测试可替换）。
 * @param requestTimeoutMs - 超时；缺省用请求默认值。
 * @returns 测试结果；失败不抛异常。
 */
export async function testConnection(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
  requestTimeoutMs?: number,
): Promise<SyncTestResult> {
  const base = normalizeBase(serverUrl)
  if (base === '') return { ok: false, kind: 'config', message: 'serverUrl 未配置' }
  let target: URL
  try {
    target = new URL(base)
  } catch {
    return { ok: false, kind: 'config', message: 'serverUrl 非法' }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, kind: 'config', message: 'serverUrl 必须是 http(s) 地址' }
  }
  const timedFetch = withRequestTimeout(fetchImpl, requestTimeoutMs)
  try {
    const response = await timedFetch(`${base}/v1/health`, { headers: { accept: 'application/json' } })
    if (response.status === 200) {
      const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
      if (body === undefined || body['ok'] !== true) {
        return { ok: false, kind: 'server', message: '服务端 /v1/health 响应不合法' }
      }
      return {
        ok: true,
        ...typeof body['version'] === 'string' ? { version: body['version'] } : {},
        ...typeof body['protocol'] === 'number' ? { protocol: body['protocol'] } : {},
      }
    }
    if (response.status === 404) {
      return { ok: false, kind: 'not-found', message: '服务端没有 /v1/health，确认地址指向同步服务端' }
    }
    return { ok: false, kind: 'server', message: `服务端返回 HTTP ${response.status}` }
  } catch (error: unknown) {
    const classified = classifySyncError(error)
    return { ok: false, kind: classified.kind, message: classified.message }
  }
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
 * @param onProgress - 每下载完一帧后的累计事件数回调（可选）。
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
  onProgress?: (doneEvents: number, totalEvents: number) => void,
): Promise<SyncEvent[]> {
  const events: SyncEvent[] = []
  const totalEvents = safe - localLast
  for (const frame of frames.slice(1)) {
    if (frame.seqFrom > safe) break
    if (frame.seqTo <= localLast) continue
    const sealed = await downloadBlob(fetchImpl, base, token, frame.blobSha256)
    for (const event of openEventBatch(sealed, frame, sessionId, sessionKey)) {
      if (event.seq > localLast && event.seq <= safe) events.push(event)
    }
    if (totalEvents > 0) onProgress?.(events.length, totalEvents)
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
 * 解析一个远端会话的 workspaceKey：根读取 manifest，子代理沿父链找根。
 * @param loaded - 当前会话。
 * @param fetchImpl - fetch。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param master - 主密钥。
 * @param lookup - 本轮已读会话索引。
 * @returns key 或 undefined（unmapped）。
 */
async function resolveWorkspaceKey(
  loaded: LoadedRemote,
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  master: Buffer,
  lookup: (sessionId: string) => LoadedRemote | undefined,
): Promise<string | undefined> {
  let current = loaded
  const seen = new Set<string>()
  while (current.remote.workspaceKey === undefined) {
    const parentId = current.meta?.origin === 'subagent' ? current.meta.parentSession : undefined
    if (parentId === undefined || seen.has(parentId)) return undefined
    seen.add(parentId)
    const cached = lookup(parentId)
    current = cached ?? await loadRemoteHeader(fetchImpl, base, token, master, parentId)
  }
  return current.remote.workspaceKey
}

/**
 * 沿父链找到会话所属的根会话 id。
 * @param loaded - 当前会话。
 * @param fetchImpl - fetch。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param master - 主密钥。
 * @param lookup - 本轮已读会话索引。
 * @returns 根会话 id；无法解析父链时返回当前会话 id。
 */
async function resolveRootSessionId(
  loaded: LoadedRemote,
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  master: Buffer,
  lookup: (sessionId: string) => LoadedRemote | undefined,
): Promise<string> {
  let current = loaded
  const seen = new Set<string>()
  while (current.meta?.origin === 'subagent') {
    const parentId = current.meta.parentSession
    if (parentId === undefined || seen.has(parentId)) return current.remote.sessionId
    seen.add(parentId)
    const cached = lookup(parentId)
    try {
      current = cached ?? await loadRemoteHeader(fetchImpl, base, token, master, parentId)
    } catch {
      return current.remote.sessionId
    }
  }
  return current.remote.sessionId
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
  workspacePath: string,
  preloaded?: LoadedRemote,
): Promise<PullSessionReport> {
  const loaded = preloaded ?? await loadRemoteHeader(fetchImpl, base, deps.config.token, master, sessionId)
  const remote = loaded.remote
  if (remote.deletedAt !== undefined) return { sessionId, status: 'tombstone', totalEvents: 0 }
  const meta = loaded.meta
  if (meta === undefined) throw new Error('缺少会话头')

  const sessionKey = sessionKeyOf(master, sessionId)
  const headerRef = remote.frames[0]
  if (headerRef === undefined) throw new Error('manifest 缺少会话头')

  const safe = remote.safeThroughSeq ?? remote.lastSeq
  if (!Number.isSafeInteger(safe) || safe < -1 || safe > remote.lastSeq) throw new Error('manifest 的 safeThroughSeq 非法')

  const live = deps.sessions.get(sessionId)
  const local = await deps.persistence.stat(sessionId)
  if (local !== undefined) {
    // 活跃会话只能读，不能写：DSH 的 session store 已持有写句柄。先读本地
    // lastSeq，确认远端没有新事件时直接 up-to-date；确实落后时返回
    // local-active，让游标停在它之前，等会话关闭后再 apply。
    const handle = await deps.persistence.open(sessionId, live === undefined ? 'write' : 'read')
    try {
      const read = await handle.read()
      const localMeta = headerMetaOf(handle.header, handle.inheritedEventCount)
      if (headerChainHash(localMeta) !== headerRef.chainHash) throw new Error('本地会话头与远端不一致（diverged）')
      const localLast = read.events.length === 0 ? -1 : read.events[read.events.length - 1]!.seq
      await verifySharedPrefix(fetchImpl, base, deps.config.token, sessionId, sessionKey, remote, read.events)
      const localCwdNonPortable = cwdNonPortableOf(read.events, workspacePath)
      if (localLast > safe) {
        return { sessionId, status: 'local-ahead', totalEvents: 0, ...localCwdNonPortable ? { cwdNonPortable: true } : {} }
      }
      if (localLast === safe) {
        if (live === undefined && !localCwdNonPortable) await deps.attach?.(sessionId, workspacePath)
        return { sessionId, status: 'up-to-date', totalEvents: 0, ...localCwdNonPortable ? { cwdNonPortable: true } : {} }
      }
      if (live !== undefined) {
        const pendingEvents = safe - localLast
        return {
          sessionId,
          status: 'local-active',
          totalEvents: pendingEvents,
          pendingEvents,
          ...localCwdNonPortable ? { cwdNonPortable: true } : {},
        }
      }
      const totalEvents = safe - localLast
      const notifyDownload = (doneEvents: number): void => {
        notifyProgress(deps, {
          sessionId,
          direction: 'pull',
          phase: 'progress',
          progress: totalEvents === 0 ? 1 : doneEvents / totalEvents,
          totalEvents,
          doneEvents,
        })
      }
      notifyDownload(0)
      const events = await downloadSafeEvents(
        fetchImpl, base, deps.config.token, sessionId, remote.frames, localLast, safe, sessionKey,
        (doneEvents) => { notifyDownload(doneEvents) },
      )
      if (events.length === 0) throw new Error(`远端承诺到 ${safe}，但没有拉到新事件`)
      await deps.beforeApply?.(sessionId, safe)
      await handle.append(events)
      await handle.flush()
      const nextCwdNonPortable = cwdNonPortableOf([...read.events, ...events], workspacePath)
      if (!nextCwdNonPortable) await deps.attach?.(sessionId, workspacePath)
      await deps.afterApply?.(sessionId)
      return {
        sessionId,
        status: safe < remote.lastSeq ? 'partial' : 'pulled',
        applied: events.length,
        totalEvents: events.length,
        pendingEvents: safe < remote.lastSeq ? remote.lastSeq - safe : 0,
        ...nextCwdNonPortable ? { cwdNonPortable: true } : {},
      }
    } finally {
      await handle.close()
    }
  }

  // 没有本地 artifact 却是活跃会话：同样不能 create/写，等它关闭。
  if (live !== undefined) {
    return { sessionId, status: 'local-active', totalEvents: safe + 1, pendingEvents: safe + 1 }
  }

  const totalEvents = safe + 1
  const notifyDownload = (doneEvents: number): void => {
    notifyProgress(deps, {
      sessionId,
      direction: 'pull',
      phase: 'progress',
      progress: totalEvents === 0 ? 1 : doneEvents / totalEvents,
      totalEvents,
      doneEvents,
    })
  }
  notifyDownload(0)
  const events = await downloadSafeEvents(
    fetchImpl, base, deps.config.token, sessionId, remote.frames, -1, safe, sessionKey,
    (doneEvents) => { notifyDownload(doneEvents) },
  )
  const header: CreateHeaderLike = {
    version: meta.formatVersion,
    id: sessionId,
    createdAt: meta.createdAt,
    cwd: workspacePath,
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
  const cwdNonPortable = cwdNonPortableOf(events, workspacePath)
  if (!cwdNonPortable) await deps.attach?.(sessionId, workspacePath)
  await deps.afterApply?.(sessionId)
  return {
    sessionId,
    status: safe < remote.lastSeq ? 'partial' : 'pulled',
    applied: events.length,
    totalEvents: events.length,
    pendingEvents: safe < remote.lastSeq ? remote.lastSeq - safe : 0,
    ...cwdNonPortable ? { cwdNonPortable: true } : {},
  }
}

/**
 * 接收端把当前 cwd 修正到本地工作区根。
 *
 * 这是 append-only 操作：不重写历史；先申请租约，确认远端没有推进，再追加并推送。
 * 如果本地已 portable、会话正在运行、或远端还有未同步事件，则不修改。
 * @param deps - 修正依赖。
 * @param sessionId - 会话 id。
 * @returns 修正结果。
 */
export async function correctCwd<Session>(
  deps: CorrectCwdDeps<Session>,
  sessionId: string,
): Promise<CwdCorrectionResult> {
  if (deps.targetPath.trim() === '' || !isAbsolute(deps.targetPath)) {
    return { ok: false, status: 'error', message: 'targetPath 未配置或不是绝对路径' }
  }
  if (deps.sessions.get(sessionId) !== undefined) {
    return { ok: false, status: 'error', message: '会话正在运行，不能修改 cwd' }
  }
  const local = await deps.persistence.stat(sessionId)
  if (local === undefined) return { ok: false, status: 'error', message: '本地会话不存在' }

  const base = normalizeBase(deps.config.serverUrl)
  if (base === '') return { ok: false, status: 'error', message: 'serverUrl 非法' }
  const master = deriveMasterKey(deps.config.passphrase, resolveSalt(deps.config, base))
  const fetchImpl = withRequestTimeout(deps.fetch ?? fetch, deps.config.requestTimeoutMs)
  const handle = await deps.persistence.open(sessionId, 'write')
  try {
    const read = await handle.read()
    const events = read.events
    const last = lastWorkingDirectoryOf(events)
    const localLast = events.length === 0 ? -1 : events[events.length - 1]!.seq
    const remote = await readManifest(fetchImpl, base, deps.config.token, sessionId)
    if (last === undefined || cwdInsideWorkspace(deps.targetPath, last)) {
      // 本地已经 portable；如果远端还落后，说明上次修正只落了本地，必须先推送。
      if (remote === undefined || (remote.deletedAt === undefined && remote.lastSeq === localLast)) {
        return { ok: true, status: 'already-portable' }
      }
      return { ok: false, status: 'needs-sync', message: '本地已有未推送的 cwd 事件，请先完成同步' }
    }
    if (remote === undefined || remote.deletedAt !== undefined) {
      return { ok: false, status: 'error', message: '远端会话不存在或已删除' }
    }
    if (remote.lastSeq !== localLast || remote.tailOpen === true
      || (remote.safeThroughSeq ?? remote.lastSeq) !== remote.lastSeq) {
      return { ok: false, status: 'needs-sync', message: '远端还有未同步事件，请先完成同步' }
    }

    // 全局单写者租约由宿主在进入本函数前确保；服务端 append 会再次校验。
    // 再读一次，防止 manifest 在检查与追加之间被别的设备推进。
    const current = await readManifest(fetchImpl, base, deps.config.token, sessionId)
    if (current === undefined || current.deletedAt !== undefined
      || current.lastSeq !== localLast || current.tailOpen === true
      || (current.safeThroughSeq ?? current.lastSeq) !== current.lastSeq) {
      return { ok: false, status: 'needs-sync', message: '会话已变化，请先重新同步' }
    }
    if (current.createdAt !== handle.header.createdAt || current.formatVersion !== handle.header.version) {
      return { ok: false, status: 'needs-sync', message: '远端会话头已变化，请先重新同步' }
    }
    const headerRef = current.frames[0]
    if (headerRef === undefined
      || headerRef.chainHash !== headerChainHash(headerMetaOf(handle.header, handle.inheritedEventCount))) {
      return { ok: false, status: 'needs-sync', message: '远端会话头与本地不一致，请先重新同步' }
    }
    await verifySharedPrefix(fetchImpl, base, deps.config.token, sessionId, sessionKeyOf(master, sessionId), current, events)

    const lastTime = (events[events.length - 1] as { readonly time?: unknown } | undefined)?.time
    const correction = {
      type: 'working-directory/change',
      seq: localLast + 1,
      time: Math.max(Date.now(), (typeof lastTime === 'number' && Number.isFinite(lastTime) ? lastTime : 0) + 1),
      data: { cwd: deps.targetPath },
    }
    await handle.append([correction])
    await handle.flush()

    const sealed = sealEventBatch([correction], sessionId, current.frames.length, sessionKeyOf(master, sessionId))
    await uploadBlob(fetchImpl, base, deps.config.token, sealed)
    const baseFrame = current.frames[current.frames.length - 1]
    if (baseFrame === undefined) throw new Error('manifest 缺少最后一个批次')
    await appendFrames(fetchImpl, base, deps.config.token, sessionId, clientIdOf(deps.config), {
      baseIndex: current.frames.length - 1,
      baseChainHash: baseFrame.chainHash,
      createdAt: handle.header.createdAt,
      formatVersion: handle.header.version,
      frames: [sealed.ref],
      tailOpen: false,
      safeThroughSeq: correction.seq,
    })
    return { ok: true, status: 'corrected' }
  } catch (error: unknown) {
    return { ok: false, status: 'error', message: error instanceof Error ? error.message : String(error) }
  } finally {
    await handle.close()
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
  const excluded = new Set(config.excludedSessionIds ?? [])
  if (deps.workspacePathOf === undefined) {
    return { configured: false, reason: 'workspace 绑定未初始化', sessions: [], revision: state.revision }
  }
  const base = normalizeBase(config.serverUrl)
  if (base === '') return { configured: false, reason: 'serverUrl 非法', sessions: [], revision: state.revision }
  const salt = resolveSalt(config, base)
  const master = deriveMasterKey(config.passphrase, salt)
  const fetchImpl = withRequestTimeout(deps.fetch ?? fetch, deps.config.requestTimeoutMs)

  const reports: PullSessionReport[] = []
  let revision = state.revision
  // local-active / local-ahead 是“暂时不能 apply”，不是成功；游标必须停在
  // 它之前，等会话关闭或本地追平后重试。否则游标越过，push 会一直 remote-ahead
  // 并触发 UI 的安全边界拦截，形成死锁。
  let deferredRevision: number | undefined
  const resolvePath = (workspaceKey: string | undefined): string | undefined => {
    if (workspaceKey === undefined) return undefined
    return deps.workspacePathOf(workspaceKey)
  }
  // 拉取期间只收集待挂载会话，等整轮 apply 完再挂到工作区；这样前端不会在
  // 子代理/根会话只到一半时刷新列表。pending 在 append+flush 后即清除，
  // 挂载失败时下一轮会因本地已是最新而重试挂载。
  const attachments: Array<{ readonly sessionId: string; readonly workspacePath?: string }> = []
  let applyStarted: string | undefined
  const applyDeps: PullDeps<Session> = {
    ...deps,
    ...(deps.attach === undefined ? {} : {
      attach: async (sessionId: string, workspacePath?: string): Promise<void> => {
        attachments.push({ sessionId, ...workspacePath === undefined ? {} : { workspacePath } })
      },
    }),
    beforeApply: async (sessionId: string, targetSeq: number): Promise<void> => {
      applyStarted = sessionId
      await deps.beforeApply?.(sessionId, targetSeq)
    },
    afterApply: async (sessionId: string): Promise<void> => {
      await deps.afterApply?.(sessionId)
      if (applyStarted === sessionId) applyStarted = undefined
    },
  }

  // 上次崩溃留下的 pending：先把它补完，再继续游标。
  if (state.pending !== undefined) {
    try {
      const loaded = await loadRemoteHeader(fetchImpl, base, config.token, master, state.pending.sessionId)
      const rootId = await resolveRootSessionId(loaded, fetchImpl, base, config.token, master, () => undefined)
      if (excluded.has(rootId)) {
        reports.push({ sessionId: state.pending.sessionId, status: 'excluded' })
        return { configured: true, sessions: reports, revision: state.revision }
      }
      const workspaceKey = await resolveWorkspaceKey(loaded, fetchImpl, base, config.token, master, () => undefined)
      const workspacePath = resolvePath(workspaceKey)
      if (workspacePath === undefined) {
        reports.push({ sessionId: state.pending.sessionId, status: 'unmapped', revision: state.revision, ...workspaceKey === undefined ? {} : { workspaceKey } })
        return { configured: true, sessions: reports, revision: state.revision }
      }
      reports.push(await pullSession(applyDeps, fetchImpl, base, master, state.pending.sessionId, workspacePath, loaded))
      await deps.afterApply?.(state.pending.sessionId)
    } catch (error: unknown) {
      const classified = classifySyncError(error)
      deps.logger?.warn(`dsh-session-cloudsync: 恢复 ${state.pending.sessionId} 失败：${classified.message}`)
      reports.push({ sessionId: state.pending.sessionId, status: 'error', error: classified.message, kind: classified.kind })
      return { configured: true, sessions: reports, revision: state.revision }
    }
  }

  for (let page = 0; page < 20; page += 1) {
    const cursor = await readCursor(fetchImpl, base, config.token, revision)
    const prepared: Array<{ readonly sessionId: string; readonly loaded: LoadedRemote; readonly revision: number }> = []
    for (const change of cursor.sessions) {
      if (change.deletedAt !== null) {
        reports.push({ sessionId: change.sessionId, status: 'tombstone' })
        continue
      }
      try {
        prepared.push({
          sessionId: change.sessionId,
          revision: change.revision,
          loaded: await loadRemoteHeader(fetchImpl, base, config.token, master, change.sessionId),
        })
      } catch (error: unknown) {
        const classified = classifySyncError(error)
        deps.logger?.warn(`dsh-session-cloudsync: 读取 ${change.sessionId} 的会话头失败：${classified.message}`)
        reports.push({ sessionId: change.sessionId, status: 'error', error: classified.message, kind: classified.kind })
        continue
      }
    }

    // 子代理先建、根后建：深度从大到小。同级按创建时间，保证稳定。
    prepared.sort((left, right) =>
      (right.loaded.meta?.delegationDepth ?? -1) - (left.loaded.meta?.delegationDepth ?? -1)
      || (left.loaded.meta?.createdAt ?? 0) - (right.loaded.meta?.createdAt ?? 0)
      || left.sessionId.localeCompare(right.sessionId))
    const preparedById = new Map(prepared.map((item) => [item.sessionId, item.loaded]))

    for (const item of prepared) {
      if (item.loaded.remote.deletedAt !== undefined) {
        reports.push({ sessionId: item.sessionId, status: 'tombstone' })
        continue
      }
      notifyProgress(deps, { sessionId: item.sessionId, direction: 'pull', phase: 'start', progress: 0 })
      applyStarted = undefined
      try {
        const rootId = await resolveRootSessionId(
          item.loaded,
          fetchImpl,
          base,
          config.token,
          master,
          (sessionId) => preparedById.get(sessionId),
        )
        if (excluded.has(rootId)) {
          reports.push({ sessionId: item.sessionId, status: 'excluded' })
          notifyProgress(deps, { sessionId: item.sessionId, direction: 'pull', phase: 'done', progress: 1 })
          continue
        }
        const workspaceKey = await resolveWorkspaceKey(
          item.loaded,
          fetchImpl,
          base,
          config.token,
          master,
          (sessionId) => preparedById.get(sessionId),
        )
        const workspacePath = resolvePath(workspaceKey)
        if (workspacePath === undefined) {
          reports.push({
            sessionId: item.sessionId,
            status: 'unmapped',
            revision: item.revision,
            ...workspaceKey === undefined ? {} : { workspaceKey },
            ...item.loaded.meta === undefined ? {} : {
              createdAt: item.loaded.meta.createdAt,
              formatVersion: item.loaded.meta.formatVersion,
            },
          })
          notifyProgress(deps, {
            sessionId: item.sessionId, direction: 'pull', phase: 'done', progress: 1,
            error: '未映射工作区：unmapped',
          })
          continue
        }
        const report = await pullSession(applyDeps, fetchImpl, base, master, item.sessionId, workspacePath, item.loaded)
        reports.push(report)
        if (report.status === 'local-active' || report.status === 'local-ahead') {
          deferredRevision = deferredRevision === undefined
            ? item.revision
            : Math.min(deferredRevision, item.revision)
        }
        notifyProgress(deps, {
          sessionId: item.sessionId, direction: 'pull',
          phase: report.status === 'error' ? 'error' : 'done',
          progress: report.status === 'error' ? 0 : 1,
          ...report.totalEvents === undefined ? {} : { totalEvents: report.totalEvents },
          ...report.applied === undefined ? {} : { doneEvents: report.applied },
          ...report.error === undefined ? {} : { error: report.error },
        })
      } catch (error: unknown) {
        const classified = classifySyncError(error)
        deps.logger?.warn(`dsh-session-cloudsync: 拉取 ${item.sessionId} 失败：${classified.message}`)
        reports.push({
          sessionId: item.sessionId,
          status: 'error',
          error: classified.message,
          kind: classified.kind,
          ...item.loaded.meta === undefined ? {} : {
            createdAt: item.loaded.meta.createdAt,
            formatVersion: item.loaded.meta.formatVersion,
          },
        })
        notifyProgress(deps, { sessionId: item.sessionId, direction: 'pull', phase: 'error', progress: 0, error: classified.message })
        // 已经调用 beforeApply 的失败会留下 pending；此时必须停下，不能
        // 让下一个会话覆盖唯一一条恢复记录。只读阶段的分叉/格式错误没有
        // pending，可以跳过该会话，继续处理其他安全会话。
        if (applyStarted !== undefined) return { configured: true, sessions: reports, revision: state.revision }
        continue
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

  if (deps.attach !== undefined) {
    const unique = new Map<string, string | undefined>()
    for (const attachment of attachments) {
      if (!unique.has(attachment.sessionId)) unique.set(attachment.sessionId, attachment.workspacePath)
    }
    for (const [sessionId, workspacePath] of unique) {
      try {
        await deps.attach(sessionId, workspacePath)
      } catch (error: unknown) {
        const classified = classifySyncError(error)
        deps.logger?.warn(`dsh-session-cloudsync: 挂载 ${sessionId} 失败：${classified.message}`)
        reports.push({ sessionId, status: 'error', error: classified.message, kind: classified.kind })
        return { configured: true, sessions: reports, revision: state.revision }
      }
    }
  }

  const nextRevision = reports.some((report) => report.status === 'error')
    ? state.revision
    : deferredRevision === undefined
      ? revision
      : Math.min(revision, Math.max(0, deferredRevision - 1))
  return {
    configured: true,
    sessions: reports,
    revision: nextRevision,
  }
}

/** 导出默认值，便于配置/测试。 */
export { DEFAULT_BATCH_BYTES, DEFAULT_BATCH_EVENTS }
