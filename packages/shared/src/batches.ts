/**
 * 事件批次的纯函数：会话头元数据、批次哈希、封批/解批，以及按上限切批。
 *
 * 同步链的第 0 个条目是**封好的会话头**（`seq = -1`），事件批次从下标 1 开始。
 * 这样服务端现有“首条目 seq=-1、后续 seq 连续”的链校验不需要改，同时把
 * `cwd` 从哈希里排除，跨设备不会因为本地路径不同而分叉。
 *
 * @module @dsh-session-sync/shared/batches
 */
import { sha256 } from './crypto.ts'
import { stableStringify } from './chain.ts'
import { openSealedFrame, sealFrame, type SealedFrame, type SealedFrameRef } from './sealed-frame.ts'

/** 会话头在链中的下标。 */
export const HEADER_INDEX = 0

/** 会话头条目的 seq 哨兵（与服务端的 header frame 约定一致）。 */
export const HEADER_SEQ = -1

/** 默认单批事件上限。 */
export const DEFAULT_BATCH_EVENTS = 50

/** 默认单批字节上限（规范 JSON，未压缩）。 */
export const DEFAULT_BATCH_BYTES = 256 * 1024

/** 同步用的事件：只需要稳定的 `seq`；其余字段原样保留。 */
export type SyncEvent = { readonly seq: number }

/** 可同步的会话头字段（不含 `cwd`）。 */
export interface SessionHeaderMeta {
  /** DSH 会话格式代际。 */
  readonly formatVersion: number
  /** 会话创建时间（生命周期标识）。 */
  readonly createdAt: number
  /** 是否 fork/seed 会话。 */
  readonly isSeeded: boolean
  /** 委托深度。 */
  readonly delegationDepth: number
  /** agent 预设（可选）。 */
  readonly agentPreset?: string
  /** 父会话（子代理会话）。 */
  readonly parentSession?: string
  /** 来源（子代理会话）。 */
  readonly origin?: string
  /** seeded 会话的继承前缀长度。 */
  readonly inheritedEventCount?: number
}

/** 持久化会话头里本模块需要的字段。 */
export interface SessionHeaderLike {
  readonly version: number
  readonly createdAt: number
  readonly isSeeded: boolean
  readonly delegationDepth?: number
  readonly agentPreset?: string
  readonly parentSession?: string
  readonly origin?: string
}

/** 一批连续事件。 */
export interface EventBatch {
  /** 批次内第一条事件的 seq。 */
  readonly seqFrom: number
  /** 批次内最后一条事件的 seq。 */
  readonly seqTo: number
  /** 批次内的事件（顺序保持）。 */
  readonly events: readonly SyncEvent[]
  /** 规范 JSON 的字节数。 */
  readonly bytes: number
}

/** 切批上限。 */
export interface BatchOptions {
  /** 单批最多事件数，默认 {@link DEFAULT_BATCH_EVENTS}。 */
  readonly maxEvents?: number
  /** 单批最多规范 JSON 字节数，默认 {@link DEFAULT_BATCH_BYTES}。 */
  readonly maxBytes?: number
}

/**
 * 从持久化 header 提取可同步的元数据；`cwd` 不参与。
 * @param header - DSH 的 SessionHeader。
 * @param inheritedEventCount - seeded 会话的继承前缀长度。
 * @returns 稳定的元数据对象。
 */
export function headerMetaOf(header: SessionHeaderLike, inheritedEventCount?: number): SessionHeaderMeta {
  return {
    formatVersion: header.version,
    createdAt: header.createdAt,
    isSeeded: header.isSeeded,
    delegationDepth: header.delegationDepth ?? 0,
    ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.isSeeded ? { inheritedEventCount: inheritedEventCount ?? 0 } : {},
  }
}

/**
 * 会话头的链哈希（规范 JSON 的 sha256）。
 * @param meta - 会话头元数据。
 * @returns 小写十六进制哈希。
 */
export function headerChainHash(meta: SessionHeaderMeta): string {
  return sha256(stableStringify(meta))
}

/**
 * 封会话头。
 * @param meta - 会话头元数据。
 * @param sessionId - 会话 id。
 * @param sessionKey - 会话密钥。
 * @returns 封好的头条目。
 */
export function sealHeader(meta: SessionHeaderMeta, sessionId: string, sessionKey: Buffer): SealedFrame {
  const plain = Buffer.from(stableStringify(meta), 'utf8')
  return sealFrame(plain, { sessionId, index: HEADER_INDEX, seqFrom: HEADER_SEQ, seqTo: HEADER_SEQ }, sessionKey)
}

/**
 * 解会话头。
 * @param sealed - 封好的头字节。
 * @param ref - 清单里的头条目。
 * @param sessionId - 会话 id。
 * @param sessionKey - 会话密钥。
 * @returns 会话头元数据。
 * @throws 条目不是头、AAD/哈希不符或字段非法时抛出。
 */
export function openHeader(sealed: Buffer, ref: SealedFrameRef, sessionId: string, sessionKey: Buffer): SessionHeaderMeta {
  if (ref.index !== HEADER_INDEX || ref.seqFrom !== HEADER_SEQ || ref.seqTo !== HEADER_SEQ) {
    throw new Error('第 0 个链条目不是会话头')
  }
  const plain = openSealedFrame(sealed, {
    sessionId,
    index: ref.index,
    seqFrom: ref.seqFrom,
    seqTo: ref.seqTo,
    chainHash: ref.chainHash,
  }, sessionKey)
  return parseHeaderMeta(JSON.parse(plain.toString('utf8')))
}

/**
 * 校验并读取一个事件数组。
 * @param value - JSON.parse 的结果。
 * @returns 事件数组。
 */
function parseEvents(value: unknown): SyncEvent[] {
  if (!Array.isArray(value)) throw new Error('批次不是事件数组')
  return value.map((entry, position) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`批次第 ${position} 项不是事件对象`)
    const seq = (entry as Record<string, unknown>)['seq']
    if (!Number.isSafeInteger(seq) || (seq as number) < 0) throw new Error(`批次第 ${position} 项的 seq 非法`)
    return entry as SyncEvent
  })
}

/**
 * 校验并读取会话头元数据。
 * @param value - JSON.parse 的结果。
 * @returns 元数据。
 */
function parseHeaderMeta(value: unknown): SessionHeaderMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('会话头不是对象')
  const record = value as Record<string, unknown>
  const formatVersion = record['formatVersion']
  const createdAt = record['createdAt']
  const isSeeded = record['isSeeded']
  const delegationDepth = record['delegationDepth']
  if (!Number.isSafeInteger(formatVersion) || (formatVersion as number) < 1) throw new Error('会话头 formatVersion 非法')
  if (!Number.isSafeInteger(createdAt)) throw new Error('会话头 createdAt 非法')
  if (typeof isSeeded !== 'boolean') throw new Error('会话头 isSeeded 非法')
  if (!Number.isSafeInteger(delegationDepth) || (delegationDepth as number) < 0) throw new Error('会话头 delegationDepth 非法')
  const stringField = (key: string): string | undefined => {
    const field = record[key]
    if (field === undefined) return undefined
    if (typeof field !== 'string') throw new Error(`会话头 ${key} 非法`)
    return field
  }
  const inherited = record['inheritedEventCount']
  if (inherited !== undefined && (!Number.isSafeInteger(inherited) || (inherited as number) < 0)) {
    throw new Error('会话头 inheritedEventCount 非法')
  }
  const agentPreset = stringField('agentPreset')
  const parentSession = stringField('parentSession')
  const origin = stringField('origin')
  return {
    formatVersion: formatVersion as number,
    createdAt: createdAt as number,
    isSeeded,
    delegationDepth: delegationDepth as number,
    ...agentPreset === undefined ? {} : { agentPreset },
    ...parentSession === undefined ? {} : { parentSession },
    ...origin === undefined ? {} : { origin },
    ...inherited === undefined ? {} : { inheritedEventCount: inherited as number },
  }
}

/**
 * 一批事件的规范 JSON 文本。
 * @param events - 连续事件。
 * @returns 键序稳定的 JSON。
 */
export function serializeEventBatch(events: readonly SyncEvent[]): string {
  return stableStringify(events)
}

/**
 * 一批事件的链哈希。
 * @param events - 连续事件。
 * @returns 规范 JSON 的 sha256。
 */
export function eventBatchHash(events: readonly SyncEvent[]): string {
  return sha256(serializeEventBatch(events))
}

/**
 * 封一批事件。
 * @param events - 连续的已排序事件。
 * @param sessionId - 会话 id。
 * @param index - 链上下标（必须 >= 1）。
 * @param sessionKey - 会话密钥。
 * @returns 封好的批次。
 */
export function sealEventBatch(
  events: readonly SyncEvent[],
  sessionId: string,
  index: number,
  sessionKey: Buffer,
): SealedFrame {
  if (index < 1) throw new Error('事件批次的链下标必须 >= 1')
  if (events.length === 0) throw new Error('不能封空批次')
  const seqFrom = events[0]!.seq
  const seqTo = events[events.length - 1]!.seq
  assertContiguous(events, seqFrom, seqTo)
  const plain = Buffer.from(serializeEventBatch(events), 'utf8')
  return sealFrame(plain, { sessionId, index, seqFrom, seqTo }, sessionKey)
}

/**
 * 解一批事件。
 * @param sealed - 封好的批次字节。
 * @param ref - 清单里的批次条目。
 * @param sessionId - 会话 id。
 * @param sessionKey - 会话密钥。
 * @returns 事件数组。
 * @throws AAD/哈希不符、seq 区间不一致或内容非法时抛出。
 */
export function openEventBatch(
  sealed: Buffer,
  ref: SealedFrameRef,
  sessionId: string,
  sessionKey: Buffer,
): SyncEvent[] {
  const plain = openSealedFrame(sealed, {
    sessionId,
    index: ref.index,
    seqFrom: ref.seqFrom,
    seqTo: ref.seqTo,
    chainHash: ref.chainHash,
  }, sessionKey)
  const events = parseEvents(JSON.parse(plain.toString('utf8')))
  if (events.length !== ref.seqTo - ref.seqFrom + 1) throw new Error('批次事件数与 seq 区间不符')
  if (events.length === 0 || events[0]!.seq !== ref.seqFrom || events[events.length - 1]!.seq !== ref.seqTo) {
    throw new Error('批次首尾 seq 与清单不符')
  }
  assertContiguous(events, ref.seqFrom, ref.seqTo)
  return events
}

/**
 * 校验一段事件是 `[seqFrom, seqTo]` 的连续序列。
 * @param events - 事件数组。
 * @param seqFrom - 首 seq。
 * @param seqTo - 末 seq。
 */
function assertContiguous(events: readonly SyncEvent[], seqFrom: number, seqTo: number): void {
  if (events.length !== seqTo - seqFrom + 1) throw new Error('事件数与 seq 区间不符')
  events.forEach((event, offset) => {
    if (event.seq !== seqFrom + offset) throw new Error(`第 ${offset} 个事件的 seq 应为 ${seqFrom + offset}，实际是 ${event.seq}`)
  })
}

/**
 * 把待上传事件切成新批次；已经有批次边界的旧事件不会重新参与切分。
 * @param events - 本地全部事件（按 seq 升序）。
 * @param startAfterSeq - 最后一个已上传批次覆盖的 seq；-1 表示从 0 开始。
 * @param options - 单批上限。
 * @returns 新批次，按顺序排列。
 * @throws 事件不连续/重复或第一条待传事件不是 `startAfterSeq + 1` 时抛出。
 */
export function planEventBatches(
  events: readonly SyncEvent[],
  startAfterSeq: number,
  options: BatchOptions = {},
): EventBatch[] {
  const maxEvents = options.maxEvents ?? DEFAULT_BATCH_EVENTS
  const maxBytes = options.maxBytes ?? DEFAULT_BATCH_BYTES
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents 必须是正整数')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes 必须是正整数')

  events.forEach((event, offset) => {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error(`第 ${offset} 个事件的 seq 非法`)
    if (offset > 0 && events[offset - 1]!.seq + 1 !== event.seq) throw new Error(`事件 seq 不连续：${events[offset - 1]!.seq} -> ${event.seq}`)
  })

  const pending = events.filter((event) => event.seq > startAfterSeq)
  if (pending.length === 0) return []
  if (pending[0]!.seq !== startAfterSeq + 1) throw new Error(`待传事件应从 ${startAfterSeq + 1} 开始，实际是 ${pending[0]!.seq}`)

  const batches: EventBatch[] = []
  let current: SyncEvent[] = []
  for (const event of pending) {
    const candidate = [...current, event]
    const candidateBytes = Buffer.byteLength(serializeEventBatch(candidate), 'utf8')
    if (current.length > 0 && (candidate.length > maxEvents || candidateBytes > maxBytes)) {
      const bytes = Buffer.byteLength(serializeEventBatch(current), 'utf8')
      batches.push({ seqFrom: current[0]!.seq, seqTo: current[current.length - 1]!.seq, events: current, bytes })
      current = [event]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) {
    batches.push({
      seqFrom: current[0]!.seq,
      seqTo: current[current.length - 1]!.seq,
      events: current,
      bytes: Buffer.byteLength(serializeEventBatch(current), 'utf8'),
    })
  }
  return batches
}
