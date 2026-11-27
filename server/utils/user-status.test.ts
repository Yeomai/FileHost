import { describe, expect, it } from 'vitest'
import {
  createSessionRow,
  findUserByApiToken,
  findUserById,
  getDb,
  insertUser,
  setUserApiToken,
  setUserDisabled
} from './db'

describe('user disabled status', () => {
  it('blocks API tokens and revokes sessions until re-enabled', () => {
    const now = new Date().toISOString()
    const userId = insertUser({
      username: 'disabled-user',
      passwordHash: 'hash',
      role: 'user',
      createdAt: now
    })
    const token = 'disabled-user-token'
    const sessionId = 'disabled-user-session'
    setUserApiToken(userId, token)
    createSessionRow({
      id: sessionId,
      userId,
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: now
    })

    setUserDisabled(userId, true)

    expect(findUserById(userId)?.disabled_at).not.toBeNull()
    expect(findUserByApiToken(token)).toBeNull()
    expect(getDb().prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId))
      .toBeUndefined()

    setUserDisabled(userId, false)

    expect(findUserById(userId)?.disabled_at).toBeNull()
    expect(findUserByApiToken(token)?.id).toBe(userId)
  })
})
