/**
 * 会话帧链的纯函数：连续性校验、公共前缀、缺帧/分叉判定、manifest 组装与摘要。
 *
 * 这里只关心「帧字节的哈希 + 顺序 + seq 区间」，不涉及加密、HTTP 或事件内容；
 * 对同一格式代际的事件 schema 变化完全免疫。
 *
 * @module @dsh-session-sync/shared/chain
 */
import { sha256 } from './crypto.ts'
import type { SessionManifest } from './protocol.ts'
import type { SealedFrameRef } from './sealed-frame.ts'

/** 链比较只需要的最小帧身份。 */
export interface ChainFrame {
  /** 帧在链中的下标（0 是 header 帧）。 */
  readonly index: number
  /** 明文帧的 SHA-256（小写十六进制）。 */
  readonly chainHash: string
  /** 帧内第一条事件的序号；header 帧无序号，用 -1。 */
  readonly seqFrom: number
  /** 帧内最后一条事件的序号；header 帧无序号，用 -1。 */
  readonly seqTo: number
}

/** 两条链的关系。 */
export type ChainStatus = 'equal' | 'local-ahead' | 'remote-ahead' | 'diverged' | 'tail-mismatch'

/** 一次链比较的结果。 */
export interface ChainDiff {
  readonly status: ChainStatus
  /** 公共前缀的帧数。 */
  readonly common: number
  /** 远端有、本地缺的帧（需要拉取）。 */
  readonly pull: readonly ChainFrame[]
  /** 本地有、远端缺的帧（需要推送）。 */
  readonly push: readonly ChainFrame[]
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u

/**
 * 校验一条链的连续性。
 * @param chain - 按下标升序排列的帧。
 * @throws 下标不连续、哈希形状不对或 seq 区间断开时抛出。
 */
export function assertChain(chain: readonly ChainFrame[]): void {
  chain.forEach((frame, position) => {
    if (frame.index !== position) throw new Error(`第 ${position} 帧的下标是 ${frame.index}，链不连续`)
    if (!HASH_PATTERN.test(frame.chainHash)) throw new Error(`第 ${position} 帧的 chainHash 不是 64 位十六进制`)
    if (!Number.isSafeInteger(frame.seqFrom) || !Number.isSafeInteger(frame.seqTo)) throw new Error(`第 ${position} 帧的 seq 不是整数`)
    if (position === 0) {
      if (frame.seqFrom !== -1 || frame.seqTo !== -1) throw new Error('header 帧的 seq 必须是 -1')
      return
    }
    const previous = chain[position - 1]!
    if (frame.seqFrom < 0 || frame.seqTo < frame.seqFrom) throw new Error(`第 ${position} 帧的 seq 区间非法`)
    if (previous.seqTo + 1 !== frame.seqFrom) {
      throw new Error(`第 ${position} 帧的 seq 应从 ${previous.seqTo + 1} 开始，实际是 ${frame.seqFrom}`)
    }
  })
}

/**
 * 计算两条链的公共前缀长度。
 * @param local - 本地链。
 * @param remote - 远端链。
 * @returns 从下标 0 起连续相同的帧数。
 */
export function commonPrefix(local: readonly ChainFrame[], remote: readonly ChainFrame[]): number {
  let index = 0
  while (index < local.length && index < remote.length && local[index]!.chainHash === remote[index]!.chainHash) index += 1
  return index
}

/**
 * 比较两条链，给出拉取/推送计划。
 *
 * 规则：
 * - 公共前缀之后只有一侧有帧 → 该侧领先；
 * - 两侧都还有帧，且各只剩一帧、下标相同 → `tail-mismatch`（DSH 崩溃恢复可能重写尾帧）；
 * - 其余两侧都有差异帧的情况 → `diverged`，不自动合并。
 * @param local - 本地链。
 * @param remote - 远端链。
 * @returns 关系与需要传输的帧。
 * @throws 任一链不连续时抛出。
 */
export function diffChains(local: readonly ChainFrame[], remote: readonly ChainFrame[]): ChainDiff {
  assertChain(local)
  assertChain(remote)
  const common = commonPrefix(local, remote)
  const pull = remote.slice(common)
  const push = local.slice(common)
  if (pull.length === 0 && push.length === 0) return { status: 'equal', common, pull, push }
  if (push.length === 0) return { status: 'remote-ahead', common, pull, push }
  if (pull.length === 0) return { status: 'local-ahead', common, pull, push }
  if (pull.length === 1 && push.length === 1 && pull[0]!.index === push[0]!.index) {
    return { status: 'tail-mismatch', common, pull, push }
  }
  return { status: 'diverged', common, pull, push }
}

/** manifest 组装入参。 */
export interface ManifestInput {
  readonly sessionId: string
  readonly formatVersion: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly frames: readonly SealedFrameRef[]
}

/**
 * 由封帧条目组装会话 manifest。
 * @param input - 会话 id、格式代际、时间与帧条目。
 * @returns 可直接上传/比对的 manifest。
 * @throws 帧条目下标不连续或字段非法时抛出。
 */
export function buildManifest(input: ManifestInput): SessionManifest {
  input.frames.forEach((frame, position) => {
    if (frame.index !== position) throw new Error(`manifest 第 ${position} 条的 index 是 ${frame.index}`)
    if (!HASH_PATTERN.test(frame.chainHash) || !HASH_PATTERN.test(frame.blobSha256)) throw new Error(`manifest 第 ${position} 条的哈希非法`)
    if (frame.sealedVersion < 1) throw new Error(`manifest 第 ${position} 条的封帧版本非法`)
  })
  const last = input.frames[input.frames.length - 1]
  return {
    sessionId: input.sessionId,
    formatVersion: input.formatVersion,
    createdAt: input.createdAt,
    lastSeq: last === undefined ? -1 : last.seqTo,
    frames: input.frames,
    updatedAt: input.updatedAt,
  }
}

/**
 * 校验一份 manifest 的形状。
 * @param manifest - 待检查的 manifest。
 * @throws 帧条目下标/哈希/seq 不一致时抛出。
 */
export function assertManifest(manifest: SessionManifest): void {
  manifest.frames.forEach((frame, position) => {
    if (frame.index !== position) throw new Error(`manifest 第 ${position} 条的 index 是 ${frame.index}`)
    if (!HASH_PATTERN.test(frame.chainHash) || !HASH_PATTERN.test(frame.blobSha256)) throw new Error(`manifest 第 ${position} 条的哈希非法`)
  })
  const last = manifest.frames[manifest.frames.length - 1]
  if ((last === undefined ? -1 : last.seqTo) !== manifest.lastSeq) throw new Error('manifest 的 lastSeq 与最后一帧不一致')
}

/** 把值规整成键序稳定的 JSON 形状。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry))
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = canonical((value as Record<string, unknown>)[key])
    return sorted
  }
  return value
}

/**
 * 键序稳定的 JSON 序列化，用于摘要。
 * @param value - 任意 JSON 值。
 * @returns 稳定的 JSON 文本。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value))
}

/**
 * manifest 的内容摘要；不含 `updatedAt`（服务端易变字段）。
 * @param manifest - 待摘要的 manifest。
 * @returns 小写十六进制 SHA-256。
 */
export function manifestDigest(manifest: SessionManifest): string {
  return sha256(stableStringify({
    sessionId: manifest.sessionId,
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    lastSeq: manifest.lastSeq,
    frames: manifest.frames.map((frame) => ({
      index: frame.index,
      chainHash: frame.chainHash,
      blobSha256: frame.blobSha256,
      bytes: frame.bytes,
      sealedVersion: frame.sealedVersion,
      keyId: frame.keyId,
      seqFrom: frame.seqFrom,
      seqTo: frame.seqTo,
    })),
    deletedAt: manifest.deletedAt ?? null,
  }))
}
