/**
 * 附件密文容器与批次附件索引。
 *
 * 会话事件本身只带 `attachmentId`（明文内容哈希）与媒体元数据；附件正文
 * 由这里单独加密成 blob。加密是**确定性**的：每个附件用由 `attachmentId`
 * 派生的子密钥 + 固定 nonce，因此同一附件重推得到同一密文、同一 blob 地址，
 * 重试与去重都安全。安全前提是 `attachmentId` 必须是明文内容的哈希；同一 id
 * 配不同内容会复用 key + nonce，禁止这样使用。
 *
 * 容器布局（8 字节固定头 + 密文 + tag）：
 *
 * ```text
 * 0  4  magic "DSCA"
 * 4  1  version（1）
 * 5  1  flags（0）
 * 6  2  reserved（0）
 * 8  N  密文
 * N  16 GCM tag
 * ```
 *
 * 索引同样用容器封装：明文是 `AttachmentIndex` JSON，AAD 绑定会话与批次坐标，
 * 防止把一个批次的索引挪到另一个批次。
 *
 * @module @dsh-session-cloudsync/shared/attachment
 */
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { stableStringify } from './chain.ts'
import { deriveSubkey, KEY_BYTES, NONCE_BYTES, TAG_BYTES } from './crypto.ts'

/** 附件容器魔数。 */
export const ATTACHMENT_MAGIC = Buffer.from('DSCA', 'ascii')

/** 附件容器版本。 */
export const ATTACHMENT_VERSION = 1

/** 容器固定头长度：magic + version + flags + reserved。 */
export const ATTACHMENT_HEADER_BYTES = 8

/** 每条附件密文相对明文的固定开销（头 + tag）。 */
export const ATTACHMENT_OVERHEAD_BYTES = ATTACHMENT_HEADER_BYTES + TAG_BYTES

/** 固定 nonce：每条附件派生出独立密钥，nonce 无需变化。 */
const FIXED_NONCE = Buffer.alloc(NONCE_BYTES)

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const ATTACHMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u

/**
 * 由会话密钥派生附件子密钥。
 * @param sessionKey - 会话密钥（{@link sessionKeyOf}）。
 * @returns 32 字节附件密钥。
 */
export function attachmentKeyOf(sessionKey: Buffer): Buffer {
  if (sessionKey.length !== KEY_BYTES) throw new Error(`会话密钥必须是 ${KEY_BYTES} 字节`)
  return deriveSubkey(sessionKey, 'dsh-sync/attachment/v1')
}

/**
 * 派生一条附件密文的密钥。
 * @param attachmentKey - 附件子密钥。
 * @param attachmentId - 明文内容哈希。
 * @returns 32 字节记录密钥。
 */
function attachmentRecordKeyOf(attachmentKey: Buffer, attachmentId: string): Buffer {
  return deriveSubkey(attachmentKey, `v1|attachment:${attachmentId}`)
}

/**
 * 派生索引密文的密钥。
 * @param attachmentKey - 附件子密钥。
 * @returns 32 字节索引密钥。
 */
function attachmentIndexKeyOf(attachmentKey: Buffer): Buffer {
  return deriveSubkey(attachmentKey, 'v1|index')
}

/**
 * 把一段明文封进 DSCA 容器。
 * @param key - 32 字节密钥。
 * @param aad - 关联数据。
 * @param plain - 明文。
 * @returns 容器字节。
 */
function sealContainer(key: Buffer, aad: Buffer, plain: Uint8Array): Buffer {
  const header = Buffer.alloc(ATTACHMENT_HEADER_BYTES)
  ATTACHMENT_MAGIC.copy(header, 0)
  header.writeUInt8(ATTACHMENT_VERSION, 4)
  header.writeUInt8(0, 5)
  header.writeUInt16BE(0, 6)
  const cipher = createCipheriv('aes-256-gcm', key, FIXED_NONCE)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()])
  return Buffer.concat([header, body, cipher.getAuthTag()])
}

/**
 * 解开 DSCA 容器。
 * @param key - 32 字节密钥。
 * @param aad - 关联数据。
 * @param sealed - 容器字节。
 * @returns 明文。
 * @throws 容器头、密钥或 AAD 不匹配时抛出。
 */
function openContainer(key: Buffer, aad: Buffer, sealed: Uint8Array): Uint8Array {
  const bytes = Buffer.from(sealed)
  if (bytes.length < ATTACHMENT_OVERHEAD_BYTES) throw new Error('附件密文被截断')
  if (!bytes.subarray(0, 4).equals(ATTACHMENT_MAGIC)) throw new Error('不是 DSCA 附件密文')
  if (bytes.readUInt8(4) !== ATTACHMENT_VERSION) throw new Error(`不支持的附件容器版本：${bytes.readUInt8(4)}`)
  if (bytes.readUInt8(5) !== 0) throw new Error('附件容器 flags 非零')
  if (bytes.readUInt16BE(6) !== 0) throw new Error('附件容器 reserved 非零')
  const body = bytes.subarray(ATTACHMENT_HEADER_BYTES, bytes.length - TAG_BYTES)
  const tag = bytes.subarray(bytes.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, FIXED_NONCE)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  try {
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]))
  } catch {
    throw new Error('附件解密失败（密文、AAD 或密钥不匹配）')
  }
}

/** 一条附件密文：内容哈希、地址与密文字节数。 */
export interface AttachmentEntry {
  /** 密文 blob 的 sha256。 */
  readonly blobSha256: string
  /** 密文字节数。 */
  readonly bytes: number
}

/** 无法同步的附件（超过服务端单 blob 上限），保留原因供另一端提示。 */
export interface OversizedAttachmentEntry {
  /** 明文内容哈希。 */
  readonly attachmentId: string
  /** 明文字节数。 */
  readonly bytes: number
  readonly tooLarge: true
}

/** 一个批次的附件索引。 */
export interface AttachmentIndex {
  readonly v: 1
  readonly sessionId: string
  readonly frameIndex: number
  readonly seqFrom: number
  readonly seqTo: number
  /** `attachmentId` → 密文地址；不超过单 blob 上限的附件。 */
  readonly entries: Readonly<Record<string, AttachmentEntry>>
  /** 超过单 blob 上限、没有上传的附件。 */
  readonly tooLarge?: readonly OversizedAttachmentEntry[]
}

/** 封一条附件正文。 */
export interface SealAttachmentInput {
  readonly sessionKey: Buffer
  readonly sessionId: string
  readonly attachmentId: string
  readonly data: Uint8Array
}

/** 解一条附件正文。 */
export interface OpenAttachmentInput {
  readonly sessionKey: Buffer
  readonly sessionId: string
  readonly attachmentId: string
  readonly bytes: Uint8Array
}

/** 附件容器 AAD：会话 + 内容哈希 + 明文字节数。 */
function attachmentAad(sessionId: string, attachmentId: string, plainBytes: number): Buffer {
  return Buffer.from(stableStringify({ v: 1, sessionId, attachmentId, bytes: plainBytes }), 'utf8')
}

/** 索引 AAD：会话 + 批次坐标。 */
function indexAad(sessionId: string, frameIndex: number, seqFrom: number, seqTo: number): Buffer {
  return Buffer.from(stableStringify({ v: 1, sessionId, frameIndex, seqFrom, seqTo }), 'utf8')
}

/**
 * 封一条附件正文。
 * @param input - 会话密钥、会话 id、内容哈希与明文。
 * @returns 密文字节（含头与 tag）。
 */
export function sealAttachment(input: SealAttachmentInput): Buffer {
  if (!ATTACHMENT_ID_PATTERN.test(input.attachmentId)) throw new Error('attachmentId 必须是 sha256:<64 位十六进制>')
  const key = attachmentRecordKeyOf(attachmentKeyOf(input.sessionKey), input.attachmentId)
  return sealContainer(key, attachmentAad(input.sessionId, input.attachmentId, input.data.length), input.data)
}

/**
 * 解一条附件正文。
 * @param input - 会话密钥、会话 id、内容哈希与密文。
 * @returns 明文字节。
 * @throws 容器、AAD 或密钥不匹配时抛出。
 */
export function openAttachment(input: OpenAttachmentInput): Uint8Array {
  if (!ATTACHMENT_ID_PATTERN.test(input.attachmentId)) throw new Error('attachmentId 必须是 sha256:<64 位十六进制>')
  const key = attachmentRecordKeyOf(attachmentKeyOf(input.sessionKey), input.attachmentId)
  return openContainer(key, attachmentAad(input.sessionId, input.attachmentId, expectedPlainBytes(input.bytes)), input.bytes)
}

/**
 * 由密文字节数反推明文字节数（容器开销固定）。
 * @param sealedBytes - 密文字节数。
 * @returns 明文字节数。
 */
function expectedPlainBytes(sealedBytes: Uint8Array): number {
  if (sealedBytes.length < ATTACHMENT_OVERHEAD_BYTES) throw new Error('附件密文被截断')
  return sealedBytes.length - ATTACHMENT_OVERHEAD_BYTES
}

/** 封一个批次索引。 */
export interface SealAttachmentIndexInput {
  readonly sessionKey: Buffer
  readonly index: AttachmentIndex
}

/**
 * 封一个批次的附件索引。
 * @param input - 会话密钥与索引内容。
 * @returns 索引密文（含头与 tag）。
 */
export function sealAttachmentIndex(input: SealAttachmentIndexInput): Buffer {
  const index = input.index
  const key = attachmentIndexKeyOf(attachmentKeyOf(input.sessionKey))
  const aad = indexAad(index.sessionId, index.frameIndex, index.seqFrom, index.seqTo)
  return sealContainer(key, aad, Buffer.from(stableStringify(index), 'utf8'))
}

/** 解索引时的批次坐标；不匹配视为数据错位。 */
export interface OpenAttachmentIndexInput {
  readonly sessionKey: Buffer
  readonly bytes: Uint8Array
  readonly sessionId: string
  readonly frameIndex: number
  readonly seqFrom: number
  readonly seqTo: number
}

/**
 * 解一个批次的附件索引，并校验批次坐标。
 * @param input - 会话密钥、密文与期望坐标。
 * @returns 索引内容。
 * @throws 容器、AAD、坐标或形状不合法时抛出。
 */
export function openAttachmentIndex(input: OpenAttachmentIndexInput): AttachmentIndex {
  const key = attachmentIndexKeyOf(attachmentKeyOf(input.sessionKey))
  const aad = indexAad(input.sessionId, input.frameIndex, input.seqFrom, input.seqTo)
  const plain = openContainer(key, aad, input.bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(plain).toString('utf8'))
  } catch {
    throw new Error('附件索引不是合法 JSON')
  }
  return validateAttachmentIndex(parsed, input)
}

/**
 * 校验索引形状与批次坐标。
 * @param value - 解析后的值。
 * @param expect - 期望坐标。
 * @returns 索引。
 * @throws 形状不合法时抛出。
 */
function validateAttachmentIndex(value: unknown, expect: Omit<OpenAttachmentIndexInput, 'sessionKey' | 'bytes'>): AttachmentIndex {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('附件索引不是对象')
  const record = value as Record<string, unknown>
  if (record['v'] !== 1) throw new Error('附件索引版本非法')
  if (record['sessionId'] !== expect.sessionId) throw new Error('附件索引的会话 id 不匹配')
  if (record['frameIndex'] !== expect.frameIndex) throw new Error('附件索引的批次下标不匹配')
  if (record['seqFrom'] !== expect.seqFrom || record['seqTo'] !== expect.seqTo) throw new Error('附件索引的批次 seq 不匹配')
  const entriesRaw = record['entries']
  if (entriesRaw === null || typeof entriesRaw !== 'object' || Array.isArray(entriesRaw)) throw new Error('附件索引 entries 非法')
  const entries: Record<string, AttachmentEntry> = {}
  for (const [attachmentId, entryRaw] of Object.entries(entriesRaw as Record<string, unknown>)) {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) throw new Error(`附件索引里的 attachmentId 非法：${attachmentId}`)
    if (entryRaw === null || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) throw new Error(`附件条目非法：${attachmentId}`)
    const entry = entryRaw as Record<string, unknown>
    if (typeof entry['blobSha256'] !== 'string' || !HASH_PATTERN.test(entry['blobSha256'])) throw new Error(`附件 blob 地址非法：${attachmentId}`)
    if (!Number.isSafeInteger(entry['bytes']) || Number(entry['bytes']) <= 0) throw new Error(`附件密文字节数非法：${attachmentId}`)
    entries[attachmentId] = { blobSha256: entry['blobSha256'], bytes: Number(entry['bytes']) }
  }
  const tooLargeRaw = record['tooLarge']
  const tooLarge: OversizedAttachmentEntry[] = []
  if (tooLargeRaw !== undefined) {
    if (!Array.isArray(tooLargeRaw)) throw new Error('附件索引 tooLarge 非法')
    for (const item of tooLargeRaw) {
      if (item === null || typeof item !== 'object') throw new Error('附件索引 tooLarge 条目非法')
      const entry = item as Record<string, unknown>
      if (typeof entry['attachmentId'] !== 'string' || !ATTACHMENT_ID_PATTERN.test(entry['attachmentId'])) throw new Error('tooLarge 的 attachmentId 非法')
      if (!Number.isSafeInteger(entry['bytes']) || Number(entry['bytes']) <= 0) throw new Error('tooLarge 的字节数非法')
      tooLarge.push({ attachmentId: entry['attachmentId'], bytes: Number(entry['bytes']), tooLarge: true })
    }
  }
  return {
    v: 1,
    sessionId: expect.sessionId,
    frameIndex: expect.frameIndex,
    seqFrom: expect.seqFrom,
    seqTo: expect.seqTo,
    entries,
    ...tooLarge.length === 0 ? {} : { tooLarge },
  }
}

/** 会话事件里引用的一种附件。 */
export type AttachmentRef =
  | {
    readonly kind: 'image'
    readonly attachmentId: string
    readonly mediaType: string
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }
  | {
    readonly kind: 'file'
    readonly attachmentId: string
    readonly name: string
    readonly bytes: number
  }

/**
 * 收集一段事件里引用的附件。
 *
 * 载体与 DSH 自己的导出实现一致：`user/message`、`tool/ptc-dispatch` 的
 * `content`；`system/developer/tool/result/team` 消息的 `message.content`；
 * `agent/inbox/spliced` 的 `inserted[].content`；`compaction/summary` 的
 * `summary` 与 `rawOutput`；`assistant/message` 的 `message.content` 与
 * `stream` 中 `block-end` 的 `block`。图片按 id 去重，文件按 `(id, name)` 去重。
 * @param events - 解析后的会话事件（未知形状一律跳过）。
 * @returns 去重后的附件引用，保持首次出现顺序。
 */
export function collectAttachmentRefs(events: readonly unknown[]): AttachmentRef[] {
  const images = new Map<string, AttachmentRef>()
  const files = new Map<string, AttachmentRef>()
  for (const event of events) collectEventRefs(event, images, files)
  return [...images.values(), ...files.values()]
}

/**
 * 收集单个事件里的附件引用。
 * @param event - 一个事件对象。
 * @param images - 图片去重表。
 * @param files - 文件去重表。
 */
function collectEventRefs(
  event: unknown,
  images: Map<string, AttachmentRef>,
  files: Map<string, AttachmentRef>,
): void {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return
  const row = event as { readonly type?: unknown; readonly data?: unknown }
  if (typeof row.type !== 'string') return
  const data = row.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return
  const carrier = data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: unknown
    readonly summary?: unknown
    readonly rawOutput?: unknown
    readonly stream?: unknown
  }
  switch (row.type) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      collectBlocks(carrier.content, images, files)
      return
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued':
      collectBlocks(carrier.message?.content, images, files)
      return
    case 'agent/inbox/spliced': {
      if (!Array.isArray(carrier.inserted)) return
      for (const message of carrier.inserted) {
        if (message === null || typeof message !== 'object') continue
        collectBlocks((message as { readonly content?: unknown }).content, images, files)
      }
      return
    }
    case 'compaction/summary':
      collectBlocks(carrier.summary, images, files)
      collectBlocks(carrier.rawOutput, images, files)
      return
    case 'assistant/message': {
      collectBlocks(carrier.message?.content, images, files)
      if (!Array.isArray(carrier.stream)) return
      for (const record of carrier.stream) {
        if (record === null || typeof record !== 'object') continue
        const chunk = record as { readonly type?: unknown; readonly chunk?: { readonly type?: unknown; readonly block?: unknown } }
        if (chunk.type === 'chunk' && chunk.chunk?.type === 'block-end') collectBlocks([chunk.chunk.block], images, files)
      }
      return
    }
    default:
      return
  }
}

/**
 * 从一个 content 数组收集附件块。
 * @param content - 事件或消息的 content。
 * @param images - 图片去重表。
 * @param files - 文件去重表。
 */
function collectBlocks(content: unknown, images: Map<string, AttachmentRef>, files: Map<string, AttachmentRef>): void {
  if (!Array.isArray(content)) return
  for (const value of content) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown }
    const attachment = block.attachment
    if (attachment === null || typeof attachment !== 'object') continue
    if (block.type === 'image') {
      const ref = imageRef(attachment)
      if (ref !== undefined && !images.has(ref.attachmentId)) images.set(ref.attachmentId, ref)
    } else if (block.type === 'file') {
      const ref = fileRef(attachment)
      if (ref !== undefined) {
        const key = `${ref.attachmentId}\u0000${ref.name}`
        if (!files.has(key)) files.set(key, ref)
      }
    }
  }
}

/**
 * 校验并收窄一个图片引用。
 * @param value - 原始引用对象。
 * @returns 合法引用，或 undefined。
 */
function imageRef(value: object): AttachmentRef | undefined {
  const record = value as Record<string, unknown>
  const attachmentId = record['attachmentId']
  if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_PATTERN.test(attachmentId)) return undefined
  if (typeof record['mediaType'] !== 'string' || typeof record['bytes'] !== 'number') return undefined
  if (typeof record['width'] !== 'number' || typeof record['height'] !== 'number') return undefined
  return {
    kind: 'image',
    attachmentId,
    mediaType: record['mediaType'],
    bytes: record['bytes'],
    width: record['width'],
    height: record['height'],
    ...typeof record['name'] === 'string' && record['name'] !== '' ? { name: record['name'] } : {},
  }
}

/**
 * 校验并收窄一个文件引用。
 * @param value - 原始引用对象。
 * @returns 合法引用，或 undefined。
 */
function fileRef(value: object): AttachmentRef | undefined {
  const record = value as Record<string, unknown>
  const attachmentId = record['attachmentId']
  if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_PATTERN.test(attachmentId)) return undefined
  if (typeof record['name'] !== 'string' || record['name'] === '' || typeof record['bytes'] !== 'number') return undefined
  return { kind: 'file', attachmentId, name: record['name'], bytes: record['bytes'] }
}
