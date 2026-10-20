import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevice } from '../../server/src/http.ts'
import { openDatabase } from '../../server/src/db.ts'
import { listenServer } from '../../server/tests/listen.mjs'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import {
  classifySyncError,
  pullOnce,
  syncOnce,
  SyncHttpError,
} from '../src/engine.ts'

/** 发一个 JSON 请求。 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
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

/** 造一个假的持久化服务。 */
function fakePersistence(header, state) {
  return {
    list: async () => [{ header, eventCount: state.events.length, sizeBytes: 0 }],
    open: async () => ({
      header,
      inheritedEventCount: 0,
      read: async () => ({ events: state.events }),
      close: async () => {},
    }),
  }
}

/** 造一个可读写的假本地存储。 */
function fakeStore(header, initialEvents = [], options = {}) {
  const sessions = new Map()
  if (header !== undefined) sessions.set(header.id, { header, events: [...initialEvents] })
  const handleFor = (record) => ({
    header: record.header,
    inheritedEventCount: 0,
    read: async () => ({ events: record.events }),
    append: async (events) => {
      if (options.failAppendOnce === true) {
        options.failAppendOnce = false
        throw new Error('simulated append failure')
      }
      record.events.push(...events)
    },
    flush: async () => {},
    close: async () => {},
  })
  return {
    sessions,
    list: async () => [...sessions.values()].map((record) => ({
      header: record.header,
      eventCount: record.events.length,
      sizeBytes: 0,
    })),
    stat: async (id) => {
      const record = sessions.get(id)
      return record === undefined ? undefined : { header: record.header, eventCount: record.events.length, sizeBytes: 0 }
    },
    open: async (id) => {
      const record = sessions.get(id)
      if (record === undefined) throw new Error(`没有会话 ${id}`)
      return handleFor(record)
    },
    create: async (createdHeader) => {
      const record = { header: createdHeader, events: [] }
      sessions.set(createdHeader.id, record)
      return handleFor(record)
    },
  }
}

/** 造一个没有 live 会话的 sessions 服务。 */
const sessions = {
  get: () => undefined,
  flush: async () => true,
}

test('推送引擎：首次推送 header+批次，重复执行增量追加', async () => {
  const temp = createTempHome('plugin-engine')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'engine-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const sessionId = 'session-engine-test'
      const header = {
        id: sessionId,
        version: 4,
        createdAt: 777,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'standard',
        cwd: 'D:/local',
      }
      const state = { events: events(0, 119) }
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'correct horse battery staple',
        batchEvents: 50,
      }
      const persistence = fakePersistence(header, state)
      const isTailOpen = () => false

      const first = await syncOnce({ persistence, sessions, config, isTailOpen })
      assert.equal(first.configured, true)
      assert.equal(first.sessions.length, 1)
      assert.equal(first.sessions[0].status, 'pushed')
      assert.equal(first.sessions[0].batches, 3)
      assert.ok(first.sessions[0].bytes > 0)

      const manifest1 = await call(base, `/v1/sessions/${sessionId}/manifest`, { token: device.token })
      assert.equal(manifest1.status, 200)
      assert.equal(manifest1.body.value.manifest.frames.length, 4)
      assert.equal(manifest1.body.value.manifest.lastSeq, 119)
      assert.equal(manifest1.body.value.manifest.tailOpen, false)
      assert.equal(manifest1.body.value.manifest.safeThroughSeq, 119)
      assert.equal(manifest1.body.value.manifest.frames[0].seqFrom, -1)
      assert.equal(manifest1.body.value.manifest.frames[1].seqFrom, 0)

      const second = await syncOnce({ persistence, sessions, config, isTailOpen })
      assert.equal(second.sessions[0].status, 'up-to-date')

      state.events = events(0, 149)
      const third = await syncOnce({ persistence, sessions, config, isTailOpen })
      assert.equal(third.sessions[0].status, 'pushed')
      assert.equal(third.sessions[0].batches, 1)

      const manifest2 = await call(base, `/v1/sessions/${sessionId}/manifest`, { token: device.token })
      assert.equal(manifest2.body.value.manifest.frames.length, 5)
      assert.equal(manifest2.body.value.manifest.lastSeq, 149)
      assert.equal(manifest2.body.value.manifest.safeThroughSeq, 149)
      assert.equal(manifest2.body.value.manifest.frames[4].seqFrom, 120)
      assert.equal(manifest2.body.value.manifest.frames[4].seqTo, 149)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('错误分类：auth / lease / network / crypto', () => {
  assert.equal(classifySyncError(new SyncHttpError('unauthorized', 401)).kind, 'auth')
  const lease = new SyncHttpError('lease held', 409, 'lease-held')
  assert.equal(classifySyncError(lease).kind, 'lease-held')
  assert.equal(classifySyncError(new Error('fetch failed')).kind, 'network')
  assert.equal(classifySyncError(new Error('封帧认证失败（密文、AAD 或密钥不匹配）')).kind, 'crypto')
  assert.equal(classifySyncError(new SyncHttpError('quota', 507)).retryable, true)
})

test('拉取引擎：append 失败留下 pending，重启后按 pending 补完', async () => {
  const temp = createTempHome('plugin-pending')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'pending-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const sessionId = 'session-pending-test'
      const headerA = {
        id: sessionId,
        version: 4,
        createdAt: 999,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'standard',
        cwd: 'D:/a',
      }
      const eventsA = events(0, 59)
      const storeA = fakeStore(headerA, eventsA)
      const config = { serverUrl: base, token: device.token, passphrase: 'pending pass', batchEvents: 20 }
      assert.equal((await syncOnce({ persistence: storeA, sessions, config, isTailOpen: () => false })).sessions[0].status, 'pushed')

      const storeB = fakeStore(undefined, [], { failAppendOnce: true })
      let pending
      const deps = {
        persistence: storeB,
        sessions,
        config,
        workspacePath: 'D:/b',
        attach: async () => {},
        beforeApply: async (id, targetSeq) => {
          pending = { sessionId: id, targetSeq, at: 1 }
        },
        afterApply: async () => { pending = undefined },
      }

      const first = await pullOnce(deps, { revision: 0 })
      assert.equal(first.sessions[0].status, 'error')
      assert.equal(first.sessions[0].kind, 'unknown')
      assert.ok(pending !== undefined, 'append 失败后应留下 pending')
      assert.equal(storeB.sessions.get(sessionId).events.length, 0)

      const second = await pullOnce(deps, { revision: 0, pending })
      assert.equal(second.sessions.some((entry) => entry.status === 'pulled' || entry.status === 'up-to-date'), true)
      assert.equal(pending, undefined, '恢复成功后应清除 pending')
      assert.equal(storeB.sessions.get(sessionId).events.length, 60)
      assert.equal(storeB.sessions.get(sessionId).events.at(-1).seq, 59)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('推送引擎：未配置时不动作，离线时只报告错误不抛出', async () => {
  const header = { id: 'session-engine-offline', version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const state = { events: events(0, 2) }
  const persistence = fakePersistence(header, state)

  const disabled = await syncOnce({
    persistence,
    sessions,
    config: { serverUrl: '', token: '', passphrase: '' },
  })
  assert.equal(disabled.configured, false)

  const offline = await syncOnce({
    persistence,
    sessions,
    config: { serverUrl: 'http://127.0.0.1:1', token: 'token', passphrase: 'pass' },
  })
  assert.equal(offline.configured, true)
  assert.equal(offline.sessions[0].status, 'error')
  assert.ok((offline.sessions[0].error ?? '').length > 0)
})

test('拉取引擎：只 apply 到安全边界，开放尾闭合后再补', async () => {
  const temp = createTempHome('plugin-pull')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'pull-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const sessionId = 'session-pull-test'
      const headerA = {
        id: sessionId,
        version: 4,
        createdAt: 888,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'standard',
        cwd: 'D:/device-a',
      }
      const eventsA = events(0, 119)
      eventsA[eventsA.length - 1] = { ...eventsA[eventsA.length - 1], type: 'turn/end' }
      const storeA = fakeStore(headerA, eventsA)
      const config = { serverUrl: base, token: device.token, passphrase: 'pull pass', batchEvents: 50 }

      const firstPush = await syncOnce({
        persistence: storeA,
        sessions,
        config,
        isTailOpen: () => false,
      })
      assert.equal(firstPush.sessions[0].status, 'pushed')

      // A 追加一个开放尾事件（turn/start，没有 turn/end）再推。
      storeA.sessions.get(sessionId).events.push({ type: 'turn/start', seq: 120, time: 2000, data: { turn: 2 } })
      const openPush = await syncOnce({
        persistence: storeA,
        sessions,
        config,
        isTailOpen: (events) => events[events.length - 1]?.type !== 'turn/end',
      })
      assert.equal(openPush.sessions[0].status, 'pushed')

      const storeB = fakeStore(undefined)
      const attached = []
      const pulled = await pullOnce({
        persistence: storeB,
        sessions,
        config,
        workspacePath: 'D:/device-b',
        attach: async (id) => { attached.push(id) },
      }, { revision: 0 })
      assert.equal(pulled.configured, true)
      assert.equal(pulled.sessions[0].status, 'partial')
      const localB = storeB.sessions.get(sessionId)
      assert.equal(localB.events.length, 120)
      assert.equal(localB.events[localB.events.length - 1].seq, 119)
      assert.deepEqual(attached, [sessionId])

      // 闭合 turn：追加 turn/end 再推，B 只补 120..121。
      storeA.sessions.get(sessionId).events.push({ type: 'turn/end', seq: 121, time: 2001, data: { turn: 2, reason: { kind: 'completed' } } })
      const closedPush = await syncOnce({
        persistence: storeA,
        sessions,
        config,
        isTailOpen: () => false,
      })
      assert.equal(closedPush.sessions[0].status, 'pushed')

      const pulledAgain = await pullOnce({
        persistence: storeB,
        sessions,
        config,
        workspacePath: 'D:/device-b',
        attach: async () => {},
      }, { revision: pulled.revision })
      assert.equal(pulledAgain.sessions[0].status, 'pulled')
      assert.equal(localB.events.length, 122)
      assert.equal(localB.events[localB.events.length - 1].seq, 121)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
