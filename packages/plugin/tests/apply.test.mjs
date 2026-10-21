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
    sessions: { get: () => undefined, flush: async () => true },
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
    '/api/session-sync/status',
    '/api/session-sync/setup',
    '/api/session-sync/workspaces',
    '/api/session-sync/test',
    '/api/session-sync/sync',
    '/api/session-sync/cwd',
    '/api/session-sync/blocked',
  ])

  const status = await connection.routes[0].fetch(new Request('http://host/api/session-sync/status'))
  const statusBody = JSON.parse(await status.text())
  assert.equal(statusBody.value.configured, false)
  assert.equal(statusBody.value.reason, 'serverUrl 未配置')

  const sync = await connection.routes[4].fetch(new Request('http://host/api/session-sync/sync', { method: 'POST' }))
  const syncBody = JSON.parse(await sync.text())
  assert.equal(syncBody.value.ok, false)
  assert.equal(syncBody.value.code, 'unconfigured')
  assert.equal(syncBody.value.message, 'serverUrl 未配置')
})

test('应用接线：恢复的 blocked 会话在 agent/pre-step 被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-apply-'))
  const statePath = join(dir, 'session-sync', 'state.json')
  mkdirSync(join(dir, 'session-sync'), { recursive: true })
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    revision: 0,
    blocked: [{ sessionId: 'blocked-session', kind: 'diverged', message: 'old divergence', at: 1 }],
  }))
  const connection = fakeConnection()
  const { ctx, listeners } = fakeContext(connection, { dshHomePath: () => statePath })
  apply(ctx, {
    enabled: true,
    serverUrl: '',
    token: '',
    passphrase: '',
    autoSync: false,
  })

  let delegated = false
  const decision = await listeners.get('agent/pre-step')(
    { agent: { session: { header: { id: 'blocked-session' } } } },
    async () => { delegated = true; return { kind: 'enter' } },
  )
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(delegated, false)

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
    workspacePath: ref(''),
    workspaceAllowlist: ref([]),
    autoSync: ref(false),
    intervalMs: ref(15_000),
    includeSubagents: ref(false),
    batchEvents: ref(10),
    batchBytes: ref(1024),
  })

  const setup = await connection.routes[1].fetch(new Request('http://host/api/session-sync/setup'))
  const body = JSON.parse(await setup.text())
  assert.equal(body.value.serverUrl, 'http://127.0.0.1:8787')
  assert.equal(body.value.deviceName, 'dev-box')
  assert.equal(body.value.intervalMs, 15_000)
  assert.equal(body.value.autoSync, false)
  assert.equal(body.value.includeSubagents, false)
  assert.equal(body.value.reason, 'workspaceAllowlist 未配置')
})

test('应用接线：volatile 引用原地更新后 setup/status 立即读到新值', async () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection)
  const values = { serverUrl: '', allowlist: [] }
  const ref = (read) => ({ get: read })
  apply(ctx, {
    enabled: true,
    serverUrl: ref(() => values.serverUrl),
    token: 'token-value',
    passphrase: 'pass-value',
    deviceName: 'dev-box',
    workspacePath: '',
    workspaceAllowlist: ref(() => values.allowlist),
    autoSync: false,
    intervalMs: 15_000,
    includeSubagents: false,
    batchEvents: 10,
    batchBytes: 1024,
  })

  const first = await connection.routes[1].fetch(new Request('http://host/api/session-sync/setup'))
  assert.equal((JSON.parse(await first.text())).value.reason, 'serverUrl 未配置')

  values.serverUrl = 'http://127.0.0.1:8787'
  values.allowlist = ['D:/work']
  const second = await connection.routes[1].fetch(new Request('http://host/api/session-sync/setup'))
  const body = JSON.parse(await second.text())
  assert.equal(body.value.serverUrl, 'http://127.0.0.1:8787')
  assert.equal(body.value.configured, true)
  assert.deepEqual(body.value.workspaceAllowlist, ['D:/work'])
})

test('应用接线：设置信息不回传 token/passphrase', async () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection)
  apply(ctx, {
    enabled: true,
    serverUrl: 'http://127.0.0.1:8787',
    token: 'secret-token',
    passphrase: 'secret-passphrase',
    workspacePath: 'D:/work',
    autoSync: false,
  })

  const response = await connection.routes[1].fetch(new Request('http://host/api/session-sync/setup'))
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
    workspaceAllowlist: ['D:/work'],
    autoSync: false,
  })

  const response = await connection.routes[2].fetch(new Request('http://host/api/session-sync/workspaces'))
  const body = JSON.parse(await response.text())
  assert.equal(body.value.allowlistConfigured, true)
  assert.deepEqual(body.value.selectedPaths, ['D:/work'])
  assert.deepEqual(body.value.workspaces, [{
    path: 'D:/work',
    title: 'Work',
    rootSessions: 1,
    subagentSessions: 1,
    selected: true,
  }])
})

test('应用接线：token/passphrase 优先取 DSH 凭据库', async () => {
  const connection = fakeConnection()
  const requested = []
  const { ctx } = fakeContext(connection, {
    credentials: {
      resolve: async (ref) => {
        requested.push(ref)
        if (ref === 'DSH_SESSION_SYNC_TOKEN') return { value: 'credential-token', source: 'file' }
        if (ref === 'DSH_SESSION_SYNC_PASSPHRASE') return { value: 'credential-pass', source: 'env' }
        return undefined
      },
    },
  })
  apply(ctx, {
    enabled: true,
    serverUrl: 'http://127.0.0.1:1',
    token: '',
    passphrase: '',
    workspacePath: '',
    workspaceAllowlist: ['D:/work'],
    autoSync: false,
  })

  const response = await connection.routes[1].fetch(new Request('http://host/api/session-sync/setup'))
  const body = JSON.parse(await response.text())
  assert.equal(body.value.hasToken, true)
  assert.equal(body.value.hasPassphrase, true)
  assert.equal(body.value.tokenSource, 'file')
  assert.equal(body.value.passphraseSource, 'env')
  assert.deepEqual(body.value.credentialRefs, {
    token: 'DSH_SESSION_SYNC_TOKEN',
    passphrase: 'DSH_SESSION_SYNC_PASSPHRASE',
  })
  assert.ok(requested.includes('DSH_SESSION_SYNC_TOKEN'))
  assert.ok(requested.includes('DSH_SESSION_SYNC_PASSPHRASE'))
  assert.equal(JSON.stringify(body).includes('credential-token'), false)
  assert.equal(JSON.stringify(body).includes('credential-pass'), false)
})

test('应用接线：禁用时不注册任何路由', () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection)
  apply(ctx, { enabled: false, serverUrl: 'http://127.0.0.1:8787', token: 't', passphrase: 'p' })
  assert.deepEqual(connection.routes, [])
})
