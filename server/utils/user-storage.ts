import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { getDb } from './db'
import {
  deleteImageIndex,
  listImageIndexRowsForUser
} from './image-index'
import { getBackendForKey } from './storage/resolver'
import type { StorageBackend } from './storage/types'
import { cancelTranscode } from './transcode'
import { collectMediaAssetKeys } from './media-assets'
import {
  deleteBackupJobsForUser,
  getActiveBackupJob,
  listAllBackupJobsForUser,
  type BackupJob
} from './backup/jobs'
import {
  getBackupsDir,
  getBackupStagingDir,
  isSafeBackupFilename
} from './backup/paths'

const activeUsers = new Set<number>()

export interface ClearUserStorageResult {
  deletedMedia: number
  deletedObjects: number
  deletedTags: number
  deletedLogs: number
  clearedCacheDirs: number
  deletedJobs: number
  failed: Array<{ key: string, message: string }>
}

export interface ClearUserStorageOptions {
  /** 用户注销时保留备份任务，避免影响管理员的备份数据 */
  deleteBackupJobs?: boolean
}

async function deleteObject(
  backend: StorageBackend,
  key: string
): Promise<boolean> {
  if (!await backend.head(key)) return false
  await backend.delete(key)
  return true
}

async function clearHlsDownloadCache(userId: number): Promise<number> {
  let removed = 0
  const prefix = `pichost-hls-download-${userId}-`
  try {
    const entries = await fs.readdir(tmpdir(), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
      await fs.rm(join(tmpdir(), entry.name), { recursive: true, force: true })
      removed++
    }
  } catch {
    // Cache cleanup failure does not affect the media cleanup result.
  }
  return removed
}

async function removeBackupJobArtifacts(job: BackupJob): Promise<void> {
  await fs.rm(getBackupStagingDir(job.id), { recursive: true, force: true }).catch(() => {})

  const paths = [
    job.outputPath,
    typeof job.payload.archivePath === 'string' ? job.payload.archivePath : null
  ]
  for (const path of paths) {
    if (!path || !isSafeBackupFilename(basename(path))) continue
    if (resolve(dirname(path)) !== resolve(getBackupsDir())) continue
    await fs.rm(path, { force: true }).catch(() => {})
  }
}

export async function clearUserStorage(
  userId: number,
  options: ClearUserStorageOptions = {}
): Promise<ClearUserStorageResult> {
  const deleteBackupJobs = options.deleteBackupJobs !== false
  if (activeUsers.has(userId)) {
    throw new Error('USER_STORAGE_CLEAR_IN_PROGRESS')
  }
  activeUsers.add(userId)

  const result: ClearUserStorageResult = {
    deletedMedia: 0,
    deletedObjects: 0,
    deletedTags: 0,
    deletedLogs: 0,
    clearedCacheDirs: 0,
    deletedJobs: 0,
    failed: []
  }

  try {
    if (getActiveBackupJob(userId)) {
      throw new Error('USER_STORAGE_CLEAR_ACTIVE_JOB')
    }

    const backupJobs = deleteBackupJobs ? listAllBackupJobsForUser(userId) : []
    const rows = listImageIndexRowsForUser(userId)
    for (const row of rows) {
      try {
        cancelTranscode(row.key)
        const backend = await getBackendForKey(row.key)
        let keys: string[]
        try {
          keys = await collectMediaAssetKeys(row, backend)
        } catch {
          keys = [
            ...(Number(row.source_deleted ?? 0) !== 1 ? [row.key] : []),
            ...(row.thumb_key ? [row.thumb_key] : []),
            ...(row.hls_key ? [row.hls_key] : [])
          ]
        }

        for (const key of new Set(keys)) {
          if (await deleteObject(backend, key)) result.deletedObjects++
        }
        deleteImageIndex(row.key)
        result.deletedMedia++
      } catch (error) {
        result.failed.push({
          key: row.key,
          message: error instanceof Error ? error.message : '删除失败'
        })
      }
    }

    const db = getDb()
    db.prepare(`
      DELETE FROM image_tags
      WHERE image_key NOT IN (SELECT key FROM images)
    `).run()

    if (!result.failed.length) {
      const tagCount = db.prepare('SELECT COUNT(*) AS count FROM tags WHERE user_id = ?')
        .get(userId) as { count: number }
      const logCount = db.prepare('SELECT COUNT(*) AS count FROM activity_logs WHERE user_id = ?')
        .get(userId) as { count: number }

      db.exec('BEGIN')
      try {
        db.prepare(`
          DELETE FROM image_tags
          WHERE tag_id IN (SELECT id FROM tags WHERE user_id = ?)
        `).run(userId)
        db.prepare('DELETE FROM tags WHERE user_id = ?').run(userId)
        db.prepare('DELETE FROM activity_logs WHERE user_id = ?').run(userId)
        db.prepare(`
          UPDATE users
          SET auto_delete_days = 0, auto_delete_enabled_at = NULL
          WHERE id = ?
        `).run(userId)
        db.exec('COMMIT')
        result.deletedTags = Number(tagCount.count)
        result.deletedLogs = Number(logCount.count)
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }

    if (!result.failed.length && deleteBackupJobs) {
      for (const job of backupJobs) {
        await removeBackupJobArtifacts(job)
      }
      result.deletedJobs = deleteBackupJobsForUser(userId)
    }

    result.clearedCacheDirs = await clearHlsDownloadCache(userId)
    return result
  } finally {
    activeUsers.delete(userId)
  }
}

/** 管理员注销用户：清理当前有效数据，但保留备份与管理员审计数据 */
export async function deleteUserCurrentData(
  userId: number
): Promise<ClearUserStorageResult> {
  const db = getDb()
  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(userId) as { id: number, username: string, role: string } | undefined

  if (!target) throw new Error('USER_NOT_FOUND')
  if (target.role === 'admin') throw new Error('ADMIN_USER_DELETE_FORBIDDEN')

  // 先终止会话，避免清理过程中继续上传；失败时用户仍可重新登录。
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)

  const result = await clearUserStorage(userId, { deleteBackupJobs: false })
  if (result.failed.length) return result

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    db.prepare(`
      UPDATE activity_logs
      SET original_name = '已注销用户'
      WHERE key LIKE ?
    `).run(`users/${userId}/%`)
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return result
}
