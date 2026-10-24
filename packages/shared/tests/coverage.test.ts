import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decodeLog, splitRows } from '../src/frames.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'tests', 'fixtures')
const coverageText = readFileSync(join(fixtures, 'sessions', 'v4-coverage.jsonl'), 'utf8')
const manifest = JSON.parse(readFileSync(join(fixtures, 'shapes', 'recorded-coverage.json'), 'utf8')) as {
  events: number
  eventTypes: Array<{ type: string; count: number }>
  tools: Array<{ name: string; calls: number; argKeys: string[] }>
}

const rows = splitRows(coverageText).map((row) => JSON.parse(row) as Record<string, unknown>)
const noHeader = rows.filter((event) => event['type'] !== 'session')

test('覆盖夹具把清单里的每种事件都覆盖到了', () => {
  const present = new Set(rows.map((event) => String(event['type'])))
  for (const { type } of manifest.eventTypes) {
    assert.ok(present.has(type), `缺少事件类型：${type}`)
  }
  assert.equal(present.size, manifest.eventTypes.length)
})

test('除 session 头外，每种事件的条数与录制一致', () => {
  const counts = new Map<string, number>()
  for (const event of rows) {
    const type = String(event['type'])
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  for (const { type, count } of manifest.eventTypes) {
    // 多份录制拼成一份形状样本，只会合并 session 头。
    const expected = type === 'session' ? 1 : count
    assert.equal(counts.get(type), expected, `事件类型 ${type} 的条数不一致`)
  }
})

test('每种工具都有调用，参数键与录制一致，且都有结果', () => {
  const calls = new Map<string, Array<string[]>>()
  const callIds = new Set<string>()
  for (const event of rows) {
    if (event['type'] !== 'tool/call') continue
    const data = event['data'] as Record<string, unknown>
    const name = String(data['name'])
    let keys: string[] = []
    try {
      keys = Object.keys(JSON.parse(String(data['arguments'] ?? '{}')) as Record<string, unknown>).sort()
    } catch {
      keys = []
    }
    const list = calls.get(name) ?? []
    list.push(keys)
    calls.set(name, list)
    callIds.add(String(data['callId']))
  }

  const answered = new Set<string>()
  for (const event of rows) {
    if (event['type'] !== 'tool/result') continue
    const data = event['data'] as Record<string, unknown>
    const message = data['message'] as Record<string, unknown> | undefined
    answered.add(String(message?.['toolCallId'] ?? ''))
  }

  for (const tool of manifest.tools) {
    const shapes = calls.get(tool.name)
    assert.ok(shapes !== undefined, `缺少工具调用：${tool.name}`)
    assert.equal(shapes.length, tool.calls, `工具 ${tool.name} 的调用次数不一致`)
    // 清单记录的是所有调用的参数键并集；单次调用只可能带其中一部分。
    const union = new Set<string>()
    for (const keys of shapes) {
      for (const key of keys) {
        assert.ok(tool.argKeys.includes(key), `工具 ${tool.name} 出现了清单外的参数键：${key}`)
        union.add(key)
      }
    }
    assert.deepEqual([...union].sort(), [...tool.argKeys].sort(), `工具 ${tool.name} 的参数键并集不一致`)
  }
  for (const id of callIds) assert.ok(answered.has(id), `调用 ${id} 没有对应的结果`)
})

test('结果里出现过 text / reasoning / tool-call / image 四种内容块', () => {
  const kinds = new Set<string>()
  for (const event of rows) {
    if (event['type'] !== 'assistant/message' && event['type'] !== 'tool/result') continue
    const data = event['data'] as Record<string, unknown>
    const message = data['message'] as Record<string, unknown> | undefined
    const content = message?.['content']
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block !== null && typeof block === 'object') kinds.add(String((block as Record<string, unknown>)['type']))
    }
  }
  for (const kind of ['text', 'reasoning', 'tool-call', 'image']) assert.ok(kinds.has(kind), `缺少内容块类型：${kind}`)
})

test('失败工具结果的错误对象是 { code, name }', () => {
  const errors = rows
    .filter((event) => event['type'] === 'tool/result')
    .map((event) => (event['data'] as Record<string, unknown>)['error'])
    .filter((error): error is Record<string, unknown> => error !== null && typeof error === 'object')
  assert.ok(errors.length > 0, '录制里至少有一条失败结果')
  for (const error of errors) {
    assert.equal(typeof error['code'], 'string')
    assert.equal(typeof error['name'], 'string')
  }
})

test('事件序号从 0 连续，且序号唯一的头事件在最前', () => {
  assert.equal(rows[0]?.['type'], 'session')
  noHeader.forEach((event, index) => {
    assert.equal(event['seq'], index, `第 ${index} 条事件的 seq 不连续`)
  })
})

test('覆盖夹具不含真实内容：纯 ASCII、无盘符路径、无 URL', () => {
  // cwd 必须是绝对路径，生成器固定用跨平台的 `/fixture/workspace` 占位值；其余盘符路径一律不允许。
  const cleaned = coverageText.split('/fixture/workspace').join('')
  assert.ok(!/[^\x00-\x7f]/u.test(cleaned), '出现非 ASCII 字符')
  assert.ok(!/[A-Za-z]:[\\/]/u.test(cleaned), '出现盘符路径')
  assert.ok(!/https?:\/\//iu.test(cleaned), '出现 URL')
})

test('覆盖夹具的 zstd 版本能解回同样的行', () => {
  const compressed = readFileSync(join(fixtures, 'sessions', 'v4-coverage.jsonl.zstd'))
  assert.deepEqual(splitRows(decodeLog(compressed)), splitRows(coverageText))
})
