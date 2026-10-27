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
  sealEventBatchFromText,
  sealHeader,
  serializeEventBatch,
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

test('批次：zstd 封帧可解回原事件，且带压缩元数据', () => {
  const meta = headerMetaOf({ version: 4, createdAt: 456, isSeeded: false, delegationDepth: 0 })
  const header = sealHeader(meta, SESSION, KEY, 'zstd')
  assert.equal(openHeader(header.bytes, header.ref, SESSION, KEY).createdAt, 456)
  assert.equal(header.ref.compression, 'zstd')

  const batch = events(50)
  const sealed = sealEventBatch(batch, SESSION, 1, KEY, 'zstd')
  assert.equal(sealed.ref.compression, 'zstd')
  assert.equal(sealed.ref.chainHash, eventBatchHash(batch))
  assert.deepEqual(openEventBatch(sealed.bytes, sealed.ref, SESSION, KEY), batch)
})

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

test('批次：线性规划的字节数与规范 JSON 完全一致', () => {
  const samples = [
    events(0),
    events(1),
    events(2),
    events(7),
    events(120),
    [
      { type: 'test/event', seq: 0, time: 1, data: { text: 'x'.repeat(500) } },
      { type: 'test/event', seq: 1, time: 2, data: { text: '中'.repeat(50) } },
    ] as unknown as SyncEvent[],
  ]
  for (const sample of samples) {
    for (const options of [{}, { maxEvents: 1 }, { maxBytes: 120 }, { maxEvents: 3, maxBytes: 300 }]) {
      const plan = planEventBatches(sample, -1, options)
      for (const batch of plan) {
        assert.equal(batch.bytes, Buffer.byteLength(serializeEventBatch(batch.events), 'utf8'))
        assert.equal(eventBatchHash(batch.events), eventBatchHash([...batch.events]))
      }
    }
  }
})

test('批次：线性规划与旧实现的边界/bytes 完全一致', () => {
  // 旧实现的逐事件候选重序列化；只用于小样本对照。
  function oldPlan(sample: readonly SyncEvent[], options: { maxEvents?: number; maxBytes?: number } = {}) {
    const maxEvents = options.maxEvents ?? DEFAULT_BATCH_EVENTS
    const maxBytes = options.maxBytes ?? DEFAULT_BATCH_BYTES
    const result: { seqFrom: number; seqTo: number; bytes: number; events: SyncEvent[] }[] = []
    let current: SyncEvent[] = []
    for (const event of sample) {
      const candidate = [...current, event]
      const candidateBytes = Buffer.byteLength(serializeEventBatch(candidate), 'utf8')
      if (current.length > 0 && (candidate.length > maxEvents || candidateBytes > maxBytes)) {
        result.push({
          seqFrom: current[0]!.seq,
          seqTo: current[current.length - 1]!.seq,
          bytes: Buffer.byteLength(serializeEventBatch(current), 'utf8'),
          events: current,
        })
        current = [event]
      } else {
        current = candidate
      }
    }
    if (current.length > 0) {
      result.push({
        seqFrom: current[0]!.seq,
        seqTo: current[current.length - 1]!.seq,
        bytes: Buffer.byteLength(serializeEventBatch(current), 'utf8'),
        events: current,
      })
    }
    return result
  }

  let seed = 0x12345678
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  const sample = Array.from({ length: 180 }, (_, seq) => ({
    type: 'test/random',
    seq,
    time: 1000 + seq,
    data: {
      n: next() % 1000,
      text: `事件-${next() % 100}-${'x'.repeat(next() % 80)}`,
      nested: { a: next() % 2 === 0, b: '中文-' + (next() % 10) },
    },
  })) as unknown as SyncEvent[]

  for (const options of [{}, { maxEvents: 1 }, { maxEvents: 7 }, { maxBytes: 120 }, { maxEvents: 13, maxBytes: 700 }]) {
    const actual = planEventBatches(sample, -1, options)
    const expected = oldPlan(sample, options)
    assert.deepEqual(
      actual.map((batch) => [batch.seqFrom, batch.seqTo, batch.bytes, batch.events.length]),
      expected.map((batch) => [batch.seqFrom, batch.seqTo, batch.bytes, batch.events.length]),
    )
  }
})

test('批次：预序列化封批与普通封批完全一致', () => {
  const plan = planEventBatches(events(51), -1)
  for (const batch of plan) {
    const text = serializeEventBatch(batch.events)
    const fromText = sealEventBatchFromText(text, SESSION, 1, batch.seqFrom, batch.seqTo, KEY)
    const fromEvents = sealEventBatch(batch.events, SESSION, 1, KEY)
    assert.deepEqual(fromText.bytes, fromEvents.bytes)
    assert.deepEqual(fromText.ref, fromEvents.ref)
  }
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
