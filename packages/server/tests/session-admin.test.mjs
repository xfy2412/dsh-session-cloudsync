import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { splitFrames, splitRows } from '../../shared/src/frames.ts'
import { sealFrame, sessionKeyOf } from '../../shared/src/sealed-frame.ts'
import { deriveMasterKey, newSalt } from '../../shared/src/crypto.ts'
import { blobPath } from '../src/blobs.ts'
import { createDevice } from '../src/http.ts'
import { markAdminInitialized, openDatabase, setAdminPassword } from '../src/db.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import { listenServer } from './listen.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'tests', 'fixtures', 'sessions')

/**
 * 发一个请求。
 * @param base - 基地址。
 * @param path - 路径。
 * @param options - 方法、token、cookie 与 JSON 体。
 * @returns 状态码与响应体。
 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers, 'x-client-id': '0123456789abcdef' }
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
 * 封前几帧。
 * @param count - 帧数。
 * @param sessionId - 会话 id。
 * @param key - 会话密钥。
 * @returns 封好的帧。
 */
function sealFrames(count, sessionId, key) {
  const frames = splitFrames(readFileSync(join(fixtures, 'v4-coverage.jsonl.zstd'))).slice(0, count)
  return frames.map((frame, index) => {
    const rows = splitRows(zstdDecompressSync(frame).toString('utf8')).map((row) => JSON.parse(row))
    const first = rows[0]
    const last = rows[rows.length - 1]
    const seqFrom = typeof first?.seq === 'number' ? first.seq : -1
    const seqTo = typeof last?.seq === 'number' ? last.seq : seqFrom
    return sealFrame(frame, { sessionId, index, seqFrom, seqTo }, key)
  })
}

test('会话三档：存档/恢复/移除/重置、includeDeleted 与重置闸门', async () => {
  const temp = createTempHome('server-session-admin')
  try {
    const db = openDatabase(temp.dataDir)
    const deviceA = createDevice(db, 'A')
    const deviceB = createDevice(db, 'B')
    const salt = newSalt()
    setAdminPassword(db, deriveMasterKey('abc123', salt).toString('hex'), salt.toString('hex'))
    markAdminInitialized(db)
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      const login = await call(base, '/admin/login', { method: 'POST', json: { password: 'abc123' } })
      assert.equal(login.status, 200)
      const adminCookie = cookieOf(login.headers, 'dsh_sync_admin')
      assert.ok(adminCookie !== undefined)

      const devicesRes = await call(base, '/admin/devices', { cookie: adminCookie })
      const colors = devicesRes.body.value.map((device) => device.color)
      assert.ok(colors.every((color) => typeof color === 'string' && /^#[0-9a-f]{6}$/u.test(color)))
      assert.notEqual(colors[0], colors[1])

      const sessionId = 'session-admin-modes'
      const createdAt = 1000
      const key = sessionKeyOf(Buffer.alloc(32, 7), sessionId)
      const sealed = sealFrames(3, sessionId, key)
      const refs = sealed.map((entry) => entry.ref)
      for (const entry of sealed) {
        assert.equal((await call(base, '/v2/blobs?kind=frame', { method: 'POST', token: deviceA.token, body: entry.bytes })).status, 201)
      }
      assert.equal((await call(base, '/v2/sync/lease', { method: 'POST', token: deviceA.token })).status, 200)
      const created = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST', token: deviceA.token, headers: { 'idempotency-key': 'admin-create-1' },
        json: { baseIndex: -1, baseChainHash: null, createdAt, formatVersion: 4, workspaceKey: 'workspace-reset-key', batches: refs },
      })
      assert.equal(created.status, 200)
      const storedBytes = created.body.value.storedBytes
      assert.ok(storedBytes > 0)
      const blobFiles = sealed.map((entry) => blobPath(temp.dataDir, entry.ref.blobSha256))
      assert.ok(blobFiles.every((file) => existsSync(file)))

      // 存档：默认快照消失，includeDeleted 能看到；blob 保留。
      const archived = await call(base, `/admin/sessions/${sessionId}/archive`, { method: 'POST', cookie: adminCookie, json: { createdAt } })
      assert.equal(archived.status, 200)
      const snapshot = await call(base, '/v2/sessions', { token: deviceA.token })
      assert.equal(snapshot.body.value.sessions.length, 0)
      const withDeleted = await call(base, '/v2/sessions?includeDeleted=1', { token: deviceA.token })
      assert.equal(withDeleted.body.value.sessions.length, 1)
      assert.equal(withDeleted.body.value.sessions[0].deletedBy, 'admin:archive')
      assert.equal(withDeleted.body.value.sessions[0].purgedAt, null)
      assert.ok(blobFiles.every((file) => existsSync(file)))
      const gone = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST', token: deviceA.token, headers: { 'idempotency-key': 'admin-gone-1' },
        json: { baseIndex: -1, baseChainHash: null, createdAt, formatVersion: 4, batches: refs },
      })
      assert.equal(gone.status, 410)
      assert.equal(gone.body.error.code, 'gone')

      // 恢复：重新出现在默认快照里。
      const restored = await call(base, `/admin/sessions/${sessionId}/restore`, { method: 'POST', cookie: adminCookie, json: { createdAt } })
      assert.equal(restored.status, 200)
      const afterRestore = await call(base, '/v2/sessions', { token: deviceA.token })
      assert.equal(afterRestore.body.value.sessions.length, 1)

      // 移除：释放 blob，写入 purgedAt，仍保留墓碑。
      const removed = await call(base, `/admin/sessions/${sessionId}/remove`, { method: 'POST', cookie: adminCookie, json: { createdAt } })
      assert.equal(removed.status, 200)
      assert.ok(removed.body.value.purgedBytes > 0)
      assert.ok(blobFiles.every((file) => !existsSync(file)))
      const removedDeleted = await call(base, '/v2/sessions?includeDeleted=1', { token: deviceA.token })
      assert.equal(removedDeleted.body.value.sessions[0].purgedAt > 0, true)
      const overview = await call(base, '/admin/overview', { cookie: adminCookie })
      assert.ok(overview.body.value.usedBytes < storedBytes)
      const restorePurged = await call(base, `/admin/sessions/${sessionId}/restore`, { method: 'POST', cookie: adminCookie, json: { createdAt } })
      assert.equal(restorePurged.status, 409)

      // 重置：指定 A；B 先推被 reset-pending 拦住，A 可以重建。
      const reset = await call(base, `/admin/sessions/${sessionId}/reset`, {
        method: 'POST', cookie: adminCookie, json: { createdAt, deviceId: deviceA.device.deviceId },
      })
      assert.equal(reset.status, 200)
      const afterReset = await call(base, '/v2/sessions?includeDeleted=1', { token: deviceA.token })
      assert.equal(afterReset.body.value.sessions.length, 0)
      const adminList = await call(base, '/admin/sessions', { cookie: adminCookie })
      const resettingRow = adminList.body.value.find((session) => session.sessionId === sessionId)
      assert.ok(resettingRow !== undefined)
      assert.equal(resettingRow.resetDeviceId, deviceA.device.deviceId)
      assert.equal(resettingRow.workspaceKey, 'workspace-reset-key')
      assert.ok(resettingRow.resetExpiresAt > Date.now())
      // 重置删除了 blob，需要重新上传。
      for (const entry of sealed) {
        assert.equal((await call(base, '/v2/blobs?kind=frame', { method: 'POST', token: deviceA.token, body: entry.bytes })).status, 201)
      }
      const blockedB = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST', token: deviceB.token, headers: { 'idempotency-key': 'admin-b-1' },
        json: { baseIndex: -1, baseChainHash: null, createdAt, formatVersion: 4, batches: refs },
      })
      assert.equal(blockedB.status, 409)
      assert.equal(blockedB.body.error.code, 'reset-pending')
      const cleared = await call(base, `/admin/sessions/${sessionId}/clear-reset`, {
        method: 'POST', cookie: adminCookie, json: { createdAt },
      })
      assert.equal(cleared.status, 200)
      const afterClear = await call(base, '/admin/sessions', { cookie: adminCookie })
      assert.equal(afterClear.body.value.some((session) => session.sessionId === sessionId), false)
      assert.equal((await call(base, '/v2/sync/lease', { method: 'POST', token: deviceA.token })).status, 200)
      const rebuilt = await call(base, `/v2/sessions/${sessionId}/append`, {
        method: 'POST', token: deviceA.token, headers: { 'idempotency-key': 'admin-rebuild-1' },
        json: { baseIndex: -1, baseChainHash: null, createdAt, formatVersion: 4, batches: refs },
      })
      assert.equal(rebuilt.status, 200)
      assert.equal(rebuilt.body.value.lastSeq, refs[refs.length - 1].seqTo)

      const audit = await call(base, '/admin/audit?limit=50', { cookie: adminCookie })
      const actions = audit.body.value.events.map((event) => event.action)
      for (const action of ['session.archive', 'session.restore', 'session.remove', 'session.reset']) {
        assert.ok(actions.includes(action), `缺少审计动作 ${action}`)
      }
      const history = await call(base, `/admin/sessions/${sessionId}/history`, { cookie: adminCookie })
      assert.equal(history.status, 200)
      const kinds = history.body.value.events.map((event) => event.kind)
      for (const kind of ['create', 'archive', 'restore', 'remove', 'reset']) {
        assert.ok(kinds.includes(kind), `缺少历史事件 ${kind}`)
      }
      assert.ok(history.body.value.summary.events > 0)
      assert.match(history.body.value.events.find((event) => event.kind === 'create').deviceColor, /^#[0-9a-f]{6}$/u)
      assert.equal(history.body.value.summary.devices, 1)
      assert.equal(history.body.value.summary.firstAt > 0, true)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
