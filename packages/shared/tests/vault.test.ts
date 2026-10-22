import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertVaultRecordRef,
  openVaultRecord,
  sealVaultRecord,
  vaultKeyIdOf,
  vaultKeyOf,
  vaultRecordHashOf,
  verifyVaultChain,
  workspaceKeyOf,
} from '../src/vault.ts'

const master = Buffer.alloc(32, 7)
const vaultKey = vaultKeyOf(master)

/** 构造一条测试记录。 */
function record(seq: number, prevHash: string | null, overrides: Record<string, unknown> = {}) {
  return sealVaultRecord({
    writer: 'device-a',
    seq,
    prevHash,
    createdAt: 1_790_000_000_000 + seq,
    kind: 'device/profile',
    entity: 'device-a',
    at: 1_790_000_000_000 + seq,
    data: { seq, name: 'X2411' },
    vaultKey,
    ...overrides,
  })
}

test('Vault 密钥域与 workspaceKey 稳定且相互隔离', () => {
  assert.equal(vaultKey.length, 32)
  assert.deepEqual(vaultKeyOf(master), vaultKey)
  assert.match(vaultKeyIdOf(vaultKey), /^[0-9a-f]{16}$/)

  const a = workspaceKeyOf(vaultKey, 'D:/work/project')
  const b = workspaceKeyOf(vaultKey, 'D:/work/project')
  const c = workspaceKeyOf(vaultKey, 'D:/work/other')
  const otherVault = workspaceKeyOf(vaultKeyOf(Buffer.alloc(32, 8)), 'D:/work/project')
  assert.equal(a, b)
  assert.match(a, /^[A-Za-z0-9_-]{24}$/)
  assert.notEqual(a, c)
  assert.notEqual(a, otherVault)
})

test('Vault 记录确定性封帧并可解开', () => {
  const first = record(1, null)
  const again = record(1, null)
  assert.deepEqual(first.ref, again.ref)
  assert.deepEqual(first.bytes, again.bytes)
  assert.equal(first.ref.sealed.formatVersion, 1)
  assert.match(first.ref.recordHash, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(first.bytes.toString('utf8'), /device\/profile/)
  assert.doesNotMatch(first.bytes.toString('utf8'), /X2411/)

  const opened = openVaultRecord(first, vaultKey)
  assert.equal(opened.schema, 'dsh-session-cloudsync/vault/1')
  assert.equal(opened.kind, 'device/profile')
  assert.equal(opened.entity, 'device-a')
  assert.deepEqual(opened.data, { seq: 1, name: 'X2411' })
})

test('Vault 记录链校验连续序号、writer、prevHash 与 recordHash', () => {
  const first = record(1, null)
  const second = record(2, first.ref.recordHash)
  const third = record(3, second.ref.recordHash)
  assert.doesNotThrow(() => verifyVaultChain([first.ref, second.ref, third.ref]))

  assert.throws(() => verifyVaultChain([first.ref, third.ref]), /seq 应为 2/)
  assert.throws(() => verifyVaultChain([{ ...first.ref, recordHash: '0'.repeat(64) }]), /recordHash/)
  assert.throws(
    () => verifyVaultChain([record(1, null, { data: { other: true } }).ref, second.ref]),
    /prevHash/,
  )
  const writerMismatch = record(2, first.ref.recordHash, { writer: 'device-b' })
  assert.throws(() => verifyVaultChain([first.ref, writerMismatch.ref]), /writer/)
  assert.throws(() => assertVaultRecordRef({ ...first.ref, bytes: 0 }), /bytes/)
})

test('篡改密文、索引或跨设备挪记录都解不开', () => {
  const first = record(1, null)
  const tampered = Buffer.from(first.bytes)
  const last = tampered.length - 1
  tampered[last] = tampered[last]! ^ 1
  assert.throws(() => openVaultRecord({ ref: first.ref, bytes: tampered }, vaultKey), /哈希/)
  assert.throws(() => openVaultRecord({ ...first, ref: { ...first.ref, createdAt: first.ref.createdAt + 1 } }, vaultKey), /recordHash/)
  assert.throws(() => openVaultRecord({ ...first, ref: { ...first.ref, writer: 'device-b' } }, vaultKey), /recordHash|keyId/)
  const moved = { ...first.ref, writer: 'device-b' }
  moved.recordHash = vaultRecordHashOf(moved)
  assert.throws(() => openVaultRecord({ ref: moved, bytes: first.bytes }, vaultKey), /解密/)
  assert.throws(() => openVaultRecord(first, vaultKeyOf(Buffer.alloc(32, 9))), /keyId/)
})

test('genesis 和非法 kind/data 被拒绝', () => {
  assert.throws(() => record(2, null), /prevHash/)
  assert.throws(() => record(1, '0'.repeat(64)), /prevHash/)
  assert.throws(() => record(1, null, { kind: 'device' }), /kind/)
  assert.throws(() => record(1, null, { data: undefined }), /undefined/)
})
