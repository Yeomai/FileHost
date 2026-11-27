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
import { processSingleVideoUpload } from '../../utils/file-bed'
import {
  enqueueTranscode,
  MAX_TRANSCODE_BITRATE_PERCENT,
  MIN_TRANSCODE_BITRATE_PERCENT,
  parseTranscodePreset
} from '../../utils/transcode'
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

  const transcodeField = formData.get('transcode')
  const wantTranscode = typeof transcodeField === 'string'
    && ['1', 'true', 'yes'].includes(transcodeField.trim().toLowerCase())

  const presetField = formData.get('transcodePreset')
  const presetRaw = typeof presetField === 'string' ? presetField.trim() : ''
  const transcodePreset = presetRaw ? parseTranscodePreset(presetRaw) : undefined
  if (presetRaw && !transcodePreset) {
    createApiError(event, 'INVALID_REQUEST', '无效的转码质量档位', 400)
  }

  const bitrateField = formData.get('transcodeBitratePercent')
  const bitrateRaw = typeof bitrateField === 'string' ? bitrateField.trim() : ''
  const transcodeBitratePercent = bitrateRaw ? Number(bitrateRaw) : undefined
  if (
    bitrateRaw
    && (
      !Number.isInteger(transcodeBitratePercent)
      || transcodeBitratePercent! < MIN_TRANSCODE_BITRATE_PERCENT
      || transcodeBitratePercent! > MAX_TRANSCODE_BITRATE_PERCENT
    )
  ) {
    createApiError(
      event,
      'INVALID_REQUEST',
      `转码目标码率需为 ${MIN_TRANSCODE_BITRATE_PERCENT}–${MAX_TRANSCODE_BITRATE_PERCENT} 的整数`,
      400
    )
  }

  const fileParts = readFormDataFiles(
    formData,
    ['file', 'files', 'video']
  )
  if (!fileParts.length) {
    createApiError(event, 'INVALID_REQUEST', '未收到上传文件', 400)
  }

  if (fileParts.length > MAX_FILES_PER_UPLOAD) {
    createApiError(
      event,
      'TOO_MANY_FILES',
      `每次最多上传 ${MAX_FILES_PER_UPLOAD} 个视频`,
      400
    )
  }

  const items: FileItem[] = []
  const errors: UploadErrorItem[] = []

  for (const part of fileParts) {
    const result = await processSingleVideoUpload(event, {
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

  if (wantTranscode) {
    for (const item of items) {
      enqueueTranscode(item.key, {
        ...(transcodePreset ? { preset: transcodePreset } : {}),
        ...(transcodeBitratePercent !== undefined ? { bitratePercent: transcodeBitratePercent } : {})
      })
    }
  }

  if (!items.length && errors.length) {
    setResponseStatus(event, 400)
  }

  return response
})
