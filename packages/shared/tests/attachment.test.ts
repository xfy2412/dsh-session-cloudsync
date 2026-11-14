import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ATTACHMENT_HEADER_BYTES,
  ATTACHMENT_MAGIC,
  attachmentKeyOf,
  collectAttachmentRefs,
  openAttachment,
  openAttachmentIndex,
  sealAttachment,
  sealAttachmentIndex,
} from '../src/attachment.ts'
import { sessionKeyOf } from '../src/sealed-frame.ts'

const master = Buffer.alloc(32, 7)
const sessionId = 'session-attachment-unit'
const sessionKey = sessionKeyOf(master, sessionId)
const imageId = `sha256:${'a'.repeat(64)}`
const fileId = `sha256:${'b'.repeat(64)}`

test('附件密文容器可往返，且同样输入得到同样字节', () => {
  const data = Buffer.from('image-bytes')
  const first = sealAttachment({ sessionKey, sessionId, attachmentId: imageId, data })
  const second = sealAttachment({ sessionKey, sessionId, attachmentId: imageId, data })
  assert.deepEqual(first, second)
  assert.deepEqual(first.subarray(0, 4), ATTACHMENT_MAGIC)
  assert.ok(first.length > ATTACHMENT_HEADER_BYTES)
  assert.deepEqual(Buffer.from(openAttachment({ sessionKey, sessionId, attachmentId: imageId, bytes: first })), data)
})

test('附件解密拒绝错会话、错 id、坏头部与截断', () => {
  const data = Buffer.from('payload')
  const sealed = sealAttachment({ sessionKey, sessionId, attachmentId: imageId, data })
  assert.throws(() => openAttachment({ sessionKey, sessionId: 'other', attachmentId: imageId, bytes: sealed }), /解密失败/)
  assert.throws(() => openAttachment({ sessionKey, sessionId, attachmentId: fileId, bytes: sealed }), /解密失败/)
  assert.throws(() => openAttachment({ sessionKey: Buffer.alloc(32, 9), sessionId, attachmentId: imageId, bytes: sealed }), /解密失败/)

  const badMagic = Buffer.from(sealed)
  badMagic[0] = 0
  assert.throws(() => openAttachment({ sessionKey, sessionId, attachmentId: imageId, bytes: badMagic }), /DSCA/)

  const badVersion = Buffer.from(sealed)
  badVersion[4] = 9
  assert.throws(() => openAttachment({ sessionKey, sessionId, attachmentId: imageId, bytes: badVersion }), /版本/)

  assert.throws(() => openAttachment({ sessionKey, sessionId, attachmentId: imageId, bytes: sealed.subarray(0, 10) }), /截断/)
})

test('附件索引可往返，并拒绝错误的批次坐标', () => {
  const index = {
    v: 1 as const,
    sessionId,
    frameIndex: 3,
    seqFrom: 10,
    seqTo: 20,
    entries: { [imageId]: { blobSha256: 'c'.repeat(64), bytes: 42 } },
    tooLarge: [{ attachmentId: fileId, bytes: 99 * 1024 * 1024, tooLarge: true as const }],
  }
  const sealed = sealAttachmentIndex({ sessionKey, index })
  const opened = openAttachmentIndex({ sessionKey, bytes: sealed, sessionId, frameIndex: 3, seqFrom: 10, seqTo: 20 })
  assert.deepEqual(opened, index)
  assert.throws(
    () => openAttachmentIndex({ sessionKey, bytes: sealed, sessionId, frameIndex: 4, seqFrom: 10, seqTo: 20 }),
    /批次下标不匹配|解密失败/,
  )
})

test('附件引用收集覆盖全部载体并正确去重', () => {
  const image = { attachmentId: imageId, mediaType: 'image/png', bytes: 12, width: 3, height: 4 }
  const file = { attachmentId: fileId, name: 'notes.txt', bytes: 34 }
  const events = [
    { type: 'session', seq: 0, time: 1, data: {} },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: image }] } },
    { type: 'tool/ptc-dispatch', seq: 2, time: 3, data: { content: [{ type: 'file', attachment: file }] } },
    { type: 'tool/result', seq: 3, time: 4, data: { message: { content: [{ type: 'image', attachment: image }] } } },
    { type: 'agent/inbox/spliced', seq: 4, time: 5, data: { inserted: [{ content: [{ type: 'file', attachment: file }] }] } },
    { type: 'compaction/summary', seq: 5, time: 6, data: { summary: [{ type: 'file', attachment: { ...file, name: 'other.txt' } }], rawOutput: [] } },
    {
      type: 'assistant/message', seq: 6, time: 7,
      data: {
        message: { content: [{ type: 'image', attachment: image }] },
        stream: [{ type: 'chunk', chunk: { type: 'block-end', block: { type: 'file', attachment: { ...file, name: 'stream.txt' } } } }],
      },
    },
    { type: 'tool/result', seq: 7, time: 8, data: { message: { content: [{ type: 'file', attachment: file }] } } },
  ]
  const refs = collectAttachmentRefs(events)
  const images = refs.filter((ref) => ref.kind === 'image')
  const files = refs.filter((ref) => ref.kind === 'file')
  assert.equal(images.length, 1)
  assert.deepEqual(files.map((ref) => ref.kind === 'file' ? ref.name : ''), ['notes.txt', 'other.txt', 'stream.txt'])
})

test('损坏或未知形状的事件不会产生引用', () => {
  const refs = collectAttachmentRefs([
    null,
    42,
    [],
    { type: 'user/message' },
    { type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: 'bad' } }] } },
    { type: 'assistant/attempt', data: { message: { content: [{ type: 'image', attachment: { attachmentId: imageId } }] } } },
  ])
  assert.deepEqual(refs, [])
})

test('attachmentKeyOf 拒绝错误长度的会话密钥', () => {
  assert.throws(() => attachmentKeyOf(Buffer.alloc(16)), /32 字节/)
})
