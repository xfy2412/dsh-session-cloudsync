import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractSummary,
  foldNoteThreads,
  renderNotesContext,
  sanitizeNoteRecord,
  visibleNoteThreads,
} from '../src/notes.ts'
import { hasCompactionAfter, lastNotesMarker, noteContextMessage, shouldInjectNotes } from '../src/note-notice.ts'
import { lastDeviceChangeDeviceId } from '../src/device-notice.ts'

let sequence = 0

function note(overrides = {}) {
  sequence += 1
  return sanitizeNoteRecord({
    id: `note-${sequence}`,
    at: 1000 + sequence,
    scope: 'workspace',
    scopeKey: 'ws-1',
    storage: 'vault',
    deviceId: 'dev-1',
    authorKind: 'user',
    title: `标题 ${sequence}`,
    summary: `摘要 ${sequence}`,
    text: `正文 ${sequence}`,
    tags: [],
    pinned: false,
    threadId: `note-${sequence}`,
    ...overrides,
  })
}

function entry(value, order = value.at) {
  return { note: value, order }
}

test('笔记校验：两个维度独立，global 的 scopeKey 必须为空', () => {
  assert.equal(sanitizeNoteRecord({
    id: 'note-a', at: 1, scope: 'global', scopeKey: '', storage: 'device',
    deviceId: 'dev', authorKind: 'agent', text: 'x', threadId: 'note-a',
  }).scope, 'global')
  assert.equal(sanitizeNoteRecord({
    id: 'note-b', at: 1, scope: 'global', scopeKey: 'bad', storage: 'vault',
    deviceId: 'dev', authorKind: 'user', text: 'x', threadId: 'note-b',
  }), undefined)
  assert.equal(sanitizeNoteRecord({
    id: 'note-c', at: 1, scope: 'session', scopeKey: '', storage: 'vault',
    deviceId: 'dev', authorKind: 'user', text: 'x', threadId: 'note-c',
  }), undefined)
  assert.equal(sanitizeNoteRecord({
    id: 'note-d', at: 1, scope: 'workspace', scopeKey: 'ws', storage: 'device',
    deviceId: 'dev', authorKind: 'agent', text: '', threadId: 'note-d',
  }), undefined)
})

test('摘要：去代码块/Markdown，长文截断且稳定', () => {
  const summary = extractSummary('## 构建\n\n```bash\npnpm build\n```\n\n用 pnpm 构建。测试先跑 `node --test`。')
  assert.match(summary, /用 pnpm 构建/u)
  assert.doesNotMatch(summary, /pnpm build/u)
  assert.ok(summary.length <= 200)
  assert.equal(extractSummary('```only code```'), '')
})

test('thread 折叠：追加版本取最新，墓碑隐藏整个 thread', () => {
  const first = note({ threadId: 'thread-a' })
  const second = note({ threadId: 'thread-a', at: first.at + 5 })
  const threads = foldNoteThreads([entry(first, 1), entry(second, 2)])
  assert.equal(threads.length, 1)
  assert.equal(threads[0].latest.id, second.id)
  assert.equal(threads[0].notes.length, 2)

  const deleted = note({ threadId: 'thread-a', at: second.at + 5, deleted: true, text: '' })
  assert.equal(foldNoteThreads([entry(first, 1), entry(second, 2), entry(deleted, 3)]).length, 0)
})

test('可见 thread：session + workspace + global，其他工作区不出现', () => {
  const session = note({ scope: 'session', scopeKey: 's-1' })
  const workspace = note({ scope: 'workspace', scopeKey: 'ws-1' })
  const other = note({ scope: 'workspace', scopeKey: 'ws-2' })
  const global = note({ scope: 'global', scopeKey: '' })
  const threads = visibleNoteThreads([
    entry(session), entry(workspace), entry(other), entry(global),
  ], 's-1', 'ws-1')
  assert.deepEqual(threads.map((thread) => thread.latest.id), [global.id, workspace.id, session.id])
})

test('注入渲染：pinned 优先、每 thread 一条、hash 随内容变化', () => {
  const normal = note({ scope: 'workspace', scopeKey: 'ws-1', pinned: false })
  const pinned = note({ scope: 'session', scopeKey: 's-1', pinned: true })
  const threads = visibleNoteThreads([entry(normal), entry(pinned)], 's-1', 'ws-1')
  const rendered = renderNotesContext(threads)
  assert.equal(rendered.count, 2)
  assert.match(rendered.text, /^<notes-context version="2">/u)
  assert.match(rendered.text, /\[scope=session storage=vault\]/u)
  assert.ok(rendered.text.indexOf(pinned.id) < rendered.text.indexOf(normal.id))
  const changed = renderNotesContext(visibleNoteThreads([
    entry(normal), entry(note({ scope: 'session', scopeKey: 's-1', pinned: true, summary: '新摘要' })),
  ], 's-1', 'ws-1'))
  assert.notEqual(changed.hash, rendered.hash)
})

test('注入去重：同 hash 跳过，hash 变化/压缩后重注', () => {
  const userEvent = { type: 'user/message', data: { source: { kind: 'user' } } }
  const marker = { type: 'user/message', data: { source: { kind: 'session-cloudsync', hash: 'a'.repeat(64) } } }
  assert.equal(shouldInjectNotes([userEvent], 'a'.repeat(64), true), true)
  assert.equal(shouldInjectNotes([userEvent, marker], 'a'.repeat(64), true), false)
  assert.equal(shouldInjectNotes([userEvent, marker], 'b'.repeat(64), true), true)
  assert.equal(lastNotesMarker([userEvent, marker])?.index, 1)
  assert.equal(hasCompactionAfter([userEvent, marker, { type: 'compaction/end', data: {} }], 1), true)
  assert.equal(shouldInjectNotes([userEvent, marker, { type: 'compaction/end', data: {} }], 'a'.repeat(64), true), true)
})

test('笔记注入消息带 hash，不干扰设备切换提示', () => {
  const context = renderNotesContext([])
  const message = noteContextMessage(context, 'fixed')
  assert.equal(message.source.hash, context.hash)
  assert.equal(message.content[0].text, '<notes-context version="2">\n当前没有可用笔记。\n</notes-context>')
  const events = [
    { type: 'user/message', data: { source: { kind: 'session-cloudsync', deviceId: 'dev-1' } } },
    { type: 'user/message', data: { source: { kind: 'session-cloudsync', hash: 'a'.repeat(64) } } },
  ]
  assert.equal(lastDeviceChangeDeviceId(events), 'dev-1')
})
