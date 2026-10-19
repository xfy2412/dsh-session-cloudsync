/**
 * 线上错误的统一形状：机器可读分类 → HTTP 状态。
 *
 * 服务端与插件共用这张表，避免"同一个错误在两边映射成不同状态码"。
 *
 * @module @dsh-session-sync/shared/wire
 */
import type { SyncErrorCode } from './protocol.ts'

/** 错误码到 HTTP 状态的唯一映射。 */
export const ERROR_STATUS: Readonly<Record<SyncErrorCode, number>> = {
  unauthorized: 401,
  'bad-request': 400,
  'not-found': 404,
  conflict: 409,
  diverged: 409,
  'lease-held': 409,
  gone: 410,
  quota: 507,
}

/**
 * 取错误码对应的 HTTP 状态。
 * @param code - 错误分类。
 * @returns HTTP 状态码。
 */
export function statusOf(code: SyncErrorCode): number {
  return ERROR_STATUS[code]
}

/** 带分类的协议错误；服务端把它映射成状态码，插件据分类决定重试/提示。 */
export class SyncError extends Error {
  readonly code: SyncErrorCode

  /**
   * @param code - 错误分类。
   * @param message - 人能读懂的说明。
   */
  constructor(code: SyncErrorCode, message: string) {
    super(message)
    this.name = 'SyncError'
    this.code = code
  }
}
