import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { putBlob } from '../src/blobs.ts'
import { createDevice } from '../src/http.ts'
import { openDatabase } from '../src/db.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

import { listenServer } from './listen.mjs'

/**
 * 发一个带设备 token 的 JSON 请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - token、方法、请求头与 JSON 体。
 * @returns 状态码与解析后的响应体。
 */
async function call(base, path, options = {}) {
  const headers = { 'x-client-id': '0123456789abcdef', ...options.headers }
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

/**
 * 造一个满足服务端校验的封帧条目。
 * @param index - 帧下标。
 * @param seqFrom - 起始 seq。
 * @param seqTo - 结束 seq。
 * @param bytes - 对应的 blob 字节。
 * @returns 帧引用。
 */
function frameRef(index, seqFrom, seqTo, bytes) {
  return {
    index,
    chainHash: createHash('sha256').update(`chain-${index}`).digest('hex'),
    blobSha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    sealedVersion: 1,
    keyId: '0'.repeat(16),
    seqFrom,
    seqTo,
  }
}

test('v2 append 幂等重放不依赖租约，重复 key 不同内容返回 conflict', async () => {
  const temp = createTempHome('server-v2-write')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'v2-write')
    const headerBytes = Buffer.from('header-payload')
    const bodyBytes = Buffer.from('event-payload')
    const nextBytes = Buffer.from('next-payload')
    for (const bytes of [headerBytes, bodyBytes, nextBytes]) await putBlob(temp.dataDir, bytes)

    const sessionId = 'session-v2-write'
    const createdAt = 1000
    const refs = [
      frameRef(0, -1, -1, headerBytes),
      frameRef(1, 0, 0, bodyBytes),
    ]
    const nextRef = frameRef(2, 1, 1, nextBytes)
    const body = {
      baseIndex: -1,
      baseChainHash: null,
      createdAt,
      formatVersion: 4,
      batches: refs,
    }
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const lease = await call(base, '/v2/sync/lease', { method: 'POST', token: device.token })
      assert.equal(lease.status, 200)

      const first = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'group-1' },
        json: body,
      })
      assert.equal(first.status, 200)
      assert.equal(first.body.value.batchCount, 2)
      assert.equal(first.body.value.lastSeq, 0)
      const firstRevision = first.body.value.revision

      // 释放租约后重放：原始请求已经成功，必须直接返回同一结果。
      assert.equal((await call(base, '/v2/sync/lease', { method: 'DELETE', token: device.token })).status, 200)
      const replay = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'group-1' },
        json: body,
      })
      assert.equal(replay.status, 200)
      assert.deepEqual(replay.body.value, first.body.value)
      assert.equal(replay.body.value.revision, firstRevision)

      // 键顺序变化不应改变请求哈希。
      const reordered = Object.fromEntries(Object.entries(body).reverse())
      const reorderedReplay = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'group-1' },
        json: reordered,
      })
      assert.equal(reorderedReplay.status, 200)
      assert.deepEqual(reorderedReplay.body.value, first.body.value)

      // 同一个 key 带不同内容必须拒绝，不能静默覆盖。
      const conflict = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'group-1' },
        json: { ...body, baseIndex: 0 },
      })
      assert.equal(conflict.status, 409)
      assert.equal(conflict.body.error.code, 'conflict')

      const missing = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        json: body,
      })
      assert.equal(missing.status, 400)

      const invalid = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'bad key!' },
        json: body,
      })
      assert.equal(invalid.status, 400)

      // 继续追加下一帧，然后重放旧 key，仍应返回旧结果而不是当前状态。
      assert.equal((await call(base, '/v2/sync/lease', { method: 'POST', token: device.token })).status, 200)
      const appended = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'group-2' },
        json: {
          baseIndex: 1,
          baseChainHash: refs[1].chainHash,
          createdAt,
          formatVersion: 4,
          batches: [nextRef],
        },
      })
      assert.equal(appended.status, 200)
      assert.equal(appended.body.value.batchCount, 3)
      assert.equal(appended.body.value.lastSeq, 1)

      const oldReplay = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'group-1' },
        json: body,
      })
      assert.equal(oldReplay.status, 200)
      assert.equal(oldReplay.body.value.batchCount, 2)
      assert.equal(oldReplay.body.value.revision, firstRevision)

      const summary = await call(base, `/v2/sessions/${sessionId}/summary`, { token: device.token })
      assert.equal(summary.status, 200)
      assert.equal(summary.body.value.batchCount, 3)
      assert.equal(summary.body.value.lastSeq, 1)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
