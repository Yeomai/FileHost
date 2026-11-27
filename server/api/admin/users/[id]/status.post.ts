import { requireAdminAuth } from '../../../../utils/access'
import { createApiError } from '../../../../utils/api-error'
import { logActivity } from '../../../../utils/activity-log'
import { findUserById, setUserDisabled } from '../../../../utils/db'

export default defineEventHandler(async (event) => {
  await requireAdminAuth(event)

  const id = Number(getRouterParam(event, 'id'))
  const target = Number.isInteger(id) ? findUserById(id) : null
  if (!target) {
    createApiError(event, 'INVALID_REQUEST', '用户不存在', 404)
  }
  if (target.role === 'admin') {
    createApiError(event, 'FORBIDDEN', '不允许禁用管理员账号', 403)
  }

  const body = await readBody<{ disabled?: unknown }>(event).catch(() => null)
  if (typeof body?.disabled !== 'boolean') {
    createApiError(event, 'INVALID_REQUEST', '无效的账号状态', 400)
  }

  setUserDisabled(target.id, body.disabled)
  logActivity(event, {
    action: 'settings',
    key: `users/${target.id}/status`,
    originalName: target.username,
    source: 'admin'
  })

  return { success: true, disabled: body.disabled }
})
