import { getHeader, readFormData } from 'h3'
import { requireSiteSyncAuth } from '../../utils/access'
import { createApiError } from '../../utils/api-error'
import { MAX_VIDEO_FILE_SIZE } from '../../utils/constants'
import { findUserByUsername } from '../../utils/db'
import { validateStorageKey } from '../../utils/image-key'
import { getActiveBackend } from '../../utils/storage/resolver'
import { recordSiteSyncArtifact } from '../../utils/site-sync/artifacts'
import { readFormDataFiles } from '../../utils/multipart-form'

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export default defineEventHandler(async (event) => {
  await requireSiteSyncAuth(event)
  const contentLength = Number(getHeader(event, 'content-length') || 0)
  if (contentLength > MAX_VIDEO_FILE_SIZE + 1024 * 1024) {
    createApiError(event, 'FILE_TOO_LARGE', '同步文件超过 500 MB', 413)
  }
  const form = await readFormData(event)

  const key = field(form, 'key')
  const file = readFormDataFiles(form, ['file'])[0]
  if (!validateStorageKey(key) || !file) {
    createApiError(event, 'INVALID_REQUEST', '同步文件参数无效', 400)
  }
  if (file.size > MAX_VIDEO_FILE_SIZE) {
    createApiError(event, 'FILE_TOO_LARGE', '同步文件超过 500 MB', 413)
  }

  const conflictMode = field(form, 'conflictMode') === 'skip' ? 'skip' : 'overwrite'
  const backend = await getActiveBackend()
  if (conflictMode === 'skip' && await backend.head(key)) {
    return { success: true, skipped: true }
  }
  const existedBefore = Boolean(await backend.head(key))

  const ownerUsername = field(form, 'ownerUsername')
  const owner = ownerUsername ? findUserByUsername(ownerUsername) : null
  if (ownerUsername && !owner) {
    createApiError(event, 'INVALID_REQUEST', `目标站点缺少用户：${ownerUsername}`, 400)
  }

  const jobId = field(form, 'jobId')
  const mediaKey = field(form, 'mediaKey')
  if (jobId && validateStorageKey(mediaKey)) {
    recordSiteSyncArtifact({
      jobId,
      mediaKey,
      key,
      backendId: backend.id,
      created: !existedBefore
    })
  }

  await backend.put(key, new Uint8Array(await file.arrayBuffer()), {
    originalName: field(form, 'originalName') || file.name || key.split('/').pop() || 'file',
    uploadedAt: field(form, 'uploadedAt') || new Date().toISOString(),
    contentType: file.type || field(form, 'contentType') || 'application/octet-stream',
    size: file.size,
    userId: owner?.id ?? null,
    mediaType: key.startsWith('videos/')
      ? 'video'
      : key.startsWith('files/')
        ? 'file'
        : 'image'
  })

  return { success: true, skipped: false }
})
