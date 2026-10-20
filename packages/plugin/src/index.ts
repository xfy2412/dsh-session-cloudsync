/**
 * dsh-session-sync 宿主插件入口。
 *
 * M4：在 M3 的推拉引擎外面加一层同步控制器——手动触发、状态快照和
 * `/api/session-sync/*` 宿主 API。未配置时也加载，设置/首启界面需要读取
 * `setup` 与 `status`。
 *
 * @module dsh-session-sync
 */
import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { SyncController } from './controller.ts'
import {
  pullOnce,
  syncOnce,
  type CreateHeaderLike,
  type CreateOptions,
  type EngineConfig,
  type PullReport,
  type PullState,
  type SyncLogger,
} from './engine.ts'
import { createHostApi, type HostFetchRoute, type SyncControl } from './host-api.ts'
import { readPullJournal, writePullJournal, STATE_VERSION, type PullJournal } from './state.ts'
import type { SetupInfo } from './status.ts'

/** 插件在加载器里的名字。 */
export const name = 'dsh-session-sync'

/** 本插件读取的服务；缺任何一个都由加载器在装载期报错，而不是运行期。 */
export const inject = ['sessions', 'sessionPersistence', 'sessionProjections', 'workspaceRegistry']

/** 插件配置。 */
export interface Config {
  /** 总开关。默认 true。 */
  enabled?: boolean
  /** 自部署服务端地址；空表示未配置。 */
  serverUrl?: string
  /** 设备 token（管理台/CLI 签发）；空表示未配置。 */
  token?: string
  /** 同步口令；不落盘。 */
  passphrase?: string
  /** 可选：base64 的 16 字节 KDF 盐；缺省由服务端地址派生。 */
  salt?: string
  /** 本设备短标签；空表示未使用。 */
  deviceName?: string
  /** 拉取会话时挂载的本地工作区路径；空表示只推送不拉取。 */
  workspacePath?: string
  /** 是否自动按间隔推送，默认 true；关闭后只做一次启动推送。 */
  autoSync?: boolean
  /** 自动推送间隔（毫秒），默认 60000，最小 1000。 */
  intervalMs?: number
  /** 是否同步子代理会话，默认 false。 */
  includeSubagents?: boolean
  /** 单批最多事件数，默认 50。 */
  batchEvents?: number
  /** 单批最多规范 JSON 字节数，默认 256 KiB。 */
  batchBytes?: number
}

/** 配置 schema。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  serverUrl: z.string().default(''),
  token: z.string().default(''),
  passphrase: z.string().default(''),
  salt: z.string().default(''),
  deviceName: z.string().default(''),
  workspacePath: z.string().default(''),
  autoSync: z.boolean().default(true),
  intervalMs: z.number().min(1000).default(60000),
  includeSubagents: z.boolean().default(false),
  batchEvents: z.number().min(1).default(50),
  batchBytes: z.number().min(1024).default(256 * 1024),
})

/** 活动的会话类型（由 ctx.sessions 推导，避免手写 DSH 内部类型）。 */
type LiveSession = NonNullable<ReturnType<Context['sessions']['get']>>

/** workspace 服务的最小接口（类型包不在本插件依赖里）。 */
interface WorkspaceLike {
  attachSession(sessionId: SessionId): Promise<void>
}

interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  create(path: string, title: string): Promise<WorkspaceLike>
}

/** `ctx.connection` 的最小结构（类型包不在本插件依赖里）。 */
interface ConnectionLike {
  readonly fetch: {
    register(route: HostFetchRoute): () => Promise<void>
  }
}

/**
 * 找出持久化状态文件路径。
 * @param ctx - 插件上下文。
 * @returns 路径；找不到 home 时 undefined。
 */
function statePathOf(ctx: Context): string | undefined {
  const homePath = ctx.get('dshHomePath') as unknown
  if (typeof homePath === 'function') {
    try {
      return (homePath as (path: string) => string)('session-sync/state.json')
    } catch {
      return undefined
    }
  }
  const home = process.env.DSH_HOME
  return home === undefined || home === '' ? undefined : join(home, 'session-sync', 'state.json')
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

  if (config.enabled === false) {
    logger.info('dsh-session-sync: 已禁用')
    return
  }
  const serverUrl = config.serverUrl ?? ''
  const token = config.token ?? ''
  const passphrase = config.passphrase ?? ''
  const intervalMs = config.intervalMs ?? 60000

  const engineConfig: EngineConfig = {
    serverUrl,
    token,
    passphrase,
    ...config.salt === undefined || config.salt === '' ? {} : { salt: config.salt },
    includeSubagents: config.includeSubagents === true,
    batchEvents: config.batchEvents ?? 50,
    batchBytes: config.batchBytes ?? 256 * 1024,
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

  const workspacePath = config.workspacePath ?? ''
  const workspaceRegistry = ctx.get('workspaceRegistry') as unknown as WorkspaceRegistryLike | undefined
  const statePath = statePathOf(ctx)
  const initialJournal: PullJournal = statePath === undefined
    ? { version: STATE_VERSION, revision: 0 }
    : readPullJournal(statePath)
  if (statePath === undefined) logger.info('dsh-session-sync: 找不到 DSH home，拉取状态只保存在内存')

  const persistState = (state: PullState): void => {
    if (statePath === undefined) return
    try {
      writePullJournal(statePath, {
        version: STATE_VERSION,
        revision: state.revision,
        ...state.pending === undefined ? {} : { pending: state.pending },
      })
    } catch (error: unknown) {
      logger.warn(`dsh-session-sync: 写状态文件失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const configuration = (): { configured: boolean; reason?: string } => {
    if (serverUrl.trim() === '') return { configured: false, reason: 'serverUrl 未配置' }
    if (token.trim() === '') return { configured: false, reason: 'token 未配置' }
    if (passphrase === '') return { configured: false, reason: 'passphrase 未配置' }
    return { configured: true }
  }

  let pullWithDeps: ((state: PullState) => Promise<PullReport>) | undefined
  const controller = new SyncController({
    push: () => syncOnce(deps),
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
    },
    logger,
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
  pullWithDeps = (state) => pullOnce(pullDeps, state)

  const setup = (): SetupInfo => {
    const state = configuration()
    return {
      configured: state.configured,
      reason: state.reason ?? null,
      serverUrl,
      deviceName: config.deviceName ?? '',
      workspacePath,
      autoSync: config.autoSync !== false,
      intervalMs,
      includeSubagents: config.includeSubagents === true,
      hasToken: token.trim() !== '',
      hasPassphrase: passphrase !== '',
    }
  }

  const control: SyncControl = {
    status: () => controller.snapshot(),
    setup,
    syncNow: () => controller.run({ manual: true }),
  }
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection') as ConnectionLike | undefined
    if (connection === undefined) {
      logger.warn('dsh-session-sync: connection 服务不可用，状态/控制 API 未注册')
      return
    }
    for (const route of createHostApi(control)) {
      connectionCtx.effect(
        () => connection.fetch.register(route),
        `dsh-session-sync: ${route.path}`,
      )
    }
  })

  const current = configuration()
  if (!current.configured) {
    logger.info(`dsh-session-sync: 未配置（${current.reason ?? '原因未知'}），只提供设置/状态 API`)
  } else {
    void controller.run()
  }
  if (config.autoSync !== false) {
    ctx.effect(() => {
      const timer = setInterval(() => { void controller.run() }, intervalMs)
      return () => { clearInterval(timer) }
    })
  }
}
