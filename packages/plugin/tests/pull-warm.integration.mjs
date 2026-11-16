import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevice } from '../../server/src/http.ts'
import { openDatabase } from '../../server/src/db.ts'
import { listenServer } from '../../server/tests/listen.mjs'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import { syncOnce as syncOnceRaw, pullSessionTask, warmSessionTask } from '../src/engine.ts'

const TEST_WORKSPACE_KEY = 'test-workspace-key-0001'
const syncOnce = (deps) => syncOnceRaw({ workspaceKeyOf: () => TEST_WORKSPACE_KEY, ...deps })

/** 没有 live 会话的 sessions 服务。 */
const sessions = { get: () => undefined, flush: async () => true }

const localCwd = process.platform === 'win32' ? 'D:/local' : '/local'
const mappedPath = process.platform === 'win32' ? 'D:/mapped' : '/mapped'

/** 发一个 JSON 请求。 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/** 拿 sync 租约（推送需要）。 */
async function holdLease(base, device) {
  const response = await call(base, '/v2/sync/lease', {
    method: 'POST',
    token: device.token,
    headers: { 'x-client-id': '0000000000000000' },
  })
  assert.equal(response.status, 200)
}

/** 造连续事件。 */
function events(from, to) {
  return Array.from({ length: to - from + 1 }, (_, offset) => ({
    type: 'test/event',
    seq: from + offset,
    time: 1000 + from + offset,
    data: { text: `event-${from + offset}` },
  }))
}

/** 造一个可读写的假本地存储。 */
function fakeStore(header, initialEvents = []) {
  const records = new Map()
  if (header !== undefined) records.set(header.id, { header, events: [...initialEvents] })
  const handleFor = (record) => ({
    header: record.header,
    inheritedEventCount: 0,
    read: async () => ({ events: record.events }),
    append: async (events) => { record.events.push(...events) },
    flush: async () => {},
    close: async () => {},
  })
  return {
    records,
    list: async () => [...records.values()].map((record) => ({
      header: record.header, eventCount: record.events.length, sizeBytes: 0,
    })),
    stat: async (id) => {
      const record = records.get(id)
      return record === undefined ? undefined : { header: record.header, eventCount: record.events.length, sizeBytes: 0 }
    },
    open: async (id) => {
      const record = records.get(id)
      if (record === undefined) throw new Error(`没有会话 ${id}`)
      return handleFor(record)
    },
    create: async (createdHeader) => {
      const record = { header: createdHeader, events: [] }
      records.set(createdHeader.id, record)
      return handleFor(record)
    },
  }
}

test('补热任务：只读本地日志刷新缓存，不碰远端', async () => {
  const header = {
    id: 'session-warm-only',
    version: 4,
    createdAt: 900,
    isSeeded: false,
    delegationDepth: 0,
    cwd: localCwd,
  }
  const store = fakeStore(header, events(0, 7))
  const warm = []
  const report = await warmSessionTask({
    persistence: store,
    warm: async (input) => { warm.push(input) },
  }, 'session-warm-only')
  assert.equal(report.status, 'up-to-date')
  assert.equal(report.totalEvents, 0)
  assert.equal(warm.length, 1)
  assert.equal(warm[0].header.id, 'session-warm-only')
  assert.equal(warm[0].lastSeq, 7)
  assert.deepEqual(warm[0].events.map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6, 7])

  const missing = await warmSessionTask({
    persistence: fakeStore(undefined),
    warm: async () => { throw new Error('不应预热不存在的会话') },
  }, 'session-warm-only')
  assert.equal(missing.status, 'up-to-date')
})

test('拉取预热：新会话、追加、已追平都带完整日志，活跃/被占用时不动缓存', async () => {
  const temp = createTempHome('plugin-pull-warm')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'pull-warm')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)

      const sessionId = 'session-pull-warm'
      const header = {
        id: sessionId,
        version: 4,
        createdAt: 4242,
        isSeeded: false,
        delegationDepth: 0,
        cwd: localCwd,
      }
      const source = fakeStore(header, events(0, 5))
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'pull-warm-pass',
        batchEvents: 2,
      }
      const pushed = await syncOnce({ persistence: source, sessions, config, isTailOpen: () => false })
      assert.equal(pushed.sessions[0].status, 'pushed')

      const warm = []
      const target = fakeStore(undefined)
      const pullDeps = {
        persistence: target,
        sessions,
        config,
        workspacePathOf: () => mappedPath,
        attach: async () => {},
        warm: async (input) => { warm.push(input) },
      }

      const first = await pullSessionTask(pullDeps, sessionId, false)
      assert.equal(first.status, 'pulled')
      assert.equal(warm.length, 1)
      assert.equal(warm[0].sessionId, sessionId)
      assert.equal(warm[0].header.id, sessionId)
      assert.equal(warm[0].header.createdAt, 4242)
      assert.equal(warm[0].inheritedEventCount, 0)
      assert.equal(warm[0].lastSeq, 5)
      assert.deepEqual(warm[0].events.map((event) => event.seq), [0, 1, 2, 3, 4, 5])

      // 已追平也要补热：缓存可能落后于日志（升级前拉过 / 缓存丢失）。
      const second = await pullSessionTask(pullDeps, sessionId, true)
      assert.equal(second.status, 'up-to-date')
      assert.equal(warm.length, 2)
      assert.equal(warm[1].events.length, 6)
      assert.equal(warm[1].lastSeq, 5)

      // 远端追加：预热拿到的是本地完整日志（旧事件 + 本次追加）。
      source.records.get(sessionId).events = events(0, 8)
      const pushedMore = await syncOnce({ persistence: source, sessions, config, isTailOpen: () => false })
      assert.equal(pushedMore.sessions[0].status, 'pushed')
      const third = await pullSessionTask(pullDeps, sessionId, true)
      assert.equal(third.status, 'pulled')
      assert.equal(third.applied, 3)
      assert.equal(warm.length, 3)
      assert.equal(warm[2].lastSeq, 8)
      assert.deepEqual(warm[2].events.map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8])

      // 活跃会话（本进程已加载）与写所有权冲突时不预热：缓存由 DSH 自己维护。
      const liveWarm = []
      const live = await pullSessionTask({
        persistence: fakeStore(header, events(0, 2)),
        sessions: { ...sessions, get: () => ({}) },
        config,
        workspacePathOf: () => mappedPath,
        warm: async (input) => { liveWarm.push(input) },
      }, sessionId, true)
      assert.equal(live.status, 'local-active')
      assert.equal(liveWarm.length, 0)

      const ownedWarm = []
      const owned = fakeStore(header, events(0, 2))
      const originalOpen = owned.open
      owned.open = async (id, access) => {
        if (access === 'write') {
          const error = new Error(`session "${id}" is already owned by an active write handle`)
          error.name = 'SessionAlreadyOwnedError'
          throw error
        }
        return originalOpen(id)
      }
      const ownedResult = await pullSessionTask({
        persistence: owned,
        sessions,
        config,
        workspacePathOf: () => mappedPath,
        warm: async (input) => { ownedWarm.push(input) },
      }, sessionId, true)
      assert.equal(ownedResult.status, 'write-owned')
      assert.equal(ownedWarm.length, 0)

      const aheadWarm = []
      const ahead = await pullSessionTask({
        persistence: fakeStore(header, events(0, 9)),
        sessions,
        config,
        workspacePathOf: () => mappedPath,
        warm: async (input) => { aheadWarm.push(input) },
      }, sessionId, true)
      assert.equal(ahead.status, 'local-ahead')
      assert.equal(aheadWarm.length, 0)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
