import { readFormData } from 'h3'
import type { FileItem, FileUploadResponse } from '~/types/file'
import type { UploadErrorItem } from '~/types/image'
import {
  getUploadUserId,
  requireUploadAuth,
  verifyApiUploadToken
} from '../../utils/access'
import { MAX_FILES_PER_UPLOAD } from '../../utils/constants'
import { createApiError } from '../../utils/api-error'
import { checkUploadRateLimit } from '../../utils/rate-limit'
import { processSingleFileUpload } from '../../utils/file-bed'
import { getFileBedAccessMode } from '../../utils/env'
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
  const uploadTagNames = parseTagNamesParam(
    tagNamesRaw.length === 1 ? tagNamesRaw[0] : tagNamesRaw
  )
  const resolvedTags = resolveUploadTagIds(uploadUserId, uploadTagNames)
  if ('message' in resolvedTags) {
    createApiError(event, 'INVALID_REQUEST', resolvedTags.message, 400)
  }
  const uploadTagIds = resolvedTags.tagIds

  const fileParts = readFormDataFiles(
    formData,
    ['file', 'files']
  )
  if (!fileParts.length) {
    createApiError(event, 'INVALID_REQUEST', '未收到上传文件', 400)
  }

  if (fileParts.length > MAX_FILES_PER_UPLOAD) {
    createApiError(
      event,
      'TOO_MANY_FILES',
      `每次最多上传 ${MAX_FILES_PER_UPLOAD} 个文件`,
      400
    )
  }

  const items: FileItem[] = []
  const errors: UploadErrorItem[] = []

  for (const part of fileParts) {
    const result = await processSingleFileUpload(event, {
      bytes: new Uint8Array(await part.arrayBuffer()),
      filename: part.name,
      contentType: part.type,
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

  const response: FileUploadResponse = {
    success: items.length > 0,
    items,
    errors,
    accessMode: getFileBedAccessMode()
  }

  if (!items.length && errors.length) {
    setResponseStatus(event, 400)
  }

  return response
})
