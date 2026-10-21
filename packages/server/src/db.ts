/**
 * SQLite 表结构与打开函数。
 *
 * 服务端把元数据放 SQLite，把内容（封帧、附件）放 blob 目录。
 * `dataset` 是单租户接缝：本部署恒写 `'default'`，以后多租户部署可以按账号
 * 给行加键，而不用改端点。
 *
 * 会话 manifest 以**整份 JSON** 存在 `sessions.manifest_json`；服务端不解析
 * 事件内容，只校验形状与哈希。`revision` 是全局单调计数器，供 cursor 增量。
 *
 * @module @dsh-session-cloudsync/server/db
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 单用户部署写入的租户键。 */
export const DEFAULT_DATASET = 'default'

/** 当前库结构版本；结构有破坏性变化时递增。 */
const SCHEMA_VERSION = 2

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  dataset TEXT NOT NULL,
  device_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  PRIMARY KEY (dataset, device_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  dataset TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  format_version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  frame_count INTEGER NOT NULL,
  head_chain_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (dataset, session_id)
);

CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  dataset TEXT NOT NULL,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  PRIMARY KEY (dataset, session_id)
);

CREATE TABLE IF NOT EXISTS tombstones (
  dataset TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  deleted_by TEXT NOT NULL,
  PRIMARY KEY (dataset, session_id, created_at)
);
`

/** 一个已打开的服务端数据库。 */
export interface ServerDb {
  readonly handle: DatabaseSync
  close(): void
}

/**
 * 打开（并初始化）服务端数据库。
 *
 * 结构版本落后时只重建会话/租约/墓碑相关表；设备与 blob 记录保留。
 * @param dataDir - 存放 `db.sqlite` 的目录。
 * @returns 已打开的数据库。
 */
export function openDatabase(dataDir: string): ServerDb {
  mkdirSync(dataDir, { recursive: true })
  const handle = new DatabaseSync(join(dataDir, 'db.sqlite'))
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA foreign_keys = ON')
  const versionRow = handle.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const version = Number(versionRow?.user_version ?? 0)
  if (version < SCHEMA_VERSION) {
    // M2 之前没有真实部署；旧结构直接重建（设备、blob、meta 不受影响）。
    handle.exec('DROP TABLE IF EXISTS session_frames; DROP TABLE IF EXISTS frames; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS leases; DROP TABLE IF EXISTS tombstones;')
    handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
  handle.exec(SCHEMA)
  return { handle, close: () => handle.close() }
}

/**
 * 读取一个 meta 值。
 * @param db - 已打开的数据库。
 * @param key - meta 键。
 * @returns 存的值，或 undefined。
 */
export function readMeta(db: ServerDb, key: string): string | undefined {
  const row = db.handle.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
  return row?.value
}

/**
 * 写入一个 meta 值。
 * @param db - 已打开的数据库。
 * @param key - meta 键。
 * @param value - 要存的值。
 */
export function writeMeta(db: ServerDb, key: string, value: string): void {
  db.handle.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/**
 * 读取 setup token，首次使用时生成。
 * @param db - 已打开的数据库。
 * @returns token 以及本次调用是否刚创建它。
 */
export function ensureSetupToken(db: ServerDb): { token: string; created: boolean } {
  const existing = readMeta(db, 'setup_token')
  if (existing !== undefined) return { token: existing, created: false }
  const token = randomBytes(32).toString('base64url')
  writeMeta(db, 'setup_token', token)
  return { token, created: true }
}

/**
 * 管理台是否已完成初始化（向导走完）。
 * @param db - 已打开的数据库。
 * @returns 已初始化时为 true。
 */
export function isAdminInitialized(db: ServerDb): boolean {
  return readMeta(db, 'admin_initialized') === 'true'
}

/**
 * 标记管理台初始化完成。
 * @param db - 已打开的数据库。
 */
export function markAdminInitialized(db: ServerDb): void {
  writeMeta(db, 'admin_initialized', 'true')
}

/**
 * 读取管理台密码的哈希与盐。
 * @param db - 已打开的数据库。
 * @returns 十六进制哈希与盐，或 undefined。
 */
export function adminPassword(db: ServerDb): { hash: string; salt: string } | undefined {
  const hash = readMeta(db, 'admin_password_hash')
  const salt = readMeta(db, 'admin_password_salt')
  return hash === undefined || salt === undefined ? undefined : { hash, salt }
}

/**
 * 写入管理台密码的哈希与盐（不改变初始化状态）。
 * @param db - 已打开的数据库。
 * @param hash - 十六进制哈希。
 * @param salt - 十六进制盐。
 */
export function setAdminPassword(db: ServerDb, hash: string, salt: string): void {
  writeMeta(db, 'admin_password_hash', hash)
  writeMeta(db, 'admin_password_salt', salt)
}

/**
 * 清除管理台密码，并回到未初始化状态。
 * @param db - 已打开的数据库。
 */
export function clearAdminPassword(db: ServerDb): void {
  db.handle.prepare("DELETE FROM meta WHERE key IN ('admin_password_hash', 'admin_password_salt', 'admin_initialized')").run()
}

/**
 * 读取生效的存储配额。
 * @param db - 已打开的数据库。
 * @param fallback - 没有配置时的默认值。
 * @returns 配额字节数。
 */
export function readMaxBytes(db: ServerDb, fallback: number): number {
  const value = readMeta(db, 'max_bytes')
  const parsed = Number(value)
  return value !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * 写入存储配额。
 * @param db - 已打开的数据库。
 * @param maxBytes - 配额字节数。
 */
export function writeMaxBytes(db: ServerDb, maxBytes: number): void {
  writeMeta(db, 'max_bytes', String(maxBytes))
}

/**
 * 读取当前全局 revision。
 * @param db - 已打开的数据库。
 * @returns 当前值；未初始化时为 0。
 */
export function readRevision(db: ServerDb): number {
  return Number(readMeta(db, 'revision') ?? '0')
}

/**
 * 把全局 revision 加一并返回新值。
 * @param db - 已打开的数据库。
 * @returns 新 revision。
 */
export function bumpRevision(db: ServerDb): number {
  const row = db.handle
    .prepare("INSERT INTO meta (key, value) VALUES ('revision', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT) RETURNING CAST(value AS INTEGER) AS revision")
    .get() as { revision?: number } | undefined
  return Number(row?.revision ?? 1)
}

/**
 * 已占用的 blob 字节总数。
 * @param db - 已打开的数据库。
 * @returns 唯一 blob 的字节和。
 */
export function usedBlobBytes(db: ServerDb): number {
  const row = db.handle.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM blobs').get() as { total?: number } | undefined
  return Number(row?.total ?? 0)
}

/**
 * 在写事务里执行一个函数。
 * @param db - 已打开的数据库。
 * @param fn - 要执行的操作。
 * @returns 操作结果。
 */
export function withTransaction<T>(db: ServerDb, fn: () => T): T {
  db.handle.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.handle.exec('COMMIT')
    return result
  } catch (error) {
    db.handle.exec('ROLLBACK')
    throw error
  }
}

/**
 * 查一个 blob 的登记行。
 * @param db - 已打开的数据库。
 * @param sha256 - 内容哈希。
 * @returns 字节数与类别，或 undefined。
 */
export function blobRecord(db: ServerDb, sha256: string): { bytes: number; kind: string } | undefined {
  const row = db.handle.prepare('SELECT bytes, kind FROM blobs WHERE sha256 = ?').get(sha256) as { bytes?: number; kind?: string } | undefined
  return row === undefined ? undefined : { bytes: Number(row.bytes), kind: String(row.kind) }
}

/**
 * 登记一个已存储的 blob。
 * @param db - 已打开的数据库。
 * @param sha256 - 内容哈希。
 * @param bytes - 字节数。
 * @param kind - 类别（frame / attachment）。
 */
export function recordBlob(db: ServerDb, sha256: string, bytes: number, kind: string): void {
  db.handle
    .prepare('INSERT OR IGNORE INTO blobs (sha256, bytes, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256, bytes, kind, Date.now())
}
