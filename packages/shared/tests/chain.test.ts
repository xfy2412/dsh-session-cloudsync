import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { sha256 } from '../src/crypto.ts'
import {
  assertChain,
  assertManifest,
  buildManifest,
  commonPrefix,
  diffChains,
  manifestDigest,
  stableStringify,
} from '../src/chain.ts'
import type { ChainFrame } from '../src/chain.ts'
import { hashFrame, splitFrames, splitRows } from '../src/frames.ts'
import { sealFrame, sessionKeyOf } from '../src/sealed-frame.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'tests', 'fixtures', 'sessions')

/** 造一条长度可控的合成链。 */
function makeChain(length: number): ChainFrame[] {
  return Array.from({ length }, (_, index) => ({
    index,
    chainHash: sha256(`synthetic-frame-${index}`),
    seqFrom: index === 0 ? -1 : index - 1,
    seqTo: index === 0 ? -1 : index - 1,
  }))
}

/** 把覆盖夹具拆成真实链（序号从帧内首/末行读取）。 */
function fixtureChain(): ChainFrame[] {
  const frames = splitFrames(readFileSync(join(fixtures, 'v4-coverage.jsonl.zstd')))
  return frames.map((frame, index) => {
    const rows = splitRows(zstdDecompressSync(frame).toString('utf8')).map((row) => JSON.parse(row) as Record<string, unknown>)
    const first = rows[0]
    const last = rows[rows.length - 1]
    const seqFrom = typeof first?.['seq'] === 'number' ? first['seq'] : -1
    const seqTo = typeof last?.['seq'] === 'number' ? last['seq'] : seqFrom
    return { index, chainHash: hashFrame(frame), seqFrom, seqTo }
  })
}

test('合成链：相同 / 本地领先 / 远端领先 / 空链', () => {
  const chain = makeChain(4)
  assert.deepEqual(diffChains(chain, chain), { status: 'equal', common: 4, pull: [], push: [] })

  const localAhead = diffChains(chain, makeChain(2))
  assert.equal(localAhead.status, 'local-ahead')
  assert.equal(localAhead.common, 2)
  assert.equal(localAhead.push.length, 2)

  const remoteAhead = diffChains(makeChain(2), chain)
  assert.equal(remoteAhead.status, 'remote-ahead')
  assert.equal(remoteAhead.pull.length, 2)

  const emptyRemote = diffChains(chain, [])
  assert.equal(emptyRemote.status, 'local-ahead')
  assert.equal(emptyRemote.push.length, 4)

  assert.equal(diffChains([], []).status, 'equal')
  assert.equal(diffChains([], chain).status, 'remote-ahead')
})

test('尾帧重写是 tail-mismatch，而不是普通分叉', () => {
  const local = makeChain(3)
  const remote = makeChain(3)
  remote[2] = { ...remote[2]!, chainHash: sha256('rewritten-tail') }
  const diff = diffChains(local, remote)
  assert.equal(diff.status, 'tail-mismatch')
  assert.equal(diff.common, 2)
  assert.equal(diff.pull.length, 1)
  assert.equal(diff.push.length, 1)
})

test('公共前缀之后双方都有多帧 → diverged', () => {
  const local = makeChain(4)
  const remote = makeChain(4)
  remote[1] = { ...remote[1]!, chainHash: sha256('remote-write-1') }
  remote[2] = { ...remote[2]!, chainHash: sha256('remote-write-2') }
  const diff = diffChains(local, remote)
  assert.equal(diff.status, 'diverged')
  assert.equal(diff.common, 1)
  assert.equal(diff.pull.length, 3)
  assert.equal(diff.push.length, 3)
})

test('assertChain 拒绝下标断裂、哈希非法、seq 断裂与 header 序号', () => {
  assert.throws(() => assertChain([makeChain(1)[0]!, { ...makeChain(3)[2]! }]), /下标/)
  assert.throws(() => assertChain([{ index: 0, chainHash: 'xyz', seqFrom: -1, seqTo: -1 }]), /chainHash/)
  assert.throws(
    () => assertChain([makeChain(2)[0]!, { index: 1, chainHash: sha256('x'), seqFrom: 5, seqTo: 5 }]),
    /seq 应从/,
  )
  assert.throws(() => assertChain([{ index: 0, chainHash: sha256('h'), seqFrom: 0, seqTo: 0 }]), /header/)
})

test('真实覆盖夹具的链连续，公共前缀可定位到具体帧', () => {
  const chain = fixtureChain()
  assert.ok(chain.length > 100)
  assertChain(chain)
  assert.equal(commonPrefix(chain, chain), chain.length)

  const local = chain.slice(0, 120)
  const diff = diffChains(local, chain)
  assert.equal(diff.status, 'remote-ahead')
  assert.equal(diff.common, 120)
  assert.deepEqual(diff.pull.map((frame) => frame.index), chain.slice(120).map((frame) => frame.index))

  const rewritten = [...chain]
  rewritten[rewritten.length - 1] = { ...rewritten[rewritten.length - 1]!, chainHash: sha256('crash-rewrite') }
  assert.equal(diffChains(chain, rewritten).status, 'tail-mismatch')

  const diverged = [...chain.slice(0, 132), ...chain.slice(132).map((frame) => ({ ...frame, chainHash: sha256(`diverged-${frame.index}`) }))]
  assert.equal(diffChains(chain, diverged).status, 'diverged')
})

test('manifest 组装、校验与摘要', () => {
  const frames = splitFrames(readFileSync(join(fixtures, 'v4-coverage.jsonl.zstd'))).slice(0, 3)
  const sessionKey = sessionKeyOf(Buffer.alloc(32, 9), 'session-manifest-test')
  const refs = frames.map((frame, index) =>
    sealFrame(frame, {
      sessionId: 'session-manifest-test',
      index,
      seqFrom: index === 0 ? -1 : index - 1,
      seqTo: index === 0 ? -1 : index - 1,
    }, sessionKey).ref,
  )
  const manifest = buildManifest({
    sessionId: 'session-manifest-test',
    formatVersion: 4,
    createdAt: 100,
    updatedAt: 200,
    frames: refs,
  })
  assert.equal(manifest.lastSeq, 1)
  assertManifest(manifest)
  assert.throws(() => assertManifest({ ...manifest, lastSeq: 99 }), /lastSeq/)

  const digest = manifestDigest(manifest)
  assert.match(digest, /^[0-9a-f]{64}$/u)
  assert.equal(manifestDigest({ ...manifest, updatedAt: 999 }), digest)
  assert.notEqual(manifestDigest({ ...manifest, frames: [refs[0]!, refs[1]!, { ...refs[2]!, chainHash: sha256('other') }] }), digest)
})

test('stableStringify 与键序无关', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }))
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
})
