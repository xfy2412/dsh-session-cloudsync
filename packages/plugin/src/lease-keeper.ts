/**
 * 设备独占租约：本地已经 live 的会话持续持有服务端 `session:<id>` 租约，
 * 其他设备的 append 会得到 409 `lease-held`，直到本进程主动释放或 TTL 过期。
 *
 * 租约只绑定当前 DSH 进程的 `clientId`；正常退出时释放，异常退出由服务端
 * TTL 兜底。cold 会话不持有租约，允许其他设备拉取/打开。
 *
 * @module dsh-session-cloudsync/lease-keeper
 */
import type { SyncLogger } from './engine.ts'
import type { SessionLeaseView } from './status.ts'

/** 续租需要读取的当前连接配置。 */
export interface LeaseKeeperConfiguration {
  /** 服务端基地址。 */
  readonly serverUrl: string
  /** 设备 token。 */
  readonly token: string
  /** 当前 DSH 进程的 clientInstanceId。 */
  readonly clientId: string
  /** 单次租约请求超时。 */
  readonly requestTimeoutMs?: number
}

/** LeaseKeeper 依赖。 */
export interface LeaseKeeperOptions {
  /** 当前 live 会话 id；cold 会话不返回。 */
  readonly listLiveSessionIds: () => readonly string[]
  /** 当前连接配置；未配置时返回 undefined。 */
  readonly configuration: () => LeaseKeeperConfiguration | undefined
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
 * 设备独占租约管理器。
 *
 * 周期扫描 live 会话并续租；push 的短租约通过 `releaseAfterWrite` 交给这里，
 * 保证不会误释放 presence lease。
 */
export class LeaseKeeper {
  private readonly options: LeaseKeeperOptions
  private readonly held = new Map<string, HeldLease>()
  private readonly views = new Map<string, SessionLeaseView>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private dirty = false
  private disposed = false
  private readonly renewIntervalMs: number
  private readonly renewBeforeMs: number

  /**
   * @param options - live 会话来源、连接配置、时钟与日志。
   */
  constructor(options: LeaseKeeperOptions) {
    this.options = options
    this.renewIntervalMs = Math.max(1000, options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS)
    this.renewBeforeMs = Math.max(0, options.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS)
  }

  /** 启动周期续租；立即执行一次。 */
  start(): void {
    if (this.disposed || this.timer !== undefined) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.renewIntervalMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /** 当前租约快照。 */
  snapshot(): readonly SessionLeaseView[] {
    return [...this.views.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  /**
   * 推送结束后调用。presence lease 由本管理器持有，不能被这次 push 释放；
   * 没有 presence lease 时释放本次 push 的短租约。
   * @param sessionId - 刚推送完的会话。
   */
  async releaseAfterWrite(sessionId: string): Promise<void> {
    if (this.disposed || this.held.has(sessionId)) return
    const config = this.configuration()
    if (config === undefined) return
    await this.release(config, sessionId)
  }

  /** 停止续租并尽量释放所有持有租约。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.releaseAllHeld()
  }

  /**
   * 执行一次扫描；测试可直接调用。
   * @returns 扫描完成。
   */
  async tick(): Promise<void> {
    if (this.disposed || this.ticking) return
    this.ticking = true
    try {
      const config = this.configuration()
      if (config === undefined) return
      const base = normalizeBase(config.serverUrl)
      if (base === '' || config.token.trim() === '' || config.clientId === '') return
      const live = this.liveSessionIds()
      const liveSet = new Set(live)
      const now = this.now()

      for (const [sessionId, lease] of [...this.held]) {
        if (!liveSet.has(sessionId) || lease.serverUrl !== base
          || lease.token !== config.token || lease.clientId !== config.clientId) {
          this.held.delete(sessionId)
          this.views.delete(sessionId)
          this.dirty = true
          await this.release({
            serverUrl: lease.serverUrl,
            token: lease.token,
            clientId: lease.clientId,
          }, sessionId)
        }
      }

      for (const sessionId of [...this.views.keys()]) {
        if (!liveSet.has(sessionId)) {
          this.views.delete(sessionId)
          this.dirty = true
        }
      }

      for (const sessionId of live) {
        const held = this.held.get(sessionId)
        const dueByClock = held !== undefined && now - held.lastRenewAt >= this.renewIntervalMs
        if (held !== undefined && held.leaseUntil - now > this.renewBeforeMs && !dueByClock) {
          this.setView(sessionId, {
            sessionId,
            state: 'held',
            leaseUntil: held.leaseUntil,
            lastRenewAt: held.lastRenewAt,
            ...held.ownerDeviceId === undefined ? {} : { ownerDeviceId: held.ownerDeviceId },
          })
          continue
        }
        await this.acquire(sessionId, base, config, now)
      }
    } finally {
      this.ticking = false
      if (this.dirty) {
        this.dirty = false
        this.options.onChange?.()
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private liveSessionIds(): string[] {
    try {
      return [...new Set(this.options.listLiveSessionIds().map((id) => String(id)).filter((id) => id !== ''))]
    } catch (error: unknown) {
      this.options.logger?.warn(`dsh-session-cloudsync: 读取 live 会话失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  private configuration(): LeaseKeeperConfiguration | undefined {
    try {
      return this.options.configuration()
    } catch (error: unknown) {
      this.options.logger?.warn(`dsh-session-cloudsync: 读取租约配置失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async acquire(
    sessionId: string,
    base: string,
    config: LeaseKeeperConfiguration,
    now: number,
  ): Promise<void> {
    const response = await this.requestLease('POST', base, config, sessionId)
    if (response.kind === 'ok') {
      const leaseUntil = response.leaseUntil ?? now + FALLBACK_LEASE_TTL_MS
      this.held.set(sessionId, {
        serverUrl: base,
        token: config.token,
        clientId: config.clientId,
        leaseUntil,
        lastRenewAt: now,
        ...response.ownerDeviceId === undefined ? {} : { ownerDeviceId: response.ownerDeviceId },
      })
      this.setView(sessionId, {
        sessionId,
        state: 'held',
        leaseUntil,
        lastRenewAt: now,
        ...response.ownerDeviceId === undefined ? {} : { ownerDeviceId: response.ownerDeviceId },
      })
      return
    }
    if (response.kind === 'foreign') {
      this.held.delete(sessionId)
      this.setView(sessionId, {
        sessionId,
        state: 'foreign',
        ...response.ownerDeviceId === undefined ? {} : { ownerDeviceId: response.ownerDeviceId },
        ...response.message === undefined ? {} : { error: response.message },
      })
      return
    }
    const existing = this.held.get(sessionId)
    this.setView(sessionId, {
      sessionId,
      state: 'lost',
      ...existing === undefined ? {} : { leaseUntil: existing.leaseUntil, lastRenewAt: existing.lastRenewAt },
      ...response.message === undefined ? {} : { error: response.message },
    })
    if (existing === undefined || existing.leaseUntil <= now) this.held.delete(sessionId)
  }

  private async requestLease(
    method: 'POST' | 'DELETE',
    base: string,
    config: LeaseKeeperConfiguration,
    sessionId: string,
  ): Promise<LeaseResponse> {
    const fetchImpl = this.options.fetch ?? fetch
    const timeout = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    try {
      const response = await fetchImpl(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/lease`, {
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

  private async release(config: LeaseKeeperConfiguration, sessionId: string): Promise<void> {
    await this.requestLease('DELETE', normalizeBase(config.serverUrl), config, sessionId)
  }

  /** 用各自记录的服务端配置释放全部持有租约。 */
  private async releaseAllHeld(): Promise<void> {
    const held = [...this.held.entries()]
    this.held.clear()
    this.views.clear()
    this.dirty = true
    await Promise.all(held.map(async ([sessionId, lease]) => {
      await this.release({
        serverUrl: lease.serverUrl,
        token: lease.token,
        clientId: lease.clientId,
      }, sessionId)
    }))
  }

  private setView(sessionId: string, view: SessionLeaseView): void {
    const previous = this.views.get(sessionId)
    const changed = previous === undefined
      || previous.state !== view.state
      || previous.leaseUntil !== view.leaseUntil
      || previous.ownerDeviceId !== view.ownerDeviceId
      || previous.lastRenewAt !== view.lastRenewAt
      || previous.error !== view.error
    if (!changed) return
    this.views.set(sessionId, view)
    this.dirty = true
    if (previous?.state !== view.state && (view.state === 'foreign' || view.state === 'lost')) {
      this.options.logger?.warn(`dsh-session-cloudsync: ${sessionId} 的租约状态变为 ${view.state}${view.error === undefined ? '' : `：${view.error}`}`)
    }
  }
}
