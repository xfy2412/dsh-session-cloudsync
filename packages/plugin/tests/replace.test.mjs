import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareReplaceScript } from '../src/replace.ts'

/** 拿一个已经退出、且短期不会被复用的 PID。 */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  await once(child, 'exit')
  return pid
}

/** 搭一个最小 DSH home。 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'cloudsync-replace-'))
  const sessionId = 'replace-test-1'
  const sessionDir = join(home, 'sessions', '--project--', sessionId)
  const statePath = join(home, 'session-cloudsync', 'state.json')
  const workspacePath = join(home, 'storages', 'workspace.json')
  const projectionPath = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  await mkdir(sessionDir, { recursive: true })
  await mkdir(join(home, 'session-cloudsync'), { recursive: true })
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'fake-zstd-session\n', 'utf8')
  await writeFile(join(sessionDir, 'extra.bin'), Buffer.from([0, 1, 2, 3]))
  await writeFile(projectionPath, '{"projection":true}\n', 'utf8')
  await writeFile(statePath, JSON.stringify({
    version: 1,
    revision: 7,
    pending: { sessionId, targetSeq: 9, at: 1 },
    cwdPending: [sessionId, 'other'],
    blocked: [{ sessionId, kind: 'diverged', message: 'x', at: 1, createdAt: 123, formatVersion: 4 }],
    blockedDecisions: [{ sessionId, createdAt: 123, formatVersion: 4, action: 'ignore', message: 'x', at: 1 }],
  }, null, 2), 'utf8')
  await writeFile(workspacePath, JSON.stringify({
    global: { archivedSessionIds: [sessionId, 'other'] },
    tables: { workspaces: { a: { sessionIds: [sessionId, 'other'] } } },
  }, null, 2), 'utf8')
  return { home, sessionId, sessionDir, statePath, workspacePath, projectionPath }
}

test('生成的覆盖脚本备份、删除黑名单状态并清理工作区记账', async () => {
  const data = await fixture()
  try {
    const pid = await deadPid()
    const plan = await prepareReplaceScript({
      sessionId: data.sessionId,
      createdAt: 123,
      formatVersion: 4,
      dshHome: data.home,
      statePath: data.statePath,
      dshPid: pid,
    })
    assert.match(plan.command, /^node "/)
    assert.ok(existsSync(plan.scriptPath))
    const script = await readFile(plan.scriptPath, 'utf8')
    assert.match(script, new RegExp(data.sessionId))
    assert.doesNotMatch(script, /__CONFIG__/)

    const run = spawnSync(process.execPath, [plan.scriptPath], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    assert.equal(existsSync(data.sessionDir), false)
    assert.equal(existsSync(data.projectionPath), false)

    const state = JSON.parse(await readFile(data.statePath, 'utf8'))
    assert.equal(state.revision, 0)
    assert.equal(state.pending, undefined)
    assert.deepEqual(state.cwdPending, ['other'])
    assert.deepEqual(state.blocked, [])
    assert.deepEqual(state.blockedDecisions, [])

    const workspace = JSON.parse(await readFile(data.workspacePath, 'utf8'))
    assert.deepEqual(workspace.global.archivedSessionIds, ['other'])
    assert.deepEqual(workspace.tables.workspaces.a.sessionIds, ['other'])

    const dirs = await readdir(plan.backupRoot)
    assert.equal(dirs.length, 1)
    const backupDir = join(plan.backupRoot, dirs[0])
    const manifest = JSON.parse(await readFile(join(backupDir, '_backup-manifest.json'), 'utf8'))
    assert.equal(manifest.sessionId, data.sessionId)
    assert.equal(manifest.files.length, 2)
    assert.equal(await readFile(join(backupDir, 'extra.bin')).then((b) => b.toString('hex')), '00010203')
  } finally {
    await rm(data.home, { recursive: true, force: true })
  }
})

test('DSH 仍运行时脚本拒绝改动', async () => {
  const data = await fixture()
  try {
    const plan = await prepareReplaceScript({
      sessionId: data.sessionId,
      createdAt: 123,
      formatVersion: 4,
      dshHome: data.home,
      statePath: data.statePath,
      dshPid: process.pid,
    })
    const run = spawnSync(process.execPath, [plan.scriptPath], { encoding: 'utf8' })
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /DSH 仍在运行/)
    assert.ok(existsSync(data.sessionDir))
    assert.equal(existsSync(plan.backupRoot), false)
  } finally {
    await rm(data.home, { recursive: true, force: true })
  }
})
