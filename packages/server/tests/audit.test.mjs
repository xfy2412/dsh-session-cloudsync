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
 * @returns 状态码与响应体。
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

test('审计日志：初始化、登录、设备与配额动作按时间倒序记录', async () => {
  const temp = createTempHome('server-audit')
  try {
    const db = openDatabase(temp.dataDir)
    const { base, close } = await listenServer(db, temp.dataDir, { onboardingCode: 'ABCD-EFGH' })
    try {
      const verified = await call(base, '/setup/verify', { method: 'POST', json: { code: 'ABCD-EFGH' } })
      const setupCookie = cookieOf(verified.headers, 'dsh_sync_setup')
      assert.ok(setupCookie !== undefined)
      await call(base, '/setup/password', { method: 'POST', cookie: setupCookie, json: { password: 'abc123' } })
      await call(base, '/setup/quota', { method: 'POST', cookie: setupCookie, json: { maxBytes: 5 * 1024 ** 3 } })
      const setupDevice = await call(base, '/setup/device', { method: 'POST', cookie: setupCookie, json: { label: 'PC-1' } })
      assert.equal(setupDevice.status, 201)
      const completed = await call(base, '/setup/complete', { method: 'POST', cookie: setupCookie, json: {} })
      assert.equal(completed.status, 200)
      const adminCookie = cookieOf(completed.headers, 'dsh_sync_admin')
      assert.ok(adminCookie !== undefined)

      // 未登录不可读审计。
      assert.equal((await call(base, '/admin/audit')).status, 401)

      // 登录失败与成功都要留痕。
      assert.equal((await call(base, '/admin/login', { method: 'POST', json: { password: 'wrong-pass' } })).status, 401)
      const login = await call(base, '/admin/login', { method: 'POST', json: { password: 'abc123' } })
      assert.equal(login.status, 200)
      const loginCookie = cookieOf(login.headers, 'dsh_sync_admin')

      const created = await call(base, '/admin/devices', {
        method: 'POST', cookie: loginCookie, json: { label: 'PC-2' },
      })
      assert.equal(created.status, 201)
      const deviceId = created.body.value.device.deviceId

      const renamed = await call(base, `/admin/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH', cookie: loginCookie, json: { label: 'PC-2-renamed' },
      })
      assert.equal(renamed.status, 200)

      const revoked = await call(base, `/admin/devices/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE', cookie: loginCookie,
      })
      assert.equal(revoked.status, 200)

      const quota = await call(base, '/admin/quota', {
        method: 'POST', cookie: loginCookie, json: { maxBytes: 8 * 1024 ** 3 },
      })
      assert.equal(quota.status, 200)

      const audit = await call(base, '/admin/audit?limit=100', { cookie: adminCookie })
      assert.equal(audit.status, 200)
      const events = audit.body.value.events
      assert.ok(events.length >= 9)
      assert.equal(audit.body.value.nextBefore, null)

      const actions = events.map((event) => event.action)
      for (const action of ['setup.password', 'setup.quota', 'setup.device', 'setup.complete', 'login_failed', 'login', 'device.create', 'device.rename', 'device.revoke', 'quota.change']) {
        assert.ok(actions.includes(action), `缺少审计动作 ${action}`)
      }

      // 时间倒序。
      for (let index = 1; index < events.length; index += 1) {
        assert.ok(events[index - 1].id > events[index].id)
      }

      const rename = events.find((event) => event.action === 'device.rename')
      assert.equal(rename.target, deviceId)
      assert.deepEqual(rename.detail, { from: 'PC-2', to: 'PC-2-renamed' })

      const revoke = events.find((event) => event.action === 'device.revoke')
      assert.deepEqual(revoke.detail, { label: 'PC-2-renamed' })

      const quotaEvent = events.find((event) => event.action === 'quota.change')
      assert.deepEqual(quotaEvent.detail, { from: 5 * 1024 ** 3, to: 8 * 1024 ** 3 })

      // action 过滤。
      const filtered = await call(base, '/admin/audit?action=device.create', { cookie: adminCookie })
      assert.equal(filtered.body.value.events.length, 1)
      assert.equal(filtered.body.value.events[0].action, 'device.create')

      // before 游标分页。
      const firstPage = await call(base, '/admin/audit?limit=2', { cookie: adminCookie })
      assert.equal(firstPage.body.value.events.length, 2)
      assert.ok(firstPage.body.value.nextBefore !== null)
      const secondPage = await call(base, `/admin/audit?limit=2&before=${firstPage.body.value.nextBefore}`, { cookie: adminCookie })
      assert.equal(secondPage.body.value.events.length, 2)
      assert.ok(secondPage.body.value.events[0].id < firstPage.body.value.events[1].id)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
