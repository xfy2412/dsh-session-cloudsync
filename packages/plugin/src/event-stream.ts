/**
 * 同步状态的 SSE 事件流：连接后先发一帧全量快照，之后在状态版本变化时
 * 合并发送；支持心跳、客户端 abort、空闲关闭和最长生命周期。
 *
 * 该模块只依赖 Fetch/Streams，宿主路由通过 `connection.fetch` 注册。
 *
 * @module dsh-session-cloudsync/event-stream
 */
import type { SyncStatus } from './status.ts'

/** SSE 流依赖。 */
export interface EventStreamOptions {
  /** 读取当前状态快照。 */
  readonly status: () => SyncStatus
  /** 订阅状态变化；返回取消订阅。 */
  readonly subscribe: (listener: () => void) => () => void
  /** 心跳间隔，默认 15s。 */
  readonly heartbeatMs?: number
  /** 合并窗口，默认 80ms。 */
  readonly coalesceMs?: number
  /** 空闲关闭宽限，默认 2s。 */
  readonly idleGraceMs?: number
  /** 最长连接时长，默认 10 分钟。 */
  readonly maxLifetimeMs?: number
}

const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_COALESCE_MS = 80
const DEFAULT_IDLE_GRACE_MS = 2_000
const DEFAULT_MAX_LIFETIME_MS = 10 * 60_000

/**
 * 创建一个 `text/event-stream` 响应。
 * @param request - 浏览器请求；`until=idle` 时终态后关闭。
 * @param options - 状态源、订阅与时间参数。
 * @returns 可长期持有的 SSE 响应。
 */
export function createEventStreamResponse(request: Request, options: EventStreamOptions): Response {
  const untilIdle = new URL(request.url).searchParams.get('until') === 'idle'
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS
  const maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS
  const encoder = new TextEncoder()
  let cancelStream: (() => void) | undefined

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let unsubscribe: (() => void) | undefined
      let coalesceTimer: ReturnType<typeof setTimeout> | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined
      let lifetimeTimer: ReturnType<typeof setTimeout> | undefined

      const cleanup = (): void => {
        if (closed) return
        closed = true
        if (coalesceTimer !== undefined) clearTimeout(coalesceTimer)
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
        if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer)
        coalesceTimer = undefined
        idleTimer = undefined
        heartbeatTimer = undefined
        lifetimeTimer = undefined
        unsubscribe?.()
        unsubscribe = undefined
        try {
          controller.close()
        } catch {
          // 已经关闭/取消；无需再处理。
        }
      }
      cancelStream = cleanup

      const write = (text: string): boolean => {
        if (closed) return false
        try {
          controller.enqueue(encoder.encode(text))
          return true
        } catch {
          cleanup()
          return false
        }
      }

      const scheduleIdleClose = (): void => {
        if (!untilIdle || idleTimer !== undefined || closed) return
        idleTimer = setTimeout(cleanup, idleGraceMs)
        ;(idleTimer as { unref?: () => void }).unref?.()
      }

      const sendStatus = (): void => {
        if (closed) return
        let status: SyncStatus
        try {
          status = options.status()
        } catch {
          cleanup()
          return
        }
        write(`id: ${status.statusVersion}\nevent: status\ndata: ${JSON.stringify(status)}\n\n`)
        if (status.running || status.pending !== null) {
          if (idleTimer !== undefined) {
            clearTimeout(idleTimer)
            idleTimer = undefined
          }
        } else {
          scheduleIdleClose()
        }
      }

      const scheduleSend = (): void => {
        if (closed || coalesceTimer !== undefined) return
        coalesceTimer = setTimeout(() => {
          coalesceTimer = undefined
          sendStatus()
        }, coalesceMs)
      }

      request.signal.addEventListener('abort', cleanup, { once: true })
      if (request.signal.aborted) {
        cleanup()
        return
      }
      sendStatus()
      if (closed) return
      unsubscribe = options.subscribe(scheduleSend)
      heartbeatTimer = setInterval(() => { write(': ping\n\n') }, heartbeatMs)
      ;(heartbeatTimer as { unref?: () => void }).unref?.()
      lifetimeTimer = setTimeout(cleanup, maxLifetimeMs)
      ;(lifetimeTimer as { unref?: () => void }).unref?.()
    },
    cancel() {
      cancelStream?.()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
