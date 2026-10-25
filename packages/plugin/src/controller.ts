/**
 * 一次同步的执行器与状态机：串行化推送/拉取、维护退避、记录逐会话结果。
 *
 * 控制器不碰 DSH 服务，只拿三个注入点：push、pull、persist。这样它既能在
 * 宿主里跑，也能在测试里用假的引擎驱动；`index.ts` 只负责把真实服务接进来。
 *
 * @module dsh-session-cloudsync/controller
 */
import {
  classifySyncError,
  type BlockedDecision,
  type BlockedSessionState,
  type PullReport,
  type PullSessionReport,
  type PullState,
  type SessionSyncReport,
  type SyncErrorKind,
  type SyncLogger,
  type SyncProgress,
  type SyncReport,
  type SyncStage,
  type UnmappedSessionState,
} from './engine.ts'
import type {
  BlockedDecisionView,
  BlockedSessionView,
  DeviceLeaseView,
  SyncDirectionPhase,
  SyncDirectionStatus,
  SyncErrorView,
  SyncRunView,
  SyncSchedulerView,
  SyncSessionPhase,
  SyncSessionStatus,
  SyncStatus,
} from './status.ts'

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
  /** 全局单写者租约；缺省视为持有（测试/只读注入）。 */
  readonly deviceLease?: () => DeviceLeaseView
  /** 调度器视图；缺省使用 intervalMs 与 nextRetryAt。 */
  readonly scheduler?: () => SyncSchedulerView
  /** 覆盖默认的不可重试集合（测试用）。 */
  readonly nonRetryable?: ReadonlySet<SyncErrorKind>
  /** 日志。 */
  readonly logger?: SyncLogger
  /** 测试可替换时钟。 */
  readonly now?: () => number
}

/** 没有真正执行时的原因。 */
export type SyncSkipCode = 'already-running' | 'backoff' | 'unconfigured'

/** 同步开始前的完整列表条目。 */
export interface PlannedSyncSession {
  readonly sessionId: string
  /** 这一行来自上传选择或远端未拉取。 */
  readonly direction: 'push' | 'pull'
  /** 本机记录与远端清单给出的初始方向。 */
  readonly state?: 'planned' | 'local-ahead' | 'remote-ahead' | 'up-to-date'
}

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
  private sessions: readonly SyncDirectionStatus[] = []
  private live: readonly SyncDirectionStatus[] = []
  private stableViews: readonly SyncSessionStatus[] = []
  private readonly ordinals = new Map<string, number>()
  private nextOrdinal = 0
  private statusVersion = 0
  private runView: SyncRunView = {
    id: 0,
    trigger: 'startup',
    state: 'idle',
    startedAt: null,
    finishedAt: null,
  }
  private readonly cwdPending = new Set<string>()
  private readonly blocked = new Map<string, BlockedSessionState>()
  private readonly blockedDecisions = new Map<string, BlockedDecision>()
  private readonly unmapped = new Map<string, UnmappedSessionState>()
  private readonly listeners = new Set<() => void>()

  /**
   * @param options - 引擎、持久化与时钟注入点。
   */
  constructor(options: SyncControllerOptions) {
    this.options = options
    this.nonRetryable = options.nonRetryable ?? DEFAULT_NON_RETRYABLE
    this.revision = options.initial?.revision ?? 0
    this.pending = options.initial?.pending
    for (const sessionId of options.initial?.cwdPending ?? []) this.cwdPending.add(sessionId)
    for (const entry of options.initial?.blockedDecisions ?? []) this.blockedDecisions.set(entry.sessionId, entry)
    for (const entry of options.initial?.blocked ?? []) {
      if (!this.blockedDecisions.has(entry.sessionId)) this.blocked.set(entry.sessionId, entry)
    }
    for (const entry of options.initial?.unmapped ?? []) this.unmapped.set(entry.sessionId, entry)
  }

  /** 当前客户端可读快照。 */
  snapshot(): SyncStatus {
    const configuration = this.options.configuration()
    return {
      schemaVersion: 2,
      statusVersion: this.statusVersion,
      configured: configuration.configured,
      reason: configuration.reason ?? null,
      running: this.running,
      run: this.runView,
      scheduler: this.options.scheduler?.() ?? {
        autoSync: this.options.intervalMs > 0,
        intervalMs: this.options.intervalMs,
        nextRunAt: null,
        backoffUntil: this.nextRetryAt === 0 ? null : this.nextRetryAt,
      },
      deviceLease: this.options.deviceLease?.() ?? { state: 'held' },
      lastAttempt: this.lastAttempt === 0 ? null : this.lastAttempt,
      lastSuccess: this.lastSuccess === 0 ? null : this.lastSuccess,
      lastError: this.lastError ?? null,
      retryCount: this.retryCount,
      nextRetryAt: this.nextRetryAt === 0 ? null : this.nextRetryAt,
      pending: this.pending ?? null,
      revision: this.revision,
      sessions: this.sessionViews(),
    }
  }

  /** 每个 sessionId 只出现一次的聚合视图。 */
  private sessionViews(): readonly SyncSessionStatus[] {
    const now = this.now()
    const map = new Map<string, MutableSessionStatus>()
    const ensure = (sessionId: string): MutableSessionStatus => {
      let value = map.get(sessionId)
      if (value === undefined) {
        if (!this.ordinals.has(sessionId)) {
          this.ordinals.set(sessionId, this.nextOrdinal)
          this.nextOrdinal += 1
        }
        value = {
          sessionId,
          live: false,
          tailOpen: false,
          remoteAhead: false,
          cwdPending: false,
          updatedAt: now,
        }
        map.set(sessionId, value)
      }
      return value
    }

    for (const view of this.stableViews) {
      const entry = ensure(view.sessionId)
      if (view.push !== undefined) entry.push = view.push
      if (view.pull !== undefined) entry.pull = view.pull
    }

    const source = this.running && this.live.length > 0 ? this.live : this.sessions
    for (const view of source) {
      const entry = ensure(view.sessionId)
      if (view.direction === 'push') entry.push = view
      else entry.pull = view
      if (view.tailOpen === true) entry.tailOpen = true
      if (view.direction === 'push' && view.status === 'remote-ahead') entry.remoteAhead = true
      if (view.direction === 'pull' && view.status === 'remote-ahead') entry.remoteAhead = true
      if (view.direction === 'pull' && view.status === 'local-active') entry.live = true
      // push 先于 pull：pull 已经追平远端时，清除同轮 push 的 remote-ahead。
      if (view.direction === 'pull' && (view.status === 'pulled' || view.status === 'up-to-date')) entry.remoteAhead = false
      entry.updatedAt = now
    }
    for (const [sessionId, entry] of this.unmapped) {
      const value = ensure(sessionId)
      value.unmapped = { workspaceKey: entry.workspaceKey }
      value.updatedAt = now
    }
    for (const sessionId of this.cwdPending) {
      const value = ensure(sessionId)
      value.cwdPending = true
      value.updatedAt = now
    }
    for (const [sessionId, entry] of this.blocked) {
      const value = ensure(sessionId)
      value.blocked = entry as BlockedSessionView
      value.updatedAt = now
    }
    for (const [sessionId, entry] of this.blockedDecisions) {
      const value = ensure(sessionId)
      value.decision = entry as BlockedDecisionView
      value.updatedAt = now
    }

    const result = [...map.values()]
      .filter((entry) => {
        const attention = entry.blocked !== undefined
          || entry.decision !== undefined
          || entry.cwdPending
          || entry.unmapped !== undefined
        const unselectedLocal = entry.push?.status === 'skipped'
          && entry.push.error === '根会话未选中'
          && entry.pull === undefined
          && !attention
        return !unselectedLocal
      })
      .map((entry) => finishSessionView(entry, now))
      .sort((left, right) => {
        const leftOrdinal = this.ordinals.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER
        const rightOrdinal = this.ordinals.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER
        return leftOrdinal - rightOrdinal || left.sessionId.localeCompare(right.sessionId)
      })
    // live 只是本轮临时进度，不能写进稳定表；否则没有最终报告的实时行会
    // 永远停留在 running。计划占位行仍保留。
    if (!this.running) this.stableViews = result
    return result
  }

  /** 订阅状态变化；返回取消订阅。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 外部（如 DeviceLeaseKeeper）修改了快照可见状态。 */
  notifyChanged(): void {
    this.bump()
  }

  private bump(): void {
    this.statusVersion += 1
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 订阅者异常不能影响同步。
      }
    }
  }

  /** 用户已处理某个 cwd 决策后清除警告。 */
  clearCwdPending(sessionId: string): void {
    if (this.cwdPending.delete(sessionId)) {
      this.stableViews = this.stableViews.filter((view) => view.sessionId !== sessionId)
      this.bump()
    }
    this.persistNow()
  }

  /** 会话是否因分叉被 Host 侧拦截。 */
  isBlocked(sessionId: string, createdAt: number, formatVersion: number): boolean {
    const entry = this.blocked.get(sessionId)
    return entry !== undefined && sameLifecycle(entry, createdAt, formatVersion)
  }

  /** 清除一个人工处理完成的阻塞项。 */
  clearBlocked(sessionId: string): void {
    const hadBlocked = this.blocked.delete(sessionId)
    const hadDecision = this.blockedDecisions.delete(sessionId)
    if (hadBlocked || hadDecision) {
      this.bump()
      this.persistNow()
    }
  }

  /** 用户对分叉会话选择忽略或强行写入；两者都解除 Host 写入拦截。 */
  resolveBlocked(
    sessionId: string,
    action: 'ignore' | 'force',
    createdAt: number,
    formatVersion: number,
  ): void {
    const blocked = this.blocked.get(sessionId)
    const message = blocked?.message ?? this.blockedDecisions.get(sessionId)?.message ?? '历史已分叉'
    this.blocked.delete(sessionId)
    this.blockedDecisions.set(sessionId, { sessionId, action, message, at: this.now(), createdAt, formatVersion })
    this.bump()
    this.persistNow()
  }

  /** 撤销忽略/强行写入，恢复 Host 侧硬阻塞。 */
  restoreBlocked(sessionId: string, createdAt: number, formatVersion: number): void {
    const decision = this.blockedDecisions.get(sessionId)
    if (decision === undefined || !sameLifecycle(decision, createdAt, formatVersion)) return
    this.blockedDecisions.delete(sessionId)
    this.blocked.set(sessionId, {
      sessionId,
      createdAt,
      formatVersion,
      kind: 'diverged',
      message: decision.message,
      at: this.now(),
    })
    this.bump()
    this.persistNow()
  }

  /** 记录分叉；下一次该会话成功同步时自动清除。 */
  private block(
    sessionId: string,
    kind: SyncErrorKind,
    message: string,
    createdAt: number,
    formatVersion: number,
  ): void {
    if (kind !== 'diverged') return
    // 用户已经明确选择忽略/强行写入后，不把同一代会话反复锁回去。
    const decision = this.blockedDecisions.get(sessionId)
    if (decision !== undefined && sameLifecycle(decision, createdAt, formatVersion)) return
    const existing = this.blocked.get(sessionId)
    if (existing !== undefined && existing.message === message
      && sameLifecycle(existing, createdAt, formatVersion)) return
    this.blocked.set(sessionId, { sessionId, kind, message, at: this.now(), createdAt, formatVersion })
    this.bump()
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
    const previous = this.live.find((item) =>
      item.sessionId === progress.sessionId && item.direction === progress.direction)
    const mappedStage = progress.stage ?? stageOfStatus(progress.direction, status)
    // 逐批进度回调（下载/上传）不带 stage；沿用上一条 live 视图，避免
    // 下载期间阶段被清空、界面只剩“同步中”。
    const viewStage = mappedStage ?? (progress.phase === 'progress' ? previous?.stage : undefined)
    const totalEvents = progress.totalEvents ?? previous?.totalEvents ?? 0
    const doneEvents = progress.doneEvents ?? previous?.doneEvents ?? 0
    const batches = progress.batches ?? progress.doneBatches ?? previous?.batches
    const bytes = progress.doneBytes ?? progress.bytes ?? previous?.bytes
    const view: SyncDirectionStatus = {
      sessionId: progress.sessionId,
      direction: progress.direction,
      phase: directionPhaseOf(progress.direction, status),
      ...viewStage === undefined ? {} : { stage: viewStage },
      status,
      totalEvents,
      doneEvents,
      ...progress.error === undefined ? {} : { error: progress.error },
      ...batches === undefined ? {} : { batches },
      ...bytes === undefined ? {} : { bytes },
    }
    const next = this.live.filter((item) => !(item.sessionId === view.sessionId && item.direction === view.direction))
    next.push(view)
    this.live = next
    this.bump()
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
    this.bump()
    this.persistNow()
  }

  /**
   * 本地追加、flush、attach 全部成功后清除 pending；只清除该会话自己的记录。
   * @param sessionId - 刚完成应用的会话。
   */
  endApply(sessionId: string): void {
    if (this.pending?.sessionId !== sessionId) return
    this.pending = undefined
    this.bump()
    this.persistNow()
  }

  /** 当前仍在等待工作区映射的远端会话。 */
  unmappedSessions(): readonly UnmappedSessionState[] {
    return [...this.unmapped.values()]
  }

  /**
   * 在同步开始前写入完整列表：已选中的本地根会话 + 远端未拉取会话。
   * 只增加占位行，不在这里推断传输状态。
   * @param entries - 计划列表。
   */
  seedList(entries: readonly PlannedSyncSession[]): void {
    if (entries.length === 0) return
    const now = this.now()
    const map = new Map(this.stableViews.map((view) => [view.sessionId, view]))
    for (const entry of entries) {
      if (!this.ordinals.has(entry.sessionId)) {
        this.ordinals.set(entry.sessionId, this.nextOrdinal)
        this.nextOrdinal += 1
      }
      const previous = map.get(entry.sessionId)
      const state = entry.state ?? 'planned'
      const laneStage = stageOfStatus(entry.direction, state)
      const lane: SyncDirectionStatus = {
        sessionId: entry.sessionId,
        direction: entry.direction,
        phase: directionPhaseOf(entry.direction, state),
        ...laneStage === undefined ? {} : { stage: laneStage },
        status: state,
        totalEvents: 0,
        doneEvents: 0,
      }
      if (previous === undefined) {
        const next: SyncSessionStatus = {
          sessionId: entry.sessionId,
          phase: state === 'up-to-date' ? 'done' : state === 'planned' ? 'planned' : 'deferred',
          pending: { upload: 0, download: 0 },
          totalEvents: 0,
          doneEvents: 0,
          live: false,
          tailOpen: false,
          remoteAhead: state === 'remote-ahead',
          cwdPending: false,
          updatedAt: now,
          ...entry.direction === 'push' ? { push: lane } : { pull: lane },
        }
        map.set(entry.sessionId, next)
        continue
      }
      const current = entry.direction === 'push' ? previous.push : previous.pull
      const shouldSet = current === undefined
        || (current.status === 'planned' && lane.status !== 'planned')
      if (entry.direction === 'push') {
        // 本地已存在时，旧的 pull planned/unmapped 占位应被本机记录修复，不能一直显示待拉取/等待 cwd。
        const stalePull = previous.pull?.status === 'planned' || previous.pull?.status === 'unmapped'
        const repairedStatus = state === 'up-to-date' || state === 'local-ahead'
          ? 'up-to-date'
          : state === 'remote-ahead' ? 'remote-ahead' : 'planned'
        const repairedPull = stalePull && repairedStatus !== undefined && previous.pull !== undefined
          ? {
              sessionId: previous.pull.sessionId,
              direction: 'pull' as const,
              status: repairedStatus,
              phase: directionPhaseOf('pull', repairedStatus),
              totalEvents: previous.pull.totalEvents,
              doneEvents: previous.pull.doneEvents,
              ...repairedStatus === 'up-to-date' ? { stage: 'done' as const } : {},
              ...previous.pull.error === undefined ? {} : { error: previous.pull.error },
            }
          : previous.pull
        map.set(entry.sessionId, {
          ...previous,
          ...shouldSet ? { push: lane } : {},
          ...repairedPull === undefined ? {} : { pull: repairedPull },
        })
      } else if (shouldSet) {
        map.set(entry.sessionId, { ...previous, pull: lane })
      }
    }
    this.stableViews = [...map.values()]
    this.bump()
  }

  /**
   * 用本机记录修正 seed 留下的陈旧状态：
   * - 本地已有记录时，旧的 unmapped/pull planned 不能继续支配气泡；
   * - 未选中的纯本地会话从列表移除（除非仍有分叉/cwd 等需要处理）。
   * @param localIds - 本机所有会话 id。
   * @param selected - 当前上传选择。
   */
  reconcileLocal(localIds: ReadonlySet<string>, selected: ReadonlySet<string>): void {
    let changed = false
    for (const sessionId of localIds) {
      if (this.unmapped.delete(sessionId)) changed = true
    }
    const staleUnmapped = (view: SyncDirectionStatus): boolean =>
      localIds.has(view.sessionId) && view.direction === 'pull' && view.status === 'unmapped'
    this.sessions = this.sessions.filter((view) => !staleUnmapped(view))
    this.live = this.live.filter((view) => !staleUnmapped(view))

    const remove = new Set<string>()
    for (const view of this.stableViews) {
      if (!localIds.has(view.sessionId)) continue
      if (selected.has(view.sessionId)) continue
      if (view.blocked !== undefined || view.decision !== undefined || view.cwdPending) continue
      remove.add(view.sessionId)
    }
    if (remove.size > 0) {
      this.stableViews = this.stableViews.filter((view) => !remove.has(view.sessionId))
      this.sessions = this.sessions.filter((view) => !remove.has(view.sessionId))
      this.live = this.live.filter((view) => !remove.has(view.sessionId))
      changed = true
    }
    if (changed) this.bump()
  }

  /**
   * 开始一次由宿主映射回填触发的 pull。它不推进主 cursor，也不走 scheduler 的
   * 退避，但必须让气泡看到正在拉取的状态。
   * @returns 已有同步在跑时返回 false。
   */
  beginBackfill(): boolean {
    if (this.running) return false
    this.running = true
    this.live = []
    this.runView = {
      id: this.runView.id + 1,
      trigger: 'auto',
      state: 'running',
      startedAt: this.now(),
      finishedAt: null,
    }
    this.bump()
    return true
  }

  /**
   * 结束映射回填，并把 pull 结果合并进稳定视图。
   * @param report - 拉取结果；缺失时只结束运行状态。
   */
  endBackfill(report?: PullReport): void {
    if (!this.running) return
    if (report !== undefined && report.configured) {
      const views: SyncDirectionStatus[] = []
      this.collectPull(report, views, [])
      this.sessions = views
    }
    this.running = false
    this.live = []
    this.runView = {
      ...this.runView,
      state: 'finished',
      finishedAt: this.now(),
    }
    this.bump()
  }

  /**
   * 记录一次映射回填的拉取结果：更新未映射表，并把 pull 方向合并进会话视图。
   * 回填不推进主游标，但必须让设置页/气泡看到真实 pull 状态，不能只留
   * 上一轮的 push skipped。
   * @param report - 回填拉取结果。
   */
  recordBackfill(report: PullReport): void {
    if (!report.configured) return
    const views: SyncDirectionStatus[] = []
    this.collectPull(report, views, [])
    if (views.length > 0) {
      const merged = new Map(this.sessions.map((view) => [`${view.direction}:${view.sessionId}`, view]))
      for (const view of views) merged.set(`${view.direction}:${view.sessionId}`, view)
      this.sessions = [...merged.values()]
      this.bump()
    }
  }

  /**
   * 执行一轮推送 + 拉取。
   * @param options - `manual: true` 表示用户手动触发，跳过当前退避。
   * @returns 本轮结果与结束后的状态快照。
   */
  async run(options: {
    readonly manual?: boolean
    readonly trigger?: 'startup' | 'auto' | 'manual'
  } = {}): Promise<SyncRunResult> {
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
    this.runView = {
      id: this.runView.id + 1,
      trigger: options.trigger ?? (options.manual === true ? 'manual' : 'auto'),
      state: 'running',
      startedAt: now,
      finishedAt: null,
    }
    this.bump()
    const errors: Array<{ kind: SyncErrorKind; message: string }> = []
    const views: SyncDirectionStatus[] = []
    try {
      // 拉取不需要租约；只有持有全局单写者租约时才允许上传。
      const lease = this.options.deviceLease?.()
      if (lease === undefined || lease.state === 'held') {
        this.collectPush(await this.options.push(), views, errors)
      }
      const pull = await this.options.pull(this.pullState())
      this.collectPull(pull, views, errors)
      if (pull.configured && pull.sessions.every((session) => session.status !== 'error')) {
        this.revision = pull.revision
        this.persistNow()
      }
    } catch (error: unknown) {
      const classified = classifySyncError(error)
      errors.push({ kind: classified.kind, message: classified.message })
      this.options.logger?.warn(`dsh-session-cloudsync: 一次同步失败（${classified.kind}）：${classified.message}`)
    }

    this.running = false
    this.sessions = views
    this.live = []
    const finished = this.now()
    this.runView = {
      ...this.runView,
      state: 'finished',
      finishedAt: finished,
    }
    this.bump()
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
      ...this.blocked.size === 0 ? {} : { blocked: [...this.blocked.values()] },
      ...this.blockedDecisions.size === 0 ? {} : { blockedDecisions: [...this.blockedDecisions.values()] },
      ...this.unmapped.size === 0 ? {} : { unmapped: [...this.unmapped.values()] },
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
    this.options.logger?.warn(`dsh-session-cloudsync: 将在 ${Math.round(delay / 1000)}s 后重试（retry=${this.retryCount}）`)
    this.bump()
    return { ok: false, message: first.message, status: this.snapshot() }
  }

  /** 把一次拉取里的未映射状态并入持久集合；返回集合是否变化。 */
  private trackUnmapped(session: PullSessionReport): boolean {
    if (session.status === 'unmapped' && session.workspaceKey !== undefined) {
      const previous = this.unmapped.get(session.sessionId)
      const createdAt = session.createdAt ?? previous?.createdAt
      const formatVersion = session.formatVersion ?? previous?.formatVersion
      const revision = session.revision ?? previous?.revision ?? 0
      if (previous !== undefined
        && previous.workspaceKey === session.workspaceKey
        && previous.revision === revision
        && previous.createdAt === createdAt
        && previous.formatVersion === formatVersion) return false
      this.unmapped.set(session.sessionId, {
        sessionId: session.sessionId,
        workspaceKey: session.workspaceKey,
        revision,
        at: previous?.at ?? this.now(),
        ...createdAt === undefined ? {} : { createdAt },
        ...formatVersion === undefined ? {} : { formatVersion },
      })
      return true
    }
    // 错误可能发生在解析 workspaceKey 之前；保留旧记录，等下一次成功拉取/回填再清。
    if (session.status !== 'error') return this.unmapped.delete(session.sessionId)
    return false
  }

  private collectPush(
    report: SyncReport,
    views: SyncDirectionStatus[],
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
      this.options.logger?.info(`dsh-session-cloudsync: 推送 ${pushed.length} 个会话，失败 ${failed.length}，跳过 ${skipped}`)
    }
    for (const session of report.sessions) views.push(pushView(session))
    for (const session of report.sessions) {
      if (session.status === 'error'
        && session.createdAt !== undefined
        && session.formatVersion !== undefined) {
        this.block(session.sessionId, session.kind ?? 'unknown', session.error ?? '未知错误', session.createdAt, session.formatVersion)
      }
    }
    for (const session of failed) {
      const kind = session.kind ?? 'unknown'
      errors.push({ kind, message: session.error ?? '未知错误' })
      this.options.logger?.warn(`dsh-session-cloudsync: ${session.sessionId} 失败（${kind}）：${session.error ?? '未知错误'}`)
    }
  }

  private collectPull(
    report: PullReport,
    views: SyncDirectionStatus[],
    errors: Array<{ kind: SyncErrorKind; message: string }>,
  ): void {
    if (!report.configured) return
    const failed = report.sessions.filter((session) => session.status === 'error')
    const applied = report.sessions.filter((session) => session.status === 'pulled' || session.status === 'partial')
    if (applied.length > 0 || failed.length > 0) {
      this.options.logger?.info(`dsh-session-cloudsync: 拉取 ${applied.length} 个会话，失败 ${failed.length}`)
    }
    for (const session of report.sessions) views.push(pullView(session))
    let unmappedChanged = false
    for (const session of report.sessions) {
      unmappedChanged = this.trackUnmapped(session) || unmappedChanged
      if (session.cwdNonPortable === true) {
        this.cwdPending.add(session.sessionId)
      } else if (session.status !== 'error') {
        this.cwdPending.delete(session.sessionId)
      }
      if (session.status === 'error'
        && session.createdAt !== undefined
        && session.formatVersion !== undefined) {
        this.block(session.sessionId, session.kind ?? 'unknown', session.error ?? '未知错误', session.createdAt, session.formatVersion)
      }
      else {
        const hadBlocked = this.blocked.delete(session.sessionId)
        const hadDecision = this.blockedDecisions.delete(session.sessionId)
        if (hadBlocked || hadDecision) this.persistNow()
      }
    }
    if (unmappedChanged) this.persistNow()
    for (const session of failed) {
      const kind = session.kind ?? 'unknown'
      errors.push({ kind, message: session.error ?? '未知错误' })
      this.options.logger?.warn(`dsh-session-cloudsync: 拉取 ${session.sessionId} 失败（${kind}）：${session.error ?? '未知错误'}`)
    }
  }
}

/** 生命周期匹配；任一方没有完整信息时退回按 sessionId。 */
function sameLifecycle(
  entry: { readonly createdAt: number; readonly formatVersion: number },
  createdAt: number,
  formatVersion: number,
): boolean {
  return entry.createdAt === createdAt && entry.formatVersion === formatVersion
}

/**
 * 由引擎结果生成稳定视图。
 * @param session - 推送结果。
 * @returns 客户端视图。
 */
function pushView(session: SessionSyncReport): SyncDirectionStatus {
  const totalEvents = session.totalEvents ?? 0
  const doneEvents = session.doneEvents ?? (session.status === 'pushed' ? totalEvents : 0)
  const stage = stageOfStatus('push', session.status)
  return {
    sessionId: session.sessionId,
    direction: 'push',
    phase: directionPhaseOf('push', session.status),
    ...stage === undefined ? {} : { stage },
    status: session.status,
    totalEvents,
    doneEvents,
    ...session.pendingEvents === undefined ? {} : { pendingEvents: session.pendingEvents },
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
function pullView(session: PullSessionReport): SyncDirectionStatus {
  const doneEvents = session.applied ?? 0
  const totalEvents = session.totalEvents ?? doneEvents
  const stage = stageOfStatus('pull', session.status)
  return {
    sessionId: session.sessionId,
    direction: 'pull',
    phase: directionPhaseOf('pull', session.status),
    ...stage === undefined ? {} : { stage },
    status: session.status,
    totalEvents,
    doneEvents,
    ...session.pendingEvents === undefined ? {} : { pendingEvents: session.pendingEvents },
    ...session.applied === undefined ? {} : { applied: session.applied },
    ...session.cwdNonPortable === undefined ? {} : { cwdNonPortable: session.cwdNonPortable },
    ...session.workspaceKey === undefined ? {} : { workspaceKey: session.workspaceKey },
    ...session.kind === undefined ? {} : { kind: session.kind },
    ...session.error === undefined ? {} : { error: session.error },
  }
}

/** 引擎原始状态到方向的稳定阶段。 */
function directionPhaseOf(direction: 'push' | 'pull', status: string): SyncDirectionPhase {
  if (status === 'error') return 'failed'
  if (status === 'up-to-date') return 'up-to-date'
  if (status === 'pushed' || status === 'pulled') return 'done'
  if (status === 'skipped' || status === 'excluded' || status === 'tombstone') return 'skipped'
  if (status === 'remote-ahead' || status === 'partial'
    || status === 'local-active' || status === 'write-owned' || status === 'local-ahead' || status === 'unmapped') return 'deferred'
  if (direction === 'push' ? status === 'pushing' : status === 'pulling') return 'transferring'
  return 'planned'
}

/** 方向最终状态对应的细分阶段。 */
function stageOfStatus(_direction: 'push' | 'pull', status: string): SyncStage | undefined {
  if (status === 'error') return 'failed'
  if (status === 'pushed' || status === 'pulled' || status === 'up-to-date') return 'done'
  if (status === 'local-active') return 'waiting-live'
  if (status === 'write-owned') return 'waiting-write'
  if (status === 'unmapped') return 'waiting-cwd'
  if (status === 'partial') return 'applying'
  return undefined
}

/** 聚合视图的可变中间态。 */
interface MutableSessionStatus {
  readonly sessionId: string
  push?: SyncDirectionStatus
  pull?: SyncDirectionStatus
  live: boolean
  tailOpen: boolean
  remoteAhead: boolean
  cwdPending: boolean
  unmapped?: { readonly workspaceKey: string; readonly label?: string }
  blocked?: BlockedSessionView
  decision?: BlockedDecisionView
  updatedAt: number
}

/** 收束聚合视图并计算阶段/计数。 */
function finishSessionView(entry: MutableSessionStatus, now: number): SyncSessionStatus {
  const upload = entry.push === undefined
    ? 0
    : entry.push.status === 'remote-ahead'
      ? 0
      : Math.max(0, entry.push.totalEvents - entry.push.doneEvents)
  const download = entry.pull === undefined
    ? (entry.push?.pendingEvents ?? 0)
    : Math.max(0, entry.pull.totalEvents - entry.pull.doneEvents)
  const totalEvents = (entry.push?.totalEvents ?? 0) + (entry.pull?.totalEvents ?? 0)
  const doneEvents = (entry.push?.doneEvents ?? 0) + (entry.pull?.doneEvents ?? 0)
  const directions = [entry.push, entry.pull].filter((value): value is SyncDirectionStatus => value !== undefined)
  const failed = directions.some((direction) => direction.phase === 'failed')
  const running = directions.some((direction) => direction.phase === 'transferring'
    || direction.phase === 'committing' || direction.phase === 'applying')
  const deferred = entry.live || entry.remoteAhead || entry.cwdPending
    || entry.unmapped !== undefined
    || entry.pull?.phase === 'deferred'
    || entry.push?.status === 'local-ahead'
    || (entry.push?.phase === 'deferred' && entry.remoteAhead)
  const terminal = directions.length > 0 && directions.every((direction) =>
    direction.phase === 'done' || direction.phase === 'up-to-date' || direction.phase === 'skipped'
    || (direction.direction === 'push' && direction.status === 'remote-ahead' && !entry.remoteAhead))
  const phase: SyncSessionPhase = entry.blocked !== undefined
    ? 'blocked'
    : failed
      ? 'failed'
      : running
        ? 'running'
        : deferred
          ? 'deferred'
          : terminal
            ? (directions.every((direction) => direction.phase === 'skipped') ? 'skipped' : 'done')
            : 'planned'
  const stage = directions.map((direction) => direction.stage)
    .find((value) => value !== undefined && value !== 'done' && value !== 'failed')
    ?? directions.map((direction) => direction.stage).find((value) => value !== undefined)
  return {
    sessionId: entry.sessionId,
    phase,
    ...stage === undefined ? {} : { stage },
    ...entry.push === undefined ? {} : { push: entry.push },
    ...entry.pull === undefined ? {} : { pull: entry.pull },
    pending: { upload, download },
    totalEvents,
    doneEvents,
    live: entry.live,
    tailOpen: entry.tailOpen,
    remoteAhead: entry.remoteAhead,
    cwdPending: entry.cwdPending,
    ...entry.unmapped === undefined ? {} : { unmapped: entry.unmapped },
    ...entry.blocked === undefined ? {} : { blocked: entry.blocked },
    ...entry.decision === undefined ? {} : { decision: entry.decision },
    updatedAt: now,
  }
}
