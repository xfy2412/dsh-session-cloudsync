import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import { syncVault } from '../src/vault-sync.ts'
import { vaultRecordHashOf } from '../../shared/src/vault.ts'

const CLIENT_ID = '0123456789abcdef'
const WRITER = 'device-vault-1'

/**
 * 一个最小 Vault 假服务端。
 * @returns fetch 与观测数据。
 */
function fakeServer() {
  const records = []
  const blobs = new Map()
  let lease = null
  let revision = 0
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    const path = url.pathname
    const method = init.method ?? 'GET'
    calls.push(`${method} ${path}`)
    if (path === '/v1/me') {
      return Response.json({ ok: true, value: { role: 'device', device: { deviceId: WRITER, label: 'Writer' } } })
    }
    if (path === '/v1/vault/stream/device-vault-1') {
      const from = Number(url.searchParams.get('from') ?? 1)
      const matching = records.filter((record) => record.seq >= from)
      return Response.json({ ok: true, value: { writer: WRITER, records: matching, hasMore: false } })
    }
    if (path === '/v1/vault/lease' && method === 'POST') {
      const client = String(init.headers?.['x-client-id'] ?? '')
      if (lease !== null && lease !== client) return Response.json({ ok: false, error: { code: 'lease-held', message: 'held' } }, { status: 409 })
      lease = client
      return Response.json({ ok: true, value: { resource: 'vault-writer:test', acquired: true } })
    }
    if (path === '/v1/vault/lease' && method === 'DELETE') {
      lease = null
      return Response.json({ ok: true, value: { released: true } })
    }
    if (path === '/v1/blobs') {
      const bytes = Buffer.from(init.body)
      const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
      blobs.set(sha256, bytes)
      return Response.json({ ok: true, value: { sha256, bytes: bytes.length, dedup: false } }, { status: 201 })
    }
    if (path === '/v1/vault/append' && method === 'POST') {
      if (lease === null) return Response.json({ ok: false, error: { code: 'lease-held', message: 'no lease' } }, { status: 409 })
      const body = JSON.parse(String(init.body))
      const blob = blobs.get(body.blobSha256)
      if (blob === undefined || blob.length !== body.bytes) throw new Error('missing blob')
      const fields = {
        v: 1,
        writer: body.writer,
        seq: body.seq,
        prevHash: body.prevHash,
        blobSha256: body.blobSha256,
        bytes: body.bytes,
        createdAt: body.createdAt,
        sealed: body.sealed,
      }
      const record = { ...fields, recordHash: vaultRecordHashOf(fields), revision: ++revision }
      records.push(record)
      return Response.json({ ok: true, value: { ...record, dedup: false } })
    }
    return Response.json({ ok: false, error: { code: 'not-found', message: path } }, { status: 404 })
  }
  return { fetchImpl, records, blobs, calls, lease: () => lease }
}

/** 生成同步配置。 */
function config(temp, workspaces) {
  return {
    serverUrl: 'http://vault.test',
    token: 'token',
    passphrase: 'passphrase',
    clientId: CLIENT_ID,
    deviceName: 'Writer',
    dshHome: temp.home,
    stateDir: `${temp.home}/session-cloudsync/vault`,
    workspaces,
    dshVersion: '0.2.1-rc.2',
    dshProfile: 'web',
  }
}

test('Vault 首次写入设备台账和 workspace/profile，第二次不重复', async () => {
  const temp = createTempHome('plugin-vault')
  try {
    const server = fakeServer()
    const workspaces = [
      { path: 'D:/work/a', title: 'a' },
      { path: 'D:/work/b', title: 'b' },
    ]
    const first = await syncVault(config(temp, workspaces), undefined, server.fetchImpl)
    assert.equal(first.configured, true)
    assert.equal(first.appended, 3)
    assert.equal(server.records.length, 3)
    assert.deepEqual(server.records.map((record) => record.seq), [1, 2, 3])
    assert.equal(server.lease(), null)
    assert.ok([...server.blobs.keys()].length >= 3)

    const second = await syncVault(config(temp, workspaces), undefined, server.fetchImpl)
    assert.equal(second.appended, 0)
    assert.equal(server.records.length, 3)
  } finally {
    temp.dispose()
  }
})

test('Vault writer 租约冲突时整轮失败且不写新记录', async () => {
  const temp = createTempHome('plugin-vault-conflict')
  try {
    const server = fakeServer()
    const workspaces = [{ path: 'D:/work/a', title: 'a' }]
    const first = await syncVault(config(temp, workspaces), undefined, server.fetchImpl)
    assert.equal(first.appended, 2)

    // 清掉本地状态，强制重新判断；服务端已有 head，租约先被另一个 client 持有。
    await (await import('node:fs/promises')).rm(config(temp, workspaces).stateDir, { recursive: true, force: true })
    const original = server.fetchImpl
    const conflictFetch = async (input, init = {}) => {
      if (String(input).endsWith('/v1/vault/lease') && (init.method ?? 'GET') === 'POST') {
        return Response.json({ ok: false, error: { code: 'lease-held', message: 'held' } }, { status: 409 })
      }
      return original(input, init)
    }
    await assert.rejects(() => syncVault(config(temp, workspaces), undefined, conflictFetch), /held|租约/)
    assert.equal(server.records.length, 2)
  } finally {
    temp.dispose()
  }
})
