/**
 * 拉取后刷新 DSH 的持久化投影缓存（`sessionProjectionCache`）。
 *
 * 冷会话在会话列表里的标题和 `sessionListMetadata`（`blank` 与最后一条
 * 用户消息时间，列表用它算 `updatedAt` 排序）都只来自这份缓存。插件通过
 * `sessionPersistence` 直接追加日志，不产生 `session/event`，DSH 自己的写后置
 * 检查点不会触发；所以每次拉取都要用完整日志补一次，否则列表会一直显示旧
 * 标题，排序也停在旧位置，看起来像没同步。
 *
 * 缓存是派生数据：失败只告警，绝不影响会话落地。
 * @module dsh-session-cloudsync/projection-warm
 */

/** `sessionProjectionCache` 的最小结构；宿主没加载该服务时整体跳过。 */
export interface ProjectionCacheLike {
  coldSnapshot(meta: unknown, inheritedEventCount: number, events: readonly unknown[]): unknown
  cachedSnapshot(meta: unknown, keys?: readonly string[]): { readonly asOfSeq?: unknown } | undefined
}

/** 一次预热要折叠的完整本地日志。 */
export interface ProjectionWarmInput {
  readonly sessionId: string
  /** 本地持久化的会话头；缓存用它校验生命周期身份。 */
  readonly header: unknown
  /** seeded 会话的继承前缀长度；非 seeded 为 0。 */
  readonly inheritedEventCount: number
  /** 完整有序日志（seq 从 0 开始）。 */
  readonly events: readonly unknown[]
  /** 日志末事件 seq；空日志为 -1。 */
  readonly lastSeq: number
}

/** 预热的可选参数。 */
export interface ProjectionWarmOptions {
  /** 等待缓存水位追上日志末端的上限，毫秒；缺省 2 秒。 */
  readonly timeoutMs?: number
  /** 等待时的轮询间隔，毫秒；缺省 10。 */
  readonly pollIntervalMs?: number
  readonly logger?: { warn(message: string): void }
}

const DEFAULT_TIMEOUT_MS = 2_000
const DEFAULT_POLL_INTERVAL_MS = 10

/**
 * 缓存是否落后于日志末端：没有可用记录、或水位低于 `lastSeq` 都算落后。
 *
 * scan 用它决定是否给已追平会话排一次补热；宿主没加载缓存服务时恒为 false。
 * @param cache - 宿主的投影缓存。
 * @param header - 会话头。
 * @param lastSeq - 本地日志末 seq。
 * @returns 是否需要重算缓存。
 */
export function projectionNeedsWarm(
  cache: ProjectionCacheLike | undefined,
  header: unknown,
  lastSeq: number,
): boolean {
  if (cache === undefined || typeof cache.coldSnapshot !== 'function') return false
  if (typeof cache.cachedSnapshot !== 'function') return false
  return watermarkOf(cache, header) < lastSeq
}

/**
 * 让缓存追上这次拉取的本地日志。
 *
 * 水位已经到 `lastSeq` 时直接返回，所以稳态下一轮拉取只多一次零 I/O 的比较；
 * 升级前拉过、缓存一直落后的会话会在第一次拉取时补热。
 * @param cache - 宿主的投影缓存；`undefined` 表示宿主没加载该服务。
 * @param input - 本次拉取的完整日志。
 * @param options - 超时、轮询间隔与日志。
 * @returns 是否重算了缓存（false 表示没有缓存服务或已经是最新）。
 */
export async function warmSessionProjection(
  cache: ProjectionCacheLike | undefined,
  input: ProjectionWarmInput,
  options: ProjectionWarmOptions = {},
): Promise<boolean> {
  if (!projectionNeedsWarm(cache, input.header, input.lastSeq)) return false
  if (cache === undefined) return false
  try {
    cache.coldSnapshot(input.header, input.inheritedEventCount, input.events)
  } catch (error: unknown) {
    warn(options, input.sessionId, `重算失败：${messageOf(error)}`)
    return false
  }
  // coldSnapshot 的写回是 fire-and-forget；等行水位到达日志末端，避免紧接着的
  // session/list 读到旧标题或旧排序时间。
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (watermarkOf(cache, input.header) < input.lastSeq) {
    if (Date.now() >= deadline) {
      warn(options, input.sessionId, `缓存写回在 ${timeoutMs}ms 内没有追上 seq ${input.lastSeq}`)
      return true
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
  return true
}

/**
 * 读缓存当前水位（它服务的最低行 seq）；没有可用记录时视为无穷低。
 * @param cache - 宿主的投影缓存。
 * @param header - 会话头。
 * @returns 水位；读不到时为 `-Infinity`。
 */
function watermarkOf(cache: ProjectionCacheLike, header: unknown): number {
  try {
    const seq = cache.cachedSnapshot(header)?.asOfSeq
    return typeof seq === 'number' ? seq : Number.NEGATIVE_INFINITY
  } catch {
    return Number.NEGATIVE_INFINITY
  }
}

/**
 * 记一条预热告警；宿主日志不是同步正确性的一部分。
 * @param options - 预热参数。
 * @param sessionId - 会话 id。
 * @param detail - 告警内容。
 */
function warn(options: ProjectionWarmOptions, sessionId: string, detail: string): void {
  options.logger?.warn(`dsh-session-cloudsync: 会话 ${sessionId} 预热投影缓存失败：${detail}`)
}

/**
 * 取错误消息。
 * @param error - 抛出的值。
 * @returns 可读消息。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
