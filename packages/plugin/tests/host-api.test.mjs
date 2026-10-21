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
      live: [],
    },
    setup: async () => overrides.setup ?? {
      configured: true,
      reason: null,
      serverUrl: 'http://127.0.0.1:8787',
      deviceName: 'dev',
      workspacePath: 'D:/work',
      workspaceAllowlist: ['D:/work'],
      allowlistConfigured: true,
      autoSync: true,
      intervalMs: 60_000,
      includeSubagents: true,
      hasToken: true,
      hasPassphrase: true,
      tokenSource: 'file',
      passphraseSource: 'file',
      credentialRefs: {
        token: 'DSH_SESSION_SYNC_TOKEN',
        passphrase: 'DSH_SESSION_SYNC_PASSPHRASE',
      },
    },
    workspaces: overrides.workspaces ?? (async () => ({
      allowlistConfigured: true,
      selectedPaths: ['D:/work'],
      workspaces: [{
        path: 'D:/work',
        title: 'work',
        rootSessions: 2,
        subagentSessions: 3,
        selected: true,
      }],
    })),
    test: overrides.test ?? (async () => ({ ok: true })),
    syncNow: overrides.syncNow ?? (async () => ({ ok: true, status: { running: false } })),
    cwdDecision: overrides.cwdDecision ?? (async () => ({ ok: true, status: 'corrected' })),
    resolveBlocked: overrides.resolveBlocked ?? (async () => ({ ok: true })),
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

test('宿主 API：注册 status/setup/workspaces/test/sync/cwd/blocked 七条精确路由', () => {
  const routes = createHostApi(control())
  assert.deepEqual(routes.map((entry) => [entry.path, [...entry.methods], entry.requestBody]), [
    ['/api/session-sync/status', ['GET'], 'buffered'],
    ['/api/session-sync/setup', ['GET'], 'buffered'],
    ['/api/session-sync/workspaces', ['GET'], 'buffered'],
    ['/api/session-sync/test', ['POST'], 'buffered'],
    ['/api/session-sync/sync', ['POST'], 'buffered'],
    ['/api/session-sync/cwd', ['POST'], 'buffered'],
    ['/api/session-sync/blocked', ['POST'], 'buffered'],
  ])
})

test('宿主 API：status 返回快照且禁止缓存', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-sync/status').fetch(
    new Request('http://host/api/session-sync/status'),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await bodyOf(response)).value.revision, 3)
})

test('宿主 API：setup 只返回非敏感字段', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-sync/setup').fetch(
    new Request('http://host/api/session-sync/setup'),
  )
  assert.equal(response.status, 200)
  const body = await bodyOf(response)
  assert.equal(body.value.workspacePath, 'D:/work')
  assert.equal(JSON.stringify(body).includes('token-value'), false)
})

test('宿主 API：workspaces 返回同步列表与选中项', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-sync/workspaces').fetch(
    new Request('http://host/api/session-sync/workspaces'),
  )
  assert.equal(response.status, 200)
  const body = await bodyOf(response)
  assert.equal(body.value.workspaces[0].rootSessions, 2)
  assert.equal(body.value.workspaces[0].selected, true)
})

test('宿主 API：workspaces 读取失败时返回 500', async () => {
  const routes = createHostApi(control({
    workspaces: async () => { throw new Error('无法读取工作区') },
  }))
  const response = await route(routes, '/api/session-sync/workspaces').fetch(
    new Request('http://host/api/session-sync/workspaces'),
  )
  assert.equal(response.status, 500)
  const body = await bodyOf(response)
  assert.equal(body.ok, false)
  assert.equal(body.error.message, '无法读取工作区')
})

test('宿主 API：test 返回连接测试结果', async () => {
  const routes = createHostApi(control({ test: async () => ({ ok: false, kind: 'auth', message: 'token 无效' }) }))
  const response = await route(routes, '/api/session-sync/test').fetch(
    new Request('http://host/api/session-sync/test', { method: 'POST' }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual((await bodyOf(response)).value, { ok: false, kind: 'auth', message: 'token 无效' })
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

test('宿主 API：cwd 决策按 sessionId/action 调用控制面', async () => {
  let seen = ''
  let seenAction = ''
  const routes = createHostApi(control({
    cwdDecision: async (sessionId, action) => {
      seen = sessionId
      seenAction = action
      return { ok: true, status: 'corrected' }
    },
  }))
  const response = await route(routes, '/api/session-sync/cwd').fetch(
    new Request('http://host/api/session-sync/cwd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-cwd', action: 'fix' }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(seen, 'session-cwd')
  assert.equal(seenAction, 'fix')
  assert.deepEqual((await bodyOf(response)).value, { ok: true, status: 'corrected' })
})

test('宿主 API：blocked 决策按 sessionId/action 调用控制面', async () => {
  let seen = ''
  let seenAction = ''
  let seenCreatedAt
  const routes = createHostApi(control({
    resolveBlocked: async (sessionId, action, createdAt) => {
      seen = sessionId
      seenAction = action
      seenCreatedAt = createdAt
      return { ok: true }
    },
  }))
  const response = await route(routes, '/api/session-sync/blocked').fetch(
    new Request('http://host/api/session-sync/blocked', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-blocked', action: 'force', createdAt: 42, formatVersion: 4 }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(seen, 'session-blocked')
  assert.equal(seenAction, 'force')
  assert.equal(seenCreatedAt, 42)
  assert.deepEqual((await bodyOf(response)).value, { ok: true })
})

test('宿主 API：cwd 决策缺少 action 时返回 400', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-sync/cwd').fetch(
    new Request('http://host/api/session-sync/cwd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-cwd' }),
    }),
  )
  assert.equal(response.status, 400)
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
