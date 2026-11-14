/**
 * 管理台的会话生命周期操作：存档、移除、重置、恢复。
 *
 * 与设备删除不同，这些动作走管理台 cookie，不需要设备租约；
 * 重置会清掉租约，让设备重新申请。
 *
 * @module @dsh-session-cloudsync/server/session-admin
 */
import { rmSync } from 'node:fs'
import { blobPath } from './blobs.ts'
import { bumpRevision, DEFAULT_DATASET, withTransaction, type ServerDb } from './db.ts'
import { SyncError } from '../../shared/src/wire.ts'
import { recordSessionEvent } from './session-history.ts'

/** 重置闸门的默认有效期。 */
export const SESSION_RESET_TTL_MS = 24 * 60 * 60 * 1000

interface TargetRow {
  readonly session_id: string
  readonly created_at: number
  readonly deleted_at: number | null
  readonly purged_at: number | null
  readonly stored_bytes: number
  readonly last_seq: number
  readonly manifest_json: string
}

/** 一次 purge 的结果。 */
export interface PurgeResult {
  readonly bytes: number
  readonly files: string[]
}

/**
 * 读目标生命周期。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param createdAt - 生命周期。
 * @returns 行或 undefined。
 */
function targetRow(db: ServerDb, sessionId: string, createdAt: number): TargetRow | undefined {
  return db.handle
    .prepare('SELECT session_id, created_at, deleted_at, purged_at, stored_bytes, last_seq, manifest_json FROM sessions WHERE dataset = ? AND session_id = ?')
    .get(DEFAULT_DATASET, sessionId) as TargetRow | undefined
}

/**
 * 校验目标行与 createdAt。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param createdAt - 生命周期。
 * @returns 目标行。
 * @throws 不存在、生命周期不符时抛出。
 */
function requireTarget(db: ServerDb, sessionId: string, createdAt: number): TargetRow {
  const row = targetRow(db, sessionId, createdAt)
  if (row === undefined) throw new SyncError('not-found', `没有会话 ${sessionId}`)
  if (row.created_at !== createdAt) throw new SyncError('conflict', 'createdAt 与当前生命周期不符')
  return row
}

/**
 * 收集一份 manifest 引用的全部 blob：封帧、附件索引与附件密文。
 * @param manifest - 已解析的 manifest 形状。
 * @returns blob 地址列表（可能重复）。
 */
function manifestBlobRefs(manifest: { frames?: unknown }): string[] {
  const frames = Array.isArray(manifest.frames) ? manifest.frames : []
  const hashes: string[] = []
  for (const frame of frames) {
    if (frame === null || typeof frame !== 'object') continue
    const record = frame as { blobSha256?: unknown; attachmentIndexSha256?: unknown; attachmentBlobs?: unknown }
    if (typeof record.blobSha256 === 'string' && record.blobSha256 !== '') hashes.push(record.blobSha256)
    if (typeof record.attachmentIndexSha256 === 'string' && record.attachmentIndexSha256 !== '') {
      hashes.push(record.attachmentIndexSha256)
    }
    if (Array.isArray(record.attachmentBlobs)) {
      for (const sha of record.attachmentBlobs) {
        if (typeof sha === 'string' && sha !== '') hashes.push(sha)
      }
    }
  }
  return hashes
}

/**
 * 删除一个会话独占的 blob（封帧、附件索引、附件密文）；被其它会话或 Vault 引用的保留。
 * @param db - 已打开的数据库。
 * @param dataDir - 数据目录。
 * @param sessionId - 目标会话。
 * @param manifestJson - 目标 manifest。
 * @returns 删除的字节数与文件路径。
 */
function purgeSessionBlobs(db: ServerDb, dataDir: string, sessionId: string, manifestJson: string): PurgeResult {
  let hashes: string[]
  try {
    hashes = manifestBlobRefs(JSON.parse(manifestJson) as { frames?: unknown })
  } catch {
    throw new SyncError('conflict', '会话 manifest 损坏，拒绝清理')
  }
  const unique = [...new Set(hashes)]
  if (unique.length === 0) return { bytes: 0, files: [] }

  const otherHashes = new Set<string>()
  const otherRows = db.handle
    .prepare('SELECT manifest_json FROM sessions WHERE dataset = ? AND session_id <> ?')
    .all(DEFAULT_DATASET, sessionId) as unknown as Array<{ manifest_json: string }>
  for (const row of otherRows) {
    try {
      for (const hash of manifestBlobRefs(JSON.parse(row.manifest_json) as { frames?: unknown })) otherHashes.add(hash)
    } catch {
      // 损坏的其它 manifest 只能保守处理：不据此删除任何 blob。
      for (const hash of unique) otherHashes.add(hash)
    }
  }

  const vaultCheck = db.handle.prepare('SELECT 1 FROM vault_records WHERE blob_sha256 = ? LIMIT 1')
  const deleteBlob = db.handle.prepare('DELETE FROM blobs WHERE sha256 = ?')
  const blobInfo = db.handle.prepare('SELECT bytes FROM blobs WHERE sha256 = ?')
  let bytes = 0
  const files: string[] = []
  for (const hash of unique) {
    if (otherHashes.has(hash) || vaultCheck.get(hash) !== undefined) continue
    const record = blobInfo.get(hash) as { bytes?: number } | undefined
    if (record === undefined) continue
    deleteBlob.run(hash)
    bytes += Number(record.bytes ?? 0)
    files.push(blobPath(dataDir, hash))
  }
  return { bytes, files }
}

/**
 * 删除 purge 收集到的文件；文件删除失败不影响数据库状态。
 * @param files - 文件路径。
 */
function removeFiles(files: readonly string[]): void {
  for (const file of files) {
    try {
      rmSync(file, { force: true })
    } catch {
      // 文件可能已被并发清理；数据库行已删除，留作孤儿不影响正确性。
    }
  }
}

/**
 * 存档：墓碑 + 保留数据。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param createdAt - 生命周期。
 * @param now - 当前时间。
 */
export function archiveSession(db: ServerDb, sessionId: string, createdAt: number, now = Date.now()): void {
  withTransaction(db, () => {
    const row = requireTarget(db, sessionId, createdAt)
    if (row.deleted_at !== null) throw new SyncError('conflict', '会话已经删除/存档')
    const revision = bumpRevision(db)
    db.handle.prepare('UPDATE sessions SET deleted_at = ?, revision = ?, updated_at = ? WHERE dataset = ? AND session_id = ?')
      .run(now, revision, now, DEFAULT_DATASET, sessionId)
    db.handle.prepare(`INSERT OR REPLACE INTO tombstones (dataset, session_id, created_at, deleted_at, deleted_by)
                       VALUES (?, ?, ?, ?, ?)`)
      .run(DEFAULT_DATASET, sessionId, createdAt, now, 'admin:archive')
    db.handle.prepare('DELETE FROM append_requests WHERE dataset = ? AND session_id = ?').run(DEFAULT_DATASET, sessionId)
    recordSessionEvent(db, {
      sessionId, at: now, kind: 'archive', actorKind: 'admin', actorId: 'admin',
      lastSeq: row.last_seq ?? null, storedBytes: row.stored_bytes ?? null, detail: { createdAt },
    })
  })
}

/**
 * 移除：墓碑 + 清理帧/blob，保留历史计数。
 * @param db - 已打开的数据库。
 * @param dataDir - 数据目录。
 * @param sessionId - 会话 id。
 * @param createdAt - 生命周期。
 * @param now - 当前时间。
 * @returns 删除的字节数。
 */
export function removeSession(db: ServerDb, dataDir: string, sessionId: string, createdAt: number, now = Date.now()): number {
  let purged: PurgeResult | undefined
  withTransaction(db, () => {
    const row = requireTarget(db, sessionId, createdAt)
    if (row.purged_at !== null) throw new SyncError('conflict', '会话已经移除并释放过空间')
    purged = purgeSessionBlobs(db, dataDir, sessionId, row.manifest_json)
    const revision = bumpRevision(db)
    let manifest: Record<string, unknown> = {}
    try {
      manifest = JSON.parse(row.manifest_json) as Record<string, unknown>
    } catch {
      manifest = {}
    }
    manifest.frames = []
    db.handle.prepare(`UPDATE sessions
                       SET deleted_at = COALESCE(deleted_at, ?), purged_at = ?, revision = ?, updated_at = ?,
                           stored_bytes = 0, manifest_json = ?
                       WHERE dataset = ? AND session_id = ?`)
      .run(now, now, revision, now, JSON.stringify(manifest), DEFAULT_DATASET, sessionId)
    db.handle.prepare(`INSERT OR REPLACE INTO tombstones (dataset, session_id, created_at, deleted_at, deleted_by)
                       VALUES (?, ?, ?, ?, ?)`)
      .run(DEFAULT_DATASET, sessionId, createdAt, now, 'admin:remove')
    db.handle.prepare('DELETE FROM append_requests WHERE dataset = ? AND session_id = ?').run(DEFAULT_DATASET, sessionId)
    recordSessionEvent(db, {
      sessionId, at: now, kind: 'remove', actorKind: 'admin', actorId: 'admin',
      bytes: purged?.bytes ?? 0, lastSeq: null, storedBytes: 0,
      detail: { createdAt, purgedBytes: purged?.bytes ?? 0 },
    })
  })
  const result = purged ?? { bytes: 0, files: [] }
  removeFiles(result.files)
  return result.bytes
}

/**
 * 重置：清数据与墓碑，允许指定设备重建。
 * @param db - 已打开的数据库。
 * @param dataDir - 数据目录。
 * @param sessionId - 会话 id。
 * @param createdAt - 生命周期。
 * @param deviceId - 指定重建设备；null 表示先到先得。
 * @param now - 当前时间。
 * @returns 删除的字节数。
 */
export function resetSession(
  db: ServerDb,
  dataDir: string,
  sessionId: string,
  createdAt: number,
  deviceId: string | null,
  now = Date.now(),
): number {
  let purged: PurgeResult | undefined
  withTransaction(db, () => {
    const row = requireTarget(db, sessionId, createdAt)
    purged = purgeSessionBlobs(db, dataDir, sessionId, row.manifest_json)
    db.handle.prepare('DELETE FROM append_requests WHERE dataset = ? AND session_id = ?').run(DEFAULT_DATASET, sessionId)
    db.handle.prepare('DELETE FROM tombstones WHERE dataset = ? AND session_id = ?').run(DEFAULT_DATASET, sessionId)
    db.handle.prepare('DELETE FROM sessions WHERE dataset = ? AND session_id = ?').run(DEFAULT_DATASET, sessionId)
    db.handle.prepare('DELETE FROM leases WHERE dataset = ? AND resource = ?').run(DEFAULT_DATASET, 'sync')
    let workspaceKey: string | null = null
    try {
      const manifest = JSON.parse(row.manifest_json) as { workspaceKey?: unknown }
      if (typeof manifest.workspaceKey === 'string' && manifest.workspaceKey !== '') workspaceKey = manifest.workspaceKey
    } catch {
      workspaceKey = null
    }
    db.handle.prepare(`INSERT OR REPLACE INTO session_resets
                       (dataset, session_id, created_at, reset_at, expires_at, device_id, workspace_key)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(DEFAULT_DATASET, sessionId, createdAt, now, now + SESSION_RESET_TTL_MS, deviceId, workspaceKey)
    recordSessionEvent(db, {
      sessionId, at: now, kind: 'reset', actorKind: 'admin', actorId: 'admin',
      bytes: purged?.bytes ?? 0, detail: { createdAt, deviceId, purgedBytes: purged?.bytes ?? 0 },
    })
  })
  const result = purged ?? { bytes: 0, files: [] }
  removeFiles(result.files)
  return result.bytes
}

/**
 * 恢复存档：清墓碑、重新参与同步。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param createdAt - 生命周期。
 * @param now - 当前时间。
 */
export function restoreSession(db: ServerDb, sessionId: string, createdAt: number, now = Date.now()): void {
  withTransaction(db, () => {
    const row = requireTarget(db, sessionId, createdAt)
    if (row.deleted_at === null) throw new SyncError('conflict', '会话没有存档')
    if (row.purged_at !== null) throw new SyncError('conflict', '会话已经释放空间，不能恢复')
    const revision = bumpRevision(db)
    db.handle.prepare('UPDATE sessions SET deleted_at = NULL, revision = ?, updated_at = ? WHERE dataset = ? AND session_id = ?')
      .run(revision, now, DEFAULT_DATASET, sessionId)
    db.handle.prepare('DELETE FROM tombstones WHERE dataset = ? AND session_id = ? AND created_at = ?')
      .run(DEFAULT_DATASET, sessionId, createdAt)
    recordSessionEvent(db, {
      sessionId, at: now, kind: 'restore', actorKind: 'admin', actorId: 'admin',
      lastSeq: null, storedBytes: row.stored_bytes ?? null, detail: { createdAt },
    })
  })
}
