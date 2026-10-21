/**
 * 会话同步的服务端逻辑：租约、append、墓碑与 cursor。
 *
 * 所有写操作都在 `BEGIN IMMEDIATE` 事务里完成；append 只校验元数据与 blob
 * 存在性，不解析密文内容。链的完整性由客户端负责，服务端只保证"前缀延续"。
 *
 * @module @dsh-session-cloudsync/server/sessions
 */
import { existsSync } from 'node:fs'
import { assertChain, buildManifest, manifestDigest } from '../../shared/src/chain.ts'
import type { ChainFrame } from '../../shared/src/chain.ts'
import type { SessionManifest } from '../../shared/src/protocol.ts'
import type { SealedFrameRef } from '../../shared/src/sealed-frame.ts'
import { SyncError } from '../../shared/src/wire.ts'
import { blobPath } from './blobs.ts'
import { DEFAULT_DATASET, bumpRevision, readRevision, withTransaction, type ServerDb } from './db.ts'

/** 租约有效期。 */
export const LEASE_TTL_MS = 60_000

/** 单个 append 请求体上限（万帧会话首次同步约 1.5 MB）。 */
export const MAX_APPEND_BODY_BYTES = 8 * 1024 * 1024

interface SessionRow {
  readonly created_at: number
  readonly format_version: number
  readonly last_seq: number
  readonly frame_count: number
  readonly head_chain_hash: string
  readonly manifest_json: string
  readonly manifest_digest: string
  readonly revision: number
  readonly updated_at: number
  readonly deleted_at: number | null
}

interface LeaseRow {
  readonly device_id: string
  readonly lease_until: number
}

/** 租约状态。 */
export interface LeaseState {
  readonly sessionId: string
  readonly deviceId: string
  readonly leaseUntil: number
  readonly acquired: boolean
}

/** append 的入参。 */
export interface AppendInput {
  readonly sessionId: string
  readonly deviceId: string
  readonly baseIndex: number
  readonly baseChainHash: string | null
  readonly createdAt: number
  readonly formatVersion: number
  readonly frames: readonly SealedFrameRef[]
  readonly tailOpen?: boolean
  readonly safeThroughSeq?: number
}

/** append / delete 之后返回的会话摘要。 */
export interface SessionSummary {
  readonly sessionId: string
  readonly revision: number
  readonly frameCount: number
  readonly headChainHash: string
  readonly manifestDigest: string
  readonly lastSeq: number
  readonly updatedAt: number
  readonly deletedAt: number | null
}

const HASH = /^[0-9a-f]{64}$/u
const KEY_ID = /^[0-9a-f]{16}$/u

/**
 * 校验一个封帧条目。
 * @param frame - 待检查的条目。
 * @param expectedIndex - 期望的下标。
 * @throws 字段非法时抛出 `bad-request`。
 */
function assertRef(frame: SealedFrameRef, expectedIndex: number): void {
  if (frame.index !== expectedIndex) throw new SyncError('bad-request', `帧下标应为 ${expectedIndex}，实际是 ${frame.index}`)
  if (!HASH.test(frame.chainHash) || !HASH.test(frame.blobSha256)) throw new SyncError('bad-request', `帧 ${expectedIndex} 的哈希非法`)
  if (!KEY_ID.test(frame.keyId)) throw new SyncError('bad-request', `帧 ${expectedIndex} 的 keyId 非法`)
  if (!Number.isSafeInteger(frame.bytes) || frame.bytes <= 0) throw new SyncError('bad-request', `帧 ${expectedIndex} 的字节数非法`)
  if (!Number.isSafeInteger(frame.sealedVersion) || frame.sealedVersion < 1) throw new SyncError('bad-request', `帧 ${expectedIndex} 的封帧版本非法`)
  if (!Number.isSafeInteger(frame.seqFrom) || !Number.isSafeInteger(frame.seqTo)) throw new SyncError('bad-request', `帧 ${expectedIndex} 的 seq 非法`)
}

/**
 * 把封帧条目映射成链比较用的最小身份。
 * @param frames - 封帧条目。
 * @returns 链帧数组。
 */
function toChain(frames: readonly SealedFrameRef[]): ChainFrame[] {
  return frames.map((frame) => ({ index: frame.index, chainHash: frame.chainHash, seqFrom: frame.seqFrom, seqTo: frame.seqTo }))
}

/**
 * 读取会话行。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @returns 行或 undefined。
 */
function sessionRow(db: ServerDb, sessionId: string): SessionRow | undefined {
  return db.handle
    .prepare('SELECT created_at, format_version, last_seq, frame_count, head_chain_hash, manifest_json, manifest_digest, revision, updated_at, deleted_at FROM sessions WHERE dataset = ? AND session_id = ?')
    .get(DEFAULT_DATASET, sessionId) as SessionRow | undefined
}

/**
 * 要求调用者持有有效租约。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param deviceId - 调用设备。
 * @param now - 当前时间。
 * @throws 租约不存在、被他人持有或已过期时抛出 `lease-held`。
 */
function requireLease(db: ServerDb, sessionId: string, deviceId: string, now: number): LeaseRow {
  const row = db.handle
    .prepare('SELECT device_id, lease_until FROM leases WHERE dataset = ? AND session_id = ?')
    .get(DEFAULT_DATASET, sessionId) as LeaseRow | undefined
  if (row === undefined || row.device_id !== deviceId || row.lease_until <= now) {
    throw new SyncError('lease-held', `会话 ${sessionId} 的租约未由当前设备持有或已过期`)
  }
  return row
}

/**
 * 申请或续租。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param deviceId - 调用设备。
 * @param now - 当前时间。
 * @returns 租约状态。
 * @throws 被其他设备持有时抛出 `lease-held`。
 */
export function acquireLease(db: ServerDb, sessionId: string, deviceId: string, now = Date.now()): LeaseState {
  return withTransaction(db, () => {
    const row = db.handle
      .prepare('SELECT device_id, lease_until FROM leases WHERE dataset = ? AND session_id = ?')
      .get(DEFAULT_DATASET, sessionId) as LeaseRow | undefined
    if (row !== undefined && row.device_id !== deviceId && row.lease_until > now) {
      throw new SyncError('lease-held', `会话 ${sessionId} 的租约由 ${row.device_id} 持有至 ${row.lease_until}`)
    }
    const leaseUntil = now + LEASE_TTL_MS
    db.handle
      .prepare('INSERT INTO leases (dataset, session_id, device_id, lease_until) VALUES (?, ?, ?, ?) ON CONFLICT(dataset, session_id) DO UPDATE SET device_id = excluded.device_id, lease_until = excluded.lease_until')
      .run(DEFAULT_DATASET, sessionId, deviceId, leaseUntil)
    return { sessionId, deviceId, leaseUntil, acquired: row === undefined || row.device_id !== deviceId || row.lease_until <= now }
  })
}

/**
 * 释放自己持有的租约。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param deviceId - 调用设备。
 * @returns 是否真的释放了。
 */
export function releaseLease(db: ServerDb, sessionId: string, deviceId: string): boolean {
  const result = db.handle.prepare('DELETE FROM leases WHERE dataset = ? AND session_id = ? AND device_id = ?').run(DEFAULT_DATASET, sessionId, deviceId)
  return Number(result.changes) > 0
}

/**
 * 校验链并组装 manifest。
 * @param sessionId - 会话 id。
 * @param formatVersion - 格式代际。
 * @param createdAt - 创建时间。
 * @param updatedAt - 更新时间。
 * @param frames - 合并后的完整帧列表。
 * @returns manifest 与摘要。
 */
function manifestOf(
  sessionId: string,
  formatVersion: number,
  createdAt: number,
  updatedAt: number,
  frames: readonly SealedFrameRef[],
  tailOpen?: boolean,
  safeThroughSeq?: number,
): {
  manifest: SessionManifest
  digest: string
  headChainHash: string
} {
  assertChain(toChain(frames))
  const manifest = buildManifest({
    sessionId,
    formatVersion,
    createdAt,
    updatedAt,
    frames,
    ...tailOpen === undefined ? {} : { tailOpen },
    ...safeThroughSeq === undefined ? {} : { safeThroughSeq },
  })
  return { manifest, digest: manifestDigest(manifest), headChainHash: frames[frames.length - 1]!.chainHash }
}

/**
 * 提交新帧（首次创建或前缀延续）。
 * @param db - 已打开的数据库。
 * @param dataDir - 数据目录（检查 blob 是否已上传）。
 * @param input - append 入参。
 * @param now - 当前时间。
 * @returns 会话摘要。
 * @throws 租约、前缀、生命周期或 blob 缺失时抛出对应错误。
 */
export function appendFrames(db: ServerDb, dataDir: string, input: AppendInput, now = Date.now()): SessionSummary {
  return withTransaction(db, () => {
    requireLease(db, input.sessionId, input.deviceId, now)
    const row = sessionRow(db, input.sessionId)
    let combined: SealedFrameRef[]
    let formatVersion = input.formatVersion
    let createdAt = input.createdAt

    if (row !== undefined && row.deleted_at !== null && row.created_at === input.createdAt) {
      throw new SyncError('gone', `会话 ${input.sessionId} 的这个生命周期已被删除`)
    }
    const replacingLifecycle = row !== undefined && row.deleted_at !== null && row.created_at !== input.createdAt
    if (row !== undefined && row.deleted_at === null && row.created_at !== input.createdAt) {
      throw new SyncError('conflict', `会话 ${input.sessionId} 已存在另一个生命周期（createdAt=${row.created_at}）`)
    }

    if (row === undefined || replacingLifecycle) {
      if (input.baseIndex !== -1 || input.baseChainHash !== null) throw new SyncError('conflict', '新会话必须从 baseIndex=-1 开始')
      if (input.frames.length === 0) throw new SyncError('bad-request', 'append 至少需要一帧')
      combined = [...input.frames]
    } else {
      const existing = JSON.parse(row.manifest_json) as SessionManifest
      formatVersion = existing.formatVersion
      createdAt = existing.createdAt
      const start = input.baseIndex + 1
      if (start < 0 || start > existing.frames.length) throw new SyncError('diverged', `baseIndex=${input.baseIndex} 超出链长 ${existing.frames.length}`)
      if (start < existing.frames.length - 1) throw new SyncError('diverged', '只能追加或替换尾帧')
      if (input.baseIndex >= 0) {
        const base = existing.frames[input.baseIndex]
        if (base === undefined || base.chainHash !== input.baseChainHash) throw new SyncError('diverged', 'baseChainHash 与当前链不匹配')
      } else if (existing.frames.length !== 0) {
        throw new SyncError('diverged', 'baseIndex=-1 但会话已存在')
      }
      if (input.frames.length === 0) throw new SyncError('bad-request', 'append 至少需要一帧')
      combined = [...existing.frames.slice(0, start), ...input.frames]
    }

    // 新帧的 blob 必须已经上传；旧的尾帧被替换时也要求新 blob 存在。
    for (const frame of input.frames) {
      if (!existsSync(blobPath(dataDir, frame.blobSha256))) throw new SyncError('bad-request', `帧 ${frame.index} 的 blob 尚未上传`)
    }
    input.frames.forEach((frame, offset) => assertRef(frame, (row === undefined || replacingLifecycle ? 0 : input.baseIndex + 1) + offset))

    const { manifest, digest, headChainHash } = manifestOf(
      input.sessionId,
      formatVersion,
      createdAt,
      now,
      combined,
      input.tailOpen,
      input.safeThroughSeq,
    )
    const revision = bumpRevision(db)
    db.handle
      .prepare(`INSERT INTO sessions (dataset, session_id, created_at, format_version, last_seq, frame_count, head_chain_hash, manifest_json, manifest_digest, revision, updated_at, deleted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(dataset, session_id) DO UPDATE SET
                  created_at = excluded.created_at, format_version = excluded.format_version, last_seq = excluded.last_seq,
                  frame_count = excluded.frame_count, head_chain_hash = excluded.head_chain_hash,
                  manifest_json = excluded.manifest_json, manifest_digest = excluded.manifest_digest,
                  revision = excluded.revision, updated_at = excluded.updated_at, deleted_at = NULL`)
      .run(DEFAULT_DATASET, input.sessionId, createdAt, formatVersion, manifest.lastSeq, combined.length, headChainHash, JSON.stringify(manifest), digest, revision, now)
    return {
      sessionId: input.sessionId,
      revision,
      frameCount: combined.length,
      headChainHash,
      manifestDigest: digest,
      lastSeq: manifest.lastSeq,
      updatedAt: now,
      deletedAt: null,
    }
  })
}

/**
 * 给会话写墓碑。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param deviceId - 调用设备（必须持有租约）。
 * @param createdAt - 生命周期标识，必须与存储的一致。
 * @param now - 当前时间。
 * @returns 会话摘要。
 * @throws 不存在、生命周期不符或已删除时抛出。
 */
export function deleteSession(db: ServerDb, sessionId: string, deviceId: string, createdAt: number, now = Date.now()): SessionSummary {
  return withTransaction(db, () => {
    requireLease(db, sessionId, deviceId, now)
    const row = sessionRow(db, sessionId)
    if (row === undefined) throw new SyncError('not-found', `没有会话 ${sessionId}`)
    if (row.created_at !== createdAt) throw new SyncError('conflict', 'createdAt 与当前生命周期不符')
    if (row.deleted_at !== null) throw new SyncError('gone', `会话 ${sessionId} 已删除`)
    const revision = bumpRevision(db)
    db.handle.prepare('UPDATE sessions SET deleted_at = ?, revision = ?, updated_at = ? WHERE dataset = ? AND session_id = ?').run(now, revision, now, DEFAULT_DATASET, sessionId)
    db.handle
      .prepare('INSERT OR REPLACE INTO tombstones (dataset, session_id, created_at, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?)')
      .run(DEFAULT_DATASET, sessionId, createdAt, now, deviceId)
    return { sessionId, revision, frameCount: row.frame_count, headChainHash: row.head_chain_hash, manifestDigest: row.manifest_digest, lastSeq: row.last_seq, updatedAt: now, deletedAt: now }
  })
}

/**
 * 读完整 manifest。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @returns manifest 与 revision，或 undefined。
 */
export function getManifest(db: ServerDb, sessionId: string): { manifest: SessionManifest; revision: number } | undefined {
  const row = sessionRow(db, sessionId)
  if (row === undefined) return undefined
  return { manifest: JSON.parse(row.manifest_json) as SessionManifest, revision: row.revision }
}

/**
 * 分页读帧引用。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param from - 起始下标。
 * @param limit - 每页条数。
 * @returns 帧引用、总数与 revision，或 undefined。
 */
export function listFrames(db: ServerDb, sessionId: string, from: number, limit: number): { frames: SealedFrameRef[]; total: number; revision: number } | undefined {
  const row = sessionRow(db, sessionId)
  if (row === undefined) return undefined
  const manifest = JSON.parse(row.manifest_json) as SessionManifest
  return { frames: manifest.frames.slice(from, from + limit), total: manifest.frames.length, revision: row.revision }
}

/**
 * 管理台用的会话行（含租约）。
 */
export interface AdminSession {
  readonly sessionId: string
  readonly createdAt: number
  readonly formatVersion: number
  readonly frameCount: number
  readonly lastSeq: number
  readonly headChainHash: string
  readonly revision: number
  readonly updatedAt: number
  readonly deletedAt: number | null
  readonly lease: { readonly deviceId: string; readonly leaseUntil: number } | null
}

/**
 * 列出管理台用的会话元数据。
 * @param db - 已打开的数据库。
 * @param limit - 最大条数。
 * @returns 按更新时间倒序的会话。
 */
export function adminSessions(db: ServerDb, limit = 500): AdminSession[] {
  const rows = db.handle
    .prepare(`SELECT s.session_id, s.created_at, s.format_version, s.frame_count, s.last_seq, s.head_chain_hash,
                     s.revision, s.updated_at, s.deleted_at, l.device_id AS lease_device, l.lease_until AS lease_until
              FROM sessions s LEFT JOIN leases l ON l.dataset = s.dataset AND l.session_id = s.session_id
              WHERE s.dataset = ? ORDER BY s.updated_at DESC LIMIT ?`)
    .all(DEFAULT_DATASET, limit) as unknown as Array<{
      session_id: string
      created_at: number
      format_version: number
      frame_count: number
      last_seq: number
      head_chain_hash: string
      revision: number
      updated_at: number
      deleted_at: number | null
      lease_device: string | null
      lease_until: number | null
    }>
  return rows.map((row) => ({
    sessionId: row.session_id,
    createdAt: row.created_at,
    formatVersion: row.format_version,
    frameCount: row.frame_count,
    lastSeq: row.last_seq,
    headChainHash: row.head_chain_hash,
    revision: row.revision,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    lease: row.lease_device === null || row.lease_until === null ? null : { deviceId: row.lease_device, leaseUntil: row.lease_until },
  }))
}

/**
 * 统计会话总数与已删除数。
 * @param db - 已打开的数据库。
 * @returns 计数。
 */
export function sessionCounts(db: ServerDb): { total: number; deleted: number } {
  const row = db.handle
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END), 0) AS deleted FROM sessions WHERE dataset = ?')
    .get(DEFAULT_DATASET) as { total?: number; deleted?: number } | undefined
  return { total: Number(row?.total ?? 0), deleted: Number(row?.deleted ?? 0) }
}

/** cursor 返回的会话摘要。 */
export interface SessionChange {
  readonly sessionId: string
  readonly revision: number
  readonly formatVersion: number
  readonly createdAt: number
  readonly frameCount: number
  readonly headChainHash: string
  readonly manifestDigest: string
  readonly updatedAt: number
  readonly deletedAt: number | null
}

/**
 * 列出自某 revision 以来的变更摘要。
 * @param db - 已打开的数据库。
 * @param since - 客户端持有的 revision。
 * @param limit - 最大条数。
 * @returns 当前 revision、变更摘要与是否还有更多。
 */
export function listChanges(db: ServerDb, since: number, limit: number): {
  revision: number
  sessions: SessionChange[]
  tombstones: Array<{ sessionId: string; createdAt: number; deletedAt: number }>
  hasMore: boolean
} {
  const rows = db.handle
    .prepare('SELECT session_id, created_at, format_version, frame_count, head_chain_hash, manifest_digest, revision, updated_at, deleted_at FROM sessions WHERE dataset = ? AND revision > ? ORDER BY revision ASC LIMIT ?')
    .all(DEFAULT_DATASET, since, limit + 1) as unknown as Array<{
      session_id: string
      created_at: number
      format_version: number
      frame_count: number
      head_chain_hash: string
      manifest_digest: string
      revision: number
      updated_at: number
      deleted_at: number | null
    }>
  const tombstones = db.handle
    .prepare('SELECT session_id, created_at, deleted_at FROM tombstones WHERE dataset = ? AND deleted_at > ? ORDER BY deleted_at ASC LIMIT ?')
    .all(DEFAULT_DATASET, since, limit + 1) as unknown as Array<{ session_id: string; created_at: number; deleted_at: number }>
  const sessions = rows.slice(0, limit).map((row) => ({
    sessionId: row.session_id,
    revision: row.revision,
    formatVersion: row.format_version,
    createdAt: row.created_at,
    frameCount: row.frame_count,
    headChainHash: row.head_chain_hash,
    manifestDigest: row.manifest_digest,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }))
  return {
    revision: readRevision(db),
    sessions,
    tombstones: tombstones.slice(0, limit).map((row) => ({ sessionId: row.session_id, createdAt: row.created_at, deletedAt: row.deleted_at })),
    hasMore: rows.length > limit || tombstones.length > limit,
  }
}
