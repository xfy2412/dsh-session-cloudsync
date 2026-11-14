import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { decodeBlobBatch } from '../../shared/src/blob-batch.ts'
import { deriveMasterKey, newSalt } from '../../shared/src/crypto.ts'
import { blobPath, putBlob } from '../src/blobs.ts'
import { createDevice } from '../src/http.ts'
import { markAdminInitialized, openDatabase, setAdminPassword, usedBlobBytes } from '../src/db.ts'
import { MAX_FRAME_ATTACHMENT_BLOBS } from '../src/sessions.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import { listenServer } from './listen.mjs'

/**
 * 发一个带设备 token 的 JSON 请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - token、cookie、方法与 JSON 体。
 * @returns 状态码与解析后的响应体。
 */
async function call(base, path, options = {}) {
  const headers = { 'x-client-id': '0123456789abcdef', ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  if (options.cookie !== undefined) headers.cookie = options.cookie
  let body = options.body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers, body })
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) }
}

/**
 * 上传一个单条 blob。
 * @param base - 基地址。
 * @param token - 设备 token。
 * @param kind - blob 类别。
 * @param bytes - 密文字节。
 * @returns 内容地址与状态码。
 */
async function uploadBlob(base, token, kind, bytes) {
  const response = await fetch(`${base}/v2/blobs?kind=${kind}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-client-id': '0123456789abcdef' },
    body: bytes,
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/**
 * 取响应里的 cookie 片段。
 * @param headers - 响应头。
 * @param name - cookie 名。
 * @returns `name=value`，或 undefined。
 */
function cookieOf(headers, name) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? '']
  const found = list.find((entry) => entry.startsWith(`${name}=`))
  return found?.split(';')[0]
}

/**
 * 生成摘要。
 * @param value - 输入。
 * @returns 64 位小写十六进制。
 */
function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 造一个满足服务端校验的封帧条目。
 * @param index - 帧下标。
 * @param seqFrom - 起始 seq。
 * @param seqTo - 结束 seq。
 * @param bytes - 对应的 blob 字节。
 * @param extra - 追加的附件字段。
 * @returns 帧引用。
 */
function frameRef(index, seqFrom, seqTo, bytes, extra = {}) {
  return {
    index,
    chainHash: digest(`chain-${index}`),
    blobSha256: digest(bytes),
    bytes: bytes.length,
    sealedVersion: 1,
    keyId: '0'.repeat(16),
    seqFrom,
    seqTo,
    ...extra,
  }
}

/**
 * 造一个最小 append 体。
 * @param createdAt - 生命周期时间。
 * @param refs - 帧引用。
 * @returns 请求体。
 */
function appendBody(createdAt, refs) {
  return { baseIndex: -1, baseChainHash: null, createdAt, formatVersion: 4, batches: refs }
}

test('附件索引与附件密文随批次同步，可回读并按批次下载', async () => {
  const temp = createTempHome('server-v2-attachments')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'attachments')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const health = await call(base, '/health')
      assert.ok(health.body.server.capabilities.includes('attachment-index'))

      const sessionId = 'session-attachments'
      const createdAt = 1000
      const headerBytes = Buffer.from('header-payload')
      const eventBytes = Buffer.from('event-payload')
      const imageBytes = Buffer.from('sealed-image')
      const fileBytes = Buffer.from('sealed-file')
      const indexBytes = Buffer.from('sealed-attachment-index')
      for (const [kind, bytes] of [['frame', headerBytes], ['frame', eventBytes], ['attachment', imageBytes], ['attachment', fileBytes], ['attachment-index', indexBytes]]) {
        const uploaded = await uploadBlob(base, device.token, kind, bytes)
        assert.equal(uploaded.status, 201)
      }

      assert.equal((await call(base, '/v2/sync/lease', { method: 'POST', token: device.token })).status, 200)
      const refs = [
        frameRef(0, -1, -1, headerBytes),
        frameRef(1, 0, 3, eventBytes, {
          attachmentIndexSha256: digest(indexBytes),
          attachmentBlobs: [digest(imageBytes), digest(fileBytes)],
        }),
      ]
      const created = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'attachment-group-1' },
        json: appendBody(createdAt, refs),
      })
      assert.equal(created.status, 200)

      const manifest = await call(base, `/v2/sessions/${sessionId}/manifest`, { token: device.token })
      assert.equal(manifest.status, 200)
      const remote = manifest.body.value.manifest.batches
      assert.equal(remote.length, 2)
      assert.deepEqual(remote[1].attachmentBlobs, [digest(imageBytes), digest(fileBytes)])
      assert.equal(remote[1].attachmentIndexSha256, digest(indexBytes))
      assert.equal(remote[0].attachmentIndexSha256, undefined)

      const batches = await call(base, `/v2/sessions/${sessionId}/batches?from=1&limit=1`, { token: device.token })
      assert.equal(batches.body.value.batches[0].attachmentIndexSha256, digest(indexBytes))

      // 索引与附件都能走批量下载通道，类别由服务端回填。
      const response = await fetch(`${base}/v2/blobs/batch/read`, {
        method: 'POST',
        headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json', 'x-client-id': '0123456789abcdef' },
        body: JSON.stringify({ sha256: [digest(indexBytes), digest(imageBytes)] }),
      })
      assert.equal(response.status, 200)
      const decoded = decodeBlobBatch(Buffer.from(await response.arrayBuffer()))
      assert.deepEqual(decoded.map((entry) => entry.kind), ['attachment-index', 'attachment'])
      assert.deepEqual(decoded.map((entry) => entry.data), [indexBytes, imageBytes])
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('append 拒绝缺失、类别不符、非法与超限的附件引用', async () => {
  const temp = createTempHome('server-v2-attachments-reject')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'attachments-reject')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const sessionId = 'session-attachments-reject'
      const createdAt = 1000
      const headerBytes = Buffer.from('reject-header')
      const eventBytes = Buffer.from('reject-event')
      const attachmentBytes = Buffer.from('reject-attachment')
      const indexBytes = Buffer.from('reject-index')
      const misfiled = Buffer.from('reject-misfiled')
      const unregistered = Buffer.from('reject-unregistered')
      for (const [kind, bytes] of [['frame', headerBytes], ['frame', eventBytes], ['attachment', attachmentBytes], ['attachment-index', indexBytes], ['frame', misfiled]]) {
        assert.equal((await uploadBlob(base, device.token, kind, bytes)).status, 201)
      }
      // 只有磁盘文件、没有 blob 登记行：模拟登记缺失。
      await putBlob(temp.dataDir, unregistered)

      assert.equal((await call(base, '/v2/sync/lease', { method: 'POST', token: device.token })).status, 200)
      const refs = () => [
        frameRef(0, -1, -1, headerBytes),
        frameRef(1, 0, 3, eventBytes),
      ]
      const attempt = async (dataRef, key) => {
        const batches = refs()
        batches[1] = { ...batches[1], ...dataRef }
        return call(base, `/v2/sessions/${sessionId}/append`, {
          method: 'POST',
          token: device.token,
          headers: { 'idempotency-key': key },
          json: appendBody(createdAt, batches),
        })
      }

      const cases = [
        ['索引未上传', { attachmentIndexSha256: digest('never-uploaded-index') }],
        ['附件未上传', { attachmentBlobs: [digest('never-uploaded-attachment')] }],
        ['附件类别不符', { attachmentBlobs: [digest(misfiled)] }],
        ['附件没有登记', { attachmentBlobs: [digest(unregistered)] }],
        ['索引哈希非法', { attachmentIndexSha256: 'zz' }],
        ['附件哈希非法', { attachmentBlobs: ['zz'] }],
        ['附件列表重复', { attachmentBlobs: [digest(attachmentBytes), digest(attachmentBytes)] }],
        ['附件列表为空', { attachmentBlobs: [] }],
        ['附件列表超限', { attachmentBlobs: Array.from({ length: MAX_FRAME_ATTACHMENT_BLOBS + 1 }, (_, index) => digest(`bulk-${index}`)) }],
      ]
      for (const [index, [label, dataRef]] of cases.entries()) {
        const result = await attempt(dataRef, `reject-${index}`)
        assert.equal(result.status, 400, `${label} 应被拒绝`)
        assert.equal(result.body.error.code, 'bad-request', `${label} 的错误码`)
      }
      assert.equal((await call(base, `/v2/sessions/${sessionId}/manifest`, { token: device.token })).status, 404)

      // 拒绝没有副作用：补全引用后同一请求可以成功。
      const accepted = await attempt({
        attachmentIndexSha256: digest(indexBytes),
        attachmentBlobs: [digest(attachmentBytes)],
      }, 'reject-accepted')
      assert.equal(accepted.status, 200)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('不带附件字段的旧式 append 仍然可用', async () => {
  const temp = createTempHome('server-v2-attachments-legacy')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'attachments-legacy')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const sessionId = 'session-attachments-legacy'
      const headerBytes = Buffer.from('legacy-header')
      const eventBytes = Buffer.from('legacy-event')
      for (const bytes of [headerBytes, eventBytes]) {
        assert.equal((await uploadBlob(base, device.token, 'frame', bytes)).status, 201)
      }
      assert.equal((await call(base, '/v2/sync/lease', { method: 'POST', token: device.token })).status, 200)
      const created = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST',
        token: device.token,
        headers: { 'idempotency-key': 'legacy-1' },
        json: appendBody(2000, [frameRef(0, -1, -1, headerBytes), frameRef(1, 0, 0, eventBytes)]),
      })
      assert.equal(created.status, 200)
      assert.equal(created.body.value.batchCount, 2)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('幂等键覆盖附件字段：同键不同附件返回 conflict', async () => {
  const temp = createTempHome('server-v2-attachments-idempotent')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'attachments-idempotent')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const sessionId = 'session-attachments-idempotent'
      const headerBytes = Buffer.from('idem-header')
      const eventBytes = Buffer.from('idem-event')
      const firstBytes = Buffer.from('idem-attachment-1')
      const secondBytes = Buffer.from('idem-attachment-2')
      const indexBytes = Buffer.from('idem-index')
      for (const [kind, bytes] of [['frame', headerBytes], ['frame', eventBytes], ['attachment', firstBytes], ['attachment', secondBytes], ['attachment-index', indexBytes]]) {
        assert.equal((await uploadBlob(base, device.token, kind, bytes)).status, 201)
      }
      assert.equal((await call(base, '/v2/sync/lease', { method: 'POST', token: device.token })).status, 200)
      const body = (attachmentSha) => {
        const batches = [frameRef(0, -1, -1, headerBytes), frameRef(1, 0, 0, eventBytes, {
          attachmentIndexSha256: digest(indexBytes),
          attachmentBlobs: [attachmentSha],
        })]
        return appendBody(3000, batches)
      }
      const first = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST', token: device.token, headers: { 'idempotency-key': 'attachment-group-1' }, json: body(digest(firstBytes)),
      })
      assert.equal(first.status, 200)
      const conflict = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST', token: device.token, headers: { 'idempotency-key': 'attachment-group-1' }, json: body(digest(secondBytes)),
      })
      assert.equal(conflict.status, 409)
      assert.equal(conflict.body.error.code, 'conflict')
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('移除会话时清理附件与索引，仍被其它会话引用的 blob 保留', async () => {
  const temp = createTempHome('server-v2-attachments-purge')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'attachments-purge')
    const salt = newSalt()
    setAdminPassword(db, deriveMasterKey('abc123', salt).toString('hex'), salt.toString('hex'))
    markAdminInitialized(db)
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const login = await call(base, '/admin/login', { method: 'POST', json: { password: 'abc123' } })
      assert.equal(login.status, 200)
      const adminCookie = cookieOf(login.headers, 'dsh_sync_admin')
      assert.ok(adminCookie !== undefined)

      const headerBytes = Buffer.from('purge-header')
      const eventBytes = Buffer.from('purge-event')
      const attachmentBytes = Buffer.from('purge-attachment')
      const indexBytes = Buffer.from('purge-index')
      for (const [kind, bytes] of [['frame', headerBytes], ['frame', eventBytes], ['attachment', attachmentBytes], ['attachment-index', indexBytes]]) {
        assert.equal((await uploadBlob(base, device.token, kind, bytes)).status, 201)
      }
      const before = usedBlobBytes(db)
      const attachmentPath = blobPath(temp.dataDir, digest(attachmentBytes))
      const indexPath = blobPath(temp.dataDir, digest(indexBytes))
      assert.ok(existsSync(attachmentPath))
      assert.ok(existsSync(indexPath))

      const refs = [frameRef(0, -1, -1, headerBytes), frameRef(1, 0, 0, eventBytes, {
        attachmentIndexSha256: digest(indexBytes),
        attachmentBlobs: [digest(attachmentBytes)],
      })]
      assert.equal((await call(base, '/v2/sync/lease', { method: 'POST', token: device.token })).status, 200)
      for (const [sessionId, createdAt, key] of [['session-purge-a', 4000, 'purge-a'], ['session-purge-b', 5000, 'purge-b']]) {
        const created = await call(base, `/v2/sessions/${sessionId}/append`, {
          method: 'POST',
          token: device.token,
          headers: { 'idempotency-key': key },
          json: appendBody(createdAt, refs),
        })
        assert.equal(created.status, 200)
      }

      // 存档不是移除：附件与索引都必须保留。
      const archivedA = await call(base, '/admin/sessions/session-purge-a/archive', {
        method: 'POST', cookie: adminCookie, json: { createdAt: 4000 },
      })
      assert.equal(archivedA.status, 200)
      assert.ok(existsSync(attachmentPath))
      assert.ok(existsSync(indexPath))

      // A 移除后，附件与索引仍被 B 引用，必须保留。
      const removedA = await call(base, '/admin/sessions/session-purge-a/remove', {
        method: 'POST', cookie: adminCookie, json: { createdAt: 4000 },
      })
      assert.equal(removedA.status, 200)
      assert.ok(existsSync(attachmentPath))
      assert.ok(existsSync(indexPath))
      assert.equal(usedBlobBytes(db), before)

      // B 移除后，独占的附件与索引一起释放。
      const removedB = await call(base, '/admin/sessions/session-purge-b/remove', {
        method: 'POST', cookie: adminCookie, json: { createdAt: 5000 },
      })
      assert.equal(removedB.status, 200)
      assert.equal(existsSync(attachmentPath), false)
      assert.equal(existsSync(indexPath), false)
      assert.equal(existsSync(blobPath(temp.dataDir, digest(headerBytes))), false)
      assert.ok(usedBlobBytes(db) < before)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
