/**
 * DSH 会话日志的 Zstandard 帧处理。
 *
 * 会话日志是一串独立的 zstd 帧：第一帧装 header，之后每个持久化批次一帧。
 * 本项目的同步单位就是帧，所以这里所有函数都围绕"原始帧字节"工作，
 * 绝不对已提交的内容重新编码。
 *
 * @module @dsh-session-sync/shared/frames
 */
import { createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** 每个 Zstandard 帧开头的魔数（小端）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 判断缓冲区是否以 zstd 帧开头。
 * @param buffer - 待检查的字节。
 * @returns 魔数匹配时返回 true。
 */
export function isZstd(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(ZSTD_MAGIC)
}

/**
 * 返回从 offset 开始的 zstd 帧的结束位置（不含）。
 *
 * 按格式规范走帧头与块列表，而不是搜索下一个魔数：压缩载荷里可能出现那串字节。
 * @param buffer - 含该帧的字节。
 * @param offset - 帧魔数的位置。
 * @returns 帧结束（含可选校验和）后的偏移。
 * @throws 帧头、块头或校验和被截断，或出现保留值时抛出。
 */
export function zstdFrameEnd(buffer: Buffer, offset: number): number {
  if (offset + 5 > buffer.length || !buffer.subarray(offset, offset + 4).equals(ZSTD_MAGIC)) {
    throw new Error(`offset ${offset} 处不是 zstd 帧`)
  }
  const descriptor = buffer[offset + 4]!
  if ((descriptor & 8) !== 0) throw new Error('zstd 帧声明了保留位')
  const singleSegment = (descriptor & 32) !== 0
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >>> 6]!
  let cursor = offset + 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]! + contentSizeBytes
  let last = false
  while (!last) {
    if (cursor + 3 > buffer.length) throw new Error('zstd 块头被截断')
    const header = buffer.readUIntLE(cursor, 3)
    const type = (header >>> 1) & 3
    if (type === 3) throw new Error('zstd 块声明了保留类型')
    last = (header & 1) !== 0
    cursor += 3 + (type === 1 ? 1 : header >>> 3)
    if (cursor > buffer.length) throw new Error('zstd 块被截断')
  }
  if ((descriptor & 4) !== 0) cursor += 4
  if (cursor > buffer.length) throw new Error('zstd 校验和被截断')
  return cursor
}

/**
 * 把一串帧拆成原始帧缓冲区。
 * @param buffer - 完整日志或帧链。
 * @returns 按顺序排列的帧。
 * @throws 字节不是完整帧的干净拼接时抛出。
 */
export function splitFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = []
  let offset = 0
  while (offset < buffer.length) {
    const end = zstdFrameEnd(buffer, offset)
    frames.push(buffer.subarray(offset, end))
    offset = end
  }
  return frames
}

/**
 * 解压原始帧。
 * @param frames - {@link splitFrames} 或 {@link encodeLog} 产生的帧。
 * @returns 每帧一份解压后的字节。
 * @throws 帧损坏时抛出。
 */
export function decodeFrames(frames: readonly Buffer[]): Buffer[] {
  return frames.map((frame) => zstdDecompressSync(frame))
}

/**
 * 解压完整日志。
 * @param buffer - 串联的帧，或明文 JSONL。
 * @returns 拼接后的文本；明文原样返回。
 * @throws 帧损坏时抛出。
 */
export function decodeLog(buffer: Buffer): string {
  if (!isZstd(buffer)) return buffer.toString('utf8')
  return Buffer.concat(decodeFrames(splitFrames(buffer))).toString('utf8')
}

/**
 * 把 JSONL 文本拆成非空行。
 * @param text - 日志文本。
 * @returns 按顺序的、已去空白判断的空行被剔除的行。
 */
export function splitRows(text: string): string[] {
  return text.split('\n').filter((row) => row.trim() !== '')
}

/**
 * 把 JSONL 文本编码成帧，模拟 DSH 的持久化形状。
 *
 * 前 `headerLines` 行装在同一个帧里（DSH 首次发布时 header 与首批同帧），
 * 其余行按 `rowsPerFrame` 分批。
 * @param text - 日志文本。
 * @param options - header 行数与每帧行数；默认值面向小型夹具。
 * @returns 帧链。
 */
export function encodeLog(text: string, options: { headerLines?: number; rowsPerFrame?: number } = {}): Buffer[] {
  const headerLines = options.headerLines ?? 1
  const rowsPerFrame = options.rowsPerFrame ?? 1
  const rows = splitRows(text)
  if (rows.length === 0) return []
  const head = rows.slice(0, headerLines)
  const frames = [zstdCompressSync(Buffer.from(`${head.join('\n')}\n`, 'utf8'))]
  let index = headerLines
  while (index < rows.length) {
    const chunk = rows.slice(index, index + rowsPerFrame)
    frames.push(zstdCompressSync(Buffer.from(`${chunk.join('\n')}\n`, 'utf8')))
    index += rowsPerFrame
  }
  return frames
}

/**
 * 把帧链拼成一个缓冲区。
 * @param frames - 帧链。
 * @returns DSH 后端会当成一份日志读取的缓冲区。
 */
export function joinFrames(frames: readonly Buffer[]): Buffer {
  return Buffer.concat(frames)
}

/**
 * 一帧的内容地址。
 * @param frame - 原始帧字节。
 * @returns 小写十六进制 SHA-256。
 */
export function hashFrame(frame: Buffer): string {
  return createHash('sha256').update(frame).digest('hex')
}

/**
 * 只解第一帧读取 header，不碰后面的帧。
 * @param buffer - 串联的帧。
 * @returns 解析后的 header 对象。
 * @throws 第一帧不是 JSON 对象时抛出。
 */
export function readHeader(buffer: Buffer): Record<string, unknown> {
  const text = isZstd(buffer)
    ? Buffer.concat(decodeFrames([splitFrames(buffer)[0]!])).toString('utf8')
    : buffer.toString('utf8')
  const first = splitRows(text)[0]
  if (first === undefined) throw new Error('会话日志为空')
  const parsed: unknown = JSON.parse(first)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('会话日志 header 不是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}
