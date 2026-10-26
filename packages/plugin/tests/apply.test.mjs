import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../src/index.ts'

/** 造一个只提供最小能力的宿主上下文。 */
function fakeContext(connection, services = {}) {
  const disposers = []
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    sessions: {
      get: (id) => services.sessionHeaders?.[id] === undefined ? undefined : { header: services.sessionHeaders[id] },
      flush: async () => true,
    },
    sessionPersistence: services.sessionPersistence ?? {
      list: async () => [],
      stat: async () => undefined,
      open: async () => { throw new Error('不应打开会话') },
      create: async () => { throw new Error('不应创建会话') },
    },
    get: (name) => name === 'connection' ? connection : services[name],
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    effect: (fn) => {
      const disposer = fn()
      disposers.push(disposer)
      return { dispose: async () => { await disposer?.() } }
    },
    inject: (_deps, callback) => { callback(ctx) },
  }
  return { ctx, disposers, listeners }
}

/** 造一个记录路由的 connection 服务。 */
function fakeConnection() {
  const routes = []
  return {
    routes,
    fetch: {
      register: (route) => {
        routes.push(route)
        return async () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
}

test('应用接线：未配置时仍注册状态/设置/手动同步路由', async () => {
  const connection = fakeConnection()
  const { ctx, listeners } = fakeContext(connection)
  apply(ctx, {
    enabled: true,
    serverUrl: '',
    token: '',
    passphrase: '',
    autoSync: false,
  })

  assert.equal(typeof listeners.get('agent/pre-step'), 'function')
  let delegated = false
  const decision = await listeners.get('agent/pre-step')(
    { agent: { session: { header: { id: 'not-blocked' } } } },
    async () => { delegated = true; return { kind: 'enter' } },
  )
  assert.equal(delegated, true)
  assert.deepEqual(decision, { kind: 'enter' })

  assert.deepEqual(connection.routes.map((route) => route.path), [
    '/api/session-cloudsync/status',
    '/api/session-cloudsync/config',
    '/api/session-cloudsync/events',
    '/api/session-cloudsync/setup',
    '/api/session-cloudsync/workspaces',
    '/api/session-cloudsync/test',
    '/api/session-cloudsync/sync',
    '/api/session-cloudsync/cwd',
    '/api/session-cloudsync/blocked',
    '/api/session-cloudsync/replace',
    '/api/session-cloudsync/workspaces/bind',
  ])

  const status = await connection.routes[0].fetch(new Request('http://host/api/session-cloudsync/status'))
  const statusBody = JSON.parse(await status.text())
  assert.equal(statusBody.value.configured, false)
  assert.equal(statusBody.value.reason, 'serverUrl 未配置')

  const events = await connection.routes[2].fetch(new Request('http://host/api/session-cloudsync/events?until=idle'))
  assert.match(events.headers.get('content-type') ?? '', /^text\/event-stream/)
  const reader = events.body.getReader()
  const first = await reader.read()
  assert.match(new TextDecoder().decode(first.value), /"schemaVersion":2/)
  await reader.cancel()

  const sync = await connection.routes[6].fetch(new Request('http://host/api/session-cloudsync/sync', { method: 'POST' }))
  const syncBody = JSON.parse(await sync.text())
  assert.equal(syncBody.value.ok, false)
  assert.equal(syncBody.value.code, 'unconfigured')
  assert.equal(syncBody.value.message, 'serverUrl 未配置')
})

test('应用接线：status 暴露自调度 nextRunAt', async () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection)
  apply(ctx, {
    enabled: true,
    serverUrl: 'http://127.0.0.1:8787',
    token: 'token',
    passphrase: 'pass',
    autoSync: true,
    intervalMs: 60_000,
  })
  const response = await connection.routes[0].fetch(new Request('http://host/api/session-cloudsync/status'))
  const body = JSON.parse(await response.text())
  assert.equal(body.value.scheduler.autoSync, true)
  assert.equal(body.value.scheduler.intervalMs, 60_000)
  assert.equal(typeof body.value.scheduler.nextRunAt, 'number')
  assert.ok(body.value.scheduler.nextRunAt > Date.now())
})

test('应用接线：恢复的 blocked 会话在 agent/pre-step 被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-apply-'))
  const statePath = join(dir, 'session-cloudsync', 'state.json')
  mkdirSync(join(dir, 'session-cloudsync'), { recursive: true })
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    revision: 0,
    blocked: [{ sessionId: 'blocked-session', kind: 'diverged', message: 'old divergence', at: 1, createdAt: 10, formatVersion: 4 }],
  }))
  const connection = fakeConnection()
  const { ctx, listeners } = fakeContext(connection, {
    dshHomePath: () => statePath,
    sessionHeaders: {
      'blocked-session': { id: 'blocked-session', createdAt: 10, version: 4 },
    },
  })
  apply(ctx, {
    enabled: true,
    serverUrl: '',
    token: '',
    passphrase: '',
    autoSync: false,
  })

  let delegated = false
  const decision = await listeners.get('agent/pre-step')(
    { agent: { session: { header: { id: 'blocked-session', createdAt: 10, version: 4 } } } },
    async () => { delegated = true; return { kind: 'enter' } },
  )
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(delegated, false)

  const otherLifecycle = await listeners.get('agent/pre-step')(
    { agent: { session: { header: { id: 'blocked-session', createdAt: 11, version: 4 } } } },
    async () => { delegated = true; return { kind: 'enter' } },
  )
  assert.deepEqual(otherLifecycle, { kind: 'enter' })
  assert.equal(delegated, true)

  delegated = false
  const childDecision = await listeners.get('agent/pre-step')(
    { agent: { session: { header: { id: 'child-session', origin: 'subagent', parentSession: 'blocked-session' } } } },
    async () => { delegated = true; return { kind: 'enter' } },
  )
  assert.deepEqual(childDecision, { kind: 'reject' })
  assert.equal(delegated, false)
})

test('应用接线：Schemastery volatile 引用按 .get() 读取', async () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection)
  const ref = (value) => ({ get: () => value })
  apply(ctx, {
    enabled: true,
    serverUrl: ref('http://127.0.0.1:8787'),
    token: ref('token-value'),
    passphrase: ref('pass-value'),
    deviceName: ref('dev-box'),
    syncSessionIds: ref(['session-a']),
    autoSync: ref(false),
    intervalMs: ref(15_000),
    includeSubagents: ref(false),
    batchEvents: ref(10),
    batchBytes: ref(1024),
  })

  const setup = await connection.routes[3].fetch(new Request('http://host/api/session-cloudsync/setup'))
  const body = JSON.parse(await setup.text())
  assert.equal(body.value.serverUrl, 'http://127.0.0.1:8787')
  assert.equal(body.value.deviceName, 'dev-box')
  assert.equal(body.value.intervalMs, 15_000)
  assert.equal(body.value.autoSync, false)
  assert.equal(body.value.includeSubagents, false)
  assert.deepEqual(body.value.syncSessionIds, ['session-a'])
  assert.equal(body.value.reason, null)
})

test('应用接线：volatile 引用原地更新后 setup/status 立即读到新值', async () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection)
  const values = { serverUrl: '', sync: [] }
  const ref = (read) => ({ get: read })
  apply(ctx, {
    enabled: true,
    serverUrl: ref(() => values.serverUrl),
    token: 'token-value',
    passphrase: 'pass-value',
    deviceName: 'dev-box',
    syncSessionIds: ref(() => values.sync),
    autoSync: false,
    intervalMs: 15_000,
    includeSubagents: false,
    batchEvents: 10,
    batchBytes: 1024,
  })

  const first = await connection.routes[3].fetch(new Request('http://host/api/session-cloudsync/setup'))
  assert.equal((JSON.parse(await first.text())).value.reason, 'serverUrl 未配置')

  values.serverUrl = 'http://127.0.0.1:8787'
  values.sync = ['session-a']
  const second = await connection.routes[3].fetch(new Request('http://host/api/session-cloudsync/setup'))
  const body = JSON.parse(await second.text())
  assert.equal(body.value.serverUrl, 'http://127.0.0.1:8787')
  assert.equal(body.value.configured, true)
  assert.deepEqual(body.value.syncSessionIds, ['session-a'])
})

test('应用接线：设置信息不回传 token/passphrase', async () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection)
  apply(ctx, {
    enabled: true,
    serverUrl: 'http://127.0.0.1:8787',
    token: 'secret-token',
    passphrase: 'secret-passphrase',
    autoSync: false,
  })

  const response = await connection.routes[3].fetch(new Request('http://host/api/session-cloudsync/setup'))
  const body = JSON.parse(await response.text())
  assert.equal(body.value.serverUrl, 'http://127.0.0.1:8787')
  assert.equal(body.value.hasToken, true)
  assert.equal(body.value.hasPassphrase, true)
  assert.equal(body.value.tokenSource, 'config')
  assert.equal(body.value.passphraseSource, 'config')
  assert.equal(JSON.stringify(body).includes('secret-token'), false)
  assert.equal(JSON.stringify(body).includes('secret-passphrase'), false)
})

test('应用接线：workspaces 汇总工作区、根会话与子代理计数', async () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection, {
    sessionPersistence: {
      list: async () => [
        {
          header: { id: 'root', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: 'D:/work' },
          eventCount: 1,
          sizeBytes: 0,
        },
        {
          header: {
            id: 'child',
            createdAt: 2,
            isSeeded: false,
            delegationDepth: 1,
            cwd: 'D:/work',
            origin: 'subagent',
            parentSession: 'root',
          },
          eventCount: 2,
          sizeBytes: 0,
        },
      ],
      stat: async () => undefined,
      open: async () => { throw new Error('不应打开会话') },
      create: async () => { throw new Error('不应创建会话') },
    },
    workspaceRegistry: {
      list: () => [{ id: 'w1', path: 'D:/work', title: 'Work', sessionIds: ['root'], attachSession: async () => {} }],
      resolveByPath: async () => undefined,
      create: async () => { throw new Error('不应创建工作区') },
    },
  })
  apply(ctx, {
    enabled: true,
    serverUrl: '',
    token: '',
    passphrase: '',
    syncSessionIds: [],
    autoSync: false,
  })

  const response = await connection.routes[4].fetch(new Request('http://host/api/session-cloudsync/workspaces'))
  const body = JSON.parse(await response.text())
  assert.deepEqual(body.value.syncSessionIds, [])
  assert.deepEqual(body.value.sessions, [{
    sessionId: 'root',
    workspacePath: 'D:/work',
    createdAt: 1,
    formatVersion: 0,
    eventCount: 1,
    subagentSessions: 1,
  }])
  assert.deepEqual(body.value.workspaces, [{
    path: 'D:/work',
    title: 'Work',
    rootSessions: 1,
    subagentSessions: 1,
  }])
  assert.deepEqual(body.value.remoteWorkspaces, [])
})

test('应用接线：token/passphrase 优先取 DSH 凭据库', async () => {
  const connection = fakeConnection()
  const requested = []
  const { ctx } = fakeContext(connection, {
    credentials: {
      resolve: async (ref) => {
        requested.push(ref)
        if (ref === 'DSH_SESSION_CLOUDSYNC_TOKEN') return { value: 'credential-token', source: 'file' }
        if (ref === 'DSH_SESSION_CLOUDSYNC_PASSPHRASE') return { value: 'credential-pass', source: 'env' }
        return undefined
      },
    },
  })
  apply(ctx, {
    enabled: true,
    serverUrl: 'http://127.0.0.1:1',
    token: '',
    passphrase: '',
    syncSessionIds: [],
    autoSync: false,
  })

  const response = await connection.routes[3].fetch(new Request('http://host/api/session-cloudsync/setup'))
  const body = JSON.parse(await response.text())
  assert.equal(body.value.hasToken, true)
  assert.equal(body.value.hasPassphrase, true)
  assert.equal(body.value.tokenSource, 'file')
  assert.equal(body.value.passphraseSource, 'env')
  assert.deepEqual(body.value.credentialRefs, {
    token: 'DSH_SESSION_CLOUDSYNC_TOKEN',
    passphrase: 'DSH_SESSION_CLOUDSYNC_PASSPHRASE',
  })
  assert.ok(requested.includes('DSH_SESSION_CLOUDSYNC_TOKEN'))
  assert.ok(requested.includes('DSH_SESSION_CLOUDSYNC_PASSPHRASE'))
  assert.equal(JSON.stringify(body).includes('credential-token'), false)
  assert.equal(JSON.stringify(body).includes('credential-pass'), false)
})

test('应用接线：禁用时不注册任何路由', () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection)
  apply(ctx, { enabled: false, serverUrl: 'http://127.0.0.1:8787', token: 't', passphrase: 'p' })
  assert.deepEqual(connection.routes, [])
})
