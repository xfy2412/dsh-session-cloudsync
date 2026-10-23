import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LeaseKeeper } from '../src/lease-keeper.ts'

/** 造一个 JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 造一个可观察的假 fetch。 */
function fakeServer({ now, mode = 'ok' }) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      clientId: init.headers ? init.headers['x-client-id'] : undefined,
    })
    if (mode === 'network') throw new Error('network down')
    if (mode === 'foreign') {
      return jsonResponse({ ok: false, error: { code: 'lease-held', message: 'held by other' } }, 409)
    }
    if (init.method === 'DELETE') return jsonResponse({ ok: true, value: { released: true } })
    return jsonResponse({
      ok: true,
      value: {
        resource: 'session:s1',
        deviceId: 'device-a',
        clientId: 'client-a',
        leaseUntil: now.value + 60_000,
        acquired: true,
      },
    })
  }
  return { calls, fetchImpl }
}

/** 造一个可控的 keeper。 */
function makeKeeper(options = {}) {
  const now = { value: 1_000_000 }
  const live = { value: ['s1'] }
  const server = fakeServer({ now, mode: options.mode ?? 'ok' })
  const keeper = new LeaseKeeper({
    listLiveSessionIds: () => live.value,
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
  })
  return { keeper, now, live, server }
}

test('租约：首次申请、提前续租、会话变 cold 后释放', async () => {
  const { keeper, now, live, server } = makeKeeper()
  await keeper.tick()
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 1)
  assert.deepEqual(keeper.snapshot(), [{
    sessionId: 's1',
    state: 'held',
    leaseUntil: 1_060_000,
    lastRenewAt: 1_000_000,
    ownerDeviceId: 'device-a',
  }])

  now.value += 10_000
  await keeper.tick()
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 1, '剩余 50s 不应续租')

  now.value += 35_000
  await keeper.tick()
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 2, '剩余 15s 应续租')
  assert.equal(keeper.snapshot()[0].state, 'held')

  live.value = []
  await keeper.tick()
  assert.equal(server.calls.filter((call) => call.method === 'DELETE').length, 1)
  assert.deepEqual(keeper.snapshot(), [])
})

test('租约：其他设备持有时标记 foreign，不删除本地 held 记录', async () => {
  const { keeper } = makeKeeper({ mode: 'foreign' })
  await keeper.tick()
  assert.deepEqual(keeper.snapshot(), [{
    sessionId: 's1',
    state: 'foreign',
    error: 'held by other',
  }])
  assert.equal(keeper.snapshot().some((lease) => lease.state === 'held'), false)
})

test('租约：网络错误标 lost；恢复后重新 held', async () => {
  const now = { value: 1_000_000 }
  const live = { value: ['s1'] }
  const mode = { value: 'network' }
  const fetchImpl = async (url, init = {}) => {
    if (mode.value === 'network') throw new Error('network down')
    if (init.method === 'DELETE') return jsonResponse({ ok: true, value: { released: true } })
    return jsonResponse({
      ok: true,
      value: { deviceId: 'device-a', leaseUntil: now.value + 60_000 },
    })
  }
  const keeper = new LeaseKeeper({
    listLiveSessionIds: () => live.value,
    configuration: () => ({ serverUrl: 'http://server', token: 'token', clientId: 'client-a' }),
    fetch: fetchImpl,
    now: () => now.value,
  })
  await keeper.tick()
  assert.equal(keeper.snapshot()[0].state, 'lost')
  assert.equal(keeper.snapshot()[0].error, 'network down')

  mode.value = 'ok'
  await keeper.tick()
  assert.equal(keeper.snapshot()[0].state, 'held')
})

test('租约：push 释放不误删 presence lease', async () => {
  const { keeper, server } = makeKeeper()
  await keeper.tick()
  await keeper.releaseAfterWrite('s1')
  assert.equal(server.calls.filter((call) => call.method === 'DELETE').length, 0)
  assert.equal(keeper.snapshot()[0].state, 'held')
})

test('租约：没有 presence lease 时 push 释放会 DELETE', async () => {
  const { keeper, server } = makeKeeper()
  await keeper.releaseAfterWrite('s1')
  assert.equal(server.calls.filter((call) => call.method === 'DELETE').length, 1)
})

test('租约：dispose 释放全部；未配置时不发请求；dispose 后不再请求', async () => {
  const unconfigured = makeKeeper({ configuration: () => undefined })
  await unconfigured.keeper.tick()
  assert.equal(unconfigured.server.calls.length, 0)

  const { keeper, server } = makeKeeper()
  await keeper.tick()
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 1)
  await keeper.dispose()
  assert.equal(server.calls.filter((call) => call.method === 'DELETE').length, 1)
  assert.deepEqual(keeper.snapshot(), [])
  await keeper.tick()
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 1, 'dispose 后不应再申请')
})
