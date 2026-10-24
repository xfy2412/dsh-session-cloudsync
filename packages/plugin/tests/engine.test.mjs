import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDevice, SERVER_VERSION } from '../../server/src/http.ts'
import { PROTOCOL_VERSION } from '../../shared/src/protocol.ts'
import { openDatabase } from '../../server/src/db.ts'
import { listenServer } from '../../server/tests/listen.mjs'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import {
  classifySyncError,
  correctCwd,
  pullOnce,
  syncOnce as syncOnceRaw,
  SyncHttpError,
  testConnection,
} from '../src/engine.ts'

const TEST_WORKSPACE_KEY = 'test-workspace-key-0001'
/** 测试默认给每个推送根会话一个稳定 key；V2 严格模式不再接受无 key。 */
const syncOnce = (deps) => syncOnceRaw({ workspaceKeyOf: () => TEST_WORKSPACE_KEY, ...deps })

/** 路径边界测试必须使用当前平台的绝对路径；POSIX 上 D:/local 是相对路径。 */
const localCwd = process.platform === 'win32' ? 'D:/local' : '/local'
const otherCwd = process.platform === 'win32' ? 'D:/other' : '/other'

/** 发一个 JSON 请求。 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/**
 * 取得全局同步租约；推送测试都通过真实服务端，append 现在要求它。
 * @param base - 基地址。
 * @param device - 设备。
 */
async function holdLease(base, device) {
  const response = await call(base, '/v1/sync/lease', {
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

/** 造一条 working-directory/change。 */
function cwdEvent(seq, cwd) {
  return { type: 'working-directory/change', seq, time: 2000 + seq, data: { cwd } }
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

test('V2 推送写入 workspaceKey，拉取按映射落点，未映射不 apply', async () => {
  const temp = createTempHome('plugin-v2')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'v2-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)

      const sessionId = 'session-v2-mapping'
      const workspaceKey = 'abcdefghijklmnopqrstuvwx'
      const header = {
        id: sessionId,
        version: 4,
        createdAt: 901,
        isSeeded: false,
        delegationDepth: 0,
        cwd: localCwd,
      }
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'v2 pass',
        batchEvents: 2,
      }
      const pushedProgress = []
      const pushed = await syncOnce({
        persistence: fakeStore(header, events(0, 5)),
        sessions,
        config,
        isTailOpen: () => false,
        workspaceKeyOf: () => workspaceKey,
        onProgress: (progress) => { pushedProgress.push(progress) },
      })
      assert.equal(pushed.sessions[0].status, 'pushed')
      assert.equal(pushed.sessions[0].totalEvents, 6)
      assert.equal(pushed.sessions[0].doneEvents, 6)
      assert.ok(pushedProgress.some((progress) => progress.direction === 'push'
        && progress.totalEvents === 6 && progress.doneEvents === 6))
      assert.ok(pushedProgress.some((progress) => progress.direction === 'push'
        && progress.phase === 'progress' && progress.doneEvents === 2))
      assert.ok(pushedProgress.some((progress) => progress.direction === 'push'
        && progress.phase === 'progress' && progress.doneEvents === 4))
      assert.ok(pushedProgress.some((progress) => progress.direction === 'push'
        && progress.phase === 'done' && progress.doneEvents === 6))
      const manifest = await call(base, `/v1/sessions/${sessionId}/manifest`, { token: device.token })
      assert.equal(manifest.body.value.manifest.workspaceKey, workspaceKey)

      // 已有远端 manifest 的会话沿用远端 key：映射到本地路径后不会因为本地
      // 解析出的 key 变化而被判成分叉。
      const reused = await syncOnce({
        persistence: fakeStore(header, events(0, 5)),
        sessions,
        config,
        isTailOpen: () => false,
        workspaceKeyOf: () => 'differentworkspacekey',
      })
      assert.equal(reused.sessions[0].status, 'up-to-date')
      const reusedManifest = await call(base, `/v1/sessions/${sessionId}/manifest`, { token: device.token })
      assert.equal(reusedManifest.body.value.manifest.workspaceKey, workspaceKey)

      // 活跃会话本轮不 apply，游标必须停在它之前，否则 push 会一直 remote-ahead。
      const active = await pullOnce({
        persistence: fakeStore(undefined),
        sessions: { ...sessions, get: () => ({}) },
        config,
        workspacePathOf: (key) => key === workspaceKey ? 'D:/mapped' : undefined,
      }, { revision: 0 })
      assert.equal(active.sessions[0].status, 'local-active')
      assert.equal(active.sessions[0].totalEvents, 6)
      assert.equal(active.sessions[0].pendingEvents, 6)
      assert.equal(active.revision, 0)

      // 未映射报告带 cursor revision；游标越过之后不会再次交付。
      const firstPull = await pullOnce({
        persistence: fakeStore(undefined),
        sessions,
        config,
        workspacePathOf: () => undefined,
      }, { revision: 0 })
      assert.equal(firstPull.sessions[0].status, 'unmapped')
      assert.equal(typeof firstPull.sessions[0].revision, 'number')
      const secondPull = await pullOnce({
        persistence: fakeStore(undefined),
        sessions,
        config,
        workspacePathOf: () => undefined,
      }, { revision: firstPull.revision })
      assert.deepEqual(secondPull.sessions, [])

      const mappedStore = fakeStore(undefined)
      const mappedProgress = []
      const mapped = await pullOnce({
        persistence: mappedStore,
        sessions,
        config,
        workspacePathOf: (key) => key === workspaceKey ? 'D:/mapped' : undefined,
        onProgress: (progress) => { mappedProgress.push(progress) },
      })
      assert.equal(mapped.sessions[0].status, 'pulled')
      assert.equal(mapped.sessions[0].applied, 6)
      assert.equal(mapped.sessions[0].totalEvents, 6)
      assert.equal(mapped.sessions[0].pendingEvents, 0)
      assert.ok(mappedProgress.some((progress) => progress.direction === 'pull'
        && progress.totalEvents === 6 && progress.doneEvents === 6))
      assert.ok(mappedProgress.some((progress) => progress.direction === 'pull'
        && progress.phase === 'progress' && progress.doneEvents === 2))
      assert.ok(mappedProgress.some((progress) => progress.direction === 'pull'
        && progress.phase === 'progress' && progress.doneEvents === 4))
      assert.equal(mappedStore.sessions.get(sessionId).header.cwd, 'D:/mapped')

      // 已加载但已经是最新：只读判断后返回 up-to-date，不能因为 live 就兜底
      // local-active 卡住游标。
      const liveCurrent = await pullOnce({
        persistence: mappedStore,
        sessions: { ...sessions, get: () => ({}) },
        config,
        workspacePathOf: (key) => key === workspaceKey ? 'D:/mapped' : undefined,
      }, { revision: 0 })
      assert.equal(liveCurrent.sessions[0].status, 'up-to-date')
      assert.equal(liveCurrent.revision, mapped.revision)

      const unmappedStore = fakeStore(undefined)
      const unmapped = await pullOnce({
        persistence: unmappedStore,
        sessions,
        config,
        workspacePathOf: () => undefined,
      })
      assert.equal(unmapped.sessions[0].status, 'unmapped')
      assert.equal(unmappedStore.sessions.has(sessionId), false)

      const excludedStore = fakeStore(undefined)
      const excluded = await pullOnce({
        persistence: excludedStore,
        sessions,
        config: { ...config, excludedSessionIds: [sessionId] },
        workspacePathOf: () => 'D:/mapped',
      })
      assert.equal(excluded.sessions[0].status, 'excluded')
      assert.equal(excludedStore.sessions.has(sessionId), false)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('推送引擎：首次推送 header+批次，重复执行增量追加', async () => {
  const temp = createTempHome('plugin-engine')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'engine-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)

      const sessionId = 'session-engine-test'
      const header = {
        id: sessionId,
        version: 4,
        createdAt: 777,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'standard',
        cwd: localCwd,
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
      assert.equal(manifest1.body.value.manifest.batches.length, 4)
      assert.equal(manifest1.body.value.manifest.lastSeq, 119)
      assert.equal(manifest1.body.value.manifest.tailOpen, false)
      assert.equal(manifest1.body.value.manifest.safeThroughSeq, 119)
      assert.equal(manifest1.body.value.manifest.batches[0].seqFrom, -1)
      assert.equal(manifest1.body.value.manifest.batches[1].seqFrom, 0)

      const second = await syncOnce({ persistence, sessions, config, isTailOpen })
      assert.equal(second.sessions[0].status, 'up-to-date')

      state.events = events(0, 149)
      const third = await syncOnce({ persistence, sessions, config, isTailOpen })
      assert.equal(third.sessions[0].status, 'pushed')
      assert.equal(third.sessions[0].batches, 1)

      const manifest2 = await call(base, `/v1/sessions/${sessionId}/manifest`, { token: device.token })
      assert.equal(manifest2.body.value.manifest.batches.length, 5)
      assert.equal(manifest2.body.value.manifest.lastSeq, 149)
      assert.equal(manifest2.body.value.manifest.safeThroughSeq, 149)
      assert.equal(manifest2.body.value.manifest.batches[4].seqFrom, 120)
      assert.equal(manifest2.body.value.manifest.batches[4].seqTo, 149)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('共享前缀校验：raw 前缀不同则拒绝推送/拉取，一致则允许跨界批次', async () => {
  const temp = createTempHome('plugin-prefix')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'prefix-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)

      const sessionId = 'session-prefix-test'
      const header = {
        id: sessionId,
        version: 4,
        createdAt: 900,
        isSeeded: false,
        delegationDepth: 0,
        cwd: localCwd,
      }
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'prefix pass',
        batchEvents: 50,
      }
      const source = fakeStore(header, events(0, 119))
      const first = await syncOnce({ persistence: source, sessions, config, isTailOpen: () => false })
      assert.equal(first.sessions[0].status, 'pushed')

      // 推送方向：本地 120 条，但第 50 条内容不同；不能把远端当成同一历史。
      const divergent = events(0, 119)
      divergent[50].data.text = 'tampered'
      const pushDiverged = await syncOnce({
        persistence: fakeStore(header, divergent),
        sessions,
        config,
        isTailOpen: () => false,
      })
      assert.equal(pushDiverged.sessions[0].status, 'error')
      assert.equal(pushDiverged.sessions[0].kind, 'diverged')

      // 拉取方向：本地只到 59，但第 50 条不同；跨界的远端批次也必须比较重叠段。
      const localDiverged = events(0, 59)
      localDiverged[50].data.text = 'tampered'
      const pullDiverged = await pullOnce({
        persistence: fakeStore(header, localDiverged),
        sessions,
        config,
        workspacePathOf: () => localCwd,
      }, { revision: 0 })
      assert.equal(pullDiverged.sessions[0].status, 'error')
      assert.equal(pullDiverged.sessions[0].kind, 'diverged')

      // 本地只到 59 且完全相同：跨界批次通过，拉取 60..119。
      const localAhead = fakeStore(header, events(0, 59))
      const pulled = await pullOnce({
        persistence: localAhead,
        sessions,
        config,
        workspacePathOf: () => localCwd,
      }, { revision: 0 })
      assert.equal(pulled.sessions[0].status, 'pulled')
      assert.equal(localAhead.sessions.get(sessionId).events.length, 120)

      // 本地和远端完全一致：up-to-date。
      const same = await syncOnce({
        persistence: fakeStore(header, events(0, 119)),
        sessions,
        config,
        isTailOpen: () => false,
      })
      assert.equal(same.sessions[0].status, 'up-to-date')
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('nonPortable：只看最后 cwd，且不阻塞推拉', async () => {
  const temp = createTempHome('plugin-nonportable')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'nonportable-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)

      const sessionId = 'session-nonportable-test'
      const header = {
        id: sessionId,
        version: 4,
        createdAt: 1000,
        isSeeded: false,
        delegationDepth: 0,
        cwd: localCwd,
      }
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'nonportable pass',
        batchEvents: 50,
      }
      const outside = [...events(0, 2), cwdEvent(3, otherCwd)]
      const pushed = await syncOnce({
        persistence: fakeStore(header, outside),
        sessions,
        config,
        isTailOpen: () => false,
      })
      assert.equal(pushed.sessions[0].status, 'pushed')
      assert.equal(pushed.sessions[0].cwdNonPortable, true)

      // 拉取到另一个工作区根时，最后 cwd 仍在工作区外，只告警且暂不挂载。
      const attached = []
      const pulled = await pullOnce({
        persistence: fakeStore(undefined),
        sessions,
        config,
        workspacePathOf: () => localCwd,
        attach: async (id) => { attached.push(id) },
      }, { revision: 0 })
      assert.equal(pulled.sessions[0].status, 'pulled')
      assert.equal(pulled.sessions[0].cwdNonPortable, true)
      assert.deepEqual(attached, [])

      // 后来的 change 回到工作区内，源端 nonPortable 应清除。
      const backInside = [...outside, cwdEvent(4, `${localCwd}/sub`)]
      const repushed = await syncOnce({
        persistence: fakeStore(header, backInside),
        sessions,
        config,
        isTailOpen: () => false,
      })
      assert.equal(repushed.sessions[0].status, 'pushed')
      assert.equal(repushed.sessions[0].cwdNonPortable, undefined)

      const pulledInside = await pullOnce({
        persistence: fakeStore(undefined),
        sessions,
        config,
        workspacePathOf: () => localCwd,
      }, { revision: 0 })
      assert.equal(pulledInside.sessions[0].status, 'pulled')
      assert.equal(pulledInside.sessions[0].cwdNonPortable, undefined)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('接收端 cwd 修正：租约内 append 并立即推送', async () => {
  const temp = createTempHome('plugin-correct-cwd')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'correct-cwd-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)

      const sessionId = 'session-correct-cwd-test'
      const header = {
        id: sessionId,
        version: 4,
        createdAt: 1100,
        isSeeded: false,
        delegationDepth: 0,
        cwd: localCwd,
      }
      const outside = [...events(0, 2), cwdEvent(3, otherCwd)]
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'correct pass',
        batchEvents: 50,
      }
      await syncOnce({
        persistence: fakeStore(header, outside),
        sessions,
        config,
        isTailOpen: () => false,
      })

      const target = fakeStore(header, outside)
      const result = await correctCwd({
        persistence: target,
        sessions,
        config,
        targetPath: localCwd,
      }, sessionId)
      assert.equal(result.ok, true)
      assert.equal(result.status, 'corrected')
      const corrected = target.sessions.get(sessionId)
      assert.equal(corrected.events.length, 5)
      assert.equal(corrected.events[4].type, 'working-directory/change')
      assert.equal(corrected.events[4].data.cwd, localCwd)

      const manifest = await call(base, `/v1/sessions/${sessionId}/manifest`, { token: device.token })
      assert.equal(manifest.body.value.manifest.lastSeq, 4)
      assert.equal(manifest.body.value.manifest.safeThroughSeq, 4)

      const again = await correctCwd({ persistence: target, sessions, config, targetPath: localCwd }, sessionId)
      assert.equal(again.status, 'already-portable')

      // 远端已推进、本地还停在旧边界时不能 append，避免制造分叉。
      const stale = fakeStore(header, outside)
      const refused = await correctCwd({ persistence: stale, sessions, config, targetPath: localCwd }, sessionId)
      assert.equal(refused.ok, false)
      assert.equal(refused.status, 'needs-sync')
      assert.equal(stale.sessions.get(sessionId).events.length, 4)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('拉取引擎：一个只读阶段失败后继续其他安全会话', async () => {
  const temp = createTempHome('plugin-pull-continue')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'pull-continue-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)

      const headerA = {
        id: 'session-continue-a',
        version: 4,
        createdAt: 1200,
        isSeeded: false,
        delegationDepth: 0,
        cwd: 'D:/work',
      }
      const headerB = { ...headerA, id: 'session-continue-b', createdAt: 1201 }
      const config = {
        serverUrl: base,
        token: device.token,
        passphrase: 'pull continue pass',
        batchEvents: 50,
      }
      const source = fakeStore(headerA, events(0, 2))
      source.sessions.set(headerB.id, { header: headerB, events: events(0, 1) })
      await syncOnce({
        persistence: source,
        sessions,
        config,
        isTailOpen: () => false,
      })

      const divergent = events(0, 2)
      divergent[1].data.text = 'tampered'
      const local = fakeStore(headerA, divergent)
      const attached = []
      const result = await pullOnce({
        persistence: local,
        sessions,
        config,
        workspacePathOf: () => 'D:/work',
        attach: async (id) => { attached.push(id) },
      }, { revision: 0 })

      const failed = result.sessions.find((entry) => entry.sessionId === headerA.id)
      const safe = result.sessions.find((entry) => entry.sessionId === headerB.id)
      assert.equal(failed.status, 'error')
      assert.equal(failed.kind, 'diverged')
      assert.equal(safe.status, 'pulled')
      assert.deepEqual(attached, [headerB.id])
      assert.equal(result.revision, 0)
      assert.equal(local.sessions.has(headerB.id), true)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('推送引擎：本地排除根会话时不推送', async () => {
  const header = { id: 'session-no-allowlist', version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: 'D:/work' }
  const report = await syncOnce({
    persistence: fakePersistence(header, { events: events(0, 2) }),
    sessions,
    config: {
      serverUrl: 'http://127.0.0.1:1',
      token: 'token',
      passphrase: 'pass',
      excludedSessionIds: [header.id],
    },
  })
  assert.equal(report.configured, true)
  assert.deepEqual(report.sessions.map((entry) => [entry.sessionId, entry.status, entry.error]), [
    [header.id, 'skipped', '根会话未选中'],
  ])
})

test('推送引擎：默认同步子代理闭包，子先父后，被排除的根跳过', async () => {
  const temp = createTempHome('plugin-closure')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'closure-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)

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
      const other = { ...root, id: 'session-closure-other', createdAt: 300, cwd: otherCwd }
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
          excludedSessionIds: [other.id],
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
        error: '根会话未选中',
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
      await holdLease(base, device)

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
        },
        workspacePathOf: () => 'D:/b',
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

test('连接测试：只探测公开的 /v1/health，不读配置也不带 token', async () => {
  const temp = createTempHome('plugin-test-connection')
  try {
    const db = openDatabase(temp.dataDir)
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const result = await testConnection(`${base}/`)
      assert.equal(result.ok, true)
      assert.equal(result.version, SERVER_VERSION)
      assert.equal(result.protocol, PROTOCOL_VERSION)

      const offline = await testConnection('http://127.0.0.1:1')
      assert.equal(offline.ok, false)
      assert.equal(offline.kind, 'network')

      const wrongPath = await testConnection(`${base}/missing`)
      assert.equal(wrongPath.ok, false)
      assert.equal(wrongPath.kind, 'not-found')

      assert.deepEqual(await testConnection(''), {
        ok: false,
        kind: 'config',
        message: 'serverUrl 未配置',
      })
      assert.deepEqual(await testConnection('not a url'), {
        ok: false,
        kind: 'config',
        message: 'serverUrl 非法',
      })
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('连接测试：读取超时归类为 network', async () => {
  const result = await testConnection('http://127.0.0.1:1', (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('request timeout')))
  }), 10)
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'network')
  assert.equal(result.message, 'request timeout')
})

test('错误分类：auth / lease / network / crypto', () => {
  assert.equal(classifySyncError(new SyncHttpError('unauthorized', 401)).kind, 'auth')
  const lease = new SyncHttpError('lease held', 409, 'lease-held')
  assert.equal(classifySyncError(lease).kind, 'lease-held')
  assert.equal(classifySyncError(new Error('fetch failed')).kind, 'network')
  assert.equal(classifySyncError(new Error('封帧认证失败（密文、AAD 或密钥不匹配）')).kind, 'crypto')
  assert.equal(classifySyncError(new SyncHttpError('quota', 507)).retryable, true)
})

test('错误分类：M4 故障矩阵', () => {
  const cases = [
    [new SyncHttpError('forbidden', 403), 'forbidden', false],
    [new SyncHttpError('missing', 404), 'not-found', false],
    [new SyncHttpError('gone', 410), 'gone', false],
    [new SyncHttpError('rate', 429), 'rate-limited', true],
    [new SyncHttpError('quota', 507), 'quota', true],
    [new SyncHttpError('server', 503), 'server', true],
    [new SyncHttpError('lease', 409, 'lease-held'), 'lease-held', true],
    [new SyncHttpError('diverged', 409, 'diverged'), 'diverged', false],
    [new SyncHttpError('format', 409, 'format-mismatch'), 'format', false],
    [new Error('request timeout'), 'network', true],
    [new Error('未配置 serverUrl'), 'config', false],
  ]
  for (const [error, kind, retryable] of cases) {
    const classified = classifySyncError(error)
    assert.equal(classified.kind, kind, error.message)
    assert.equal(classified.retryable, retryable, error.message)
  }
})

test('拉取引擎：append 失败留下 pending，重启后按 pending 补完', async () => {
  const temp = createTempHome('plugin-pending')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'pending-test')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)

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
        batchEvents: 20,
      }
      assert.equal((await syncOnce({ persistence: storeA, sessions, config, isTailOpen: () => false })).sessions[0].status, 'pushed')

      const storeB = fakeStore(undefined, [], { failAppendOnce: true })
      let pending
      const deps = {
        persistence: storeB,
        sessions,
        config,
        workspacePathOf: () => 'D:/b',
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
      await holdLease(base, device)

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
        workspacePathOf: () => 'D:/b',
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
      await holdLease(base, device)

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
        workspacePathOf: () => 'D:/device-b',
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
        workspacePathOf: () => 'D:/device-b',
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
