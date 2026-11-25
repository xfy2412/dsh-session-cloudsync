import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevice, revokeDevice } from '../src/http.ts'
import { openDatabase } from '../src/db.ts'
import { listenServer } from './listen.mjs'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

/** 发一个 JSON 请求。 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

test('GET /v2/peers 只向设备 token 返回其他未吊销设备', async () => {
  const temp = createTempHome('server-peers')
  try {
    const db = openDatabase(temp.dataDir)
    const alpha = createDevice(db, 'alpha')
    const beta = createDevice(db, 'beta')
    const gamma = createDevice(db, 'gamma')
    assert.equal(revokeDevice(db, gamma.device.deviceId), true)
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const health = await call(base, '/health')
      assert.ok(health.body.server.capabilities.includes('plugin-version-sync'))

      const unauthorized = await call(base, '/v2/peers')
      assert.equal(unauthorized.status, 401)

      // 让 beta 产生 lastSeenAt。
      const me = await call(base, '/v2/me', { token: beta.token })
      assert.equal(me.status, 200)

      const peers = await call(base, '/v2/peers', { token: alpha.token })
      assert.equal(peers.status, 200)
      assert.deepEqual(peers.body.value.map((item) => item.deviceId), [beta.device.deviceId])
      assert.equal(peers.body.value[0].label, 'beta')
      assert.equal(typeof peers.body.value[0].lastSeenAt, 'number')
      assert.equal(peers.body.value.some((item) => item.deviceId === gamma.device.deviceId), false)

      const reverse = await call(base, '/v2/peers', { token: beta.token })
      assert.deepEqual(reverse.body.value.map((item) => item.deviceId), [alpha.device.deviceId])
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
