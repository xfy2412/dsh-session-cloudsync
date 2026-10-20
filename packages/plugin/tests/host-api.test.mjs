import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncHttpError } from '../src/engine.ts'
import { createHostApi } from '../src/host-api.ts'

/** 造一个固定状态的控制面。 */
function control(overrides = {}) {
  return {
    status: () => overrides.status ?? {
      configured: true,
      reason: null,
      running: false,
      lastAttempt: 10,
      lastSuccess: 10,
      lastError: null,
      retryCount: 0,
      nextRetryAt: null,
      pending: null,
      revision: 3,
      sessions: [],
    },
    setup: () => overrides.setup ?? {
      configured: true,
      reason: null,
      serverUrl: 'http://127.0.0.1:8787',
      deviceName: 'dev',
      workspacePath: 'D:/work',
      autoSync: true,
      intervalMs: 60_000,
      includeSubagents: false,
      hasToken: true,
      hasPassphrase: true,
    },
    syncNow: overrides.syncNow ?? (async () => ({ ok: true, status: { running: false } })),
  }
}

/** 取某条路由。 */
function route(routes, path) {
  const found = routes.find((entry) => entry.path === path)
  assert.ok(found, `缺少路由 ${path}`)
  return found
}

/** 解析 JSON 响应。 */
async function bodyOf(response) {
  return JSON.parse(await response.text())
}

test('宿主 API：注册 status/setup/sync 三条精确路由', () => {
  const routes = createHostApi(control())
  assert.deepEqual(routes.map((entry) => [entry.path, [...entry.methods], entry.requestBody]), [
    ['/api/session-sync/status', ['GET'], 'buffered'],
    ['/api/session-sync/setup', ['GET'], 'buffered'],
    ['/api/session-sync/sync', ['POST'], 'buffered'],
  ])
})

test('宿主 API：status 返回快照且禁止缓存', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-sync/status').fetch(
    new Request('http://host/api/session-sync/status'),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type') ?? '', /application\/json/u)
  const body = await bodyOf(response)
  assert.equal(body.ok, true)
  assert.equal(body.value.revision, 3)
  assert.equal(body.value.configured, true)
})

test('宿主 API：setup 只返回非敏感字段', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-sync/setup').fetch(
    new Request('http://host/api/session-sync/setup'),
  )
  const body = await bodyOf(response)
  assert.equal(body.value.serverUrl, 'http://127.0.0.1:8787')
  assert.equal(body.value.hasToken, true)
  assert.equal('token' in body.value, false)
  assert.equal('passphrase' in body.value, false)
})

test('宿主 API：sync 返回控制器结果', async () => {
  const result = { ok: false, code: 'already-running', message: '同步正在进行', status: { running: true } }
  const routes = createHostApi(control({ syncNow: async () => result }))
  const response = await route(routes, '/api/session-sync/sync').fetch(
    new Request('http://host/api/session-sync/sync', { method: 'POST' }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual((await bodyOf(response)).value, result)
})

test('宿主 API：sync 抛错时返回 500 与分类', async () => {
  const routes = createHostApi(control({
    syncNow: async () => { throw new SyncHttpError('服务端 503', 503) },
  }))
  const response = await route(routes, '/api/session-sync/sync').fetch(
    new Request('http://host/api/session-sync/sync', { method: 'POST' }),
  )
  assert.equal(response.status, 500)
  const body = await bodyOf(response)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'server')
  assert.equal(body.error.message, '服务端 503')
})
