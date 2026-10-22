import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevice } from '../src/http.ts'
import { openDatabase } from '../src/db.ts'
import { sealVaultRecord, vaultKeyOf } from '../../shared/src/vault.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import { listenServer } from './listen.mjs'

const CLIENT_A = '0123456789abcdef'
const CLIENT_B = 'fedcba9876543210'

/**
 * 发一个 JSON 请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - 方法、token、clientId 与 JSON/原始体。
 * @returns 状态码与解析后的响应体。
 */
async function call(base, path, options = {}) {
  const headers = { 'x-client-id': options.clientId ?? CLIENT_A, ...options.headers }
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

test('Vault writer 租约、append、幂等、cursor 与 stream', async () => {
  const temp = createTempHome('server-vault')
  try {
    const db = openDatabase(temp.dataDir)
    const deviceA = createDevice(db, 'A')
    const deviceB = createDevice(db, 'B')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const vaultKey = vaultKeyOf(Buffer.alloc(32, 3))
      const writer = deviceA.device.deviceId
      const first = sealVaultRecord({
        writer,
        seq: 1,
        prevHash: null,
        createdAt: 1000,
        kind: 'device/profile',
        entity: writer,
        at: 1000,
        data: { name: 'A', os: 'test' },
        vaultKey,
      })

      assert.equal((await call(base, '/v1/blobs?kind=vault', { method: 'POST', token: deviceA.token, body: first.bytes })).status, 201)

      const body = {
        writer,
        seq: 1,
        prevHash: null,
        blobSha256: first.ref.blobSha256,
        bytes: first.ref.bytes,
        createdAt: 1000,
        sealed: first.ref.sealed,
      }

      // 没有租约不能 append。
      const noLease = await call(base, '/v1/vault/append', { method: 'POST', token: deviceA.token, json: body })
      assert.equal(noLease.status, 409)
      assert.equal(noLease.body.error.code, 'lease-held')

      // 同一 token 的第二个 client 不能抢 writer 租约。
      assert.equal((await call(base, '/v1/vault/lease', { method: 'POST', token: deviceA.token, clientId: CLIENT_A })).status, 200)
      const held = await call(base, '/v1/vault/lease', { method: 'POST', token: deviceA.token, clientId: CLIENT_B })
      assert.equal(held.status, 409)
      assert.equal(held.body.error.code, 'lease-held')

      const created = await call(base, '/v1/vault/append', { method: 'POST', token: deviceA.token, json: body })
      assert.equal(created.status, 200)
      assert.equal(created.body.value.seq, 1)
      assert.equal(created.body.value.dedup, false)
      assert.match(created.body.value.recordHash, /^[0-9a-f]{64}$/)

      // 相同内容重试是幂等的。
      const replay = await call(base, '/v1/vault/append', { method: 'POST', token: deviceA.token, json: body })
      assert.equal(replay.status, 200)
      assert.equal(replay.body.value.dedup, true)
      assert.equal(replay.body.value.recordHash, created.body.value.recordHash)

      // 同 seq 不同内容拒绝。
      const conflict = await call(base, '/v1/vault/append', {
        method: 'POST',
        token: deviceA.token,
        json: { ...body, createdAt: 1001 },
      })
      assert.equal(conflict.status, 409)
      assert.equal(conflict.body.error.code, 'conflict')

      // cursor / stream 都能看到这条记录。
      const cursor = await call(base, '/v1/vault/cursor?since=0', { token: deviceA.token })
      assert.equal(cursor.status, 200)
      assert.equal(cursor.body.value.records.length, 1)
      assert.equal(cursor.body.value.records[0].recordHash, created.body.value.recordHash)
      const stream = await call(base, `/v1/vault/stream/${writer}?from=1`, { token: deviceA.token })
      assert.equal(stream.status, 200)
      assert.equal(stream.body.value.records[0].seq, 1)

      // B 的 stream 独立：同样从 seq=1 开始，不与 A 冲突。
      const writerB = deviceB.device.deviceId
      const firstB = sealVaultRecord({
        writer: writerB,
        seq: 1,
        prevHash: null,
        createdAt: 2000,
        kind: 'device/profile',
        entity: writerB,
        at: 2000,
        data: { name: 'B' },
        vaultKey,
      })
      assert.equal((await call(base, '/v1/blobs?kind=vault', { method: 'POST', token: deviceB.token, body: firstB.bytes })).status, 201)
      assert.equal((await call(base, '/v1/vault/lease', { method: 'POST', token: deviceB.token })).status, 200)
      const createdB = await call(base, '/v1/vault/append', {
        method: 'POST',
        token: deviceB.token,
        json: {
          writer: writerB,
          seq: 1,
          prevHash: null,
          blobSha256: firstB.ref.blobSha256,
          bytes: firstB.ref.bytes,
          createdAt: 2000,
          sealed: firstB.ref.sealed,
        },
      })
      assert.equal(createdB.status, 200)
      const cursorB = await call(base, '/v1/vault/cursor?since=0', { token: deviceB.token })
      assert.equal(cursorB.body.value.records.length, 2)

      // 第二个设备不能替 A 写 A 的 stream。
      const spoof = await call(base, '/v1/vault/append', {
        method: 'POST',
        token: deviceB.token,
        json: { ...body, seq: 2, prevHash: created.body.value.recordHash },
      })
      assert.equal(spoof.status, 400)
      assert.equal(spoof.body.error.code, 'bad-request')

      // 缺 X-Client-Id 的 lease 被拒。
      const noClient = await fetch(`${base}/v1/vault/lease`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deviceA.token}` },
      })
      assert.equal(noClient.status, 400)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
