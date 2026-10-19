// 从真实录制派生"合成覆盖夹具"：保留事件结构、工具名、参数键、结果形态，
// 把所有自由文本 / 路径 / URL / 命令替换成占位符。
//
// 产物：tests/fixtures/sessions/v4-coverage.jsonl
//
// 用法（输入是隔离开发实例录制的日志，永不入库）：
//   node tests/tools/make-coverage-fixture.ts <日志…>
//
// 安全保证：生成后断言产物是纯 ASCII，且不含盘符路径或 URL —— 任何漏网的中文
// 内容、绝对路径、链接都会让脚本失败，而不是悄悄写进仓库。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeLog, splitRows } from '../../packages/shared/src/frames.ts'

const TEXT = '<text>'
const ARG = '<arg>'
/** cwd 必须是绝对路径；用固定占位路径，并在泄漏断言里单独放行。 */
const FIXTURE_CWD = 'C:/fixture/workspace'

/** 这些键的值是枚举/标识/关系坐标，必须保留才能保持结构。 */
const KEEP_KEYS = new Set([
  'type', 'role', 'kind', 'status', 'mode', 'reason', 'op', 'action', 'preset', 'policy',
  'provider', 'model', 'form', 'onFire', 'version', 'seq', 'time', 'turn', 'step', 'surfaceOp',
  'sourceEventSeqs', 'ignorable', 'callId', 'toolCallId', 'id', 'sessionId', 'parentSession',
  'agentPreset', 'goal_id', 'agent_id', 'job_id', 'revision', 'sessionFormatVersion', 'throughSeq',
  'origin', 'delegationDepth', 'isSeeded', 'createdAt', 'created', 'index', 'ordinal', 'scope',
])

/** 自由文本键：显式替换（即使不在 KEEP 里也走替换，避免"猜漏"）。 */
const TEXT_KEYS = new Set([
  'text', 'command', 'file_path', 'url', 'prompt', 'note', 'objective', 'title', 'description',
  'script', 'plan', 'queries', 'pattern', 'cd', 'old_string', 'new_string', 'label', 'content',
  'message', 'cwd', 'dshHome', 'sessionIds', 'todos', 'questions', 'files', 'tools', 'header',
])

/** 判断一个值是否是该保留的枚举/坐标。 */
function keepString(key: string, value: string, parent: Record<string, unknown> | undefined): boolean {
  if (value.length > 64) return false
  if (KEEP_KEYS.has(key)) return true
  // 工具调用与错误对象里的 name 是工具名/错误名，保留。
  if (key === 'name' && parent !== undefined) {
    if ('callId' in parent || 'code' in parent) return true
  }
  void value
  return false
}

/** 把工具参数字符串换成"只有键名"的合成对象。 */
function sanitizeArguments(raw: unknown): string {
  if (typeof raw !== 'string') return '{}'
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}'
    const rebuilt: Record<string, string> = {}
    for (const key of Object.keys(parsed as Record<string, unknown>)) rebuilt[key] = ARG
    return JSON.stringify(rebuilt)
  } catch {
    return '{}'
  }
}

/** 递归替换一个 JSON 值。 */
function sanitize(value: unknown, key: string, parent: Record<string, unknown> | undefined): unknown {
  // 原始 provider 流只对回放有意义，且体积占了一半以上：形状样本里直接丢掉。
  if (key === 'stream') return []
  // 工具 schema 的 parameters 是嵌套 JSON Schema，保留键名即可，值不重要。
  if (key === 'parameters' && value !== null && typeof value === 'object') return {}
  // cwd 必须是绝对路径，用固定占位路径（泄漏断言里单独放行这一个值）。
  if (key === 'cwd' && typeof value === 'string') return FIXTURE_CWD
  if (typeof value === 'string') {
    if (key === 'arguments') return sanitizeArguments(value)
    if (keepString(key, value, parent)) return value
    return TEXT
  }
  if (Array.isArray(value)) {
    // 工具清单只保留前两个，覆盖"数组形状"即可。
    const kept = key === 'tools' ? value.slice(0, 2) : value
    return kept.map((entry) => sanitize(entry, key, parent))
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const rebuilt: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(source)) {
      rebuilt[childKey] = sanitize(childValue, childKey, source)
    }
    return rebuilt
  }
  return value
}

/** 生成后的泄漏检查：纯 ASCII、无盘符、无 URL（放行唯一固定的占位 cwd）。 */
function assertNoContent(rows: readonly string[]): void {
  for (const row of rows) {
    const cleaned = row.split(FIXTURE_CWD).join('')
    if (/[^\x00-\x7f]/u.test(cleaned)) throw new Error(`覆盖夹具含非 ASCII 字符（可能漏了内容）：${cleaned.slice(0, 120)}`)
    if (/[A-Za-z]:[\\/]/u.test(cleaned)) throw new Error(`覆盖夹具含盘符路径：${cleaned.slice(0, 120)}`)
    if (/https?:\/\//iu.test(cleaned)) throw new Error(`覆盖夹具含 URL：${cleaned.slice(0, 120)}`)
  }
}

const inputs = process.argv.slice(2)
if (inputs.length === 0) {
  console.error('用法：node tests/tools/make-coverage-fixture.ts <录制的日志…>')
  process.exit(2)
}

const events: Record<string, unknown>[] = []
let headerSeen = false
for (const input of inputs) {
  const rows = splitRows(decodeLog(readFileSync(input)))
  for (const row of rows) {
    const event = JSON.parse(row) as Record<string, unknown>
    // 一份日志只能有一个 header；多份录制拼成形状样本时只保留第一个。
    if (event['type'] === 'session') {
      if (headerSeen) continue
      headerSeen = true
    }
    const sanitized = sanitize(event, 'event', undefined) as Record<string, unknown>
    events.push(sanitized)
  }
}

// 重新编号：覆盖夹具是"形状样本"，不需要保留真实坐标，但必须连续。
let seq = 0
for (const event of events) {
  if (event['type'] === 'session') continue
  event['seq'] = seq++
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sessions')
const target = join(outDir, 'v4-coverage.jsonl')
const lines = events.map((event) => JSON.stringify(event))
assertNoContent(lines)
writeFileSync(target, `${lines.join('\n')}\n`)

const types = new Set(events.map((event) => String(event['type'])))
const tools = new Set(events.filter((event) => event['type'] === 'tool/call').map((event) => String((event['data'] as Record<string, unknown>)?.['name'])))
console.log(`已写出 ${target}`)
console.log(`事件 ${events.length} · 类型 ${types.size} · 工具 ${tools.size} · 纯 ASCII 泄漏检查通过`)
