import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdDecompressSync } from 'node:zlib'
import { splitFrames, splitRows } from '../packages/shared/src/frames.ts'
import { importBenchSession } from './tools/import-bench-session.ts'
import { createTempHome, repoRoot } from './helpers/tmp-home.mjs'

/**
 * 解出导入会话的全部事件。
 * @param path - session 文件路径。
 * @returns 事件列表。
 */
function readEvents(path) {
  const events = []
  for (const frame of splitFrames(readFileSync(path))) {
    for (const row of splitRows(zstdDecompressSync(frame).toString('utf8'))) events.push(JSON.parse(row))
  }
  return events
}

test('导入大会话时注入 logo 图片并写入附件对象', () => {
  const temp = createTempHome('bench-attachments')
  try {
    const trace = {
      version: 1,
      source: { formatVersion: 4, eventCount: 3, canonicalBytes: 500, compressedBytes: 120, frameCount: 1 },
      types: ['user/message', 'turn/end'],
      events: [[0, 200, 0, 0, 0, 0], [1, 100, 0, 0, 0, 0], [0, 200, 0, 0, 0, 1]],
      frames: [4],
    }
    const png = readFileSync(join(repoRoot, 'tests', 'fixtures', 'attachments', 'logo.png'))
    const result = importBenchSession({
      trace,
      home: temp.home,
      cwd: join(temp.root, 'workspace'),
      attachments: [{ name: 'logo.png', data: png }],
    })
    assert.equal(result.attachments, 1)

    const digest = createHash('sha256').update(png).digest('hex')
    assert.ok(existsSync(join(temp.home, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)))

    const events = readEvents(result.path)
    const userMessages = events.filter((event) => event.type === 'user/message')
    const withImage = userMessages.filter((event) => Array.isArray(event.data?.content)
      && event.data.content.some((block) => block?.type === 'image'))
    assert.equal(withImage.length, 1)
    assert.equal(withImage[0], userMessages.at(-1))
    const block = withImage[0].data.content.find((entry) => entry?.type === 'image')
    assert.equal(block.attachment.attachmentId, `sha256:${digest}`)
    assert.equal(block.attachment.mediaType, 'image/png')
    assert.equal(block.attachment.bytes, png.length)
    assert.equal(block.attachment.width, 256)
    assert.equal(block.attachment.height, 256)
  } finally {
    temp.dispose()
  }
})
