import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotesStore } from '../src/notes-store.ts'

function note(id, storage = 'device') {
  return {
    id, at: Date.now(), scope: 'session', scopeKey: 's-1', storage, deviceId: 'dev-1',
    authorKind: 'user', title: id, summary: '', text: 'x', tags: [], pinned: false, threadId: id,
  }
}

test('NotesStore：device 与 outbox 分开，append/remove 幂等', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dscs-notes-'))
  try {
    const store = new NotesStore(dir)
    await store.appendDevice(note('note-device-1'))
    await store.appendDevice(note('note-device-1'))
    assert.deepEqual((await store.deviceEntries()).map((entry) => entry.note.id), ['note-device-1'])

    await store.enqueue(note('note-vault-1', 'vault'))
    await store.enqueue(note('note-vault-1', 'vault'))
    assert.deepEqual((await store.pending()).map((item) => item.id), ['note-vault-1'])
    await store.removePending(['note-vault-1'])
    assert.deepEqual(await store.pending(), [])
    assert.deepEqual((await store.deviceEntries()).map((entry) => entry.note.id), ['note-device-1'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
