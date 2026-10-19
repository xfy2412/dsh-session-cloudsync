// 用本仓库自己的帧写入器生成夹具的 `.zstd` 兄弟文件。
//
// 生成物会被提交，因为测试需要固定字节；改了夹具后重跑：
//   pnpm fixtures
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeLog, joinFrames } from '../../packages/shared/src/frames.ts'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sessions')

for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
  const text = readFileSync(join(dir, name), 'utf8')
  const frames = encodeLog(text, { headerLines: 1, rowsPerFrame: 3 })
  const target = join(dir, name.replace(/\.jsonl$/, '.jsonl.zstd'))
  writeFileSync(target, joinFrames(frames))
  console.log(`已写出 ${target}（${frames.length} 帧）`)
}
