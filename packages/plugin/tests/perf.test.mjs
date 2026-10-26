import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PerfCollector } from '../src/perf.ts'

/** 造最小状态。 */
function status(runId = 7) {
  return {
    schemaVersion: 2,
    statusVersion: 1,
    configured: true,
    reason: null,
    running: false,
    run: { id: runId, trigger: 'manual', state: 'finished', startedAt: 1, finishedAt: 2 },
    scheduler: { autoSync: true, intervalMs: 60_000, nextRunAt: null, backoffUntil: null },
    lastAttempt: 1,
    lastSuccess: 2,
    lastError: null,
    retryCount: 0,
    nextRetryAt: null,
    pending: null,
    revision: 0,
    sessions: [
      { sessionId: 's1', phase: 'done', push: { direction: 'push', status: 'pushed', doneEvents: 2 }, pull: undefined },
      { sessionId: 's2', phase: 'failed', push: undefined, pull: { direction: 'pull', status: 'error', doneEvents: 1 } },
    ],
  }
}

test('性能采集：阶段、字节和会话摘要', () => {
  const collector = new PerfCollector()
  collector.begin('manual')
  collector.progress({ sessionId: 's1', direction: 'push', phase: 'start', stage: 'reading', progress: 0 })
  collector.progress({ sessionId: 's1', direction: 'push', phase: 'progress', stage: 'planning', progress: 0, totalEvents: 2 })
  collector.progress({ sessionId: 's1', direction: 'push', phase: 'progress', stage: 'uploading', progress: 0.5, totalEvents: 2, doneEvents: 1, doneBytes: 12 })
  collector.beginOperation({ direction: 'push', sessionId: 's1', stage: 'seal' })
  collector.metric({ direction: 'push', sessionId: 's1', stage: 'seal', ms: 3.2, bytes: 12, blocking: true })
  collector.beginOperation({ direction: 'push', sessionId: 's1', stage: 'upload' })
  collector.metric({ direction: 'push', sessionId: 's1', stage: 'upload', ms: 4.5, bytes: 12 })
  collector.progress({ sessionId: 's1', direction: 'push', phase: 'done', stage: 'done', progress: 1, totalEvents: 2, doneEvents: 2, doneBytes: 24 })
  collector.finish(status())

  const snapshot = collector.snapshot()
  assert.equal(snapshot.active, false)
  assert.equal(snapshot.latest.runId, 7)
  assert.equal(snapshot.latest.trigger, 'manual')
  assert.equal(snapshot.latest.sessions.total, 2)
  assert.equal(snapshot.latest.sessions.failed, 1)
  assert.equal(snapshot.latest.bytes.uploaded, 24)
  assert.ok(snapshot.latest.stageMs.reading >= 0)
  assert.ok(snapshot.latest.stageMs.planning >= 0)
  assert.equal(snapshot.latest.operations.seal, 3.2)
  assert.equal(snapshot.latest.operations.upload, 4.5)
  assert.equal(typeof snapshot.latest.eventLoopByStage.seal, 'number')
  assert.ok(snapshot.latest.eventLoopByStage.seal >= 3.2)
  assert.equal(typeof snapshot.latest.eventLoopByStage.upload, 'number')
  assert.ok(snapshot.latest.eventLoop.p99Ms >= 0)
  assert.equal(snapshot.environment.plugin, 'dsh-session-cloudsync')
})

test('性能采集：只保留最近 30 次 run', () => {
  const collector = new PerfCollector()
  for (let index = 0; index < 31; index += 1) {
    collector.begin('auto')
    collector.progress({ sessionId: `s${index}`, direction: 'pull', phase: 'start', stage: 'reading', progress: 0 })
    collector.finish(status(index))
  }
  const snapshot = collector.snapshot()
  assert.equal(snapshot.recent.length, 30)
  assert.equal(snapshot.latest.runId, 30)
  assert.equal(snapshot.recent.at(-1).runId, 1)
})
