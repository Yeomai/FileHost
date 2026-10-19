export const SITE_SYNC_FORM_STORAGE_KEY = 'pichost.site-sync-form'
export const SITE_SYNC_FORM_TTL_MS = 24 * 60 * 60 * 1000

export interface SiteSyncFormCache {
  targetBaseUrl: string
  token: string
}

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function loadSiteSyncForm(): SiteSyncFormCache | null {
  const storage = getStorage()
  if (!storage) return null

  try {
    const raw = storage.getItem(SITE_SYNC_FORM_STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as {
      targetBaseUrl?: unknown
      token?: unknown
      savedAt?: unknown
    }
    if (typeof data.savedAt !== 'number' || Date.now() - data.savedAt > SITE_SYNC_FORM_TTL_MS) {
      storage.removeItem(SITE_SYNC_FORM_STORAGE_KEY)
      return null
    }
    return {
      targetBaseUrl: typeof data.targetBaseUrl === 'string' ? data.targetBaseUrl : '',
      token: typeof data.token === 'string' ? data.token : ''
    }
  } catch {
    storage.removeItem(SITE_SYNC_FORM_STORAGE_KEY)
    return null
  }
}

export function saveSiteSyncForm(targetBaseUrl: string, token: string): void {
  const storage = getStorage()
  if (!storage) return

  try {
    storage.setItem(SITE_SYNC_FORM_STORAGE_KEY, JSON.stringify({
      targetBaseUrl,
      token,
      savedAt: Date.now()
    }))
  } catch {
    // 存储不可用时忽略
  }
}
