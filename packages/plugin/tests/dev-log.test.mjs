import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevLogSink, withDevLog } from '../src/dev-log.ts'

/**
 * 造一个不自动调度的 sink 和记录 fetch。
 * @param {Partial<ConstructorParameters<typeof DevLogSink>[0]>} overrides - 覆盖项。
 */
function fixture(overrides = {}) {
  let enabled = true
  let url = 'http://127.0.0.1:3092/api/log/a'
  const calls = []
  const sink = new DevLogSink({
    enabled: () => enabled,
    url: () => url,
    source: 'test-plugin',
    now: () => 1234,
    schedule: () => {},
    fetchImpl: async (target, init) => {
      calls.push({ target, body: JSON.parse(init.body) })
      return new Response('', { status: 204 })
    },
    ...overrides,
  })
  return {
    sink,
    calls,
    setEnabled: (value) => { enabled = value },
    setUrl: (value) => { url = value },
  }
}

test('dev-log：禁用或空地址时不发送', async () => {
  const { sink, calls, setEnabled, setUrl } = fixture()
  setEnabled(false)
  sink.write('info', 'hidden')
  await sink.flush()
  assert.equal(calls.length, 0)

  setEnabled(true)
  setUrl('')
  sink.write('info', 'no-url')
  await sink.flush()
  assert.equal(calls.length, 0)
})

test('dev-log：按批发送级别、来源与时间', async () => {
  const { sink, calls } = fixture()
  sink.write('info', 'hello')
  sink.write('warn', 'careful')
  await sink.flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, 'http://127.0.0.1:3092/api/log/a')
  assert.deepEqual(calls[0].body.entries, [
    { level: 'info', message: 'hello', source: 'test-plugin', time: 1234 },
    { level: 'warn', message: 'careful', source: 'test-plugin', time: 1234 },
  ])
})

test('dev-log：队列有界并截断超长消息', async () => {
  const { sink, calls } = fixture({ maxQueue: 2, maxMessageChars: 128 })
  sink.write('info', 'a'.repeat(200))
  sink.write('info', 'b')
  sink.write('info', 'c')
  await sink.flush()
  assert.equal(calls.length, 1)
  const entries = calls[0].body.entries
  assert.equal(entries.length, 2)
  assert.equal(entries[0].message, 'b')
  assert.equal(entries[1].message, 'c')
})

test('dev-log：withDevLog 同时转发原 logger 与 sink', async () => {
  const messages = []
  const { sink, calls } = fixture()
  const logger = withDevLog({
    info: (message) => messages.push(['info', message]),
    warn: (message) => messages.push(['warn', message]),
    error: (message) => messages.push(['error', message]),
  }, sink)
  logger.info('one')
  logger.error('two')
  await sink.flush()
  assert.deepEqual(messages, [['info', 'one'], ['error', 'two']])
  assert.equal(calls[0].body.entries.length, 2)
})
