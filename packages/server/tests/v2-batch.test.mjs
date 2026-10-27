import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BLOB_BATCH_CONTENT_TYPE, decodeBlobBatch, encodeBlobBatch } from '../../shared/src/blob-batch.ts'
import { sha256 } from '../../shared/src/crypto.ts'
import { blobRecord, openDatabase } from '../src/db.ts'
import { hasBlob } from '../src/blobs.ts'
import { createDevice } from '../src/http.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

import { listenServer } from './listen.mjs'

/**
 * 发一个请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - token、方法、内容和请求头。
 * @returns 状态、响应头、文本与二进制体。
 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers, body: options.body })
  const bytes = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    headers: response.headers,
    text: bytes.toString('utf8'),
    bytes,
  }
}

test('v2 批量上传：去重、配额、哈希校验与批量下载', async () => {
  const temp = createTempHome('server-v2-batch')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'v2-batch')
    const { base, close } = await listenServer(db, temp.dataDir, { maxBytes: 200 })
    try {
      const entries = [
        { kind: 'frame', data: Buffer.from('frame-payload') },
        { kind: 'attachment', data: Buffer.from('attachment-payload') },
        { kind: 'vault', data: Buffer.from('vault-payload') },
      ]
      const encoded = encodeBlobBatch(entries)
      const uploaded = await call(base, '/v2/blobs/batch', {
        method: 'POST',
        token: device.token,
        headers: { 'content-type': BLOB_BATCH_CONTENT_TYPE },
        body: encoded,
      })
      assert.equal(uploaded.status, 200)
      const value = JSON.parse(uploaded.text).value
      assert.equal(value.blobs.length, 3)
      assert.deepEqual(value.blobs.map((blob) => blob.dedup), [false, false, false])
      for (const entry of entries) {
        const digest = sha256(entry.data)
        assert.ok(await hasBlob(temp.dataDir, digest))
        assert.equal(blobRecord(db, digest).kind, entry.kind)
      }

      const again = await call(base, '/v2/blobs/batch', {
        method: 'POST',
        token: device.token,
        body: encoded,
      })
      assert.equal(again.status, 200)
      assert.deepEqual(JSON.parse(again.text).value.blobs.map((blob) => blob.dedup), [true, true, true])

      const read = await call(base, '/v2/blobs/batch/read', {
        method: 'POST',
        token: device.token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: entries.map((entry) => sha256(entry.data)) }),
      })
      assert.equal(read.status, 200)
      assert.equal(read.headers.get('content-type'), BLOB_BATCH_CONTENT_TYPE)
      const downloaded = decodeBlobBatch(read.bytes)
      assert.deepEqual(downloaded.map((entry) => entry.data), entries.map((entry) => entry.data))
      assert.deepEqual(downloaded.map((entry) => entry.kind), ['frame', 'attachment', 'vault'])

      const missing = await call(base, '/v2/blobs/batch/read', {
        method: 'POST',
        token: device.token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: ['0'.repeat(64)] }),
      })
      assert.equal(missing.status, 404)

      const denied = await call(base, '/v2/blobs/batch', { method: 'POST', body: encoded })
      assert.equal(denied.status, 401)

      const badHashBody = Buffer.from(encoded)
      badHashBody[badHashBody.length - 1] ^= 0xff
      const badHash = await call(base, '/v2/blobs/batch', {
        method: 'POST',
        token: device.token,
        body: badHashBody,
      })
      assert.equal(badHash.status, 400)

      const tooMany = await call(base, '/v2/blobs/batch/read', {
        method: 'POST',
        token: device.token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: Array.from({ length: 65 }, () => '0'.repeat(64)) }),
      })
      assert.equal(tooMany.status, 400)

      const overQuota = await call(base, '/v2/blobs/batch', {
        method: 'POST',
        token: device.token,
        body: encodeBlobBatch([{ kind: 'frame', data: Buffer.alloc(250, 7) }]),
      })
      assert.equal(overQuota.status, 507)
      assert.equal(JSON.parse(overQuota.text).error.code, 'quota')
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
