import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createDevice } from '../src/http.ts'
import { ensureSetupToken, openDatabase } from '../src/db.ts'
import { PROTOCOL_VERSION } from '../../shared/src/protocol.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

import { listenServer } from './listen.mjs'


test('健康检查不需要 token，并报告协议版本', async () => {
  const temp = createTempHome('server-health')
  try {
    const db = openDatabase(temp.dataDir)
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const removedV1Health = await fetch(`${base}/v1/health`)
      assert.equal(removedV1Health.status, 404)
      const removedV2Health = await fetch(`${base}/v2/health`)
      assert.equal(removedV2Health.status, 404)

      const discovery = await fetch(`${base}/health`)
      assert.equal(discovery.status, 200)
      const info = await discovery.json()
      assert.equal(info.ok, true)
      assert.equal(typeof info.server.version, 'string')
      assert.deepEqual(info.server.apiVersions, [2])
      assert.deepEqual(info.server.protocols, [PROTOCOL_VERSION])
      assert.ok(info.server.protocols.includes(PROTOCOL_VERSION))
      assert.equal(typeof info.server.schemaVersion, 'number')
      assert.ok(Array.isArray(info.server.capabilities))
      assert.ok(info.server.capabilities.includes('session-summary'))
      assert.ok(info.server.capabilities.includes('idempotent-append'))
      assert.equal(discovery.headers.get('cache-control'), 'no-store')
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('设备管理必须带 setup token', async () => {
  const temp = createTempHome('server-devices')
  try {
    const db = openDatabase(temp.dataDir)
    const setup = ensureSetupToken(db)
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const denied = await fetch(`${base}/v2/devices`, { method: 'POST', body: '{"label":"x"}' })
      assert.equal(denied.status, 401)

      const created = await fetch(`${base}/v2/devices`, {
        method: 'POST',
        headers: { authorization: `Bearer ${setup.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'PC-1' }),
      })
      assert.equal(created.status, 201)
      const createdBody = await created.json()
      assert.match(createdBody.value.token, /^[A-Za-z0-9_-]{20,}$/)
      assert.match(createdBody.value.device.deviceId, /^[0-9a-f]{16}$/)

      const listed = await fetch(`${base}/v2/devices`, { headers: { authorization: `Bearer ${setup.token}` } })
      assert.equal(listed.status, 200)
      const listedBody = await listed.json()
      assert.equal(listedBody.value.length, 1)
      assert.equal(listedBody.value[0].label, 'PC-1')
      assert.equal(listedBody.value[0].token, undefined, '设备 token 永远不会被列出')

      const me = await fetch(`${base}/v2/me`, { headers: { authorization: `Bearer ${createdBody.value.token}` } })
      assert.equal(me.status, 200)
      const meBody = await me.json()
      assert.equal(meBody.value.role, 'device')
      assert.equal(meBody.value.device.deviceId, createdBody.value.device.deviceId)

      const revoked = await fetch(`${base}/v2/devices/${createdBody.value.device.deviceId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${setup.token}` },
      })
      assert.equal(revoked.status, 200)

      const afterRevoke = await fetch(`${base}/v2/me`, { headers: { authorization: `Bearer ${createdBody.value.token}` } })
      assert.equal(afterRevoke.status, 401, '吊销后的 token 立刻失效')
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('未知路径返回 JSON 404，而不是空响应', async () => {
  const temp = createTempHome('server-404')
  try {
    const db = openDatabase(temp.dataDir)
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const response = await fetch(`${base}/v2/nope`)
      assert.equal(response.status, 404)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'not-found')
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('两次创建设备绝不会拿到同一个 token', () => {
  const temp = createTempHome('server-tokens')
  try {
    const db = openDatabase(temp.dataDir)
    try {
      const a = createDevice(db, 'a')
      const b = createDevice(db, 'b')
      assert.notEqual(a.token, b.token)
      assert.notEqual(a.device.deviceId, b.device.deviceId)
    } finally {
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('blob 上传、去重、HEAD/GET 与配额 507', async () => {
  const temp = createTempHome('server-blobs')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'blob-device')
    const { base, close } = await listenServer(db, temp.dataDir, { maxBytes: 300, maxBlobBytes: 200 })
    try {
      const auth = { authorization: `Bearer ${device.token}` }
      const body = Buffer.from('a'.repeat(100))
      const sha = createHash('sha256').update(body).digest('hex')

      const denied = await fetch(`${base}/v2/blobs`, { method: 'POST', body })
      assert.equal(denied.status, 401)

      const created = await fetch(`${base}/v2/blobs?kind=frame`, { method: 'POST', headers: auth, body })
      assert.equal(created.status, 201)
      const createdBody = await created.json()
      assert.equal(createdBody.value.sha256, sha)
      assert.equal(createdBody.value.dedup, false)

      const again = await fetch(`${base}/v2/blobs?kind=frame`, { method: 'POST', headers: auth, body })
      assert.equal(again.status, 200)
      assert.equal((await again.json()).value.dedup, true)

      const head = await fetch(`${base}/v2/blobs/${sha}`, { method: 'HEAD', headers: auth })
      assert.equal(head.status, 200)
      const missing = await fetch(`${base}/v2/blobs/${'0'.repeat(64)}`, { method: 'HEAD', headers: auth })
      assert.equal(missing.status, 404)

      const got = await fetch(`${base}/v2/blobs/${sha}`, { headers: auth })
      assert.equal(got.status, 200)
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), body)

      const tooBigForBlob = await fetch(`${base}/v2/blobs`, { method: 'POST', headers: auth, body: Buffer.alloc(250, 1) })
      assert.equal(tooBigForBlob.status, 400)

      const second = await fetch(`${base}/v2/blobs`, { method: 'POST', headers: auth, body: Buffer.alloc(150, 2) })
      assert.equal(second.status, 201)

      const overQuota = await fetch(`${base}/v2/blobs`, { method: 'POST', headers: auth, body: Buffer.alloc(100, 4) })
      assert.equal(overQuota.status, 507)
      assert.equal((await overQuota.json()).error.code, 'quota')

      const badKind = await fetch(`${base}/v2/blobs?kind=nope`, { method: 'POST', headers: auth, body: Buffer.alloc(10, 3) })
      assert.equal(badKind.status, 400)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
