/**
 * 构建自部署服务端：把 `src/**.ts` 和共享原语转成无 TypeScript 运行时依赖的
 * `dist/**.js`，供 npm 包、install 脚本和离线 tarball 使用。
 *
 * Node 24 可以在开发时直接跑 `.ts`，但发布包不能依赖这个实验行为。
 *
 * @module dscs-server/scripts/build
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(root, 'src')
const outputDir = path.join(root, 'dist')
const sharedDir = path.resolve(root, '..', 'shared', 'src')
const sharedOutput = path.join(outputDir, 'shared')

function sources(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

function compile(file, transformImports) {
  const transformed = stripTypeScriptTypes(readFileSync(file, 'utf8'), {
    mode: 'transform',
    sourceUrl: path.basename(file),
  })
  return transformImports(transformed)
}

function localJs(text) {
  return text.replace(/(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
}

rmSync(outputDir, { recursive: true, force: true })
let written = 0
let bytes = 0

mkdirSync(sharedOutput, { recursive: true })
for (const file of sources(sharedDir)) {
  const relative = path.relative(sharedDir, file).replace(/\.ts$/, '.js')
  const target = path.join(sharedOutput, relative)
  const text = compile(file, localJs)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text)
  bytes += Buffer.byteLength(text)
  written += 1
}

for (const file of sources(sourceDir)) {
  const relative = path.relative(sourceDir, file).replace(/\.ts$/, '.js')
  const target = path.join(outputDir, relative)
  const text = compile(file, (code) => localJs(code.replace(
    /(from\s+['"])(?:\.\.\/)+shared\/src\/([^'"]+)\.ts(['"])/g,
    '$1./shared/$2.js$3',
  )))
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text, { mode: file.endsWith('index.ts') ? 0o755 : 0o644 })
  bytes += Buffer.byteLength(text)
  written += 1
}

console.log(`已构建 ${written} 个模块到 dist/（${Math.round(bytes / 1024)} KB）`)
