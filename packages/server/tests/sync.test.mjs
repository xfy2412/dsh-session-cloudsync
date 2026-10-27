import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { splitFrames, splitRows } from '../../shared/src/frames.ts'
import { sealFrame, sessionKeyOf } from '../../shared/src/sealed-frame.ts'
import { createDevice } from '../src/http.ts'
import { openDatabase } from '../src/db.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'tests', 'fixtures', 'sessions')

import { listenServer } from './listen.mjs'


/**
 * 发一个 JSON 请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - 方法、token 与 JSON 体或原始体。
 * @returns 状态码与解析后的响应体。
 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  headers['x-client-id'] ??= '0123456789abcdef'
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  let body = options.body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers, body })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/** 把前几帧封好，并给出每帧的 seq 区间。 */
function sealFrames(count, sessionId, key) {
  const frames = splitFrames(readFileSync(join(fixtures, 'v4-coverage.jsonl.zstd'))).slice(0, count)
  return frames.map((frame, index) => {
    const rows = splitRows(zstdDecompressSync(frame).toString('utf8')).map((row) => JSON.parse(row))
    const first = rows[0]
    const last = rows[rows.length - 1]
    const seqFrom = typeof first?.seq === 'number' ? first.seq : -1
    const seqTo = typeof last?.seq === 'number' ? last.seq : seqFrom
    return sealFrame(frame, { sessionId, index, seqFrom, seqTo }, key)
  })
}

test('租约互斥、前缀 append、尾帧替换、墓碑与 cursor', async () => {
  const temp = createTempHome('server-sync')
  try {
    const db = openDatabase(temp.dataDir)
    const deviceA = createDevice(db, 'A')
    const deviceB = createDevice(db, 'B')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const sessionId = 'session-cloudsync-test'
      const key = sessionKeyOf(Buffer.alloc(32, 5), sessionId)
      const sealed = sealFrames(4, sessionId, key)
      const refs = sealed.map((entry) => entry.ref)

      // 租约：A 先拿，B 被拒。
      assert.equal((await call(base, `/v2/sync/lease`, { method: 'POST', token: deviceA.token })).status, 200)
      const held = await call(base, `/v2/sync/lease`, { method: 'POST', token: deviceB.token })
      assert.equal(held.status, 409)
      assert.equal(held.body.error.code, 'lease-held')

      // 上传全部封帧 blob。
      for (const entry of sealed) {
        const uploaded = await call(base, '/v2/blobs?kind=frame', { method: 'POST', token: deviceA.token, body: entry.bytes })
        assert.equal(uploaded.status, 201)
        assert.equal(uploaded.body.value.sha256, entry.ref.blobSha256)
      }

      // 首次 append：从 baseIndex=-1 建立链。
      const createBody = {
        baseIndex: -1,
        baseChainHash: null,
        createdAt: 1000,
        formatVersion: 4,
        batches: refs,
      }
      const created = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: deviceA.token,
        headers: { 'idempotency-key': 'create-1' },
        json: createBody,
      })
      assert.equal(created.status, 200)
      assert.equal(created.body.value.batchCount, 4)
      assert.equal(created.body.value.headChainHash, refs[3].chainHash)
      assert.equal(created.body.value.lastSeq, refs[3].seqTo)

      // 释放租约后 append 被拒。
      assert.equal((await call(base, `/v2/sync/lease`, { method: 'DELETE', token: deviceA.token })).status, 200)
      const noLease = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: deviceA.token,
        headers: { 'idempotency-key': 'no-lease-1' },
        json: createBody,
      })
      assert.equal(noLease.status, 409)
      assert.equal(noLease.body.error.code, 'lease-held')
      // 拉取/读 manifest 不需要全局租约。
      const readWithoutLease = await call(base, `/v2/sessions/${sessionId}/manifest`, { token: deviceA.token })
      assert.equal(readWithoutLease.status, 200)

      // 重新拿租约；base 不匹配 → diverged。
      assert.equal((await call(base, `/v2/sync/lease`, { method: 'POST', token: deviceA.token })).status, 200)
      const badBase = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: deviceA.token,
        headers: { 'idempotency-key': 'bad-base-1' },
        json: { baseIndex: 2, baseChainHash: refs[1].chainHash, createdAt: 1000, formatVersion: 4, batches: [refs[2]] },
      })
      assert.equal(badBase.status, 409)
      assert.equal(badBase.body.error.code, 'diverged')

      // 尾帧替换：同一 index、新的 chainHash。
      const mutatedTail = Buffer.from(splitFrames(readFileSync(join(fixtures, 'v4-coverage.jsonl.zstd')))[3])
      mutatedTail[mutatedTail.length - 1] ^= 0xff
      const tail = sealFrame(mutatedTail, { sessionId, index: 3, seqFrom: refs[3].seqFrom, seqTo: refs[3].seqTo }, key)
      assert.equal((await call(base, '/v2/blobs?kind=frame', { method: 'POST', token: deviceA.token, body: tail.bytes })).status, 201)
      const replaced = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: deviceA.token,
        headers: { 'idempotency-key': 'replace-tail-1' },
        json: { baseIndex: 2, baseChainHash: refs[2].chainHash, createdAt: 1000, formatVersion: 4, batches: [tail.ref] },
      })
      assert.equal(replaced.status, 200)
      assert.equal(replaced.body.value.batchCount, 4)
      assert.equal(replaced.body.value.headChainHash, tail.ref.chainHash)

      // manifest 与分页帧引用。
      const manifest = await call(base, `/v2/sessions/${sessionId}/manifest`, { token: deviceA.token })
      assert.equal(manifest.status, 200)
      assert.equal(manifest.body.value.manifest.batches[3].chainHash, tail.ref.chainHash)
      const page = await call(base, `/v2/sessions/${sessionId}/batches?from=2&limit=1`, { token: deviceA.token })
      assert.equal(page.status, 200)
      assert.equal(page.body.value.batchCount, 4)
      assert.equal(page.body.value.batches[0].index, 2)

      // 墓碑：删掉后同一生命周期 append → 410。
      const deleted = await call(base, `/v2/sessions/${sessionId}/delete`, { method: 'POST', token: deviceA.token, json: { createdAt: 1000 } })
      assert.equal(deleted.status, 200)
      assert.equal(deleted.body.value.deletedAt > 0, true)
      const gone = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: deviceA.token,
        headers: { 'idempotency-key': 'gone-1' },
        json: { baseIndex: -1, baseChainHash: null, createdAt: 1000, formatVersion: 4, batches: refs },
      })
      assert.equal(gone.status, 410)
      assert.equal(gone.body.error.code, 'gone')

      // 同 id 的新生命周期可以重建。
      const recreated = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: deviceA.token,
        headers: { 'idempotency-key': 'recreate-1' },
        json: { baseIndex: -1, baseChainHash: null, createdAt: 2000, formatVersion: 4, batches: refs },
      })
      assert.equal(recreated.status, 200)

      // v2 变更流：当前活跃会话 + 旧生命周期墓碑；推进游标后无增量。
      const changes = await call(base, '/v2/changes?limit=10', { token: deviceA.token })
      assert.equal(changes.status, 200)
      assert.equal(changes.body.value.sessions.length, 1)
      assert.equal(changes.body.value.sessions[0].sessionId, sessionId)
      assert.equal(changes.body.value.sessions[0].deletedAt, null)
      assert.equal(changes.body.value.tombstones.length, 1)
      const current = await call(base, `/v2/changes?cursor=${encodeURIComponent(changes.body.value.nextCursor)}`, { token: deviceA.token })
      assert.equal(current.status, 200)
      assert.equal(current.body.value.sessions.length, 0)
      assert.equal(current.body.value.tombstones.length, 0)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('append 拒绝未上传的 blob、非法请求与错误的 X-Device-Id', async () => {
  const temp = createTempHome('server-sync-errors')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'A')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const sessionId = 'session-cloudsync-errors'
      const key = sessionKeyOf(Buffer.alloc(32, 6), sessionId)
      const sealed = sealFrames(2, sessionId, key)
      assert.equal((await call(base, `/v2/sync/lease`, { method: 'POST', token: device.token })).status, 200)

      // 没有上传 blob 的帧。
      const missing = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'missing-blob-1' },
        json: { baseIndex: -1, baseChainHash: null, createdAt: 1, formatVersion: 4, batches: sealed.map((entry) => entry.ref) },
      })
      assert.equal(missing.status, 400)

      // 非法 baseIndex。
      const bad = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'bad-base-index-1' },
        json: { baseIndex: 'x', baseChainHash: null, createdAt: 1, formatVersion: 4, batches: [] },
      })
      assert.equal(bad.status, 400)

      // X-Device-Id 与 token 不一致。
      const mismatched = await call(base, `/v2/sync/lease`, {
        method: 'POST',
        token: device.token,
        headers: { 'x-device-id': 'deadbeefdeadbeef' },
      })
      assert.equal(mismatched.status, 401)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
