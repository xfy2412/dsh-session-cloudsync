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
  const created = []
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
    created,
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
      created.push(createdHeader.id)
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
        workspaceAllowlist: ['D:/local'],
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

test('推送引擎：白名单为空时整体不执行', async () => {
  const header = { id: 'session-no-allowlist', version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: 'D:/work' }
  const report = await syncOnce({
    persistence: fakePersistence(header, { events: events(0, 2) }),
    sessions,
    config: {
      serverUrl: 'http://127.0.0.1:1',
      token: 'token',
      passphrase: 'pass',
      workspaceAllowlist: [],
    },
  })
  assert.equal(report.configured, false)
  assert.equal(report.reason, 'workspaceAllowlist 未配置')
  assert.deepEqual(report.sessions, [])
})

test('推送引擎：默认同步子代理闭包，子先父后，白名单外的根跳过', async () => {
  const temp = createTempHome('plugin-closure')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'closure-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const root = {
        id: 'session-closure-root',
        version: 4,
        createdAt: 100,
        isSeeded: false,
        delegationDepth: 0,
        cwd: 'D:/work',
      }
      const child = {
        ...root,
        id: 'session-closure-child',
        createdAt: 200,
        delegationDepth: 1,
        parentSession: root.id,
        origin: 'subagent',
      }
      const other = { ...root, id: 'session-closure-other', createdAt: 300, cwd: 'D:/other' }
      const store = fakeStore(root, events(0, 1))
      store.sessions.set(child.id, { header: child, events: events(0, 2) })
      store.sessions.set(other.id, { header: other, events: events(0, 1) })

      const report = await syncOnce({
        persistence: store,
        sessions,
        config: {
          serverUrl: base,
          token: device.token,
          passphrase: 'closure pass',
          workspaceAllowlist: ['D:/work'],
        },
        isTailOpen: () => false,
      })

      const relevant = report.sessions.filter((entry) => entry.sessionId !== other.id)
      assert.deepEqual(relevant.map((entry) => [entry.sessionId, entry.status]), [
        [child.id, 'pushed'],
        [root.id, 'pushed'],
      ])
      assert.deepEqual(report.sessions.find((entry) => entry.sessionId === other.id), {
        sessionId: other.id,
        status: 'skipped',
        error: '工作区不在同步白名单',
      })
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('拉取引擎：子代理先创建，根会话后创建', async () => {
  const temp = createTempHome('plugin-pull-closure')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'pull-closure-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const root = {
        id: 'session-pull-root',
        version: 4,
        createdAt: 100,
        isSeeded: false,
        delegationDepth: 0,
        cwd: 'D:/work',
      }
      const child = {
        ...root,
        id: 'session-pull-child',
        createdAt: 200,
        delegationDepth: 1,
        parentSession: root.id,
        origin: 'subagent',
      }
      const storeA = fakeStore(root, events(0, 1))
      storeA.sessions.set(child.id, { header: child, events: events(0, 2) })

      const pushed = await syncOnce({
        persistence: storeA,
        sessions,
        config: {
          serverUrl: base,
          token: device.token,
          passphrase: 'pull closure pass',
          workspaceAllowlist: ['D:/work'],
        },
        isTailOpen: () => false,
      })
      assert.deepEqual(pushed.sessions.map((entry) => entry.sessionId), [child.id, root.id])

      const storeB = fakeStore(undefined)
      const attached = []
      const pulled = await pullOnce({
        persistence: storeB,
        sessions,
        config: {
          serverUrl: base,
          token: device.token,
          passphrase: 'pull closure pass',
          workspaceAllowlist: ['D:/work', 'D:/b'],
        },
        workspacePath: 'D:/b',
        attach: async (id) => {
          attached.push({
            id,
            created: storeB.created.length,
            events: storeB.sessions.get(id)?.events.length ?? -1,
          })
        },
      }, { revision: 0 })

      assert.equal(pulled.configured, true)
      assert.deepEqual(storeB.created, [child.id, root.id])
      assert.deepEqual(pulled.sessions.map((entry) => entry.sessionId), [child.id, root.id])
      // 所有会话先 apply 完，最后才挂载；子代理先于根，但两者挂载时已有完整闭包。
      assert.deepEqual(attached, [
        { id: child.id, created: 2, events: 3 },
        { id: root.id, created: 2, events: 2 },
      ])
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('拉取引擎：白名单为空或拉取目标不在白名单时整体不执行', async () => {
  const base = {
    serverUrl: 'http://127.0.0.1:1',
    token: 'token',
    passphrase: 'pass',
  }
  const store = fakeStore(undefined)
  const empty = await pullOnce({
    persistence: store,
    sessions,
    config: { ...base, workspaceAllowlist: [] },
    workspacePath: 'D:/b',
  }, { revision: 0 })
  assert.equal(empty.configured, false)
  assert.equal(empty.reason, 'workspaceAllowlist 未配置')

  const outside = await pullOnce({
    persistence: store,
    sessions,
    config: { ...base, workspaceAllowlist: ['D:/a'] },
    workspacePath: 'D:/b',
  }, { revision: 0 })
  assert.equal(outside.configured, false)
  assert.equal(outside.reason, 'workspacePath 不在同步白名单')
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
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'pending pass',
        workspaceAllowlist: ['D:/a', 'D:/b'],
        batchEvents: 20,
      }
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

test('拉取引擎：一个会话失败后停止，不覆盖它的 pending', async () => {
  const temp = createTempHome('plugin-pending-stop')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'pending-stop-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const firstId = 'session-pending-stop-1'
      const secondId = 'session-pending-stop-2'
      const header = (id, createdAt) => ({
        id,
        version: 4,
        createdAt,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'standard',
        cwd: 'D:/a',
      })
      const storeA = fakeStore(header(firstId, 100), events(0, 3))
      storeA.sessions.set(secondId, { header: header(secondId, 200), events: events(0, 5) })
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'pending stop pass',
        workspaceAllowlist: ['D:/a', 'D:/b'],
        batchEvents: 20,
      }
      const pushed = await syncOnce({ persistence: storeA, sessions, config, isTailOpen: () => false })
      assert.equal(pushed.sessions.length, 2)

      const storeB = fakeStore(undefined, [], { failAppendOnce: true })
      let pending
      const pulled = await pullOnce({
        persistence: storeB,
        sessions,
        config,
        workspacePath: 'D:/b',
        attach: async () => {},
        beforeApply: async (id, targetSeq) => { pending = { sessionId: id, targetSeq, at: 1 } },
        afterApply: async (id) => {
          if (pending?.sessionId === id) pending = undefined
        },
      }, { revision: 0 })

      assert.equal(pulled.sessions.length, 1, '第一个会话失败后应立即停止')
      assert.equal(pulled.sessions[0].status, 'error')
      assert.deepEqual(pending?.sessionId, pulled.sessions[0].sessionId)
      assert.equal(storeB.sessions.size, 1, '不应开始创建第二个会话')
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('推送引擎：未配置时不动作，离线时只报告错误不抛出', async () => {
  const header = {
    id: 'session-engine-offline',
    version: 4,
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
    cwd: 'D:/offline',
  }
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
    config: {
      serverUrl: 'http://127.0.0.1:1',
      token: 'token',
      passphrase: 'pass',
      workspaceAllowlist: ['D:/offline'],
    },
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
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'pull pass',
        workspaceAllowlist: ['D:/device-a', 'D:/device-b'],
        batchEvents: 50,
      }

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
