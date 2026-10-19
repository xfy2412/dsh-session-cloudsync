// 盘点会话日志"用到了什么"：事件类型、工具调用、参数键、结果形态。
//
// 只输出形状与计数，不打印正文、不打印参数值、不打印结果文本 —— 这样可以把
// 真实会话的覆盖面带进仓库，而不把内容带进来。
//
// 用法：
//   node tests/tools/inspect-session.ts <日志…> [--json]
// 多个文件会合并统计（用于"主会话 + 子代理会话"的整棵树）。
import { readFileSync } from 'node:fs'
import { decodeLog, splitRows } from '../../packages/shared/src/frames.ts'

interface ToolShape {
  calls: number
  argKeys: Set<string>
  results: number
  resultContentKinds: Set<string>
  resultTextBytes: number
  errors: Set<string>
  withMeta: number
  withSourceEventSeqs: number
}

interface Summary {
  files: string[]
  events: number
  turns: Set<number>
  steps: Set<string>
  eventTypes: Map<string, number>
  surfaceOps: Map<string, number>
  tools: Map<string, ToolShape>
}

/** 新建一个空汇总。 */
function emptySummary(): Summary {
  return { files: [], events: 0, turns: new Set(), steps: new Set(), eventTypes: new Map(), surfaceOps: new Map(), tools: new Map() }
}

/**
 * 盘点一个日志文件，并把结果并进汇总。
 * @param summary - 汇总目标。
 * @param file - 日志路径（zstd 或明文）。
 */
function inspectInto(summary: Summary, file: string): void {
  summary.files.push(file)
  const rows = splitRows(decodeLog(readFileSync(file))).map((row) => JSON.parse(row) as Record<string, unknown>)
  summary.events += rows.length

  const callToTool = new Map<string, string>()

  for (const event of rows) {
    const type = String(event['type'])
    summary.eventTypes.set(type, (summary.eventTypes.get(type) ?? 0) + 1)

    const op = event['surfaceOp']
    if (op !== undefined) {
      const key = typeof op === 'string' ? op : `object:${String((op as Record<string, unknown>)['op'])}`
      summary.surfaceOps.set(key, (summary.surfaceOps.get(key) ?? 0) + 1)
    }

    const data = event['data'] as Record<string, unknown> | undefined
    if ((type === 'turn/start' || type === 'turn/end') && typeof data?.['turn'] === 'number') {
      summary.turns.add(data['turn'])
    }
    if (type === 'step/start' || type === 'step/end') {
      summary.steps.add(`${String(data?.['turn'])}/${String(data?.['step'])}`)
    }

    if (type === 'tool/call') {
      const name = String(data?.['name'] ?? '?')
      const shape = summary.tools.get(name) ?? {
        calls: 0,
        argKeys: new Set<string>(),
        results: 0,
        resultContentKinds: new Set<string>(),
        resultTextBytes: 0,
        errors: new Set<string>(),
        withMeta: 0,
        withSourceEventSeqs: 0,
      }
      shape.calls += 1
      const raw = data?.['arguments']
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          for (const key of Object.keys(parsed)) shape.argKeys.add(key)
        } catch {
          shape.argKeys.add('<unparseable>')
        }
      }
      if (event['sourceEventSeqs'] !== undefined) shape.withSourceEventSeqs += 1
      summary.tools.set(name, shape)
      const callId = data?.['callId']
      if (typeof callId === 'string') callToTool.set(callId, name)
    }
  }

  // 第二遍：把结果挂回工具形状。
  for (const event of rows) {
    if (event['type'] !== 'tool/result') continue
    const data = event['data'] as Record<string, unknown> | undefined
    const message = data?.['message'] as Record<string, unknown> | undefined
    const callId = String(message?.['toolCallId'] ?? data?.['toolCallId'] ?? '')
    const name = callToTool.get(callId)
    const shape = name === undefined ? undefined : summary.tools.get(name)
    if (shape === undefined) continue
    shape.results += 1
    const content = message?.['content']
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        shape.resultContentKinds.add(String((block as Record<string, unknown>)['type']))
        const text = (block as Record<string, unknown>)['text']
        if (typeof text === 'string') shape.resultTextBytes += Buffer.byteLength(text, 'utf8')
      }
    }
    const error = message?.['error'] ?? data?.['error']
    if (error !== undefined) {
      const kind = typeof error === 'object' && error !== null ? String((error as Record<string, unknown>)['kind'] ?? 'object') : typeof error
      shape.errors.add(kind)
    }
    if (message?.['meta'] !== undefined) shape.withMeta += 1
    if (event['sourceEventSeqs'] !== undefined) shape.withSourceEventSeqs += 1
  }
}

const paths = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
const asJson = process.argv.includes('--json')
if (paths.length === 0) {
  console.error('用法：node tests/tools/inspect-session.ts <日志…> [--json]')
  process.exit(2)
}

const summary = emptySummary()
for (const path of paths) inspectInto(summary, path)

const sortedTypes = [...summary.eventTypes.entries()].sort((a, b) => b[1] - a[1])
const sortedOps = [...summary.surfaceOps.entries()].sort((a, b) => b[1] - a[1])
const sortedTools = [...summary.tools.entries()].sort((a, b) => b[1].calls - a[1].calls)

if (asJson) {
  console.log(JSON.stringify({
    files: summary.files,
    events: summary.events,
    turns: summary.turns.size,
    steps: summary.steps.size,
    eventTypes: sortedTypes.map(([type, count]) => ({ type, count })),
    surfaceOps: sortedOps.map(([op, count]) => ({ op, count })),
    tools: sortedTools.map(([name, shape]) => ({
      name,
      calls: shape.calls,
      argKeys: [...shape.argKeys].sort(),
      results: shape.results,
      resultContentKinds: [...shape.resultContentKinds].sort(),
      resultTextBytes: shape.resultTextBytes,
      errors: [...shape.errors].sort(),
      withMeta: shape.withMeta,
      withSourceEventSeqs: shape.withSourceEventSeqs,
    })),
  }, null, 2))
} else {
  console.log(`文件 ${summary.files.length} 个 · 事件 ${summary.events} · 轮 ${summary.turns.size} · 步 ${summary.steps.size}`)
  console.log(`\n事件类型（${sortedTypes.length} 种）：`)
  for (const [type, count] of sortedTypes) console.log(`  ${String(count).padStart(4)}  ${type}`)
  console.log(`\nsurfaceOp：`)
  for (const [op, count] of sortedOps) console.log(`  ${String(count).padStart(4)}  ${op}`)
  console.log(`\n工具调用（${sortedTools.length} 种）：`)
  for (const [name, shape] of sortedTools) {
    const flags = [
      shape.errors.size > 0 ? `errors=${[...shape.errors].join(',')}` : '',
      shape.withMeta > 0 ? `meta×${shape.withMeta}` : '',
      shape.withSourceEventSeqs > 0 ? `srcSeqs×${shape.withSourceEventSeqs}` : '',
    ].filter(Boolean).join(' ')
    console.log(`  ${shape.calls}× ${name}  参数键=[${[...shape.argKeys].sort().join(',')}]  结果=${shape.results} 内容=[${[...shape.resultContentKinds].sort().join(',')}] 文本≈${shape.resultTextBytes}B ${flags}`)
  }
}
