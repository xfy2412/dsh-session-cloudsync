/**
 * 同步性能采集：只在本进程内保留最近若干次 run 的墙钟、阶段耗时和
 * 事件循环延迟。不写会话日志，不发送到外部服务。
 *
 * 采集器只依赖 Node 性能 API；调用方在 run 开始/进度/结束时打点。
 *
 * @module dsh-session-cloudsync/perf
 */
import { cpus } from 'node:os'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { SyncPerfSample, SyncPerfStart, SyncProgress, SyncStage } from './engine.ts'
import type { SyncStatus } from './status.ts'

/** 保留的 run 数。 */
const MAX_RUNS = 30

/** 一类阶段的累计墙钟。 */
export interface PerfStageTotals {
  readonly [stage: string]: number
}

/** 一次同步 run 的聚合结果。 */
export interface PerfRunSummary {
  /** 采集 schema 版本。 */
  readonly schemaVersion: 1
  /** 本轮 run 的 id。 */
  readonly runId: number
  /** 触发来源。 */
  readonly trigger: string
  /** epoch 毫秒。 */
  readonly startedAt: number
  /** epoch 毫秒。 */
  readonly finishedAt: number
  /** 墙钟总耗时。 */
  readonly wallMs: number
  /** 各 stage 的累计耗时；并发会话会分别累计。 */
  readonly stageMs: PerfStageTotals
  /** 引擎直接测得的操作耗时（read/seal/upload/append/download/apply/flush）。 */
  readonly operations: PerfStageTotals
  /** run 外层阶段的墙钟（seed/list/bind/backfill/flush）。 */
  readonly phases: PerfStageTotals
  /** 事件循环延迟。 */
  readonly eventLoop: {
    readonly maxMs: number
    readonly p99Ms: number
    readonly p50Ms: number
  }
  /** 按操作归因的事件循环最大延迟。 */
  readonly eventLoopByStage: PerfStageTotals
  /** RSS 采样。 */
  readonly rss: {
    readonly startMb: number
    readonly peakMb: number
  }
  /** 会话汇总。 */
  readonly sessions: {
    readonly total: number
    readonly push: number
    readonly pull: number
    readonly skipped: number
    readonly failed: number
  }
  /** 已上传/下载的字节数（各方向最后进度之和）。 */
  readonly bytes: {
    readonly uploaded: number
    readonly downloaded: number
  }
}

/** 采样环境。 */
export interface PerfEnvironment {
  readonly plugin: string
  readonly node: string
  readonly platform: string
  readonly arch: string
  readonly cpuCount: number
}

/** `/perf` 的返回体。 */
export interface PerfSnapshot {
  readonly schemaVersion: 1
  readonly active: boolean
  readonly latest: PerfRunSummary | null
  readonly recent: readonly PerfRunSummary[]
  readonly environment: PerfEnvironment
}

interface ActiveStage {
  readonly stage: SyncStage
  readonly startedAt: number
}

/**
 * 进程内性能采集器。
 *
 * 事件循环 histogram 在 run 开始时 reset，结束时读取 max/p99；因此结果只覆盖
 * 当前 run，而不会把启动阶段的历史延迟混入。
 */
export class PerfCollector {
  private runHistogram: ReturnType<typeof monitorEventLoopDelay> | undefined
  private opHistogram: ReturnType<typeof monitorEventLoopDelay> | undefined
  private active = false
  private trigger = 'unknown'
  private startedAt = 0
  private startedMono = 0
  private rssStartMb = 0
  private rssPeakMb = 0
  private stageMs: Record<string, number> = {}
  private operationMs: Record<string, number> = {}
  private phaseMs: Record<string, number> = {}
  private eventLoopByStage: Record<string, number> = {}
  private opStage: SyncPerfSample['stage'] | null = null
  private readonly stages = new Map<string, ActiveStage>()
  private readonly bytes = new Map<string, number>()
  private readonly runs: PerfRunSummary[] = []

  constructor() {
    // histogram 在 begin() 时才启用，避免空闲进程/测试常驻一个计时器。
  }

  /** 开始一轮采集；已有活动 run 时丢弃旧活动状态。 */
  begin(trigger: string): void {
    if (this.runHistogram === undefined) {
      this.runHistogram = monitorEventLoopDelay({ resolution: 10 })
      this.runHistogram.enable()
    }
    if (this.opHistogram === undefined) {
      this.opHistogram = monitorEventLoopDelay({ resolution: 5 })
      this.opHistogram.enable()
    }
    this.runHistogram.reset()
    this.opHistogram.reset()
    this.active = true
    this.trigger = trigger
    this.startedAt = Date.now()
    this.startedMono = performance.now()
    this.rssStartMb = currentRssMb()
    this.rssPeakMb = this.rssStartMb
    this.stageMs = {}
    this.operationMs = {}
    this.phaseMs = {}
    this.eventLoopByStage = {}
    this.opStage = null
    this.stages.clear()
    this.bytes.clear()
  }

  /**
   * 接收引擎进度；只在 stage 变化时结算上一阶段。
   * @param progress - 引擎实时进度。
   */
  progress(progress: SyncProgress): void {
    if (!this.active) return
    const key = progress.direction + ':' + progress.sessionId
    const now = performance.now()
    const nextStage = progress.stage
    const previous = this.stages.get(key)
    if (nextStage !== undefined && previous?.stage !== nextStage) {
      if (previous !== undefined) this.addStage(previous.stage, now - previous.startedAt)
      this.stages.set(key, { stage: nextStage, startedAt: now })
      this.rssPeakMb = Math.max(this.rssPeakMb, currentRssMb())
    }
    if (progress.phase === 'done' || progress.phase === 'error') {
      if (previous !== undefined) this.addStage(previous.stage, now - previous.startedAt)
      this.stages.delete(key)
    }
    const doneBytes = progress.doneBytes ?? progress.bytes
    if (doneBytes !== undefined) {
      this.bytes.set(key, Math.max(this.bytes.get(key) ?? 0, doneBytes))
    }
  }

  /**
   * 标记一个操作的开始；重置操作级事件循环采样。
   * @param sample - 操作方向/会话/阶段。
   */
  beginOperation(sample: SyncPerfStart): void {
    if (!this.active || this.opHistogram === undefined) return
    this.opHistogram.reset()
    this.opStage = sample.stage
  }

  /**
   * 接收引擎直接测得的操作耗时。
   * @param sample - 一次 read/seal/upload/append 等操作。
   */
  metric(sample: SyncPerfSample): void {
    if (!this.active) return
    if (!Number.isFinite(sample.ms) || sample.ms < 0) return
    this.operationMs[sample.stage] = (this.operationMs[sample.stage] ?? 0) + sample.ms
    if (this.opHistogram !== undefined) {
      let maxMs = roundMs(this.opHistogram.max / 1e6)
      // 同步操作返回后，timer 回调还没机会记录这次长阻塞；用操作自身墙钟补足。
      if (sample.blocking === true) maxMs = Math.max(maxMs, roundMs(sample.ms))
      this.eventLoopByStage[sample.stage] = Math.max(this.eventLoopByStage[sample.stage] ?? 0, maxMs)
      this.opHistogram.reset()
      this.opStage = null
    }
  }

  /**
   * 记录 run 外层阶段墙钟；不重置操作 histogram。
   * @param name - 阶段名，如 seed/list/bind/backfill。
   * @param elapsed - 墙钟毫秒。
   */
  phase(name: string, elapsed: number): void {
    if (!this.active) return
    if (!Number.isFinite(elapsed) || elapsed < 0) return
    this.phaseMs[name] = (this.phaseMs[name] ?? 0) + elapsed
  }

  /**
   * 结束一轮采集并保留聚合结果。
   * @param status - 结束后的状态；缺失时只记录不完整结果。
   */
  finish(status?: SyncStatus): void {
    if (!this.active) return
    const now = performance.now()
    for (const [key, stage] of this.stages) {
      this.addStage(stage.stage, now - stage.startedAt)
      this.stages.delete(key)
    }
    this.rssPeakMb = Math.max(this.rssPeakMb, currentRssMb())
    const histogram = this.runHistogram
    const eventLoop = {
      maxMs: histogram === undefined ? 0 : roundMs(histogram.max / 1e6),
      p99Ms: histogram === undefined ? 0 : roundMs(histogram.percentile(99) / 1e6),
      p50Ms: histogram === undefined ? 0 : roundMs(histogram.percentile(50) / 1e6),
    }
    if (this.opHistogram !== undefined && this.opStage !== null) {
      const current = this.eventLoopByStage[this.opStage]
      this.eventLoopByStage[this.opStage] = Math.max(current ?? 0, roundMs(this.opHistogram.max / 1e6))
      this.opStage = null
    }
    const summary: PerfRunSummary = {
      schemaVersion: 1,
      runId: status?.run.id ?? 0,
      trigger: this.trigger,
      startedAt: this.startedAt,
      finishedAt: Date.now(),
      wallMs: Math.round(now - this.startedMono),
      stageMs: { ...this.stageMs },
      operations: { ...this.operationMs },
      phases: { ...this.phaseMs },
      eventLoop,
      eventLoopByStage: { ...this.eventLoopByStage },
      rss: {
        startMb: this.rssStartMb,
        peakMb: this.rssPeakMb,
      },
      sessions: summarizeSessions(status),
      bytes: {
        uploaded: this.sumBytes('push:'),
        downloaded: this.sumBytes('pull:'),
      },
    }
    this.runs.unshift(summary)
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS
    this.active = false
    this.stages.clear()
  }

  /** 当前采集快照；不包含 session 内容。 */
  snapshot(): PerfSnapshot {
    return {
      schemaVersion: 1,
      active: this.active,
      latest: this.runs[0] ?? null,
      recent: this.runs.slice(),
      environment: {
        plugin: 'dsh-session-cloudsync',
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuCount: cpus().length,
      },
    }
  }

  private addStage(stage: SyncStage, elapsed: number): void {
    if (!Number.isFinite(elapsed) || elapsed < 0) return
    this.stageMs[stage] = (this.stageMs[stage] ?? 0) + elapsed
  }

  private sumBytes(prefix: string): number {
    let total = 0
    for (const [key, bytes] of this.bytes) {
      if (key.startsWith(prefix)) total += bytes
    }
    return total
  }
}

function currentRssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024)
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10
}

function summarizeSessions(status?: SyncStatus): PerfRunSummary['sessions'] {
  const sessions = status?.sessions ?? []
  return {
    total: sessions.length,
    push: sessions.filter((session) => session.push !== undefined).length,
    pull: sessions.filter((session) => session.pull !== undefined).length,
    skipped: sessions.filter((session) => session.phase === 'skipped').length,
    failed: sessions.filter((session) => session.phase === 'failed').length,
  }
}
