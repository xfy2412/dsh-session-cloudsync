import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createDevice } from '../src/http.ts'
import { openDatabase } from '../src/db.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

import { listenServer } from './listen.mjs'

const HEX64 = '0'.repeat(64)

/**
 * 发一个带设备 token 的请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - token、方法与请求头。
 * @returns 状态码、响应头与 JSON 响应体。
 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? undefined : JSON.parse(text),
  }
}

/**
 * 生成稳定的摘要。
 * @param value - 输入文本。
 * @returns 64 位十六进制。
 */
function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 构造一个最小 manifest；只包含 v2 摘要和批次分页会用到的字段。
 * @param sessionId - 会话 id。
 * @param options - 覆盖字段。
 * @returns manifest JSON。
 */
function manifestFor(sessionId, options = {}) {
  const lastSeq = options.lastSeq ?? 10
  const frames = options.frames ?? []
  return JSON.stringify({
    sessionId,
    formatVersion: 4,
    createdAt: options.createdAt ?? 1,
    lastSeq,
    ...(options.workspaceKey === undefined ? {} : { workspaceKey: options.workspaceKey }),
    ...(options.tailOpen === undefined ? {} : { tailOpen: options.tailOpen }),
    ...(options.safeThroughSeq === undefined ? {} : { safeThroughSeq: options.safeThroughSeq }),
    frames,
    updatedAt: options.updatedAt ?? 1,
    ...(options.deletedAt === undefined ? {} : { deletedAt: options.deletedAt }),
  })
}

/**
 * 直接写入一条会话行，避免 v2 只读测试依赖 blob 上传。
 * @param db - 已打开的数据库。
 * @param options - 会话字段。
 * @returns 写入的 manifestDigest。
 */
function insertSession(db, options) {
  const manifestDigest = digest(`${options.sessionId}:${options.revision}`)
  const headChainHash = digest(`head:${options.sessionId}`)
  const frames = options.frames ?? []
  db.handle.prepare(`INSERT INTO sessions
    (dataset, session_id, created_at, format_version, last_seq, frame_count, head_chain_hash,
     manifest_json, manifest_digest, revision, updated_at, deleted_at)
    VALUES ('default', ?, ?, 4, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      options.sessionId,
      options.createdAt ?? 1,
      options.lastSeq ?? 10,
      frames.length,
      headChainHash,
      manifestFor(options.sessionId, options),
      manifestDigest,
      options.revision,
      options.updatedAt ?? options.revision,
      options.deletedAt ?? null,
    )
  return { manifestDigest, headChainHash }
}

/**
 * 把全局 revision 对齐到测试直接写入的最大值。
 * @param db - 已打开的数据库。
 * @param revision - 当前 revision。
 */
function setRevision(db, revision) {
  db.handle.prepare("INSERT INTO meta (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(revision))
}

/**
 * 写入一条墓碑。
 * @param db - 已打开的数据库。
 * @param sessionId - 会话 id。
 * @param createdAt - 生命周期。
 * @param deletedAt - 删除时间。
 */
function insertTombstone(db, sessionId, createdAt, deletedAt) {
  db.handle.prepare(`INSERT INTO tombstones (dataset, session_id, created_at, deleted_at, deleted_by)
    VALUES ('default', ?, ?, ?, 'test')`)
    .run(sessionId, createdAt, deletedAt)
}

test('v2 全量快照分页完整，且 v1 路由已移除', async () => {
  const temp = createTempHome('server-v2-snapshot')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'v2-snapshot')
    for (let index = 0; index < 205; index += 1) {
      const sessionId = `session-v2-${String(index).padStart(3, '0')}`
      insertSession(db, {
        sessionId,
        revision: index + 1,
        workspaceKey: index < 2 ? `workspace-${index}` : undefined,
        tailOpen: index === 0,
        safeThroughSeq: index === 0 ? 9 : undefined,
      })
    }
    insertSession(db, { sessionId: 'session-v2-deleted', revision: 300, deletedAt: 300 })
    setRevision(db, 300)
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const seen = new Set()
      let cursor = null
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const query = cursor === null ? '?limit=50' : `?limit=50&cursor=${encodeURIComponent(cursor)}`
        const page = await call(base, `/v2/sessions${query}`, { token: device.token })
        assert.equal(page.status, 200)
        assert.equal(page.body.ok, true)
        for (const session of page.body.value.sessions) {
          assert.equal(seen.has(session.sessionId), false, '快照不能重复会话')
          seen.add(session.sessionId)
          assert.equal(Object.hasOwn(session, 'frames'), false, '快照不能带完整批次')
        }
        cursor = page.body.value.nextCursor
        if (cursor === null) break
      }
      assert.equal(seen.size, 205)
      assert.equal(cursor, null)
      assert.equal(seen.has('session-v2-deleted'), false)

      const first = await call(base, '/v2/sessions?limit=1', { token: device.token })
      assert.equal(first.body.value.sessions[0].workspaceKey, 'workspace-0')
      assert.equal(first.body.value.sessions[0].tailOpen, true)
      assert.equal(first.body.value.sessions[0].safeThroughSeq, 9)
      assert.equal(first.body.value.sessions[0].compression, 'none')
      assert.equal(first.body.value.sessions[0].storedBytes, 0)

      const removedCursor = await call(base, '/v1/cursor?since=0&limit=2', { token: device.token })
      assert.equal(removedCursor.status, 404)

      const health = await call(base, '/health')
      assert.deepEqual(health.body.server.apiVersions, [2])
      assert.deepEqual(health.body.server.protocols, [3])
      assert.ok(health.body.server.capabilities.includes('session-summary'))

      const malformed = await call(base, '/v2/sessions?cursor=not-a-cursor', { token: device.token })
      assert.equal(malformed.status, 400)
      assert.equal(malformed.body.error.code, 'bad-request')

      // 没有墓碑时游标仍带空墓碑哨兵，第二次请求必须能继续用。
      const changes = await call(base, '/v2/changes?limit=1', { token: device.token })
      assert.equal(changes.status, 200)
      const continued = await call(base, `/v2/changes?limit=1&cursor=${encodeURIComponent(changes.body.value.nextCursor)}`, { token: device.token })
      assert.equal(continued.status, 200)
      assert.equal(continued.body.value.sessions.length, 1)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('v2 变更流分开推进会话与墓碑游标，且不漏项', async () => {
  const temp = createTempHome('server-v2-changes')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'v2-changes')
    for (let index = 0; index < 5; index += 1) {
      insertSession(db, {
        sessionId: `session-change-${index}`,
        revision: index + 1,
        ...(index === 2 ? { deletedAt: index + 1 } : {}),
      })
    }
    insertTombstone(db, 'session-change-2', 1, 3)
    setRevision(db, 5)
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const first = await call(base, '/v2/changes?limit=2', { token: device.token })
      assert.equal(first.status, 200)
      assert.deepEqual(first.body.value.sessions.map((session) => session.revision), [1, 2])
      assert.deepEqual(first.body.value.tombstones.map((tombstone) => tombstone.deletedAt), [3])
      assert.equal(first.body.value.hasMore, true)
      assert.equal(typeof first.body.value.nextCursor, 'string')

      const second = await call(base, `/v2/changes?limit=2&cursor=${encodeURIComponent(first.body.value.nextCursor)}`, { token: device.token })
      assert.deepEqual(second.body.value.sessions.map((session) => session.revision), [4, 5])
      assert.deepEqual(second.body.value.tombstones, [])
      assert.equal(second.body.value.hasMore, false)

      const tail = second.body.value.nextCursor
      const empty = await call(base, `/v2/changes?cursor=${encodeURIComponent(tail)}`, { token: device.token })
      assert.deepEqual(empty.body.value.sessions, [])
      assert.deepEqual(empty.body.value.tombstones, [])
      assert.equal(empty.body.value.hasMore, false)

      insertSession(db, { sessionId: 'session-change-new', revision: 6 })
      setRevision(db, 6)
      insertTombstone(db, 'session-change-dead', 7, 7)
      const next = await call(base, `/v2/changes?cursor=${encodeURIComponent(tail)}`, { token: device.token })
      assert.deepEqual(next.body.value.sessions.map((session) => session.sessionId), ['session-change-new'])
      assert.deepEqual(next.body.value.tombstones.map((tombstone) => tombstone.sessionId), ['session-change-dead'])
      assert.equal(next.body.value.hasMore, false)

      // 同一毫秒删除两条墓碑时，单靠 deletedAt 做游标会漏掉第二条；
      // v2 用 (deletedAt, sessionId, createdAt) 继续翻页。
      insertTombstone(db, 'session-dead-a', 1, 9)
      insertTombstone(db, 'session-dead-b', 1, 9)
      const collisionFirst = await call(base, `/v2/changes?limit=1&cursor=${encodeURIComponent(next.body.value.nextCursor)}`, { token: device.token })
      assert.deepEqual(collisionFirst.body.value.tombstones.map((tombstone) => tombstone.sessionId), ['session-dead-a'])
      assert.equal(collisionFirst.body.value.hasMore, true)
      const collisionSecond = await call(base, `/v2/changes?limit=1&cursor=${encodeURIComponent(collisionFirst.body.value.nextCursor)}`, { token: device.token })
      assert.deepEqual(collisionSecond.body.value.tombstones.map((tombstone) => tombstone.sessionId), ['session-dead-b'])
      assert.equal(collisionSecond.body.value.hasMore, false)

      const bad = await call(base, '/v2/changes?cursor=bad', { token: device.token })
      assert.equal(bad.status, 400)

      const wrongShape = await call(base, `/v2/changes?cursor=${encodeURIComponent(Buffer.from('{"v":2,"revision":1}').toString('base64url'))}`, { token: device.token })
      assert.equal(wrongShape.status, 400)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('v2 摘要支持 ETag / 304，且不返回完整 manifest', async () => {
  const temp = createTempHome('server-v2-summary')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'v2-summary')
    const { manifestDigest } = insertSession(db, {
      sessionId: 'session-summary',
      revision: 7,
      workspaceKey: 'workspace-summary',
      safeThroughSeq: 8,
      tailOpen: true,
    })
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const summary = await call(base, '/v2/sessions/session-summary/summary', { token: device.token })
      assert.equal(summary.status, 200)
      assert.equal(summary.body.value.sessionId, 'session-summary')
      assert.equal(summary.body.value.workspaceKey, 'workspace-summary')
      assert.equal(summary.body.value.safeThroughSeq, 8)
      assert.equal(summary.body.value.tailOpen, true)
      assert.equal(Object.hasOwn(summary.body.value, 'batches'), false)
      assert.equal(summary.headers.get('etag'), `"${manifestDigest}"`)

      const cached = await call(base, '/v2/sessions/session-summary/summary', {
        token: device.token,
        headers: { 'if-none-match': `"${manifestDigest}"` },
      })
      assert.equal(cached.status, 304)
      assert.equal(cached.body, undefined)

      const changed = await call(base, '/v2/sessions/session-summary/summary', {
        token: device.token,
        headers: { 'if-none-match': '"0000000000000000000000000000000000000000000000000000000000000000"' },
      })
      assert.equal(changed.status, 200)

      const missing = await call(base, '/v2/sessions/no-such-session/summary', { token: device.token })
      assert.equal(missing.status, 404)
      assert.equal(missing.body.error.code, 'not-found')

      const denied = await call(base, '/v2/sessions/session-summary/summary')
      assert.equal(denied.status, 401)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('v2 批次分页校验 expectedManifestDigest，但仍返回批次引用', async () => {
  const temp = createTempHome('server-v2-batches')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'v2-batches')
    const frames = [
      { index: 0, chainHash: HEX64, blobSha256: HEX64, bytes: 10, sealedVersion: 1, keyId: '0'.repeat(16), seqFrom: -1, seqTo: -1 },
      { index: 1, chainHash: '1'.repeat(64), blobSha256: '2'.repeat(64), bytes: 20, sealedVersion: 1, keyId: '0'.repeat(16), seqFrom: 0, seqTo: 10 },
    ]
    const { manifestDigest } = insertSession(db, {
      sessionId: 'session-batches',
      revision: 4,
      frames,
      lastSeq: 10,
    })
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const page = await call(base, `/v2/sessions/session-batches/batches?from=1&limit=1&expectedManifestDigest=${manifestDigest}`, { token: device.token })
      assert.equal(page.status, 200)
      assert.equal(page.body.value.batchCount, 2)
      assert.equal(page.body.value.manifestDigest, manifestDigest)
      assert.equal(page.body.value.batches.length, 1)
      assert.equal(page.body.value.batches[0].index, 1)

      const mismatch = await call(base, `/v2/sessions/session-batches/batches?expectedManifestDigest=${'f'.repeat(64)}`, { token: device.token })
      assert.equal(mismatch.status, 409)
      assert.equal(mismatch.body.error.code, 'conflict')

      const malformed = await call(base, '/v2/sessions/session-batches/batches?expectedManifestDigest=nope', { token: device.token })
      assert.equal(malformed.status, 400)

      const missing = await call(base, '/v2/sessions/no-such-session/batches', { token: device.token })
      assert.equal(missing.status, 404)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
