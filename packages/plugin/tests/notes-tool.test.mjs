import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerNotesTools } from '../src/notes-tool.ts'

function fakeTools() {
  const definitions = []
  return {
    definitions,
    register(definition) {
      definitions.push(definition)
      return () => {}
    },
    get() { return undefined },
  }
}

function note(id, text, at) {
  return {
    id, at, scope: 'session', scopeKey: 's-1', storage: 'vault', deviceId: 'dev',
    authorKind: 'agent', title: 'T' + id, summary: 'S' + id, text, tags: [], pinned: false,
    threadId: 'thread-1',
  }
}

function thread() {
  const latest = note('note-2', 'latest body', 2)
  return {
    threadId: 'thread-1', scope: 'session', scopeKey: 's-1', storage: 'vault',
    latest,
    notes: [note('note-1', 'old body', 1), latest],
  }
}

test('笔记工具：search 只回摘要，read 默认只回最新版本', async () => {
  const tools = fakeTools()
  const registered = registerNotesTools(tools, {
    write: async () => note('note-3', 'new', 3),
    search: async () => [thread()],
    read: async () => thread(),
  })
  assert.equal(registered.names.search, 'note_search')
  const search = tools.definitions.find((item) => item.name === 'note_search')
  const read = tools.definitions.find((item) => item.name === 'note_read')
  const write = tools.definitions.find((item) => item.name === 'note_write')

  const results = await search.execute({ query: 'latest' }, { agent: { session: { header: { id: 's-1' } } } })
  assert.equal(results[0].latest.text, undefined)
  assert.equal(results[0].latest.summary, 'Snote-2')
  assert.equal(results[0].versions, 2)

  const latest = await read.execute(
    { id: 'note-2' },
    { agent: { session: { header: { id: 's-1' } } } },
  )
  assert.equal(latest.notes.length, 1)
  assert.equal(latest.versions, 2)

  const history = await read.execute(
    { id: 'note-2', history: true },
    { agent: { session: { header: { id: 's-1' } } } },
  )
  assert.equal(history.notes.length, 2)
  assert.match(write.description, /Do not write temporary task state/u)
  assert.match(write.parameters.properties.storage.description, /device = this machine only/u)
})

test('笔记工具：缺 id 与空 text 报错', async () => {
  const tools = fakeTools()
  registerNotesTools(tools, {
    write: async () => note('note-3', 'new', 3),
    search: async () => [],
    read: async () => thread(),
  })
  const read = tools.definitions.find((item) => item.name === 'note_read')
  const write = tools.definitions.find((item) => item.name === 'note_write')
  await assert.rejects(() => read.execute({}, { agent: { session: { header: { id: 's-1' } } } }), /id/u)
  await assert.rejects(() => write.execute({ text: ' ' }, { agent: { session: { header: { id: 's-1' } } } }), /text/u)
})
