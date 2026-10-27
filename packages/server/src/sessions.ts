/**
 * 会话同步的服务端逻辑：租约、append、墓碑与 cursor。
 *
 * 所有写操作都在 `BEGIN IMMEDIATE` 事务里完成；append 只校验元数据与 blob
 * 存在性，不解析密文内容。链的完整性由客户端负责，服务端只保证"前缀延续"。
 *
 * @module @dsh-session-cloudsync/server/sessions
 */
import { existsSync } from 'node:fs'
import { assertChain, buildManifest, manifestDigest, stableStringify } from '../../shared/src/chain.ts'
import type { ChainFrame } from '../../shared/src/chain.ts'
import { sha256 } from '../../shared/src/crypto.ts'
import type { SessionManifest } from '../../shared/src/protocol.ts'
import type { SealedFrameRef } from '../../shared/src/sealed-frame.ts'
import { SyncError } from '../../shared/src/wire.ts'
import { blobPath } from './blobs.ts'
import { DEFAULT_DATASET, bumpRevision, readAppendRequest, readRevision, withTransaction, writeAppendRequest, type ServerDb } from './db.ts'
import { requireLease as requireResourceLease, SYNC_RESOURCE } from './leases.ts'

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

/** append 的入参。 */
export interface AppendInput {
  readonly sessionId: string
  readonly deviceId: string
  readonly clientId: string
  readonly baseIndex: number
  readonly baseChainHash: string | null
  readonly createdAt: number
  readonly formatVersion: number
  readonly frames: readonly SealedFrameRef[]
  readonly tailOpen?: boolean
  readonly safeThroughSeq?: number
  /** 根/worktree 的逻辑工作区 key；子代理继承。 */
  readonly workspaceKey?: string
  /** v2 客户端的幂等键；v1 不设置。 */
  readonly idempotencyKey?: string
}

/** append / delete 之后返回的会话摘要。 */
export interface SessionSummary {
  readonly sessionId: string
  readonly revision: number
  readonly batchCount: number
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
  if (frame.compression === undefined) {
    if (frame.sealedVersion !== 1 || frame.compressedHash !== undefined) {
      throw new SyncError('bad-request', `帧 ${expectedIndex} 缺少压缩元数据`)
    }
  } else {
    if (frame.compression !== 'zstd' || frame.sealedVersion < 2) {
      throw new SyncError('bad-request', `帧 ${expectedIndex} 的压缩元数据非法`)
    }
    if (typeof frame.compressedHash !== 'string' || !HASH.test(frame.compressedHash)) {
      throw new SyncError('bad-request', `帧 ${expectedIndex} 的 compressedHash 非法`)
    }
  }
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
  workspaceKey?: string,
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
    ...workspaceKey === undefined ? {} : { workspaceKey },
  })
  return { manifest, digest: manifestDigest(manifest), headChainHash: frames[frames.length - 1]!.chainHash }
}

/**
 * 计算 append 请求内容的稳定哈希，用于发现 Idempotency-Key 被复用于不同内容。
 * @param input - append 入参。
 * @returns 小写十六进制 SHA-256。
 */
function appendRequestHash(input: AppendInput): string {
  return sha256(stableStringify({
    sessionId: input.sessionId,
    baseIndex: input.baseIndex,
    baseChainHash: input.baseChainHash,
    createdAt: input.createdAt,
    formatVersion: input.formatVersion,
    frames: input.frames,
    tailOpen: input.tailOpen ?? null,
    safeThroughSeq: input.safeThroughSeq ?? null,
    workspaceKey: input.workspaceKey ?? null,
  }))
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
    const idempotencyKey = input.idempotencyKey
    const requestHash = idempotencyKey === undefined ? undefined : appendRequestHash(input)
    if (idempotencyKey !== undefined && requestHash !== undefined) {
      // 幂等重放必须发生在租约检查之前：原始请求成功后，租约可能已经过期
      // 或已释放，但客户端仍应拿到同一个成功结果。
      const existing = readAppendRequest(db, input.deviceId, input.sessionId, idempotencyKey)
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          throw new SyncError('conflict', 'Idempotency-Key 已用于不同的 append 请求')
        }
        return JSON.parse(existing.resultJson) as SessionSummary
      }
    }
    requireResourceLease(db, SYNC_RESOURCE, input.deviceId, input.clientId, now)
    const row = sessionRow(db, input.sessionId)
    let combined: SealedFrameRef[]
    let formatVersion = input.formatVersion
    let createdAt = input.createdAt
    let workspaceKey = input.workspaceKey

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
      if (workspaceKey !== undefined && existing.workspaceKey !== undefined && workspaceKey !== existing.workspaceKey) {
        throw new SyncError('conflict', 'append 的 workspaceKey 与已存 manifest 不一致')
      }
      if (workspaceKey === undefined && existing.workspaceKey !== undefined) workspaceKey = existing.workspaceKey
      if (workspaceKey !== undefined && existing.workspaceKey === undefined) {
        throw new SyncError('conflict', '已有会话缺少 workspaceKey，不能在后续 append 补写')
      }
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
      workspaceKey,
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
    const summary: SessionSummary = {
      sessionId: input.sessionId,
      revision,
      batchCount: combined.length,
      headChainHash,
      manifestDigest: digest,
      lastSeq: manifest.lastSeq,
      updatedAt: now,
      deletedAt: null,
    }
    if (idempotencyKey !== undefined && requestHash !== undefined) {
      writeAppendRequest(
        db,
        input.deviceId,
        input.sessionId,
        idempotencyKey,
        requestHash,
        JSON.stringify(summary),
        now,
      )
    }
    return summary
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
export function deleteSession(db: ServerDb, sessionId: string, deviceId: string, clientId: string, createdAt: number, now = Date.now()): SessionSummary {
  return withTransaction(db, () => {
    requireResourceLease(db, SYNC_RESOURCE, deviceId, clientId, now)
    const row = sessionRow(db, sessionId)
    if (row === undefined) throw new SyncError('not-found', `没有会话 ${sessionId}`)
    if (row.created_at !== createdAt) throw new SyncError('conflict', 'createdAt 与当前生命周期不符')
    if (row.deleted_at !== null) throw new SyncError('gone', `会话 ${sessionId} 已删除`)
    const revision = bumpRevision(db)
    db.handle.prepare('UPDATE sessions SET deleted_at = ?, revision = ?, updated_at = ? WHERE dataset = ? AND session_id = ?').run(now, revision, now, DEFAULT_DATASET, sessionId)
    db.handle
      .prepare('INSERT OR REPLACE INTO tombstones (dataset, session_id, created_at, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?)')
      .run(DEFAULT_DATASET, sessionId, createdAt, now, deviceId)
    return { sessionId, revision, batchCount: row.frame_count, headChainHash: row.head_chain_hash, manifestDigest: row.manifest_digest, lastSeq: row.last_seq, updatedAt: now, deletedAt: now }
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
 * @returns 批次引用、总数与 revision，或 undefined。
 */
export function listBatches(db: ServerDb, sessionId: string, from: number, limit: number): { batches: SealedFrameRef[]; batchCount: number; revision: number } | undefined {
  const row = sessionRow(db, sessionId)
  if (row === undefined) return undefined
  const manifest = JSON.parse(row.manifest_json) as SessionManifest
  return { batches: manifest.frames.slice(from, from + limit), batchCount: manifest.frames.length, revision: row.revision }
}

/** v2 会话摘要；不包含 manifest 里的完整批次列表。 */
export interface V2SessionSummary {
  readonly sessionId: string
  readonly revision: number
  readonly formatVersion: number
  readonly createdAt: number
  readonly batchCount: number
  readonly lastSeq: number
  readonly headChainHash: string
  readonly manifestDigest: string
  /** manifest 里的 opaque workspaceKey；子代理或旧 manifest 为 null。 */
  readonly workspaceKey: string | null
  /** 已闭合到的事件序号；没有显式值时等于 lastSeq。 */
  readonly safeThroughSeq: number
  readonly tailOpen: boolean
  readonly updatedAt: number
  readonly deletedAt: number | null
}

interface V2SummaryRow {
  readonly session_id: string
  readonly created_at: number
  readonly format_version: number
  readonly last_seq: number
  readonly frame_count: number
  readonly head_chain_hash: string
  readonly manifest_digest: string
  readonly revision: number
  readonly updated_at: number
  readonly deleted_at: number | null
  readonly workspace_key: string | null
  readonly tail_open: number | null
  readonly safe_through_seq: number | null
}

const V2_SUMMARY_SELECT = `s.session_id, s.created_at, s.format_version, s.last_seq, s.frame_count,
  s.head_chain_hash, s.manifest_digest, s.revision, s.updated_at, s.deleted_at,
  json_extract(s.manifest_json, '$.workspaceKey') AS workspace_key,
  json_extract(s.manifest_json, '$.tailOpen') AS tail_open,
  json_extract(s.manifest_json, '$.safeThroughSeq') AS safe_through_seq`

/**
 * 把数据库行映射成 v2 摘要。
 * @param row - 查询结果。
 * @returns v2 摘要。
 */
function mapV2Summary(row: V2SummaryRow): V2SessionSummary {
  const safe = typeof row.safe_through_seq === 'number' && Number.isSafeInteger(row.safe_through_seq)
    ? row.safe_through_seq
    : row.last_seq
  return {
    sessionId: row.session_id,
    revision: row.revision,
    formatVersion: row.format_version,
    createdAt: row.created_at,
    batchCount: row.frame_count,
    lastSeq: row.last_seq,
    headChainHash: row.head_chain_hash,
    manifestDigest: row.manifest_digest,
    workspaceKey: typeof row.workspace_key === 'string' && row.workspace_key !== '' ? row.workspace_key : null,
    safeThroughSeq: safe,
    tailOpen: Number(row.tail_open) === 1,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/**
 * 列出 v2 全量会话快照（只含未删除会话）。
 *
 * 用 `session_id` 做 keyset 分页，避免用全局 revision 当页游标；这与 v1 的
 * change feed 无关，v1 行为保持不变。
 * @param db - 已打开的数据库。
 * @param after - 上一页最后一个 sessionId；第一页为 undefined。
 * @param limit - 本页最多返回条数。
 * @returns 摘要与下一页游标。
 */
export function listV2Sessions(
  db: ServerDb,
  after: string | undefined,
  limit: number,
): { sessions: V2SessionSummary[]; nextSessionId: string | null } {
  const rows = db.handle
    .prepare(`SELECT ${V2_SUMMARY_SELECT}
              FROM sessions s
              WHERE s.dataset = ? AND s.deleted_at IS NULL AND s.session_id > ?
              ORDER BY s.session_id ASC LIMIT ?`)
    .all(DEFAULT_DATASET, after ?? '', limit + 1) as unknown as V2SummaryRow[]
  const visible = rows.slice(0, limit)
  const last = visible[visible.length - 1]
  return {
    sessions: visible.map(mapV2Summary),
    nextSessionId: rows.length > limit && last !== undefined ? last.session_id : null,
  }
}

/** v2 变更流里的墓碑。 */
export interface V2Tombstone {
  readonly sessionId: string
  readonly createdAt: number
  readonly deletedAt: number
}

/** v2 墓碑分页游标；同毫秒删除靠 sessionId/createdAt 保持稳定顺序。 */
export interface V2TombstoneCursor {
  readonly deletedAt: number
  readonly sessionId: string
  readonly createdAt: number
}

/**
 * 读取 v2 变更流。
 *
 * 会话变更按全局 `revision` 推进；墓碑仍按 `deleted_at` 推进。两路各自
 * 使用自己的高水位，避免 v1 里“两路共用一个 limit/游标”造成的漏项。
 * `highWater` 在查询前读取，保证并发写入不会被本页跳过。
 * @param db - 已打开的数据库。
 * @param sinceRevision - 客户端已处理到的会话 revision。
 * @param sinceTombstone - 客户端已处理到的墓碑游标。
 * @param limit - 每路最多返回条数。
 * @returns 变更摘要、墓碑、下一页游标与是否还有更多。
 */
export function listV2Changes(
  db: ServerDb,
  sinceRevision: number,
  sinceTombstone: V2TombstoneCursor,
  limit: number,
): {
  sessions: V2SessionSummary[]
  tombstones: V2Tombstone[]
  nextRevision: number
  nextTombstone: V2TombstoneCursor
  hasMore: boolean
} {
  const highWater = Math.max(sinceRevision, readRevision(db))
  const rows = db.handle
    .prepare(`SELECT ${V2_SUMMARY_SELECT}
              FROM sessions s
              WHERE s.dataset = ? AND s.deleted_at IS NULL AND s.revision > ? AND s.revision <= ?
              ORDER BY s.revision ASC LIMIT ?`)
    .all(DEFAULT_DATASET, sinceRevision, highWater, limit + 1) as unknown as V2SummaryRow[]
  const tombstoneRows = db.handle
    .prepare(`SELECT session_id, created_at, deleted_at FROM tombstones
              WHERE dataset = ? AND (
                deleted_at > ? OR
                (deleted_at = ? AND session_id > ?) OR
                (deleted_at = ? AND session_id = ? AND created_at > ?)
              )
              ORDER BY deleted_at ASC, session_id ASC, created_at ASC LIMIT ?`)
    .all(
      DEFAULT_DATASET,
      sinceTombstone.deletedAt,
      sinceTombstone.deletedAt,
      sinceTombstone.sessionId,
      sinceTombstone.deletedAt,
      sinceTombstone.sessionId,
      sinceTombstone.createdAt,
      limit + 1,
    ) as unknown as Array<{
    session_id: string
    created_at: number
    deleted_at: number
  }>
  const visible = rows.slice(0, limit)
  const visibleTombstones = tombstoneRows.slice(0, limit)
  const last = visible[visible.length - 1]
  const lastTombstone = visibleTombstones[visibleTombstones.length - 1]
  const hasMore = rows.length > limit || tombstoneRows.length > limit
  return {
    sessions: visible.map(mapV2Summary),
    tombstones: visibleTombstones.map((row) => ({
      sessionId: row.session_id,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    })),
    // 会话已经全部扫到 highWater 时才推进到高水位；只有墓碑还有更多时，
    // 不能把会话游标也提前推进，否则会漏掉后续会话。
    nextRevision: rows.length > limit && last !== undefined ? last.revision : highWater,
    nextTombstone: lastTombstone === undefined
      ? sinceTombstone
      : {
        deletedAt: lastTombstone.deleted_at,
        sessionId: lastTombstone.session_id,
        createdAt: lastTombstone.created_at,
      },
    hasMore,
  }
}

/**
 * 读单个 v2 会话摘要。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @returns 摘要，或 undefined。
 */
export function getV2SessionSummary(db: ServerDb, sessionId: string): V2SessionSummary | undefined {
  const row = db.handle
    .prepare(`SELECT ${V2_SUMMARY_SELECT}
              FROM sessions s
              WHERE s.dataset = ? AND s.session_id = ?`)
    .get(DEFAULT_DATASET, sessionId) as unknown as V2SummaryRow | undefined
  return row === undefined ? undefined : mapV2Summary(row)
}

/**
 * 分页读 v2 批次引用，并带上 manifest 摘要供条件请求校验。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param from - 起始下标。
 * @param limit - 每页条数。
 * @returns 批次引用、总数、revision 与 manifestDigest，或 undefined。
 */
export function listV2Batches(
  db: ServerDb,
  sessionId: string,
  from: number,
  limit: number,
): { batches: SealedFrameRef[]; batchCount: number; revision: number; manifestDigest: string } | undefined {
  const row = sessionRow(db, sessionId)
  if (row === undefined) return undefined
  const manifest = JSON.parse(row.manifest_json) as SessionManifest
  return {
    batches: manifest.frames.slice(from, from + limit),
    batchCount: manifest.frames.length,
    revision: row.revision,
    manifestDigest: row.manifest_digest,
  }
}

/**
 * 管理台用的会话行。
 */
export interface AdminSession {
  readonly sessionId: string
  readonly createdAt: number
  readonly formatVersion: number
  readonly batchCount: number
  readonly lastSeq: number
  readonly headChainHash: string
  readonly revision: number
  readonly updatedAt: number
  readonly deletedAt: number | null
  /** manifest 里的 opaque workspaceKey；子代理或旧 manifest 为 null。 */
  readonly workspaceKey: string | null
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
                     s.revision, s.updated_at, s.deleted_at,
                     json_extract(s.manifest_json, '$.workspaceKey') AS workspace_key
              FROM sessions s
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
      workspace_key: string | null
    }>
  return rows.map((row) => ({
    sessionId: row.session_id,
    createdAt: row.created_at,
    formatVersion: row.format_version,
    batchCount: row.frame_count,
    lastSeq: row.last_seq,
    headChainHash: row.head_chain_hash,
    revision: row.revision,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    workspaceKey: row.workspace_key === null ? null : String(row.workspace_key),
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
  readonly batchCount: number
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
    batchCount: row.frame_count,
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
