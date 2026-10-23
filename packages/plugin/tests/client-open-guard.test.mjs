import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../client/index.js', import.meta.url))

/** 造一个足够让客户端 apply 跑起来的 React 替身。 */
const React = {
  createElement: (...args) => ({ args }),
  useCallback: (fn) => fn,
  useEffect: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

test('客户端 openSession guard：拦冷危险会话、放行 live/安全/未知目标，dispose 还原', async () => {
  const status = {
    schemaVersion: 2,
    statusVersion: 1,
    configured: true,
    reason: null,
    running: false,
    run: { id: 1, trigger: 'auto', state: 'finished', startedAt: 1, finishedAt: 2 },
    scheduler: { autoSync: false, intervalMs: 60_000, nextRunAt: null, backoffUntil: null },
    deviceLease: { state: 'held' },
    lastAttempt: 1,
    lastSuccess: 2,
    lastError: null,
    retryCount: 0,
    nextRetryAt: null,
    pending: null,
    revision: 0,
    sessions: [
      {
        sessionId: 'cold-danger', phase: 'deferred', live: false, tailOpen: false,
        remoteAhead: true, cwdPending: false, pending: { upload: 0, download: 3 },
        totalEvents: 0, doneEvents: 0, updatedAt: 2,
      },
      {
        sessionId: 'cold-safe', phase: 'done', live: false, tailOpen: false,
        remoteAhead: false, cwdPending: false, pending: { upload: 0, download: 0 },
        totalEvents: 0, doneEvents: 0, updatedAt: 2,
      },
      {
        sessionId: 'live-danger', phase: 'deferred', live: true, tailOpen: false,
        remoteAhead: true, cwdPending: false, pending: { upload: 0, download: 3 },
        totalEvents: 0, doneEvents: 0, updatedAt: 2,
      },
    ],
  }
  const calls = []
  const workspace = {
    openSession(target) {
      calls.push(target)
    },
  }
  const originalOpenSession = workspace.openSession
  const disposers = []
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    get(name) {
      return name === 'uiWorkspace' ? workspace : undefined
    },
    effect(fn) {
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    slots: {
      inject() {},
      register() { return () => {} },
    },
  }

  let loaded
  const document = {
    visibilityState: 'visible',
    head: { appendChild() {} },
    createElement() {
      return { dataset: {}, style: {}, textContent: '', remove() {} }
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const sandbox = {
    console,
    document,
    window: {
      __ModuleLoader__: {
        load(config) { loaded = config },
      },
    },
    fetch: async (url) => {
      const path = String(url)
      if (path.endsWith('/status')) {
        // 直接返回同一个对象，测试改 status.deviceLease 时客户端能看到。
        return { ok: true, status: 200, json: async () => ({ ok: true, value: status }) }
      }
      if (path.endsWith('/setup')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: { configured: true } }) }
      }
      throw new Error(`unexpected fetch ${path}`)
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    TextDecoder,
    Response,
    Request,
    URL,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: CLIENT_PATH })
  assert.ok(loaded)
  loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require ${name}`)
  }).apply(ctx)

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.notEqual(workspace.openSession, originalOpenSession)

  workspace.openSession('cold-danger')
  assert.equal(calls.length, 0)
  workspace.openSession('cold-safe')
  assert.equal(calls.length, 1)

  // 全局租约 foreign：冷会话即使自身安全也不能打开；live 仍允许切换查看。
  status.deviceLease = { state: 'foreign' }
  workspace.openSession('cold-safe')
  assert.equal(calls.length, 1)
  workspace.openSession('live-danger')
  assert.equal(calls.length, 2)
  status.deviceLease = { state: 'held' }
  workspace.openSession('cold-safe')
  assert.equal(calls.length, 3)
  workspace.openSession({ parentSessionId: 'p', childSessionId: 'cold-danger' })
  assert.equal(calls.length, 3)
  workspace.openSession('unknown-session')
  assert.equal(calls.length, 4)

  for (const dispose of disposers.reverse()) {
    if (typeof dispose === 'function') await dispose()
  }
  assert.equal(workspace.openSession, originalOpenSession)
  workspace.openSession('cold-danger')
  assert.equal(calls.length, 5)
})
