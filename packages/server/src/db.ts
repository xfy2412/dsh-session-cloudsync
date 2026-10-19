/**
 * SQLite 表结构与打开函数。
 *
 * 服务端把元数据放 SQLite，把内容（帧、附件）放 blob 目录。
 * `dataset` 是单租户接缝：本部署恒写 `'default'`，以后多租户部署可以按账号
 * 给行加键，而不用改端点。
 *
 * @module @dsh-session-sync/server/db
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 单用户部署写入的租户键。 */
export const DEFAULT_DATASET = 'default'

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
  format_version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (dataset, session_id)
);

CREATE TABLE IF NOT EXISTS frames (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_frames (
  dataset TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  seq_from INTEGER NOT NULL,
  seq_to INTEGER NOT NULL,
  PRIMARY KEY (dataset, session_id, ordinal),
  FOREIGN KEY (sha256) REFERENCES frames (sha256)
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
  deleted_at INTEGER NOT NULL,
  deleted_by TEXT NOT NULL,
  PRIMARY KEY (dataset, session_id)
);
`

/** 一个已打开的服务端数据库。 */
export interface ServerDb {
  readonly handle: DatabaseSync
  close(): void
}

/**
 * 打开（并初始化）服务端数据库。
 * @param dataDir - 存放 `db.sqlite` 的目录。
 * @returns 已打开的数据库。
 */
export function openDatabase(dataDir: string): ServerDb {
  mkdirSync(dataDir, { recursive: true })
  const handle = new DatabaseSync(join(dataDir, 'db.sqlite'))
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA foreign_keys = ON')
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
