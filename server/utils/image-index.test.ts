import { describe, expect, it } from 'vitest'
import { validateImageKey } from './image-key'
import { insertActivityLog, insertUser } from './db'
import { getMediaStats, insertImageIndex } from './image-index'
import { ensureDefaultBackends } from './storage-backends'

describe('image index key validation', () => {
  it('accepts standard image keys used in index', () => {
    expect(validateImageKey('images/2026/03/abc.webp')).toBe(true)
    expect(validateImageKey('images/file/111.webp')).toBe(true)
    expect(validateImageKey('images/2026/08/28/123.webp')).toBe(true)
    expect(validateImageKey('images/abc.webp')).toBe(true)
  })

  it('rejects legacy top-level keys and path traversal', () => {
    expect(validateImageKey('../secret')).toBe(false)
    expect(validateImageKey('images/../../etc/passwd')).toBe(false)
    expect(validateImageKey('twikoo/2026/03/abc.webp')).toBe(false)
    expect(validateImageKey('blog/abc.webp')).toBe(false)
  })
})

describe('image stats isolation', () => {
  it('scopes upload source counts to the selected user', () => {
    ensureDefaultBackends()
    const now = new Date().toISOString()
    const userA = insertUser({
      username: 'stats-user-a',
      passwordHash: 'hash-a',
      role: 'user',
      createdAt: now
    })
    const userB = insertUser({
      username: 'stats-user-b',
      passwordHash: 'hash-b',
      role: 'user',
      createdAt: now
    })

    insertImageIndex({
      key: 'images/2026/10/stats-a.webp',
      backendId: 'local',
      userId: userA,
      originalName: 'stats-a.webp',
      contentType: 'image/webp',
      size: 1,
      uploadedAt: now
    })
    insertImageIndex({
      key: 'images/2026/10/stats-b.webp',
      backendId: 'local',
      userId: userB,
      originalName: 'stats-b.webp',
      contentType: 'image/webp',
      size: 1,
      uploadedAt: now
    })
    insertActivityLog({
      action: 'upload',
      key: 'images/2026/10/stats-a.webp',
      originalName: 'stats-a.webp',
      size: 1,
      contentType: 'image/webp',
      source: 'web',
      userId: userA
    })
    insertActivityLog({
      action: 'upload',
      key: 'images/2026/10/stats-b.webp',
      originalName: 'stats-b.webp',
      size: 1,
      contentType: 'image/webp',
      source: 'api',
      userId: userB
    })

    expect(getMediaStats('image', userA).bySource).toEqual({ web: 1, api: 0 })
    expect(getMediaStats('image', userB).bySource).toEqual({ web: 0, api: 1 })
  })
})
