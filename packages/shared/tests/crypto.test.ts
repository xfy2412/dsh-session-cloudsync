import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveMasterKey, deriveMasterKeyAsync, deriveSubkey, newSalt, open, randomId, seal, sha256 } from '../src/crypto.ts'

const passphrase = 'correct horse battery staple'
const salt = newSalt()

test('同一口令与盐派生出同一主密钥', () => {
  assert.deepEqual(deriveMasterKey(passphrase, salt), deriveMasterKey(passphrase, salt))
  assert.notDeepEqual(deriveMasterKey(passphrase, newSalt()), deriveMasterKey(passphrase, salt))
})

test('异步派生与同步派生结果一致', async () => {
  assert.deepEqual(await deriveMasterKeyAsync(passphrase, salt), deriveMasterKey(passphrase, salt))
})

test('子密钥按用途分隔', () => {
  const master = deriveMasterKey(passphrase, salt)
  const a = deriveSubkey(master, 'v1|session:a')
  const b = deriveSubkey(master, 'v1|session:b')
  assert.equal(a.length, 32)
  assert.notDeepEqual(a, b)
})

test('带关联数据的封装可以往返', () => {
  const key = deriveSubkey(deriveMasterKey(passphrase, salt), 'v1|session:a')
  const plaintext = Buffer.from('frame bytes', 'utf8')
  const aad = Buffer.from('frame-hash|session|ordinal', 'utf8')
  const sealed = seal(key, plaintext, aad)
  assert.equal(sealed.nonce.length, 12)
  assert.deepEqual(open(key, sealed, aad), plaintext)
})

test('关联数据不一致时解不开', () => {
  const key = deriveSubkey(deriveMasterKey(passphrase, salt), 'v1|session:a')
  const sealed = seal(key, Buffer.from('frame bytes'), Buffer.from('aad-1'))
  assert.throws(() => open(key, sealed, Buffer.from('aad-2')))
})

test('密文被篡改时解不开', () => {
  const key = deriveSubkey(deriveMasterKey(passphrase, salt), 'v1|session:a')
  const sealed = seal(key, Buffer.from('frame bytes'), Buffer.from('aad'))
  const tampered = { nonce: sealed.nonce, ciphertext: Buffer.from(sealed.ciphertext) }
  tampered.ciphertext[0] = (tampered.ciphertext[0]! ^ 0x01) & 0xff
  assert.throws(() => open(key, tampered, Buffer.from('aad')))
})

test('哈希与随机 id 的形状固定', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.match(randomId(), /^[0-9a-f]{32}$/)
})
