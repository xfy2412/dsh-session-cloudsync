/**
 * 同步性能基准：真实会话 vs 形状轨迹生成会话。
 *
 * 只输出阶段耗时、事件数、canonical 字节数和 sealed 字节数，不输出事件内容。
 *
 * 用法：
 *   node tests/tools/bench-sync.ts --real <session.v4.jsonl.zstd> --trace <trace.json>
 *
 * 省略 --real 只跑生成会话；省略 --trace 只跑真实会话。
 *
 * @module dsh-session-cloudsync/tests/bench-sync
 */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { decodeLog, splitRows } from '../../packages/shared/src/frames.ts'
import { iterateEventBatches, planEventBatches, sealEventBatch, sealEventBatchFromText, type BatchOptions } from '../../packages/shared/src/batches.ts'
import { stableStringify } from '../../packages/shared/src/chain.ts'
import { generateSession } from './make-bench-session.ts'
import type { SessionShapeTrace } from './session-trace.ts'

/** 一轮基准结果。 */
interface Result {
  readonly label: string
  readonly events: number
  readonly canonicalBytes: number
  readonly decodeMs: number
  readonly parseMs: number
  readonly planMs: number
  readonly sealMs: number
  readonly pipelineMs: number
  readonly sealedBytes: number
  readonly batches: number
  readonly maxRssMb: number
}

/** 读取并解析一份日志。 */
function readLog(buffer: Buffer): { rows: string[]; events: readonly { readonly seq: number }[]; decodeMs: number; parseMs: number } {
  let start = performance.now()
  const text = decodeLog(buffer)
  const rows = splitRows(text)
  const decodeMs = performance.now() - start
  start = performance.now()
  const events = rows.slice(1).map((row) => JSON.parse(row) as { readonly seq: number })
  const parseMs = performance.now() - start
  return { rows, events, decodeMs, parseMs }
}

/** 跑 plan + seal。 */
function runPhases(
  label: string,
  events: readonly { readonly seq: number }[],
  rows: readonly string[],
  decodeMs: number,
  parseMs: number,
  options: BatchOptions = {},
): Result {
  let canonicalBytes = 0
  for (const row of rows.slice(1)) canonicalBytes += Buffer.byteLength(row, 'utf8')
  const startPlan = performance.now()
  const batches = planEventBatches(events, -1, options)
  const planMs = performance.now() - startPlan
  const startSeal = performance.now()
  let sealedBytes = 0
  const key = Buffer.alloc(32, 7)
  for (const [index, batch] of batches.entries()) {
    sealedBytes += sealEventBatch(batch.events, 'session-bench-shape', index + 1, key).bytes.length
  }
  const sealMs = performance.now() - startSeal
  // 实际 push 路径：惰性规划 + 直接使用批次文本封帧，避免再次序列化。
  const startPipeline = performance.now()
  let pipelineBatches = 0
  for (const batch of iterateEventBatches(events, -1, options)) {
    sealEventBatchFromText(batch.text, 'session-bench-shape', pipelineBatches + 1, batch.seqFrom, batch.seqTo, key)
    pipelineBatches += 1
  }
  const pipelineMs = performance.now() - startPipeline
  return {
    label,
    events: events.length,
    canonicalBytes,
    decodeMs,
    parseMs,
    planMs,
    sealMs,
    pipelineMs,
    sealedBytes,
    batches: batches.length,
    maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  }
}

/**
 * 解析参数。
 * @param argv - 参数。
 * @returns 路径。
 */
function parseArgs(argv: readonly string[]): { real?: string; trace?: string; batchEvents?: number; batchBytes?: number } {
  let real: string | undefined
  let trace: string | undefined
  let batchEvents: number | undefined
  let batchBytes: number | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--real') {
      real = argv[index + 1]
      index += 1
    } else if (argument === '--trace') {
      trace = argv[index + 1]
      index += 1
    } else if (argument === '--batch-events') {
      batchEvents = Number(argv[index + 1])
      index += 1
    } else if (argument === '--batch-bytes') {
      batchBytes = Number(argv[index + 1])
      index += 1
    }
  }
  return {
    ...real === undefined ? {} : { real },
    ...trace === undefined ? {} : { trace },
    ...batchEvents === undefined ? {} : { batchEvents },
    ...batchBytes === undefined ? {} : { batchBytes },
  }
}

const args = parseArgs(process.argv.slice(2))
const options: BatchOptions = {
  ...args.batchEvents === undefined ? {} : { maxEvents: args.batchEvents },
  ...args.batchBytes === undefined ? {} : { maxBytes: args.batchBytes },
}
const results: Result[] = []

if (args.real !== undefined) {
  const buffer = readFileSync(args.real)
  const parsed = readLog(buffer)
  results.push(runPhases('real', parsed.events, parsed.rows, parsed.decodeMs, parsed.parseMs, options))
}

if (args.trace !== undefined) {
  const trace = JSON.parse(readFileSync(args.trace, 'utf8')) as SessionShapeTrace
  const start = performance.now()
  const generated = generateSession(trace)
  const generateMs = performance.now() - start
  const buffer = Buffer.concat(generated.frames)
  const parsed = readLog(buffer)
  results.push({
    ...runPhases('generated', parsed.events, parsed.rows, parsed.decodeMs, parsed.parseMs, options),
    generateMs,
  } as Result & { generateMs: number })
  console.error(`generated in ${Math.round(generateMs)}ms; canonical=${generated.canonicalBytes}; mismatch=${generated.mismatchedBytes}`)
}

if (results.length === 0) {
  console.error('用法：node tests/tools/bench-sync.ts --real <session> --trace <trace>')
  process.exit(2)
}
console.log(JSON.stringify(results, null, 2))
