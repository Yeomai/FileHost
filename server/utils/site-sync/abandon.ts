import {
  getBackupJob,
  updateBackupJob,
  type BackupJob
} from '../backup/jobs'
import { cleanupSiteSyncJobArtifacts } from './artifacts'
import { fetchSiteSyncJson } from './runner'

interface CleanupResult {
  deleted: number
  referenced: number
  failed: number
}

export async function abandonSiteSyncJob(
  jobId: string,
  token: string,
  userId: number
): Promise<BackupJob> {
  const job = getBackupJob(jobId, userId)
  if (!job || job.type !== 'site_sync') throw new Error('同步任务不存在')
  if (job.status !== 'failed') throw new Error('只能放弃已停止的同步任务')

  const direction = job.payload.direction === 'pull' ? 'pull' : 'push'
  const targetBaseUrl = typeof job.payload.targetBaseUrl === 'string'
    ? job.payload.targetBaseUrl.replace(/\/+$/, '')
    : ''
  let cleanup: CleanupResult
  if (direction === 'push') {
    if (!targetBaseUrl || !token) {
      throw new Error('放弃推送任务并清理目标站残留时，需要目标站 Token')
    }
    cleanup = await fetchSiteSyncJson<CleanupResult>(
      `${targetBaseUrl}/api/site-sync/cleanup`,
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId })
      }
    )
  } else {
    cleanup = await cleanupSiteSyncJobArtifacts(jobId)
  }

  if (cleanup.failed > 0) {
    throw new Error(`同步残留清理失败：${cleanup.failed} 个对象`)
  }

  const message = `已放弃同步 · 清理 ${cleanup.deleted} 个残留对象`
  updateBackupJob(jobId, {
    status: 'failed',
    message,
    error: '已放弃同步',
    finishedAt: new Date().toISOString(),
    payload: {
      ...job.payload,
      resumable: false,
      abandoned: true,
      cancelled: false,
      failedKeys: [],
      cleanup
    }
  })
  return getBackupJob(jobId, userId)!
}
