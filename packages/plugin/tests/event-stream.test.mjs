import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEventStreamResponse } from '../src/event-stream.ts'

/** 造一个最小 v2 状态。 */
function makeStatus(version, running = false) {
  return {
    schemaVersion: 2,
    statusVersion: version,
    configured: true,
    reason: null,
    running,
    run: { id: 1, trigger: 'auto', state: running ? 'running' : 'finished', startedAt: 1, finishedAt: running ? null : 2 },
    scheduler: { autoSync: true, intervalMs: 60_000, nextRunAt: null, backoffUntil: null },
    lastAttempt: 1,
    lastSuccess: running ? null : 2,
    lastError: null,
    retryCount: 0,
    nextRetryAt: null,
    pending: null,
    revision: 0,
    sessions: [],
  }
}

const decoder = new TextDecoder()

/** 读到包含 marker 的文本块。 */
async function readUntil(reader, marker) {
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return { text, done: true }
    text += decoder.decode(value, { stream: true })
    if (text.includes(marker)) return { text, done: false }
  }
}

function fixture(initial, options = {}) {
  let current = initial
  const listeners = new Set()
  const response = createEventStreamResponse(
    new Request('http://host/api/session-cloudsync/events?until=idle'),
    {
      status: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      heartbeatMs: 10_000,
      coalesceMs: 5,
      idleGraceMs: 1000,
      maxLifetimeMs: 30_000,
      ...options,
    },
  )
  return {
    response,
    listeners,
    setStatus: (value) => { current = value },
    notify: () => { for (const listener of [...listeners]) listener() },
  }
}

test('SSE：连接先发全量状态，变化后合并发送', async () => {
  const f = fixture(makeStatus(1))
  const reader = f.response.body.getReader()
  const first = await readUntil(reader, '\n\n')
  assert.match(first.text, /event: status/)
  assert.match(first.text, /"statusVersion":1/)

  f.setStatus(makeStatus(2))
  f.notify()
  const second = await readUntil(reader, '\n\n')
  assert.match(second.text, /"statusVersion":2/)
  await reader.cancel()
})

test('SSE：until=idle 在非运行状态后关闭，运行中保持打开', async () => {
  const f = fixture(makeStatus(1), { idleGraceMs: 20 })
  const reader = f.response.body.getReader()
  await readUntil(reader, '\n\n')
  const closed = await reader.read()
  assert.equal(closed.done, true)

  const running = fixture(makeStatus(1, true), { idleGraceMs: 5 })
  const runningReader = running.response.body.getReader()
  await readUntil(runningReader, '\n\n')
  await new Promise((resolve) => setTimeout(resolve, 30))
  running.setStatus(makeStatus(2, false))
  running.notify()
  const next = await readUntil(runningReader, '\n\n')
  assert.match(next.text, /"statusVersion":2/)
  const done = await runningReader.read()
  assert.equal(done.done, true)
})

test('SSE：不带 until=idle 时空闲连接保持打开', async () => {
  let current = makeStatus(1)
  const listeners = new Set()
  const response = createEventStreamResponse(
    new Request('http://host/api/session-cloudsync/events'),
    {
      status: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      heartbeatMs: 10_000,
      coalesceMs: 5,
      idleGraceMs: 5,
      maxLifetimeMs: 30_000,
    },
  )
  const reader = response.body.getReader()
  const first = await readUntil(reader, '\n\n')
  assert.match(first.text, /"statusVersion":1/)
  await new Promise((resolve) => setTimeout(resolve, 30))
  current = makeStatus(2)
  for (const listener of [...listeners]) listener()
  const second = await readUntil(reader, '\n\n')
  assert.match(second.text, /"statusVersion":2/)
  await reader.cancel()
})

test('SSE：客户端 abort 会取消订阅', async () => {
  const abort = new AbortController()
  const listeners = new Set()
  const response = createEventStreamResponse(
    new Request('http://host/api/session-cloudsync/events', { signal: abort.signal }),
    {
      status: () => makeStatus(1),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      coalesceMs: 5,
      idleGraceMs: 1000,
      heartbeatMs: 10_000,
    },
  )
  const reader = response.body.getReader()
  await readUntil(reader, '\n\n')
  assert.equal(listeners.size, 1)
  abort.abort()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(listeners.size, 0)
  await reader.cancel().catch(() => {})
})
