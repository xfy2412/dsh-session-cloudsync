import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncScheduler } from '../src/scheduler.ts'

/** 造一个可控调度器。 */
function fixture(overrides = {}) {
  const runs = []
  let auto = overrides.autoSync ?? true
  let interval = overrides.intervalMs ?? 20
  let nextRetryAt = null
  const scheduler = new SyncScheduler({
    run: async (trigger) => {
      runs.push(trigger)
      return { ok: true, status: { nextRetryAt } }
    },
    intervalMs: () => interval,
    autoSync: () => auto,
    minDelayMs: 1,
    ...overrides.options,
  })
  return {
    scheduler,
    runs,
    setAuto: (value) => { auto = value },
    setInterval: (value) => { interval = value },
    setRetry: (value) => { nextRetryAt = value },
  }
}

test('调度器：start 后按间隔自动跑，stop 停止', async () => {
  const { scheduler, runs } = fixture({ intervalMs: 10 })
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 45))
  scheduler.stop()
  assert.ok(runs.length >= 1)
  assert.deepEqual(runs.slice(0, 1), ['auto'])
})

test('调度器：autoSync=false 不跑自动轮，manual 仍可跑', async () => {
  const { scheduler, runs } = fixture({ autoSync: false, intervalMs: 10 })
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(runs.length, 0)
  const result = await scheduler.manual()
  assert.equal(result.ok, true)
  assert.deepEqual(runs, ['manual'])
  scheduler.stop()
})

test('调度器：manual 排下一次；退避时间会推迟 nextRunAt', async () => {
  const { scheduler, runs, setRetry, setInterval } = fixture({ intervalMs: 20 })
  scheduler.start()
  const result = await scheduler.manual()
  assert.equal(result.ok, true)
  assert.deepEqual(runs, ['manual'])
  const first = scheduler.snapshot()
  assert.equal(first.nextRunAt !== null, true)
  assert.equal(first.autoSync, true)

  setInterval(1000)
  setRetry(Date.now() + 60000)
  const second = await scheduler.manual()
  assert.equal(second.ok, true)
  const after = scheduler.snapshot()
  assert.ok(after.nextRunAt >= after.backoffUntil)
  scheduler.stop()
})
