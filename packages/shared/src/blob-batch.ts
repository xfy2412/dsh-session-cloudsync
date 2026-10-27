/**
 * v2 批量 blob 的二进制编解码。
 *
 * 一次请求携带多个密文 blob，格式固定、无 JSON/base64 膨胀：
 *
 * ```text
 * "DSHB" | version(1) | flags(1) | reserved(2) | count(u32 BE)
 * count × [ kind(1) | reserved(3) | bytes(u32 BE) | sha256(32) | data ]
 * ```
 *
 * 服务端只存密文，不理解 blob 内容；上传条目的 sha256 是客户端声明的
 * 期望值，下载条目的是服务端实际内容地址。
 *
 * @module @dsh-session-cloudsync/shared/blob-batch
 */
import { sha256 } from './crypto.ts'

/** 批量传输的 Content-Type。 */
export const BLOB_BATCH_CONTENT_TYPE = 'application/x-dsh-blob-batch'

/** 固定头长度。 */
export const BLOB_BATCH_HEADER_BYTES = 12

/** 每个条目的固定头长度。 */
export const BLOB_BATCH_ENTRY_HEADER_BYTES = 40

/** 单批 blob 上限。 */
export const MAX_BATCH_BLOBS = 64

/** 单批请求体上限（8 MiB）。 */
export const MAX_BATCH_BODY_BYTES = 8 * 1024 * 1024

/** 单个 blob 的绝对上限；批量请求本身仍受 {@link MAX_BATCH_BODY_BYTES} 限制。 */
export const MAX_BLOB_BYTES = 32 * 1024 * 1024

/** blob 类别。 */
export type BlobKind = 'frame' | 'attachment' | 'vault'

const MAGIC = Buffer.from('DSHB', 'ascii')
const VERSION = 1

const KIND_TO_CODE: Record<BlobKind, number> = {
  frame: 1,
  attachment: 2,
  vault: 3,
}

const CODE_TO_KIND: Record<number, BlobKind> = {
  1: 'frame',
  2: 'attachment',
  3: 'vault',
}

/** 一个批量条目。 */
export interface BlobBatchEntry {
  readonly kind: BlobKind
  readonly sha256: string
  readonly data: Buffer
}

/**
 * 把多个 blob 编码成一个批量请求体。
 * @param entries - 类别与原始密文字节。
 * @returns 二进制请求体。
 * @throws 数量、总字节或单个 blob 超过上限时抛出。
 */
export function encodeBlobBatch(entries: readonly { readonly kind: BlobKind; readonly data: Buffer }[]): Buffer {
  if (entries.length < 1 || entries.length > MAX_BATCH_BLOBS) {
    throw new Error(`批量 blob 条数必须在 1–${MAX_BATCH_BLOBS} 之间`)
  }
  let total = BLOB_BATCH_HEADER_BYTES
  for (const entry of entries) {
    if (entry.data.length === 0) throw new Error('批量 blob 不能包含空内容')
    if (entry.data.length > MAX_BLOB_BYTES) throw new Error(`单个 blob 超过上限 ${MAX_BLOB_BYTES} 字节`)
    total += BLOB_BATCH_ENTRY_HEADER_BYTES + entry.data.length
  }
  if (total > MAX_BATCH_BODY_BYTES) throw new Error(`批量 blob 超过上限 ${MAX_BATCH_BODY_BYTES} 字节`)

  const output = Buffer.allocUnsafe(total)
  MAGIC.copy(output, 0)
  output.writeUInt8(VERSION, 4)
  output.writeUInt8(0, 5)
  output.writeUInt16BE(0, 6)
  output.writeUInt32BE(entries.length, 8)
  let offset = BLOB_BATCH_HEADER_BYTES
  for (const entry of entries) {
    const digest = sha256(entry.data)
    output.writeUInt8(KIND_TO_CODE[entry.kind], offset)
    output.fill(0, offset + 1, offset + 4)
    output.writeUInt32BE(entry.data.length, offset + 4)
    Buffer.from(digest, 'hex').copy(output, offset + 8)
    entry.data.copy(output, offset + BLOB_BATCH_ENTRY_HEADER_BYTES)
    offset += BLOB_BATCH_ENTRY_HEADER_BYTES + entry.data.length
  }
  return output
}

/**
 * 解码批量 blob 请求/响应。
 * @param bytes - 完整二进制体。
 * @returns 条目（按原顺序）。
 * @throws magic/版本/flags/count/长度/尾部多余字节非法时抛出。
 */
export function decodeBlobBatch(bytes: Buffer): BlobBatchEntry[] {
  if (bytes.length < BLOB_BATCH_HEADER_BYTES) throw new Error('批量 blob 头被截断')
  if (!bytes.subarray(0, 4).equals(MAGIC)) throw new Error('不是 DSHB 批量 blob')
  if (bytes.readUInt8(4) !== VERSION) throw new Error(`不支持的批量 blob 版本：${bytes.readUInt8(4)}`)
  if (bytes.readUInt8(5) !== 0) throw new Error('批量 blob flags 非零')
  if (bytes.readUInt16BE(6) !== 0) throw new Error('批量 blob reserved 非零')
  const count = bytes.readUInt32BE(8)
  if (count < 1 || count > MAX_BATCH_BLOBS) throw new Error(`批量 blob 条数非法：${count}`)

  const entries: BlobBatchEntry[] = []
  let offset = BLOB_BATCH_HEADER_BYTES
  for (let index = 0; index < count; index += 1) {
    if (offset + BLOB_BATCH_ENTRY_HEADER_BYTES > bytes.length) throw new Error(`批量 blob 第 ${index} 条头被截断`)
    const kind = CODE_TO_KIND[bytes.readUInt8(offset)]
    if (kind === undefined) throw new Error(`批量 blob 第 ${index} 条类别非法`)
    if (bytes.readUInt8(offset + 1) !== 0 || bytes.readUInt8(offset + 2) !== 0 || bytes.readUInt8(offset + 3) !== 0) {
      throw new Error(`批量 blob 第 ${index} 条 reserved 非零`)
    }
    const length = bytes.readUInt32BE(offset + 4)
    if (length === 0) throw new Error(`批量 blob 第 ${index} 条为空`)
    if (length > MAX_BLOB_BYTES) throw new Error(`批量 blob 第 ${index} 条超过单 blob 上限`)
    const start = offset + BLOB_BATCH_ENTRY_HEADER_BYTES
    const end = start + length
    if (end > bytes.length) throw new Error(`批量 blob 第 ${index} 条数据被截断`)
    entries.push({
      kind,
      sha256: bytes.subarray(offset + 8, offset + 8 + 32).toString('hex'),
      data: bytes.subarray(start, end),
    })
    offset = end
  }
  if (offset !== bytes.length) throw new Error('批量 blob 尾部有多余字节')
  if (bytes.length > MAX_BATCH_BODY_BYTES) throw new Error(`批量 blob 超过上限 ${MAX_BATCH_BODY_BYTES} 字节`)
  return entries
}
