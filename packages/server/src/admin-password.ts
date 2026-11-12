/**
 * 管理密码的 CLI 重置工具（供 `dscs-server admin reset-password` 使用）。
 *
 * 与 HTTP 修改密码不同：CLI 拥有服务器文件系统权限，属于 break-glass 路径；
 * 调用方应在本机执行，并在重置后重启 server，使内存中的旧管理会话失效。
 *
 * @module @dsh-session-cloudsync/server/admin-password
 */
import { randomBytes } from 'node:crypto'
import { deriveMasterKey, newSalt } from '../../shared/src/crypto.ts'
import { recordAudit } from './audit.ts'
import { isAdminInitialized, setAdminPassword, type ServerDb } from './db.ts'
import { validateAdminPassword } from './http.ts'

/**
 * 生成一个满足管理密码策略的随机密码。
 * @returns 随机密码。
 */
export function generateAdminPassword(): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomBytes(18).toString('base64url')
    if (validateAdminPassword(candidate) === undefined) return candidate
  }
  // 极端情况下 base64url 没有数字/特殊字符；补足策略要求。
  return randomBytes(18).toString('base64url') + '!aA1'
}

/**
 * 直接设置新的管理密码，并写审计。
 * @param db - 已打开的数据库。
 * @param password - 已通过策略校验的新密码。
 */
export function resetAdminPassword(db: ServerDb, password: string): void {
  if (!isAdminInitialized(db)) throw new Error('尚未初始化，请先通过 /admin 完成初始化')
  const problem = validateAdminPassword(password)
  if (problem !== undefined) throw new Error(problem)
  const salt = newSalt()
  setAdminPassword(db, deriveMasterKey(password, salt).toString('hex'), salt.toString('hex'))
  recordAudit(db, { actorKind: 'system', actorId: 'cli', action: 'password.reset_cli' })
}
