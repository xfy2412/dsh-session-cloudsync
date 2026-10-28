/**
 * 全局单写者租约：一台设备/一个 DSH 进程持有服务端 `sync` 租约才能上传；
 * 拉取不需要租约。租约在进程存活期间持续续租，正常退出时主动释放，异常退出
 * 由服务端 TTL 兜底。
 *
 * @module dsh-session-cloudsync/device-lease
 */
import type { SyncLogger } from './engine.ts'
import type { DeviceLeaseView } from './status.ts'

/** 续租需要读取的当前连接配置。 */
export interface DeviceLeaseConfiguration {
  /** 服务端基地址。 */
  readonly serverUrl: string
  /** 设备 token。 */
  readonly token: string
  /** 当前 DSH 进程的 clientInstanceId。 */
  readonly clientId: string
  /** 单次租约请求超时。 */
  readonly requestTimeoutMs?: number
}

/** DeviceLeaseKeeper 依赖。 */
export interface DeviceLeaseKeeperOptions {
  /** 当前连接配置；未配置时返回 undefined。 */
  readonly configuration: () => DeviceLeaseConfiguration | undefined
  /** 日志。 */
  readonly logger?: SyncLogger
  /** 测试可替换的 fetch。 */
  readonly fetch?: typeof fetch
  /** 测试可替换的时钟。 */
  readonly now?: () => number
  /** 续租扫描间隔；必须小于服务端 TTL。默认 20s。 */
  readonly renewIntervalMs?: number
  /** 剩余租期低于该值时续租。默认 30s。 */
  readonly renewBeforeMs?: number
  /** 租约视图变化时通知（供 SSE/状态版本使用）。 */
  readonly onChange?: () => void
}

/** 一条由本进程持有的租约。 */
interface HeldLease {
  readonly serverUrl: string
  readonly token: string
  readonly clientId: string
  readonly leaseUntil: number
  readonly lastRenewAt: number
  readonly ownerDeviceId?: string
}

/** 服务端 lease 响应。 */
interface LeaseResponse {
  readonly kind: 'ok' | 'foreign' | 'error'
  readonly leaseUntil?: number
  readonly ownerDeviceId?: string
  readonly message?: string
}

/** 默认续租间隔。 */
const DEFAULT_RENEW_INTERVAL_MS = 20_000
/** 默认提前续租阈值。 */
const DEFAULT_RENEW_BEFORE_MS = 30_000
/** 默认请求超时。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/** 服务端固定 TTL 的保守兜底；正常响应会覆盖它。 */
const FALLBACK_LEASE_TTL_MS = 60_000

/**
 * 归一化服务端地址，避免尾斜杠造成同一服务端被当成两个配置。
 * @param value - 原始地址。
 * @returns 去掉尾斜杠的地址。
 */
function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/u, '')
}

/**
 * 从响应体里取错误信息。
 * @param body - JSON 响应体。
 * @returns 错误码与消息。
 */
function errorOf(body: unknown): { code?: string; message: string } {
  if (body === null || typeof body !== 'object') return { message: '服务端返回了非 JSON 错误' }
  const error = (body as Record<string, unknown>)['error']
  if (error === null || typeof error !== 'object') return { message: '服务端返回了未知错误' }
  const record = error as Record<string, unknown>
  return {
    ...typeof record['code'] === 'string' ? { code: record['code'] } : {},
    message: typeof record['message'] === 'string' ? record['message'] : '服务端返回了未知错误',
  }
}

/**
 * 维护全局 `sync` 租约；没有 held 时宿主只拉取、不上传。
 */
export class DeviceLeaseKeeper {
  private readonly options: DeviceLeaseKeeperOptions
  private readonly renewIntervalMs: number
  private readonly renewBeforeMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private inflight: Promise<boolean> | undefined
  private dirty = false
  private disposed = false
  private held: HeldLease | undefined
  private view: DeviceLeaseView = { state: 'unconfigured' }

  /**
   * @param options - 连接配置、时钟与日志。
   */
  constructor(options: DeviceLeaseKeeperOptions) {
    this.options = options
    this.renewIntervalMs = Math.max(1000, options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS)
    this.renewBeforeMs = Math.max(0, options.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS)
  }

  /** 启动租约扫描；立即申请一次。 */
  start(): void {
    if (this.disposed || this.timer !== undefined) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.renewIntervalMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /** 当前租约视图。 */
  snapshot(): DeviceLeaseView {
    return this.view
  }

  /**
   * 主动确保本机持有租约；手动同步/推送前调用。
   * @returns 是否已持有。
   */
  async ensure(): Promise<boolean> {
    await this.tick()
    return this.view.state === 'held'
  }

  /**
   * 执行一次申请/续租扫描。
   * @returns 当前是否持有。
   */
  async tick(): Promise<boolean> {
    if (this.disposed) return false
    if (this.ticking) return await (this.inflight ?? Promise.resolve(false))
    this.ticking = true
    this.inflight = this.runTick().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.options.logger?.warn(`dsh-session-cloudsync: 全局租约扫描失败：${message}`)
      this.setView({ state: 'lost', error: message })
      return false
    }).then((held) => {
      if (this.dirty) {
        this.dirty = false
        this.options.onChange?.()
      }
      return held
    }).finally(() => {
      this.ticking = false
      this.inflight = undefined
    })
    return await this.inflight
  }

  /** 停止续租并尽量释放。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    const held = this.held
    this.held = undefined
    if (held !== undefined) await this.release(held)
  }

  private async runTick(): Promise<boolean> {
    const config = this.configuration()
    if (config === undefined) {
      const previous = this.held
      this.held = undefined
      if (previous !== undefined) await this.release(previous)
      this.setView({ state: 'unconfigured' })
      return false
    }
    const base = normalizeBase(config.serverUrl)
    if (base === '' || config.token.trim() === '' || config.clientId === '') {
      this.setView({ state: 'lost', error: '服务端地址/token/clientId 未配置全' })
      return false
    }
    const now = this.now()
    const current = this.held
    if (current !== undefined
      && current.serverUrl === base
      && current.token === config.token
      && current.clientId === config.clientId) {
      if (now < current.leaseUntil - this.renewBeforeMs) {
        this.setHeldView(current)
        return true
      }
      return await this.acquire(base, config, now)
    }
    if (current !== undefined) await this.release(current)
    this.held = undefined
    return await this.acquire(base, config, now)
  }

  private async acquire(base: string, config: DeviceLeaseConfiguration, now: number): Promise<boolean> {
    const response = await this.requestLease('POST', base, config)
    if (response.kind === 'ok') {
      const leaseUntil = response.leaseUntil ?? now + FALLBACK_LEASE_TTL_MS
      const held: HeldLease = {
        serverUrl: base,
        token: config.token,
        clientId: config.clientId,
        leaseUntil,
        lastRenewAt: now,
        ...response.ownerDeviceId === undefined ? {} : { ownerDeviceId: response.ownerDeviceId },
      }
      this.held = held
      this.setHeldView(held)
      return true
    }
    if (response.kind === 'foreign') {
      this.held = undefined
      this.setView({
        state: 'foreign',
        ...response.ownerDeviceId === undefined ? {} : { ownerDeviceId: response.ownerDeviceId },
        ...response.message === undefined ? {} : { error: response.message },
      })
      return false
    }
    const existing = this.held
    this.setView({
      state: 'lost',
      ...existing === undefined ? {} : {
        leaseUntil: existing.leaseUntil,
        lastRenewAt: existing.lastRenewAt,
      },
      ...response.message === undefined ? {} : { error: response.message },
    })
    return false
  }

  private setHeldView(held: HeldLease): void {
    this.setView({
      state: 'held',
      leaseUntil: held.leaseUntil,
      lastRenewAt: held.lastRenewAt,
      ...held.ownerDeviceId === undefined ? {} : { ownerDeviceId: held.ownerDeviceId },
    })
  }

  private setView(view: DeviceLeaseView): void {
    const previous = this.view
    const changed = previous.state !== view.state
      || previous.leaseUntil !== view.leaseUntil
      || previous.ownerDeviceId !== view.ownerDeviceId
      || previous.lastRenewAt !== view.lastRenewAt
      || previous.error !== view.error
    if (!changed) return
    this.view = view
    this.dirty = true
    if (previous.state !== view.state && (view.state === 'foreign' || view.state === 'lost')) {
      this.options.logger?.warn(`dsh-session-cloudsync: 全局同步租约变为 ${view.state}${view.error === undefined ? '' : `：${view.error}`}`)
    }
  }

  private async release(held: HeldLease): Promise<void> {
    await this.requestLease('DELETE', held.serverUrl, {
      serverUrl: held.serverUrl,
      token: held.token,
      clientId: held.clientId,
    })
  }

  private async requestLease(
    method: 'POST' | 'DELETE',
    base: string,
    config: DeviceLeaseConfiguration,
  ): Promise<LeaseResponse> {
    const fetchImpl = this.options.fetch ?? fetch
    const timeout = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    try {
      const response = await fetchImpl(`${base}/v2/sync/lease`, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          'x-client-id': config.clientId,
        },
        signal: AbortSignal.timeout(timeout),
      })
      const text = await response.text()
      let body: unknown
      try {
        body = text === '' ? undefined : JSON.parse(text) as unknown
      } catch {
        body = undefined
      }
      if (response.status === 200) {
        const value = body !== null && typeof body === 'object'
          ? (body as Record<string, unknown>)['value']
          : undefined
        const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
        return {
          kind: 'ok',
          ...typeof record['leaseUntil'] === 'number' ? { leaseUntil: record['leaseUntil'] } : {},
          ...typeof record['deviceId'] === 'string' ? { ownerDeviceId: record['deviceId'] } : {},
        }
      }
      const error = errorOf(body)
      if (response.status === 409 && error.code === 'lease-held') {
        return { kind: 'foreign', message: error.message }
      }
      return { kind: 'error', message: error.message }
    } catch (error: unknown) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  private configuration(): DeviceLeaseConfiguration | undefined {
    try {
      return this.options.configuration()
    } catch (error: unknown) {
      this.options.logger?.warn(`dsh-session-cloudsync: 读取租约配置失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
