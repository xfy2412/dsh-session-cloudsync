import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncController } from '../src/controller.ts'

/** 造一个推送结果。 */
function pushReport(sessions) {
  return { configured: true, sessions }
}

/** 造一个拉取结果。 */
function pullReport(sessions, revision) {
  return { configured: true, sessions, revision }
}

/** 造一个可控时钟与记录器的控制器。 */
function createController(overrides = {}) {
  let now = 1_000
  const persists = []
  const calls = { push: 0, pull: 0 }
  const push = overrides.push ?? (async () => pushReport([]))
  const pull = overrides.pull ?? (async () => pullReport([], 0))
  const controller = new SyncController({
    push: async () => {
      calls.push += 1
      return push()
    },
    pull: async (state) => {
      calls.pull += 1
      return pull(state)
    },
    persist: (state) => { persists.push(state) },
    configuration: overrides.configuration ?? (() => ({ configured: true })),
    intervalMs: overrides.intervalMs ?? 60_000,
    nonRetryable: overrides.nonRetryable,
    initial: overrides.initial,
    leases: overrides.leases,
    now: () => now,
  })
  return {
    controller,
    persists,
    calls,
    advance: (ms) => { now += ms },
    setNow: (value) => { now = value },
  }
}

test('控制器：实时阶段进入 live，轮次结束后收敛', async () => {
  let fixture
  fixture = createController({
    push: async () => {
      fixture.controller.updateProgress({ sessionId: 's1', direction: 'push', phase: 'start', progress: 0 })
      return pushReport([])
    },
  })

  const running = fixture.controller.run()
  const during = fixture.controller.snapshot().sessions
  assert.equal(during.length, 1)
  assert.equal(during[0].sessionId, 's1')
  assert.equal(during[0].phase, 'running')
  assert.equal(during[0].push.status, 'pushing')
  await running
  assert.deepEqual(fixture.controller.snapshot().sessions, [])
})

test('控制器：成功一轮更新状态、revision 与逐会话视图', async () => {
  const fixture = createController({
    push: async () => pushReport([
      { sessionId: 's1', status: 'pushed', batches: 2, bytes: 128, tailOpen: true },
      { sessionId: 's2', status: 'skipped', error: '子代理会话默认不同步' },
    ]),
    pull: async () => pullReport([
      { sessionId: 's3', status: 'pulled', applied: 4 },
      { sessionId: 's4', status: 'up-to-date' },
    ], 7),
  })

  const result = await fixture.controller.run()
  assert.equal(result.ok, true)
  assert.equal(result.status.running, false)
  assert.equal(result.status.configured, true)
  assert.equal(result.status.reason, null)
  assert.equal(result.status.lastAttempt, 1_000)
  assert.equal(result.status.lastSuccess, 1_000)
  assert.equal(result.status.lastError, null)
  assert.equal(result.status.retryCount, 0)
  assert.equal(result.status.nextRetryAt, null)
  assert.equal(result.status.revision, 7)
  assert.equal(result.status.pending, null)

  assert.equal(result.status.schemaVersion, 2)
  assert.equal(result.status.run.state, 'finished')
  assert.equal(result.status.run.trigger, 'auto')
  assert.equal(result.status.scheduler.intervalMs, 60_000)

  const sessions = result.status.sessions
  assert.deepEqual(sessions.map((session) => session.sessionId), ['s1', 's2', 's3', 's4'])
  const byId = Object.fromEntries(sessions.map((session) => [session.sessionId, session]))
  assert.equal(byId.s1.phase, 'done')
  assert.equal(byId.s1.push.status, 'pushed')
  assert.equal(byId.s1.tailOpen, true)
  assert.equal(byId.s2.phase, 'skipped')
  assert.equal(byId.s2.push.error, '子代理会话默认不同步')
  assert.equal(byId.s3.phase, 'done')
  assert.equal(byId.s3.pull.applied, 4)
  assert.equal(byId.s3.pull.totalEvents, 4)
  assert.equal(byId.s4.phase, 'done')
  assert.equal(byId.s4.pull.status, 'up-to-date')
  assert.deepEqual(fixture.persists.at(-1), { revision: 7 })
})

test('控制器：cwd 警告保留到用户处理，clear 后消失', async () => {
  let report = pullReport([{ sessionId: 's-cwd', status: 'pulled', cwdNonPortable: true }], 1)
  const fixture = createController({ pull: async () => report })
  await fixture.controller.run()
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-cwd').cwdPending, true)
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-cwd').pull.cwdNonPortable, true)
  assert.deepEqual(fixture.persists.at(-1), { revision: 1, cwdPending: ['s-cwd'] })

  // 下一轮没有这条会话时仍保留，避免提示在 revision 推进后丢失。
  report = pullReport([], 2)
  await fixture.controller.run()
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-cwd').cwdPending, true)

  fixture.controller.clearCwdPending('s-cwd')
  assert.equal(fixture.controller.snapshot().sessions.some((session) => session.sessionId === 's-cwd'), false)
  assert.deepEqual(fixture.persists.at(-1), { revision: 2 })
})

test('控制器：从状态文件恢复 cwd 待处理项', () => {
  const fixture = createController({ initial: { revision: 4, cwdPending: ['s-restored'] } })
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-restored').cwdPending, true)
})

test('控制器：分叉会话进入 blocked、持久化，并在后续成功同步后清除', async () => {
  let report = pullReport([
    { sessionId: 's-diverged', status: 'error', kind: 'diverged', error: '共享前缀批次 3 不一致（diverged）', createdAt: 10, formatVersion: 4 },
  ], 1)
  const fixture = createController({ pull: async () => report })
  const first = await fixture.controller.run()
  assert.equal(first.ok, false)
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-diverged').phase, 'blocked')
  assert.equal(fixture.controller.isBlocked('s-diverged', 10, 4), true)
  assert.deepEqual(fixture.persists.at(-1).blocked.map((entry) => entry.sessionId), ['s-diverged'])

  fixture.controller.resolveBlocked('s-diverged', 'force', 10, 4)
  assert.equal(fixture.controller.isBlocked('s-diverged', 10, 4), false)
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-diverged').blocked, undefined)
  assert.deepEqual(fixture.persists.at(-1).blockedDecisions, [
    { sessionId: 's-diverged', action: 'force', message: '共享前缀批次 3 不一致（diverged）', at: 1_000, createdAt: 10, formatVersion: 4 },
  ])

  // 同一分叉再次出现时，不把用户已经强行写入的会话重新锁上。
  const again = await fixture.controller.run({ manual: true })
  assert.equal(again.ok, false)
  assert.equal(fixture.controller.isBlocked('s-diverged', 10, 4), false)

  report = pullReport([{ sessionId: 's-diverged', status: 'up-to-date' }], 2)
  const second = await fixture.controller.run({ manual: true })
  assert.equal(second.ok, true)
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-diverged').blocked, undefined)
  assert.equal(fixture.controller.isBlocked('s-diverged', 10, 4), false)
  assert.equal(fixture.persists.at(-1).blockedDecisions, undefined)
})

test('控制器：blocked 决定按生命周期匹配，不误伤同 id 的新会话', async () => {
  let report = pullReport([{
    sessionId: 's-life',
    status: 'error',
    kind: 'diverged',
    error: 'diverged',
    createdAt: 10,
    formatVersion: 4,
  }], 1)
  const fixture = createController({ pull: async () => report })
  await fixture.controller.run()
  assert.equal(fixture.controller.isBlocked('s-life', 10, 4), true)
  assert.equal(fixture.controller.isBlocked('s-life', 11, 4), false)
  assert.deepEqual(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-life').blocked, {
    sessionId: 's-life',
    kind: 'diverged',
    message: 'diverged',
    at: 1_000,
    createdAt: 10,
    formatVersion: 4,
  })

  fixture.controller.resolveBlocked('s-life', 'force', 10, 4)
  assert.equal(fixture.controller.isBlocked('s-life', 10, 4), false)
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-life').blocked, undefined)
})

test('控制器：忽略后可以从状态恢复为阻塞', async () => {
  const fixture = createController({
    pull: async () => pullReport([{
      sessionId: 's-restore',
      status: 'error',
      kind: 'diverged',
      error: 'diverged',
      createdAt: 20,
      formatVersion: 4,
    }], 1),
  })
  await fixture.controller.run()
  fixture.controller.resolveBlocked('s-restore', 'ignore', 20, 4)
  assert.equal(fixture.controller.isBlocked('s-restore', 20, 4), false)
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-restore').decision.action, 'ignore')

  fixture.controller.restoreBlocked('s-restore', 20, 4)
  assert.equal(fixture.controller.isBlocked('s-restore', 20, 4), true)
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-restore').decision, undefined)
  assert.equal(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-restore').blocked.message, 'diverged')
})

test('控制器：从状态文件恢复 blocked 项', () => {
  const fixture = createController({
    initial: {
      revision: 4,
      blocked: [{ sessionId: 's-blocked', kind: 'diverged', message: 'old divergence', at: 10, createdAt: 10, formatVersion: 4 }],
    },
  })
  assert.equal(fixture.controller.isBlocked('s-blocked', 10, 4), true)
  assert.deepEqual(fixture.controller.snapshot().sessions.find((session) => session.sessionId === 's-blocked').blocked, {
    sessionId: 's-blocked', kind: 'diverged', message: 'old divergence', at: 10, createdAt: 10, formatVersion: 4,
  })
})

test('控制器：会话聚合：push+pull 一行，pull 追平后清除 remote-ahead', async () => {
  const fixture = createController({
    push: async () => pushReport([{
      sessionId: 's1', status: 'remote-ahead', pendingEvents: 5, totalEvents: 0,
    }]),
    pull: async () => pullReport([{
      sessionId: 's1', status: 'pulled', applied: 5, totalEvents: 5,
    }], 1),
  })
  const before = fixture.controller.snapshot()
  const result = await fixture.controller.run()
  const sessions = result.status.sessions
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].sessionId, 's1')
  assert.equal(sessions[0].remoteAhead, false)
  assert.equal(sessions[0].phase, 'done')
  assert.equal(sessions[0].push.status, 'remote-ahead')
  assert.equal(sessions[0].push.pendingEvents, 5)
  assert.equal(sessions[0].pull.applied, 5)
  assert.equal(sessions[0].pending.download, 0)
  assert.ok(result.status.statusVersion > before.statusVersion)
})

test('控制器：local-active 聚合为 deferred 并保留待下载事件数', async () => {
  const fixture = createController({
    push: async () => pushReport([{
      sessionId: 's1', status: 'remote-ahead', pendingEvents: 5, totalEvents: 0,
    }]),
    pull: async () => pullReport([{
      sessionId: 's1', status: 'local-active', totalEvents: 5, pendingEvents: 5,
    }], 0),
  })
  const result = await fixture.controller.run()
  const session = result.status.sessions[0]
  assert.equal(session.phase, 'deferred')
  assert.equal(session.live, true)
  assert.equal(session.remoteAhead, true)
  assert.equal(session.pending.download, 5)
})

test('控制器：subscribe 在状态变化时通知，可取消', async () => {
  const fixture = createController()
  let calls = 0
  const unsubscribe = fixture.controller.subscribe(() => { calls += 1 })
  await fixture.controller.run()
  assert.ok(calls > 0)
  const afterRun = calls
  unsubscribe()
  fixture.controller.notifyChanged()
  assert.equal(calls, afterRun)
})

test('控制器：推送错误进入退避，自动轮次跳过，手动轮次立即重试', async () => {
  let pushCalls = 0
  let fail = true
  const fixture = createController({
    push: async () => {
      pushCalls += 1
      return fail
        ? pushReport([{ sessionId: 's1', status: 'error', kind: 'server', error: '服务端 503' }])
        : pushReport([{ sessionId: 's1', status: 'pushed' }])
    },
    pull: async (state) => pullReport([], state.revision),
  })

  const first = await fixture.controller.run()
  assert.equal(first.ok, false)
  assert.equal(first.status.lastSuccess, null)
  assert.equal(first.status.retryCount, 1)
  assert.equal(first.status.lastError.kind, 'server')
  assert.equal(first.status.lastError.message, '服务端 503')
  assert.equal(first.status.nextRetryAt, 1_000 + 120_000)

  fixture.advance(30_000)
  const skipped = await fixture.controller.run()
  assert.equal(skipped.ok, false)
  assert.equal(skipped.code, 'backoff')
  assert.equal(pushCalls, 1)

  fail = false
  const manual = await fixture.controller.run({ manual: true })
  assert.equal(manual.ok, true)
  assert.equal(pushCalls, 2)
  assert.equal(manual.status.retryCount, 0)
  assert.equal(manual.status.nextRetryAt, null)
  assert.equal(manual.status.lastError, null)
  assert.equal(manual.status.lastSuccess, 31_000)
})

test('控制器：不可重试错误至少退避 5 分钟', async () => {
  const fixture = createController({
    push: async () => pushReport([{ sessionId: 's1', status: 'error', kind: 'auth', error: 'token 无效' }]),
  })
  const result = await fixture.controller.run()
  assert.equal(result.ok, false)
  assert.equal(result.status.lastError.kind, 'auth')
  assert.equal(result.status.nextRetryAt, 1_000 + 5 * 60_000)
})

test('控制器：拉取错误不推进 revision，已存在的 pending 会传给拉取', async () => {
  let received
  const fixture = createController({
    initial: { revision: 3, pending: { sessionId: 's9', targetSeq: 5, at: 99 } },
    pull: async (state) => {
      received = state
      return { configured: true, sessions: [{ sessionId: 's9', status: 'error', kind: 'network', error: '断网' }], revision: 9 }
    },
  })

  const result = await fixture.controller.run()
  assert.deepEqual(received, { revision: 3, pending: { sessionId: 's9', targetSeq: 5, at: 99 } })
  assert.equal(result.ok, false)
  assert.equal(result.status.revision, 3)
  assert.deepEqual(fixture.persists, [])
})

test('控制器：beginApply/endApply 立即落盘并反映在快照里', async () => {
  const fixture = createController()
  fixture.controller.beginApply('s1', 12)
  assert.deepEqual(fixture.controller.snapshot().pending, { sessionId: 's1', targetSeq: 12, at: 1_000 })
  assert.deepEqual(fixture.persists.at(-1), { revision: 0, pending: { sessionId: 's1', targetSeq: 12, at: 1_000 } })

  fixture.controller.endApply('s1')
  assert.equal(fixture.controller.snapshot().pending, null)
  assert.deepEqual(fixture.persists.at(-1), { revision: 0 })
})

test('控制器：不会用另一个会话的 pending 覆盖未完成的恢复记录', () => {
  const fixture = createController()
  fixture.controller.beginApply('s1', 12)
  assert.throws(() => fixture.controller.beginApply('s2', 3), /尚未完成/u)
  assert.deepEqual(fixture.controller.snapshot().pending, { sessionId: 's1', targetSeq: 12, at: 1_000 })

  fixture.controller.endApply('s2')
  assert.equal(fixture.controller.snapshot().pending.sessionId, 's1')

  fixture.controller.endApply('s1')
  assert.equal(fixture.controller.snapshot().pending, null)
})

test('控制器：未映射会话跨轮次持久化，回填成功后移除', async () => {
  const unmapped = {
    sessionId: 's1', status: 'unmapped', workspaceKey: 'workspace-key-0001', revision: 5,
    createdAt: 1, formatVersion: 4,
  }
  const fixture = createController({
    pull: async () => pullReport([unmapped], 9),
  })

  await fixture.controller.run()
  assert.deepEqual(fixture.controller.unmappedSessions(), [{
    sessionId: 's1', workspaceKey: 'workspace-key-0001', revision: 5, at: 1_000,
    createdAt: 1, formatVersion: 4,
  }])
  assert.deepEqual(fixture.persists.at(-1).unmapped, fixture.controller.unmappedSessions())

  // 下一轮游标已到 9、没有新变更：未映射记录不能丢。
  await fixture.controller.run()
  assert.equal(fixture.controller.unmappedSessions().length, 1)

  // 模拟新进程从 journal 恢复。
  const restored = createController({ initial: { revision: 9, unmapped: fixture.controller.unmappedSessions() } })
  assert.equal(restored.controller.unmappedSessions().length, 1)

  fixture.controller.recordBackfill(pullReport([{ sessionId: 's1', status: 'pulled', applied: 3 }], 9))
  assert.deepEqual(fixture.controller.unmappedSessions(), [])
  assert.equal(fixture.persists.at(-1).unmapped, undefined)
})

test('控制器：并发触发返回 already-running，上一轮结束后才允许下一轮', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let started
  const entered = new Promise((resolve) => { started = resolve })
  const fixture = createController({
    push: async () => {
      started()
      await gate
      return pushReport([])
    },
  })

  const first = fixture.controller.run()
  await entered
  const second = await fixture.controller.run({ manual: true })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'already-running')
  assert.equal(second.status.running, true)

  release()
  assert.equal((await first).ok, true)
  assert.equal(fixture.controller.snapshot().running, false)
})

test('控制器：未配置时不调用引擎，快照带原因', async () => {
  const fixture = createController({
    configuration: () => ({ configured: false, reason: 'passphrase 未配置' }),
  })
  const result = await fixture.controller.run({ manual: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unconfigured')
  assert.equal(result.message, 'passphrase 未配置')
  assert.equal(result.status.configured, false)
  assert.equal(result.status.reason, 'passphrase 未配置')
  assert.equal(result.status.lastAttempt, null)
  assert.deepEqual(fixture.calls, { push: 0, pull: 0 })
})

test('控制器：快照把 live 会话的设备独占租约并入会话视图', () => {
  const fixture = createController({
    leases: () => [{ sessionId: 's1', state: 'foreign', error: 'held by other' }],
  })
  const session = fixture.controller.snapshot().sessions.find((entry) => entry.sessionId === 's1')
  assert.equal(session.live, true)
  assert.deepEqual(session.lease, { sessionId: 's1', state: 'foreign', error: 'held by other' })
})
