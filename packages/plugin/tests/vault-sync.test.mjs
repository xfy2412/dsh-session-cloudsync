import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import { syncVault, readWorkspaceProfileLabels, vaultKeyForConfig } from '../src/vault-sync.ts'
import { openVaultRecord, vaultRecordHashOf } from '../../shared/src/vault.ts'
import { decodeBlobBatch, encodeBlobBatch } from '../../shared/src/blob-batch.ts'

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
    if (path === '/v2/me') {
      return Response.json({ ok: true, value: { role: 'device', device: { deviceId: WRITER, label: 'Writer' } } })
    }
    if (path === '/v2/vault/stream/device-vault-1') {
      const from = Number(url.searchParams.get('from') ?? 1)
      const matching = records.filter((record) => record.seq >= from)
      return Response.json({ ok: true, value: { writer: WRITER, records: matching, hasMore: false } })
    }
    if (path === '/v2/vault/lease' && method === 'POST') {
      const client = String(init.headers?.['x-client-id'] ?? '')
      if (lease !== null && lease !== client) return Response.json({ ok: false, error: { code: 'lease-held', message: 'held' } }, { status: 409 })
      lease = client
      return Response.json({ ok: true, value: { resource: 'vault-writer:test', acquired: true } })
    }
    if (path === '/v2/vault/lease' && method === 'DELETE') {
      lease = null
      return Response.json({ ok: true, value: { released: true } })
    }
    if (path === '/v2/blobs' && method === 'POST') {
      const bytes = Buffer.from(init.body)
      const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
      blobs.set(sha256, bytes)
      return Response.json({ ok: true, value: { sha256, bytes: bytes.length, dedup: false } }, { status: 201 })
    }
    if (path === '/v2/blobs/batch' && method === 'POST') {
      const entries = decodeBlobBatch(Buffer.from(init.body))
      for (const entry of entries) blobs.set(entry.sha256, entry.data)
      return Response.json({ ok: true, value: { blobs: entries.map((entry) => ({
        sha256: entry.sha256, bytes: entry.data.length, dedup: false,
      })) } }, { status: 201 })
    }
    if (path === '/v2/blobs/batch/read' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      const entries = (Array.isArray(body.sha256) ? body.sha256 : []).map((sha256) => {
        const data = blobs.get(sha256)
        if (data === undefined) throw new Error(`missing blob ${sha256}`)
        return { kind: 'vault', data }
      })
      return new Response(encodeBlobBatch(entries), {
        status: 200,
        headers: { 'content-type': 'application/x-dsh-blob-batch' },
      })
    }
    if (path.startsWith('/v2/blobs/') && method === 'GET') {
      const sha256 = path.slice('/v2/blobs/'.length)
      const bytes = blobs.get(sha256)
      if (bytes === undefined) return Response.json({ ok: false, error: { code: 'not-found', message: sha256 } }, { status: 404 })
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    if (path === '/v2/vault/cursor' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0)
      const matching = records.filter((record) => record.revision > since)
      return Response.json({ ok: true, value: { revision: revision, records: matching, hasMore: false } })
    }
    if (path === '/v2/vault/append' && method === 'POST') {
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
    assert.ok(server.calls.includes('POST /v2/blobs/batch'))

    const cfg = config(temp, workspaces)
    const deviceRecord = server.records[0]
    const payload = openVaultRecord({
      ref: deviceRecord,
      bytes: server.blobs.get(deviceRecord.blobSha256),
    }, vaultKeyForConfig(cfg))
    assert.equal(payload.kind, 'device/profile')
    assert.deepEqual(Object.keys(payload.data).sort(), ['deviceId', 'deviceName', 'dsh', 'lastSeenAt', 'os'])
    assert.equal('dshHome' in payload.data, false)
    assert.equal('workspaces' in payload.data, false)
    assert.equal('node' in payload.data.dsh, false)

    const second = await syncVault(config(temp, workspaces), undefined, server.fetchImpl)
    assert.equal(second.appended, 0)
    assert.equal(server.records.length, 3)
  } finally {
    temp.dispose()
  }
})

test('读取远端 workspace/profile label', async () => {
  const temp = createTempHome('plugin-vault-labels')
  try {
    const server = fakeServer()
    const workspaces = [
      { path: 'D:/work/a', title: 'alpha' },
      { path: 'D:/work/b', title: 'beta' },
    ]
    const cfg = config(temp, workspaces)
    await syncVault(cfg, undefined, server.fetchImpl)
    const result = await readWorkspaceProfileLabels(cfg, server.fetchImpl)
    assert.deepEqual(Object.values(result.labels).sort(), ['alpha', 'beta'])
    assert.equal(result.revision, server.records.length)
  } finally {
    temp.dispose()
  }
})

test('Vault 设备快照带插件列表，读端返回其他设备的 plugins', async () => {
  const temp = createTempHome('plugin-vault-devices')
  try {
    const server = fakeServer()
    const cfg = config(temp, [{ path: 'D:/work/a', title: 'a' }])
    await syncVault({
      ...cfg,
      plugins: [{ name: 'dsh-context', version: '1.3.0', source: 'dsh-context@1.3.0', enabled: true }],
    }, undefined, server.fetchImpl)
    const result = await readWorkspaceProfileLabels(cfg, server.fetchImpl)
    assert.equal(result.devices.length, 1)
    assert.equal(result.devices[0].deviceId, WRITER)
    assert.equal(result.devices[0].name, 'Writer')
    assert.deepEqual(result.devices[0].plugins, [
      { name: 'dsh-context', version: '1.3.0', source: 'dsh-context@1.3.0', enabled: true },
    ])
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
      if (String(input).endsWith('/v2/vault/lease') && (init.method ?? 'GET') === 'POST') {
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

test('workspace/profile 带来源路径，读取端返回 paths', async () => {
  const temp = createTempHome('plugin-vault-path')
  try {
    const server = fakeServer()
    const workspaces = [
      { path: 'D:/work/a', title: 'alpha' },
      { path: 'D:/work/b', title: 'beta' },
    ]
    const cfg = config(temp, workspaces)
    await syncVault(cfg, undefined, server.fetchImpl)
    const result = await readWorkspaceProfileLabels(cfg, server.fetchImpl)
    const paths = Object.values(result.paths).sort()
    assert.deepEqual(paths, ['D:/work/a', 'D:/work/b'])
  } finally {
    temp.dispose()
  }
})

test('老状态没有 workspacePaths 时补写一次 path，之后不再重复', async () => {
  const temp = createTempHome('plugin-vault-path-upgrade')
  try {
    const server = fakeServer()
    const workspaces = [{ path: 'D:/work/a', title: 'alpha' }]
    const cfg = config(temp, workspaces)
    await syncVault(cfg, undefined, server.fetchImpl)
    const before = server.records.length

    // 模拟旧版本客户端留下的状态：去掉 workspacePaths，保留 workspaces。
    const stateFile = cfg.stateDir + '/state.json'
    const fs = await import('node:fs/promises')
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    delete state.workspacePaths
    await fs.writeFile(stateFile, JSON.stringify(state), 'utf8')

    const upgraded = await syncVault(cfg, undefined, server.fetchImpl)
    assert.equal(upgraded.appended, 1)
    assert.equal(server.records.length, before + 1)

    const again = await syncVault(cfg, undefined, server.fetchImpl)
    assert.equal(again.appended, 0)
  } finally {
    temp.dispose()
  }
})
