import { requireAdminAuth } from '../../../../utils/access'
import { createApiError } from '../../../../utils/api-error'
import { logActivity } from '../../../../utils/activity-log'
import { findUserById } from '../../../../utils/db'
import { deleteUserCurrentData } from '../../../../utils/user-storage'

export default defineEventHandler(async (event) => {
  const operator = await requireAdminAuth(event)

  const id = Number(getRouterParam(event, 'id'))
  const target = Number.isInteger(id) ? findUserById(id) : null
  if (!target) {
    createApiError(event, 'INVALID_REQUEST', '用户不存在', 404)
  }
  if (target.role === 'admin') {
    createApiError(event, 'FORBIDDEN', '不允许注销管理员账号', 403)
  }
  if (target.id === operator.id) {
    createApiError(event, 'INVALID_REQUEST', '不能注销当前登录账号', 400)
  }

  const body = await readBody<{ confirmation?: string }>(event).catch(() => null)
  if (body?.confirmation?.trim() !== target.username) {
    createApiError(event, 'INVALID_REQUEST', '请输入用户名确认注销', 400)
  }

  try {
    const result = await deleteUserCurrentData(target.id)
    if (result.failed.length) {
      createApiError(
        event,
        'CONFLICT',
        `有 ${result.failed.length} 个媒体删除失败，账号未注销，请重试`,
        409
      )
    }

    logActivity(event, {
      action: 'delete',
      key: `users/${target.id}`,
      originalName: '已注销用户',
      source: 'admin',
      userId: operator.id
    })

    return { success: true, ...result }
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.message === 'USER_STORAGE_CLEAR_IN_PROGRESS') {
        createApiError(event, 'CONFLICT', '用户数据正在清理，请勿重复操作', 409)
      }
      if (error.message === 'USER_STORAGE_CLEAR_ACTIVE_JOB') {
        createApiError(event, 'CONFLICT', '该用户有正在运行的任务，请完成后再注销', 409)
      }
      if (error.message === 'ADMIN_USER_DELETE_FORBIDDEN') {
        createApiError(event, 'FORBIDDEN', '不允许注销管理员账号', 403)
      }
    }
    throw error
  }
})
