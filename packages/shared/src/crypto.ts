/**
 * 端到端加密原语：由口令派生主密钥、按用途派生子密钥，以及带关联数据的
 * AES-256-GCM 封装。
 *
 * 服务端只会拿到密文；这里出现的密钥都留在客户端。
 *
 * @module @dsh-session-cloudsync/shared/crypto
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt, scryptSync } from 'node:crypto'

/** 对称密钥长度（字节）。 */
export const KEY_BYTES = 32

/** AES-GCM nonce 长度（字节）。 */
export const NONCE_BYTES = 12

/** AES-GCM 认证标签长度（字节）。 */
export const TAG_BYTES = 16

/** 口令盐长度（字节）。 */
export const SALT_BYTES = 16

/** scrypt 参数；与盐一起记录，以后可以调整。 */
export const SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const

/** 封装结果：nonce 与"密文 + 认证标签"。 */
export interface Sealed {
  readonly nonce: Buffer
  readonly ciphertext: Buffer
}

/**
 * 为新 keybox 生成随机盐。
 * @returns 随机字节。
 */
export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES)
}

/**
 * 由用户口令派生主密钥。
 * @param passphrase - 同步口令，永不落盘。
 * @param salt - 存在 keybox 里的盐。
 * @returns 32 字节密钥。
 */
export function deriveMasterKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, { ...SCRYPT, maxmem: 128 * 1024 * 1024 })
}

/**
 * 异步版本的主密钥派生；用于不在宿主事件循环上跑 scrypt。
 * @param passphrase - 同步口令，永不落盘。
 * @param salt - 存在 keybox 里的盐。
 * @returns 32 字节密钥。
 */
export async function deriveMasterKeyAsync(passphrase: string, salt: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase, salt, KEY_BYTES, { ...SCRYPT, maxmem: 128 * 1024 * 1024 }, (error, key) => {
      if (error !== null) reject(error)
      else resolve(Buffer.from(key))
    })
  })
}

/**
 * 从主密钥派生某个用途的子密钥。
 * @param master - 主密钥。
 * @param info - 域分隔串，例如 `v1|session:<sessionId>`。
 * @returns 32 字节子密钥。
 */
export function deriveSubkey(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info, 'utf8'), KEY_BYTES))
}

/**
 * 用 AES-256-GCM 封装字节。
 * @param key - 32 字节密钥。
 * @param plaintext - 待加密字节。
 * @param aad - 与密文绑定的关联数据（帧哈希、会话 id、序号）。
 * @returns nonce 与密文（标签附加在末尾）。
 */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Sealed {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) }
}

/**
 * 解开封装。
 * @param key - 32 字节密钥。
 * @param sealed - {@link seal} 产生的 nonce 与密文。
 * @param aad - 封装时使用的同一份关联数据。
 * @returns 明文。
 * @throws 密钥、nonce、标签或关联数据不匹配时抛出。
 */
export function open(key: Buffer, sealed: Sealed, aad: Buffer): Buffer {
  if (sealed.ciphertext.length < TAG_BYTES) throw new Error('封装载荷比认证标签还短')
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/**
 * SHA-256，小写十六进制。
 * @param data - 字节或 UTF-8 文本。
 * @returns 十六进制摘要。
 */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 随机标识符，小写十六进制。
 * @param bytes - 熵的字节数。
 * @returns 长度为 `bytes` 两倍的十六进制串。
 */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}
