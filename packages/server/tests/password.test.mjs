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

test('修改管理密码：校验当前密码、失效旧会话、记录审计', async () => {
  const temp = createTempHome('server-password')
  try {
    const db = openDatabase(temp.dataDir)
    const { base, close } = await listenServer(db, temp.dataDir, { onboardingCode: 'ABCD-EFGH' })
    try {
      const verified = await call(base, '/setup/verify', { method: 'POST', json: { code: 'ABCD-EFGH' } })
      const setupCookie = cookieOf(verified.headers, 'dsh_sync_setup')
      await call(base, '/setup/password', { method: 'POST', cookie: setupCookie, json: { password: 'abc123' } })
      await call(base, '/setup/quota', { method: 'POST', cookie: setupCookie, json: { maxBytes: 5 * 1024 ** 3 } })
      await call(base, '/setup/complete', { method: 'POST', cookie: setupCookie, json: {} })
      const login = await call(base, '/admin/login', { method: 'POST', json: { password: 'abc123' } })
      assert.equal(login.status, 200)
      const oldCookie = cookieOf(login.headers, 'dsh_sync_admin')
      assert.ok(oldCookie !== undefined)
      const secondLogin = await call(base, '/admin/login', { method: 'POST', json: { password: 'abc123' } })
      assert.equal(secondLogin.status, 200)
      const otherCookie = cookieOf(secondLogin.headers, 'dsh_sync_admin')
      assert.ok(otherCookie !== undefined)
      assert.notEqual(otherCookie, oldCookie)

      // 当前密码错、新的太弱都不能改。
      const wrongCurrent = await call(base, '/admin/password', {
        method: 'POST', cookie: oldCookie, json: { currentPassword: 'nope', newPassword: 'newpass1!' },
      })
      assert.equal(wrongCurrent.status, 400)
      const weak = await call(base, '/admin/password', {
        method: 'POST', cookie: oldCookie, json: { currentPassword: 'abc123', newPassword: 'short' },
      })
      assert.equal(weak.status, 400)

      const changed = await call(base, '/admin/password', {
        method: 'POST', cookie: oldCookie, json: { currentPassword: 'abc123', newPassword: 'newpass1!' },
      })
      assert.equal(changed.status, 200)
      assert.equal(changed.body.value.changed, true)
      assert.equal(cookieOf(changed.headers, 'dsh_sync_admin'), undefined)

      // 当前会话保留，其它管理会话失效。
      assert.equal((await call(base, '/admin/overview', { cookie: oldCookie })).status, 200)
      assert.equal((await call(base, '/admin/overview', { cookie: otherCookie })).status, 401)

      // 旧密码不能登录，新密码可以。
      assert.equal((await call(base, '/admin/login', { method: 'POST', json: { password: 'abc123' } })).status, 401)
      assert.equal((await call(base, '/admin/login', { method: 'POST', json: { password: 'newpass1!' } })).status, 200)

      const audit = await call(base, '/admin/audit?action=password.change', { cookie: oldCookie })
      assert.equal(audit.status, 200)
      assert.ok(audit.body.value.events.length >= 1)
      assert.equal(audit.body.value.events[0].action, 'password.change')

      const failed = await call(base, '/admin/audit?action=password.change_failed', { cookie: oldCookie })
      assert.equal(failed.body.value.events.length, 1)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
