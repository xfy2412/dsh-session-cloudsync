/**
 * 构建发布用的运行时代码：把 `src/**.ts` 转成 `lib/**.js`。
 *
 * 用 Node 自带的 TypeScript 转换（`module.stripTypeScriptTypes` 的 transform
 * 模式），而不是引入编译器依赖：DSH 加载器以普通 Node ESM 启动插件，不装
 * TypeScript 钩子，所以包的入口必须是 JavaScript。
 *
 * M3 的引擎复用了 `packages/shared` 的批次/加密原语。这里把这些共享模块也
 * 转换后放进 `lib/shared/`，让插件产物保持自包含；插件源码里的
 * `../../shared/src/x.ts` 会改写成 `./shared/x.js`。
 *
 * @module dsh-session-cloudsync/scripts/build
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(root, 'src')
const outputDir = path.join(root, 'lib')
const sharedDir = path.resolve(root, '..', 'shared', 'src')
const sharedOutput = path.join(outputDir, 'shared')
const SHARED_MODULES = ['batches.ts', 'chain.ts', 'crypto.ts', 'sealed-frame.ts', 'vault.ts']

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

/**
 * 转译一个 TypeScript 文件。
 * @param file - 源文件。
 * @param transformImports - 说明符改写。
 * @returns 转译后的文本。
 */
function compile(file, transformImports) {
  const transformed = stripTypeScriptTypes(readFileSync(file, 'utf8'), {
    mode: 'transform',
    sourceUrl: path.basename(file),
  })
  return transformImports(transformed)
}

/** 把相对说明符里的 `.ts` 改成 `.js`。 */
function localJs(text) {
  return text.replace(/(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
}

rmSync(outputDir, { recursive: true, force: true })
let written = 0
let bytes = 0

// 共享模块：放进 lib/shared，内部相对导入改成 .js。
mkdirSync(sharedOutput, { recursive: true })
for (const name of SHARED_MODULES) {
  const output = path.join(sharedOutput, name.replace(/\.ts$/, '.js'))
  const text = compile(path.join(sharedDir, name), localJs)
  writeFileSync(output, text)
  bytes += Buffer.byteLength(text)
  written += 1
}

// 插件源码：把 ../../shared/src/x.ts 指到 ./shared/x.js，再处理本地 .ts。
for (const file of sources(sourceDir)) {
  const relative = path.relative(sourceDir, file).replace(/\.ts$/, '.js')
  const target = path.join(outputDir, relative)
  const text = compile(file, (code) => localJs(code.replace(
    /(from\s+['"])(?:\.\.\/)+shared\/src\/([^'"]+)\.ts(['"])/g,
    '$1./shared/$2.js$3',
  )))
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text)
  bytes += Buffer.byteLength(text)
  written += 1
}

process.stdout.write(`已构建 ${written} 个模块到 lib/（${(bytes / 1024).toFixed(1)} KB）\n`)
