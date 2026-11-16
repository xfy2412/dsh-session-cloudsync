import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectionNeedsWarm, warmSessionProjection } from '../src/projection-warm.ts'

/**
 * 造一个可观测的假投影缓存：`coldSnapshot` 按日志末尾推进水位，
 * `seq` 为 undefined 表示宿主还没有该会话的记录。
 * @param seq - 初始水位。
 * @param options - `loseWrite` 模拟写回失败。
 */
function fakeCache(seq, options = {}) {
  const calls = []
  let watermark = seq
  return {
    calls,
    get watermark() { return watermark },
    coldSnapshot(meta, inheritedEventCount, events) {
      calls.push({ meta, inheritedEventCount, events })
      if (options.loseWrite !== true) watermark = events.length === 0 ? -1 : events.at(-1).seq
    },
    cachedSnapshot() {
      return watermark === undefined ? undefined : { asOfSeq: watermark, values: {} }
    },
  }
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

/** 造一次预热的输入。 */
function inputOf(sessionEvents) {
  return {
    sessionId: 'warm-session',
    header: { id: 'warm-session', createdAt: 1, version: 4, isSeeded: false, cwd: 'D:/w', delegationDepth: 0 },
    inheritedEventCount: 0,
    events: sessionEvents,
    lastSeq: sessionEvents.length === 0 ? -1 : sessionEvents.at(-1).seq,
  }
}

test('缓存落后时用完整日志重算，并等到水位追上日志末端', async () => {
  const cache = fakeCache(2)
  const input = inputOf(events(0, 5))
  const result = await warmSessionProjection(cache, input)
  assert.equal(result, true)
  assert.equal(cache.calls.length, 1)
  assert.equal(cache.calls[0].meta, input.header)
  assert.equal(cache.calls[0].inheritedEventCount, 0)
  assert.deepEqual(cache.calls[0].events, input.events)
  assert.equal(cache.watermark, 5)
})

test('seeded 会话把继承前缀长度原样传给缓存', async () => {
  const cache = fakeCache(undefined)
  const input = { ...inputOf(events(0, 3)), inheritedEventCount: 2 }
  await warmSessionProjection(cache, input)
  assert.equal(cache.calls[0].inheritedEventCount, 2)
})

test('缓存已经到日志末端时零调用返回', async () => {
  const cache = fakeCache(5)
  const result = await warmSessionProjection(cache, inputOf(events(0, 5)))
  assert.equal(result, false)
  assert.equal(cache.calls.length, 0)
})

test('宿主没有投影缓存服务时整体跳过', async () => {
  const result = await warmSessionProjection(undefined, inputOf(events(0, 5)))
  assert.equal(result, false)
})

test('空日志也会建立水位为 -1 的缓存记录', async () => {
  const cache = fakeCache(undefined)
  const result = await warmSessionProjection(cache, inputOf([]))
  assert.equal(result, true)
  assert.equal(cache.calls.length, 1)
  assert.equal(cache.watermark, -1)
})

test('写回追不上时超时告警，但不抛异常也不阻塞拉取结果', async () => {
  const cache = fakeCache(undefined, { loseWrite: true })
  const warnings = []
  const started = Date.now()
  const result = await warmSessionProjection(cache, inputOf(events(0, 5)), {
    timeoutMs: 40,
    pollIntervalMs: 5,
    logger: { warn: (message) => { warnings.push(message) } },
  })
  assert.equal(result, true)
  assert.ok(Date.now() - started >= 30)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /没有追上 seq 5/u)
})

test('重算抛错只告警，返回 false', async () => {
  const cache = {
    coldSnapshot() { throw new Error('projection restore failed') },
    cachedSnapshot() { return undefined },
  }
  const warnings = []
  const result = await warmSessionProjection(cache, inputOf(events(0, 5)), {
    logger: { warn: (message) => { warnings.push(message) } },
  })
  assert.equal(result, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /重算失败：projection restore failed/u)
})

test('判断补热：无记录、水位落后为 true；已追平、无缓存服务为 false', () => {
  assert.equal(projectionNeedsWarm(fakeCache(undefined), {}, 5), true)
  assert.equal(projectionNeedsWarm(fakeCache(2), {}, 5), true)
  assert.equal(projectionNeedsWarm(fakeCache(5), {}, 5), false)
  assert.equal(projectionNeedsWarm(fakeCache(6), {}, 5), false)
  assert.equal(projectionNeedsWarm(undefined, {}, 5), false)
  const noRead = { coldSnapshot() {} }
  assert.equal(projectionNeedsWarm(noRead, {}, 5), false)
  const broken = { coldSnapshot() {}, cachedSnapshot() { throw new Error('cache read failed') } }
  assert.equal(projectionNeedsWarm(broken, {}, 5), true)
})
