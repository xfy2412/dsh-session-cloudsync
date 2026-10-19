/**
 * 插件与服务端共享的线上类型。
 *
 * 服务端只存不透明密文；这里的类型全是元数据：id、大小、序号区间、
 * 租约状态与墓碑。
 *
 * @module @dsh-session-sync/shared/protocol
 */

/** 所有 API 路由的前缀。 */
export const API_PREFIX = '/v1'

/** 当前协议版本；端点契约变化时递增。 */
export const PROTOCOL_VERSION = 1

/** 健康探针的成功响应。 */
export interface HealthResponse {
  readonly ok: true
  readonly version: string
  readonly protocol: number
  readonly now: number
}

/** 服务端列出的设备（不含密钥本身）。 */
export interface DeviceRef {
  readonly deviceId: string
  readonly label: string
  readonly createdAt: number
  readonly lastSeenAt?: number
}

/** 会话日志链上的一帧（不可变）。 */
export type { SealedFrameRef } from './sealed-frame.ts'

/** 服务端保存的单个会话元数据。 */
export interface SessionManifest {
  readonly sessionId: string
  /** 日志写入时的 DSH 会话格式代际。 */
  readonly formatVersion: number
  /** 会话创建时间（用于区分同 id 的不同生命周期）。 */
  readonly createdAt: number
  /** 写入帧链的最高事件序号；只有 header 帧时为 -1。 */
  readonly lastSeq: number
  readonly frames: readonly import('./sealed-frame.ts').SealedFrameRef[]
  readonly updatedAt: number
  /** 软删除时存在。 */
  readonly deletedAt?: number
}

/** 单个会话的租约状态。 */
export interface Lease {
  readonly sessionId: string
  readonly deviceId: string
  readonly leaseUntil: number
}

/** 客户端必须能区分的错误码。 */
export type SyncErrorCode =
  | 'unauthorized'
  | 'bad-request'
  | 'not-found'
  | 'conflict'
  | 'diverged'
  | 'lease-held'
  | 'gone'
  | 'quota'
  | 'rate-limited'

/** 统一的失败响应体。 */
export interface SyncErrorBody {
  readonly ok: false
  readonly error: { readonly code: SyncErrorCode; readonly message: string }
}

/**
 * 构造失败响应体。
 * @param code - 机器可读的分类。
 * @param message - 人能读懂的说明。
 * @returns 响应体。
 */
export function errorBody(code: SyncErrorCode, message: string): SyncErrorBody {
  return { ok: false, error: { code, message } }
}
