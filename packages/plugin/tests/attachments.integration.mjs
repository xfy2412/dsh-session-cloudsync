import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createDevice } from '../../server/src/http.ts'
import { openDatabase } from '../../server/src/db.ts'
import { listenServer } from '../../server/tests/listen.mjs'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'
import { syncOnce as syncOnceRaw, pullSessionTask, repairSessionAttachments } from '../src/engine.ts'

const TEST_WORKSPACE_KEY = 'test-workspace-key-0001'
const syncOnce = (deps) => syncOnceRaw({ workspaceKeyOf: () => TEST_WORKSPACE_KEY, ...deps })

/** 没有 live 会话的 sessions 服务。 */
const sessions = { get: () => undefined, flush: async () => true }

/** 发一个 JSON 请求。 */
async function call(base, path, options = {}) {
  const headers = { ...options.headers }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers })
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) }
}

/** 拿 sync 租约。 */
async function holdLease(base, device) {
  const response = await call(base, '/v2/sync/lease', {
    method: 'POST',
    token: device.token,
    headers: { 'x-client-id': '0000000000000000' },
  })
  assert.equal(response.status, 200)
}

/** 内容地址。 */
function idOf(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** 假附件桥：一个 Map 当本地 store。 */
function fakeBridge(store, options = {}) {
  return {
    read: async (ref) => {
      if (options.readMissing === true) return undefined
      return store.get(ref.attachmentId)
    },
    exists: async (ref) => store.has(ref.attachmentId),
    write: async (ref, data) => {
      if (options.failWrite === true) throw new Error('simulated write failure')
      store.set(ref.attachmentId, Buffer.from(data))
    },
  }
}

/** 造一个可读写的假本地存储。 */
function fakeStore(header, initialEvents = []) {
  const sessionsMap = new Map()
  if (header !== undefined) sessionsMap.set(header.id, { header, events: [...initialEvents] })
  const handleFor = (record) => ({
    header: record.header,
    inheritedEventCount: 0,
    read: async () => ({ events: record.events }),
    append: async (events) => { record.events.push(...events) },
    flush: async () => {},
    close: async () => {},
  })
  return {
    sessions: sessionsMap,
    list: async () => [...sessionsMap.values()].map((record) => ({
      header: record.header, eventCount: record.events.length, sizeBytes: 0,
    })),
    stat: async (id) => {
      const record = sessionsMap.get(id)
      return record === undefined ? undefined : { header: record.header, eventCount: record.events.length, sizeBytes: 0 }
    },
    open: async (id) => {
      const record = sessionsMap.get(id)
      if (record === undefined) throw new Error(`没有会话 ${id}`)
      return handleFor(record)
    },
    create: async (createdHeader) => {
      const record = { header: createdHeader, events: [] }
      sessionsMap.set(createdHeader.id, record)
      return handleFor(record)
    },
  }
}

/** 造一个带附件引用的会话。 */
function sessionWithAttachments(sessionId, imageBytes, fileBytes) {
  const imageId = idOf(imageBytes)
  const fileId = idOf(fileBytes)
  const header = {
    id: sessionId,
    version: 4,
    createdAt: 1000,
    isSeeded: false,
    delegationDepth: 0,
    cwd: 'D:/work',
  }
  const events = [
    {
      type: 'user/message',
      seq: 0,
      time: 1001,
      data: {
        content: [
          { type: 'text', text: '看这两张' },
          { type: 'image', attachment: { attachmentId: imageId, mediaType: 'image/png', bytes: imageBytes.length, width: 2, height: 2 } },
          { type: 'file', attachment: { attachmentId: fileId, name: 'notes.txt', bytes: fileBytes.length } },
        ],
      },
    },
    { type: 'turn/end', seq: 1, time: 1002, data: {} },
  ]
  return { header, events, imageId, fileId }
}

/** 测试用配置。 */
function configOf(base, token) {
  return { serverUrl: base, token, passphrase: 'attachment-pass' }
}

test('推送会上传附件与索引，拉取在 apply 前补齐并保持字节一致', async () => {
  const temp = createTempHome('plugin-attachments')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'attachments')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)
      const sessionId = 'session-attachments-pull'
      const imageBytes = Buffer.from('fake-png-bytes')
      const fileBytes = Buffer.from('file-bytes-123')
      const { header, events, imageId, fileId } = sessionWithAttachments(sessionId, imageBytes, fileBytes)
      const sourceStore = new Map([[imageId, imageBytes], [fileId, fileBytes]])

      const pushed = await syncOnce({
        persistence: fakeStore(header, events),
        sessions,
        config: configOf(base, device.token),
        isTailOpen: () => false,
        attachments: fakeBridge(sourceStore),
      })
      assert.equal(pushed.sessions[0].status, 'pushed')

      const manifest = await call(base, `/v2/sessions/${sessionId}/manifest`, { token: device.token })
      const frames = manifest.body.value.manifest.batches
      const dataFrame = frames[1]
      assert.ok(typeof dataFrame.attachmentIndexSha256 === 'string')
      assert.equal(dataFrame.attachmentBlobs.length, 2)

      // 拉取到全新的本地 store：apply 之前附件已经落盘。
      const targetStore = new Map()
      const target = fakeStore(undefined)
      const pulled = await pullSessionTask({
        persistence: target,
        sessions,
        config: configOf(base, device.token),
        workspacePathOf: () => 'D:/mapped',
        attach: async () => {},
        attachments: fakeBridge(targetStore),
      }, sessionId, false)
      assert.equal(pulled.status, 'pulled')
      assert.deepEqual(targetStore.get(imageId), imageBytes)
      assert.deepEqual(targetStore.get(fileId), fileBytes)
      assert.equal(target.sessions.get(sessionId).events.length, 2)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('服务端没声明 attachment-index 时整条附件链路跳过', async () => {
  const temp = createTempHome('plugin-attachments-gate')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'attachments-gate')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)
      const sessionId = 'session-attachments-gate'
      const imageBytes = Buffer.from('gate-image')
      const fileBytes = Buffer.from('gate-file')
      const { header, events } = sessionWithAttachments(sessionId, imageBytes, fileBytes)
      const store = new Map()
      const fetched = []
      const pushed = await syncOnce({
        persistence: fakeStore(header, events),
        sessions,
        config: configOf(base, device.token),
        isTailOpen: () => false,
        attachments: fakeBridge(store),
        fetch: async (input, init) => {
          const url = String(input)
          fetched.push(url)
          const response = await fetch(input, init)
          if (!url.endsWith('/health')) return response
          const body = await response.json()
          body.server.capabilities = body.server.capabilities.filter((item) => item !== 'attachment-index')
          return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
        },
      })
      assert.equal(pushed.sessions[0].status, 'pushed')
      const manifest = await call(base, `/v2/sessions/${sessionId}/manifest`, { token: device.token })
      const frames = manifest.body.value.manifest.batches
      assert.equal(frames[1].attachmentIndexSha256, undefined)
      assert.equal(frames[1].attachmentBlobs, undefined)
      assert.ok(fetched.some((url) => url.endsWith('/health')))
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('修复接口能补齐被删掉的附件，报告计数可核对', async () => {
  const temp = createTempHome('plugin-attachments-repair')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'attachments-repair')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)
      const sessionId = 'session-attachments-repair'
      const imageBytes = Buffer.from('repair-image')
      const fileBytes = Buffer.from('repair-file')
      const { header, events, imageId, fileId } = sessionWithAttachments(sessionId, imageBytes, fileBytes)
      const sourceStore = new Map([[imageId, imageBytes], [fileId, fileBytes]])
      const pushed = await syncOnce({
        persistence: fakeStore(header, events),
        sessions,
        config: configOf(base, device.token),
        isTailOpen: () => false,
        attachments: fakeBridge(sourceStore),
      })
      assert.equal(pushed.sessions[0].status, 'pushed')

      const target = fakeStore(undefined)
      const store = new Map()
      const pulled = await pullSessionTask({
        persistence: target,
        sessions,
        config: configOf(base, device.token),
        workspacePathOf: () => 'D:/mapped',
        attach: async () => {},
        attachments: fakeBridge(store),
      }, sessionId, false)
      assert.equal(pulled.status, 'pulled')
      assert.deepEqual(store.get(imageId), imageBytes)

      // 删掉图片模拟本地缺失，再走修复。
      store.delete(imageId)
      const report = await repairSessionAttachments({
        config: configOf(base, device.token),
        attachments: fakeBridge(store),
        persistence: target,
      }, sessionId)
      assert.equal(report.scanned, 2)
      assert.equal(report.missing, 1)
      assert.equal(report.downloaded, 1)
      assert.deepEqual(report.failed, [])
      assert.deepEqual(store.get(imageId), imageBytes)

      // 再跑一次：没有缺失，幂等。
      const again = await repairSessionAttachments({
        config: configOf(base, device.token),
        attachments: fakeBridge(store),
        persistence: target,
      }, sessionId)
      assert.equal(again.missing, 0)
      assert.equal(again.downloaded, 0)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})

test('超过单 blob 上限的附件只记 tooLarge，拉取端在 apply 前被阻塞', async () => {
  const temp = createTempHome('plugin-attachments-oversize')
  try {
    const db = openDatabase(temp.dataDir)
    const device = createDevice(db, 'attachments-oversize')
    const { base, close } = await listenServer(db, temp.dataDir)
    try {
      await holdLease(base, device)
      const sessionId = 'session-attachments-oversize'
      // 32 MiB 上限 + 容器开销之上的一个附件。
      const big = Buffer.alloc(33 * 1024 * 1024, 7)
      const fileBytes = Buffer.from('small-file')
      const { header, events, fileId } = sessionWithAttachments(sessionId, big, fileBytes)
      const sourceStore = new Map([[idOf(big), big], [fileId, fileBytes]])
      const pushed = await syncOnce({
        persistence: fakeStore(header, events),
        sessions,
        config: configOf(base, device.token),
        isTailOpen: () => false,
        attachments: fakeBridge(sourceStore),
      })
      assert.equal(pushed.sessions[0].status, 'pushed')

      const target = fakeStore(undefined)
      const store = new Map()
      await assert.rejects(async () => await pullSessionTask({
        persistence: target,
        sessions,
        config: configOf(base, device.token),
        workspacePathOf: () => 'D:/mapped',
        attach: async () => {},
        attachments: fakeBridge(store),
      }, sessionId, false), /附件未同步完成/)
      assert.equal(target.sessions.has(sessionId), false)
      assert.equal(store.size, 0)
    } finally {
      await close()
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
