/**
 * 内容寻址的 blob 存储。
 *
 * 每个 blob 以自身字节的 SHA-256 命名。blob 不可变，所以"与同内容的写入
 * 竞争失败"不算错误：目标位置已经存着同样的字节。
 *
 * @module @dsh-session-sync/server/blobs
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 一个 blob 的文件系统路径。
 * @param dataDir - 服务端数据目录。
 * @param sha256 - 小写十六进制摘要。
 * @returns 绝对路径。
 */
export function blobPath(dataDir: string, sha256: string): string {
  return join(dataDir, 'blobs', sha256.slice(0, 2), sha256)
}

/**
 * 存储字节并返回内容地址。
 * @param dataDir - 服务端数据目录。
 * @param bytes - 要存的内容。
 * @returns 摘要与字节数。
 */
export async function putBlob(dataDir: string, bytes: Buffer): Promise<{ sha256: string; bytes: number }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const target = blobPath(dataDir, sha256)
  try {
    await stat(target)
    return { sha256, bytes: bytes.length }
  } catch {
    // 尚未存储。
  }
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, bytes)
  try {
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    // 并发写入者可能已经先发布了同样的内容。
    try {
      await stat(target)
    } catch {
      throw error
    }
  }
  return { sha256, bytes: bytes.length }
}

/**
 * 判断某个 blob 是否存在。
 * @param dataDir - 服务端数据目录。
 * @param sha256 - 小写十六进制摘要。
 * @returns 文件存在时为 true。
 */
export async function hasBlob(dataDir: string, sha256: string): Promise<boolean> {
  try {
    await stat(blobPath(dataDir, sha256))
    return true
  } catch {
    return false
  }
}

/**
 * 读取一个 blob。
 * @param dataDir - 服务端数据目录。
 * @param sha256 - 小写十六进制摘要。
 * @returns 存储的字节。
 * @throws blob 不存在时抛出。
 */
export async function readBlob(dataDir: string, sha256: string): Promise<Buffer> {
  return readFile(blobPath(dataDir, sha256))
}
