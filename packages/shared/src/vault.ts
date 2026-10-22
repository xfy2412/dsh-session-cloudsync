/**
 * Vault 记录原语：密钥域、确定性封帧、AAD、记录哈希与链校验。
 *
 * Vault 用于设备台账、工作区身份/绑定、agent 笔记等会话事件之外的数据。
 * 服务端只保存记录索引和密文 blob；这里的函数全部在客户端执行。
 *
 * V0 只做纯本地原语，不接 HTTP；记录链的 append/cursor 由 V1 服务端实现。
 *
 * @module @dsh-session-cloudsync/shared/vault
 */
import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto'
import { stableStringify } from './chain.ts'
import { deriveSubkey, KEY_BYTES, NONCE_BYTES, sha256, TAG_BYTES } from './crypto.ts'

/** Vault 记录的加密载荷 schema。 */
export const VAULT_SCHEMA = 'dsh-session-cloudsync/vault/1'

/** Vault 记录/信封格式版本。 */
export const VAULT_FORMAT_VERSION = 1

/** 记录 keyId 的字节长度；十六进制后为 16 个字符。 */
export const VAULT_KEY_ID_BYTES = 8

/** workspaceKey 的固定字符长度。 */
export const WORKSPACE_KEY_CHARS = 24

/** Vault 记录链的 genesis 值。 */
export const VAULT_GENESIS_HASH = null

/** V0 固定 nonce：每条记录用独立 key，nonce 全 0。 */
const FIXED_NONCE = Buffer.alloc(NONCE_BYTES)

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/u
const KIND_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u

/** 一条 Vault 记录加密前的载荷。 */
export interface VaultPayload {
  /** 载荷 schema；未知 schema 必须 fail-closed。 */
  readonly schema: string
  /** 记录类型，例如 `device/profile`、`workspace/bind`。 */
  readonly kind: string
  /** 记录实体，例如 deviceId 或 workspaceKey。 */
  readonly entity: string
  /** 客户端记录时间（epoch ms）。 */
  readonly at: number
  /** 按 kind 定义的载荷。 */
  readonly data: unknown
}

/** 服务端可见的记录索引；不含明文。 */
export interface VaultRecordRef {
  /** 信封格式版本。 */
  readonly v: number
  /** 写入者 deviceId。 */
  readonly writer: string
  /** 从 1 开始的连续序号。 */
  readonly seq: number
  /** 上一条记录的 recordHash；seq=1 为 null。 */
  readonly prevHash: string | null
  /** 密文 blob 的 SHA-256。 */
  readonly blobSha256: string
  /** 密文 blob 字节数。 */
  readonly bytes: number
  /** 记录创建时间（epoch ms）。 */
  readonly createdAt: number
  /** 封帧元数据。 */
  readonly sealed: {
    /** 封帧格式版本。 */
    readonly formatVersion: number
    /** vaultKey 的稳定标识（16 位十六进制）。 */
    readonly keyId: string
  }
  /** 本条记录索引的稳定哈希，作为下一条的 prevHash。 */
  readonly recordHash: string
}

/** 一条已封装的 Vault 记录。 */
export interface SealedVaultRecord {
  /** 服务端可见的索引。 */
  readonly ref: VaultRecordRef
  /** 密文字节（含 GCM tag）。 */
  readonly bytes: Buffer
}

/** 生成一条记录需要的输入。 */
export interface VaultRecordInput {
  readonly writer: string
  readonly seq: number
  readonly prevHash: string | null
  readonly createdAt: number
  readonly kind: string
  readonly entity: string
  readonly at: number
  readonly data: unknown
  /** 由 masterKey 派生的 Vault 密钥。 */
  readonly vaultKey: Buffer
}

/**
 * 由主密钥派生独立的 Vault 密钥域。
 * @param master - scrypt 派生的主密钥。
 * @returns 32 字节 vaultKey。
 */
export function vaultKeyOf(master: Buffer): Buffer {
  assertKey(master, 'masterKey')
  return deriveSubkey(master, 'dsh-sync/vault/v1')
}

/**
 * Vault 密钥的稳定 keyId。
 * @param vaultKey - Vault 密钥。
 * @returns 16 位小写十六进制。
 */
export function vaultKeyIdOf(vaultKey: Buffer): string {
  assertKey(vaultKey, 'vaultKey')
  return deriveSubkey(vaultKey, 'v1|key-id').subarray(0, VAULT_KEY_ID_BYTES).toString('hex')
}

/**
 * 由 canonical workspace path 派生 opaque workspaceKey。
 *
 * 调用方必须传入 DSH Workspace.path / realpath 的规范值；本函数不做平台
 * 路径归一化，避免不同调用方对同一路径产生不同 key。
 * @param vaultKey - Vault 密钥。
 * @param canonicalPath - 规范工作区路径。
 * @returns 24 字符 base64url key。
 */
export function workspaceKeyOf(vaultKey: Buffer, canonicalPath: string): string {
  assertKey(vaultKey, 'vaultKey')
  if (canonicalPath.trim() === '') throw new Error('canonical workspace path 不能为空')
  return createHmac('sha256', vaultKey)
    .update(`workspace|${canonicalPath}`, 'utf8')
    .digest('base64url')
    .slice(0, WORKSPACE_KEY_CHARS)
}

/**
 * 封装一条 Vault 记录。
 *
 * 同一 writer/seq/createdAt/载荷重封必须得到完全相同的密文字节，以便
 * append 幂等和 blob 去重。每条记录用独立的子密钥，nonce 固定为 0。
 *
 * **同一个 writer+seq 永远不能用于不同内容**：recordKey 与 nonce 都相同，
 * 复用会破坏 GCM 安全性。append 的 seq/prevHash 幂等约束必须在协议层保证。
 * @param input - 记录内容与 vaultKey。
 * @returns 索引与密文字节。
 */
export function sealVaultRecord(input: VaultRecordInput): SealedVaultRecord {
  assertKey(input.vaultKey, 'vaultKey')
  assertWriter(input.writer)
  assertSeq(input.seq)
  assertPrevHash(input.seq, input.prevHash)
  assertTimestamp(input.createdAt, 'createdAt')
  assertKind(input.kind)
  assertEntity(input.entity)
  assertTimestamp(input.at, 'at')
  if (input.data === undefined) throw new Error('Vault data 不能是 undefined')

  const payload: VaultPayload = {
    schema: VAULT_SCHEMA,
    kind: input.kind,
    entity: input.entity,
    at: input.at,
    data: input.data,
  }
  const plain = Buffer.from(stableStringify(payload), 'utf8')
  const keyId = vaultKeyIdOf(input.vaultKey)
  const key = recordKeyOf(input.vaultKey, input.writer, input.seq)
  const aad = aadOf(input.writer, input.seq, input.prevHash, VAULT_SCHEMA)
  const cipher = createCipheriv('aes-256-gcm', key, FIXED_NONCE)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  const bytes = Buffer.concat([body, cipher.getAuthTag()])
  const sealed = { formatVersion: VAULT_FORMAT_VERSION, keyId }
  const blobSha256 = sha256(bytes)
  const ref = {
    v: VAULT_FORMAT_VERSION,
    writer: input.writer,
    seq: input.seq,
    prevHash: input.prevHash,
    blobSha256,
    bytes: bytes.length,
    createdAt: input.createdAt,
    sealed,
    recordHash: vaultRecordHashOf({
      v: VAULT_FORMAT_VERSION,
      writer: input.writer,
      seq: input.seq,
      prevHash: input.prevHash,
      blobSha256,
      bytes: bytes.length,
      createdAt: input.createdAt,
      sealed,
    }),
  } satisfies VaultRecordRef
  return { ref, bytes }
}

/**
 * 校验索引并解开 Vault 记录。
 * @param record - 索引与密文字节。
 * @param vaultKey - Vault 密钥。
 * @returns 解密后的载荷。
 * @throws 索引非法、哈希不符、AAD/密钥不符或载荷 schema 非法时抛出。
 */
export function openVaultRecord(record: SealedVaultRecord, vaultKey: Buffer): VaultPayload {
  assertKey(vaultKey, 'vaultKey')
  assertVaultRecordRef(record.ref)
  if (!Buffer.isBuffer(record.bytes)) throw new Error('Vault 密文必须是 Buffer')
  if (record.bytes.length !== record.ref.bytes) throw new Error('Vault 密文字节数与索引不一致')
  if (sha256(record.bytes) !== record.ref.blobSha256) throw new Error('Vault 密文哈希与索引不一致')
  if (vaultKeyIdOf(vaultKey) !== record.ref.sealed.keyId) throw new Error('Vault keyId 不匹配')

  const key = recordKeyOf(vaultKey, record.ref.writer, record.ref.seq)
  if (record.bytes.length < TAG_BYTES) throw new Error('Vault 密文过短')
  const body = record.bytes.subarray(0, record.bytes.length - TAG_BYTES)
  const tag = record.bytes.subarray(record.bytes.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, FIXED_NONCE)
  decipher.setAAD(aadOf(record.ref.writer, record.ref.seq, record.ref.prevHash, VAULT_SCHEMA))
  decipher.setAuthTag(tag)
  let parsed: unknown
  try {
    const plain = Buffer.concat([decipher.update(body), decipher.final()])
    parsed = JSON.parse(plain.toString('utf8'))
  } catch (error: unknown) {
    throw new Error(`Vault 记录解密失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Vault 载荷不是对象')
  const payload = parsed as Record<string, unknown>
  if (payload['schema'] !== VAULT_SCHEMA) throw new Error(`未知 Vault schema：${String(payload['schema'])}`)
  if (typeof payload['kind'] !== 'string' || !KIND_PATTERN.test(payload['kind'])) throw new Error('Vault kind 非法')
  if (typeof payload['entity'] !== 'string' || payload['entity'].trim() === '') throw new Error('Vault entity 非法')
  if (!Number.isSafeInteger(payload['at'])) throw new Error('Vault at 非法')
  if (payload['data'] === undefined) throw new Error('Vault data 缺失')
  return {
    schema: payload['schema'],
    kind: payload['kind'],
    entity: payload['entity'],
    at: payload['at'] as number,
    data: payload['data'],
  }
}

/**
 * 校验一条记录索引的形状与自身 recordHash。
 * @param ref - 记录索引。
 * @throws 字段非法或 recordHash 不匹配时抛出。
 */
export function assertVaultRecordRef(ref: VaultRecordRef): void {
  if (ref.v !== VAULT_FORMAT_VERSION) throw new Error(`Vault 记录版本非法：${String(ref.v)}`)
  assertWriter(ref.writer)
  assertSeq(ref.seq)
  assertPrevHash(ref.seq, ref.prevHash)
  if (!HASH_PATTERN.test(ref.blobSha256)) throw new Error('Vault blobSha256 非法')
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) throw new Error('Vault bytes 非法')
  assertTimestamp(ref.createdAt, 'createdAt')
  if (ref.sealed === null || typeof ref.sealed !== 'object') throw new Error('Vault sealed 非法')
  if (ref.sealed.formatVersion !== VAULT_FORMAT_VERSION) throw new Error('Vault sealed.formatVersion 非法')
  if (!KEY_ID_PATTERN.test(ref.sealed.keyId)) throw new Error('Vault sealed.keyId 非法')
  if (!HASH_PATTERN.test(ref.recordHash)) throw new Error('Vault recordHash 非法')
  const expected = vaultRecordHashOf(ref)
  if (expected !== ref.recordHash) throw new Error('Vault recordHash 与索引内容不一致')
}

/**
 * 校验一条按 seq 升序排列的 Vault 记录链。
 *
 * 只校验索引与链，不下载/解密 blob；密文完整性由 openVaultRecord 负责。
 * @param records - 从 seq=1 开始的完整记录索引。
 * @throws 序号跳变、writer 混用、prevHash/recordHash 不匹配时抛出。
 */
export function verifyVaultChain(records: readonly VaultRecordRef[]): void {
  let previous: VaultRecordRef | undefined
  records.forEach((ref, index) => {
    const expectedSeq = index + 1
    if (ref.seq !== expectedSeq) throw new Error(`Vault seq 应为 ${expectedSeq}，实际是 ${ref.seq}`)
    assertVaultRecordRef(ref)
    if (previous === undefined) {
      if (ref.prevHash !== VAULT_GENESIS_HASH) throw new Error('Vault 链首条记录的 prevHash 必须为 null')
    } else {
      if (ref.writer !== previous.writer) throw new Error('Vault 链混用了不同 writer')
      if (ref.prevHash !== previous.recordHash) throw new Error(`Vault 第 ${ref.seq} 条的 prevHash 不匹配`)
    }
    previous = ref
  })
}

function recordKeyOf(vaultKey: Buffer, writer: string, seq: number): Buffer {
  return deriveSubkey(vaultKey, `v1|vault-record:${writer}:${seq}`)
}

function aadOf(writer: string, seq: number, prevHash: string | null, schema: string): Buffer {
  return Buffer.from(stableStringify({
    v: VAULT_FORMAT_VERSION,
    writer,
    seq,
    prevHash,
    schema,
  }), 'utf8')
}

/**
 * 由记录索引字段计算 recordHash；不包含 recordHash 自身。
 * @param ref - 除 recordHash 外的索引字段。
 * @returns 64 位小写十六进制哈希。
 */
export function vaultRecordHashOf(ref: Omit<VaultRecordRef, 'recordHash'>): string {
  return sha256(stableStringify({
    v: ref.v,
    writer: ref.writer,
    seq: ref.seq,
    prevHash: ref.prevHash,
    blobSha256: ref.blobSha256,
    bytes: ref.bytes,
    createdAt: ref.createdAt,
    sealed: ref.sealed,
  }))
}

function assertKey(key: Buffer, name: string): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error(`${name} 必须是 ${KEY_BYTES} 字节`)
}

function assertWriter(writer: string): void {
  if (typeof writer !== 'string' || writer.length === 0 || writer.length > 128) throw new Error('Vault writer 非法')
  for (const character of writer) {
    if (character.charCodeAt(0) < 0x21 || character.charCodeAt(0) > 0x7e) throw new Error('Vault writer 含非法字符')
  }
}

function assertSeq(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Vault seq 必须是正整数')
}

function assertPrevHash(seq: number, prevHash: string | null): void {
  if (seq === 1) {
    if (prevHash !== VAULT_GENESIS_HASH) throw new Error('Vault seq=1 的 prevHash 必须为 null')
    return
  }
  if (prevHash === null || !HASH_PATTERN.test(prevHash)) throw new Error('Vault prevHash 非法')
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Vault ${name} 非法`)
}

function assertKind(kind: string): void {
  if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) throw new Error('Vault kind 非法')
}

function assertEntity(entity: string): void {
  if (typeof entity !== 'string' || entity.trim() === '' || entity.length > 512) throw new Error('Vault entity 非法')
}
