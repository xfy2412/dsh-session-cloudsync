import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { deriveMasterKey, sha256 } from '../src/crypto.ts'
import { splitFrames } from '../src/frames.ts'
import {
  SEALED_HEADER_BYTES,
  SEALED_VERSION,
  SEALED_VERSION_ZSTD,
  frameKeyOf,
  keyIdOf,
  openSealedFrame,
  parseSealedHeader,
  sealFrame,
  sessionKeyOf,
} from '../src/sealed-frame.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'tests', 'fixtures', 'sessions')
const frames = splitFrames(readFileSync(join(fixtures, 'v4-coverage.jsonl.zstd')))

const MASTER = Buffer.alloc(32, 7)
const SESSION_KEY = sessionKeyOf(MASTER, 'session-sealed-test')
const POSITION = { sessionId: 'session-sealed-test', index: 0, seqFrom: 0, seqTo: 0 }

/** 造一个可复用的帧坐标。 */
function positionOf(index: number): { sessionId: string; index: number; seqFrom: number; seqTo: number } {
  // header 帧没有 seq；统一用下标当序号，测试只关心"两边一致"。
  return { sessionId: POSITION.sessionId, index, seqFrom: index, seqTo: index }
}

test('header 帧的无序号哨兵也能封装与解开', () => {
  const position = { sessionId: POSITION.sessionId, index: 0, seqFrom: -1, seqTo: -1 }
  const sealed = sealFrame(frames[0]!, position, SESSION_KEY)
  const opened = openSealedFrame(sealed.bytes, { ...position, chainHash: sealed.ref.chainHash }, SESSION_KEY)
  assert.deepEqual(opened, frames[0])
  assert.equal(sealed.ref.seqFrom, -1)
  assert.equal(sealed.ref.seqTo, -1)
})

test('覆盖夹具的每一帧都能封装再解开，字节完全一致', () => {
  assert.ok(frames.length > 0)
  frames.forEach((frame, index) => {
    const position = positionOf(index)
    const sealed = sealFrame(frame, position, SESSION_KEY)
    const opened = openSealedFrame(sealed.bytes, { ...position, chainHash: sealed.ref.chainHash }, SESSION_KEY)
    assert.deepEqual(opened, frame, `第 ${index} 帧往返后字节不一致`)
    assert.deepEqual(splitFrames(opened), [frame])
  })
})

test('同一帧两次封装得到完全相同的密文（可去重）', () => {
  const position = positionOf(1)
  const a = sealFrame(frames[1]!, position, SESSION_KEY)
  const b = sealFrame(frames[1]!, position, SESSION_KEY)
  assert.deepEqual(a.bytes, b.bytes)
  assert.deepEqual(a.ref, b.ref)
})

test('清单条目：链哈希、密文哈希与长度都正确', () => {
  const position = positionOf(2)
  const sealed = sealFrame(frames[2]!, position, SESSION_KEY)
  assert.equal(sealed.ref.index, 2)
  assert.equal(sealed.ref.chainHash, sha256(frames[2]!))
  assert.equal(sealed.ref.blobSha256, sha256(sealed.bytes))
  assert.equal(sealed.ref.bytes, sealed.bytes.length)
  assert.equal(sealed.ref.sealedVersion, SEALED_VERSION)
  assert.equal(sealed.ref.seqFrom, 2)
  assert.equal(sealed.ref.seqTo, 2)
  assert.equal(sealed.ref.keyId, keyIdOf(SESSION_KEY).toString('hex'))
  assert.equal(sealed.bytes.length, SEALED_HEADER_BYTES + frames[2]!.length + 16)
})

test('封帧头可解析，keyId 对同一会话密钥稳定', () => {
  const a = sealFrame(frames[0]!, positionOf(0), SESSION_KEY)
  const b = sealFrame(frames[1]!, positionOf(1), SESSION_KEY)
  const header = parseSealedHeader(a.bytes)
  assert.equal(header.version, SEALED_VERSION)
  assert.equal(header.flags, 0)
  assert.deepEqual(header.keyId, keyIdOf(SESSION_KEY))
  assert.deepEqual(header.keyId, parseSealedHeader(b.bytes).keyId)
})

test('换会话密钥解不开', () => {
  const position = positionOf(3)
  const sealed = sealFrame(frames[3]!, position, SESSION_KEY)
  const other = sessionKeyOf(MASTER, 'session-other')
  assert.throws(
    () => openSealedFrame(sealed.bytes, { ...position, chainHash: sealed.ref.chainHash }, other),
    /keyId|认证失败/,
  )
})

test('密文改一个字节就解不开', () => {
  const position = positionOf(4)
  const sealed = sealFrame(frames[4]!, position, SESSION_KEY)
  const tampered = Buffer.from(sealed.bytes)
  const offset = SEALED_HEADER_BYTES + 3
  tampered[offset] = (tampered[offset] ?? 0) ^ 0xff
  assert.throws(
    () => openSealedFrame(tampered, { ...position, chainHash: sealed.ref.chainHash }, SESSION_KEY),
    /认证失败/,
  )
})

test('AAD 坐标不一致就解不开（挪帧/改序号/换会话/换哈希）', () => {
  const position = positionOf(5)
  const sealed = sealFrame(frames[5]!, position, SESSION_KEY)
  const base = { ...position, chainHash: sealed.ref.chainHash }
  const variants = [
    { ...base, index: 6 },
    { ...base, seqFrom: 6 },
    { ...base, seqTo: 7 },
    { ...base, sessionId: 'session-other' },
    { ...base, chainHash: sha256('not-the-frame') },
  ]
  for (const variant of variants) {
    assert.throws(() => openSealedFrame(sealed.bytes, variant, SESSION_KEY), /认证失败|keyId|明文哈希/, JSON.stringify(variant))
  }
})

test('未知封帧版本被拒绝，而不是猜', () => {
  const sealed = sealFrame(frames[6]!, positionOf(6), SESSION_KEY)
  const future = Buffer.from(sealed.bytes)
  future.writeUInt8(99, 4)
  assert.throws(() => parseSealedHeader(future), /不支持的封帧版本/)
})

test('v2 zstd 帧：明文哈希不变，密文/帧密钥与未压缩不同', () => {
  const position = positionOf(7)
  const plain = Buffer.from(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ seq: index, text: 'repeatable-payload' }))))
  const uncompressed = sealFrame(plain, position, SESSION_KEY)
  const compressed = sealFrame(plain, position, SESSION_KEY, { compression: 'zstd' })
  const compressedHash = compressed.ref.compressedHash
  assert.ok(compressedHash !== undefined)
  assert.equal(compressed.ref.chainHash, uncompressed.ref.chainHash)
  assert.notEqual(compressed.ref.blobSha256, uncompressed.ref.blobSha256)
  assert.equal(compressed.ref.sealedVersion, SEALED_VERSION_ZSTD)
  assert.equal(compressed.ref.compression, 'zstd')
  assert.ok(compressed.bytes.length < uncompressed.bytes.length)
  assert.equal(compressedHash, sha256(zstdCompressSync(plain)))
  assert.notDeepEqual(
    frameKeyOf(SESSION_KEY, compressed.ref.chainHash, 'zstd', compressedHash),
    frameKeyOf(SESSION_KEY, compressed.ref.chainHash),
  )
  const opened = openSealedFrame(compressed.bytes, {
    ...position,
    chainHash: compressed.ref.chainHash,
    compression: 'zstd',
    compressedHash,
  }, SESSION_KEY)
  assert.deepEqual(opened, plain)
})

test('v2 zstd 帧缺少压缩元数据或压缩哈希被改时拒绝', () => {
  const position = positionOf(8)
  const compressed = sealFrame(Buffer.from('compressible '.repeat(100)), position, SESSION_KEY, { compression: 'zstd' })
  const compressedHash = compressed.ref.compressedHash
  assert.ok(compressedHash !== undefined)
  assert.throws(
    () => openSealedFrame(compressed.bytes, { ...position, chainHash: compressed.ref.chainHash }, SESSION_KEY),
    /缺少压缩元数据/,
  )
  assert.throws(
    () => openSealedFrame(compressed.bytes, {
      ...position,
      chainHash: compressed.ref.chainHash,
      compression: 'zstd',
      compressedHash: sha256('wrong'),
    }, SESSION_KEY),
    /认证失败|压缩明文哈希/,
  )
  const tampered = Buffer.from(compressed.bytes)
  tampered[tampered.length - 1]! ^= 0xff
  assert.throws(
    () => openSealedFrame(tampered, {
      ...position,
      chainHash: compressed.ref.chainHash,
      compression: 'zstd',
      compressedHash,
    }, SESSION_KEY),
    /认证失败/,
  )
})

test('口令派生：同盐同结果，不同盐不同结果', () => {
  const salt = Buffer.alloc(16, 1)
  const a = deriveMasterKey('correct horse battery staple', salt)
  const b = deriveMasterKey('correct horse battery staple', salt)
  const c = deriveMasterKey('correct horse battery staple', Buffer.alloc(16, 2))
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
  assert.deepEqual(sessionKeyOf(a, 'session-a'), sessionKeyOf(b, 'session-a'))
  assert.notDeepEqual(sessionKeyOf(a, 'session-a'), sessionKeyOf(a, 'session-b'))
})
