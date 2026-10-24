import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncHttpError } from '../src/engine.ts'
import { createHostApi } from '../src/host-api.ts'

/** 造一个固定状态的控制面。 */
function control(overrides = {}) {
  return {
    status: () => overrides.status ?? {
      schemaVersion: 2,
      statusVersion: 1,
      configured: true,
      reason: null,
      running: false,
      run: { id: 1, trigger: 'auto', state: 'finished', startedAt: 10, finishedAt: 10 },
      scheduler: { autoSync: true, intervalMs: 60_000, nextRunAt: null, backoffUntil: null },
      deviceLease: { state: 'held' },
      lastAttempt: 10,
      lastSuccess: 10,
      lastError: null,
      retryCount: 0,
      nextRetryAt: null,
      pending: null,
      revision: 3,
      sessions: [],
    },
    events: overrides.events ?? (async () => new Response('event: status\ndata: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })),
    setup: async () => overrides.setup ?? {
      configured: true,
      reason: null,
      serverUrl: 'http://127.0.0.1:8787',
      deviceName: 'dev',
      excludedSessionIds: ['session-a'],
      autoSync: true,
      intervalMs: 60_000,
      includeSubagents: true,
      hasToken: true,
      hasPassphrase: true,
      tokenSource: 'file',
      passphraseSource: 'file',
      credentialRefs: {
        token: 'DSH_SESSION_CLOUDSYNC_TOKEN',
        passphrase: 'DSH_SESSION_CLOUDSYNC_PASSPHRASE',
      },
    },
    workspaces: overrides.workspaces ?? (async () => ({
      workspaces: [{
        path: 'D:/work',
        title: 'work',
        rootSessions: 2,
        subagentSessions: 3,
      }],
      sessions: [{
        sessionId: 'session-a',
        workspacePath: 'D:/work',
        createdAt: 1,
        formatVersion: 4,
        eventCount: 3,
        subagentSessions: 1,
        excluded: true,
      }],
      excludedSessionIds: ['session-a'],
      bindings: [],
      unmapped: [],
      remoteWorkspaces: [],
    })),
    test: overrides.test ?? (async () => ({ ok: true })),
    syncNow: overrides.syncNow ?? (async () => ({ ok: true, status: { running: false } })),
    cwdDecision: overrides.cwdDecision ?? (async () => ({ ok: true, status: 'corrected' })),
    resolveBlocked: overrides.resolveBlocked ?? (async () => ({ ok: true })),
    prepareReplace: overrides.prepareReplace ?? (async (sessionId) => ({
      sessionId,
      scriptPath: '/tmp/replace.mjs',
      command: 'node "/tmp/replace.mjs"',
      backupRoot: '/tmp/backups',
      steps: ['step'],
    })),
    bindWorkspace: overrides.bindWorkspace ?? (async () => ({
      workspaces: [],
      sessions: [],
      excludedSessionIds: [],
      bindings: [],
      unmapped: [],
      remoteWorkspaces: [],
    })),
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

test('宿主 API：注册 status/events/setup/workspaces/test/sync/cwd/blocked/replace/bind 十条精确路由', () => {
  const routes = createHostApi(control())
  assert.deepEqual(routes.map((entry) => [entry.path, [...entry.methods], entry.requestBody]), [
    ['/api/session-cloudsync/status', ['GET'], 'buffered'],
    ['/api/session-cloudsync/events', ['GET'], 'buffered'],
    ['/api/session-cloudsync/setup', ['GET'], 'buffered'],
    ['/api/session-cloudsync/workspaces', ['GET'], 'buffered'],
    ['/api/session-cloudsync/test', ['POST'], 'buffered'],
    ['/api/session-cloudsync/sync', ['POST'], 'buffered'],
    ['/api/session-cloudsync/cwd', ['POST'], 'buffered'],
    ['/api/session-cloudsync/blocked', ['POST'], 'buffered'],
    ['/api/session-cloudsync/replace', ['POST'], 'buffered'],
    ['/api/session-cloudsync/workspaces/bind', ['POST'], 'buffered'],
  ])
})

test('宿主 API：status 返回快照且禁止缓存', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-cloudsync/status').fetch(
    new Request('http://host/api/session-cloudsync/status'),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await bodyOf(response)).value.revision, 3)
})

test('宿主 API：events 返回 text/event-stream', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-cloudsync/events').fetch(
    new Request('http://host/api/session-cloudsync/events?until=idle'),
  )
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
})

test('宿主 API：setup 只返回非敏感字段', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-cloudsync/setup').fetch(
    new Request('http://host/api/session-cloudsync/setup'),
  )
  assert.equal(response.status, 200)
  const body = await bodyOf(response)
  assert.equal(JSON.stringify(body).includes('token-value'), false)
})

test('宿主 API：workspaces 返回会话选择列表', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-cloudsync/workspaces').fetch(
    new Request('http://host/api/session-cloudsync/workspaces'),
  )
  assert.equal(response.status, 200)
  const body = await bodyOf(response)
  assert.equal(body.value.workspaces[0].rootSessions, 2)
  assert.equal(body.value.sessions[0].sessionId, 'session-a')
  assert.deepEqual(body.value.excludedSessionIds, ['session-a'])
})

test('宿主 API：workspaces 读取失败时返回 500', async () => {
  const routes = createHostApi(control({
    workspaces: async () => { throw new Error('无法读取工作区') },
  }))
  const response = await route(routes, '/api/session-cloudsync/workspaces').fetch(
    new Request('http://host/api/session-cloudsync/workspaces'),
  )
  assert.equal(response.status, 500)
  const body = await bodyOf(response)
  assert.equal(body.ok, false)
  assert.equal(body.error.message, '无法读取工作区')
})

test('宿主 API：test 用请求体里的 serverUrl 探测，不读控制面配置', async () => {
  let seen = ''
  const routes = createHostApi(control({
    test: async (serverUrl) => {
      seen = serverUrl
      return { ok: true, version: '0.0.0', protocol: 1 }
    },
  }))
  const response = await route(routes, '/api/session-cloudsync/test').fetch(
    new Request('http://host/api/session-cloudsync/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverUrl: '  http://127.0.0.1:8787  ' }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(seen, 'http://127.0.0.1:8787')
  assert.deepEqual((await bodyOf(response)).value, { ok: true, version: '0.0.0', protocol: 1 })
})

test('宿主 API：test 缺少 serverUrl 时返回 400', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-cloudsync/test').fetch(
    new Request('http://host/api/session-cloudsync/test', { method: 'POST' }),
  )
  assert.equal(response.status, 400)
  const body = await bodyOf(response)
  assert.equal(body.ok, false)
  assert.equal(body.error.message, '需要 serverUrl')
})

test('宿主 API：sync 返回控制器结果', async () => {
  const result = { ok: false, code: 'already-running', message: '同步正在进行', status: { running: true } }
  const routes = createHostApi(control({ syncNow: async () => result }))
  const response = await route(routes, '/api/session-cloudsync/sync').fetch(
    new Request('http://host/api/session-cloudsync/sync', { method: 'POST' }),
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
  const response = await route(routes, '/api/session-cloudsync/cwd').fetch(
    new Request('http://host/api/session-cloudsync/cwd', {
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
  const response = await route(routes, '/api/session-cloudsync/blocked').fetch(
    new Request('http://host/api/session-cloudsync/blocked', {
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

  const restored = await route(routes, '/api/session-cloudsync/blocked').fetch(
    new Request('http://host/api/session-cloudsync/blocked', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-blocked', action: 'restore', createdAt: 42, formatVersion: 4 }),
    }),
  )
  assert.equal(restored.status, 200)
  assert.equal(seenAction, 'restore')
})

test('宿主 API：replace 按 sessionId 生成覆盖计划', async () => {
  let seen = ''
  const routes = createHostApi(control({
    prepareReplace: async (sessionId) => {
      seen = sessionId
      return {
        sessionId,
        scriptPath: '/tmp/replace.mjs',
        command: 'node "/tmp/replace.mjs"',
        backupRoot: '/tmp/backups',
        steps: ['一', '二'],
      }
    },
  }))
  const response = await route(routes, '/api/session-cloudsync/replace').fetch(
    new Request('http://host/api/session-cloudsync/replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-replace' }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(seen, 'session-replace')
  assert.equal((await bodyOf(response)).value.scriptPath, '/tmp/replace.mjs')
})

test('宿主 API：cwd 决策缺少 action 时返回 400', async () => {
  const routes = createHostApi(control())
  const response = await route(routes, '/api/session-cloudsync/cwd').fetch(
    new Request('http://host/api/session-cloudsync/cwd', {
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
  const response = await route(routes, '/api/session-cloudsync/sync').fetch(
    new Request('http://host/api/session-cloudsync/sync', { method: 'POST' }),
  )
  assert.equal(response.status, 500)
  const body = await bodyOf(response)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'server')
  assert.equal(body.error.message, '服务端 503')
})
