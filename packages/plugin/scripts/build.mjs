/**
 * 构建发布用的运行时代码：把 `src/**.ts` 转成 `lib/**.js`。
 *
 * 用 Node 自带的 TypeScript 转换（`module.stripTypeScriptTypes` 的 transform
 * 模式），而不是引入编译器依赖：DSH 加载器以普通 Node ESM 启动插件，不装
 * TypeScript 钩子，所以包的入口必须是 JavaScript。
 *
 * 相对说明符 `./x.ts` 会被改写成 `./x.js`，让产物在无钩子时也能解析。
 *
 * @module dsh-session-sync/scripts/build
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(root, 'src')
const outputDir = path.join(root, 'lib')

/** 递归列出某目录下的所有 `.ts` 文件。 */
function sources(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

rmSync(outputDir, { recursive: true, force: true })
let written = 0
for (const file of sources(sourceDir)) {
  const relative = path.relative(sourceDir, file).replace(/\.ts$/, '.js')
  const target = path.join(outputDir, relative)
  const transformed = stripTypeScriptTypes(readFileSync(file, 'utf8'), {
    mode: 'transform',
    sourceUrl: file,
  })
  // 产物要能自己解析导入；`.ts` 说明符在普通 Node 里解析不了。
  const rewritten = transformed.replace(/(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, rewritten)
  written += 1
}
const bytes = sources(outputDir).reduce((total, file) => total + statSync(file).size, 0)
process.stdout.write(`已构建 ${written} 个模块到 lib/（${(bytes / 1024).toFixed(1)} KB）\n`)
