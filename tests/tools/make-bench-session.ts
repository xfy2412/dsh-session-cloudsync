/**
 * 用形状轨迹生成一份大会话基准日志。
 *
 * 生成器只使用类型、字节数和结构标志；正文是占位文本。输出优先保证每个
 * 事件的 canonical JSON 字节数与轨迹一致，其次保留真实帧的行数布局。
 *
 * 用法：
 *   node tests/tools/make-bench-session.ts <trace.json> [--out .tmp/bench/session.v4.jsonl.zstd]
 *
 * @module dsh-session-cloudsync/tests/make-bench-session
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { stableStringify } from '../../packages/shared/src/chain.ts'
import { jsonNodes, type SessionShapeTrace } from './session-trace.ts'

const here = dirname(fileURLToPath(import.meta.url))
const coverageFixture = resolve(here, '..', 'fixtures', 'sessions', 'v4-coverage.jsonl')
const BASE_TIME = 1_789_200_000_000
const WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
  'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia',
  'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum',
] as const
const SURFACE_TYPES = new Set([
  'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result',
])
/** 基准保留的核心事件类型；其余类型在生成 fixture 时降级为 ignorable 记录。 */
const SAFE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'request/header',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'session/title',
  'session/end-seed',
  'session-log-deepseek/delivery-accepted',
])

/** 确定性伪随机，保证生成器可复现。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** 合成近似真实文本压缩率的 padding。 */
function paddingText(length: number, random: () => number): string {
  if (length <= 0) return ''
  const parts: string[] = []
  let remaining = length
  while (remaining > 0) {
    const word = WORDS[Math.floor(random() * WORDS.length)]!
    if (parts.length > 0) {
      parts.push(' ')
      remaining -= 1
      if (remaining <= 0) break
    }
    const take = Math.min(word.length, remaining)
    parts.push(word.slice(0, take))
    remaining -= take
  }
  return parts.join('')
}

/** 生成结果。 */
export interface GeneratedSession {
  readonly header: Record<string, unknown>
  readonly events: readonly Record<string, unknown>[]
  readonly lines: readonly string[]
  readonly frames: readonly Buffer[]
  readonly canonicalBytes: number
  readonly mismatchedBytes: number
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
  let output = resolve('.tmp/bench/session.v4.jsonl.zstd')
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
    console.error('用法：node tests/tools/make-bench-session.ts <trace.json> [--out <session>]')
    process.exit(2)
  }
  return { input: resolve(input), output }
}

/** 从已脱敏的覆盖夹具取每种类型的最小模板。 */
function templates(): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>()
  const rows = readFileSync(coverageFixture, 'utf8').split('\n').filter((row) => row.trim() !== '')
  for (const row of rows.slice(1)) {
    const event = JSON.parse(row) as Record<string, unknown>
    const type = String(event['type'])
    const previous = result.get(type)
    if (previous === undefined
      || Buffer.byteLength(stableStringify(event), 'utf8') < Buffer.byteLength(stableStringify(previous), 'utf8')) {
      result.set(type, event)
    }
  }
  return result
}

/** 深拷贝 JSON。 */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/** 生成过程中维护的合成 ID/命令状态。 */
interface IdState {
  firstUserSeq: number
  lastCommandId: string
}

/** 给模板里复用过的消息 ID 换成唯一值，避免 DSH 关系校验报 duplicate child。 */
function assignIds(
  type: string,
  seq: number,
  data: Record<string, unknown>,
  ids: IdState,
  sessionId: string,
): void {
  const messageId = `bench-msg-${seq}`
  const message = data['message']
  if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
    const record = message as Record<string, unknown>
    record['id'] = messageId
    const source = record['source']
    if (source !== null && typeof source === 'object') {
      const replayState = (source as Record<string, unknown>)['replayState']
      if (replayState !== null && typeof replayState === 'object') {
        const blocks = (replayState as Record<string, unknown>)['blocks']
        if (Array.isArray(blocks)) {
          for (const [index, block] of blocks.entries()) {
            if (block !== null && typeof block === 'object') {
              (block as Record<string, unknown>)['signature'] = `bench-sig-${seq}-${index}`
            }
          }
        }
      }
    }
  }
  if (type === 'user/message') {
    data['id'] = messageId
    if (ids.firstUserSeq < 0) ids.firstUserSeq = seq
  }
  if (type === 'request/header') {
    const header = data['header']
    if (header !== null && typeof header === 'object') {
      const tools = (header as Record<string, unknown>)['tools']
      if (Array.isArray(tools)) {
        for (const tool of tools) {
          if (tool !== null && typeof tool === 'object') {
            (tool as Record<string, unknown>)['name'] = 'bench-tool-0'
          }
        }
      }
    }
  }
  if (type === 'assistant/message') {
    const content = (data['message'] as Record<string, unknown> | undefined)?.['content']
    if (Array.isArray(content)) {
      // tool 事件在 fixture 中降级为 ignorable；assistant 不再 advertise 调用，
      // 否则会留下无法消费的工具生命周期。
      for (let index = content.length - 1; index >= 0; index -= 1) {
        if (content[index] !== null && typeof content[index] === 'object'
          && (content[index] as Record<string, unknown>)['type'] === 'tool-call') {
          content.splice(index, 1)
        }
      }
    }
  }
  if (type === 'agent/inbox/spliced' && Array.isArray(data['inserted'])) {
    for (const inserted of data['inserted']) {
      if (inserted !== null && typeof inserted === 'object') {
        const record = inserted as Record<string, unknown>
        if (typeof record['id'] === 'string') record['id'] = messageId
      }
    }
  }
  if (type === 'session/title' || type === 'session/title-llm-request') {
    data['messageSeqs'] = ids.firstUserSeq >= 0 ? [ids.firstUserSeq] : []
  }
  if (type === 'subagent/catalog') {
    data['childId'] = `bench-child-${seq}`
  }
  if (type === 'session-log-deepseek/delivery-accepted') {
    data['sessionId'] = sessionId
    const through = typeof data['throughSeq'] === 'number' ? data['throughSeq'] : 0
    data['throughSeq'] = Math.max(0, Math.min(through, seq - 1))
  }
  if (type === 'command/run') {
    const commandId = `bench-command-${seq}`
    data['commandId'] = commandId
    ids.lastCommandId = commandId
  }
  if (type === 'command/done') {
    data['commandId'] = ids.lastCommandId === '' ? `bench-command-${seq}` : ids.lastCommandId
  }
}

/** 按需要补结构节点和字符串，直到 canonical JSON 接近目标字节/节点数。 */
function sizeEvent(
  type: string,
  seq: number,
  flags: number,
  targetBytes: number,
  targetNodes: number,
  turn: number,
  step: number,
  template: Record<string, unknown> | undefined,
  random: () => number,
  ids: IdState,
  sessionId: string,
): { event: Record<string, unknown>; mismatched: boolean } {
  const ignorable = !SAFE_TYPES.has(type)
  const eventType = ignorable ? 'bench/ignorable' : type
  const sourceTemplate = ignorable ? undefined : template
  const event = sourceTemplate === undefined && eventType === 'developer/message'
    ? {
        type: eventType,
        seq,
        time: BASE_TIME + seq,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: `bench-message-${seq}`,
            role: 'developer',
            source: { kind: 'tool-registry' },
            content: [],
          },
        },
      }
    : sourceTemplate === undefined
      ? { type: eventType, seq, time: BASE_TIME + seq, data: {} }
      : clone(sourceTemplate)
  event['type'] = eventType
  event['seq'] = seq
  event['time'] = BASE_TIME + seq
  const data = event['data'] !== null && typeof event['data'] === 'object' && !Array.isArray(event['data'])
    ? event['data'] as Record<string, unknown>
    : {}
  event['data'] = data
  if (turn > 0) data['turn'] = turn
  if (step > 0) data['step'] = step
  if (type === 'session/title') data['title'] = 'Benchmark 69k'
  if (!ignorable) assignIds(type, seq, data, ids, sessionId)
  delete event['surfaceOp']
  delete event['sourceEventSeqs']
  delete event['ignorable']
  delete data['__bench']
  if ((flags & 3) === 1) event['surfaceOp'] = 'append'
  else if ((flags & 3) === 2) event['surfaceOp'] = 'replace'
  else if (SURFACE_TYPES.has(type)) event['surfaceOp'] = 'append'
  if ((flags & 4) !== 0) event['sourceEventSeqs'] = [Math.max(0, seq - 1)]
  if ((flags & 8) !== 0 || ignorable) event['ignorable'] = true
  if (ignorable) {
    delete event['surfaceOp']
    delete event['sourceEventSeqs']
  }

  const padded = clone(event)
  const paddedData = padded['data'] as Record<string, unknown>
  paddedData['__bench'] = { text: '', anchors: [] as Record<string, string>[] }
  const anchors = (paddedData['__bench'] as { anchors: Record<string, string>[] }).anchors
  let currentBytes = Buffer.byteLength(stableStringify(padded), 'utf8')
  const baseNodes = jsonNodes(padded)
  if (targetBytes < currentBytes) {
    // 最小模板已经超过目标：不要硬塞 padding，接受少量偏差。
    return { event, mismatched: true }
  }

  // 每个 {w: word} 结构贡献 3 个节点（对象、键、字符串）；先用结构补节点，
  // 再用文本补字节。不要对每个 anchor 重算整棵 JSON 树。
  const wordAnchors = Math.max(0, Math.floor((targetNodes - baseNodes) / 3))
  for (let index = 0; index < wordAnchors; index += 1) {
    anchors.push({ w: WORDS[Math.floor(random() * WORDS.length)]! })
  }
  const residual = Math.max(0, targetNodes - baseNodes - wordAnchors * 3)
  for (let index = 0; index < residual; index += 1) anchors.push({})
  currentBytes = Buffer.byteLength(stableStringify(padded), 'utf8')
  while (currentBytes > targetBytes && anchors.length > 0) {
    anchors.pop()
    currentBytes = Buffer.byteLength(stableStringify(padded), 'utf8')
  }
  const bench = paddedData['__bench'] as { text: string; anchors: Record<string, string>[] }
  const remaining = targetBytes - currentBytes
  if (remaining > 0) bench.text = paddingText(remaining, random)
  const finalNodes = jsonNodes(padded)
  return { event: padded, mismatched: finalNodes !== targetNodes || Buffer.byteLength(stableStringify(padded), 'utf8') !== targetBytes }
}

/** 生成选项。 */
export interface GenerateOptions {
  /** 会话头 cwd；默认 `/fixture/workspace`。 */
  readonly cwd?: string
  /** 会话 id；默认 `session-bench-shape`。 */
  readonly id?: string
  /** 会话 createdAt；默认固定基准时间。 */
  readonly createdAt?: number
}

/**
 * 根据轨迹生成事件和 zstd 帧。
 * @param trace - 形状轨迹。
 * @param options - 会话头覆盖。
 * @returns 生成结果。
 */
export function generateSession(trace: SessionShapeTrace, options: GenerateOptions = {}): GeneratedSession {
  const templateByType = templates()
  const random = makeRandom(0x5EED)
  const ids: IdState = { firstUserSeq: -1, lastCommandId: '' }
  const sessionId = options.id ?? 'session-bench-shape'
  const events: Record<string, unknown>[] = []
  const lines: string[] = []
  let canonicalBytes = 0
  let mismatchedBytes = 0
  for (const [seq, [typeIndex, bytes, flags, nodes, turn, step]] of trace.events.entries()) {
    const type = trace.types[typeIndex]
    if (type === undefined) throw new Error(`轨迹引用了未知类型 ${typeIndex}`)
    const { event, mismatched } = sizeEvent(type, seq, flags, bytes, nodes, turn, step, templateByType.get(type), random, ids, sessionId)
    const text = stableStringify(event)
    const actual = Buffer.byteLength(text, 'utf8')
    canonicalBytes += actual
    if (mismatched || actual !== bytes) mismatchedBytes += Math.abs(actual - bytes)
    events.push(event)
    lines.push(text)
  }
  const header = {
    type: 'session',
    version: trace.source.formatVersion,
    id: sessionId,
    createdAt: options.createdAt ?? BASE_TIME,
    cwd: options.cwd ?? '/fixture/workspace',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  const headerLine = stableStringify(header)
  const allLines = [headerLine, ...lines]

  const frameRows = [...trace.frames]
  if (frameRows.reduce((sum, count) => sum + count, 0) !== allLines.length) {
    // 轨迹帧布局与事件数不一致（例如头部/尾帧边界变化）时，退化为单帧布局。
    frameRows.splice(0, frameRows.length, allLines.length)
  }
  const frames: Buffer[] = []
  let offset = 0
  for (const count of frameRows) {
    const chunk = allLines.slice(offset, offset + count)
    if (chunk.length > 0) frames.push(zstdCompressSync(Buffer.from(`${chunk.join('\n')}\n`, 'utf8')))
    offset += count
  }
  return { header, events, lines: allLines, frames, canonicalBytes, mismatchedBytes }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { input, output } = parseArgs(process.argv.slice(2))
  const trace = JSON.parse(readFileSync(input, 'utf8')) as SessionShapeTrace
  const generated = generateSession(trace)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, Buffer.concat(generated.frames))
  console.log(JSON.stringify({
    output,
    events: generated.events.length,
    canonicalBytes: generated.canonicalBytes,
    targetBytes: trace.source.canonicalBytes,
    mismatchedBytes: generated.mismatchedBytes,
    frames: generated.frames.length,
    compressedBytes: Buffer.concat(generated.frames).length,
  }, null, 2))
}
