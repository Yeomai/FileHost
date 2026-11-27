import { requireAdminAuth } from '../../../../utils/access'
import { createApiError } from '../../../../utils/api-error'
import { clearUserPassword, findUserById } from '../../../../utils/db'
import { logActivity } from '../../../../utils/activity-log'

export default defineEventHandler(async (event) => {
  const operator = await requireAdminAuth(event)

  const id = Number(getRouterParam(event, 'id'))
  const target = Number.isInteger(id) ? findUserById(id) : null
  if (!target) {
    createApiError(event, 'INVALID_REQUEST', '用户不存在', 404)
  }
  if (target.role === 'admin') {
    createApiError(event, 'FORBIDDEN', '不允许清除管理员账号', 403)
  }
  if (target.id === operator.id) {
    createApiError(event, 'INVALID_REQUEST', '不能清除自己的密码', 400)
  }

  clearUserPassword(target.id)

  logActivity(event, {
    action: 'settings',
    key: `users/${target.id}/clear-password`,
    originalName: target.username,
    userId: operator.id,
    source: 'admin'
  })

  return { success: true }
})
