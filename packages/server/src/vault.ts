/**
 * Vault 记录的服务端逻辑：writer 租约、append、cursor 与 stream。
 *
 * 服务端只校验索引、链与 blob 存在性，不解析密文。记录链的哈希由客户端
 * 生成，服务端用同一套 shared 原语复算 recordHash，防止索引被拼接。
 *
 * @module @dsh-session-cloudsync/server/vault
 */
import { readFileSync } from 'node:fs'
import { SyncError } from '../../shared/src/wire.ts'
import {
  assertVaultRecordRef,
  vaultRecordHashOf,
  type VaultRecordRef,
} from '../../shared/src/vault.ts'
import { blobPath } from './blobs.ts'
import { DEFAULT_DATASET, bumpRevision, readRevision, withTransaction, type ServerDb } from './db.ts'
import { requireLease, vaultResource } from './leases.ts'

/** 单条 Vault 记录密文上限。 */
export const MAX_VAULT_RECORD_BYTES = 1024 * 1024

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/u

/** 一条 Vault 记录索引 + 全局 revision。 */
export interface VaultRecordView extends VaultRecordRef {
  readonly revision: number
}

/** append 的入参。 */
export interface VaultAppendInput {
  readonly writer: string
  readonly deviceId: string
  readonly clientId: string
  readonly seq: number
  readonly prevHash: string | null
  readonly blobSha256: string
  readonly bytes: number
  readonly createdAt: number
  readonly sealed: { readonly formatVersion: number; readonly keyId: string }
}

interface VaultRow {
  readonly writer: string
  readonly seq: number
  readonly prev_hash: string | null
  readonly blob_sha256: string
  readonly bytes: number
  readonly created_at: number
  readonly sealed_json: string
  readonly record_hash: string
  readonly revision: number
}

/**
 * 读取一行并还原成记录索引。
 * @param row - 数据库行。
 * @returns 记录索引 + revision。
 */
function viewOf(row: VaultRow): VaultRecordView {
  let sealed: { formatVersion: number; keyId: string }
  try {
    sealed = JSON.parse(row.sealed_json) as { formatVersion: number; keyId: string }
  } catch {
    throw new SyncError('bad-request', 'Vault sealed_json 损坏')
  }
  const ref: VaultRecordRef = {
    v: 1,
    writer: row.writer,
    seq: row.seq,
    prevHash: row.prev_hash,
    blobSha256: row.blob_sha256,
    bytes: row.bytes,
    createdAt: row.created_at,
    sealed,
    recordHash: row.record_hash,
  }
  assertVaultRecordRef(ref)
  return { ...ref, revision: row.revision }
}

/**
 * 读取一个 writer 的最后一条记录。
 * @param db - 数据库。
 * @param writer - 设备 id。
 * @returns 行或 undefined。
 */
function lastRow(db: ServerDb, writer: string): VaultRow | undefined {
  return db.handle
    .prepare('SELECT writer, seq, prev_hash, blob_sha256, bytes, created_at, sealed_json, record_hash, revision FROM vault_records WHERE dataset = ? AND writer = ? ORDER BY seq DESC LIMIT 1')
    .get(DEFAULT_DATASET, writer) as VaultRow | undefined
}

/**
 * 读取一个 writer 的指定 seq 记录。
 * @param db - 数据库。
 * @param writer - 设备 id。
 * @param seq - 序号。
 * @returns 行或 undefined。
 */
function rowAt(db: ServerDb, writer: string, seq: number): VaultRow | undefined {
  return db.handle
    .prepare('SELECT writer, seq, prev_hash, blob_sha256, bytes, created_at, sealed_json, record_hash, revision FROM vault_records WHERE dataset = ? AND writer = ? AND seq = ?')
    .get(DEFAULT_DATASET, writer, seq) as VaultRow | undefined
}

/**
 * 校验 append 请求的字段。
 * @param input - append 入参。
 * @returns 标准化后的记录索引（不含 revision）。
 */
function validateInput(input: VaultAppendInput): VaultRecordRef {
  if (input.writer !== input.deviceId) throw new SyncError('bad-request', 'writer 必须等于当前 deviceId')
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) throw new SyncError('bad-request', 'Vault seq 必须是正整数')
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw new SyncError('bad-request', 'Vault createdAt 非法')
  if (!HASH_PATTERN.test(input.blobSha256)) throw new SyncError('bad-request', 'Vault blobSha256 非法')
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > MAX_VAULT_RECORD_BYTES) {
    throw new SyncError('bad-request', 'Vault bytes 非法或超过 1 MiB')
  }
  if (input.sealed === null || typeof input.sealed !== 'object') throw new SyncError('bad-request', 'Vault sealed 非法')
  if (input.sealed.formatVersion !== 1) throw new SyncError('bad-request', 'Vault sealed.formatVersion 必须是 1')
  if (!KEY_ID_PATTERN.test(input.sealed.keyId)) throw new SyncError('bad-request', 'Vault sealed.keyId 非法')
  if (input.seq === 1 && input.prevHash !== null) throw new SyncError('bad-request', 'Vault seq=1 的 prevHash 必须为 null')
  if (input.seq > 1 && (input.prevHash === null || !HASH_PATTERN.test(input.prevHash))) {
    throw new SyncError('bad-request', 'Vault prevHash 非法')
  }
  const fields = {
    v: 1,
    writer: input.writer,
    seq: input.seq,
    prevHash: input.prevHash,
    blobSha256: input.blobSha256,
    bytes: input.bytes,
    createdAt: input.createdAt,
    sealed: {
      formatVersion: input.sealed.formatVersion,
      keyId: input.sealed.keyId,
    },
  }
  const ref = { ...fields, recordHash: vaultRecordHashOf(fields) }
  assertVaultRecordRef(ref)
  return ref
}

/**
 * 判断已有行是否就是同一条记录。
 * @param row - 已存在的行。
 * @param ref - 请求记录。
 * @returns 完全一致时为 true。
 */
function sameRow(row: VaultRow, ref: VaultRecordRef): boolean {
  return row.prev_hash === ref.prevHash
    && row.blob_sha256 === ref.blobSha256
    && row.bytes === ref.bytes
    && row.created_at === ref.createdAt
    && row.record_hash === ref.recordHash
    && row.sealed_json === JSON.stringify(ref.sealed)
}

/**
 * 追加一条 Vault 记录。
 *
 * 相同 writer/seq/内容重试是幂等的；不同内容返回 `conflict`。新记录要求
 * 当前 owner 持有 `vault-writer:<writer>` 租约。
 * @param db - 数据库。
 * @param dataDir - blob 目录。
 * @param input - append 入参。
 * @param now - 当前时间。
 * @returns 记录索引、revision 与 dedup 标记。
 */
export function appendVaultRecord(
  db: ServerDb,
  dataDir: string,
  input: VaultAppendInput,
  now = Date.now(),
): { record: VaultRecordView; dedup: boolean } {
  const ref = validateInput(input)

  // 幂等重放：在检查租约之前返回已有记录；响应丢失后的重试不应被 TTL 卡住。
  const existing = rowAt(db, input.writer, input.seq)
  if (existing !== undefined) {
    if (sameRow(existing, ref)) return { record: viewOf(existing), dedup: true }
    throw new SyncError('conflict', `Vault writer ${input.writer} 的 seq ${input.seq} 已有不同内容`)
  }

  return withTransaction(db, () => {
    requireLease(db, vaultResource(input.writer), input.deviceId, input.clientId, now)
    const raced = rowAt(db, input.writer, input.seq)
    if (raced !== undefined) {
      if (sameRow(raced, ref)) return { record: viewOf(raced), dedup: true }
      throw new SyncError('conflict', `Vault writer ${input.writer} 的 seq ${input.seq} 已有不同内容`)
    }
    const last = lastRow(db, input.writer)
    if (last === undefined) {
      if (ref.seq !== 1 || ref.prevHash !== null) throw new SyncError('conflict', 'Vault 首条必须从 seq=1 / prevHash=null 开始')
    } else {
      if (ref.seq !== last.seq + 1) throw new SyncError('conflict', `Vault 下一条 seq 应为 ${last.seq + 1}`)
      if (ref.prevHash !== last.record_hash) throw new SyncError('conflict', 'Vault prevHash 与当前链不匹配')
    }
    let blob: Buffer
    try {
      blob = readBlobSync(dataDir, ref.blobSha256)
    } catch {
      throw new SyncError('bad-request', `Vault blob 尚未上传：${ref.blobSha256}`)
    }
    if (blob.length !== ref.bytes) throw new SyncError('bad-request', 'Vault blob 字节数与索引不一致')

    const revision = bumpRevision(db)
    db.handle
      .prepare('INSERT INTO vault_records (dataset, writer, seq, prev_hash, blob_sha256, bytes, created_at, sealed_json, record_hash, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(DEFAULT_DATASET, ref.writer, ref.seq, ref.prevHash, ref.blobSha256, ref.bytes, ref.createdAt, JSON.stringify(ref.sealed), ref.recordHash, revision)
    return { record: { ...ref, revision }, dedup: false }
  })
}

/** 同步读取 blob；服务端 append 在事务内需要避免异步 IO。 */
function readBlobSync(dataDir: string, sha256: string): Buffer {
  return readFileSync(blobPath(dataDir, sha256))
}

/**
 * 读取自某个 revision 之后的 Vault 记录索引。
 * @param db - 数据库。
 * @param since - 客户端 revision。
 * @param limit - 最大条数。
 * @returns 当前 revision、记录与是否还有更多。
 */
export function readVaultCursor(db: ServerDb, since: number, limit: number): {
  revision: number
  records: VaultRecordView[]
  hasMore: boolean
} {
  const rows = db.handle
    .prepare('SELECT writer, seq, prev_hash, blob_sha256, bytes, created_at, sealed_json, record_hash, revision FROM vault_records WHERE dataset = ? AND revision > ? ORDER BY revision ASC LIMIT ?')
    .all(DEFAULT_DATASET, since, limit + 1) as unknown as VaultRow[]
  return {
    revision: readRevision(db),
    records: rows.slice(0, limit).map(viewOf),
    hasMore: rows.length > limit,
  }
}

/**
 * 读取某 writer 从 seq 起的记录索引。
 * @param db - 数据库。
 * @param writer - 设备 id。
 * @param from - 起始 seq。
 * @param limit - 最大条数。
 * @returns 记录与是否还有更多。
 */
export function readVaultStream(db: ServerDb, writer: string, from: number, limit: number): {
  writer: string
  records: VaultRecordView[]
  hasMore: boolean
} {
  const rows = db.handle
    .prepare('SELECT writer, seq, prev_hash, blob_sha256, bytes, created_at, sealed_json, record_hash, revision FROM vault_records WHERE dataset = ? AND writer = ? AND seq >= ? ORDER BY seq ASC LIMIT ?')
    .all(DEFAULT_DATASET, writer, from, limit + 1) as unknown as VaultRow[]
  return {
    writer,
    records: rows.slice(0, limit).map(viewOf),
    hasMore: rows.length > limit,
  }
}

/** 导出的 writer 校验，供 HTTP 路径使用。 */
export function validVaultWriter(writer: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(writer)
}
