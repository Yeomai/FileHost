import { getHeader, readFormData, type H3Event } from 'h3'
import { createApiError } from '../../utils/api-error'
import { isInitialized } from '../../utils/auth'
import { serializeBackupJob } from '../../utils/backup/api'
import { startFullRestoreJob } from '../../utils/backup/runner'
import { BACKUP_ARCHIVE_EXT, getBackupsDir } from '../../utils/backup/paths'
import { readFormDataFiles } from '../../utils/multipart-form'
import { join } from 'node:path'
import { createWriteStream, promises as fs } from 'node:fs'
import { pipeline } from 'node:stream/promises'

async function saveRestoreUpload(event: H3Event, archivePath: string): Promise<void> {
  const contentType = getHeader(event, 'content-type') ?? ''
  try {
    if (contentType.includes('application/octet-stream')) {
      await pipeline(event.node.req, createWriteStream(archivePath))
    } else {
      const form = await readFormData(event)
      const file = readFormDataFiles(form, ['file'])[0]
      if (!file) {
        createApiError(event, 'INVALID_REQUEST', '请上传备份文件', 400)
      }
      await fs.writeFile(archivePath, new Uint8Array(await file.arrayBuffer()))
    }
    const stat = await fs.stat(archivePath)
    if (stat.size === 0) {
      createApiError(event, 'INVALID_REQUEST', '备份文件为空', 400)
    }
  } catch (error) {
    await fs.rm(archivePath, { force: true }).catch(() => {})
    throw error
  }
}

export default defineEventHandler(async (event) => {
  if (isInitialized()) {
    createApiError(event, 'FORBIDDEN', '系统已初始化，请在存储页恢复备份', 403)
  }

  await fs.mkdir(getBackupsDir(), { recursive: true })
  const archivePath = join(getBackupsDir(), `setup-restore-${Date.now()}${BACKUP_ARCHIVE_EXT}`)
  await saveRestoreUpload(event, archivePath)

  try {
    const job = startFullRestoreJob(archivePath, 'overwrite')
    return {
      job: serializeBackupJob(job),
      message: '恢复任务已开始，完成后请使用备份中的管理员账号登录'
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'BACKUP_JOB_RUNNING') {
      createApiError(event, 'CONFLICT', '已有备份或迁移任务正在运行', 409)
    }
    throw error
  }
})
