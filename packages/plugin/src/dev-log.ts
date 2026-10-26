/**
 * 开发控制台日志 sink。
 *
 * 只在 `debug` / `devLogUrl`（或 `DSH_SESSION_CLOUDSYNC_DEV_LOG`）启用时工作：
 * 把插件自己的 `SyncLogger` 文本异步 POST 到本地控制台，不阻塞同步、不影响
 * 生产日志。控制台不可达时静默丢弃，绝不把日志失败变成同步失败。
 *
 * @module dsh-session-cloudsync/dev-log
 */
import type { SyncLogger } from './engine.ts'

/** 控制台识别的日志级别。 */
export type DevLogLevel = 'info' | 'warn' | 'error'

/** 一批上报条目。 */
export interface DevLogEntry {
  /** 级别。 */
  readonly level: DevLogLevel
  /** 已格式化的文本。 */
  readonly message: string
  /** 来源标签，例如 `dsh-session-cloudsync`。 */
  readonly source: string
  /** epoch 毫秒。 */
  readonly time: number
}

/** sink 依赖。 */
export interface DevLogSinkOptions {
  /** 当前是否启用；读取可热更新配置。 */
  readonly enabled: () => boolean
  /** 完整接收地址，例如 `http://127.0.0.1:3092/api/log/a`。 */
  readonly url: () => string
  /** 来源标签，默认 `dsh-session-cloudsync`。 */
  readonly source?: string
  /** 测试可替换的 fetch。 */
  readonly fetchImpl?: typeof fetch
  /** 测试可替换的调度；默认 `setTimeout(..., 0)`。 */
  readonly schedule?: (task: () => void) => void
  /** 测试可替换的时钟。 */
  readonly now?: () => number
  /** 队列上限；超出丢最旧。默认 200。 */
  readonly maxQueue?: number
  /** 单条消息上限；超出截断。默认 16000。 */
  readonly maxMessageChars?: number
}

/**
 * 有界异步日志队列。
 *
 * 发送是单飞的：同一时刻最多一个 POST；队列为空后停止调度。失败只丢当前批，
 * 不重试、不递归记日志，避免控制台未启动时拖住宿主。
 */
export class DevLogSink {
  private readonly options: DevLogSinkOptions
  private readonly maxQueue: number
  private readonly maxMessageChars: number
  private readonly source: string
  private queue: DevLogEntry[] = []
  private scheduled = false
  private sending = false

  /**
   * @param options - 启用条件、地址与测试钩子。
   */
  constructor(options: DevLogSinkOptions) {
    this.options = options
    this.maxQueue = Math.max(1, options.maxQueue ?? 200)
    this.maxMessageChars = Math.max(128, options.maxMessageChars ?? 16_000)
    this.source = options.source ?? 'dsh-session-cloudsync'
  }

  /**
   * 记录一条日志；未启用或地址为空时直接返回。
   * @param level - 级别。
   * @param message - 文本。
   */
  write(level: DevLogLevel, message: string): void {
    if (!this.options.enabled()) return
    if (this.options.url().trim() === '') return
    const text = message.length > this.maxMessageChars
      ? `${message.slice(0, this.maxMessageChars)}…`
      : message
    this.queue.push({
      level,
      message: text,
      source: this.source,
      time: this.options.now?.() ?? Date.now(),
    })
    if (this.queue.length > this.maxQueue) {
      this.queue.splice(0, this.queue.length - this.maxQueue)
    }
    this.scheduleFlush()
  }

  /**
   * 立即发送当前队列；测试和退出前可手动调用。
   * @returns 队列处理完（或失败丢弃）后 resolve。
   */
  async flush(): Promise<void> {
    if (this.sending) return
    if (!this.options.enabled()) {
      this.queue = []
      return
    }
    const url = this.options.url().trim()
    if (url === '') {
      this.queue = []
      return
    }
    this.sending = true
    try {
      while (this.queue.length > 0) {
        const entries = this.queue.splice(0, 20)
        try {
          await (this.options.fetchImpl ?? fetch)(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entries }),
          })
        } catch {
          // 控制台未启动/被关掉：丢弃这一批，不影响插件主流程。
          break
        }
      }
    } finally {
      this.sending = false
      if (this.queue.length > 0 && this.options.enabled()) this.scheduleFlush()
    }
  }

  /** 安排一次异步 flush；同一 tick 多次写入只调度一次。 */
  private scheduleFlush(): void {
    if (this.scheduled) return
    this.scheduled = true
    const task = (): void => {
      this.scheduled = false
      void this.flush()
    }
    const schedule = this.options.schedule ?? ((run: () => void) => {
      const timer = setTimeout(run, 0)
      ;(timer as { unref?: () => void }).unref?.()
    })
    schedule(task)
  }
}

/**
 * 在保留原 logger 的前提下追加 dev sink。
 * @param base - 原来的宿主 logger。
 * @param sink - dev sink。
 * @returns 同时写宿主与 sink 的 logger。
 */
export function withDevLog(base: SyncLogger, sink: DevLogSink): SyncLogger {
  return {
    info: (message) => {
      base.info(message)
      sink.write('info', message)
    },
    warn: (message) => {
      base.warn(message)
      sink.write('warn', message)
    },
    error: (message) => {
      base.error(message)
      sink.write('error', message)
    },
  }
}
