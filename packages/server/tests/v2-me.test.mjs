import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevice } from '../src/http.ts'
import { openDatabase } from '../src/db.ts'
import { listenServer } from './listen.mjs'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

/**
 * 发一个请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - 方法、JSON 体、token 与 cookie。
 * @returns 状态码与响应体。
 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  if (options.cookie !== undefined) headers.cookie = options.cookie
  let body = options.body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers, body })
  const text = await response.text()
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json')
  return {
    status: response.status,
    headers: response.headers,
    body: isJson && text !== '' ? JSON.parse(text) : undefined,
  }
}

/**
 * 从响应头里取某个 cookie 的 `name=value`。
 * @param headers - 响应头。
 * @param name - cookie 名。
 * @returns cookie 头片段，或 undefined。
 */
function cookieOf(headers, name) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? '']
  const found = list.find((entry) => entry.startsWith(`${name}=`))
  return found?.split(';')[0]
}

test('GET /v2/me 返回设备、服务端与统计；PATCH 可改名', async () => {
  const temp = createTempHome('server-me')
  try {
    const db = openDatabase(temp.dataDir)
    const created = createDevice(db, 'laptop')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const health = await call(base, '/health')
      assert.ok(health.body.server.capabilities.includes('me-device-info'))
      assert.ok(health.body.server.capabilities.includes('me-counts'))
      assert.ok(health.body.server.capabilities.includes('device-rename'))

      const unauthorized = await call(base, '/v2/me')
      assert.equal(unauthorized.status, 401)

      const me = await call(base, '/v2/me', { token: created.token })
      assert.equal(me.status, 200)
      assert.equal(me.body.value.role, 'device')
      assert.equal(me.body.value.device.deviceId, created.device.deviceId)
      assert.equal(me.body.value.device.label, 'laptop')
      assert.equal(typeof me.body.value.server.version, 'string')
      assert.equal(typeof me.body.value.server.protocolVersion, 'number')
      assert.equal(typeof me.body.value.server.quotaBytes, 'number')
      assert.equal(typeof me.body.value.server.usedBytes, 'number')
      assert.deepEqual(me.body.value.counts, { workspaces: 0, sessions: 0 })

      const renamed = await call(base, '/v2/me', {
        method: 'PATCH', token: created.token, json: { label: 'workstation' },
      })
      assert.equal(renamed.status, 200)
      assert.equal(renamed.body.value.device.label, 'workstation')

      const after = await call(base, '/v2/me', { token: created.token })
      assert.equal(after.body.value.device.label, 'workstation')

      const empty = await call(base, '/v2/me', { method: 'PATCH', token: created.token, json: { label: '  ' } })
      assert.equal(empty.status, 400)

      const tooLong = await call(base, '/v2/me', {
        method: 'PATCH', token: created.token, json: { label: 'x'.repeat(65) },
      })
      assert.equal(tooLong.status, 400)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('设置 token 在 /v2/me 上被识别为 admin，而不是设备', async () => {
  const temp = createTempHome('server-me-admin')
  try {
    const db = openDatabase(temp.dataDir)
    const { base, close } = await listenServer(db, temp.dataDir, { onboardingCode: 'ABCD-EFGH' })
    try {
      const verified = await call(base, '/setup/verify', { method: 'POST', json: { code: 'ABCD-EFGH' } })
      assert.equal(verified.status, 200)
      const setupCookie = cookieOf(verified.headers, 'dsh_sync_setup')
      assert.ok(setupCookie)

      const state = await call(base, '/setup/state')
      assert.equal(state.body.value.initialized, false)

      const passwordSet = await call(base, '/setup/password', {
        method: 'POST', cookie: setupCookie, json: { password: 'secret-123' },
      })
      assert.equal(passwordSet.status, 200)
      const completed = await call(base, '/setup/complete', { method: 'POST', cookie: setupCookie })
      assert.equal(completed.status, 200)

      const login = await call(base, '/admin/login', { method: 'POST', json: { password: 'secret-123' } })
      assert.equal(login.status, 200)
      const adminCookie = cookieOf(login.headers, 'dsh_sync_admin')
      assert.ok(adminCookie)

      const device = createDevice(db, 'old-name')
      const patched = await call(base, `/admin/devices/${device.device.deviceId}`, {
        method: 'PATCH', cookie: adminCookie, json: { label: 'new-name' },
      })
      assert.equal(patched.status, 200)
      assert.equal(patched.body.value.device.label, 'new-name')

      const me = await call(base, '/v2/me', { token: device.token })
      assert.equal(me.body.value.device.label, 'new-name')
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
