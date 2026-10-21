import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readPullJournal, writePullJournal, STATE_VERSION } from '../src/state.ts'

test('状态文件：缺失/损坏返回空状态，写入可读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-state-'))
  const file = join(dir, 'state.json')
  assert.deepEqual(readPullJournal(file), { version: STATE_VERSION, revision: 0 })

  writePullJournal(file, { version: STATE_VERSION, revision: 42 })
  assert.deepEqual(readPullJournal(file), { version: STATE_VERSION, revision: 42 })

  writeFileSync(file, '{broken')
  assert.deepEqual(readPullJournal(file), { version: STATE_VERSION, revision: 0 })

  writePullJournal(file, {
    version: STATE_VERSION,
    revision: 7,
    pending: { sessionId: 'session-x', targetSeq: 10, at: 123 },
    cwdPending: ['session-y'],
  })
  assert.deepEqual(readPullJournal(file), {
    version: STATE_VERSION,
    revision: 7,
    pending: { sessionId: 'session-x', targetSeq: 10, at: 123 },
    cwdPending: ['session-y'],
  })
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'))
})
