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
import { buildSessionTree, pathAllowed, pathKeyOf } from './closure.ts'
import { prepareReplaceScript } from './replace.ts'
import { syncVault } from './vault-sync.ts'
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
import { readPullJournal, writePullJournal, STATE_VERSION, type PullJournal } from './state.ts'
import type { SetupInfo, SyncWorkspaceCandidate, SyncWorkspaceList } from './status.ts'

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
  /** 拉取会话时挂载的本地工作区路径；空表示只推送不拉取。 */
  workspacePath?: string
  /** 允许同步的工作区路径；空数组表示未配置、暂不同步任何会话。 */
  workspaceAllowlist?: string[]
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
  workspacePath: z.string().default('').volatile(),
  workspaceAllowlist: z.array(z.string()).default([]).volatile(),
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
  let workspaceAllowlist: string[] = []
  let salt = readVolatile<string>(config.salt) ?? ''
  let includeSubagents = readVolatile<boolean>(config.includeSubagents) !== false
  let deviceName = readVolatile<string>(config.deviceName) ?? ''
  let workspacePath = readVolatile<string>(config.workspacePath) ?? ''
  let autoSync = readVolatile<boolean>(config.autoSync) !== false
  let batchEvents = readVolatile<number>(config.batchEvents) ?? 50
  let batchBytes = readVolatile<number>(config.batchBytes) ?? 256 * 1024
  let requestTimeoutMs = readVolatile<number>(config.requestTimeoutMs) ?? 10_000
  // 每次 DSH 进程启动生成一次；同一进程内 lease/append 复用，重启后换新值。
  const clientId = randomBytes(16).toString('hex')

  const readAllowlist = (): string[] => {
    const raw = readVolatile<unknown>(config.workspaceAllowlist)
    return Array.isArray(raw)
      ? raw.filter((path): path is string => typeof path === 'string' && path.trim() !== '')
      : []
  }
  workspaceAllowlist = readAllowlist()

  const engineConfig: MutableEngineConfig = {
    serverUrl,
    token: configToken,
    passphrase: configPassphrase,
    ...salt === '' ? {} : { salt },
    includeSubagents,
    workspaceAllowlist,
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
    workspaceAllowlist = readAllowlist()
    salt = readVolatile<string>(config.salt) ?? ''
    includeSubagents = readVolatile<boolean>(config.includeSubagents) !== false
    deviceName = readVolatile<string>(config.deviceName) ?? ''
    workspacePath = readVolatile<string>(config.workspacePath) ?? ''
    autoSync = readVolatile<boolean>(config.autoSync) !== false
    batchEvents = readVolatile<number>(config.batchEvents) ?? 50
    batchBytes = readVolatile<number>(config.batchBytes) ?? 256 * 1024
    requestTimeoutMs = readVolatile<number>(config.requestTimeoutMs) ?? 10_000
    engineConfig.serverUrl = serverUrl
    engineConfig.includeSubagents = includeSubagents
    engineConfig.workspaceAllowlist = workspaceAllowlist
    engineConfig.batchEvents = batchEvents
    engineConfig.batchBytes = batchBytes
    engineConfig.requestTimeoutMs = requestTimeoutMs
    if (salt === '') delete engineConfig.salt
    else engineConfig.salt = salt
  }
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
        .filter((workspace) => pathAllowed(workspace.path, workspaceAllowlist))
        .map((workspace) => ({ path: workspace.path, title: workspace.title }))
    } catch (error: unknown) {
      logger.warn(`dsh-session-cloudsync: 读取 Vault 工作区失败：${error instanceof Error ? error.message : String(error)}`)
    }
    await syncVault({
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
  }

  const configuration = (): { configured: boolean; reason?: string } => {
    refreshConfig()
    if (serverUrl.trim() === '') return { configured: false, reason: 'serverUrl 未配置' }
    if (engineConfig.token.trim() === '') return { configured: false, reason: 'token 未配置' }
    if (engineConfig.passphrase === '') return { configured: false, reason: 'passphrase 未配置' }
    if (workspaceAllowlist.length === 0) return { configured: false, reason: 'workspaceAllowlist 未配置' }
    return { configured: true }
  }

  let pullWithDeps: ((state: PullState) => Promise<PullReport>) | undefined
  const controller = new SyncController({
    push: () => syncOnce({ ...deps, onProgress: (progress) => controller.updateProgress(progress) }),
    pull: (state) => {
      if (pullWithDeps === undefined) throw new Error('拉取引擎尚未初始化')
      return pullWithDeps(state)
    },
    persist: persistState,
    configuration,
    intervalMs,
    initial: {
      revision: initialJournal.revision,
      ...initialJournal.pending === undefined ? {} : { pending: initialJournal.pending },
      ...initialJournal.cwdPending === undefined ? {} : { cwdPending: initialJournal.cwdPending },
      ...initialJournal.blocked === undefined ? {} : { blocked: initialJournal.blocked },
      ...initialJournal.blockedDecisions === undefined ? {} : { blockedDecisions: initialJournal.blockedDecisions },
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
    workspacePath,
    attach: async (sessionId: string): Promise<void> => {
      if (workspaceRegistry === undefined) throw new Error('workspaceRegistry 不可用')
      const workspace = (await workspaceRegistry.resolveByPath(workspacePath))
        ?? (await workspaceRegistry.create(workspacePath, 'Session Sync'))
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
      workspacePath,
      onProgress: (progress) => controller.updateProgress(progress),
    }, state)
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
      workspacePath,
      workspaceAllowlist,
      allowlistConfigured: workspaceAllowlist.length > 0,
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

  const runSync = async (manual = false): Promise<Awaited<ReturnType<SyncController['run']>>> => {
    refreshConfig()
    await refreshSecrets()
    const result = manual ? await controller.run({ manual: true }) : await controller.run()
    void runVault().catch((error: unknown) => {
      logger.warn(`dsh-session-cloudsync: Vault 同步失败：${error instanceof Error ? error.message : String(error)}`)
    })
    return result
  }

  const workspaces = async (): Promise<SyncWorkspaceList> => {
    refreshConfig()
    const snapshots = await ctx.sessionPersistence.list()
    const tree = buildSessionTree(snapshots)
    const groups = new Map<string, { path: string; rootSessions: number; subagentSessions: number }>()
    for (const entry of tree.roots) {
      const cwd = entry.root.header.cwd?.trim()
      if (cwd === undefined || cwd === '') continue
      const key = pathKeyOf(cwd)
      const group = groups.get(key) ?? { path: cwd, rootSessions: 0, subagentSessions: 0 }
      group.rootSessions += 1
      group.subagentSessions += entry.descendants.length
      groups.set(key, group)
    }

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
      candidates.push({
        path: workspace.path,
        title: workspace.title,
        rootSessions: group?.rootSessions ?? 0,
        subagentSessions: group?.subagentSessions ?? 0,
        selected: pathAllowed(workspace.path, workspaceAllowlist),
      })
    }
    for (const [key, group] of groups) {
      if (seen.has(key)) continue
      candidates.push({
        path: group.path,
        title: titleOfPath(group.path),
        rootSessions: group.rootSessions,
        subagentSessions: group.subagentSessions,
        selected: pathAllowed(group.path, workspaceAllowlist),
      })
    }

    return {
      allowlistConfigured: workspaceAllowlist.length > 0,
      selectedPaths: workspaceAllowlist,
      workspaces: candidates,
    }
  }

  const fixCwd = async (sessionId: string) => {
    refreshConfig()
    await refreshSecrets()
    const result = await correctSessionCwd({
      persistence: pullDeps.persistence,
      sessions: deps.sessions,
      config: engineConfig,
      workspacePath,
      logger,
    }, sessionId)
    if (result.ok && (result.status === 'corrected' || result.status === 'already-portable')) {
      await pullDeps.attach(sessionId)
    }
    return result
  }

  const control: SyncControl = {
    status: () => controller.snapshot(),
    setup,
    workspaces,
    test: async () => {
      await refreshSecrets()
      return testConnection(engineConfig)
    },
    syncNow: () => runSync(true),
    cwdDecision: async (sessionId: string, action: 'fix' | 'skip') => {
      if (action === 'skip') {
        await pullDeps.attach(sessionId)
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

  void refreshSecrets().then(() => {
    const current = configuration()
    if (!current.configured) {
      logger.info(`dsh-session-cloudsync: 未配置（${current.reason ?? '原因未知'}），只提供设置/状态 API`)
    } else {
      void controller.run()
      void runVault().catch((error: unknown) => {
        logger.warn(`dsh-session-cloudsync: Vault 同步失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }
  })
  if (autoSync) {
    ctx.effect(() => {
      const timer = setInterval(() => { void runSync() }, intervalMs)
      return () => { clearInterval(timer) }
    })
  }
}
