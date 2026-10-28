/**
 * 宿主侧 Vault 同步：设备台账与 workspace/profile 的 append。
 *
 * V1 只做最小集合：
 * - 自己的 `device/profile` 快照（内容变化才写）；
 * - 已选工作区的 `workspace/profile`（首次出现才写）；
 * - 写入前读取服务端 writer head，用 `vault-writer` 租约串行 append。
 *
 * 失败只影响 Vault，不阻塞会话同步；调用方负责记录日志。
 *
 * @module dsh-session-cloudsync/vault-sync
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BLOB_BATCH_CONTENT_TYPE,
  BLOB_BATCH_ENTRY_HEADER_BYTES,
  BLOB_BATCH_HEADER_BYTES,
  decodeBlobBatch,
  encodeBlobBatch,
  MAX_BATCH_BLOBS,
  MAX_BATCH_BODY_BYTES,
} from '../../shared/src/blob-batch.ts'
import { deriveMasterKey, sha256 } from '../../shared/src/crypto.ts'
import { stableStringify } from '../../shared/src/chain.ts'
import {
  openVaultRecord,
  sealVaultRecord,
  vaultKeyOf,
  workspaceKeyOf,
  type VaultRecordRef,
} from '../../shared/src/vault.ts'

/** Vault 同步配置。 */
export interface VaultSyncConfig {
  readonly serverUrl: string
  readonly token: string
  readonly passphrase: string
  readonly salt?: string
  readonly clientId: string
  readonly requestTimeoutMs?: number
  readonly deviceName: string
  readonly dshHome: string
  readonly stateDir: string
  readonly workspaces: readonly { readonly path: string; readonly title: string }[]
  readonly dshVersion?: string
  readonly dshProfile?: string
}

/** Vault 同步日志接口。 */
export interface VaultSyncLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 一次 Vault 同步的结果。 */
export interface VaultSyncResult {
  readonly configured: boolean
  readonly writer: string | null
  readonly appended: number
  readonly reason?: string
}

interface VaultState {
  readonly version: 1
  readonly writer: string
  readonly seq: number
  readonly prevHash: string | null
  readonly deviceDigest: string | null
  readonly workspaces: Record<string, string>
}

interface DeviceMe {
  readonly deviceId: string
  readonly label: string
}

/**
 * 执行一次 Vault 同步。
 * @param config - 服务端、设备和本地路径。
 * @param logger - 可选日志。
 * @param fetchImpl - 可替换的 fetch（测试）。
 * @returns 同步结果。
 */
export async function syncVault(
  config: VaultSyncConfig,
  logger?: VaultSyncLogger,
  fetchImpl: typeof fetch = fetch,
): Promise<VaultSyncResult> {
  if (config.serverUrl.trim() === '' || config.token.trim() === '' || config.passphrase === '') {
    return { configured: false, writer: null, appended: 0, reason: 'serverUrl / token / passphrase 未配置全' }
  }
  if (config.clientId === '') return { configured: false, writer: null, appended: 0, reason: 'clientId 未配置' }
  const base = config.serverUrl.trim().replace(/\/+$/u, '')
  if (base === '') return { configured: false, writer: null, appended: 0, reason: 'serverUrl 非法' }

  const master = masterKeyOf(config, base)
  const vaultKey = vaultKeyOf(master)
  const timedFetch = withTimeout(fetchImpl, config.requestTimeoutMs ?? 10_000)
  const me = await readMe(base, config.token, timedFetch)
  const writer = me.deviceId
  const statePath = join(config.stateDir, 'state.json')
  await mkdir(dirname(statePath), { recursive: true })
  const lockPath = join(config.stateDir, 'writer.lock')

  return withWriterLock(lockPath, config.clientId, async () => {
    const previous = await readState(statePath)
    const state = await reconcileHead(base, config, writer, previous, timedFetch)
    let seq = state.seq
    let prevHash = state.prevHash
    let appended = 0

    const now = Date.now()
    const workspaces = config.workspaces.map((workspace) => ({
      key: workspaceKeyOf(vaultKey, workspace.path),
      label: workspace.title,
      path: workspace.path,
    }))
    const payload = {
      deviceId: writer,
      deviceName: config.deviceName === '' ? me.label : config.deviceName,
      os: { platform: platform(), arch: arch(), release: release() },
      dsh: {
        version: config.dshVersion ?? process.env.DSH_VERSION ?? 'unknown',
        profile: config.dshProfile ?? process.env.DSH_PROFILE ?? '',
        node: process.version,
        sessionFormatVersion: 4,
      },
      workspaces,
      dshHome: config.dshHome,
    }
    const digest = sha256(stableStringify(payload))
    const pending: Array<{ kind: string; entity: string; data: unknown }> = []
    if (state.deviceDigest !== digest) {
      pending.push({ kind: 'device/profile', entity: writer, data: { ...payload, lastSeenAt: now } })
    }
    for (const workspace of workspaces) {
      if (state.workspaces[workspace.key] !== undefined) continue
      pending.push({
        kind: 'workspace/profile',
        entity: workspace.key,
        data: { key: workspace.key, label: workspace.label, createdAt: now, lastSeenAt: now },
      })
    }

    if (pending.length === 0) {
      await writeState(statePath, { ...state, deviceDigest: digest })
      return { configured: true, writer, appended: 0 }
    }

    await acquireWriterLease(base, config.token, config.clientId, timedFetch)
    try {
      let nextState: VaultState = {
        ...state,
        deviceDigest: state.deviceDigest,
        workspaces: { ...state.workspaces },
      }
      // 先按本地链规划所有记录，再批量上传 blob，最后逐条 append；append 失败时
      // 已上传的 blob 成为可去重的孤儿，但不会把半条记录索引写进服务端。
      const planned: Array<{ readonly entry: (typeof pending)[number]; readonly sealed: ReturnType<typeof sealVaultRecord> }> = []
      let planSeq = seq
      let planPrevHash = prevHash
      for (const entry of pending) {
        const sealed = sealVaultRecord({
          writer,
          seq: planSeq + 1,
          prevHash: planPrevHash,
          createdAt: Date.now(),
          kind: entry.kind,
          entity: entry.entity,
          at: Date.now(),
          data: entry.data,
          vaultKey,
        })
        planSeq = sealed.ref.seq
        planPrevHash = sealed.ref.recordHash
        planned.push({ entry, sealed })
      }
      for (const group of vaultBlobGroups(planned.map((item) => item.sealed.bytes))) {
        await uploadVaultBlobs(base, config.token, group, timedFetch)
      }
      for (const { entry, sealed } of planned) {
        const response = await requestJson(base, '/v2/vault/append', config.token, timedFetch, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-client-id': config.clientId },
          body: JSON.stringify({
            writer,
            seq: sealed.ref.seq,
            prevHash: sealed.ref.prevHash,
            blobSha256: sealed.ref.blobSha256,
            bytes: sealed.ref.bytes,
            createdAt: sealed.ref.createdAt,
            sealed: sealed.ref.sealed,
          }),
        })
        const record = response.value as VaultRecordRef
        seq = record.seq
        prevHash = record.recordHash
        appended += 1
        const nextWorkspaces = { ...nextState.workspaces }
        if (entry.kind === 'workspace/profile') {
          nextWorkspaces[entry.entity] = String((entry.data as { label?: unknown }).label ?? '')
        }
        nextState = {
          version: 1,
          writer,
          seq,
          prevHash,
          deviceDigest: entry.kind === 'device/profile' ? digest : nextState.deviceDigest,
          workspaces: nextWorkspaces,
        }
        await writeState(statePath, nextState)
      }
    } finally {
      await releaseWriterLease(base, config.token, config.clientId, timedFetch).catch(() => undefined)
    }
    logger?.info(`dsh-session-cloudsync: Vault 已追加 ${appended} 条`)
    return { configured: true, writer, appended }
  })
}

/**
 * 由已有 writer head 对齐本地状态。
 * @param base - 服务端地址。
 * @param config - 配置。
 * @param writer - 设备 id。
 * @param previous - 之前状态。
 * @param fetchImpl - fetch。
 * @returns 与服务端一致的本地状态。
 */
async function reconcileHead(
  base: string,
  config: VaultSyncConfig,
  writer: string,
  previous: VaultState | undefined,
  fetchImpl: typeof fetch,
): Promise<VaultState> {
  let from = 1
  let last: VaultRecordRef | undefined
  for (let page = 0; page < 100; page += 1) {
    const response = await requestJson(
      base,
      `/v2/vault/stream/${encodeURIComponent(writer)}?from=${from}&limit=500`,
      config.token,
      fetchImpl,
      { method: 'GET' },
    )
    const records = (response.value as { records?: unknown }).records
    if (!Array.isArray(records) || records.length === 0) break
    last = records[records.length - 1] as VaultRecordRef
    if ((response.value as { hasMore?: unknown }).hasMore !== true) break
    from = last.seq + 1
  }
  if (last === undefined) {
    return { version: 1, writer, seq: 0, prevHash: null, deviceDigest: null, workspaces: {} }
  }
  if (previous !== undefined && previous.writer === writer && previous.seq === last.seq && previous.prevHash === last.recordHash) {
    return previous
  }
  return {
    version: 1,
    writer,
    seq: last.seq,
    prevHash: last.recordHash,
    deviceDigest: previous?.writer === writer ? previous.deviceDigest : null,
    workspaces: previous?.writer === writer ? previous.workspaces : {},
  }
}

/**
 * 读取当前设备身份。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param fetchImpl - fetch。
 * @returns deviceId 与服务端 label。
 */
async function readMe(base: string, token: string, fetchImpl: typeof fetch): Promise<DeviceMe> {
  const response = await requestJson(base, '/v2/me', token, fetchImpl, { method: 'GET' })
  const value = response.value as { role?: unknown; device?: unknown }
  if (value.role !== 'device' || value.device === null || typeof value.device !== 'object') {
    throw new Error('Vault 需要设备 token')
  }
  const device = value.device as Record<string, unknown>
  if (typeof device.deviceId !== 'string' || typeof device.label !== 'string') throw new Error('/v2/me 缺少设备身份')
  return { deviceId: device.deviceId, label: device.label }
}

/** 读取本地 Vault 状态；损坏视为空。 */
async function readState(path: string): Promise<VaultState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (parsed['version'] !== 1
      || typeof parsed['writer'] !== 'string'
      || !Number.isSafeInteger(parsed['seq'])
      || (parsed['prevHash'] !== null && typeof parsed['prevHash'] !== 'string')
      || (parsed['deviceDigest'] !== null && typeof parsed['deviceDigest'] !== 'string')
      || parsed['workspaces'] === null || typeof parsed['workspaces'] !== 'object') return undefined
    return {
      version: 1,
      writer: parsed['writer'],
      seq: parsed['seq'] as number,
      prevHash: parsed['prevHash'] as string | null,
      deviceDigest: parsed['deviceDigest'] as string | null,
      workspaces: parsed['workspaces'] as Record<string, string>,
    }
  } catch {
    return undefined
  }
}

/** 原子写状态。 */
async function writeState(path: string, state: VaultState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/** 拿到 writer 租约。 */
async function acquireWriterLease(base: string, token: string, clientId: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await requestJson(base, '/v2/vault/lease', token, fetchImpl, {
    method: 'POST',
    headers: { 'x-client-id': clientId },
  })
  if (response.ok !== true) throw new Error('Vault writer 租约被占用')
}

/** 释放 writer 租约。 */
async function releaseWriterLease(base: string, token: string, clientId: string, fetchImpl: typeof fetch): Promise<void> {
  await requestJson(base, '/v2/vault/lease', token, fetchImpl, {
    method: 'DELETE',
    headers: { 'x-client-id': clientId },
  })
}

/** 上传 Vault 密文。 */
async function uploadVaultBlob(base: string, token: string, bytes: Buffer, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(`${base}/v2/blobs?kind=vault`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  if (response.status !== 200 && response.status !== 201) throw new Error(`Vault blob 上传失败：HTTP ${response.status}`)
}

/**
 * 批量上传 Vault 密文；单条回退单 blob 接口。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param blobs - 已封好的记录字节。
 * @param fetchImpl - fetch。
 */
async function uploadVaultBlobs(
  base: string,
  token: string,
  blobs: readonly Buffer[],
  fetchImpl: typeof fetch,
): Promise<void> {
  if (blobs.length <= 1) {
    if (blobs[0] !== undefined) await uploadVaultBlob(base, token, blobs[0], fetchImpl)
    return
  }
  const response = await fetchImpl(`${base}/v2/blobs/batch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': BLOB_BATCH_CONTENT_TYPE,
    },
    body: encodeBlobBatch(blobs.map((data) => ({ kind: 'vault', data }))),
  })
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Vault 批量 blob 上传失败：HTTP ${response.status}`)
  }
}

/**
 * 按 64 条 / 8 MiB 分组。
 * @param blobs - 待上传字节。
 * @returns 分组。
 */
function vaultBlobGroups(blobs: readonly Buffer[]): Buffer[][] {
  const groups: Buffer[][] = []
  let group: Buffer[] = []
  let bytes = BLOB_BATCH_HEADER_BYTES
  for (const blob of blobs) {
    const size = BLOB_BATCH_ENTRY_HEADER_BYTES + blob.length
    if (group.length > 0 && (group.length >= MAX_BATCH_BLOBS || bytes + size > MAX_BATCH_BODY_BYTES)) {
      groups.push(group)
      group = []
      bytes = BLOB_BATCH_HEADER_BYTES
    }
    group.push(blob)
    bytes += size
  }
  if (group.length > 0) groups.push(group)
  return groups
}

/**
 * 批量下载 Vault 密文；单条回退单 blob 接口。
 * @param base - 服务端地址。
 * @param token - 设备 token。
 * @param hashes - 记录 blobSha256。
 * @param fetchImpl - fetch。
 * @returns 按哈希索引的字节。
 */
async function downloadVaultBlobs(
  base: string,
  token: string,
  hashes: readonly string[],
  fetchImpl: typeof fetch,
): Promise<Map<string, Buffer>> {
  const unique = [...new Set(hashes)]
  if (unique.length === 0) return new Map()
  if (unique.length === 1) {
    const response = await fetchImpl(`${base}/v2/blobs/${unique[0]}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`Vault blob ${unique[0]} 下载失败：HTTP ${response.status}`)
    return new Map([[unique[0]!, Buffer.from(await response.arrayBuffer())]])
  }
  const response = await fetchImpl(`${base}/v2/blobs/batch/read`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sha256: unique }),
  })
  if (!response.ok) throw new Error(`Vault 批量 blob 下载失败：HTTP ${response.status}`)
  const result = new Map<string, Buffer>()
  for (const entry of decodeBlobBatch(Buffer.from(await response.arrayBuffer()))) {
    if (sha256(entry.data) !== entry.sha256) throw new Error(`Vault 批量 blob ${entry.sha256} 内容哈希不符`)
    result.set(entry.sha256, entry.data)
  }
  return result
}

/** 带超时与统一 JSON 错误处理的请求。 */
async function requestJson(
  base: string,
  path: string,
  token: string,
  fetchImpl: typeof fetch,
  init: RequestInit,
): Promise<{ ok: boolean; value: unknown; status: number }> {
  const response = await fetchImpl(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  })
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    throw new Error(`Vault 响应不是 JSON：HTTP ${response.status}`)
  }
  const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
  if (!response.ok || record['ok'] !== true) {
    const error = record['error'] as Record<string, unknown> | undefined
    throw new Error(typeof error?.message === 'string' ? error.message : `Vault HTTP ${response.status}`)
  }
  return { ok: true, value: record['value'], status: response.status }
}

/** 由配置派生 vaultKey；供 host 的 workspaceKey 解析复用。 */
export function vaultKeyForConfig(config: Pick<VaultSyncConfig, 'serverUrl' | 'passphrase' | 'salt'>): Buffer {
  const base = config.serverUrl.trim().replace(/\/+$/u, '')
  if (base === '') throw new Error('serverUrl 非法')
  return vaultKeyOf(masterKeyOf(config, base))
}

/** 远端 workspace/profile 的 label 缓存。 */
export interface WorkspaceProfileLabels {
  readonly labels: Record<string, string>
  readonly revision: number
}

/**
 * 读取远端 Vault 里的 workspace/profile label。
 * 只取最新的 workspace/profile 记录；坏记录跳过，不影响其他 label。
 * @param config - Vault 配置。
 * @param fetchImpl - fetch 实现。
 * @returns workspaceKey → label 与最后 revision。
 */
export async function readWorkspaceProfileLabels(
  config: VaultSyncConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceProfileLabels> {
  const base = config.serverUrl.trim().replace(/\/+$/u, '')
  if (base === '') throw new Error('serverUrl 非法')
  const vaultKey = vaultKeyOf(masterKeyOf(config, base))
  const labels: Record<string, { label: string; at: number }> = {}
  let since = 0
  for (let page = 0; page < 50; page += 1) {
    const cursor = await requestJson(base, `/v2/vault/cursor?since=${since}&limit=500`, config.token, fetchImpl, { method: 'GET' })
    const value = cursor.value as {
      readonly revision?: unknown
      readonly records?: unknown
      readonly hasMore?: unknown
    } | undefined
    const records = Array.isArray(value?.records) ? value.records as VaultRecordRef[] : []
    const blobs = new Map<string, Buffer>()
    for (let offset = 0; offset < records.length; offset += MAX_BATCH_BLOBS) {
      const group = records.slice(offset, offset + MAX_BATCH_BLOBS)
      try {
        const downloaded = await downloadVaultBlobs(
          base,
          config.token,
          group.map((record) => record.blobSha256),
          fetchImpl,
        )
        for (const [hash, bytes] of downloaded) blobs.set(hash, bytes)
      } catch {
        // 一整组坏记录不影响其他 workspace；下次刷新会重试。
      }
    }
    for (const record of records) {
      try {
        const bytes = blobs.get(record.blobSha256)
        if (bytes === undefined) continue
        const payload = openVaultRecord({ ref: record, bytes }, vaultKey)
        if (payload.kind !== 'workspace/profile') continue
        const data = payload.data as { readonly label?: unknown } | undefined
        if (typeof data?.label !== 'string' || data.label.trim() === '') continue
        const at = Number.isSafeInteger(payload.at) ? payload.at : record.createdAt
        const previous = labels[payload.entity]
        if (previous === undefined || at >= previous.at) labels[payload.entity] = { label: data.label, at }
      } catch {
        // 单个坏记录不影响其他 workspace；下次刷新会重试。
      }
    }
    const revision = typeof value?.revision === 'number' ? value.revision : since
    since = Math.max(since, revision)
    if (value?.hasMore !== true || revision <= 0) break
  }
  return {
    labels: Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, value.label])),
    revision: since,
  }
}

/** 由配置派生 masterKey。 */
function masterKeyOf(config: Pick<VaultSyncConfig, 'passphrase' | 'salt'>, base: string): Buffer {
  const salt = config.salt === undefined || config.salt === ''
    ? Buffer.from(sha256(`dsh-session-cloudsync/v1|${base}`).slice(0, 32), 'hex')
    : Buffer.from(config.salt, 'base64')
  if (salt.length !== 16) throw new Error('Vault salt 必须是 base64 的 16 字节值')
  return deriveMasterKey(config.passphrase, salt)
}

/** 包裹 fetch 的读取超时。 */
function withTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signal = init?.signal ?? AbortSignal.timeout(timeoutMs)
    return fetchImpl(input, { ...init, signal })
  }) as typeof fetch
}

/** 单进程 writer 锁。 */
async function withWriterLock<T>(path: string, clientId: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true })
  let locked = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, clientId, at: Date.now() }), { flag: 'wx', encoding: 'utf8' })
      locked = true
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let holder: { pid?: unknown; clientId?: unknown } = {}
      try {
        holder = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; clientId?: unknown }
      } catch {
        // 损坏的锁按 stale 处理。
      }
      if (typeof holder.pid === 'number' && isAlive(holder.pid) && holder.clientId === clientId) {
        throw new Error('Vault writer 锁被另一个 DSH 进程持有')
      }
      await unlink(path).catch(() => undefined)
    }
  }
  if (!locked) throw new Error('无法取得 Vault writer 锁')
  try {
    return await run()
  } finally {
    let holder: { clientId?: unknown } = {}
    try {
      holder = JSON.parse(await readFile(path, 'utf8')) as { clientId?: unknown }
    } catch {
      // 已经不存在。
    }
    if (holder.clientId === clientId) await unlink(path).catch(() => undefined)
  }
}

/** 判断 pid 是否存活。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
