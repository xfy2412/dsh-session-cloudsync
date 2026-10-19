// M3 探针：只通过公开的 SessionHandle 事件级 API 验证 round-trip。
//
// 模式（环境变量 M3_PROBE）：
//   export  从当前 home 找一条冷会话，把 {header, events} 写到 M3_PROBE_FILE
//   import  读入该文件，用**相同 session id** 在另一个 home 重建会话，再读回比较
//
// 这样模拟真实同步：同 id、同事件，不同 home。只在显式设置时运行。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const name = 'dsh-session-sync-m3-probe'

export const inject = ['sessionPersistence', 'sessionQuery']

/** 键序稳定的 JSON。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry))
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key])
    return sorted
  }
  return value
}

/** @param {unknown} value */
function stable(value) {
  return JSON.stringify(canonical(value))
}

/** 找第一条差异的路径。 */
function firstDifference(a, b, path = 'event') {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return stable(a) === stable(b) ? undefined : `${path}: ${stable(a)} != ${stable(b)}`
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${path}: 数组长度不同`
    for (let index = 0; index < a.length; index += 1) {
      const found = firstDifference(a[index], b[index], `${path}[${index}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const found = firstDifference(a[key], b[key], `${path}.${key}`)
    if (found !== undefined) return found
  }
  return undefined
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
async function exportSource(ctx, file) {
  const snapshots = await ctx.sessionPersistence.list()
  const candidates = snapshots.filter((snapshot) => snapshot.header.isSeeded !== true)
  candidates.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || (b.eventCount ?? 0) - (a.eventCount ?? 0))
  const source = candidates[0]
  if (source === undefined) throw new Error('没有可用的非 seeded 会话')

  const reader = await ctx.sessionPersistence.open(source.header.id, 'read')
  const header = reader.header
  const { events } = await reader.read()
  await reader.close()

  const payload = JSON.stringify({ header, events })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, payload)
  console.log(`[m3-probe] export source=${source.header.id} events=${events.length} bytes=${Buffer.byteLength(payload)} file=${file}`)
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
async function importAndVerify(ctx, file) {
  const { header, events } = JSON.parse(readFileSync(file, 'utf8'))
  const created = await ctx.sessionPersistence.create({
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    isSeeded: header.isSeeded,
    delegationDepth: header.delegationDepth,
    agentPreset: header.agentPreset,
  })
  for (let offset = 0; offset < events.length; offset += 200) {
    await created.append(events.slice(offset, offset + 200))
  }
  await created.flush()
  await created.close()

  const reopened = await ctx.sessionPersistence.open(header.id, 'read')
  const { events: copied } = await reopened.read()
  await reopened.close()

  const equal = events.length === copied.length && events.every((event, index) => stable(event) === stable(copied[index]))
  const difference = equal ? undefined : firstDifference(events, copied)
  const stat = await ctx.sessionPersistence.stat(header.id)
  const queried = await ctx.sessionQuery.readSession(header.id)
  const queryEqual = queried.events.length === events.length && queried.events.every((event, index) => stable(event) === stable(events[index]))
  console.log(`[m3-probe] import id=${header.id} events=${events.length} copied=${copied.length} equal=${equal}`)
  console.log(`[m3-probe] stat.eventCount=${stat?.eventCount} stat.sizeBytes=${stat?.sizeBytes} query.events=${queried.events.length} queryEqual=${queryEqual} firstDiff=${difference ?? 'none'}`)
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const mode = process.env.M3_PROBE
  if (mode !== 'export' && mode !== 'import') return
  const file = resolve(process.env.M3_PROBE_FILE ?? '.tmp/m3-probe/events.json')
  const task = mode === 'export' ? exportSource(ctx, file) : importAndVerify(ctx, file)
  void task.catch((error) => {
    console.error(`[m3-probe] ${mode} 失败：${error?.stack ?? String(error)}`)
  })
}
