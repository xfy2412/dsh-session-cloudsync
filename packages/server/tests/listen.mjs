import { createHttpServer } from '../src/http.ts'

/**
 * fetch 规范禁止连接的口径端口（undici 会直接抛 "bad port"）。
 * Windows 的临时端口范围可能撞上其中几个，所以测试要重试。
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
])

/**
 * 在随机端口上启动服务；撞到 fetch 禁用端口时自动换一个。
 * @param db - 已打开的数据库。
 * @param dataDir - 数据目录。
 * @param options - 额外的服务端选项。
 * @returns 基地址与关闭函数。
 */
export async function listenServer(db, dataDir, options = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createHttpServer({ db, dataDir, ...options })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    if (port !== 0 && !BAD_PORTS.has(port)) {
      return {
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(resolve)),
      }
    }
    await new Promise((resolve) => server.close(resolve))
  }
  throw new Error('找不到可用的测试端口')
}
