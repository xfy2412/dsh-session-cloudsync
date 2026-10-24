/**
 * 封帧（Sealed Frame）v1：把一帧明文装进可上传的密文 blob。
 *
 * 设计要点：
 * - 每帧用 HKDF 派生一把唯一密钥，nonce 固定为 0 —— 同一明文在任何设备上
 *   封出的字节完全一致，服务端可以按密文哈希去重；
 * - 明文 = 从会话日志里原样切出的 zstd 帧字节，绝不解码/重编码；
 * - AAD 把密文绑定到「会话 + 帧序号 + seq 区间 + 明文哈希」，挪帧/换序号/
 *   换会话都会导致认证失败；
 * - `chainHash`（明文哈希）用于帧链比对，`blobSha256`（密文哈希）用于
 *   服务端寻址，两者都写进清单条目。
 *
 * 线上布局（大端）：
 * ```text
 * 0   4   magic "DSHF"
 * 4   1   sealedVersion = 1
 * 5   1   flags
 * 6   8   keyId
 * 14  12  nonce（v1 全 0，保留）
 * 26  N   密文 + 16 字节 tag
 * ```
 *
 * @module @dsh-session-cloudsync/shared/sealed-frame
 */
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { deriveSubkey, sha256, TAG_BYTES, KEY_BYTES, NONCE_BYTES } from './crypto.ts'

/** 封帧魔数。 */
export const SEALED_MAGIC = Buffer.from('DSHF', 'ascii')

/** 当前封帧格式版本。 */
export const SEALED_VERSION = 1

/** keyId 长度（字节）。 */
export const KEY_ID_BYTES = 8

/** 固定头长度：magic + version + flags + keyId + nonce。 */
export const SEALED_HEADER_BYTES = 4 + 1 + 1 + KEY_ID_BYTES + NONCE_BYTES

/** v1 固定 nonce（每帧密钥唯一，因此 nonce 无需变化）。 */
const FIXED_NONCE = Buffer.alloc(NONCE_BYTES)

/** 清单里的封帧条目。 */
export interface SealedFrameRef {
  /** 帧在链中的下标（0 是 header 帧）。 */
  readonly index: number
  /** 明文帧的 SHA-256（小写十六进制），用于链比对。 */
  readonly chainHash: string
  /** 封帧字节的 SHA-256（小写十六进制），用于服务端寻址/去重。 */
  readonly blobSha256: string
  /** 封帧字节数。 */
  readonly bytes: number
  /** 封帧格式版本。 */
  readonly sealedVersion: number
  /** 加密该帧的会话密钥标识（小写十六进制）。 */
  readonly keyId: string
  /** 帧内第一条事件的序号（含）。 */
  readonly seqFrom: number
  /** 帧内最后一条事件的序号（含）。 */
  readonly seqTo: number
}

/** 一次封帧的产物。 */
export interface SealedFrame {
  readonly bytes: Buffer
  readonly ref: SealedFrameRef
}

/** 封帧需要的上下文；索引与序号来自帧链。 */
export interface FramePosition {
  readonly sessionId: string
  readonly index: number
  readonly seqFrom: number
  readonly seqTo: number
}

/** 解帧需要的上下文；另加清单里的明文哈希。 */
export interface OpenPosition extends FramePosition {
  readonly chainHash: string
}

/**
 * 由主密钥派生某会话的密钥。
 * @param master - scrypt 派生的主密钥。
 * @param sessionId - 会话 id。
 * @returns 32 字节会话密钥。
 */
export function sessionKeyOf(master: Buffer, sessionId: string): Buffer {
  return deriveSubkey(master, `v1|session:${sessionId}`)
}

/**
 * 由会话密钥派生某帧的密钥。
 * @param sessionKey - 会话密钥。
 * @param chainHash - 明文帧哈希（十六进制）。
 * @returns 32 字节帧密钥。
 */
export function frameKeyOf(sessionKey: Buffer, chainHash: string): Buffer {
  return deriveSubkey(sessionKey, `v1|frame:${chainHash}`)
}

/**
 * 会话密钥的稳定标识。
 * @param sessionKey - 会话密钥。
 * @returns 8 字节标识。
 */
export function keyIdOf(sessionKey: Buffer): Buffer {
  return deriveSubkey(sessionKey, 'v1|key-id').subarray(0, KEY_ID_BYTES)
}

/** AAD 里表示"header 帧无序号"的哨兵值。 */
const SEQ_HEADER = 0xffffffff

/**
 * 组装 AAD：固定头 + 会话与帧坐标 + 明文哈希。
 * @param header - 线上固定头（含 magic/version/flags/keyId/nonce）。
 * @param position - 帧坐标与明文哈希。
 * @returns 关联数据字节。
 */
function buildAad(header: Buffer, position: OpenPosition): Buffer {
  const session = Buffer.from(position.sessionId, 'utf8')
  if (session.length > 0xffff) throw new Error('会话 id 过长，AAD 无法编码')
  const tail = Buffer.alloc(2 + session.length + 8 + 4 + 4 + 32)
  tail.writeUInt16BE(session.length, 0)
  session.copy(tail, 2)
  let offset = 2 + session.length
  tail.writeBigUInt64BE(BigInt(position.index), offset)
  offset += 8
  // header 帧没有序号：用 u32 最大值当哨兵，保证同一份 AAD 在封装与解开时一致。
  tail.writeUInt32BE(position.seqFrom < 0 ? SEQ_HEADER : position.seqFrom, offset)
  offset += 4
  tail.writeUInt32BE(position.seqTo < 0 ? SEQ_HEADER : position.seqTo, offset)
  offset += 4
  Buffer.from(position.chainHash, 'hex').copy(tail, offset)
  return Buffer.concat([header, tail])
}

/**
 * 封装一帧明文。
 * @param plain - 原始 zstd 帧字节。
 * @param position - 会话 id、帧下标与 seq 区间。
 * @param sessionKey - 会话密钥（{@link sessionKeyOf}）。
 * @returns 封帧字节与清单条目。
 */
export function sealFrame(plain: Buffer, position: FramePosition, sessionKey: Buffer): SealedFrame {
  if (sessionKey.length !== KEY_BYTES) throw new Error(`会话密钥必须是 ${KEY_BYTES} 字节`)
  if (!Number.isSafeInteger(position.index) || position.index < 0) throw new Error('帧下标必须是非负整数')
  const chainHash = sha256(plain)
  const frameKey = frameKeyOf(sessionKey, chainHash)
  const keyId = keyIdOf(sessionKey)

  const header = Buffer.alloc(SEALED_HEADER_BYTES)
  SEALED_MAGIC.copy(header, 0)
  header.writeUInt8(SEALED_VERSION, 4)
  header.writeUInt8(0, 5)
  keyId.copy(header, 6)
  FIXED_NONCE.copy(header, 14)

  const aad = buildAad(header, { ...position, chainHash })
  const cipher = createCipheriv('aes-256-gcm', frameKey, FIXED_NONCE)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  const bytes = Buffer.concat([header, body, cipher.getAuthTag()])

  return {
    bytes,
    ref: {
      index: position.index,
      chainHash,
      blobSha256: sha256(bytes),
      bytes: bytes.length,
      sealedVersion: SEALED_VERSION,
      keyId: keyId.toString('hex'),
      seqFrom: position.seqFrom,
      seqTo: position.seqTo,
    },
  }
}

/**
 * 解析封帧固定头。
 * @param sealed - 封帧字节。
 * @returns 版本、flags、keyId 与 nonce。
 * @throws 长度不足、魔数不符或版本未知时抛出。
 */
export function parseSealedHeader(sealed: Buffer): { version: number; flags: number; keyId: Buffer; nonce: Buffer } {
  if (sealed.length < SEALED_HEADER_BYTES + TAG_BYTES) throw new Error('封帧字节被截断')
  if (!sealed.subarray(0, 4).equals(SEALED_MAGIC)) throw new Error('不是 DSHF 封帧')
  const version = sealed.readUInt8(4)
  if (version !== SEALED_VERSION) throw new Error(`不支持的封帧版本：${version}`)
  return {
    version,
    flags: sealed.readUInt8(5),
    keyId: sealed.subarray(6, 6 + KEY_ID_BYTES),
    nonce: sealed.subarray(14, 14 + NONCE_BYTES),
  }
}

/**
 * 解开一帧。
 * @param sealed - 封帧字节。
 * @param position - 清单给出的帧坐标与明文哈希。
 * @param sessionKey - 会话密钥。
 * @returns 原始 zstd 帧字节。
 * @throws 版本、keyId、AAD、标签或明文哈希不匹配时抛出。
 */
export function openSealedFrame(sealed: Buffer, position: OpenPosition, sessionKey: Buffer): Buffer {
  const header = parseSealedHeader(sealed)
  const expectedKeyId = keyIdOf(sessionKey)
  if (!header.keyId.equals(expectedKeyId)) {
    throw new Error('封帧的 keyId 与当前密钥不符（请确认各设备同步口令、服务端地址与 salt 一致）')
  }

  const headerBytes = sealed.subarray(0, SEALED_HEADER_BYTES)
  const aad = buildAad(headerBytes, position)
  const body = sealed.subarray(SEALED_HEADER_BYTES, sealed.length - TAG_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const frameKey = frameKeyOf(sessionKey, position.chainHash)

  const decipher = createDecipheriv('aes-256-gcm', frameKey, header.nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('封帧认证失败（密文、AAD 或密钥不匹配）')
  }
  if (sha256(plain) !== position.chainHash) throw new Error('明文哈希与清单不符')
  return plain
}
