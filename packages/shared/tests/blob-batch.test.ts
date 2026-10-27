import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BLOB_BATCH_HEADER_BYTES,
  MAX_BATCH_BLOBS,
  MAX_BATCH_BODY_BYTES,
  decodeBlobBatch,
  encodeBlobBatch,
} from '../src/blob-batch.ts'
import { sha256 } from '../src/crypto.ts'

test('批量 blob 编解码保持顺序、类别、哈希与字节', () => {
  const entries = [
    { kind: 'frame' as const, data: Buffer.from('sealed-frame') },
    { kind: 'vault' as const, data: Buffer.from('vault-record') },
    { kind: 'attachment' as const, data: Buffer.from('attachment') },
  ]
  const encoded = encodeBlobBatch(entries)
  const decoded = decodeBlobBatch(encoded)
  assert.equal(decoded.length, 3)
  assert.deepEqual(decoded.map((entry) => entry.kind), ['frame', 'vault', 'attachment'])
  assert.deepEqual(decoded.map((entry) => entry.data), entries.map((entry) => entry.data))
  assert.deepEqual(decoded.map((entry) => entry.sha256), entries.map((entry) => sha256(entry.data)))
  assert.equal(encoded.readUInt32BE(8), 3)
})

test('同样内容编码得到同样字节', () => {
  const entries = [{ kind: 'frame' as const, data: Buffer.from('same') }]
  assert.deepEqual(encodeBlobBatch(entries), encodeBlobBatch(entries))
})

test('批量 blob 拒绝空批、超条数、超总字节和空内容', () => {
  assert.throws(() => encodeBlobBatch([]), /条数/)
  assert.throws(() => encodeBlobBatch(Array.from({ length: MAX_BATCH_BLOBS + 1 }, () => ({ kind: 'frame' as const, data: Buffer.from('x') }))), /条数/)
  assert.throws(() => encodeBlobBatch([{ kind: 'frame' as const, data: Buffer.alloc(MAX_BATCH_BODY_BYTES) }]), /超过上限/)
  assert.throws(() => encodeBlobBatch([{ kind: 'frame' as const, data: Buffer.alloc(0) }]), /空内容/)
})

test('批量 blob 解码拒绝坏 magic、坏版本、截断与尾部垃圾', () => {
  const encoded = encodeBlobBatch([{ kind: 'frame' as const, data: Buffer.from('payload') }])
  const badMagic = Buffer.from(encoded)
  badMagic[0] = 0
  assert.throws(() => decodeBlobBatch(badMagic), /DSHB/)
  const badVersion = Buffer.from(encoded)
  badVersion[4] = 9
  assert.throws(() => decodeBlobBatch(badVersion), /版本/)
  assert.throws(() => decodeBlobBatch(encoded.subarray(0, BLOB_BATCH_HEADER_BYTES + 4)), /截断/)
  assert.throws(() => decodeBlobBatch(Buffer.concat([encoded, Buffer.from([0])])), /多余字节/)
})
