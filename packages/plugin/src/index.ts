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
import { dirname, join } from 'node:path'
import { SyncController } from './controller.ts'
import { buildSessionTree, pathKeyOf } from './closure.ts'
import { prepareReplaceScript } from './replace.ts'
import {
  correctCwd as correctSessionCwd,
  pullOnce,
  syncOnce,
  testConnection,
  type CreateHeaderLike,
  type CreateOptions,
  type EngineConfig,
  type PullReport,
  type PullState,
  type SyncLogger,
} from './engine.ts'
import { createHostApi, type HostFetchRoute, type SyncControl } from './host-api.ts'
import { LeaseKeeper } from './lease-keeper.ts'
import { readPullJournal, writePullJournal, STATE_VERSION, type PullJournal } from './state.ts'
import { emptyBindings, keyForPath, pathForKey, readBindings, bindWorkspace as bindWorkspaceFile, type WorkspaceBindings } from './bindings.ts'
import { vaultKeyForConfig, readWorkspaceProfileLabels, syncVault } from './vault-sync.ts'
import { workspaceKeyOf as deriveWorkspaceKey } from '../../shared/src/vault.ts'
import type { SetupInfo, SyncSessionCandidate, SyncWorkspaceCandidate, SyncWorkspaceList } from './status.ts'

/** 插件在加载器里的名字。 */
export const name = 'dsh-session-cloudsync'

/** 本插件读取的服务；缺任何一个都由加载器在装载期报错，而不是运行期。 */
export const inject = ['sessions', 'sessionPersistence', 'sessionProjections', 'workspaceRegistry', 'credentials']

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
  /** 本地排除的根会话 id；子代理跟随根。 */
  excludedSessionIds?: string[]
  /** 是否自动绑定同路径的远端工作区；默认关闭。 */
  autoBindSamePath?: boolean
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
}

/** 配置 schema；非敏感字段可被 DSH 设置页直接编辑并热更新。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  serverUrl: z.string().default('').volatile(),
  token: z.string().default(''),
  passphrase: z.string().default(''),
  salt: z.string().default(''),
  deviceName: z.string().default('').volatile(),
  excludedSessionIds: z.array(z.string()).default([]).volatile(),
  autoBindSamePath: z.boolean().default(false).volatile(),
  autoSync: z.boolean().default(true).volatile(),
  intervalMs: z.number().min(1000).default(60000).volatile(),
  includeSubagents: z.boolean().default(true).volatile(),
  batchEvents: z.number().min(1).default(50).volatile(),
  batchBytes: z.number().min(1024).default(256 * 1024).volatile(),
  requestTimeoutMs: z.number().min(1000).default(10_000).volatile(),
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
  const logger: SyncLogger = {
    info: (message) => ctx.logger.info(message),
    warn: (message) => ctx.logger.warn(message),
    error: (message) => ctx.logger.error(message),
  }

  if (readVolatile<boolean>(config.enabled) === false) {
    logger.info('dsh-session-cloudsync: 已禁用')
    return
  }
  let serverUrl = readVolatile<string>(config.serverUrl) ?? ''
  const configToken = readVolatile<string>(config.token) ?? ''
  const configPassphrase = readVolatile<string>(config.passphrase) ?? ''
  let intervalMs = readVolatile<number>(config.intervalMs) ?? 60000
  let excludedSessionIds: string[] = []
  let autoBindSamePath = readVolatile<boolean>(config.autoBindSamePath) === true
  let salt = readVolatile<string>(config.salt) ?? ''
  let includeSubagents = readVolatile<boolean>(config.includeSubagents) !== false
  let deviceName = readVolatile<string>(config.deviceName) ?? ''
  let autoSync = readVolatile<boolean>(config.autoSync) !== false
  let batchEvents = readVolatile<number>(config.batchEvents) ?? 50
  let batchBytes = readVolatile<number>(config.batchBytes) ?? 256 * 1024
  let requestTimeoutMs = readVolatile<number>(config.requestTimeoutMs) ?? 10_000
  // 每次 DSH 进程启动生成一次；同一进程内 lease/append 复用，重启后换新值。
  const clientId = randomBytes(16).toString('hex')

  const readExcludedSessions = (): string[] => {
    const raw = readVolatile<unknown>(config.excludedSessionIds)
    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : []
  }
  excludedSessionIds = readExcludedSessions()

  const engineConfig: MutableEngineConfig = {
    serverUrl,
    token: configToken,
    passphrase: configPassphrase,
    ...salt === '' ? {} : { salt },
    includeSubagents,
    excludedSessionIds,
    batchEvents,
    batchBytes,
    requestTimeoutMs,
    clientId,
  }

  /**
   * 重新读取 volatile 引用。设置页写入后，DSH 可能原地更新引用而不重启
   * 插件；每轮同步/设置读取前调用，保证不会一直拿 apply 时的旧值。
   */
  const refreshConfig = (): void => {
    serverUrl = readVolatile<string>(config.serverUrl) ?? ''
    intervalMs = readVolatile<number>(config.intervalMs) ?? 60000
    excludedSessionIds = readExcludedSessions()
    autoBindSamePath = readVolatile<boolean>(config.autoBindSamePath) === true
    salt = readVolatile<string>(config.salt) ?? ''
    includeSubagents = readVolatile<boolean>(config.includeSubagents) !== false
    deviceName = readVolatile<string>(config.deviceName) ?? ''
    autoSync = readVolatile<boolean>(config.autoSync) !== false
    batchEvents = readVolatile<number>(config.batchEvents) ?? 50
    batchBytes = readVolatile<number>(config.batchBytes) ?? 256 * 1024
    requestTimeoutMs = readVolatile<number>(config.requestTimeoutMs) ?? 10_000
    engineConfig.serverUrl = serverUrl
    engineConfig.includeSubagents = includeSubagents
    engineConfig.excludedSessionIds = excludedSessionIds
    engineConfig.batchEvents = batchEvents
    engineConfig.batchBytes = batchBytes
    engineConfig.requestTimeoutMs = requestTimeoutMs
    if (salt === '') delete engineConfig.salt
    else engineConfig.salt = salt
  }
  const leaseKeeper = new LeaseKeeper({
    listLiveSessionIds: () => {
      const service = ctx.sessions as unknown as { list?: () => readonly LiveSession[] }
      if (typeof service.list !== 'function') return []
      try {
        return service.list().map((session) => String(session.id))
      } catch (error: unknown) {
        logger.warn(`dsh-session-cloudsync: 读取 live 会话失败：${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    },
    configuration: () => {
      refreshConfig()
      if (serverUrl.trim() === '' || engineConfig.token.trim() === '') return undefined
      return { serverUrl, token: engineConfig.token, clientId, requestTimeoutMs }
    },
    logger,
  })
  let tokenSource: string | null = configToken.trim() === '' ? null : 'config'
  let passphraseSource: string | null = configPassphrase === '' ? null : 'config'
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
      engineConfig.token = credentialToken !== '' ? credentialToken : configToken
      engineConfig.passphrase = credentialPassphrase !== '' ? credentialPassphrase : configPassphrase
      tokenSource = credentialToken !== ''
        ? tokenValue?.source ?? 'credentials'
        : configToken.trim() !== '' ? 'config' : null
      passphraseSource = credentialPassphrase !== ''
        ? passphraseValue?.source ?? 'credentials'
        : configPassphrase !== '' ? 'config' : null
    })()
    try {
      await refreshingSecrets
    } finally {
      refreshingSecrets = undefined
    }
  }
  const deps = {
    persistence: {
      list: () => ctx.sessionPersistence.list(),
      open: (id: string, access: 'read') => ctx.sessionPersistence.open(id as SessionId, access),
    },
    sessions: {
      get: (id: string): LiveSession | undefined => ctx.sessions.get(id as SessionId),
      flush: (session: LiveSession) => ctx.sessions.flush(session),
    },
    config: engineConfig,
    logger,
    leaseRelease: (sessionId: string) => leaseKeeper.releaseAfterWrite(sessionId),
    isTailOpen: (events: readonly { readonly seq: number }[]) =>
      interruptedTurnClosers(events as readonly SessionEvent[]).length > 0,
  }

  const workspaceRegistry = ctx.get('workspaceRegistry') as unknown as WorkspaceRegistryLike | undefined
  if (configToken !== '' || configPassphrase !== '') {
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

  let bindings: WorkspaceBindings = emptyBindings()
  const bindingsDir = statePath === undefined ? undefined : join(dirname(statePath), 'vault')
  const refreshBindings = async (): Promise<void> => {
    bindings = bindingsDir === undefined ? emptyBindings() : await readBindings(bindingsDir)
  }
  let workspaceLabels: Record<string, string> = {}
  let labelsIdentity: string | undefined
  let labelsFetchedAt = 0
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
      labelsIdentity = identity
      labelsFetchedAt = Date.now()
    } catch (error: unknown) {
      labelsIdentity = identity
      labelsFetchedAt = Date.now()
      logger.warn(`dsh-session-cloudsync: 读取 Vault 工作区 label 失败：${error instanceof Error ? error.message : String(error)}`)
    }
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

  let pullWithDeps: ((state: PullState) => Promise<PullReport>) | undefined
  const controller = new SyncController({
    push: () => syncOnce({
      ...deps,
      workspaceKeyOf: workspaceKeyForCwd,
      onProgress: (progress) => controller.updateProgress(progress),
    }),
    pull: (state) => {
      if (pullWithDeps === undefined) throw new Error('拉取引擎尚未初始化')
      return pullWithDeps(state)
    },
    persist: persistState,
    configuration,
    intervalMs,
    leases: () => leaseKeeper.snapshot(),
    scheduler: () => ({
      autoSync,
      intervalMs,
      nextRunAt: null,
      backoffUntil: null,
    }),
    initial: {
      revision: initialJournal.revision,
      ...initialJournal.pending === undefined ? {} : { pending: initialJournal.pending },
      ...initialJournal.cwdPending === undefined ? {} : { cwdPending: initialJournal.cwdPending },
      ...initialJournal.blocked === undefined ? {} : { blocked: initialJournal.blocked },
      ...initialJournal.blockedDecisions === undefined ? {} : { blockedDecisions: initialJournal.blockedDecisions },
      ...initialJournal.unmapped === undefined ? {} : { unmapped: initialJournal.unmapped },
    },
    logger,
  })

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
    attach: async (sessionId: string, mappedPath?: string): Promise<void> => {
      if (workspaceRegistry === undefined) throw new Error('workspaceRegistry 不可用')
      if (mappedPath === undefined || mappedPath === '') throw new Error('会话没有可用的本地工作区落点')
      const workspace = (await workspaceRegistry.resolveByPath(mappedPath))
        ?? (await workspaceRegistry.create(mappedPath, 'Session Sync'))
      await workspace.attachSession(sessionId as SessionId)
    },
    logger,
    beforeApply: async (sessionId: string, targetSeq: number): Promise<void> => {
      controller.beginApply(sessionId, targetSeq)
    },
    afterApply: async (sessionId: string): Promise<void> => {
      controller.endApply(sessionId)
    },
  }
  pullWithDeps = (state) => {
    refreshConfig()
    return pullOnce({
      ...pullDeps,
      workspacePathOf: resolveWorkspacePath,
      onProgress: (progress) => controller.updateProgress(progress),
    }, state)
  }

  let backfilling = false
  /**
   * 映射完成后重放未映射会话：从它们最初的 cursor revision 之前再拉一次，
   * 不推进主游标。这样即使映射页打开时游标已经越过它们，也能补回来。
   */
  const backfillMappedWorkspaces = async (): Promise<void> => {
    if (backfilling || controller.snapshot().running) return
    const pending = controller.unmappedSessions()
      .filter((entry) => bindings.bindings[entry.workspaceKey] !== undefined)
    if (pending.length === 0) return
    const revision = Math.max(0, Math.min(...pending.map((entry) => entry.revision)) - 1)
    backfilling = true
    try {
      const snapshot = controller.snapshot()
      const report = await pullWithDeps({
        revision,
        ...snapshot.pending === null ? {} : { pending: snapshot.pending },
      })
      controller.recordBackfill(report)
      await refreshBindings()
    } catch (error: unknown) {
      logger.warn(`dsh-session-cloudsync: 映射回填失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      backfilling = false
    }
  }

  const setup = async (): Promise<SetupInfo> => {
    refreshConfig()
    await refreshSecrets()
    const state = configuration()
    return {
      configured: state.configured,
      reason: state.reason ?? null,
      serverUrl,
      deviceName,
      excludedSessionIds,
      autoBindSamePath,
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

  const autoBindMatchingWorkspaces = async (): Promise<void> => {
    if (!autoBindSamePath || bindingsDir === undefined || workspaceRegistry === undefined) return
    let registered: readonly WorkspaceLike[] = []
    try {
      registered = workspaceRegistry.list?.() ?? []
    } catch (error: unknown) {
      logger.warn(`dsh-session-cloudsync: 自动绑定读取工作区失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let bound = false
    for (const session of controller.unmappedSessions()) {
      const workspaceKey = session.workspaceKey
      if (bindings.bindings[workspaceKey] !== undefined) continue
      const candidate = registered.find((workspace) => workspaceKeyForCwd('', workspace.path) === workspaceKey)
      if (candidate === undefined) continue
      try {
        await bindWorkspaceFile(bindingsDir, workspaceKey, candidate.path, candidate.title)
        bound = true
      } catch (error: unknown) {
        logger.warn(`dsh-session-cloudsync: 自动绑定 ${candidate.path} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (bound) {
      await refreshBindings()
      labelsIdentity = undefined
    }
  }

  const runSync = async (
    manual = false,
    trigger?: 'startup' | 'auto' | 'manual',
  ): Promise<Awaited<ReturnType<SyncController['run']>>> => {
    refreshConfig()
    await refreshSecrets()
    void leaseKeeper.tick()
    await refreshBindings()
    const result = await controller.run({
      manual,
      ...trigger === undefined ? {} : { trigger },
    })
    await autoBindMatchingWorkspaces()
    await backfillMappedWorkspaces()
    void runVault().catch((error: unknown) => {
      logger.warn(`dsh-session-cloudsync: Vault 同步失败：${error instanceof Error ? error.message : String(error)}`)
    })
    return result
  }

  const workspaces = async (): Promise<SyncWorkspaceList> => {
    refreshConfig()
    await refreshBindings()
    await refreshSecrets()
    await refreshWorkspaceLabels()
    const snapshots = await ctx.sessionPersistence.list()
    const tree = buildSessionTree(snapshots)
    const excludedSet = new Set(excludedSessionIds)
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
        excluded: excludedSet.has(sessionId),
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
      unmapped.set(entry.workspaceKey, (unmapped.get(entry.workspaceKey) ?? 0) + 1)
    }
    // 首启映射步骤通常发生在第一次同步之前；Vault 里已有 workspace/profile，
    // 用它补出远端工作区列表，避免“没有未映射工作区”的假象。
    for (const key of Object.keys(workspaceLabels)) {
      if (bindings.bindings[key] !== undefined) continue
      if (localWorkspacePathForKey(key) !== undefined) continue
      if (!unmapped.has(key)) unmapped.set(key, 0)
    }

    return {
      workspaces: candidates,
      sessions,
      excludedSessionIds,
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

  const control: SyncControl = {
    status: () => controller.snapshot(),
    setup,
    workspaces,
    test: async (serverUrl: string) => testConnection(serverUrl, fetch, engineConfig.requestTimeoutMs),
    syncNow: () => runSync(true, 'manual'),
    cwdDecision: async (sessionId: string, action: 'fix' | 'skip') => {
      if (action === 'skip') {
        const snapshot = await ctx.sessionPersistence.stat(sessionId as SessionId)
        await pullDeps.attach(sessionId, snapshot?.header.cwd)
        controller.clearCwdPending(sessionId)
        return { ok: true, status: 'attached' as const }
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
      void backfillMappedWorkspaces()
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
  if (autoSync) {
    ctx.effect(() => {
      const timer = setInterval(() => { void runSync() }, intervalMs)
      return () => { clearInterval(timer) }
    })
  }
  ctx.effect(() => {
    leaseKeeper.start()
    const offSessionCreated = (ctx as unknown as {
      on(name: string, listener: () => void): () => void
    }).on('session/created', () => { void leaseKeeper.tick() })
    return () => {
      offSessionCreated()
      return leaseKeeper.dispose()
    }
  }, 'dsh-session-cloudsync: presence leases')
}
