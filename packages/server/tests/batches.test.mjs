import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevice } from '../src/http.ts'
import { openDatabase } from '../src/db.ts'
import { listenServer } from './listen.mjs'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import {
  headerMetaOf,
  planEventBatches,
  sealEventBatch,
  sealHeader,
} from '../../shared/src/batches.ts'
import { sessionKeyOf } from '../../shared/src/sealed-frame.ts'

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

/** 造连续事件。 */
function events(from, to) {
  return Array.from({ length: to - from + 1 }, (_, offset) => ({
    type: 'test/event',
    seq: from + offset,
    time: 1000 + from + offset,
    data: { text: `event-${from + offset}` },
  }))
}

test('服务端接受 header(entry 0) + 事件批次链，并能继续追加', async () => {
  const temp = createTempHome('server-batches')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'batch-device')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const sessionId = 'session-batch-server'
      const createdAt = 123456
      const key = sessionKeyOf(Buffer.alloc(32, 9), sessionId)
      const header = sealHeader(headerMetaOf({ version: 4, createdAt, isSeeded: false, delegationDepth: 0 }), sessionId, key)
      const first = events(0, 119)
      const plan = planEventBatches(first, -1)
      assert.deepEqual(plan.map((batch) => batch.events.length), [50, 50, 20])
      const batches = plan.map((batch, offset) => sealEventBatch(batch.events, sessionId, offset + 1, key))
      const refs = [header.ref, ...batches.map((batch) => batch.ref)]

      for (const sealed of [header, ...batches]) {
        const uploaded = await call(base, '/v1/blobs?kind=frame', { method: 'POST', token: device.token, body: sealed.bytes })
        assert.equal(uploaded.status, 201)
        assert.equal(uploaded.body.value.sha256, sealed.ref.blobSha256)
      }

      assert.equal((await call(base, '/v1/sync/lease', { method: 'POST', token: device.token })).status, 200)
      const created = await call(base, `/v1/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        json: { baseIndex: -1, baseChainHash: null, createdAt, formatVersion: 4, batches: refs },
      })
      assert.equal(created.status, 200)
      assert.equal(created.body.value.batchCount, 4)
      assert.equal(created.body.value.lastSeq, 119)

      const manifest = await call(base, `/v1/sessions/${sessionId}/manifest`, { token: device.token })
      assert.equal(manifest.status, 200)
      assert.equal(manifest.body.value.manifest.batches[0].seqFrom, -1)
      assert.equal(manifest.body.value.manifest.batches[0].seqTo, -1)
      assert.equal(manifest.body.value.manifest.batches[1].seqFrom, 0)
      assert.equal(manifest.body.value.manifest.batches[3].seqTo, 119)

      // 继续上传新增的 30 个事件，只追加一个新批次。
      const tail = events(120, 149)
      const [tailPlan] = planEventBatches(tail, 119)
      assert.ok(tailPlan !== undefined)
      const tailBatch = sealEventBatch(tailPlan.events, sessionId, 4, key)
      const uploaded = await call(base, '/v1/blobs?kind=frame', { method: 'POST', token: device.token, body: tailBatch.bytes })
      assert.equal(uploaded.status, 201)
      const appended = await call(base, `/v1/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        json: {
          baseIndex: 3,
          baseChainHash: refs[3].chainHash,
          createdAt,
          formatVersion: 4,
          batches: [tailBatch.ref],
        },
      })
      assert.equal(appended.status, 200)
      assert.equal(appended.body.value.batchCount, 5)
      assert.equal(appended.body.value.lastSeq, 149)

      const batchesPage = await call(base, `/v1/sessions/${sessionId}/batches?from=0&limit=10`, { token: device.token })
      assert.equal(batchesPage.status, 200)
      assert.equal(batchesPage.body.value.batches.length, 5)
      assert.equal(batchesPage.body.value.batches[4].seqFrom, 120)
      assert.equal(batchesPage.body.value.batches[4].seqTo, 149)
      assert.equal(batchesPage.body.value.batchCount, 5)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
