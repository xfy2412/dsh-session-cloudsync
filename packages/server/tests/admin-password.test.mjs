import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveMasterKey, newSalt } from '../../shared/src/crypto.ts'
import { adminPassword, markAdminInitialized, openDatabase, setAdminPassword } from '../src/db.ts'
import { generateAdminPassword, resetAdminPassword } from '../src/admin-password.ts'
import { validateAdminPassword } from '../src/http.ts'
import { listAudit } from '../src/audit.ts'
import { createTempHome } from '../../../tests/helpers/tmp-home.mjs'

test('CLI 密码重置：随机密码符合策略、重置写审计、未初始化拒绝', () => {
  const temp = createTempHome('server-admin-password')
  try {
    const db = openDatabase(temp.dataDir)
    try {
      assert.throws(() => resetAdminPassword(db, 'newpass1!'), /尚未初始化/u)

      const random = generateAdminPassword()
      assert.equal(validateAdminPassword(random), undefined)

      const salt = newSalt()
      setAdminPassword(db, deriveMasterKey('oldpass1!', salt).toString('hex'), salt.toString('hex'))
      markAdminInitialized(db)
      const before = adminPassword(db)
      resetAdminPassword(db, 'newpass1!')
      const after = adminPassword(db)
      assert.notEqual(after?.hash, before?.hash)
      assert.notEqual(after?.salt, before?.salt)

      const audit = listAudit(db, { limit: 10 })
      assert.equal(audit.events[0].action, 'password.reset_cli')
      assert.equal(audit.events[0].actorKind, 'system')
      assert.equal(audit.events[0].actorId, 'cli')

      assert.throws(() => resetAdminPassword(db, 'short'), /至少 6 位/u)
    } finally {
      db.close()
    }
  } finally {
    temp.dispose()
  }
})
