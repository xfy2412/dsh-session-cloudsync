import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SESSION_FORMAT_VERSION, Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { assertContiguous, sessionFormatVersionRefusal, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { splitRows } from '../src/frames.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'tests', 'fixtures', 'sessions')

/**
 * 把一个夹具解析成逻辑 header + 事件数组。
 * @param name - 夹具文件名。
 * @returns header、格式代际与事件。
 */
function parseFixture(name: string): { header: SessionHeader; version: number; events: SessionEvent[] } {
  const rows = splitRows(readFileSync(join(fixtures, name), 'utf8'))
  const header = JSON.parse(rows[0]!) as SessionHeader & { type?: string }
  const version = header.version
  // 存储层的 header 行带 type，逻辑 header 不带。
  delete header.type
  const events = rows.slice(1).map((row) => JSON.parse(row) as SessionEvent)
  return { header, version, events }
}

const VALID_FIXTURES = ['v4-minimal.jsonl', 'v4-with-plugin-record.jsonl', 'v4-coverage.jsonl'] as const

test('仓库夹具通过官方校验器（准入 + 序号 + 关系重放）', async (t) => {
  for (const name of VALID_FIXTURES) {
    await t.test(name, () => {
      const { header, version, events } = parseFixture(name)
      assert.equal(version, SESSION_FORMAT_VERSION, '夹具代际必须等于当前格式版本')
      validateStoredEvents(header, structuredClone(events))
      assertContiguous(header.id, structuredClone(events), 0)
      Session.fromRestore(header.id, structuredClone(events), header, SessionLogOffset(0), 'detached')
    })
  }
})

test('更高代际的夹具被版本闸门拒收', () => {
  const { header, version } = parseFixture('v5-newer.jsonl')
  assert.ok(version > SESSION_FORMAT_VERSION, '夹具必须比当前版本更新')
  const refusal = sessionFormatVersionRefusal(header.id, version)
  assert.match(refusal, /newer harness/)
})
