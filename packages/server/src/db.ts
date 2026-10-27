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
export const SERVER_SCHEMA_VERSION = 3

const SCHEMA_VERSION = SERVER_SCHEMA_VERSION

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
  resource TEXT NOT NULL,
  device_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  PRIMARY KEY (dataset, resource)
);

CREATE TABLE IF NOT EXISTS vault_records (
  dataset TEXT NOT NULL,
  writer TEXT NOT NULL,
  seq INTEGER NOT NULL,
  prev_hash TEXT,
  blob_sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sealed_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (dataset, writer, seq)
);

CREATE INDEX IF NOT EXISTS vault_records_revision ON vault_records (dataset, revision);

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

function tableExists(handle: DatabaseSync, table: string): boolean {
  const row = handle.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { name?: string } | undefined
  return row !== undefined
}

function tableColumns(handle: DatabaseSync, table: string): Set<string> {
  const rows = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'))
}

function anyUserTable(handle: DatabaseSync): boolean {
  const row = handle.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).get() as { count?: number } | undefined
  return Number(row?.count ?? 0) > 0
}

function assertV2Sessions(handle: DatabaseSync): void {
  const columns = tableColumns(handle, 'sessions')
  const required = ['created_at', 'format_version', 'last_seq', 'frame_count', 'head_chain_hash', 'manifest_json', 'manifest_digest', 'revision', 'updated_at']
  const missing = required.filter((column) => !columns.has(column))
  if (missing.length > 0) {
    throw new Error(
      `不支持的旧数据库：sessions 缺少 ${missing.join(', ')}；请先导出现有数据，再用新数据目录重建。`,
    )
  }
}

function backupBeforeMigration(handle: DatabaseSync, dataDir: string, version: number): void {
  const target = join(dataDir, `db.sqlite.bak-v${version}-${Date.now()}`)
  handle.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
}

/**
 * 迁移旧库；只迁移明确支持的版本，不删除会话/墓碑/Vault。
 *
 * v2 → v3：租约是 60s 的瞬时状态，允许重建；新增 vault_records。
 * v0 → v3：只接受没有旧表、或已是 v2 形状的库；v1 的 frames/session_frames 直接拒绝。
 */
function migrateDatabase(handle: DatabaseSync, dataDir: string, version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new Error(`数据库结构版本 ${version} 高于服务端支持的 ${SCHEMA_VERSION}；请升级服务端，不要降级覆盖。`)
  }
  if (version === SCHEMA_VERSION) {
    handle.exec(SCHEMA)
    return
  }

  let sourceVersion = version
  if (version === 0) {
    if (!anyUserTable(handle)) {
      handle.exec(SCHEMA)
      handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      return
    }
    if (tableExists(handle, 'frames') || tableExists(handle, 'session_frames')) {
      throw new Error('检测到未版本化的旧帧结构（frames/session_frames）；该结构未作为发布版本支持，拒绝自动迁移。请导出数据后重建。')
    }
    if (!tableExists(handle, 'sessions')) {
      handle.exec(SCHEMA)
      handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      return
    }
    sourceVersion = 2
  }

  if (sourceVersion !== 2 && sourceVersion !== 3) {
    throw new Error(`不支持的数据库结构版本 ${sourceVersion}；请使用对应版本的服务端迁移。`)
  }

  assertV2Sessions(handle)
  backupBeforeMigration(handle, dataDir, sourceVersion)
  handle.exec('BEGIN IMMEDIATE')
  try {
    const leaseColumns = tableColumns(handle, 'leases')
    if (!leaseColumns.has('resource') || !leaseColumns.has('client_id')) {
      // 60s 租约是瞬时状态，不可恢复；重建它不会丢失会话/墓碑/Vault。
      handle.exec('DROP TABLE IF EXISTS leases')
    }
    handle.exec(SCHEMA)
    handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    handle.exec('COMMIT')
  } catch (error: unknown) {
    handle.exec('ROLLBACK')
    throw error
  }
}

/**
 * 打开（并初始化）服务端数据库。
 *
 * 结构版本落后时执行增量迁移；迁移前用 `VACUUM INTO` 留本地备份。
 * 不支持的旧结构直接报错，不删除会话、墓碑或 Vault。
 * @param dataDir - 存放 `db.sqlite` 的目录。
 * @returns 已打开的数据库。
 */
export function openDatabase(dataDir: string): ServerDb {
  mkdirSync(dataDir, { recursive: true })
  const handle = new DatabaseSync(join(dataDir, 'db.sqlite'))
  try {
    handle.exec('PRAGMA journal_mode = WAL')
    handle.exec('PRAGMA foreign_keys = ON')
    const versionRow = handle.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    migrateDatabase(handle, dataDir, Number(versionRow?.user_version ?? 0))
    return { handle, close: () => handle.close() }
  } catch (error: unknown) {
    handle.close()
    throw error
  }
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
