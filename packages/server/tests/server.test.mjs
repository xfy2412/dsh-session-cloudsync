import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevice, createHttpServer } from '../src/http.ts'
import { ensureSetupToken, openDatabase } from '../src/db.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

/**
 * 在操作系统分配的端口上启动服务。
 * @param db - 已打开的数据库。
 * @param dataDir - 服务端数据目录。
 * @returns 基地址与关闭函数。
 */
async function listen(db, dataDir) {
  const server = createHttpServer({ db, dataDir })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('健康检查不需要 token，并报告协议版本', async () => {
  const temp = createTempHome('server-health')
  try {
    const db = openDatabase(temp.dataDir)
    const { base, close } = await listen(db, temp.dataDir)
    try {
      const response = await fetch(`${base}/v1/health`)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.protocol, 1)
      assert.equal(typeof body.now, 'number')
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
    const { base, close } = await listen(db, temp.dataDir)
    try {
      const denied = await fetch(`${base}/v1/devices`, { method: 'POST', body: '{"label":"x"}' })
      assert.equal(denied.status, 401)

      const created = await fetch(`${base}/v1/devices`, {
        method: 'POST',
        headers: { authorization: `Bearer ${setup.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'PC-1' }),
      })
      assert.equal(created.status, 201)
      const createdBody = await created.json()
      assert.match(createdBody.value.token, /^[A-Za-z0-9_-]{20,}$/)
      assert.match(createdBody.value.device.deviceId, /^[0-9a-f]{16}$/)

      const listed = await fetch(`${base}/v1/devices`, { headers: { authorization: `Bearer ${setup.token}` } })
      assert.equal(listed.status, 200)
      const listedBody = await listed.json()
      assert.equal(listedBody.value.length, 1)
      assert.equal(listedBody.value[0].label, 'PC-1')
      assert.equal(listedBody.value[0].token, undefined, '设备 token 永远不会被列出')

      const me = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${createdBody.value.token}` } })
      assert.equal(me.status, 200)
      const meBody = await me.json()
      assert.equal(meBody.value.role, 'device')
      assert.equal(meBody.value.device.deviceId, createdBody.value.device.deviceId)

      const revoked = await fetch(`${base}/v1/devices/${createdBody.value.device.deviceId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${setup.token}` },
      })
      assert.equal(revoked.status, 200)

      const afterRevoke = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${createdBody.value.token}` } })
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
    const { base, close } = await listen(db, temp.dataDir)
    try {
      const response = await fetch(`${base}/v1/nope`)
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
