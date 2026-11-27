import { readFormData } from 'h3'
import type { UploadResponse, UploadErrorItem, ImageItem } from '~/types/image'
import { requireUploadAuth, verifyApiUploadToken, getUploadUserId } from '../../utils/access'
import { MAX_FILES_PER_UPLOAD } from '../../utils/constants'
import {
  detectMimeFromSignature,
  isAllowedMimeType
} from '../../utils/file-signature'
import {
  mimeMatchesDeclared,
  processSingleImageUpload
} from '../../utils/process-image-upload'
import { createApiError } from '../../utils/api-error'
import { checkUploadRateLimit } from '../../utils/rate-limit'
import {
  readFormDataFieldValues,
  readFormDataFiles
} from '../../utils/multipart-form'
import {
  parseTagNamesParam,
  resolveUploadTagIds
} from '../../utils/tags'

export default defineEventHandler(async (event) => {
  await requireUploadAuth(event)

  const formData = await readFormData(event)
  if (!formData) {
    createApiError(event, 'INVALID_REQUEST', '未收到上传文件', 400)
  }

  const tokenField = formData.get('token')
  const formToken = typeof tokenField === 'string' ? tokenField.trim() : ''
  checkUploadRateLimit(event, formToken)

  const source = verifyApiUploadToken(event) ? 'api' : 'web'
  const uploadUserId = await getUploadUserId(event, formToken)

  const tagNamesRaw = readFormDataFieldValues(formData, 'tagNames')
  const uploadTagNames = parseTagNamesParam(tagNamesRaw.length === 1 ? tagNamesRaw[0] : tagNamesRaw)
  const resolvedTags = resolveUploadTagIds(uploadUserId, uploadTagNames)
  if ('message' in resolvedTags) {
    createApiError(event, 'INVALID_REQUEST', resolvedTags.message, 400)
  }
  const uploadTagIds = resolvedTags.tagIds

  // 兼容 image / file / files 字段名（图床脚本 / 通用客户端 / 网页多图）
  const fileParts = readFormDataFiles(
    formData,
    ['image', 'file', 'files']
  )
  if (!fileParts.length) {
    createApiError(event, 'INVALID_REQUEST', '未收到上传文件', 400)
  }

  if (fileParts.length > MAX_FILES_PER_UPLOAD) {
    createApiError(
      event,
      'TOO_MANY_FILES',
      `每次最多上传 ${MAX_FILES_PER_UPLOAD} 张图片`,
      400
    )
  }

  const items: ImageItem[] = []
  const errors: UploadErrorItem[] = []

  for (const part of fileParts) {
    const originalName = part.name || 'image'
    const bytes = new Uint8Array(await part.arrayBuffer())
    const declaredMime = part.type?.toLowerCase() ?? ''
    const detectedMime = detectMimeFromSignature(bytes)

    if (detectedMime && !mimeMatchesDeclared(declaredMime, detectedMime)) {
      errors.push({
        name: originalName,
        error: {
          code: 'INVALID_FILE_SIGNATURE',
          message: '文件类型与内容不匹配'
        }
      })
      continue
    }

    if (declaredMime && isAllowedMimeType(declaredMime) && !detectedMime) {
      errors.push({
        name: originalName,
        error: {
          code: 'INVALID_FILE_SIGNATURE',
          message: '无法识别的图片格式'
        }
      })
      continue
    }

    const result = await processSingleImageUpload(event, {
      bytes,
      filename: part.name,
      source,
      userId: uploadUserId,
      tagIds: uploadTagIds
    })

    if ('error' in result) {
      errors.push(result.error)
    } else {
      items.push(result.item)
    }
  }

  const response: UploadResponse = {
    success: items.length > 0,
    items,
    errors
  }

  if (!items.length && errors.length) {
    setResponseStatus(event, 400)
  }

  return response
})
