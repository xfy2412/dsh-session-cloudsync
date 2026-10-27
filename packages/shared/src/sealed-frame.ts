/**
 * 封帧（Sealed Frame）：把一帧明文装进可上传的密文 blob。
 *
 * v1 是未压缩格式；v2 在加密前对明文做 zstd。两者共用 26 字节固定头，
 * 版本号区分：
 *
 * ```text
 * 0   4   magic "DSHF"
 * 4   1   sealedVersion（1=未压缩，2=zstd）
 * 5   1   flags
 * 6   8   keyId
 * 14  12  nonce（全 0）
 * 26  N   密文 + 16 字节 tag
 * ```
 *
 * 压缩只发生在客户端加密前；服务端仍只存密文。`chainHash` 始终绑定
 * **未压缩明文**；压缩帧额外用压缩明文的哈希派生帧密钥，避免不同压缩结果
 * 复用同一个 key + nonce。
 *
 * @module @dsh-session-cloudsync/shared/sealed-frame
 */
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { deriveSubkey, sha256, TAG_BYTES, KEY_BYTES, NONCE_BYTES } from './crypto.ts'

/** 封帧魔数。 */
export const SEALED_MAGIC = Buffer.from('DSHF', 'ascii')

/** v1（未压缩）封帧版本。 */
export const SEALED_VERSION = 1

/** v2（zstd 压缩）封帧版本。 */
export const SEALED_VERSION_ZSTD = 2

/** keyId 长度（字节）。 */
export const KEY_ID_BYTES = 8

/** 固定头长度：magic + version + flags + keyId + nonce。 */
export const SEALED_HEADER_BYTES = 4 + 1 + 1 + KEY_ID_BYTES + NONCE_BYTES

/** 固定 nonce（每帧密钥唯一，因此 nonce 无需变化）。 */
const FIXED_NONCE = Buffer.alloc(NONCE_BYTES)

/** 明文压缩方式。 */
export type FrameCompression = 'none' | 'zstd'

/** 清单里的封帧条目。 */
export interface SealedFrameRef {
  /** 帧在链中的下标（0 是 header 帧）。 */
  readonly index: number
  /** 未压缩明文帧的 SHA-256（小写十六进制），用于链比对。 */
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
  /** v2 的压缩方式；v1 省略。 */
  readonly compression?: 'zstd'
  /** v2 压缩后明文的 SHA-256；用于派生帧密钥并校验压缩结果。 */
  readonly compressedHash?: string
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

/** 解帧需要的上下文；另加清单里的未压缩明文哈希与压缩元数据。 */
export interface OpenPosition extends FramePosition {
  readonly chainHash: string
  readonly compression?: 'zstd'
  readonly compressedHash?: string
}

/** 封帧选项。 */
export interface SealFrameOptions {
  /** 默认不压缩；设为 zstd 时启用 v2 压缩帧。 */
  readonly compression?: 'zstd'
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
 *
 * v1 只用未压缩 `chainHash`；v2 还必须带压缩明文哈希，避免不同的 zstd
 * 输出在同一个 chainHash 下复用 key + nonce。
 * @param sessionKey - 会话密钥。
 * @param chainHash - 未压缩明文帧哈希（十六进制）。
 * @param compression - 压缩方式，默认 none。
 * @param compressedHash - 压缩后明文哈希；zstd 必填。
 * @returns 32 字节帧密钥。
 */
export function frameKeyOf(
  sessionKey: Buffer,
  chainHash: string,
  compression: FrameCompression = 'none',
  compressedHash?: string,
): Buffer {
  if (compression === 'zstd') {
    if (compressedHash === undefined || !/^[0-9a-f]{64}$/u.test(compressedHash)) {
      throw new Error('zstd 帧缺少合法的 compressedHash')
    }
    return deriveSubkey(sessionKey, `v2|frame:zstd:${compressedHash}:${chainHash}`)
  }
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
 * @param plain - 未压缩明文帧字节（同步层是规范 JSON）。
 * @param position - 会话 id、帧下标与 seq 区间。
 * @param sessionKey - 会话密钥（{@link sessionKeyOf}）。
 * @param options - 压缩方式；默认 none。
 * @returns 封帧字节与清单条目。
 */
export function sealFrame(
  plain: Buffer,
  position: FramePosition,
  sessionKey: Buffer,
  options: SealFrameOptions = {},
): SealedFrame {
  if (sessionKey.length !== KEY_BYTES) throw new Error(`会话密钥必须是 ${KEY_BYTES} 字节`)
  if (!Number.isSafeInteger(position.index) || position.index < 0) throw new Error('帧下标必须是非负整数')
  const compression = options.compression ?? 'none'
  const chainHash = sha256(plain)
  const payload = compression === 'zstd' ? zstdCompressSync(plain) : plain
  const compressedHash = compression === 'zstd' ? sha256(payload) : undefined
  const frameKey = frameKeyOf(sessionKey, chainHash, compression, compressedHash)
  const keyId = keyIdOf(sessionKey)
  const version = compression === 'zstd' ? SEALED_VERSION_ZSTD : SEALED_VERSION

  const header = Buffer.alloc(SEALED_HEADER_BYTES)
  SEALED_MAGIC.copy(header, 0)
  header.writeUInt8(version, 4)
  header.writeUInt8(0, 5)
  keyId.copy(header, 6)
  FIXED_NONCE.copy(header, 14)

  const aad = buildAad(header, { ...position, chainHash })
  const cipher = createCipheriv('aes-256-gcm', frameKey, FIXED_NONCE)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(payload), cipher.final()])
  const bytes = Buffer.concat([header, body, cipher.getAuthTag()])

  return {
    bytes,
    ref: {
      index: position.index,
      chainHash,
      blobSha256: sha256(bytes),
      bytes: bytes.length,
      sealedVersion: version,
      keyId: keyId.toString('hex'),
      seqFrom: position.seqFrom,
      seqTo: position.seqTo,
      ...compression === 'zstd'
        ? { compression: 'zstd' as const, compressedHash: compressedHash! }
        : {},
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
  if (version !== SEALED_VERSION && version !== SEALED_VERSION_ZSTD) {
    throw new Error(`不支持的封帧版本：${version}`)
  }
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

  const compression: FrameCompression = header.version === SEALED_VERSION_ZSTD ? 'zstd' : 'none'
  if (compression === 'zstd') {
    if (position.compression !== 'zstd' || position.compressedHash === undefined) {
      throw new Error('zstd 封帧缺少压缩元数据')
    }
  } else if (position.compression !== undefined || position.compressedHash !== undefined) {
    throw new Error('未压缩封帧不应带压缩元数据')
  }

  const headerBytes = sealed.subarray(0, SEALED_HEADER_BYTES)
  const aad = buildAad(headerBytes, position)
  const body = sealed.subarray(SEALED_HEADER_BYTES, sealed.length - TAG_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const frameKey = frameKeyOf(sessionKey, position.chainHash, compression, position.compressedHash)

  const decipher = createDecipheriv('aes-256-gcm', frameKey, header.nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  let payload: Buffer
  try {
    payload = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('封帧认证失败（密文、AAD 或密钥不匹配）')
  }

  if (compression === 'zstd') {
    if (sha256(payload) !== position.compressedHash) throw new Error('压缩明文哈希与清单不符')
    let plain: Buffer
    try {
      plain = zstdDecompressSync(payload)
    } catch {
      throw new Error('zstd 解压失败')
    }
    if (sha256(plain) !== position.chainHash) throw new Error('解压后的明文哈希与清单不符')
    return plain
  }
  if (sha256(payload) !== position.chainHash) throw new Error('明文哈希与清单不符')
  return payload
}
