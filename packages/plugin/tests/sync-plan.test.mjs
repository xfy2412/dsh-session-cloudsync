import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planSync } from '../src/sync-plan.ts'

const root = {
  header: { id: 'root', createdAt: 1, version: 4, cwd: 'D:/work' },
  eventCount: 5,
}
const child = {
  header: { id: 'child', createdAt: 2, version: 4, cwd: 'D:/work', origin: 'subagent', parentSession: 'root', delegationDepth: 1 },
  eventCount: 1,
}
const remote = (id, lastSeq, extra = {}) => ({
  sessionId: id,
  formatVersion: 4,
  createdAt: id === 'child' ? 2 : 1,
  lastSeq,
  headChainHash: 'a'.repeat(64),
  ...extra,
})

test('规划器：远端相同就跳过，本地领先只 push，远端领先只 pull', () => {
  const plan = planSync({
    local: [root, child],
    remote: [remote('root', 4), remote('child', 2, { workspaceKey: null, parentSession: 'root', origin: 'subagent', delegationDepth: 1 })],
    selectedRoots: ['root'],
    includeSubagents: true,
  })
  const byId = Object.fromEntries(plan.entries.map((entry) => [entry.sessionId, entry]))
  assert.equal(byId.root.action, 'none')
  assert.equal(byId.root.reason, 'up-to-date')
  assert.equal(byId.child.action, 'pull')
  assert.equal(byId.child.reason, 'remote-ahead')
  assert.equal(plan.entries.filter((entry) => entry.action === 'push').length, 0)
})

test('规划器：本地不存在但远端存在，只生成 pull 新任务', () => {
  const plan = planSync({
    local: [root],
    remote: [remote('root', 4), remote('new', 2, { workspaceKey: 'w'.repeat(16), parentSession: null })],
    selectedRoots: ['root'],
    includeSubagents: true,
    boundWorkspaceKeys: new Set(['w'.repeat(16)]),
  })
  const entry = plan.entries.find((item) => item.sessionId === 'new')
  assert.equal(entry.action, 'pull')
  assert.equal(entry.reason, 'local-missing')
  assert.equal(entry.remoteLastSeq, 2)
})

test('规划器：远端-only 子代理沿 parentSession 归到已选根', () => {
  const plan = planSync({
    local: [root],
    remote: [
      remote('root', 4),
      remote('child', 2, { workspaceKey: null, parentSession: 'root', origin: 'subagent', delegationDepth: 1 }),
    ],
    selectedRoots: ['root'],
    includeSubagents: true,
  })
  const child = plan.entries.find((entry) => entry.sessionId === 'child')
  assert.equal(child.action, 'pull')
  assert.equal(child.rootId, 'root')
  assert.equal(child.depth, 1)
})

test('规划器：同一会话不会同时产生 push 和 pull', () => {
  const plan = planSync({
    local: [{ ...root, eventCount: 9 }],
    remote: [remote('root', 2)],
    selectedRoots: ['root'],
    includeSubagents: true,
  })
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].action, 'push')
})

test('规划器：DSH list 不返回 eventCount 时用 revision 判定 up-to-date', () => {
  const local = { ...root, eventCount: undefined, revision: 'rev-1' }
  const plan = planSync({
    local: [local],
    remote: [remote('root', 4)],
    selectedRoots: ['root'],
    includeSubagents: true,
    receipts: {
      root: {
        sessionId: 'root',
        localRevision: 'rev-1',
        localEventCount: 0,
        localLastSeq: 4,
        remoteLastSeq: 4,
        remoteHeadChainHash: 'a'.repeat(64),
        formatVersion: 4,
        checkedAt: 1,
      },
    },
  })
  assert.equal(plan.entries[0].action, 'none')
  assert.equal(plan.entries[0].reason, 'up-to-date')
})

test('规划器：revision 变化而远端未变只 push；revision 未变而远端变化只 pull', () => {
  const baseReceipt = {
    sessionId: 'root',
    localRevision: 'rev-1',
    localEventCount: 0,
    localLastSeq: 4,
    remoteLastSeq: 4,
    remoteHeadChainHash: 'a'.repeat(64),
    formatVersion: 4,
    checkedAt: 1,
  }
  const pushed = planSync({
    local: [{ ...root, revision: 'rev-2', eventCount: undefined }],
    remote: [remote('root', 4)],
    selectedRoots: ['root'],
    includeSubagents: true,
    receipts: { root: baseReceipt },
  })
  assert.equal(pushed.entries[0].action, 'push')

  const pulled = planSync({
    local: [{ ...root, revision: 'rev-1', eventCount: undefined }],
    remote: [remote('root', 6)],
    selectedRoots: ['root'],
    includeSubagents: true,
    receipts: { root: baseReceipt },
  })
  assert.equal(pulled.entries[0].action, 'pull')
})

test('规划器：旧 receipt 没有 revision 时，远端未变仍视为 up-to-date', () => {
  const plan = planSync({
    local: [{ ...root, eventCount: undefined }],
    remote: [remote('root', 4)],
    selectedRoots: ['root'],
    includeSubagents: true,
    receipts: {
      root: {
        sessionId: 'root',
        localEventCount: 69587,
        localLastSeq: 4,
        remoteLastSeq: 4,
        remoteHeadChainHash: 'a'.repeat(64),
        formatVersion: 4,
        checkedAt: 1,
      },
    },
  })
  assert.equal(plan.entries[0].action, 'none')
})

test('规划器：receipt 命中时 up-to-date，不产生任务', () => {
  const plan = planSync({
    local: [root],
    remote: [remote('root', 4)],
    selectedRoots: ['root'],
    includeSubagents: true,
    receipts: {
      root: {
        sessionId: 'root',
        localEventCount: 5,
        localLastSeq: 4,
        remoteLastSeq: 4,
        remoteHeadChainHash: 'a'.repeat(64),
        formatVersion: 4,
        checkedAt: 1,
      },
    },
  })
  assert.equal(plan.entries[0].action, 'none')
  assert.equal(plan.entries[0].reason, 'up-to-date')
})

test('规划器：回执要落在实际推送位置，否则下一轮会幻影拉取', () => {
  // 场景：本地 101 条（最后一条是冷打开补的 end-seed），推送前远端到 100。
  // 推送实际把 101 推上去了，回执若照抄规划时的 localLastSeq(100)，下一轮
  // 就会把刚上传的那条算成“待下载”，白跑一次拉取才自愈。
  const local = {
    header: { id: 'root', createdAt: 1, version: 4, cwd: 'D:/work' },
    revision: 'rev1',
  }
  const remoteAfter = remote('root', 101, { headChainHash: 'b'.repeat(64) })
  const baseReceipt = {
    sessionId: 'root',
    localRevision: 'rev1',
    formatVersion: 4,
    checkedAt: 1,
  }
  const stale = { ...baseReceipt, localEventCount: 101, localLastSeq: 100, remoteLastSeq: 100, remoteHeadChainHash: '' }
  const actual = { ...baseReceipt, localEventCount: 102, localLastSeq: 101, remoteLastSeq: 101, remoteHeadChainHash: 'b'.repeat(64) }

  const stalePlan = planSync({
    local: [local], remote: [remoteAfter], selectedRoots: ['root'], includeSubagents: false,
    receipts: { root: stale },
  })
  assert.equal(stalePlan.entries[0].action, 'pull')
  assert.equal(stalePlan.entries[0].reason, 'remote-ahead')
  assert.equal(stalePlan.entries[0].remoteLastSeq - stalePlan.entries[0].localLastSeq, 1)

  const fixedPlan = planSync({
    local: [local], remote: [remoteAfter], selectedRoots: ['root'], includeSubagents: false,
    receipts: { root: actual },
  })
  assert.equal(fixedPlan.entries[0].action, 'none')
  assert.equal(fixedPlan.entries[0].reason, 'up-to-date')
})

test('规划器：字节数不变即本地未变（历史代际会话的 revision 会漂）', () => {
  // 历史代际会话的 revision 末尾带“整个存储根”的语料指纹：别的会话一写，
  // 它的 revision 就变，但本会话字节数没变。按 revision 判等会把它误判成
  // 本地领先（全部待上传），所以规划优先看字节数。
  const local = {
    header: { id: 'root', createdAt: 1, version: 4, cwd: 'D:/work' },
    revision: '308183645:1:100:1:1:corpus-b',
    sizeBytes: 100,
  }
  const remoteSame = remote('root', 4, { headChainHash: 'a'.repeat(64) })
  const receipt = {
    sessionId: 'root',
    localRevision: '308183645:1:100:1:1:corpus-a',
    localSizeBytes: 100,
    localEventCount: 5,
    localLastSeq: 4,
    remoteLastSeq: 4,
    remoteHeadChainHash: 'a'.repeat(64),
    formatVersion: 4,
    checkedAt: 1,
  }

  const unchanged = planSync({
    local: [local], remote: [remoteSame], selectedRoots: ['root'], includeSubagents: false,
    receipts: { root: receipt },
  })
  assert.equal(unchanged.entries[0].action, 'none')
  assert.equal(unchanged.entries[0].reason, 'up-to-date')

  const grown = planSync({
    local: [{ ...local, sizeBytes: 160 }], remote: [remoteSame], selectedRoots: ['root'], includeSubagents: false,
    receipts: { root: receipt },
  })
  assert.equal(grown.entries[0].action, 'push')
  assert.equal(grown.entries[0].reason, 'local-ahead')
})
