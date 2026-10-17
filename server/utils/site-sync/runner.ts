import { basename } from 'node:path'
import { contentTypeFromKey } from '../content-type'
import {
  getImageIndexRow,
  listAllImageIndexRows,
  type ImageIndexRow
} from '../image-index'
import {
  findUserByUsername,
  getPrimaryAdminUserId,
  listUserIdUsernameMap
} from '../db'
import { collectMediaAssetKeys } from '../media-assets'
import {
  getActiveBackend,
  getBackendForKey
} from '../storage/resolver'
import type { StorageBackend } from '../storage/types'
import {
  getBackupJob,
  markJobDone,
  markJobFailed,
  updateBackupJob
} from '../backup/jobs'
import { applySiteSyncMedia } from './apply'
import { toSiteSyncMediaTransferWithTags } from './manifest'
import type {
  SiteSyncDirection,
  SiteSyncInventory,
  SiteSyncMediaBundle,
  SiteSyncMediaPage,
  SiteSyncUsers
} from './protocol'

export interface SiteSyncOptions {
  targetBaseUrl: string
  conflictMode: 'skip' | 'overwrite'
  direction: SiteSyncDirection
}

const tokens = (globalThis as typeof globalThis & {
  __pichostSiteSyncTokens?: Map<string, string>
}).__pichostSiteSyncTokens ?? new Map<string, string>()
;(globalThis as typeof globalThis & {
  __pichostSiteSyncTokens?: Map<string, string>
}).__pichostSiteSyncTokens = tokens

export function registerSiteSyncToken(jobId: string, token: string): void {
  tokens.set(jobId, token)
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function targetUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

async function responseError(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => null) as {
    message?: string
    statusMessage?: string
  } | null
  return new Error(payload?.message || payload?.statusMessage || `目标站点返回 ${response.status}`)
}

const SITE_SYNC_MAX_ATTEMPTS = 3

export async function retrySiteSyncOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= SITE_SYNC_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('两站点同步失败')
      if (attempt < SITE_SYNC_MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500))
      }
    }
  }
  throw lastError ?? new Error('两站点同步失败')
}

async function fetchSiteSyncJsonOnce<T>(
  url: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Auth-Token': token,
      ...(init?.headers ?? {})
    }
  })
  if (!response.ok) throw await responseError(response)
  return await response.json() as T
}

export async function fetchSiteSyncJson<T>(
  url: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  return retrySiteSyncOperation(() => (
    fetchSiteSyncJsonOnce<T>(url, token, init)
  ))
}

async function uploadObject(
  options: SiteSyncOptions,
  token: string,
  backend: StorageBackend,
  row: ImageIndexRow,
  ownerUsername: string | null,
  key: string
): Promise<void> {
  const stored = await backend.head(key)
  if (!stored) throw new Error(`源文件不存在：${key}`)
  const bytes = await streamToBuffer(await backend.createStream(key))
  const form = new FormData()
  const isPrimary = key === row.key
  form.append('key', key)
  form.append('conflictMode', options.conflictMode)
  form.append('ownerUsername', ownerUsername ?? '')
  form.append('originalName', isPrimary ? row.original_name : basename(key))
  form.append('uploadedAt', row.uploaded_at)
  const contentType = isPrimary ? row.content_type : contentTypeFromKey(key)
  form.append('contentType', contentType)
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: contentType }),
    basename(key)
  )

  await fetchSiteSyncJsonOnce<{ success: boolean }>(
    targetUrl(options.targetBaseUrl, '/api/site-sync/object'),
    token,
    { method: 'POST', body: form }
  )
}

async function downloadSiteSyncObject(
  options: SiteSyncOptions,
  token: string,
  key: string
): Promise<Buffer> {
  const response = await fetch(
    targetUrl(
      options.targetBaseUrl,
      `/api/site-sync/object?key=${encodeURIComponent(key)}`
    ),
    {
      headers: {
        'Auth-Token': token
      }
    }
  )
  if (!response.ok) throw await responseError(response)
  return Buffer.from(await response.arrayBuffer())
}

async function runSiteSyncPull(
  jobId: string,
  options: SiteSyncOptions,
  token: string
): Promise<void> {
  const job = getBackupJob(jobId)
  const checkpoint = job?.payload ?? {}
  let lastMediaKey = typeof checkpoint.lastMediaKey === 'string'
    ? checkpoint.lastMediaKey
    : ''
  let scanned = Number(checkpoint.scanned ?? 0)
  let added = Number(checkpoint.added ?? 0)
  let skipped = Number(checkpoint.skipped ?? 0)
  let filesSynced = Number(checkpoint.filesSynced ?? 0)
  let totalFiles = Number(checkpoint.totalFiles ?? 0)
  let totalMedia = Number(checkpoint.totalMedia ?? job?.total ?? 0)
  const failedKeys = new Set(
    Array.isArray(checkpoint.failedKeys)
      ? checkpoint.failedKeys.filter((key): key is string => typeof key === 'string')
      : []
  )

  const saveCheckpoint = (message: string) => {
    updateBackupJob(jobId, {
      progress: scanned,
      total: totalMedia,
      message,
      payload: {
        targetBaseUrl: options.targetBaseUrl,
        conflictMode: options.conflictMode,
        direction: 'pull',
        lastMediaKey,
        scanned,
        added,
        skipped,
        failed: failedKeys.size,
        filesSynced,
        totalFiles,
        totalMedia,
        failedKeys: [...failedKeys],
        resumable: true
      }
    })
  }
  const progressMessage = (suffix = '') => (
    `扫描 ${scanned}/${totalMedia || scanned} · 新增 ${added} · 跳过 ${skipped} · 失败 ${failedKeys.size}${suffix}`
  )
  const failAndCheckpoint = (error: unknown) => {
    const message = progressMessage(' · 已保存断点')
    saveCheckpoint(message)
    markJobFailed(
      jobId,
      error instanceof Error ? error.message : '从目标站点拉取失败',
      message
    )
  }

  try {
    const targetUsers = new Set(
      (await fetchSiteSyncJson<SiteSyncUsers>(
        targetUrl(options.targetBaseUrl, '/api/site-sync/users'),
        token
      )).users
    )
    const localUserMap = listUserIdUsernameMap()
    const localUsers = new Set(localUserMap.values())
    const missingUsers = [...targetUsers].filter(name => !localUsers.has(name))
    if (missingUsers.length) {
      throw new Error(`当前站点缺少同名用户：${missingUsers.join('、')}`)
    }

    const backend = await retrySiteSyncOperation(() => getActiveBackend())
    const actorUserId = job?.userId ?? getPrimaryAdminUserId() ?? 0
    const readMediaPage = (path: string) => fetchSiteSyncJson<SiteSyncMediaPage>(
      targetUrl(options.targetBaseUrl, path),
      token
    )

    const processBundleOnce = async (
      bundle: SiteSyncMediaBundle,
      isRetry: boolean
    ): Promise<'added' | 'skipped'> => {
      const { media, assets } = bundle
      if (
        !isRetry
        && options.conflictMode === 'skip'
        && getImageIndexRow(media.key)
      ) {
        return 'skipped'
      }

      const owner = media.ownerUsername
        ? findUserByUsername(media.ownerUsername)
        : null
      for (const asset of assets) {
        if (
          options.conflictMode === 'skip'
          && await backend.head(asset.key)
        ) {
          continue
        }
        const bytes = await downloadSiteSyncObject(
          options,
          token,
          asset.key
        )
        if (bytes.length !== asset.size) {
          throw new Error(
            `同步对象大小不一致：${asset.key}，预期 ${asset.size}，实际 ${bytes.length}`
          )
        }
        const isPrimary = asset.key === media.key
        await backend.put(asset.key, new Uint8Array(bytes), {
          originalName: isPrimary ? media.originalName : basename(asset.key),
          uploadedAt: media.uploadedAt,
          contentType: isPrimary
            ? media.contentType
            : contentTypeFromKey(asset.key),
          size: bytes.length,
          userId: owner?.id ?? null,
          mediaType: isPrimary
            ? media.mediaType
            : asset.key.startsWith('videos/')
              ? 'video'
              : asset.key.startsWith('files/')
                ? 'file'
                : 'image'
        })
      }

      await applySiteSyncMedia(media, 'overwrite', actorUserId)
      return 'added'
    }
    const processBundle = (bundle: SiteSyncMediaBundle, isRetry: boolean) => (
      retrySiteSyncOperation(() => processBundleOnce(bundle, isRetry))
    )
    const recordOutcome = (outcome: 'added' | 'skipped', fileCount: number) => {
      if (outcome === 'added') added += 1
      else skipped += 1
      filesSynced += fileCount
      totalFiles = Math.max(totalFiles, filesSynced)
    }

    for (const key of [...failedKeys]) {
      try {
        const page = await readMediaPage(
          `/api/site-sync/media?key=${encodeURIComponent(key)}`
        )
        const bundle = page.items[0]
        if (!bundle) throw new Error(`目标媒体不存在：${key}`)
        const outcome = await processBundle(bundle, true)
        recordOutcome(outcome, bundle.assets.length)
        failedKeys.delete(key)
        if (key > lastMediaKey) lastMediaKey = key
        saveCheckpoint(progressMessage())
      } catch (error) {
        failedKeys.add(key)
        failAndCheckpoint(error)
        return
      }
    }

    let cursor = lastMediaKey
    let lastCheckpointAt = 0
    while (true) {
      let page: SiteSyncMediaPage
      try {
        page = await readMediaPage(
          `/api/site-sync/media?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`
        )
      } catch (error) {
        failAndCheckpoint(error)
        return
      }
      totalMedia = Math.max(totalMedia, page.totalMedia)

      for (const bundle of page.items) {
        scanned += 1
        try {
          const outcome = await processBundle(bundle, false)
          recordOutcome(outcome, bundle.assets.length)
          failedKeys.delete(bundle.media.key)
        } catch (error) {
          failedKeys.add(bundle.media.key)
          lastMediaKey = bundle.media.key
          failAndCheckpoint(error)
          return
        }

        lastMediaKey = bundle.media.key
        const now = Date.now()
        if (
          now - lastCheckpointAt >= 1000
          || scanned === totalMedia
          || !page.nextCursor
        ) {
          saveCheckpoint(progressMessage())
          lastCheckpointAt = now
        }
      }

      if (!page.nextCursor) break
      cursor = page.nextCursor
    }

    if (failedKeys.size) {
      markJobFailed(
        jobId,
        `${failedKeys.size} 条媒体拉取失败`,
        progressMessage()
      )
      saveCheckpoint(progressMessage())
      return
    }

    totalFiles = filesSynced
    markJobDone(jobId, {
      message: `扫描 ${scanned}/${totalMedia || scanned} · 新增 ${added} · 跳过 ${skipped} · 失败 0`,
      payload: {
        targetBaseUrl: options.targetBaseUrl,
        conflictMode: options.conflictMode,
        direction: 'pull',
        lastMediaKey,
        scanned,
        added,
        skipped,
        failed: 0,
        filesSynced,
        totalFiles,
        totalMedia: totalMedia || scanned,
        failedKeys: [],
        resumable: false
      }
    })
  } catch (error) {
    failAndCheckpoint(error)
  }
}

export async function runSiteSyncJob(
  jobId: string,
  options: SiteSyncOptions
): Promise<void> {
  const token = tokens.get(jobId)
  if (!token) throw new Error('同步 Token 不可用，请重新发起任务')

  try {
    if (options.direction === 'pull') {
      await runSiteSyncPull(jobId, options, token)
      return
    }

    const inventory = await fetchSiteSyncJson<SiteSyncInventory>(
      targetUrl(options.targetBaseUrl, '/api/site-sync/inventory'),
      token
    )
    const targetUsers = new Set(inventory.users)
    const targetMedia = new Set(inventory.mediaKeys)
    const targetObjects = new Map(inventory.objects.map(item => [item.key, item.size]))
    const rows = listAllImageIndexRows()
    const ownerMap = listUserIdUsernameMap()
    const job = getBackupJob(jobId)
    const checkpoint = job?.payload ?? {}
    let lastMediaKey = typeof checkpoint.lastMediaKey === 'string'
      ? checkpoint.lastMediaKey
      : ''
    let scanned = Number(checkpoint.scanned ?? 0)
    let added = Number(checkpoint.added ?? 0)
    let skipped = Number(checkpoint.skipped ?? 0)
    let filesSynced = Number(checkpoint.filesSynced ?? 0)
    const failedKeys = new Set(
      Array.isArray(checkpoint.failedKeys)
        ? checkpoint.failedKeys.filter((key): key is string => typeof key === 'string')
        : []
    )

    const missingUsers = [...new Set(
      rows
        .map(row => row.user_id == null ? null : ownerMap.get(row.user_id))
        .filter((name): name is string => Boolean(name))
    )].filter(name => !targetUsers.has(name))
    if (missingUsers.length) {
      throw new Error(`目标站点缺少同名用户：${missingUsers.join('、')}`)
    }

    const plans: Array<{
      row: ImageIndexRow
      ownerUsername: string | null
      backend: StorageBackend
      keys: string[]
    }> = []
    let totalFiles = 0
    updateBackupJob(jobId, {
      total: rows.length,
      progress: scanned,
      message: '正在统计同步文件…'
    })

    for (const row of rows) {
      const backend = await getBackendForKey(row.key)
      let assetKeys: string[]
      try {
        assetKeys = await collectMediaAssetKeys(row, backend)
      } catch {
        assetKeys = [
          ...(!Number(row.source_deleted ?? 0) ? [row.key] : []),
          ...(row.thumb_key ? [row.thumb_key] : []),
          ...(row.hls_key ? [row.hls_key] : [])
        ]
      }
      const keys = [...new Set(assetKeys)]
      totalFiles += keys.length
      plans.push({
        row,
        ownerUsername: row.user_id == null ? null : ownerMap.get(row.user_id) ?? null,
        backend,
        keys
      })
    }

    const saveCheckpoint = (message: string) => {
      updateBackupJob(jobId, {
        progress: scanned,
        total: rows.length,
        message,
        payload: {
          targetBaseUrl: options.targetBaseUrl,
          conflictMode: options.conflictMode,
          direction: 'push',
          lastMediaKey,
          scanned,
          added,
          skipped,
          failed: failedKeys.size,
          filesSynced,
          totalFiles,
          failedKeys: [...failedKeys],
          resumable: true
        }
      })
    }

    plans.sort((a, b) => (
      a.row.key < b.row.key
        ? -1
        : a.row.key > b.row.key
          ? 1
          : 0
    ))
    lastMediaKey = lastMediaKey || ''
    let lastCheckpointAt = 0
    const processPlanOnce = async (plan: typeof plans[number], isRetry: boolean) => {
      const { row, ownerUsername, backend, keys } = plan
      if (
        !isRetry
        && options.conflictMode === 'skip'
        && targetMedia.has(row.key)
      ) {
        skipped += 1
        filesSynced = Math.min(totalFiles, filesSynced + keys.length)
        failedKeys.delete(row.key)
        return
      }

      for (const key of keys) {
        const stored = await backend.head(key)
        if (!stored) throw new Error(`源文件不存在：${key}`)
        if (
          options.conflictMode === 'skip'
          && targetObjects.get(key) === stored.size
        ) {
          continue
        }
        await uploadObject(options, token, backend, row, ownerUsername, key)
      }

      await fetchSiteSyncJsonOnce<{ success: boolean }>(
        targetUrl(options.targetBaseUrl, '/api/site-sync/media'),
        token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            media: toSiteSyncMediaTransferWithTags(row, ownerUsername),
            conflictMode: options.conflictMode
          })
        }
      )

      failedKeys.delete(row.key)
      added += 1
      filesSynced = Math.min(totalFiles, filesSynced + keys.length)
    }
    const processPlan = (
      plan: typeof plans[number],
      isRetry: boolean
    ) => retrySiteSyncOperation(() => processPlanOnce(plan, isRetry))

    const retryPlans = plans.filter(plan => failedKeys.has(plan.row.key))
    for (const plan of retryPlans) {
      try {
        await processPlan(plan, true)
        lastMediaKey = plan.row.key
      } catch {
        failedKeys.add(plan.row.key)
        const message = `扫描 ${scanned}/${rows.length} · 新增 ${added} · 跳过 ${skipped} · 失败 ${failedKeys.size} · 已保存断点`
        saveCheckpoint(message)
        markJobFailed(jobId, '连续 3 次重试失败，已保存断点', message)
        return
      }
    }

    for (const plan of plans) {
      if (plan.row.key <= lastMediaKey) continue
      scanned += 1
      try {
        await processPlan(plan, false)
      } catch {
        failedKeys.add(plan.row.key)
        lastMediaKey = plan.row.key
        const message = `扫描 ${scanned}/${rows.length} · 新增 ${added} · 跳过 ${skipped} · 失败 ${failedKeys.size} · 已保存断点`
        saveCheckpoint(message)
        markJobFailed(jobId, '连续 3 次重试失败，已保存断点', message)
        return
      }
      lastMediaKey = plan.row.key
      const now = Date.now()
      if (now - lastCheckpointAt >= 1000 || scanned === rows.length || failedKeys.size) {
        saveCheckpoint(
          `扫描 ${scanned}/${rows.length} · 新增 ${added} · 跳过 ${skipped} · 失败 ${failedKeys.size}`
        )
        lastCheckpointAt = now
      }
    }

    if (failedKeys.size) {
      markJobFailed(
        jobId,
        `${failedKeys.size} 条媒体同步失败`,
        `扫描 ${scanned}/${rows.length} · 新增 ${added} · 跳过 ${skipped} · 失败 ${failedKeys.size}`
      )
      saveCheckpoint(
        `扫描 ${scanned}/${rows.length} · 新增 ${added} · 跳过 ${skipped} · 失败 ${failedKeys.size}`
      )
      return
    }

    markJobDone(jobId, {
      message: `扫描 ${rows.length}/${rows.length} · 新增 ${added} · 跳过 ${skipped} · 失败 0`,
      payload: {
        targetBaseUrl: options.targetBaseUrl,
        conflictMode: options.conflictMode,
        direction: 'push',
        lastMediaKey,
        scanned: rows.length,
        added,
        skipped,
        failed: 0,
        filesSynced: totalFiles,
        totalFiles,
        failedKeys: [],
        resumable: false
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '两站点同步失败'
    markJobFailed(jobId, message)
    throw error
  } finally {
    tokens.delete(jobId)
  }
}
