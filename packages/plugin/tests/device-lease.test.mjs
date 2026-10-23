import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeviceLeaseKeeper } from '../src/device-lease.ts'

/** 造一个 JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 造一个可切换行为的假服务端。 */
function fakeServer(now) {
  const calls = []
  let mode = 'ok'
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, clientId: init.headers ? init.headers['x-client-id'] : undefined })
    if (mode === 'network') throw new Error('network down')
    if (mode === 'foreign') {
      return jsonResponse({ ok: false, error: { code: 'lease-held', message: 'held by other' } }, 409)
    }
    if (init.method === 'DELETE') return jsonResponse({ ok: true, value: { released: true } })
    return jsonResponse({
      ok: true,
      value: {
        resource: 'sync',
        deviceId: 'device-a',
        clientId: 'client-a',
        leaseUntil: now.value + 60_000,
        acquired: true,
      },
    })
  }
  return { calls, fetchImpl, setMode: (value) => { mode = value } }
}

/** 造一个可控 keeper。 */
function makeKeeper(options = {}) {
  const now = { value: 1_000_000 }
  const server = fakeServer(now)
  const keeper = new DeviceLeaseKeeper({
    configuration: options.configuration ?? (() => ({
      serverUrl: 'http://127.0.0.1:8787/',
      token: 'token',
      clientId: 'client-a',
      requestTimeoutMs: 1_000,
    })),
    fetch: options.fetch ?? server.fetchImpl,
    now: () => now.value,
    renewIntervalMs: 20_000,
    renewBeforeMs: 30_000,
    onChange: options.onChange,
  })
  return { keeper, now, server }
}

test('全局租约：首次申请、提前续租、dispose 释放', async () => {
  const { keeper, now, server } = makeKeeper()
  await keeper.tick()
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 1)
  assert.deepEqual(keeper.snapshot(), {
    state: 'held', leaseUntil: 1_060_000, lastRenewAt: 1_000_000, ownerDeviceId: 'device-a',
  })

  now.value += 10_000
  await keeper.tick()
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 1, '剩余 50s 不应续租')

  now.value += 35_000
  await keeper.tick()
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 2, '剩余 15s 应续租')

  await keeper.dispose()
  assert.equal(server.calls.filter((call) => call.method === 'DELETE').length, 1)
})

test('全局租约：其他设备持有时标记 foreign，ensure 返回 false', async () => {
  const { keeper, server } = makeKeeper()
  server.setMode('foreign')
  assert.equal(await keeper.ensure(), false)
  assert.equal(keeper.snapshot().state, 'foreign')
  assert.match(keeper.snapshot().error ?? '', /held by other/)
  await keeper.dispose()
})

test('全局租约：网络错误标记 lost，恢复后重新 held', async () => {
  const { keeper, now, server } = makeKeeper()
  await keeper.tick()
  server.setMode('network')
  now.value += 40_000
  await keeper.tick()
  assert.equal(keeper.snapshot().state, 'lost')
  assert.equal(await keeper.ensure(), false)

  server.setMode('ok')
  assert.equal(await keeper.ensure(), true)
  assert.equal(keeper.snapshot().state, 'held')
  await keeper.dispose()
})

test('全局租约：未配置时不发请求，状态为 unconfigured', async () => {
  const { keeper, server } = makeKeeper({ configuration: () => undefined })
  assert.equal(await keeper.tick(), false)
  assert.equal(keeper.snapshot().state, 'unconfigured')
  assert.equal(server.calls.length, 0)
})

test('全局租约：视图变化才通知 onChange', async () => {
  let changes = 0
  const { keeper } = makeKeeper({ onChange: () => { changes += 1 } })
  await keeper.tick()
  assert.ok(changes > 0)
  const afterHold = changes
  await keeper.tick()
  assert.equal(changes, afterHold, '没有变化时不应重复通知')
  await keeper.dispose()
})
