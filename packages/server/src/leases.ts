/**
 * 通用资源写租约：会话 append 与 Vault writer 共用同一张表。
 *
 * owner 是 `(deviceId, clientInstanceId)`；同一 device token 的两个 DSH 进程
 * 会有不同 clientId，因此第二个进程会被 409 拒绝，而不是靠 append 冲突兜底。
 *
 * @module @dsh-session-cloudsync/server/leases
 */
import { SyncError } from '../../shared/src/wire.ts'
import { DEFAULT_DATASET, withTransaction, type ServerDb } from './db.ts'

/** 租约有效期。 */
export const LEASE_TTL_MS = 60_000

/** 租约状态。 */
export interface LeaseState {
  /** 资源名，例如 `session:<id>`。 */
  readonly resource: string
  /** 设备 id。 */
  readonly deviceId: string
  /** 客户端实例 id。 */
  readonly clientId: string
  /** 到期时间（epoch ms）。 */
  readonly leaseUntil: number
  /** 本次是否新取得/续租成功。 */
  readonly acquired: boolean
}

interface LeaseRow {
  readonly device_id: string
  readonly client_id: string
  readonly lease_until: number
}

/** 会话资源名。 */
export function sessionResource(sessionId: string): string {
  return `session:${sessionId}`
}

/** Vault writer 资源名。 */
export function vaultResource(writer: string): string {
  return `vault-writer:${writer}`
}

/**
 * 申请或续租一个资源。
 * @param db - 已打开的数据库。
 * @param resource - 资源名。
 * @param deviceId - token 派生的设备 id。
 * @param clientId - 当前 DSH 进程的 clientInstanceId。
 * @param now - 当前时间。
 * @returns 租约状态。
 * @throws 被另一个 owner 持有时抛出 `lease-held`。
 */
export function acquireLease(
  db: ServerDb,
  resource: string,
  deviceId: string,
  clientId: string,
  now = Date.now(),
): LeaseState {
  if (clientId === '') throw new SyncError('bad-request', '缺少 clientInstanceId')
  return withTransaction(db, () => {
    const row = db.handle
      .prepare('SELECT device_id, client_id, lease_until FROM leases WHERE dataset = ? AND resource = ?')
      .get(DEFAULT_DATASET, resource) as LeaseRow | undefined
    if (row !== undefined && (row.device_id !== deviceId || row.client_id !== clientId) && row.lease_until > now) {
      throw new SyncError('lease-held', `${resource} 的租约由 ${row.device_id}/${row.client_id} 持有至 ${row.lease_until}`)
    }
    const leaseUntil = now + LEASE_TTL_MS
    db.handle
      .prepare(`INSERT INTO leases (dataset, resource, device_id, client_id, lease_until)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(dataset, resource) DO UPDATE SET
                  device_id = excluded.device_id, client_id = excluded.client_id, lease_until = excluded.lease_until`)
      .run(DEFAULT_DATASET, resource, deviceId, clientId, leaseUntil)
    return {
      resource,
      deviceId,
      clientId,
      leaseUntil,
      acquired: row === undefined || row.device_id !== deviceId || row.client_id !== clientId || row.lease_until <= now,
    }
  })
}

/**
 * 要求当前 owner 持有未过期租约。
 * @param db - 已打开的数据库。
 * @param resource - 资源名。
 * @param deviceId - 设备 id。
 * @param clientId - 客户端实例 id。
 * @param now - 当前时间。
 * @throws 缺失、owner 不符或过期时抛出 `lease-held`。
 */
export function requireLease(
  db: ServerDb,
  resource: string,
  deviceId: string,
  clientId: string,
  now = Date.now(),
): LeaseRow {
  if (clientId === '') throw new SyncError('bad-request', '缺少 clientInstanceId')
  const row = db.handle
    .prepare('SELECT device_id, client_id, lease_until FROM leases WHERE dataset = ? AND resource = ?')
    .get(DEFAULT_DATASET, resource) as LeaseRow | undefined
  if (row === undefined || row.device_id !== deviceId || row.client_id !== clientId || row.lease_until <= now) {
    throw new SyncError('lease-held', `${resource} 的租约未由当前设备/客户端持有或已过期`)
  }
  return row
}

/**
 * 释放当前 owner 的租约。
 * @param db - 已打开的数据库。
 * @param resource - 资源名。
 * @param deviceId - 设备 id。
 * @param clientId - 客户端实例 id。
 * @returns 是否真的删除了一行。
 */
export function releaseLease(db: ServerDb, resource: string, deviceId: string, clientId: string): boolean {
  const result = db.handle
    .prepare('DELETE FROM leases WHERE dataset = ? AND resource = ? AND device_id = ? AND client_id = ?')
    .run(DEFAULT_DATASET, resource, deviceId, clientId)
  return Number(result.changes) > 0
}
