/**
 * 自动同步调度器：用自调度 `setTimeout` 维护绝对的 `nextRunAt`，替代固定
 * `setInterval`。手动触发会清掉当前 timer，跑完后重新排期；失败退避时间由
 * controller 的 `nextRetryAt` 反馈。
 *
 * @module dsh-session-cloudsync/scheduler
 */
import type { SyncSchedulerView } from './status.ts'
import type { SyncRunResult } from './controller.ts'

/** 调度器依赖。 */
export interface SyncSchedulerOptions {
  /** 执行一轮同步；trigger 区分启动/自动/手动。 */
  readonly run: (trigger: 'startup' | 'auto' | 'manual') => Promise<SyncRunResult>
  /** 当前自动同步间隔。 */
  readonly intervalMs: () => number
  /** 当前是否开启自动同步。 */
  readonly autoSync: () => boolean
  /** 测试可替换时钟。 */
  readonly now?: () => number
  /** 日志。 */
  readonly logger?: { warn(message: string): void }
  /** 最小调度间隔，避免 0ms 忙循环。默认 1000ms。 */
  readonly minDelayMs?: number
  /** 排期变化时通知（供 SSE/状态版本使用）。 */
  readonly onChange?: () => void
}

/**
 * 维护自动同步 timer 与 `nextRunAt`。
 */
export class SyncScheduler {
  private readonly options: SyncSchedulerOptions
  private readonly minDelayMs: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextRunAt: number | null = null
  private lastBackoffUntil: number | null = null
  private running = false
  private disposed = false
  private lastIntervalMs = -1
  private lastAutoSync = false

  /**
   * @param options - 执行器、配置读取与时钟。
   */
  constructor(options: SyncSchedulerOptions) {
    this.options = options
    this.minDelayMs = Math.max(1, options.minDelayMs ?? 1000)
  }

  /** 启动自动调度；启动本身不立即跑一轮。 */
  start(): void {
    if (this.disposed) return
    this.schedule()
  }

  /** 停止 timer。 */
  stop(): void {
    this.disposed = true
    this.clearTimer()
    this.nextRunAt = null
  }

  /** 当前调度视图。 */
  snapshot(): SyncSchedulerView {
    return {
      autoSync: this.options.autoSync(),
      intervalMs: this.options.intervalMs(),
      nextRunAt: this.nextRunAt,
      backoffUntil: this.lastBackoffUntil,
    }
  }

  /**
   * 手动触发一轮；清掉当前 timer，跑完后重新排期。
   * @returns 本轮同步结果。
   */
  async manual(): Promise<SyncRunResult> {
    this.clearTimer()
    this.nextRunAt = null
    if (this.running) {
      // 自动轮还在跑：交给 controller 返回 already-running，不并发改 scheduler 状态。
      return await this.options.run('manual')
    }
    return await this.execute('manual')
  }

  /** 配置变化后重排；配置没变时不动作。 */
  reconfigure(): void {
    const interval = this.options.intervalMs()
    const autoSync = this.options.autoSync()
    if (interval === this.lastIntervalMs && autoSync === this.lastAutoSync) return
    this.lastIntervalMs = interval
    this.lastAutoSync = autoSync
    if (this.running) return
    this.schedule()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(): void {
    this.clearTimer()
    if (this.disposed) {
      this.nextRunAt = null
      return
    }
    const autoSync = this.options.autoSync()
    if (!autoSync) {
      if (this.nextRunAt !== null) {
        this.nextRunAt = null
        this.options.onChange?.()
      }
      return
    }
    const now = this.now()
    const base = now + Math.max(this.minDelayMs, this.options.intervalMs())
    const at = this.lastBackoffUntil !== null && this.lastBackoffUntil > now
      ? Math.max(base, this.lastBackoffUntil)
      : base
    this.nextRunAt = at
    this.timer = setTimeout(() => { void this.fire() }, Math.max(1, at - now))
    ;(this.timer as { unref?: () => void }).unref?.()
    this.options.onChange?.()
  }

  private async fire(): Promise<void> {
    this.timer = undefined
    this.nextRunAt = null
    if (this.disposed) return
    if (this.running) {
      this.schedule()
      return
    }
    try {
      await this.execute('auto')
    } catch (error: unknown) {
      this.options.logger?.warn(`dsh-session-cloudsync: 自动同步调度失败：${error instanceof Error ? error.message : String(error)}`)
      this.schedule()
    }
  }

  private async execute(trigger: 'startup' | 'auto' | 'manual'): Promise<SyncRunResult> {
    this.running = true
    this.nextRunAt = null
    try {
      const result = await this.options.run(trigger)
      this.lastBackoffUntil = result.status.nextRetryAt
      return result
    } finally {
      this.running = false
      this.schedule()
    }
  }
}
