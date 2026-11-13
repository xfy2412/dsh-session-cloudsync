import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SERVER_SCHEMA_VERSION, openDatabase } from '../src/db.ts'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dscs-db-'))
}

function createV2Database(dir) {
  const raw = new DatabaseSync(join(dir, 'db.sqlite'))
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE devices (
      dataset TEXT NOT NULL, device_id TEXT NOT NULL, label TEXT NOT NULL,
      token_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_seen_at INTEGER, revoked_at INTEGER,
      PRIMARY KEY (dataset, device_id)
    );
    CREATE TABLE sessions (
      dataset TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      format_version INTEGER NOT NULL, last_seq INTEGER NOT NULL, frame_count INTEGER NOT NULL,
      head_chain_hash TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_digest TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      PRIMARY KEY (dataset, session_id)
    );
    CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE leases (
      dataset TEXT NOT NULL, session_id TEXT NOT NULL, device_id TEXT NOT NULL,
      lease_until INTEGER NOT NULL, PRIMARY KEY (dataset, session_id)
    );
    CREATE TABLE tombstones (
      dataset TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      deleted_at INTEGER NOT NULL, deleted_by TEXT NOT NULL,
      PRIMARY KEY (dataset, session_id, created_at)
    );
    INSERT INTO sessions VALUES ('default','kept-session',1,4,2,1,'head','{}','digest',7,2,NULL);
    INSERT INTO tombstones VALUES ('default','kept-session',1,2,'device');
    INSERT INTO leases VALUES ('default','old-lease','device',9999999999999);
    PRAGMA user_version = 2;
  `)
  raw.close()
}

test('数据库迁移：v2 → v6 保留会话/墓碑并新增 Vault、幂等表、删除列与历史表，重建瞬时租约', () => {
  const dir = tempDir()
  try {
    createV2Database(dir)
    const db = openDatabase(dir)
    try {
      const version = db.handle.prepare('PRAGMA user_version').get()
      assert.equal(version.user_version, SERVER_SCHEMA_VERSION)
      const session = db.handle.prepare('SELECT session_id, last_seq, compression, stored_bytes FROM sessions').get()
      assert.equal(session.session_id, 'kept-session')
      assert.equal(session.last_seq, 2)
      assert.equal(session.compression, 'none')
      assert.equal(session.stored_bytes, 0)
      const sessionColumns = db.handle.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name)
      assert.ok(sessionColumns.includes('purged_at'))
      assert.ok(db.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_resets'").get())
      const tombstone = db.handle.prepare('SELECT session_id FROM tombstones').get()
      assert.equal(tombstone.session_id, 'kept-session')
      assert.ok(db.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vault_records'").get())
      assert.ok(db.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='append_requests'").get())
      const leaseColumns = db.handle.prepare('PRAGMA table_info(leases)').all().map((row) => row.name)
      assert.ok(leaseColumns.includes('resource'))
      assert.ok(leaseColumns.includes('client_id'))
      assert.ok(readdirSync(dir).some((name) => name.startsWith('db.sqlite.bak-v2-')))
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('数据库迁移：回填混合压缩状态与密文字节数', () => {
  const dir = tempDir()
  try {
    createV2Database(dir)
    const raw = new DatabaseSync(join(dir, 'db.sqlite'))
    raw.prepare(`INSERT INTO sessions
      (dataset, session_id, created_at, format_version, last_seq, frame_count,
       head_chain_hash, manifest_json, manifest_digest, revision, updated_at, deleted_at)
      VALUES ('default', 'mixed-session', 1, 4, 0, 2, 'head', ?, 'digest', 1, 1, NULL)`)
      .run(JSON.stringify({ frames: [{ bytes: 10 }, { bytes: 20, compression: 'zstd' }] }))
    raw.close()

    const db = openDatabase(dir)
    try {
      const row = db.handle.prepare('SELECT compression, stored_bytes FROM sessions WHERE session_id = ?').get('mixed-session')
      assert.equal(row.compression, 'mixed')
      assert.equal(row.stored_bytes, 30)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('数据库迁移：v3 → v6 只新增幂等/历史表，不动旧数据', () => {
  const dir = tempDir()
  try {
    const first = openDatabase(dir)
    try {
      first.handle.exec('DROP TABLE IF EXISTS append_requests')
      first.handle.exec('PRAGMA user_version = 3')
    } finally {
      first.close()
    }
    const db = openDatabase(dir)
    try {
      const version = db.handle.prepare('PRAGMA user_version').get()
      assert.equal(version.user_version, SERVER_SCHEMA_VERSION)
      assert.ok(db.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='append_requests'").get())
      assert.ok(readdirSync(dir).some((name) => name.startsWith('db.sqlite.bak-v3-')))
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('数据库迁移：新库直接创建 v6', () => {
  const dir = tempDir()
  try {
    const db = openDatabase(dir)
    try {
      const version = db.handle.prepare('PRAGMA user_version').get()
      assert.equal(version.user_version, SERVER_SCHEMA_VERSION)
      assert.ok(db.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get())
      assert.ok(db.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='append_requests'").get())
    } finally {
      db.close()
    }
    assert.equal(existsSync(join(dir, 'db.sqlite')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('数据库迁移：更高版本 fail-closed 且不修改数据库', () => {
  const dir = tempDir()
  try {
    const raw = new DatabaseSync(join(dir, 'db.sqlite'))
    raw.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
      INSERT INTO sessions VALUES ('must-survive');
      PRAGMA user_version = 99;
    `)
    raw.close()
    assert.throws(() => openDatabase(dir), /高于服务端支持/)
    const check = new DatabaseSync(join(dir, 'db.sqlite'))
    try {
      const version = check.prepare('PRAGMA user_version').get()
      assert.equal(version.user_version, 99)
      assert.equal(check.prepare('SELECT session_id FROM sessions').get().session_id, 'must-survive')
    } finally {
      check.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('数据库迁移：旧帧结构拒绝自动迁移，不删表', () => {
  const dir = tempDir()
  try {
    const raw = new DatabaseSync(join(dir, 'db.sqlite'))
    raw.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
      INSERT INTO sessions VALUES ('must-survive');
      CREATE TABLE frames (sha256 TEXT PRIMARY KEY);
      CREATE TABLE session_frames (session_id TEXT);
    `)
    raw.close()
    assert.throws(() => openDatabase(dir), /frames\/session_frames/)
    const check = new DatabaseSync(join(dir, 'db.sqlite'))
    try {
      assert.equal(check.prepare('SELECT session_id FROM sessions').get().session_id, 'must-survive')
    } finally {
      check.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v5 → v6 从 append_requests 回填会话历史', () => {
  const dir = tempDir()
  try {
    const first = openDatabase(dir)
    first.handle.exec("DELETE FROM meta WHERE key = 'session_events_backfill'")
    first.handle.exec('DELETE FROM session_events')
    const insert = first.handle.prepare(`INSERT INTO append_requests
      (dataset, device_id, session_id, idempotency_key, request_hash, result_json, created_at)
      VALUES ('default', 'device-a', 'session-backfill', ?, 'hash', ?, ?)`)
    insert.run('key-1', JSON.stringify({ lastSeq: 100, storedBytes: 1000, batchCount: 2 }), 1000)
    insert.run('key-2', JSON.stringify({ lastSeq: 150, storedBytes: 1500, batchCount: 3 }), 2000)
    first.handle.exec('PRAGMA user_version = 5')
    first.close()

    const db = openDatabase(dir)
    try {
      const events = db.handle.prepare('SELECT kind, events, bytes, device_id FROM session_events ORDER BY id').all()
      assert.equal(events.length, 2)
      assert.equal(events[0].kind, 'create')
      assert.equal(events[0].events, 100)
      assert.equal(events[0].bytes, 1000)
      assert.equal(events[0].device_id, 'device-a')
      assert.equal(events[1].kind, 'append')
      assert.equal(events[1].events, 50)
      assert.equal(events[1].bytes, 500)
      assert.equal(db.handle.prepare('PRAGMA user_version').get().user_version, SERVER_SCHEMA_VERSION)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
