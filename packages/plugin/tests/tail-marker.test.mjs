import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canAppendTailMarker } from '../src/engine.ts'

/** 造事件。 */
const ev = (seq, type, data = {}) => ({ type, seq, time: 1000 + seq, data })

test('补 end-seed：空会话/尾已是 marker/turn 未闭合都不补', () => {
  assert.equal(canAppendTailMarker([], false), false)
  assert.equal(canAppendTailMarker([ev(0, 'session/end-seed')], false), false)
  assert.equal(canAppendTailMarker([ev(0, 'user/message')], true), false)
  assert.equal(canAppendTailMarker([ev(0, 'user/message')], false), true)
})

test('补 end-seed：未闭合 compaction/start 不补，闭合后可以补', () => {
  assert.equal(canAppendTailMarker([ev(0, 'compaction/start'), ev(1, 'compaction/summary')], false), false)
  assert.equal(canAppendTailMarker([ev(0, 'compaction/start'), ev(1, 'compaction/end'), ev(2, 'user/message')], false), true)
  assert.equal(canAppendTailMarker([ev(0, 'compaction/end'), ev(1, 'user/message')], false), true)
})
