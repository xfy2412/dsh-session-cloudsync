/**
 * 从真实会话提取“形状轨迹”（不包含正文）。
 *
 * 轨迹只保存：事件类型、canonical JSON 字节数、少量结构标志、每个 zstd 帧
 * 的行数。用于在仓库外复现大会话的性能形状，不复制消息、ID、路径或工具内容。
 *
 * 用法：
 *   node tests/tools/session-trace.ts <session.v4.jsonl.zstd> --out .tmp/bench/session.trace.json
 *
 * @module dsh-session-cloudsync/tests/session-trace
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFrames, splitFrames, splitRows } from '../../packages/shared/src/frames.ts'
import { stableStringify } from '../../packages/shared/src/chain.ts'

/** 轨迹中的一个事件：类型、字节、结构标志、JSON 节点数、turn/step。 */
type TraceEvent = readonly [typeIndex: number, bytes: number, flags: number, nodes: number, turn: number, step: number]

/** 形状轨迹文件。 */
export interface SessionShapeTrace {
  readonly version: 1
  readonly source: {
    readonly formatVersion: number
    readonly eventCount: number
    readonly canonicalBytes: number
    readonly compressedBytes: number
    readonly frameCount: number
  }
  readonly types: readonly string[]
  readonly events: readonly TraceEvent[]
  readonly frames: readonly number[]
}

/** 命令行参数。 */
interface Args {
  readonly input: string
  readonly output: string
}

/**
 * 解析参数。
 * @param argv - 参数。
 * @returns 路径。
 */
function parseArgs(argv: readonly string[]): Args {
  let input: string | undefined
  let output = resolve('.tmp/bench/session.trace.json')
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--out') {
      output = resolve(argv[index + 1] ?? '')
      index += 1
    } else if (!argument.startsWith('--')) {
      input = argument
    }
  }
  if (input === undefined) {
    console.error('用法：node tests/tools/session-trace.ts <session.v4.jsonl.zstd> [--out <trace.json>]')
    process.exit(2)
  }
  return { input: resolve(input), output }
}

/**
 * 数一个 JSON 值的遍历节点数（对象键、数组元素、标量都算）。
 * 用来近似 planner 序列化时的结构成本，而不是只看字节数。
 */
export function jsonNodes(value: unknown): number {
  if (value === null || typeof value !== 'object') return 1
  if (Array.isArray(value)) {
    let count = 1
    for (const item of value) count += jsonNodes(item)
    return count
  }
  let count = 1
  for (const key of Object.keys(value)) count += 1 + jsonNodes((value as Record<string, unknown>)[key])
  return count
}

/**
 * 提取轨迹。
 * @param input - zstd 会话日志。
 * @returns 轨迹。
 */
export function extractTrace(input: string): SessionShapeTrace {
  const compressed = readFileSync(input)
  const frames = splitFrames(compressed)
  const frameRows: number[] = []
  const allRows: string[] = []
  let formatVersion = 4
  for (const [index, frame] of frames.entries()) {
    const rows = splitRows(decodeFrames([frame])[0]!.toString('utf8'))
    if (index === 0) {
      const header = JSON.parse(rows[0]!) as { version?: unknown }
      if (typeof header.version !== 'number') throw new Error('会话头缺少 version')
      formatVersion = header.version
    }
    frameRows.push(rows.length)
    allRows.push(...rows)
  }
  const header = JSON.parse(allRows[0]!) as { version?: unknown }
  if (typeof header.version !== 'number') throw new Error('会话头缺少 version')
  const typeIndex = new Map<string, number>()
  const types: string[] = []
  const events: TraceEvent[] = []
  let canonicalBytes = 0
  for (const [seq, row] of allRows.slice(1).entries()) {
    const event = JSON.parse(row) as {
      type?: unknown
      data?: unknown
      surfaceOp?: unknown
      sourceEventSeqs?: unknown
      ignorable?: unknown
    }
    if (typeof event.type !== 'string') throw new Error(`seq ${seq} 缺少 type`)
    const data = event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data)
      ? event.data as Record<string, unknown>
      : {}
    let index = typeIndex.get(event.type)
    if (index === undefined) {
      index = types.length
      typeIndex.set(event.type, index)
      types.push(event.type)
    }
    const bytes = Buffer.byteLength(stableStringify(event), 'utf8')
    canonicalBytes += bytes
    let flags = 0
    if (event.surfaceOp === 'append') flags = 1
    else if (event.surfaceOp === 'replace') flags = 2
    if (event.sourceEventSeqs !== undefined) flags |= 4
    if (event.ignorable === true) flags |= 8
    const turn = typeof data['turn'] === 'number' && Number.isSafeInteger(data['turn']) ? data['turn'] : 0
    const step = typeof data['step'] === 'number' && Number.isSafeInteger(data['step']) ? data['step'] : 0
    events.push([index, bytes, flags, jsonNodes(event), turn, step])
  }
  return {
    version: 1,
    source: {
      formatVersion,
      eventCount: events.length,
      canonicalBytes,
      compressedBytes: compressed.length,
      frameCount: frames.length,
    },
    types,
    events,
    frames: frameRows,
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { input, output } = parseArgs(process.argv.slice(2))
  const trace = extractTrace(input)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(trace)}\n`)
  console.log(JSON.stringify({
    output,
    bytes: Buffer.byteLength(`${JSON.stringify(trace)}\n`),
    eventCount: trace.source.eventCount,
    canonicalBytes: trace.source.canonicalBytes,
    frames: trace.source.frameCount,
    types: trace.types.length,
  }, null, 2))
}
