import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decodeLog, encodeLog, hashFrame, isZstd, joinFrames, readHeader, splitFrames, splitRows } from '../src/frames.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'sessions')

/** 读取一个夹具。 */
function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8')
}

test('这里写出的帧链能解回完全相同的行', () => {
  const text = fixture('v4-minimal.jsonl')
  const frames = encodeLog(text, { headerLines: 1, rowsPerFrame: 3 })
  assert.ok(frames.length > 1, '夹具必须跨多帧')
  assert.ok(frames.every((frame) => isZstd(frame)))

  const decoded = decodeLog(joinFrames(frames))
  assert.deepEqual(splitRows(decoded), splitRows(text))
})

test('只看 header 帧就能拿到会话头', () => {
  const frames = encodeLog(fixture('v4-minimal.jsonl'))
  const header = readHeader(frames[0]!)
  assert.equal(header['type'], 'session')
  assert.equal(header['version'], 4)
  assert.equal(header['id'], 'session-fixture-minimal')
})

test('不解正文也能看出代际更新', () => {
  const header = readHeader(Buffer.from(fixture('v5-newer.jsonl')))
  assert.equal(header['version'], 5)
})

test('帧哈希用于标识不可变帧', () => {
  const frames = encodeLog(fixture('v4-minimal.jsonl'), { rowsPerFrame: 2 })
  const hashes = frames.map(hashFrame)
  assert.equal(new Set(hashes).size, hashes.length, '不同帧必须得到不同哈希')
  assert.match(hashes[0]!, /^[0-9a-f]{64}$/)
})

test('拼起来的帧能按原字节边界拆回', () => {
  const frames = encodeLog(fixture('v4-minimal.jsonl'), { rowsPerFrame: 2 })
  const joined = joinFrames(frames)
  const split = splitFrames(joined)
  assert.equal(split.length, frames.length)
  for (const [index, frame] of split.entries()) {
    assert.deepEqual(frame, frames[index])
  }
})

test('损坏的帧必须报错，而不是悄悄截断日志', () => {
  const frames = encodeLog(fixture('v4-minimal.jsonl'), { rowsPerFrame: 2 })
  const damaged = Buffer.from(joinFrames(frames))
  damaged[damaged.length - 1] = (damaged[damaged.length - 1]! ^ 0xff) & 0xff
  assert.throws(() => decodeLog(damaged))
})

test('明文 JSONL 原样通过 decodeLog', () => {
  const text = fixture('v4-minimal.jsonl')
  assert.equal(decodeLog(Buffer.from(text, 'utf8')), text)
})
