/**
 * dsh-session-sync 宿主插件入口。
 *
 * M3：按事件批次把本地会话推到自部署服务端；拉取、客户端 UI 与自动故障
 * 恢复在后续里程碑补齐。
 *
 * @module dsh-session-sync
 */
import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import {
  classifySyncError,
  pullOnce,
  syncOnce,
  type CreateHeaderLike,
  type CreateOptions,
  type EngineConfig,
  type PendingApply,
  type SyncErrorKind,
  type SyncLogger,
} from './engine.ts'
import { readPullJournal, writePullJournal, STATE_VERSION, type PullJournal } from './state.ts'

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

/** 不可自动恢复、只应等待配置/人工处理的错误。 */
const NON_RETRYABLE: ReadonlySet<SyncErrorKind> = new Set(['auth', 'forbidden', 'diverged', 'format', 'crypto', 'gone'])

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
  if (serverUrl.trim() === '' || token.trim() === '' || passphrase === '') {
    logger.info('dsh-session-sync: 未配置 serverUrl/token/passphrase，插件只加载不推送')
    return
  }

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
  let pullRevision = initialJournal.revision
  let pending: PendingApply | undefined = initialJournal.pending
  if (statePath === undefined) logger.info('dsh-session-sync: 找不到 DSH home，拉取状态只保存在内存')

  const persistState = (): void => {
    if (statePath === undefined) return
    try {
      writePullJournal(statePath, {
        version: STATE_VERSION,
        revision: pullRevision,
        ...pending === undefined ? {} : { pending },
      })
    } catch (error: unknown) {
      logger.warn(`dsh-session-sync: 写状态文件失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

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
      pending = { sessionId, targetSeq, at: Date.now() }
      persistState()
    },
    afterApply: async (): Promise<void> => {
      pending = undefined
      persistState()
    },
  }

  const status: {
    running: boolean
    lastAttempt: number | undefined
    lastSuccess: number | undefined
    lastError: { kind: SyncErrorKind; message: string; at: number } | undefined
    retryCount: number
    nextRetryAt: number
  } = {
    running: false,
    lastAttempt: undefined,
    lastSuccess: undefined,
    lastError: undefined,
    retryCount: 0,
    nextRetryAt: 0,
  }

  const run = async (): Promise<void> => {
    if (status.running) return
    if (Date.now() < status.nextRetryAt) return
    status.running = true
    status.lastAttempt = Date.now()
    const errors: Array<{ kind: SyncErrorKind; message: string }> = []
    try {
      const report = await syncOnce(deps)
      if (!report.configured) {
        logger.warn(`dsh-session-sync: 未执行推送（${report.reason ?? '未配置'}）`)
      } else {
        const pushed = report.sessions.filter((session) => session.status === 'pushed')
        const failed = report.sessions.filter((session) => session.status === 'error')
        const skipped = report.sessions.length - pushed.length - failed.length
        if (pushed.length > 0 || failed.length > 0) {
          logger.info(`dsh-session-sync: 推送 ${pushed.length} 个会话，失败 ${failed.length}，跳过 ${skipped}`)
        }
        for (const session of failed) {
          const kind = session.kind ?? 'unknown'
          errors.push({ kind, message: session.error ?? '未知错误' })
          logger.warn(`dsh-session-sync: ${session.sessionId} 失败（${kind}）：${session.error ?? '未知错误'}`)
        }
      }

      const pulled = await pullOnce(pullDeps, pending === undefined
        ? { revision: pullRevision }
        : { revision: pullRevision, pending })
      if (pulled.configured) {
        const failed = pulled.sessions.filter((session) => session.status === 'error')
        const applied = pulled.sessions.filter((session) => session.status === 'pulled' || session.status === 'partial')
        if (failed.length === 0) {
          pullRevision = pulled.revision
          persistState()
        }
        if (applied.length > 0 || failed.length > 0) {
          logger.info(`dsh-session-sync: 拉取 ${applied.length} 个会话，失败 ${failed.length}`)
        }
        for (const session of failed) {
          const kind = session.kind ?? 'unknown'
          errors.push({ kind, message: session.error ?? '未知错误' })
          logger.warn(`dsh-session-sync: 拉取 ${session.sessionId} 失败（${kind}）：${session.error ?? '未知错误'}`)
        }
      }
    } catch (error: unknown) {
      const classified = classifySyncError(error)
      errors.push({ kind: classified.kind, message: classified.message })
      logger.warn(`dsh-session-sync: 一次同步失败（${classified.kind}）：${classified.message}`)
    } finally {
      status.running = false
      if (errors.length > 0) {
        status.retryCount += 1
        const nonRetryable = errors.some((entry) => NON_RETRYABLE.has(entry.kind))
        const base = config.intervalMs ?? 60000
        const delay = nonRetryable
          ? Math.max(base, 5 * 60_000)
          : Math.min(base * 2 ** Math.min(status.retryCount, 5), 5 * 60_000)
        status.nextRetryAt = Date.now() + delay
        status.lastError = { kind: errors[0]!.kind, message: errors[0]!.message, at: Date.now() }
        logger.warn(`dsh-session-sync: 将在 ${Math.round(delay / 1000)}s 后重试（retry=${status.retryCount}）`)
      } else {
        status.retryCount = 0
        status.nextRetryAt = 0
        status.lastSuccess = Date.now()
        status.lastError = undefined
        persistState()
      }
    }
  }

  void run()
  if (config.autoSync !== false) {
    ctx.effect(() => {
      const timer = setInterval(() => { void run() }, config.intervalMs ?? 60000)
      return () => { clearInterval(timer) }
    })
  }
}
