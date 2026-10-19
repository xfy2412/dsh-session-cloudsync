import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from '../src/db.ts'
import { listenServer } from './listen.mjs'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

/**
 * 发一个请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - 方法、JSON 体与 cookie。
 * @returns 状态码、响应体与响应头。
 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  if (options.cookie !== undefined) headers.cookie = options.cookie
  let body = options.body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers, body, redirect: options.redirect ?? 'follow' })
  const text = await response.text()
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json')
  return {
    status: response.status,
    headers: response.headers,
    location: response.headers.get('location'),
    text,
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

test('首次初始化向导：密钥 → 密码 → 配额 → 设备 → 完成，之后用密码登录', async () => {
  const temp = createTempHome('server-onboarding')
  try {
    const db = openDatabase(temp.dataDir)
    const { base, close } = await listenServer(db, temp.dataDir, { onboardingCode: 'ABCD-EFGH' })
    try {
      // 未初始化：/admin 跳 /setup，/setup 可访问。
      const adminBefore = await call(base, '/admin', { redirect: 'manual' })
      assert.equal(adminBefore.status, 302)
      assert.equal(adminBefore.location, '/setup')
      const setupPage = await call(base, '/setup')
      assert.equal(setupPage.status, 200)
      assert.match(setupPage.headers.get('content-type') ?? '', /text\/html/u)

      const state0 = await call(base, '/setup/state')
      assert.equal(state0.body.value.initialized, false)

      // 密钥错误 / 正确（允许小写与分隔符）。
      assert.equal((await call(base, '/setup/verify', { method: 'POST', json: { code: 'NOPE' } })).status, 401)
      const verified = await call(base, '/setup/verify', { method: 'POST', json: { code: 'abcd efgh' } })
      assert.equal(verified.status, 200)
      const setupCookie = cookieOf(verified.headers, 'dsh_sync_setup')
      assert.ok(setupCookie !== undefined)

      // 密码策略：至少 6 位，字母/数字/特殊字符至少两类。
      const weak = await call(base, '/setup/password', { method: 'POST', cookie: setupCookie, json: { password: 'abcdef' } })
      assert.equal(weak.status, 400)
      const weak2 = await call(base, '/setup/password', { method: 'POST', cookie: setupCookie, json: { password: '12345' } })
      assert.equal(weak2.status, 400)
      const passwordSet = await call(base, '/setup/password', { method: 'POST', cookie: setupCookie, json: { password: 'abc123' } })
      assert.equal(passwordSet.status, 200)

      // 配额：非法过小与正常值。
      assert.equal((await call(base, '/setup/quota', { method: 'POST', cookie: setupCookie, json: { maxBytes: 1 } })).status, 400)
      const quota = await call(base, '/setup/quota', { method: 'POST', cookie: setupCookie, json: { maxBytes: 5 * 1024 ** 3 } })
      assert.equal(quota.status, 200)

      // 第一台设备（可跳过，这里创建）。
      const device = await call(base, '/setup/device', { method: 'POST', cookie: setupCookie, json: { label: 'PC-1' } })
      assert.equal(device.status, 201)
      assert.match(device.body.value.token, /^[A-Za-z0-9_-]{20,}$/u)

      // 完成初始化，拿到正式管理台 cookie。
      const completed = await call(base, '/setup/complete', { method: 'POST', cookie: setupCookie, json: {} })
      assert.equal(completed.status, 200)
      const adminCookie = cookieOf(completed.headers, 'dsh_sync_admin')
      assert.ok(adminCookie !== undefined)

      // 完成后 /setup 跳 /admin，初始化接口失效。
      assert.equal((await call(base, '/setup', { redirect: 'manual' })).location, '/admin')
      assert.equal((await call(base, '/setup/verify', { method: 'POST', json: { code: 'ABCD-EFGH' } })).status, 409)

      // 管理台：未登录 401；密码错误 401；密码正确 200。
      assert.equal((await call(base, '/admin/overview')).status, 401)
      assert.equal((await call(base, '/admin/login', { method: 'POST', json: { password: 'wrong-pass' } })).status, 401)
      const login = await call(base, '/admin/login', { method: 'POST', json: { password: 'abc123' } })
      assert.equal(login.status, 200)
      const loginCookie = cookieOf(login.headers, 'dsh_sync_admin')
      assert.match(login.headers.getSetCookie().join(','), /HttpOnly/u)

      const overview = await call(base, '/admin/overview', { cookie: loginCookie })
      assert.equal(overview.status, 200)
      assert.equal(overview.body.value.devices, 1)
      assert.equal(overview.body.value.maxBytes, 5 * 1024 ** 3)

      // 配额可在管理台修改。
      const changed = await call(base, '/admin/quota', { method: 'POST', cookie: loginCookie, json: { maxBytes: 20 * 1024 ** 3 } })
      assert.equal(changed.status, 200)
      const overview2 = await call(base, '/admin/overview', { cookie: loginCookie })
      assert.equal(overview2.body.value.maxBytes, 20 * 1024 ** 3)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
