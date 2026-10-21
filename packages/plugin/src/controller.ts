/**
 * 一次同步的执行器与状态机：串行化推送/拉取、维护退避、记录逐会话结果。
 *
 * 控制器不碰 DSH 服务，只拿三个注入点：push、pull、persist。这样它既能在
 * 宿主里跑，也能在测试里用假的引擎驱动；`index.ts` 只负责把真实服务接进来。
 *
 * @module dsh-session-sync/controller
 */
import {
  classifySyncError,
  type PullReport,
  type PullSessionReport,
  type PullState,
  type SessionSyncReport,
  type SyncErrorKind,
  type SyncLogger,
  type SyncProgress,
  type SyncReport,
} from './engine.ts'
import type { SessionSyncView, SyncErrorView, SyncStatus } from './status.ts'

/** 默认不自动重试、只等待配置或人工处理的错误。 */
export const DEFAULT_NON_RETRYABLE: ReadonlySet<SyncErrorKind> = new Set([
  'auth',
  'forbidden',
  'not-found',
  'diverged',
  'format',
  'crypto',
  'gone',
  'config',
])

/** 控制器依赖。 */
export interface SyncControllerOptions {
  /** 执行一次推送。 */
  readonly push: () => Promise<SyncReport>
  /** 执行一次拉取；传入当前 revision 与未完成的 pending。 */
  readonly pull: (state: PullState) => Promise<PullReport>
  /** 持久化 revision/pending；写失败由注入方负责记录。 */
  readonly persist: (state: PullState) => void
  /** 每次读取，允许配置在运行期变化。 */
  readonly configuration: () => { readonly configured: boolean; readonly reason?: string }
  /** 自动同步间隔，也是退避的基数。 */
  readonly intervalMs: number
  /** 启动时从状态文件恢复的 revision/pending。 */
  readonly initial?: PullState
  /** 覆盖默认的不可重试集合（测试用）。 */
  readonly nonRetryable?: ReadonlySet<SyncErrorKind>
  /** 日志。 */
  readonly logger?: SyncLogger
  /** 测试可替换时钟。 */
  readonly now?: () => number
}

/** 没有真正执行时的原因。 */
export type SyncSkipCode = 'already-running' | 'backoff' | 'unconfigured'

/** 手动触发一次同步的结果。 */
export interface SyncRunResult {
  /** 本轮是否无错误完成。 */
  readonly ok: boolean
  /** 没有真正执行时的原因：已在运行、退避中、未配置。 */
  readonly code?: SyncSkipCode
  /** 可读说明。 */
  readonly message?: string
  /** 本轮结束后的状态快照。 */
  readonly status: SyncStatus
}

/**
 * 持有同步状态并串行执行同步轮次。
 *
 * 手动触发会清掉当前退避并立即执行；自动触发在退避期内直接跳过。两者都不会
 * 并发执行——上一轮没结束时返回 `already-running`。
 */
export class SyncController {
  private readonly options: SyncControllerOptions
  private readonly nonRetryable: ReadonlySet<SyncErrorKind>
  private revision: number
  private pending: { sessionId: string; targetSeq: number; at: number } | undefined
  private running = false
  private lastAttempt = 0
  private lastSuccess = 0
  private lastError: SyncErrorView | undefined
  private retryCount = 0
  private nextRetryAt = 0
  private sessions: readonly SessionSyncView[] = []
  private live: readonly SessionSyncView[] = []
  private readonly cwdPending = new Set<string>()

  /**
   * @param options - 引擎、持久化与时钟注入点。
   */
  constructor(options: SyncControllerOptions) {
    this.options = options
    this.nonRetryable = options.nonRetryable ?? DEFAULT_NON_RETRYABLE
    this.revision = options.initial?.revision ?? 0
    this.pending = options.initial?.pending
    for (const sessionId of options.initial?.cwdPending ?? []) this.cwdPending.add(sessionId)
  }

  /** 当前客户端可读快照。 */
  snapshot(): SyncStatus {
    const configuration = this.options.configuration()
    return {
      configured: configuration.configured,
      reason: configuration.reason ?? null,
      running: this.running,
      lastAttempt: this.lastAttempt === 0 ? null : this.lastAttempt,
      lastSuccess: this.lastSuccess === 0 ? null : this.lastSuccess,
      lastError: this.lastError ?? null,
      retryCount: this.retryCount,
      nextRetryAt: this.nextRetryAt === 0 ? null : this.nextRetryAt,
      pending: this.pending ?? null,
      revision: this.revision,
      sessions: this.sessions,
      cwdPending: [...this.cwdPending],
      live: this.live,
    }
  }

  /** 用户已处理某个 cwd 决策后清除警告。 */
  clearCwdPending(sessionId: string): void {
    this.cwdPending.delete(sessionId)
    this.persistNow()
  }

  /**
   * 引擎的实时阶段：只更新当前一轮的临时视图，不覆盖上一轮最终结果。
   * @param progress - 推送/拉取的阶段。
   */
  updateProgress(progress: SyncProgress): void {
    const status = progress.phase === 'error'
      ? 'error'
      : progress.phase === 'done'
        ? progress.direction === 'push' ? 'pushed' : 'pulled'
        : progress.direction === 'push' ? 'pushing' : 'pulling'
    const view: SessionSyncView = {
      sessionId: progress.sessionId,
      direction: progress.direction,
      status,
      ...progress.error === undefined ? {} : { error: progress.error },
      ...progress.batches === undefined ? {} : { batches: progress.batches },
    }
    const next = this.live.filter((item) => !(item.sessionId === view.sessionId && item.direction === view.direction))
    next.push(view)
    this.live = next
  }

  /**
   * 在本地写入之前记录 pending；随后即使进程被杀，启动时也能补完。
   * @param sessionId - 正在应用的会话。
   * @param targetSeq - 承诺应用到的安全边界。
   * @throws 已有另一个会话的 pending 时拒绝开始，避免覆盖尚未完成的恢复记录。
   */
  beginApply(sessionId: string, targetSeq: number): void {
    if (this.pending !== undefined && this.pending.sessionId !== sessionId) {
      throw new Error(`上一个拉取（${this.pending.sessionId}）尚未完成，拒绝覆盖 pending`)
    }
    this.pending = { sessionId, targetSeq, at: this.now() }
    this.persistNow()
  }

  /**
   * 本地追加、flush、attach 全部成功后清除 pending；只清除该会话自己的记录。
   * @param sessionId - 刚完成应用的会话。
   */
  endApply(sessionId: string): void {
    if (this.pending?.sessionId !== sessionId) return
    this.pending = undefined
    this.persistNow()
  }

  /**
   * 执行一轮推送 + 拉取。
   * @param options - `manual: true` 表示用户手动触发，跳过当前退避。
   * @returns 本轮结果与结束后的状态快照。
   */
  async run(options: { readonly manual?: boolean } = {}): Promise<SyncRunResult> {
    const now = this.now()
    if (this.running) return this.skipped('already-running', '同步正在进行')
    if (options.manual === true) {
      // 用户显式重试：从这一轮重新计算退避，而不是继承旧的等待时间。
      this.retryCount = 0
      this.nextRetryAt = 0
    } else if (now < this.nextRetryAt) {
      return this.skipped('backoff', `将在 ${Math.ceil((this.nextRetryAt - now) / 1000)}s 后重试`)
    }

    const configuration = this.options.configuration()
    if (!configuration.configured) {
      return this.skipped('unconfigured', configuration.reason ?? '未配置')
    }

    this.running = true
    this.live = []
    this.lastAttempt = now
    const errors: Array<{ kind: SyncErrorKind; message: string }> = []
    const views: SessionSyncView[] = []
    try {
      this.collectPush(await this.options.push(), views, errors)
      const pull = await this.options.pull(this.pullState())
      this.collectPull(pull, views, errors)
      if (pull.configured && pull.sessions.every((session) => session.status !== 'error')) {
        this.revision = pull.revision
        this.persistNow()
      }
    } catch (error: unknown) {
      const classified = classifySyncError(error)
      errors.push({ kind: classified.kind, message: classified.message })
      this.options.logger?.warn(`dsh-session-sync: 一次同步失败（${classified.kind}）：${classified.message}`)
    }

    this.running = false
    this.sessions = views
    this.live = []
    const finished = this.now()
    if (errors.length > 0) {
      return this.fail(errors, finished)
    }
    this.retryCount = 0
    this.nextRetryAt = 0
    this.lastSuccess = finished
    this.lastError = undefined
    this.persistNow()
    return { ok: true, status: this.snapshot() }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private pullState(): PullState {
    return {
      revision: this.revision,
      ...this.pending === undefined ? {} : { pending: this.pending },
      ...this.cwdPending.size === 0 ? {} : { cwdPending: [...this.cwdPending] },
    }
  }

  private persistNow(): void {
    this.options.persist(this.pullState())
  }

  private skipped(code: SyncSkipCode, message: string): SyncRunResult {
    return { ok: false, code, message, status: this.snapshot() }
  }

  private fail(
    errors: ReadonlyArray<{ kind: SyncErrorKind; message: string }>,
    finished: number,
  ): SyncRunResult {
    this.retryCount += 1
    const nonRetryable = errors.some((entry) => this.nonRetryable.has(entry.kind))
    const base = Math.max(this.options.intervalMs, 1000)
    const delay = nonRetryable
      ? Math.max(base, 5 * 60_000)
      : Math.min(base * 2 ** Math.min(this.retryCount, 5), 5 * 60_000)
    this.nextRetryAt = finished + delay
    const first = errors[0]!
    this.lastError = { kind: first.kind, message: first.message, at: finished }
    this.options.logger?.warn(`dsh-session-sync: 将在 ${Math.round(delay / 1000)}s 后重试（retry=${this.retryCount}）`)
    return { ok: false, message: first.message, status: this.snapshot() }
  }

  private collectPush(
    report: SyncReport,
    views: SessionSyncView[],
    errors: Array<{ kind: SyncErrorKind; message: string }>,
  ): void {
    if (!report.configured) {
      errors.push({ kind: 'config', message: report.reason ?? '推送未配置' })
      return
    }
    const pushed = report.sessions.filter((session) => session.status === 'pushed')
    const failed = report.sessions.filter((session) => session.status === 'error')
    const skipped = report.sessions.length - pushed.length - failed.length
    if (pushed.length > 0 || failed.length > 0) {
      this.options.logger?.info(`dsh-session-sync: 推送 ${pushed.length} 个会话，失败 ${failed.length}，跳过 ${skipped}`)
    }
    for (const session of report.sessions) views.push(pushView(session))
    for (const session of failed) {
      const kind = session.kind ?? 'unknown'
      errors.push({ kind, message: session.error ?? '未知错误' })
      this.options.logger?.warn(`dsh-session-sync: ${session.sessionId} 失败（${kind}）：${session.error ?? '未知错误'}`)
    }
  }

  private collectPull(
    report: PullReport,
    views: SessionSyncView[],
    errors: Array<{ kind: SyncErrorKind; message: string }>,
  ): void {
    if (!report.configured) return
    const failed = report.sessions.filter((session) => session.status === 'error')
    const applied = report.sessions.filter((session) => session.status === 'pulled' || session.status === 'partial')
    if (applied.length > 0 || failed.length > 0) {
      this.options.logger?.info(`dsh-session-sync: 拉取 ${applied.length} 个会话，失败 ${failed.length}`)
    }
    for (const session of report.sessions) views.push(pullView(session))
    for (const session of report.sessions) {
      if (session.cwdNonPortable === true) {
        this.cwdPending.add(session.sessionId)
      } else if (session.status !== 'error') {
        this.cwdPending.delete(session.sessionId)
      }
    }
    for (const session of failed) {
      const kind = session.kind ?? 'unknown'
      errors.push({ kind, message: session.error ?? '未知错误' })
      this.options.logger?.warn(`dsh-session-sync: 拉取 ${session.sessionId} 失败（${kind}）：${session.error ?? '未知错误'}`)
    }
  }
}

/**
 * 由引擎结果生成稳定视图。
 * @param session - 推送结果。
 * @returns 客户端视图。
 */
function pushView(session: SessionSyncReport): SessionSyncView {
  return {
    sessionId: session.sessionId,
    direction: 'push',
    status: session.status,
    ...session.batches === undefined ? {} : { batches: session.batches },
    ...session.bytes === undefined ? {} : { bytes: session.bytes },
    ...session.tailOpen === undefined ? {} : { tailOpen: session.tailOpen },
    ...session.cwdNonPortable === undefined ? {} : { cwdNonPortable: session.cwdNonPortable },
    ...session.kind === undefined ? {} : { kind: session.kind },
    ...session.error === undefined ? {} : { error: session.error },
  }
}

/**
 * 由引擎结果生成稳定视图。
 * @param session - 拉取结果。
 * @returns 客户端视图。
 */
function pullView(session: PullSessionReport): SessionSyncView {
  return {
    sessionId: session.sessionId,
    direction: 'pull',
    status: session.status,
    ...session.applied === undefined ? {} : { applied: session.applied },
    ...session.cwdNonPortable === undefined ? {} : { cwdNonPortable: session.cwdNonPortable },
    ...session.kind === undefined ? {} : { kind: session.kind },
    ...session.error === undefined ? {} : { error: session.error },
  }
}
