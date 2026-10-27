import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeBlobBatch } from '../../shared/src/blob-batch.ts'
import { headerMetaOf, sealEventBatch, sealHeader } from '../../shared/src/batches.ts'
import { sessionKeyOf } from '../../shared/src/sealed-frame.ts'
import { openDatabase } from '../src/db.ts'
import { createDevice } from '../src/http.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

import { listenServer } from './listen.mjs'

/**
 * 发一个带设备 token 的请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - token、方法、请求头与内容。
 * @returns 状态与解析后的 JSON。
 */
async function call(base, path, options = {}) {
  const headers = { 'x-client-id': '0123456789abcdef', ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  let body = options.body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/** 造连续事件。 */
function events(from, to) {
  return Array.from({ length: to - from + 1 }, (_, offset) => ({
    type: 'test/event',
    seq: from + offset,
    time: 1000 + from + offset,
    data: { text: `event-${from + offset}` },
  }))
}

test('v2 服务端接受 zstd 封帧并保留压缩元数据', async () => {
  const temp = createTempHome('server-v2-compression')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'v2-compression')
    const sessionId = 'session-v2-compression'
    const createdAt = 123456
    const key = sessionKeyOf(Buffer.alloc(32, 11), sessionId)
    const header = sealHeader(
      headerMetaOf({ version: 4, createdAt, isSeeded: false, delegationDepth: 0 }),
      sessionId,
      key,
      'zstd',
    )
    const batch = sealEventBatch(events(0, 49), sessionId, 1, key, 'zstd')
    assert.equal(header.ref.sealedVersion, 2)
    assert.equal(batch.ref.sealedVersion, 2)

    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const upload = await call(base, '/v2/blobs/batch', {
        method: 'POST',
        token: device.token,
        headers: { 'content-type': 'application/x-dsh-blob-batch' },
        body: encodeBlobBatch([
          { kind: 'frame', data: header.bytes },
          { kind: 'frame', data: batch.bytes },
        ]),
      })
      assert.equal(upload.status, 200)

      assert.equal((await call(base, '/v2/sync/lease', { method: 'POST', token: device.token })).status, 200)
      const appended = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'compression-1' },
        json: {
          baseIndex: -1,
          baseChainHash: null,
          createdAt,
          formatVersion: 4,
          batches: [header.ref, batch.ref],
        },
      })
      assert.equal(appended.status, 200, JSON.stringify(appended.body))
      assert.equal(appended.body.value.batchCount, 2)
      assert.equal(appended.body.value.compression, 'zstd')
      assert.equal(appended.body.value.storedBytes, header.bytes.length + batch.bytes.length)

      const summary = await call(base, `/v2/sessions/${sessionId}/summary`, { token: device.token })
      assert.equal(summary.status, 200)
      assert.equal(summary.body.value.compression, 'zstd')
      assert.equal(summary.body.value.storedBytes, header.bytes.length + batch.bytes.length)

      const list = await call(base, '/v2/sessions', { token: device.token })
      assert.equal(list.status, 200)
      const listed = list.body.value.sessions.find((session) => session.sessionId === sessionId)
      assert.equal(listed.compression, 'zstd')
      assert.equal(listed.storedBytes, header.bytes.length + batch.bytes.length)

      const changes = await call(base, '/v2/changes', { token: device.token })
      assert.equal(changes.status, 200)
      const changed = changes.body.value.sessions.find((session) => session.sessionId === sessionId)
      assert.equal(changed.compression, 'zstd')
      assert.equal(changed.storedBytes, header.bytes.length + batch.bytes.length)

      const manifest = await call(base, `/v2/sessions/${sessionId}/manifest`, { token: device.token })
      assert.equal(manifest.status, 200)
      const frames = manifest.body.value.manifest.batches
      assert.equal(frames.length, 2)
      for (const frame of frames) {
        assert.equal(frame.sealedVersion, 2)
        assert.equal(frame.compression, 'zstd')
        assert.match(frame.compressedHash, /^[0-9a-f]{64}$/u)
      }

      const health = await call(base, '/health')
      assert.ok(health.body.server.capabilities.includes('zstd-frame'))
      assert.deepEqual(health.body.server.apiVersions, [2])
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
