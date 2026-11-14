/**
 * dsh-session-cloudsync 宿主插件入口。
 *
 * M4：在 M3 的推拉引擎外面加一层同步控制器——手动触发、状态快照和
 * `/api/session-cloudsync/*` 宿主 API。未配置时也加载，设置/首启界面需要读取
 * `setup` 与 `status`。
 *
 * @module dsh-session-cloudsync
 */
import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse } from 'node:path'
import { SyncController, type SyncRunResult, type TaskRunner } from './controller.ts'
import { buildSessionTree, pathKeyOf } from './closure.ts'
import { planSync, type LocalPlanSnapshot, type RemoteSessionSummary, type SyncPlanEntry, type SyncReceipt } from './sync-plan.ts'
import { prepareReplaceScript } from './replace.ts'
import {
  correctCwd as correctSessionCwd,
  pullSessionTask,
  pushSessionTask,
  readRemoteSessionMeta,
  probeServer,
  repairSessionAttachments,
  verifyPassphrase as verifyRemotePassphrase,
  testConnection,
  type AttachmentBridge,
  type AttachmentRef,
  type AttachmentRepairReport,
  type CreateHeaderLike,
  type CreateOptions,
  type EngineConfig,
  type PassphraseCheck,
  type PullState,
  type RemoteSessionMeta,
  type ServerProbeResult,
  type WriteHandleLike,
  type SyncLogger,
  type SyncProgress,
} from './engine.ts'
import { performance } from 'node:perf_hooks'
import { createHostApi, type CreatedWorkspace, type DirectoryPickResult, type HostFetchRoute, type SyncControl, type WorkspacePathState } from './host-api.ts'
import { createEventStreamResponse } from './event-stream.ts'
import { PerfCollector } from './perf.ts'
import { DevLogSink, withDevLog } from './dev-log.ts'
import { DeviceLeaseKeeper } from './device-lease.ts'
import { SyncScheduler } from './scheduler.ts'
import { readPullJournal, writePlanDiagnostics, writePullJournal, STATE_VERSION, type PullJournal } from './state.ts'
import { emptyBindings, keyForPath, pathForKey, readBindings, bindWorkspace as bindWorkspaceFile, type WorkspaceBindings } from './bindings.ts'
import { vaultKeyForConfig, readWorkspaceProfileLabels, syncVault } from './vault-sync.ts'
import { workspaceKeyOf as deriveWorkspaceKey } from '../../shared/src/vault.ts'
import type { SessionScopeResult, SetupInfo, SyncConfigSnapshot, SyncSessionCandidate, SyncTaskView, SyncWorkspaceCandidate, SyncWorkspaceList } from './status.ts'

/** 插件在加载器里的名字。 */
export const name = 'dsh-session-cloudsync'

/** 本插件读取的服务；缺任何一个都由加载器在装载期报错，而不是运行期。 */
export const inject = ['sessions', 'sessionPersistence', 'sessionProjections', 'workspaceRegistry', 'credentials']

/** 宿主附件服务里本插件用到的最小接口（`ctx.get('attachments')`）。 */
interface AttachmentStoreLike {
  readImage(ref: AttachmentRef & { readonly kind: 'image' }): Promise<{ readonly data: Uint8Array }>
  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }): Promise<{ readonly attachmentId: string }>
  readFileStream(ref: AttachmentRef & { readonly kind: 'file' }): AsyncIterable<Uint8Array>
  saveFile(input: { readonly data: Uint8Array; readonly name?: string }): Promise<{ readonly attachmentId: string }>
  imageHostPath(ref: AttachmentRef & { readonly kind: 'image' }): string
  fileHostPath(ref: AttachmentRef & { readonly kind: 'file' }): string
}

/**
 * 把宿主的附件服务包成引擎要的读写桥。
 * @param store - `ctx.get('attachments')`；缺失时返回 undefined，附件同步整体跳过。
 * @returns 附件桥，或 undefined。
 */
function attachmentBridgeOf(store: unknown): AttachmentBridge | undefined {
  if (store === null || typeof store !== 'object') return undefined
  const attachments = store as Partial<AttachmentStoreLike>
  if (typeof attachments.readImage !== 'function' || typeof attachments.saveImage !== 'function'
    || typeof attachments.readFileStream !== 'function' || typeof attachments.saveFile !== 'function'
    || typeof attachments.imageHostPath !== 'function' || typeof attachments.fileHostPath !== 'function') {
    return undefined
  }
  const typed = attachments as AttachmentStoreLike
  return {
    async read(ref) {
      if (ref.kind === 'image') return (await typed.readImage(ref)).data
      const chunks: Uint8Array[] = []
      for await (const chunk of typed.readFileStream(ref)) chunks.push(chunk)
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    },
    async exists(ref) {
      try {
        const path = ref.kind === 'image' ? typed.imageHostPath(ref) : typed.fileHostPath(ref)
        return typeof path === 'string' && existsSync(path)
      } catch {
        return false
      }
    },
    async write(ref, data) {
      if (ref.kind === 'file') {
        const saved = await typed.saveFile({ data, name: ref.name })
        if (saved.attachmentId !== ref.attachmentId) throw new Error(`文件落盘 id 不符：${saved.attachmentId}`)
        return
      }
      const saved = await typed.saveImage({
        data,
        mediaType: ref.mediaType,
        ...ref.name === undefined ? {} : { name: ref.name },
      })
      if (saved.attachmentId === ref.attachmentId) return
      // 图片归一化策略不同会换 id；回退为按 digest 直写对象，再读回校验。
      const path = typed.imageHostPath(ref)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, data)
      try {
        chmodSync(path, 0o444)
      } catch {
        // Windows 可能不支持改 mode。
      }
      await typed.readImage(ref)
    },
  }
}

/** token / passphrase 在 DSH 凭据库里的引用名。 */
const CREDENTIAL_REFS = {
  token: 'DSH_SESSION_CLOUDSYNC_TOKEN',
  passphrase: 'DSH_SESSION_CLOUDSYNC_PASSPHRASE',
} as const

/** 插件配置。 */
export interface Config {
  /** 总开关。默认 true。 */
  enabled?: boolean
  /** 自部署服务端地址；空表示未配置。 */
  serverUrl?: string
  /** 设备 token；仅作 bootstrap fallback，推荐用 DSH credentials。 */
  token?: string
  /** 同步口令；仅作 bootstrap fallback，推荐用 DSH credentials。 */
  passphrase?: string
  /** 可选：base64 的 16 字节 KDF 盐；缺省由服务端地址派生。 */
  salt?: string
  /** 本设备短标签；空表示未使用。 */
  deviceName?: string
  /** 显式选中的根会话 id；空数组表示不选任何会话。 */
  syncSessionIds?: string[]
  /** 是否自动按间隔推送，默认 true；关闭后只做一次启动推送。 */
  autoSync?: boolean
  /** 自动推送间隔（毫秒），默认 60000，最小 1000。 */
  intervalMs?: number
  /** 是否同步子代理会话，默认 true。 */
  includeSubagents?: boolean
  /** 单批最多事件数，默认 50。 */
  batchEvents?: number
  /** 单批最多规范 JSON 字节数，默认 256 KiB。 */
  batchBytes?: number
  /** 单次 HTTP 读取超时（毫秒），默认 10000。 */
  requestTimeoutMs?: number
  /** 开发模式：把插件日志同时发到本地 dev 控制台；默认关闭。 */
  debug?: boolean
  /** 开发控制台日志接收地址，例如 `http://127.0.0.1:3092/api/log/a`。 */
  devLogUrl?: string
}

/** 配置 schema；非敏感字段可被 DSH 设置页直接编辑并热更新。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  serverUrl: z.string().default('').volatile(),
  token: z.string().default(''),
  passphrase: z.string().default(''),
  salt: z.string().default(''),
  deviceName: z.string().default('').volatile(),
  syncSessionIds: z.array(z.string()).default([]).volatile(),
  autoSync: z.boolean().default(false).volatile(),
  intervalMs: z.number().min(1000).default(60000).volatile(),
  includeSubagents: z.boolean().default(true).volatile(),
  batchEvents: z.number().min(1).default(50).volatile(),
  batchBytes: z.number().min(1024).default(256 * 1024).volatile(),
  requestTimeoutMs: z.number().min(1000).default(10_000).volatile(),
  debug: z.boolean().default(false).volatile(),
  devLogUrl: z.string().default('').volatile(),
})

/** 活动的会话类型（由 ctx.sessions 推导，避免手写 DSH 内部类型）。 */
type LiveSession = NonNullable<ReturnType<Context['sessions']['get']>>

/** workspace 服务的最小接口（类型包不在本插件依赖里）。 */
interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  attachSession(sessionId: SessionId): Promise<void>
}

interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  create(path: string, title: string): Promise<WorkspaceLike>
  list?(): readonly WorkspaceLike[]
}

/** dsh-settings 的最小接口；设置服务不存在时自动加入上传名单会跳过。 */
interface SettingsLike {
  readonly writable?: boolean
  describe(options?: { readonly redactSecrets?: boolean }): readonly SettingsDescriptorLike[]
  mutate(ns: string, ops: readonly SettingsPathOpLike[], expectedRevision?: number): Promise<void>
}

interface SettingsDescriptorLike {
  readonly ns: string
  readonly revision: number
  readonly value?: unknown
}

type SettingsPathOpLike =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** `ctx.connection` 的最小结构（类型包不在本插件依赖里）。 */
interface ConnectionLike {
  readonly fetch: {
    register(route: HostFetchRoute): () => Promise<void>
  }
}

/** `ctx.credentials` 的最小结构（类型包不在本插件依赖里）。 */
interface CredentialsLike {
  resolve(ref: string): Promise<{ readonly value: string; readonly source: string } | undefined>
}

/** `sessionProjectionCache` 的最小结构；未加载该可选服务时跳过。 */
interface ProjectionCacheLike {
  coldSnapshot(meta: unknown, inheritedEventCount: number, events: readonly unknown[]): unknown
  cachedSnapshot(meta: unknown, keys?: readonly string[]): unknown
}

/** 运行期可被凭据刷新/配置引用改写的引擎配置。 */
type MutableEngineConfig = { -readonly [K in keyof EngineConfig]: EngineConfig[K] }

/**
 * 找出持久化状态文件路径。
 * @param ctx - 插件上下文。
 * @returns 路径；找不到 home 时 undefined。
 */
function statePathOf(ctx: Context): string | undefined {
  const homePath = ctx.get('dshHomePath') as unknown
  if (typeof homePath === 'function') {
    try {
      return (homePath as (path: string) => string)('session-cloudsync/state.json')
    } catch {
      return undefined
    }
  }
  const home = process.env.DSH_HOME
  return home === undefined || home === '' ? undefined : join(home, 'session-cloudsync', 'state.json')
}

/**
 * 从路径取一个显示标题。
 * @param path - 工作区路径。
 * @returns 最后一段；路径为空时返回原值。
 */
function titleOfPath(path: string): string {
  const parts = path.split(/[\\/]/u).filter((part) => part !== '')
  return parts.at(-1) ?? path
}

/**
 * 读取 Schemastery 的 volatile 字段：它可能被解析成带 `.get()` 的稳定引用，
 * 而不是裸值。非 volatile 字段原样返回。
 * @param value - 原始配置字段。
 * @returns 解引用后的值。
 */
function readVolatile<T>(value: unknown): T | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get: () => T }).get()
  }
  return value as T | undefined
}

/**
 * 注册插件。
 * @param ctx - 插件上下文；所有注册都随该 fiber 销毁。
 * @param config - 服务端、凭据与批次参数。
 */
export function apply(ctx: Context, config: Config): void {
  const envDevLogUrl = process.env.DSH_SESSION_CLOUDSYNC_DEV_LOG?.trim() ?? ''
  const envSyncServerUrl = process.env.DSH_SESSION_CLOUDSYNC_SERVER_URL?.trim() ?? ''
  const envSyncToken = process.env.DSH_SESSION_CLOUDSYNC_TOKEN?.trim() ?? ''
  const envSyncPassphrase = process.env.DSH_SESSION_CLOUDSYNC_PASSPHRASE?.trim() ?? ''
  const envSyncDeviceName = process.env.DSH_SESSION_CLOUDSYNC_DEVICE_NAME?.trim() ?? ''
  let debug = envDevLogUrl !== '' || readVolatile<boolean>(config.debug) === true
  let devLogUrl = envDevLogUrl !== ''
    ? envDevLogUrl
    : (readVolatile<string>(config.devLogUrl)?.trim() ?? '')
  const baseLogger: SyncLogger = {
    info: (message) => ctx.logger.info(message),
    warn: (message) => ctx.logger.warn(message),
    error: (message) => ctx.logger.error(message),
  }
  const logger = withDevLog(baseLogger, new DevLogSink({
    enabled: () => debug && devLogUrl !== '',
    url: () => devLogUrl,
  }))

  if (readVolatile<boolean>(config.enabled) === false) {
    logger.info('dsh-session-cloudsync: 已禁用')
    return
  }
  let serverUrl = envSyncServerUrl !== ''
    ? envSyncServerUrl
    : (readVolatile<string>(config.serverUrl) ?? '')
  const yamlToken = readVolatile<string>(config.token) ?? ''
  const yamlPassphrase = readVolatile<string>(config.passphrase) ?? ''
  const configToken = envSyncToken !== '' ? envSyncToken : yamlToken
  const configPassphrase = envSyncPassphrase !== '' ? envSyncPassphrase : yamlPassphrase
  let intervalMs = readVolatile<number>(config.intervalMs) ?? 60000
  let syncSessionIds: string[] = []
  let salt = readVolatile<string>(config.salt) ?? ''
  let includeSubagents = readVolatile<boolean>(config.includeSubagents) !== false
  let deviceName = envSyncDeviceName !== ''
    ? envSyncDeviceName
    : (readVolatile<string>(config.deviceName) ?? '')
  let autoSync = readVolatile<boolean>(config.autoSync) === true
  let batchEvents = readVolatile<number>(config.batchEvents) ?? 50
  let batchBytes = readVolatile<number>(config.batchBytes) ?? 256 * 1024
  let requestTimeoutMs = readVolatile<number>(config.requestTimeoutMs) ?? 10_000
  // 每次 DSH 进程启动生成一次；同一进程内 lease/append 复用，重启后换新值。
  const clientId = randomBytes(16).toString('hex')

  const readSyncSessions = (): string[] => {
    const raw = readVolatile<unknown>(config.syncSessionIds)
    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : []
  }
  syncSessionIds = readSyncSessions()

  const engineConfig: MutableEngineConfig = {
    serverUrl,
    token: configToken,
    passphrase: configPassphrase,
    ...salt === '' ? {} : { salt },
    includeSubagents,
    syncSessionIds,
    batchEvents,
    batchBytes,
    requestTimeoutMs,
    clientId,
  }

  let scheduler: SyncScheduler | undefined

  /**
   * 重新读取 volatile 引用。设置页写入后，DSH 可能原地更新引用而不重启
   * 插件；每轮同步/设置读取前调用，保证不会一直拿 apply 时的旧值。
   */
  const refreshConfig = (): void => {
    serverUrl = envSyncServerUrl !== ''
      ? envSyncServerUrl
      : (readVolatile<string>(config.serverUrl) ?? '')
    intervalMs = readVolatile<number>(config.intervalMs) ?? 60000
    syncSessionIds = readSyncSessions()
    salt = readVolatile<string>(config.salt) ?? ''
    includeSubagents = readVolatile<boolean>(config.includeSubagents) !== false
    deviceName = envSyncDeviceName !== ''
      ? envSyncDeviceName
      : (readVolatile<string>(config.deviceName) ?? '')
    autoSync = readVolatile<boolean>(config.autoSync) === true
    batchEvents = readVolatile<number>(config.batchEvents) ?? 50
    batchBytes = readVolatile<number>(config.batchBytes) ?? 256 * 1024
    requestTimeoutMs = readVolatile<number>(config.requestTimeoutMs) ?? 10_000
    debug = envDevLogUrl !== '' || readVolatile<boolean>(config.debug) === true
    devLogUrl = envDevLogUrl !== ''
      ? envDevLogUrl
      : (readVolatile<string>(config.devLogUrl)?.trim() ?? '')
    engineConfig.serverUrl = serverUrl
    engineConfig.includeSubagents = includeSubagents
    engineConfig.syncSessionIds = syncSessionIds
    engineConfig.batchEvents = batchEvents
    engineConfig.batchBytes = batchBytes
    engineConfig.requestTimeoutMs = requestTimeoutMs
    if (salt === '') delete engineConfig.salt
    else engineConfig.salt = salt
    scheduler?.reconfigure()
  }
  let notifyChanged: (() => void) | undefined
  const deviceLease = new DeviceLeaseKeeper({
    configuration: () => {
      refreshConfig()
      if (serverUrl.trim() === '' || engineConfig.token.trim() === '') return undefined
      return { serverUrl, token: engineConfig.token, clientId, requestTimeoutMs }
    },
    onChange: () => notifyChanged?.(),
    logger,
  })
  let tokenSource: string | null = envSyncToken !== ''
    ? 'env'
    : configToken.trim() === '' ? null : 'config'
  let passphraseSource: string | null = envSyncPassphrase !== ''
    ? 'env'
    : configPassphrase === '' ? null : 'config'
  let refreshingSecrets: Promise<void> | undefined

  /**
   * 从 DSH 凭据库解析 token/口令；凭据缺失时保留 YAML 的 bootstrap 值。
   * 每轮同步前调用，凭据修改后下一轮即生效。
   */
  const refreshSecrets = async (): Promise<void> => {
    if (refreshingSecrets !== undefined) return refreshingSecrets
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    if (credentials === undefined) return
    refreshingSecrets = (async () => {
      const resolve = async (name: string, ref: string): Promise<{ readonly value: string; readonly source: string } | undefined> => {
        try {
          return await credentials.resolve(ref)
        } catch (error: unknown) {
          logger.warn(`dsh-session-cloudsync: 读取 ${name} 凭据失败：${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      }
      const [tokenValue, passphraseValue] = await Promise.all([
        resolve('token', CREDENTIAL_REFS.token),
        resolve('passphrase', CREDENTIAL_REFS.passphrase),
      ])
      const credentialToken = tokenValue?.value ?? ''
      const credentialPassphrase = passphraseValue?.value ?? ''
      engineConfig.token = envSyncToken !== ''
        ? envSyncToken
        : credentialToken !== '' ? credentialToken : configToken
      engineConfig.passphrase = envSyncPassphrase !== ''
        ? envSyncPassphrase
        : credentialPassphrase !== '' ? credentialPassphrase : configPassphrase
      tokenSource = envSyncToken !== ''
        ? 'env'
        : credentialToken !== ''
          ? tokenValue?.source ?? 'credentials'
          : configToken.trim() !== '' ? 'config' : null
      passphraseSource = envSyncPassphrase !== ''
        ? 'env'
        : credentialPassphrase !== ''
          ? passphraseValue?.source ?? 'credentials'
          : configPassphrase.trim() !== '' ? 'config' : null
    })()
    try {
      await refreshingSecrets
    } finally {
      refreshingSecrets = undefined
    }
  }
  const attachmentsBridge = attachmentBridgeOf(ctx.get('attachments'))
  const deps = {
    persistence: {
      list: () => ctx.sessionPersistence.list(),
      open: (id: string, access: 'read') => ctx.sessionPersistence.open(id as SessionId, access),
    },
    sessions: {
      get: (id: string): LiveSession | undefined => ctx.sessions.get(id as SessionId),
      flush: (session: LiveSession) => ctx.sessions.flush(session),
    },
    openWrite: (id: string) => ctx.sessionPersistence.open(id as SessionId, 'write'),
    config: engineConfig,
    logger,
    ...attachmentsBridge === undefined ? {} : { attachments: attachmentsBridge },
    isTailOpen: (events: readonly { readonly seq: number }[]) =>
      interruptedTurnClosers(events as readonly SessionEvent[]).length > 0,
  }

  const workspaceRegistry = ctx.get('workspaceRegistry') as unknown as WorkspaceRegistryLike | undefined
  if (yamlToken !== '' || yamlPassphrase !== '') {
    logger.warn(
      'dsh-session-cloudsync: token/passphrase 仍写在 YAML；建议迁到 DSH 凭据库'
      + `（${CREDENTIAL_REFS.token} / ${CREDENTIAL_REFS.passphrase}），YAML 仅作 fallback`,
    )
  }
  const statePath = statePathOf(ctx)
  const initialJournal: PullJournal = statePath === undefined
    ? { version: STATE_VERSION, revision: 0 }
    : readPullJournal(statePath)
  if (statePath === undefined) logger.info('dsh-session-cloudsync: 找不到 DSH home，拉取状态只保存在内存')
  /** 上次成功对齐的 receipt；没有记录的会话走一次完整扫描。 */
  let receipts: Record<string, SyncReceipt> = { ...(initialJournal.receipts ?? {}) }

  let bindings: WorkspaceBindings = emptyBindings()
  const bindingsDir = statePath === undefined ? undefined : join(dirname(statePath), 'vault')
  const refreshBindings = async (): Promise<void> => {
    bindings = bindingsDir === undefined ? emptyBindings() : await readBindings(bindingsDir)
  }
  let workspaceLabels: Record<string, string> = {}
  /** workspaceKey → 远端记录里的来源工作区路径（HMAC 已校验）。 */
  let workspacePaths: Record<string, string> = {}
  let labelsIdentity: string | undefined
  let labelsFetchedAt = 0
  let remoteInventory: {
    readonly identity: string
    readonly at: number
    readonly byKey: Map<string, string[]>
    readonly summaries: readonly RemoteSessionSummary[]
  } | undefined
  const remoteLastSeq = new Map<string, number>()
  /** 旧服务端摘要没有 parent/origin 时，从加密头补读的缓存。 */
  const remoteMetaCache = new Map<string, { readonly headChainHash: string; readonly meta: RemoteSessionMeta }>()
  const refreshWorkspaceLabels = async (): Promise<void> => {
    if (statePath === undefined || bindingsDir === undefined) return
    if (engineConfig.token.trim() === '' || engineConfig.passphrase === '') return
    const identity = `${serverUrl}\u0000${engineConfig.token}\u0000${engineConfig.passphrase}\u0000${engineConfig.salt ?? ''}`
    if (identity === labelsIdentity && Date.now() - labelsFetchedAt < 60_000) return
    try {
      const result = await readWorkspaceProfileLabels({
        serverUrl,
        token: engineConfig.token,
        passphrase: engineConfig.passphrase,
        ...engineConfig.salt === undefined || engineConfig.salt === '' ? {} : { salt: engineConfig.salt },
        clientId: engineConfig.clientId ?? '0000000000000000',
        deviceName,
        dshHome: dirname(dirname(statePath)),
        stateDir: dirname(statePath),
        workspaces: [],
        ...engineConfig.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: engineConfig.requestTimeoutMs },
      })
      workspaceLabels = result.labels
      workspacePaths = result.paths
      labelsIdentity = identity
      labelsFetchedAt = Date.now()
    } catch (error: unknown) {
      labelsIdentity = identity
      labelsFetchedAt = Date.now()
      logger.warn(`dsh-session-cloudsync: 读取 Vault 工作区 label 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /**
   * 读取远端会话摘要；扫描规划与设置页共用同一份 15s 缓存。
   * 这里保留无 workspaceKey 的子会话，避免远端树在 pull 时才补行。
   * @returns 全部远端摘要。
   */
  const readRemoteSummaries = async (): Promise<readonly RemoteSessionSummary[]> => {
    const base = serverUrl.trim().replace(/\/+$/u, '')
    const token = engineConfig.token.trim()
    if (base === '' || token === '') return []
    const identity = `${base}\u0000${token}`
    if (remoteInventory !== undefined && remoteInventory.identity === identity && Date.now() - remoteInventory.at < 15_000) {
      return remoteInventory.summaries
    }
    if (remoteInventory?.identity !== identity) {
      remoteLastSeq.clear()
      remoteMetaCache.clear()
    }
    const byKey = new Map<string, string[]>()
    const summaries: RemoteSessionSummary[] = []
    try {
      let cursor: string | undefined
      for (let page = 0; page < 50; page += 1) {
        const query = cursor === undefined
          ? 'limit=200'
          : `cursor=${encodeURIComponent(cursor)}&limit=200`
        const response = await fetch(`${base}/v2/sessions?${query}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(engineConfig.requestTimeoutMs ?? 10_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json() as {
          readonly value?: {
            readonly nextCursor?: unknown
            readonly sessions?: readonly Partial<RemoteSessionSummary>[]
          }
        }
        const sessions = body.value?.sessions ?? []
        for (const session of sessions) {
          const sessionId = session.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') continue
          if (typeof session.lastSeq !== 'number' || !Number.isSafeInteger(session.lastSeq)) continue
          if (typeof session.formatVersion !== 'number' || !Number.isSafeInteger(session.formatVersion)) continue
          if (typeof session.createdAt !== 'number' || !Number.isSafeInteger(session.createdAt)) continue
          if (typeof session.headChainHash !== 'string') continue
          const workspaceKey = typeof session.workspaceKey === 'string' && session.workspaceKey !== ''
            ? session.workspaceKey
            : undefined
          const summary: RemoteSessionSummary = {
            sessionId,
            formatVersion: session.formatVersion,
            createdAt: session.createdAt,
            lastSeq: session.lastSeq,
            headChainHash: session.headChainHash,
            ...workspaceKey === undefined ? {} : { workspaceKey },
            ...typeof session.safeThroughSeq === 'number' && Number.isSafeInteger(session.safeThroughSeq)
              ? { safeThroughSeq: session.safeThroughSeq } : {},
            ...typeof session.tailOpen === 'boolean' ? { tailOpen: session.tailOpen } : {},
            ...typeof session.parentSession === 'string' && session.parentSession !== ''
              ? { parentSession: session.parentSession } : {},
            ...typeof session.origin === 'string' && session.origin !== '' ? { origin: session.origin } : {},
            ...typeof session.delegationDepth === 'number' && Number.isSafeInteger(session.delegationDepth)
              ? { delegationDepth: session.delegationDepth } : {},
            ...typeof session.deletedAt === 'number' ? { deletedAt: session.deletedAt } : {},
          }
          summaries.push(summary)
          remoteLastSeq.set(sessionId, session.lastSeq)
          if (workspaceKey !== undefined) {
            const list = byKey.get(workspaceKey) ?? []
            list.push(sessionId)
            byKey.set(workspaceKey, list)
          }
        }
        cursor = typeof body.value?.nextCursor === 'string' && body.value.nextCursor !== ''
          ? body.value.nextCursor
          : undefined
        if (cursor === undefined) break
      }
    } catch (error: unknown) {
      logger.warn(`dsh-session-cloudsync: 读取远端会话清单失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    remoteInventory = { identity, at: Date.now(), byKey, summaries }
    return summaries
  }

  /**
   * 兼容设置页/映射页的按 workspaceKey 聚合视图。
   * @returns workspaceKey → sessionId 列表。
   */
  const readRemoteInventory = async (): Promise<Map<string, string[]>> => {
    try {
      await readRemoteSummaries()
    } catch {
      return remoteInventory?.byKey ?? new Map()
    }
    return remoteInventory?.byKey ?? new Map()
  }

  let vaultKeyCache: { readonly identity: string; readonly key: Buffer } | undefined
  const currentVaultKey = (): Buffer | undefined => {
    const identity = `${serverUrl}\u0000${engineConfig.passphrase}\u0000${engineConfig.salt ?? ''}`
    if (vaultKeyCache?.identity === identity) return vaultKeyCache.key
    try {
      const key = vaultKeyForConfig({
        serverUrl,
        passphrase: engineConfig.passphrase,
        ...engineConfig.salt === undefined || engineConfig.salt === '' ? {} : { salt: engineConfig.salt },
      })
      vaultKeyCache = { identity, key }
      return key
    } catch {
      return undefined
    }
  }
  const workspaceKeyForCwd = (_sessionId: string, cwd: string): string | undefined => {
    const raw = cwd.trim()
    if (raw === '') return undefined
    const registered = (workspaceRegistry?.list?.() ?? []).find((workspace) => pathKeyOf(workspace.path) === pathKeyOf(raw))
    const localPath = registered?.path ?? raw
    const bound = keyForPath(bindings, localPath)
    if (bound !== undefined) return bound
    const vaultKey = currentVaultKey()
    return vaultKey === undefined ? undefined : deriveWorkspaceKey(vaultKey, localPath)
  }

  /**
   * 本地工作区自己的 key 直接视为已映射：同一路径在任意设备上应当得到同一个
   * workspaceKey，不需要用户在映射页里“把自己映射给自己”。
   */
  const localWorkspacePathForKey = (key: string): string | undefined => {
    try {
      const vaultKey = currentVaultKey()
      for (const workspace of workspaceRegistry?.list?.() ?? []) {
        if (keyForPath(bindings, workspace.path) === key) return workspace.path
        // 已绑定别的远端 key 后，本路径自己的派生 key 仍然属于它。
        if (vaultKey !== undefined && deriveWorkspaceKey(vaultKey, workspace.path) === key) return workspace.path
      }
    } catch (error: unknown) {
      logger.warn(`dsh-session-cloudsync: 读取本地工作区失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return undefined
  }

  const resolveWorkspacePath = (key: string): string | undefined =>
    pathForKey(bindings, key) ?? localWorkspacePathForKey(key)

  const persistState = (state: PullState): void => {
    if (statePath === undefined) return
    try {
      writePullJournal(statePath, {
        version: STATE_VERSION,
        revision: state.revision,
        ...state.pending === undefined ? {} : { pending: state.pending },
        ...state.cwdPending === undefined || state.cwdPending.length === 0 ? {} : { cwdPending: state.cwdPending },
        ...state.blocked === undefined || state.blocked.length === 0 ? {} : { blocked: state.blocked },
        ...state.blockedDecisions === undefined || state.blockedDecisions.length === 0 ? {} : { blockedDecisions: state.blockedDecisions },
        ...state.unmapped === undefined || state.unmapped.length === 0 ? {} : { unmapped: state.unmapped },
        ...Object.keys(receipts).length === 0 ? {} : { receipts },
      })
    } catch (error: unknown) {
      logger.warn(`dsh-session-cloudsync: 写状态文件失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const runVault = async (): Promise<void> => {
    if (statePath === undefined) return
    refreshConfig()
    await refreshSecrets()
    let workspaces: Array<{ path: string; title: string }> = []
    try {
      workspaces = (workspaceRegistry?.list?.() ?? [])
        .map((workspace) => ({ path: workspace.path, title: workspace.title }))
    } catch (error: unknown) {
      logger.warn(`dsh-session-cloudsync: 读取 Vault 工作区失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const result = await syncVault({
      serverUrl,
      token: engineConfig.token,
      passphrase: engineConfig.passphrase,
      ...engineConfig.salt === undefined || engineConfig.salt === '' ? {} : { salt: engineConfig.salt },
      clientId,
      requestTimeoutMs,
      deviceName,
      dshHome: dirname(dirname(statePath)),
      stateDir: join(dirname(statePath), 'vault'),
      workspaces,
      ...process.env.DSH_VERSION === undefined ? {} : { dshVersion: process.env.DSH_VERSION },
      ...process.env.DSH_PROFILE === undefined ? {} : { dshProfile: process.env.DSH_PROFILE },
    }, logger)
    if (result.appended > 0) labelsIdentity = undefined
  }

  const configuration = (): { configured: boolean; reason?: string } => {
    refreshConfig()
    if (serverUrl.trim() === '') return { configured: false, reason: 'serverUrl 未配置' }
    if (engineConfig.token.trim() === '') return { configured: false, reason: 'token 未配置' }
    if (engineConfig.passphrase === '') return { configured: false, reason: 'passphrase 未配置' }
    return { configured: true }
  }

  // 所有 pull 都必须经过这一把锁：当前任务执行和未来任何入口。
  let pullTail: Promise<unknown> = Promise.resolve()
  const withPullLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = pullTail.then(operation, operation)
    pullTail = run.then(() => undefined, () => undefined)
    return run
  }

  const autoUploadRoots = new Set<string>()

  /** 读取 dsh-settings；不存在时返回 undefined，不把设置页当成硬依赖。 */
  const settingsService = (): SettingsLike | undefined => {
    try {
      const value = (ctx as unknown as { get(name: string): unknown }).get('settings')
      if (value === null || typeof value !== 'object') return undefined
      const settings = value as Partial<SettingsLike>
      if (typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') return undefined
      return settings as SettingsLike
    } catch {
      return undefined
    }
  }

  /**
   * 把首次成功拉取的根会话补进上传白名单，并让设置页的勾选反映出来。
   * 只在首次冷拉取时调用；用户之后手动取消勾选不会被下一轮重新加回。
   */
  const flushAutoUpload = async (): Promise<void> => {
    if (autoUploadRoots.size === 0) return
    const settings = settingsService()
    if (settings === undefined || settings.writable === false) return
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const descriptor = settings.describe({ redactSecrets: true }).find((entry) => {
          if (entry.ns.includes('session-cloudsync')) return true
          const value = entry.value
          return value !== null && typeof value === 'object'
            && Array.isArray((value as Record<string, unknown>)['syncSessionIds'])
            && typeof (value as Record<string, unknown>)['serverUrl'] === 'string'
        })
        if (descriptor === undefined) return
        const raw = descriptor.value
        if (raw === null || typeof raw !== 'object') return
        const value = raw as Record<string, unknown>
        const current = Array.isArray(value['syncSessionIds'])
          ? value['syncSessionIds'].filter((entry): entry is string => typeof entry === 'string')
          : []
        const next = [...new Set([...current, ...autoUploadRoots])]
        if (next.length !== current.length) {
          await settings.mutate(descriptor.ns, [{
            op: 'set',
            path: ['syncSessionIds'],
            value: next,
          }], descriptor.revision)
          refreshConfig()
        }
        autoUploadRoots.clear()
        return
      } catch (error: unknown) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        if (!/changed since it was read/u.test(message)) break
      }
    }
    logger.warn(`dsh-session-cloudsync: 自动加入上传名单失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }
  const perf = new PerfCollector()
  let taskRunner: TaskRunner | undefined
  const controller = new SyncController({
    tasks: {
      scan: (mode, hooks) => taskRunner!.scan(mode, hooks),
      execute: (task, update) => taskRunner!.execute(task, update),
    },
    persist: persistState,
    configuration,
    intervalMs,
    deviceLease: () => deviceLease.snapshot(),
    scheduler: () => scheduler?.snapshot() ?? {
      autoSync,
      intervalMs,
      nextRunAt: null,
      backoffUntil: null,
    },
    initial: {
      revision: initialJournal.revision,
      ...initialJournal.cursor === undefined ? {} : { cursor: initialJournal.cursor },
      ...initialJournal.pending === undefined ? {} : { pending: initialJournal.pending },
      ...initialJournal.cwdPending === undefined ? {} : { cwdPending: initialJournal.cwdPending },
      ...initialJournal.blocked === undefined ? {} : { blocked: initialJournal.blocked },
      ...initialJournal.blockedDecisions === undefined ? {} : { blockedDecisions: initialJournal.blockedDecisions },
      ...initialJournal.unmapped === undefined ? {} : { unmapped: initialJournal.unmapped },
    },
    logger,
  })
  notifyChanged = () => controller.notifyChanged()

  // 分叉会话已经无法安全确定远端历史；Host 侧在模型 step 前拒绝，
  // 避免只有 client composer 提示、实际仍能继续写本地。
  // dsh-agent 只提供事件类型、不是本插件的运行时依赖；这里只声明用到的
  // 最小监听形状，避免为了一个类型引入额外 peer。
  type PreStepPayloadLike = {
    readonly agent: {
      readonly session: {
        readonly header: {
          readonly id: string
          readonly createdAt: number
          readonly version: number
          readonly origin?: string
          readonly parentSession?: string
        }
      }
    }
  }
  const onPreStep = ctx.on.bind(ctx) as unknown as (
    event: 'agent/pre-step',
    listener: (payload: PreStepPayloadLike, next: () => Promise<unknown>) => Promise<unknown>,
  ) => () => void
  onPreStep('agent/pre-step', async (payload, next) => {
    // 根会话分叉时，子代理也不能继续跑；沿 durable header 的 subagent 链往上查。
    let header = payload.agent.session.header
    const visited = new Set<string>()
    while (!visited.has(header.id)) {
      if (controller.isBlocked(header.id, header.createdAt, header.version)) return { kind: 'reject' as const }
      visited.add(header.id)
      if (header.origin !== 'subagent' || header.parentSession === undefined) break
      const parent = ctx.sessions.get(header.parentSession as SessionId)
      if (parent !== undefined) {
        header = parent.header
        continue
      }
      // 父会话可能还没有恢复；直接读持久化 header，避免子代理绕过根会话的阻塞。
      const snapshot = await ctx.sessionPersistence.stat(header.parentSession as SessionId)
      if (snapshot === undefined) break
      header = snapshot.header
    }
    return next()
  })

  /**
   * 新拉取的冷会话没有 projection cache；先做一次 cold snapshot 再 attach，
   * 让 DSH 列表能从缓存读到标题等投影。失败时只告警，不影响会话落地。
   * @param sessionId - 已写入本地的会话。
   */
  const warmProjectionCache = async (sessionId: string): Promise<void> => {
    const cache = ctx.get('sessionProjectionCache') as ProjectionCacheLike | undefined
    if (cache === undefined || typeof cache.coldSnapshot !== 'function') return
    const handle = await ctx.sessionPersistence.open(sessionId as SessionId, 'read')
    try {
      const read = await handle.read()
      cache.coldSnapshot(handle.header, handle.inheritedEventCount ?? 0, read.events)
      // coldSnapshot 的落盘是 fire-and-forget；等 title 行可见后再 attach，
      // 避免列表恰好读到尚未写完的缓存。大会话的 projection checkpoint 可能
      // 超过旧实现的 250ms 窗口，这里给 2s 并留下诊断。
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (typeof cache.cachedSnapshot !== 'function') return
        if (cache.cachedSnapshot(handle.header, ['title']) !== undefined) return
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
      logger.warn(`dsh-session-cloudsync: 会话 ${sessionId} 的标题投影在 2s 内未就绪，继续挂载`)
    } finally {
      await handle.close()
    }
  }

  /** 启动/整轮前预占的写句柄：防前端在拉取前把会话"复活"。 */
  const pullHolds = new Map<string, WriteHandleLike>()

  const pullDeps = {
    persistence: {
      stat: (id: string) => ctx.sessionPersistence.stat(id as SessionId),
      create: (header: CreateHeaderLike, options?: CreateOptions) =>
        ctx.sessionPersistence.create(
          header as unknown as Parameters<typeof ctx.sessionPersistence.create>[0],
          options as Parameters<typeof ctx.sessionPersistence.create>[1],
        ),
      open: (id: string, access: 'read' | 'write') => ctx.sessionPersistence.open(id as SessionId, access),
    },
    sessions: deps.sessions,
    config: engineConfig,
    ...attachmentsBridge === undefined ? {} : { attachments: attachmentsBridge },
    takeHeldHandle: (id: string) => {
      const handle = pullHolds.get(id)
      if (handle === undefined) return undefined
      pullHolds.delete(id)
      return handle
    },
    attach: async (sessionId: string, mappedPath?: string): Promise<void> => {
      if (workspaceRegistry === undefined) throw new Error('workspaceRegistry 不可用')
      if (mappedPath === undefined || mappedPath === '') throw new Error('会话没有可用的本地工作区落点')
      controller.updateProgress({
        sessionId, direction: 'pull', phase: 'progress', stage: 'projecting', progress: 1,
      })
      try {
        await warmProjectionCache(sessionId)
      } catch (error: unknown) {
        logger.warn(`dsh-session-cloudsync: 预热会话投影缓存失败：${error instanceof Error ? error.message : String(error)}`)
      }
      controller.updateProgress({
        sessionId, direction: 'pull', phase: 'progress', stage: 'attaching', progress: 1,
      })
      const workspace = (await workspaceRegistry.resolveByPath(mappedPath))
        ?? (await workspaceRegistry.create(mappedPath, 'Session Sync'))
      await workspace.attachSession(sessionId as SessionId)
    },
    onFirstPull: (sessionId: string): void => {
      if (!syncSessionIds.includes(sessionId)) autoUploadRoots.add(sessionId)
    },
    logger,
    beforeApply: async (sessionId: string, targetSeq: number): Promise<void> => {
      controller.beginApply(sessionId, targetSeq)
    },
    afterApply: async (sessionId: string): Promise<void> => {
      controller.endApply(sessionId)
    },
  }
  /**
   * 把外部同步进来的本地根会话补挂到官方 workspace。
   * @param snapshots - 当前本地会话快照。
   */
  const reconcileWorkspaceAttachments = async (
    snapshots: readonly { readonly header: { readonly id: string; readonly createdAt: number; readonly cwd?: string } }[],
  ): Promise<void> => {
    const registered = workspaceRegistry?.list?.() ?? []
    if (registered.length === 0) return
    const tree = buildSessionTree(snapshots)
    for (const root of tree.roots) {
      const cwd = root.root.header.cwd?.trim() ?? ''
      if (cwd === '') continue
      const workspace = registered.find((item) => pathKeyOf(item.path) === pathKeyOf(cwd))
      if (workspace === undefined) continue
      const sessionId = String(root.root.header.id)
      const attached = workspace.sessionIds ?? []
      if (attached.includes(sessionId)) continue
      try {
        await workspace.attachSession(sessionId as SessionId)
      } catch (error: unknown) {
        logger.warn(`dsh-session-cloudsync: 归组 ${sessionId} 到 workspace 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * 读取一个本地会话的最末事件序号；只在 revision/receipt 无法判断方向时调用。
   * @param sessionId - 会话 id。
   * @returns 最末 seq；读取失败时为 undefined。
   */
  const readLocalLastSeq = async (sessionId: string): Promise<number | undefined> => {
    try {
      const handle = await ctx.sessionPersistence.open(sessionId as SessionId, 'read')
      try {
        const read = await handle.read()
        return read.events.length === 0 ? -1 : read.events[read.events.length - 1]!.seq
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      logger.warn(`dsh-session-cloudsync: 读取 ${sessionId} 的本地进度失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  const taskEntries = new Map<string, SyncPlanEntry>()
  /**
   * 把规划条目转成气泡任务。
   * @param entry - 规划结果。
   * @param state - 初始任务状态。
   * @param ordinal - 稳定顺序。
   * @returns 任务视图。
   */
  const taskOf = (
    entry: SyncPlanEntry,
    state: SyncTaskView['state'],
    ordinal: number,
  ): SyncTaskView => {
    const direction: SyncTaskView['direction'] = entry.action === 'pull'
      ? 'pull'
      : entry.action === 'push'
        ? 'push'
        : entry.local === undefined ? 'pull' : 'push'
    const localLast = entry.localLastSeq ?? -1
    const remoteLast = entry.remoteLastSeq ?? -1
    const totalEvents = direction === 'pull'
      ? Math.max(0, remoteLast - localLast)
      : Math.max(0, localLast - remoteLast)
    return {
      ordinal,
      sessionId: entry.sessionId,
      rootId: entry.rootId,
      ...entry.parentSession === undefined ? {} : { parentSession: entry.parentSession },
      depth: entry.depth,
      direction,
      state,
      reason: state === 'checking'
        ? 'checking'
        : entry.reason === 'blocked'
          ? 'blocked'
          : entry.action === 'push'
            ? entry.reason === 'remote-missing' ? 'remote-missing' : 'local-ahead'
            : entry.reason === 'local-missing' ? 'local-missing' : 'remote-ahead',
      totalEvents,
      doneEvents: 0,
      progress: 0,
      ...state === 'blocked' ? { error: entry.error ?? '会话被阻塞' } : {},
    }
  }

  /**
   * 只读规划：拉远端摘要、本地快照和 receipt，算出每个会话的方向与差值。
   * 不做传输、不写 receipt；`scan` 与单会话状态查询共用这一份规划。
   * @param mode - 手动/自动；只影响诊断日志的粒度。
   * @returns 规划条目、远端摘要与本地快照。
   */
  const planRound = async (mode: 'auto' | 'manual') => {
    refreshConfig()
      await refreshSecrets()
      await refreshBindings()
      const snapshots = await ctx.sessionPersistence.list()
      await reconcileWorkspaceAttachments(snapshots)
      let remote = await readRemoteSummaries()
      // 兼容没有 parent/origin/depth 摘要字段的旧服务端：对无 workspaceKey、
      // 无父链信息的远端会话补读一次加密头，之后按 headChainHash 缓存。
      remote = await Promise.all(remote.map(async (summary) => {
        if (summary.parentSession !== undefined || summary.origin !== undefined) return summary
        if (typeof summary.workspaceKey === 'string' && summary.workspaceKey !== '') return summary
        const cached = remoteMetaCache.get(summary.sessionId)
        if (cached !== undefined && cached.headChainHash === summary.headChainHash) {
          return { ...summary, ...cached.meta }
        }
        try {
          const meta = await readRemoteSessionMeta({ config: engineConfig }, summary.sessionId)
          remoteMetaCache.set(summary.sessionId, { headChainHash: summary.headChainHash, meta })
          return { ...summary, ...meta }
        } catch (error: unknown) {
          logger.warn(`dsh-session-cloudsync: 补读 ${summary.sessionId} 的远端树元数据失败：${error instanceof Error ? error.message : String(error)}`)
          return summary
        }
      }))
      const localSnapshots = await Promise.all(snapshots.map(async (snapshot) => {
        const sessionId = String(snapshot.header.id)
        const remoteSummary = remote.find((summary) => summary.sessionId === sessionId)
        if (remoteSummary === undefined) return snapshot
        const receipt = receipts[sessionId]
        const localKnown = snapshot.eventCount !== undefined
        const localRevision = typeof snapshot.revision === 'string' ? snapshot.revision : undefined
        const remoteSame = receipt !== undefined
          && receipt.remoteLastSeq === remoteSummary.lastSeq
          && (receipt.remoteHeadChainHash === '' || receipt.remoteHeadChainHash === remoteSummary.headChainHash)
        // 字节数不变即没有新事件（追加型日志），这是最便宜的判定；
        // 命中时不必再去读一遍大日志。
        const sizeSame = receipt !== undefined
          && receipt.localSizeBytes !== undefined
          && snapshot.sizeBytes !== undefined
          ? receipt.localSizeBytes === snapshot.sizeBytes
          : undefined
        // revision/receipt 足够判断方向时不读本地大日志；只有“两边都变了”
        // 或没有 receipt 的远端已存在会话才补读 lastSeq。
        const needLastSeq = !localKnown && sizeSame !== true && (
          receipt === undefined
          || (receipt.localRevision !== undefined && localRevision !== undefined
            && receipt.localRevision !== localRevision && !remoteSame)
          || (receipt.localRevision === undefined && !remoteSame)
        )
        if (!needLastSeq) return snapshot
        const lastSeq = await readLocalLastSeq(sessionId)
        return lastSeq === undefined ? snapshot : { ...snapshot, lastSeq }
      }))
      const selected = new Set(syncSessionIds)
      // 本机工作区自己的 key 也视为已映射：否则删掉 bindings 后，本地
      // key 与远端 key 相同的 workspace 会被误判为未绑定。
      const bound = new Set(Object.keys(bindings.bindings))
      for (const workspace of workspaceRegistry?.list?.() ?? []) {
        const localKey = workspaceKeyForCwd('', workspace.path)
        if (localKey !== undefined) bound.add(localKey)
      }
      // 拉取范围独立于上传白名单：本机 key 与远端 workspace key 相同的
      // 本地根也要参与校验/拉取，否则已有本地会话永远不会更新。
      const pullRoots = new Set<string>()
      const localTree = buildSessionTree(localSnapshots)
      for (const root of localTree.roots) {
        const cwd = root.root.header.cwd?.trim() ?? ''
        const key = cwd === '' ? undefined : workspaceKeyForCwd('', cwd)
        if (key !== undefined && bound.has(key)) pullRoots.add(String(root.root.header.id))
      }
      const plannedRoots = new Set([...selected, ...pullRoots])
      const plan = planSync({
        local: localSnapshots as unknown as readonly LocalPlanSnapshot[],
        remote,
        selectedRoots: [...plannedRoots],
        includeSubagents: engineConfig.includeSubagents !== false,
        boundWorkspaceKeys: bound,
        receipts,
      })
      // 未在 syncSessionIds 里的根只允许 pull，不能因为本机领先而上传。
      const entries = plan.entries.filter((entry) =>
        entry.action !== 'push' || selected.has(entry.rootId))
      if (mode === 'manual') {
        const counts = { push: 0, pull: 0, none: 0, blocked: 0 }
        for (const entry of entries) {
          if (entry.reason === 'blocked') counts.blocked += 1
          else counts[entry.action] += 1
        }
        // 一次手动规划的构成，用于复核“全部待上传/待拉取”这类误判：
        // 远端摘要条数与三个动作的数应能对上账。
        logger.info(`dsh-session-cloudsync: 本轮规划 push=${counts.push} pull=${counts.pull} 已对齐=${counts.none} 阻塞=${counts.blocked}（远端摘要 ${remote.length} 条，本地 ${snapshots.length} 条）`)
        // 同一份信息落一份诊断文件：产品 profile 没有 console exporter，
        // logger 不一定可见；出问题时可以直接读这个文件对账。
        if (statePath !== undefined) {
          try {
            writePlanDiagnostics(join(dirname(statePath), 'last-plan.json'), {
              at: Date.now(),
              remoteCount: remote.length,
              localCount: snapshots.length,
              counts,
              entries: entries.map((entry) => {
                const receipt = receipts[entry.sessionId]
                const revision = entry.local?.revision
                return {
                  sessionId: entry.sessionId,
                  action: entry.action,
                  reason: entry.reason,
                  ...entry.localLastSeq === undefined ? {} : { localLastSeq: entry.localLastSeq },
                  ...entry.remoteLastSeq === undefined ? {} : { remoteLastSeq: entry.remoteLastSeq },
                  hasReceipt: receipt !== undefined,
                  ...receipt === undefined || revision === undefined
                    ? {} : { revisionSame: receipt.localRevision === revision },
                  remoteKnown: entry.remote !== undefined,
                }
              }),
            })
          } catch (error: unknown) {
            logger.warn(`dsh-session-cloudsync: 写规划诊断失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    return { entries, remote, snapshots }
  }

  /** 单会话状态查询：复用只读规划，同一份结果在 2 秒内复用。 */
  const SESSION_STATUS_TTL_MS = 2_000
  let planMemo: { at: number; value: ReturnType<typeof planRound> } | undefined
  /**
   * 取单会话的规划条目（共享 2 秒规划缓存）。
   * @param sessionId - 会话 id。
   * @returns 规划条目；不在同步范围时为 undefined。
   */
  const planEntry = async (sessionId: string) => {
    const now = Date.now()
    if (planMemo === undefined || now - planMemo.at > SESSION_STATUS_TTL_MS) {
      const value = planRound('auto')
      // 规划失败不能在缓存里留一个 rejected promise，否则这 2 秒内每次查询都失败。
      value.catch(() => {
        if (planMemo?.value === value) planMemo = undefined
      })
      planMemo = { at: now, value }
    }
    const round = await planMemo.value
    return round.entries.find((item) => item.sessionId === sessionId)
  }
  /**
   * 单会话定向同步。
   *
   * 拉取对正在运行的会话无解（引擎返回 local-active），所以条栏只给推送；
   * 推送必须持有全局写入租约，否则返回 lease-held 让调用方置灰。
   * @param sessionId - 目标会话。
   * @param direction - 方向。
   * @returns 本轮结果。
   */
  const syncSession = async (sessionId: string, direction: 'push' | 'pull'): Promise<SyncRunResult> => {
    const entry = await planEntry(sessionId)
    if (entry === undefined) {
      return { ok: false, code: 'not-in-scope', message: '会话不在同步范围', status: controller.snapshot() }
    }
    if (direction === 'push' && !(await deviceLease.ensure())) {
      return { ok: false, code: 'lease-held', message: '未持有全局同步租约，稍后再试', status: controller.snapshot() }
    }
    const base = taskOf(entry, 'queued', 0)
    const localLast = entry.localLastSeq ?? -1
    const remoteLast = entry.remoteLastSeq ?? -1
    const totalEvents = direction === 'push'
      ? Math.max(0, localLast - remoteLast)
      : Math.max(0, remoteLast - localLast)
    const task = { ...base, direction, totalEvents, doneEvents: 0, progress: 0 }
    taskEntries.set(sessionId, entry)
    return controller.runTasks([task], { manual: true })
  }
  /**
   * 单会话状态查询。
   * @param sessionId - 会话 id。
   * @returns 状态视图；不在同步范围时为 undefined。
   */
  const sessionStatus = async (sessionId: string) => {
    const entry = await planEntry(sessionId)
    if (entry === undefined) return undefined
    // 会话正在跑时，磁盘/回执里的末序号是滞后的；live 对象里的内存日志才是
    // 实时值（`ownEvents()` 是 Session 的公开方法，不触发读盘）。
    let liveLast: number | undefined
    let live = false
    let tailOpen = false
    try {
      const session = ctx.sessions.get(entry.sessionId as SessionId) as unknown as
        { ownEvents?: () => readonly SessionEvent[] } | undefined
      if (session !== undefined) {
        live = true
        const events = typeof session.ownEvents === 'function' ? session.ownEvents() : undefined
        if (events !== undefined) {
          if (events.length > 0) liveLast = events[events.length - 1]!.seq
          // 尾未闭合 = 正在生成/工具执行中，推送只能到安全边界。
          tailOpen = interruptedTurnClosers(events).length > 0
        }
      }
    } catch {
      // 读不到 live 尾巴就退回规划值。
    }
    const plannedLocal = entry.localLastSeq ?? null
    const localLastSeq = liveLast !== undefined && (plannedLocal === null || liveLast > plannedLocal)
      ? liveLast
      : plannedLocal
    return {
      sessionId: entry.sessionId,
      rootId: entry.rootId,
      depth: entry.depth,
      action: entry.action,
      reason: entry.reason,
      localLastSeq,
      remoteLastSeq: entry.remoteLastSeq ?? null,
      headChainHash: entry.remote?.headChainHash ?? null,
      formatVersion: entry.remote?.formatVersion ?? entry.local?.header.version ?? null,
      blocked: entry.reason === 'blocked' ? entry.error ?? '会话被阻塞' : null,
      upload: syncSessionIds.includes(entry.rootId),
      live,
      tailOpen,
    }
  }

  taskRunner = {
    /**
     * 传输前把"要拉取"的本地会话写句柄全部占住。
     *
     * 前端在页面加载后会恢复上次会话（占写句柄），导致拉取只能等它关闭；
     * 提前占住可以让 resume 直接失败，把拉取窗口保住。已 live/本地不存在的
     * 会话跳过；任何失败只记日志，不影响本轮。
     * @param tasks - 本轮任务表。
     */
    async hold(tasks) {
      for (const task of tasks) {
        if (task.direction !== 'pull' || task.state === 'blocked') continue
        const id = task.sessionId
        if (pullHolds.has(id)) continue
        if (ctx.sessions.get(id as SessionId) !== undefined) continue
        const snapshot = await ctx.sessionPersistence.stat(id as SessionId)
        if (snapshot === undefined) continue
        try {
          pullHolds.set(id, await ctx.sessionPersistence.open(id as SessionId, 'write'))
        } catch (error: unknown) {
          // 已被别的 writer 占住：交给拉取自己的 deferral。
        }
      }
    },
    /** 释放所有预占句柄。 */
    async releaseHolds() {
      const handles = [...pullHolds.values()]
      pullHolds.clear()
      for (const handle of handles) {
        try { await handle.close() } catch { /* 关闭失败不影响结果 */ }
      }
    },
    async scan(mode, hooks) {
      const { entries, remote, snapshots } = await planRound(mode)
      // up-to-date 不产生任务，但顺手把 receipt 的 revision 补齐，下一轮
      // 不再因为旧 receipt 没有 revision 而重新读取/拉取。
      for (const entry of entries) {
        if (entry.action !== 'none' || entry.reason !== 'up-to-date') continue
        if (entry.local === undefined || entry.remote === undefined) continue
        const previous = receipts[entry.sessionId]
        receipts[entry.sessionId] = {
          sessionId: entry.sessionId,
          ...entry.local.revision === undefined ? {} : { localRevision: entry.local.revision },
          ...entry.local.sizeBytes === undefined ? {} : { localSizeBytes: entry.local.sizeBytes },
          localEventCount: previous?.localEventCount ?? Math.max(0, (entry.remote.safeThroughSeq ?? entry.remote.lastSeq) + 1),
          localLastSeq: entry.localLastSeq ?? entry.remote.lastSeq,
          remoteLastSeq: entry.remote.lastSeq,
          remoteHeadChainHash: entry.remote.headChainHash,
          formatVersion: entry.remote.formatVersion,
          checkedAt: Date.now(),
        }
      }
      // 旧任务路径或崩溃可能留下 pending；如果本地已经和远端一致，
      // 直接结束这条 pending，避免永久锁住会话。
      const pending = controller.snapshot().pending
      if (pending !== null && pending !== undefined) {
        const pendingEntry = entries.find((entry) => entry.sessionId === pending.sessionId)
        if (pendingEntry !== undefined && pendingEntry.reason === 'up-to-date' && pendingEntry.action === 'none') {
          controller.endApply(pending.sessionId)
        }
      }
      taskEntries.clear()
      for (const entry of entries) taskEntries.set(entry.sessionId, entry)
      const autoEntries = entries.filter((entry) => entry.action !== 'none' || entry.reason === 'blocked')
      const total = mode === 'manual' ? entries.length : autoEntries.length
      const leaseHeld = deviceLease.snapshot().state === 'held'
      const withLease = (tasks: readonly SyncTaskView[]): SyncTaskView[] => tasks.map((task) =>
        task.direction === 'push' && !leaseHeld && task.state !== 'blocked'
          ? { ...task, state: 'deferred', error: '等待全局同步租约' }
          : task)
      if (mode === 'auto') {
        const tasks = withLease(autoEntries.map((entry, index) =>
          taskOf(entry, entry.reason === 'blocked' ? 'blocked' : 'queued', index)))
        hooks.setTasks(tasks)
        hooks.setScan(tasks.length, tasks.length)
        return { tasks }
      }

      // 手动同步：全部选中会话先进入 checking；只分类，不传输。
      const tasks = entries.map((entry, index) => taskOf(entry, 'checking', index))
      hooks.setTasks(tasks)
      hooks.setScan(0, total)
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      const scanStarted = Date.now()
      const remaining: SyncTaskView[] = []
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!
        if (entry.reason === 'blocked') {
          remaining.push(taskOf(entry, 'blocked', index))
        } else if (entry.action !== 'none') {
          remaining.push(taskOf(entry, 'queued', index))
        }
        hooks.setScan(index + 1, total, entry.sessionId)
        await new Promise<void>((resolve) => { setImmediate(resolve) })
      }
      // 校验可能只有 1 个会话；给前端一个可观测的校验窗口。
      const remainingMs = 300 - (Date.now() - scanStarted)
      if (remainingMs > 0) await new Promise<void>((resolve) => { setTimeout(resolve, remainingMs) })
      // 校验全部完成后再替换任务表：up-to-date 会话在这里一次性移除，
      // 校验期间保留完整体验，避免单会话在一帧内闪掉。
      const finalTasks = withLease(remaining)
      hooks.setTasks(finalTasks)
      hooks.setScan(total, total)
      return { tasks: finalTasks }
    },

    async execute(task, update) {
      const entry = taskEntries.get(task.sessionId)
      if (entry === undefined) throw new Error('任务对应的规划条目已失效')
      const reportProgress = (progress: SyncProgress): void => {
        // 只合并本条进度实际携带的字段；total/done 为 undefined 时由
        // controller 保留当前任务的高水位，避免写入阶段把下载进度清零。
        update({
          state: 'running',
          ...progress.stage === undefined ? {} : { stage: progress.stage },
          ...progress.totalEvents === undefined ? {} : { totalEvents: progress.totalEvents },
          ...progress.doneEvents === undefined ? {} : { doneEvents: progress.doneEvents },
          progress: progress.progress,
          ...progress.error === undefined ? {} : { error: progress.error },
          ...progress.bytes === undefined ? {} : { totalBytes: progress.bytes },
          ...progress.doneBytes === undefined ? {} : { doneBytes: progress.doneBytes },
        })
        perf.progress(progress)
      }
      const commonDeps = {
        config: engineConfig,
        onProgress: reportProgress,
        onPerf: (sample: Parameters<typeof perf.metric>[0]) => perf.metric(sample),
        onPerfStart: (sample: Parameters<typeof perf.beginOperation>[0]) => perf.beginOperation(sample),
      }
      if (task.direction === 'push') {
        if (deviceLease.snapshot().state !== 'held') {
          return { state: 'deferred', totalEvents: task.totalEvents, doneEvents: task.doneEvents, error: '等待全局同步租约' }
        }
        if (entry.local === undefined) throw new Error('推送任务缺少本地快照')
        const report = await pushSessionTask({
          ...deps,
          ...commonDeps,
          workspaceKeyOf: workspaceKeyForCwd,
        }, entry.local as never, entry.depth === 0)
        if (report.status === 'error') {
          return {
            state: 'failed',
            totalEvents: report.totalEvents ?? task.totalEvents,
            doneEvents: report.doneEvents ?? 0,
            error: report.error ?? '推送失败',
          }
        }
        if (report.status === 'remote-ahead') {
          // 远端在这一轮里已经前进；缓存必须失效，否则紧接着的一轮会拿旧摘要
          // 把本机算成领先，把整批会话误报成“待上传”。
          remoteInventory = undefined
          return { state: 'deferred', totalEvents: task.totalEvents, doneEvents: task.doneEvents, error: '远端已领先，等待下一轮拉取' }
        }
        if (report.status === 'skipped') {
          return { state: 'deferred', totalEvents: task.totalEvents, doneEvents: task.doneEvents, error: report.error ?? '会话本轮跳过' }
        }
        if (report.status === 'up-to-date') {
          // 规划说“本地领先”，执行时却已是最新：几乎只可能是规划用的远端摘要
          // 过期（15s 缓存）。丢掉缓存并在日志里留一条，下一轮就能自愈。
          remoteInventory = undefined
          logger.info(`dsh-session-cloudsync: 会话 ${entry.sessionId} 规划为推送但远端已是最新，已丢弃远端摘要缓存`)
        }
        // 远端摘要已经变化；下一轮必须重读，不能继续用 15s 缓存。
        remoteInventory = undefined
        // 回执必须落在「实际推送到的位置」上：规划阶段的 localLastSeq 可能来自
        // 旧回执（例如本地只多出一条 end-seed 时不会补读最后序号），照抄会让
        // 下一轮把刚上传的事件重新算成待下载，再白跑一次拉取才自愈。
        const localLast = report.lastSeq
          ?? entry.localLastSeq
          ?? Math.max(-1, (entry.local.eventCount ?? 0) - 1)
        receipts[entry.sessionId] = {
          sessionId: entry.sessionId,
          ...entry.local.revision === undefined ? {} : { localRevision: entry.local.revision },
          ...entry.local.sizeBytes === undefined ? {} : { localSizeBytes: entry.local.sizeBytes },
          localEventCount: entry.local.eventCount ?? Math.max(0, localLast + 1),
          localLastSeq: localLast,
          remoteLastSeq: localLast,
          remoteHeadChainHash: report.headChainHash ?? '',
          formatVersion: entry.local.header.version,
          checkedAt: Date.now(),
        }
        return {
          state: 'done',
          totalEvents: report.totalEvents ?? task.totalEvents,
          doneEvents: report.doneEvents ?? report.totalEvents ?? task.totalEvents,
          ...report.bytes === undefined ? {} : { totalBytes: report.bytes, doneBytes: report.bytes },
        }
      }
      const report = await withPullLock(() =>
        pullSessionTask({
          ...pullDeps,
          ...commonDeps,
          workspacePathOf: resolveWorkspacePath,
        }, entry.sessionId, entry.local !== undefined))
      if (report.status === 'error') {
        return {
          state: 'failed',
          totalEvents: report.totalEvents ?? task.totalEvents,
          doneEvents: 0,
          error: report.error ?? '拉取失败',
        }
      }
      if (report.status === 'unmapped' || report.status === 'excluded') {
        return { state: 'deferred', totalEvents: task.totalEvents, doneEvents: task.doneEvents, error: report.error ?? '会话未映射' }
      }
      if (report.status === 'local-active' || report.status === 'write-owned' || report.status === 'local-ahead') {
        return { state: 'deferred', totalEvents: report.totalEvents ?? task.totalEvents, doneEvents: 0, error: report.error ?? '等待会话写入结束' }
      }
      const safe = entry.remote?.safeThroughSeq ?? entry.remoteLastSeq ?? -1
      // 拉取也会推进远端（别的设备可能在同一轮里推送），缓存必须失效，
      // 否则紧接着的一轮会拿旧摘要规划出方向相反的空任务。
      remoteInventory = undefined
      if (entry.remote !== undefined) {
        const after = await ctx.sessionPersistence.stat(entry.sessionId as SessionId)
        receipts[entry.sessionId] = {
          sessionId: entry.sessionId,
          ...after?.revision === undefined ? {} : { localRevision: after.revision },
          ...after?.sizeBytes === undefined ? {} : { localSizeBytes: after.sizeBytes },
          localEventCount: Math.max(0, safe + 1),
          localLastSeq: safe,
          remoteLastSeq: entry.remote.lastSeq,
          remoteHeadChainHash: entry.remote.headChainHash,
          formatVersion: entry.remote.formatVersion,
          checkedAt: Date.now(),
        }
      }
      return {
        state: 'done',
        totalEvents: report.totalEvents ?? task.totalEvents,
        doneEvents: report.applied ?? report.totalEvents ?? task.totalEvents,
      }
    },
  }

  const setup = async (): Promise<SetupInfo> => {
    refreshConfig()
    await refreshSecrets()
    const state = configuration()
    return {
      configured: state.configured,
      reason: state.reason ?? null,
      serverUrl,
      serverUrlSource: envSyncServerUrl !== '' ? 'env' : 'settings',
      deviceName,
      deviceNameSource: envSyncDeviceName !== '' ? 'env' : 'settings',
      syncSessionIds,
        autoSync,
      intervalMs,
      includeSubagents,
      hasToken: engineConfig.token.trim() !== '',
      hasPassphrase: engineConfig.passphrase !== '',
      tokenSource,
      passphraseSource,
      credentialRefs: { ...CREDENTIAL_REFS },
    }
  }

  const runSync = async (
    manual = false,
    trigger?: 'startup' | 'auto' | 'manual',
  ): Promise<Awaited<ReturnType<SyncController['run']>>> => {
    refreshConfig()
    await refreshSecrets()
    await deviceLease.ensure()
    await refreshBindings()
    const activeRun = controller.snapshot().running
    if (!activeRun) perf.begin(trigger ?? (manual ? 'manual' : 'auto'))
    try {
      // 新任务模式由 controller.scan 建立任务表；旧 seed 列表不再参与。
      const result = await controller.run({
        manual,
        ...trigger === undefined ? {} : { trigger },
      })
      if (!activeRun) perf.finish(result.status)
      // 任务模式由下一轮摘要扫描负责映射后的补拉；不再走旧的 cursor 回填。
      await flushAutoUpload()
      void runVault().catch((error: unknown) => {
        logger.warn(`dsh-session-cloudsync: Vault 同步失败：${error instanceof Error ? error.message : String(error)}`)
      })
      return result
    } catch (error: unknown) {
      if (!activeRun) perf.finish(controller.snapshot())
      throw error
    }
  }

  scheduler = new SyncScheduler({
    run: (trigger) => runSync(trigger === 'manual', trigger),
    intervalMs: () => intervalMs,
    autoSync: () => autoSync,
    onChange: () => controller.notifyChanged(),
    logger,
  })

  const workspaces = async (): Promise<SyncWorkspaceList> => {
    refreshConfig()
    await refreshBindings()
    await refreshSecrets()
    await refreshWorkspaceLabels()
    const inventory = await readRemoteInventory()
    const snapshots = await ctx.sessionPersistence.list()
    const tree = buildSessionTree(snapshots)
    const sessions: SyncSessionCandidate[] = []
    const groups = new Map<string, { path: string; rootSessions: number; subagentSessions: number }>()
    for (const entry of tree.roots) {
      const cwd = entry.root.header.cwd?.trim()
      if (cwd === undefined || cwd === '') continue
      const sessionId = String(entry.root.header.id)
      const key = pathKeyOf(cwd)
      const group = groups.get(key) ?? { path: cwd, rootSessions: 0, subagentSessions: 0 }
      group.rootSessions += 1
      group.subagentSessions += entry.descendants.length
      groups.set(key, group)
      sessions.push({
        sessionId,
        workspacePath: cwd,
        createdAt: entry.root.header.createdAt ?? 0,
        formatVersion: entry.root.header.version ?? 0,
        eventCount: entry.root.eventCount ?? 0,
        subagentSessions: entry.descendants.length,
      })
    }
    sessions.sort((left, right) => right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId))

    let registered: readonly WorkspaceLike[] = []
    try {
      registered = workspaceRegistry?.list?.() ?? []
    } catch (error: unknown) {
      logger.warn(`dsh-session-cloudsync: 读取工作区列表失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const candidates: SyncWorkspaceCandidate[] = []
    const seen = new Set<string>()
    for (const workspace of registered) {
      const key = pathKeyOf(workspace.path)
      seen.add(key)
      const group = groups.get(key)
      const candidateKey = workspaceKeyForCwd('', workspace.path)
      candidates.push({
        path: workspace.path,
        title: workspace.title,
        ...candidateKey === undefined ? {} : { workspaceKey: candidateKey },
        rootSessions: group?.rootSessions ?? 0,
        subagentSessions: group?.subagentSessions ?? 0,
      })
    }
    for (const [key, group] of groups) {
      if (seen.has(key)) continue
      const candidateKey = workspaceKeyForCwd('', group.path)
      candidates.push({
        path: group.path,
        title: titleOfPath(group.path),
        ...candidateKey === undefined ? {} : { workspaceKey: candidateKey },
        rootSessions: group.rootSessions,
        subagentSessions: group.subagentSessions,
      })
    }

    const unmapped = new Map<string, number>()
    for (const entry of controller.unmappedSessions()) {
      if (bindings.bindings[entry.workspaceKey] !== undefined) continue
      if (localWorkspacePathForKey(entry.workspaceKey) !== undefined) continue
      unmapped.set(entry.workspaceKey, inventory.get(entry.workspaceKey)?.length ?? 1)
    }
    // 首启映射步骤通常发生在第一次同步之前；Vault 里已有 workspace/profile，
    // 用它补出远端工作区列表，避免“没有未映射工作区”的假象。
    for (const key of Object.keys(workspaceLabels)) {
      if (bindings.bindings[key] !== undefined) continue
      if (localWorkspacePathForKey(key) !== undefined) continue
      // 没有会话的 workspace/profile 是陈旧记录（测试或已删会话），不能当远端工作区。
      if (!inventory.has(key)) continue
      if (!unmapped.has(key)) unmapped.set(key, inventory.get(key)?.length ?? 0)
    }
    for (const key of inventory.keys()) {
      if (bindings.bindings[key] !== undefined) continue
      if (localWorkspacePathForKey(key) !== undefined) continue
      if (!unmapped.has(key)) unmapped.set(key, inventory.get(key)?.length ?? 0)
    }

    const remote = new Map<string, { label?: string; sessions: number; sessionIds?: readonly string[] }>()
    for (const binding of Object.values(bindings.bindings)) {
      const current = remote.get(binding.key)
      const sessionIds = inventory.get(binding.key)
      remote.set(binding.key, {
        ...current?.label === undefined ? {} : { label: current.label },
        ...binding.label === '' ? {} : { label: binding.label },
        ...sessionIds === undefined ? {} : { sessionIds },
        sessions: sessionIds?.length ?? current?.sessions ?? 0,
      })
    }
    for (const [key, label] of Object.entries(workspaceLabels)) {
      const current = remote.get(key)
      const sessionIds = inventory.get(key)
      // 只给“有会话”或“已绑定”的工作区补 label；陈旧记录不生成幽灵行。
      if (sessionIds === undefined && bindings.bindings[key] === undefined) continue
      remote.set(key, {
        ...current?.label === undefined ? {} : { label: current.label },
        label,
        ...sessionIds === undefined ? {} : { sessionIds },
        sessions: sessionIds?.length ?? current?.sessions ?? 0,
      })
    }
    for (const [key, sessionIds] of inventory) {
      const current = remote.get(key)
      remote.set(key, {
        ...current?.label === undefined ? {} : { label: current.label },
        sessionIds,
        sessions: sessionIds.length,
      })
    }

    return {
      workspaces: candidates,
      sessions,
      syncSessionIds,
      bindings: Object.values(bindings.bindings).map((binding) => ({
        workspaceKey: binding.key,
        localPath: binding.localPath,
        label: binding.label,
        createdAt: binding.createdAt,
      })),
      unmapped: [...unmapped.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([workspaceKey, count]) => ({
          workspaceKey,
          sessions: count,
          ...workspaceLabels[workspaceKey] === undefined ? {} : { label: workspaceLabels[workspaceKey] },
        })),
      remoteWorkspaces: [...remote.entries()]
        .map(([workspaceKey, value]) => ({
          workspaceKey,
          sessions: value.sessions,
          ...value.label === undefined ? {} : { label: value.label },
          ...value.sessionIds === undefined ? {} : { sessionIds: value.sessionIds },
          ...workspacePaths[workspaceKey] === undefined ? {} : { path: workspacePaths[workspaceKey] },
        }))
        .sort((left, right) => (left.label ?? left.workspaceKey).localeCompare(right.label ?? right.workspaceKey)),
    }
  }

  const fixCwd = async (sessionId: string) => {
    refreshConfig()
    await refreshSecrets()
    const snapshot = await ctx.sessionPersistence.stat(sessionId as SessionId)
    const target = snapshot?.header.cwd?.trim() ?? ''
    if (target === '') return { ok: false, status: 'error' as const, message: '本地会话没有可用工作区' }
    const result = await correctSessionCwd({
      persistence: pullDeps.persistence,
      sessions: deps.sessions,
      config: engineConfig,
      targetPath: target,
      logger,
    }, sessionId)
    if (result.ok && (result.status === 'corrected' || result.status === 'already-portable')) {
      await pullDeps.attach(sessionId, target)
    }
    return result
  }

  /**
   * 改设置页同一份上传白名单；设置不可写时返回 false。
   * @param sessionId - 目标根会话。
   * @param enabled - 加入/移除。
   * @returns 是否写入成功。
   */
  const writeUploadList = async (sessionId: string, enabled: boolean): Promise<boolean> => {
    const settings = settingsService()
    if (settings === undefined || settings.writable === false) return false
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const descriptor = settings.describe({ redactSecrets: true }).find((entry) => {
          if (entry.ns.includes('session-cloudsync')) return true
          const value = entry.value
          return value !== null && typeof value === 'object'
            && Array.isArray((value as Record<string, unknown>)['syncSessionIds'])
            && typeof (value as Record<string, unknown>)['serverUrl'] === 'string'
        })
        if (descriptor === undefined) return false
        const rawValue = descriptor.value
        if (rawValue === null || typeof rawValue !== 'object') return false
        const raw = rawValue as Record<string, unknown>
        const current = Array.isArray(raw['syncSessionIds'])
          ? raw['syncSessionIds'].filter((entry): entry is string => typeof entry === 'string')
          : []
        const next = enabled
          ? [...new Set([...current, sessionId])]
          : current.filter((entry) => entry !== sessionId)
        if (next.length === current.length && current.includes(sessionId) === enabled) {
          refreshConfig()
          return true
        }
        await settings.mutate(descriptor.ns, [{
          op: 'set',
          path: ['syncSessionIds'],
          value: next,
        }], descriptor.revision)
        refreshConfig()
        return true
      } catch (error: unknown) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        if (!/changed since it was read/u.test(message)) break
      }
    }
    logger.warn(`dsh-session-cloudsync: 写入上传白名单失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
    return false
  }

  /**
   * 单会话「上传本会话」开关。
   *
   * 等价于改设置页的白名单；打开前同步检查工作区绑定，未绑定时返回候选
   * 让前端弹窗——不带 `choice` 时什么都不写。
   * @param sessionId - 目标会话。
   * @param enabled - 打开/关闭。
   * @param choice - `create` 按本地路径新建，或绑定到已有 workspaceKey。
   * @returns 结果。
   */
  const sessionScope = async (
    sessionId: string,
    enabled: boolean,
    choice?: 'create' | string,
  ): Promise<SessionScopeResult> => {
    refreshConfig()
    await refreshBindings()
    if (!enabled) {
      return await writeUploadList(sessionId, false)
        ? { status: 'done', enabled: false }
        : { status: 'error', message: '设置不可写（缺少 dsh-settings）' }
    }
    const snapshot = await ctx.sessionPersistence.stat(sessionId as SessionId)
    const cwd = snapshot?.header.cwd?.trim() ?? ''
    if (cwd === '') return { status: 'unmapped', message: '会话没有可用的 cwd' }
    if (workspaceRegistry === undefined) return { status: 'error', message: 'workspaceRegistry 不可用' }
    const workspace = await workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) return { status: 'unmapped', message: '本地工作区不存在' }
    const localKey = workspaceKeyForCwd('', workspace.path)
    if (localKey === undefined) return { status: 'unmapped', message: '工作区路径无法映射成 key' }
    const bound = bindings.bindings[localKey] !== undefined
      || localWorkspacePathForKey(localKey) !== undefined
    if (!bound && choice === undefined) {
      const list = await workspaces()
      const candidates = list.remoteWorkspaces.map((entry) => ({
        key: entry.workspaceKey ?? '',
        label: entry.label ?? '(未命名)',
        sessions: entry.sessions,
      })).filter((entry) => entry.key !== '')
      return {
        status: 'needs-binding',
        key: localKey,
        path: workspace.path,
        willCreateNew: candidates.length === 0,
        candidates,
      }
    }
    if (bindingsDir === undefined) return { status: 'error', message: '找不到绑定目录' }
    const bindKey = bound ? localKey : choice === 'create' ? localKey : choice!
    if (!bound) {
      await bindWorkspaceFile(bindingsDir, bindKey, workspace.path, workspace.title)
      await refreshBindings()
      labelsIdentity = undefined
    }
    return await writeUploadList(sessionId, true)
      ? { status: 'done', enabled: true, key: bindKey }
      : { status: 'error', message: '设置不可写（缺少 dsh-settings）' }
  }

  /** 目录选择器服务的最小接口（DSH 宿主提供）。 */
  interface DirectoryPickerLike {
    capability(): { readonly kind?: string }
    pick?(signal: AbortSignal): Promise<string | null>
  }

  const canWrite = (path: string): boolean => {
    try {
      accessSync(path, fsConstants.W_OK)
      return true
    } catch {
      return false
    }
  }

  const isDirectoryPath = (path: string): boolean => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * 判断一个目标路径能直接绑定、需要先建目录，还是只能另选。
   * 源路径可能来自另一台设备（不同系统/盘符），所以先判 sameOs 与根是否存在。
   * @param input - 用户输入或远端建议的绝对路径。
   * @returns 三态与各段可写性。
   */
  const inspectWorkspacePath = async (input: string): Promise<WorkspacePathState> => {
    const path = input.trim()
    const sameOs = process.platform === 'win32'
      ? /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
      : path.startsWith('/')
    const root = sameOs && isAbsolute(path) ? parse(path).root : ''
    const rootExists = root !== '' && existsSync(root)
    const exists = sameOs && existsSync(path)
    const directory = exists && isDirectoryPath(path)
    const writable = directory && canWrite(path)
    const parent = directory ? '' : dirname(path)
    const parentExists = sameOs && parent !== '' && parent !== path && existsSync(parent) && isDirectoryPath(parent)
    const parentWritable = parentExists && canWrite(parent)
    const mode = directory && writable ? 'bind' as const : parentExists && parentWritable ? 'create' as const : 'pick' as const
    return {
      path, mode, exists, isDirectory: directory, writable, parentExists, parentWritable, rootExists, sameOs,
    }
  }

  /**
   * 必要时先建目录，再把路径注册成 DSH 工作区。
   * @param input - 绝对路径。
   * @param title - 工作区标题；缺省取目录名。
   * @returns 工作区与是否是新建。
   */
  const createWorkspace = async (input: string, title?: string): Promise<CreatedWorkspace> => {
    const path = input.trim()
    if (path === '' || !isAbsolute(path)) throw new Error('路径必须是绝对路径')
    if (workspaceRegistry === undefined) throw new Error('workspaceRegistry 不可用')
    const state = await inspectWorkspacePath(path)
    if (state.mode === 'pick') throw new Error('这个位置不存在、父目录不可写或不是当前系统的路径')
    const existing = await workspaceRegistry.resolveByPath(path)
    if (existing !== undefined) return { path: existing.path, title: existing.title, created: false }
    mkdirSync(path, { recursive: true })
    const created = await workspaceRegistry.create(path, (title ?? '').trim() || basename(path))
    labelsIdentity = undefined
    return { path: created.path, title: created.title, created: true }
  }

  /**
   * 打开宿主目录选择器：native 返回路径，browse/不可用返回能力形态。
   * @returns 选择结果。
   */
  const pickDirectory = async (): Promise<DirectoryPickResult> => {
    const picker = ctx.get('directoryPicker') as unknown as DirectoryPickerLike | undefined
    if (picker === undefined || typeof picker.capability !== 'function') return { kind: 'unavailable' }
    const capability = picker.capability()
    if (capability.kind === 'native' && typeof picker.pick === 'function') {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120_000)
      try {
        return { kind: 'native', path: await picker.pick(controller.signal) }
      } finally {
        clearTimeout(timer)
      }
    }
    if (capability.kind === 'browse') return { kind: 'browse' }
    return { kind: 'unavailable' }
  }

  const control: SyncControl = {
    status: () => controller.snapshot(),
    sessionStatus,
    syncSession,
    sessionScope,
    repairAttachments: (sessionId: string): Promise<AttachmentRepairReport> => repairSessionAttachments({
      config: engineConfig,
      ...attachmentsBridge === undefined ? {} : { attachments: attachmentsBridge },
      persistence: { open: (id: string, access: 'read') => ctx.sessionPersistence.open(id as SessionId, access) },
    }, sessionId),
    perf: () => perf.snapshot(),
    config: async (): Promise<SyncConfigSnapshot> => {
      const setupInfo = await setup()
      const workspaceList = await workspaces()
      return {
        schemaVersion: 2,
        generatedAt: Date.now(),
        setup: setupInfo,
        status: controller.snapshot(),
        workspaces: workspaceList,
        selection: {
          uploadRootIds: syncSessionIds,
          pull: { mode: 'bound-workspaces' },
        },
      }
    },
    events: async (request: Request) => createEventStreamResponse(request, {
      status: () => controller.snapshot(),
      subscribe: (listener) => controller.subscribe(listener),
    }),
    setup,
    workspaces,
    test: async (serverUrl: string) => testConnection(serverUrl, fetch, engineConfig.requestTimeoutMs),
    probe: async (serverUrl: string, token: string): Promise<ServerProbeResult> => {
      // 设置页没有裸 token；留空时回退到已解析的凭据，避免为了看状态再输一遍。
      if (token.trim() === '') await refreshSecrets()
      return await probeServer(
        { serverUrl, token: token.trim() === '' ? engineConfig.token : token },
        fetch,
        engineConfig.requestTimeoutMs,
      )
    },
    verifyPassphrase: async (serverUrl: string, token: string, passphrase: string): Promise<PassphraseCheck> => {
      if (token.trim() === '') await refreshSecrets()
      return await verifyRemotePassphrase(
        {
          serverUrl,
          token: token.trim() === '' ? engineConfig.token : token,
          passphrase,
          ...engineConfig.salt === undefined || engineConfig.salt === '' ? {} : { salt: engineConfig.salt },
        },
        fetch,
        engineConfig.requestTimeoutMs,
      )
    },
    resolveWorkspacePath: inspectWorkspacePath,
    createWorkspace,
    pickDirectory,
    syncNow: () => scheduler?.manual() ?? runSync(true, 'manual'),
    cwdDecision: async (sessionId: string, action: 'fix' | 'skip') => {
      if (action === 'skip') {
        const snapshot = await ctx.sessionPersistence.stat(sessionId as SessionId)
        await pullDeps.attach(sessionId, snapshot?.header.cwd)
        controller.clearCwdPending(sessionId)
        return { ok: true, status: 'attached' as const }
      }
      if (!(await deviceLease.ensure())) {
        return { ok: false, status: 'lease-held' as const, message: '未持有全局同步租约，暂不能写入 cwd 修正' }
      }
      const result = await fixCwd(sessionId)
      if (result.ok) controller.clearCwdPending(sessionId)
      return result
    },
    resolveBlocked: async (
      sessionId: string,
      action: 'ignore' | 'force' | 'restore',
      createdAt: number,
      formatVersion: number,
    ) => {
      if (action === 'restore') controller.restoreBlocked(sessionId, createdAt, formatVersion)
      else controller.resolveBlocked(sessionId, action, createdAt, formatVersion)
      return { ok: true as const }
    },
    prepareReplace: async (sessionId: string) => {
      const snapshot = await ctx.sessionPersistence.stat(sessionId as SessionId)
      if (snapshot === undefined) throw new Error('本地会话不存在，无法生成覆盖脚本')
      const statePath = statePathOf(ctx)
      if (statePath === undefined) throw new Error('找不到 DSH home，无法生成覆盖脚本')
      return prepareReplaceScript({
        sessionId,
        createdAt: snapshot.header.createdAt,
        formatVersion: snapshot.header.version,
        dshHome: dirname(dirname(statePath)),
        statePath,
        dshPid: process.pid,
      })
    },
    bindWorkspace: async (workspaceKey: string, localPath: string) => {
      refreshConfig()
      if (bindingsDir === undefined) throw new Error('找不到 Vault 状态目录')
      if (workspaceRegistry === undefined) throw new Error('workspaceRegistry 不可用')
      const workspace = await workspaceRegistry.resolveByPath(localPath)
      if (workspace === undefined) throw new Error('本地工作区不存在')
      await bindWorkspaceFile(bindingsDir, workspaceKey, workspace.path, workspace.title)
      await refreshBindings()
      return workspaces()
    },
  }
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection') as ConnectionLike | undefined
    if (connection === undefined) {
      logger.warn('dsh-session-cloudsync: connection 服务不可用，状态/控制 API 未注册')
      return
    }
    for (const route of createHostApi(control)) {
      connectionCtx.effect(
        () => connection.fetch.register(route),
        `dsh-session-cloudsync: ${route.path}`,
      )
    }
  })

  void refreshSecrets().then(async () => {
    const current = configuration()
    if (!current.configured) {
      logger.info(`dsh-session-cloudsync: 未配置（${current.reason ?? '原因未知'}），只提供设置/状态 API`)
    } else {
      await refreshBindings()
      void runSync(false, 'startup').catch((error: unknown) => {
        logger.warn(`dsh-session-cloudsync: 启动同步失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })
  ctx.effect(() => {
    scheduler?.start()
    return () => scheduler?.stop()
  }, 'dsh-session-cloudsync: sync scheduler')
  ctx.effect(() => {
    deviceLease.start()
    return () => { void deviceLease.dispose() }
  }, 'dsh-session-cloudsync: device lease')
}
