import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadSiteSyncForm,
  saveSiteSyncForm,
  SITE_SYNC_FORM_STORAGE_KEY
} from './site-sync-form'

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  }
}

describe('site sync form cache', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads values saved by another component', () => {
    vi.stubGlobal('localStorage', createStorage())
    saveSiteSyncForm('http://127.0.0.1:3010', 'secret-token')

    expect(loadSiteSyncForm()).toEqual({
      targetBaseUrl: 'http://127.0.0.1:3010',
      token: 'secret-token'
    })
  })

  it('drops the cache after 24 hours', () => {
    const storage = createStorage()
    vi.stubGlobal('localStorage', storage)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
    saveSiteSyncForm('http://target', 'token')

    vi.setSystemTime(new Date('2026-10-20T00:00:01Z'))

    expect(loadSiteSyncForm()).toBeNull()
    expect(storage.getItem(SITE_SYNC_FORM_STORAGE_KEY)).toBeNull()
  })
})
