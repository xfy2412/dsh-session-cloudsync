import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_BATCH_BYTES,
  DEFAULT_BATCH_EVENTS,
  eventBatchHash,
  headerChainHash,
  headerMetaOf,
  openEventBatch,
  openHeader,
  planEventBatches,
  sealEventBatch,
  sealHeader,
  type SyncEvent,
} from '../src/batches.ts'
import { sessionKeyOf } from '../src/sealed-frame.ts'

const MASTER = Buffer.alloc(32, 7)
const SESSION = 'session-batch-test'
const KEY = sessionKeyOf(MASTER, SESSION)

/** 造一段连续事件。 */
function events(count: number): SyncEvent[] {
  return Array.from({ length: count }, (_, seq) => ({
    type: 'test/event',
    seq,
    time: 1000 + seq,
    data: { index: seq, text: `event-${seq}` },
  }))
}

test('会话头：cwd 不参与哈希，封开稳定', () => {
  const a = { version: 4, createdAt: 123, isSeeded: false, delegationDepth: 0, agentPreset: 'standard', cwd: 'D:/a' }
  const b = { ...a, cwd: 'D:/b' }
  const metaA = headerMetaOf(a)
  const metaB = headerMetaOf(b)
  assert.deepEqual(metaA, metaB)
  assert.equal(headerChainHash(metaA), headerChainHash(metaB))

  const sealed = sealHeader(metaA, SESSION, KEY)
  assert.equal(sealed.ref.index, 0)
  assert.equal(sealed.ref.seqFrom, -1)
  assert.equal(sealed.ref.seqTo, -1)
  assert.equal(sealed.ref.chainHash, headerChainHash(metaA))
  assert.deepEqual(openHeader(sealed.bytes, sealed.ref, SESSION, KEY), metaA)
})

test('会话头：改一个字节就解不开', () => {
  const sealed = sealHeader(headerMetaOf({ version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0 }), SESSION, KEY)
  const tampered = Buffer.from(sealed.bytes)
  const last = tampered.length - 1
  tampered.writeUInt8(tampered.readUInt8(last) ^ 0xff, last)
  assert.throws(() => openHeader(tampered, sealed.ref, SESSION, KEY), /认证失败|哈希/u)
})

test('批次：按事件数切分，边界稳定，封开一致', () => {
  const all = events(120)
  const plan = planEventBatches(all, -1)
  assert.deepEqual(plan.map((batch) => batch.events.length), [50, 50, 20])
  assert.deepEqual(plan.map((batch) => [batch.seqFrom, batch.seqTo]), [[0, 49], [50, 99], [100, 119]])

  const sealed = sealEventBatch(plan[1]!.events, SESSION, 2, KEY)
  assert.equal(sealed.ref.index, 2)
  assert.equal(sealed.ref.seqFrom, 50)
  assert.equal(sealed.ref.seqTo, 99)
  assert.equal(sealed.ref.chainHash, eventBatchHash(plan[1]!.events))
  assert.deepEqual(openEventBatch(sealed.bytes, sealed.ref, SESSION, KEY), plan[1]!.events)
})

test('批次：继续上传只切新增事件，不重切旧边界', () => {
  const all = events(120)
  const plan = planEventBatches(all, 49)
  assert.deepEqual(plan.map((batch) => [batch.seqFrom, batch.seqTo]), [[50, 99], [100, 119]])
  assert.deepEqual(planEventBatches(all, 119), [])
})

test('批次：字节上限与单条超限', () => {
  const all = events(10)
  const plan = planEventBatches(all, -1, { maxBytes: 120, maxEvents: 50 })
  assert.ok(plan.length > 1)
  assert.ok(plan.every((batch) => batch.bytes <= 120 || batch.events.length === 1))

  const huge = [{ type: 'test/event', seq: 0, time: 1, data: { text: 'x'.repeat(500) } }]
  const single = planEventBatches(huge, -1, { maxBytes: 100 })
  assert.equal(single.length, 1)
  assert.equal(single[0]!.events.length, 1)
})

test('批次：键序不影响哈希，seq 不连续要报错', () => {
  const a = [{ seq: 0, type: 'x', data: { a: 1, b: 2 } }] as unknown as SyncEvent[]
  const b = [{ data: { b: 2, a: 1 }, type: 'x', seq: 0 }] as unknown as SyncEvent[]
  assert.equal(eventBatchHash(a), eventBatchHash(b))

  const gap = [
    { type: 'x', seq: 0, time: 1, data: {} },
    { type: 'x', seq: 2, time: 2, data: {} },
  ] as unknown as SyncEvent[]
  assert.throws(() => planEventBatches(gap, -1), /不连续/u)
  assert.throws(() => planEventBatches(events(2), -1, { maxEvents: 0 }), /正整数/u)
})

test('批次：清单区间与内容不一致时拒绝', () => {
  const sealed = sealEventBatch(events(2), SESSION, 1, KEY)
  const bad = { ...sealed.ref, seqTo: 2 }
  assert.throws(() => openEventBatch(sealed.bytes, bad, SESSION, KEY), /seq|认证/u)

  assert.throws(() => sealEventBatch([], SESSION, 1, KEY), /空批次/u)
  assert.throws(() => sealEventBatch(events(1), SESSION, 0, KEY), /下标/u)
})

test('默认上限是 50 事件 / 256 KiB', () => {
  assert.equal(DEFAULT_BATCH_EVENTS, 50)
  assert.equal(DEFAULT_BATCH_BYTES, 256 * 1024)
})
