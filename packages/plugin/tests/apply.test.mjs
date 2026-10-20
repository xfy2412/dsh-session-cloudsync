import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.ts'

/** 造一个只提供最小能力的宿主上下文。 */
function fakeContext(connection) {
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    sessions: { get: () => undefined, flush: async () => true },
    sessionPersistence: {
      list: async () => [],
      stat: async () => undefined,
      open: async () => { throw new Error('不应打开会话') },
      create: async () => { throw new Error('不应创建会话') },
    },
    get: (name) => name === 'connection' ? connection : undefined,
    effect: (fn) => {
      const disposer = fn()
      disposers.push(disposer)
      return { dispose: async () => { await disposer?.() } }
    },
    inject: (_deps, callback) => { callback(ctx) },
  }
  return { ctx, disposers }
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
  const { ctx } = fakeContext(connection)
  apply(ctx, {
    enabled: true,
    serverUrl: '',
    token: '',
    passphrase: '',
    autoSync: false,
  })

  assert.deepEqual(connection.routes.map((route) => route.path), [
    '/api/session-sync/status',
    '/api/session-sync/setup',
    '/api/session-sync/sync',
  ])

  const status = await connection.routes[0].fetch(new Request('http://host/api/session-sync/status'))
  const statusBody = JSON.parse(await status.text())
  assert.equal(statusBody.value.configured, false)
  assert.equal(statusBody.value.reason, 'serverUrl 未配置')

  const sync = await connection.routes[2].fetch(new Request('http://host/api/session-sync/sync', { method: 'POST' }))
  const syncBody = JSON.parse(await sync.text())
  assert.equal(syncBody.value.ok, false)
  assert.equal(syncBody.value.code, 'unconfigured')
  assert.equal(syncBody.value.message, 'serverUrl 未配置')
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
  assert.equal(JSON.stringify(body).includes('secret-token'), false)
  assert.equal(JSON.stringify(body).includes('secret-passphrase'), false)
})

test('应用接线：禁用时不注册任何路由', () => {
  const connection = fakeConnection()
  const { ctx } = fakeContext(connection)
  apply(ctx, { enabled: false, serverUrl: 'http://127.0.0.1:8787', token: 't', passphrase: 'p' })
  assert.deepEqual(connection.routes, [])
})
