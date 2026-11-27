import { requireAdminAuth } from '../../../utils/access'
import { listAdminUsersWithUsage } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  await requireAdminAuth(event)
  return { users: listAdminUsersWithUsage() }
})
