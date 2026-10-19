<script setup lang="ts">
import { formatFileSize } from '~/composables/useFileSize'

interface AdminUser {
  id: number
  username: string
  role: 'admin' | 'user'
  created_at: string
  password_reset: number
  usage?: {
    imageBytes: number
    videoBytes: number
    fileBytes: number
  }
}

const {
  isChecking,
  isAuthenticated,
  isAdmin,
  checkSession,
  fetchStatus,
  handleAuthError,
  getFetchErrorMessage
} = useAuth()
const toast = useToast()
const { t } = useI18n()

const users = ref<AdminUser[]>([])
const loading = ref(false)
const deleteTarget = ref<AdminUser | null>(null)
const deleteConfirm = ref('')
const deleting = ref(false)

const canDelete = computed(() =>
  Boolean(
    deleteTarget.value
    && deleteTarget.value.role !== 'admin'
    && deleteConfirm.value.trim() === deleteTarget.value.username
    && !deleting.value
  )
)

async function loadUsers() {
  if (!isAdmin.value) return
  loading.value = true
  try {
    const data = await $fetch<{ users: AdminUser[] }>('/api/admin/users', {
      credentials: 'include'
    })
    users.value = data.users
  } catch (error: unknown) {
    handleAuthError(error)
    if (isAuthenticated.value) {
      toast.add({ title: t('users.loadFailed'), color: 'error' })
    }
  } finally {
    loading.value = false
  }
}

async function clearPassword(user: AdminUser) {
  try {
    await $fetch(`/api/admin/users/${user.id}/clear-password`, {
      method: 'POST',
      credentials: 'include'
    })
    toast.add({ title: t('users.passwordCleared', { name: user.username }), color: 'success' })
    await loadUsers()
  } catch (error: unknown) {
    handleAuthError(error)
    toast.add({
      title: getFetchErrorMessage(error, t('users.clearFailed')),
      color: 'error'
    })
  }
}

function openDeleteDialog(user: AdminUser) {
  if (user.role === 'admin') return
  deleteTarget.value = user
  deleteConfirm.value = ''
}

function closeDeleteDialog() {
  if (deleting.value) return
  deleteTarget.value = null
  deleteConfirm.value = ''
}

function onDeleteOpenChange(open: boolean) {
  if (!open) closeDeleteDialog()
}

async function deleteUser() {
  const target = deleteTarget.value
  if (!target || !canDelete.value) return

  deleting.value = true
  try {
    await $fetch(`/api/admin/users/${target.id}/delete`, {
      method: 'POST',
      credentials: 'include',
      body: { confirmation: deleteConfirm.value.trim() }
    })
    toast.add({
      title: t('users.userDeleted', { name: target.username }),
      color: 'success'
    })
    deleteTarget.value = null
    deleteConfirm.value = ''
    await loadUsers()
  } catch (error: unknown) {
    handleAuthError(error)
    toast.add({
      title: getFetchErrorMessage(error, t('users.deleteFailed')),
      color: 'error'
    })
  } finally {
    deleting.value = false
  }
}

function formatDate(value: string) {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

onMounted(async () => {
  const status = await fetchStatus()
  if (!status.initialized && !status.legacyMode) {
    await navigateTo('/setup')
    return
  }
  await checkSession()
  if (isAuthenticated.value && isAdmin.value) {
    await loadUsers()
  }
})
</script>

<template>
  <div class="min-h-screen">
    <div
      v-if="isChecking"
      class="flex min-h-screen items-center justify-center"
    >
      <div class="flex flex-col items-center gap-3 text-muted">
        <UIcon
          name="i-lucide-loader-circle"
          class="size-8 animate-spin"
        />
        <p class="text-sm">
          {{ t('common.loadingSession') }}
        </p>
      </div>
    </div>

    <AdminLoginGate v-else-if="!isAuthenticated" />

    <AppShell v-else>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h1 class="text-2xl font-semibold tracking-tight">
            {{ t('users.title') }}
          </h1>
          <p class="text-sm text-muted">
            {{ t('users.subtitle') }}
          </p>
        </div>
        <UButton
          icon="i-lucide-refresh-cw"
          variant="ghost"
          color="neutral"
          size="sm"
          :aria-label="t('common.refresh')"
          :loading="loading"
          @click="loadUsers"
        />
      </div>

      <UAlert
        v-if="!isAdmin"
        color="warning"
        variant="subtle"
        :title="t('users.adminOnly')"
      />

      <ul
        v-else
        class="rounded-xl border border-default"
      >
        <li
          v-for="user in users"
          :key="user.id"
          class="flex flex-wrap items-center gap-3 border-b border-default px-4 py-3 last:border-0"
        >
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 text-sm font-medium text-highlighted">
              <span class="truncate">{{ user.username }}</span>
              <UBadge
                :color="user.role === 'admin' ? 'primary' : 'neutral'"
                variant="subtle"
                size="xs"
              >
                {{ user.role === 'admin' ? t('users.roleAdmin') : t('users.roleUser') }}
              </UBadge>
            </p>
            <p class="mt-0.5 text-xs text-muted">
              {{ formatDate(user.created_at) }}
            </p>
          </div>

          <div
            v-if="user.role !== 'admin'"
            class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"
          >
            <span>{{ t('users.usageImages') }} {{ formatFileSize(user.usage?.imageBytes ?? 0) }}</span>
            <span>{{ t('users.usageVideos') }} {{ formatFileSize(user.usage?.videoBytes ?? 0) }}</span>
            <span>{{ t('users.usageFiles') }} {{ formatFileSize(user.usage?.fileBytes ?? 0) }}</span>
          </div>
          <div
            v-if="user.role !== 'admin'"
            class="flex items-center gap-2"
          >
            <UBadge
              v-if="user.password_reset === 1"
              color="warning"
              variant="subtle"
              size="sm"
            >
              {{ t('users.resetPending') }}
            </UBadge>
            <UButton
              v-if="user.password_reset !== 1"
              variant="outline"
              color="warning"
              size="sm"
              :label="t('users.clearPassword')"
              @click="clearPassword(user)"
            />
            <UButton
              variant="outline"
              color="error"
              size="sm"
              :label="t('users.deleteUser')"
              @click="openDeleteDialog(user)"
            />
          </div>
        </li>
      </ul>
    </AppShell>

    <UModal
      :open="Boolean(deleteTarget)"
      :title="t('users.deleteTitle')"
      :description="t('users.deleteWarning')"
      @update:open="onDeleteOpenChange"
    >
      <template #body>
        <div class="space-y-2">
          <p class="text-sm text-muted">
            {{ t('users.deleteConfirmLabel', { name: deleteTarget?.username ?? '' }) }}
          </p>
          <UInput
            v-model="deleteConfirm"
            :placeholder="deleteTarget?.username"
            class="w-full"
            autocomplete="off"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="outline"
            :disabled="deleting"
            @click="closeDeleteDialog"
          />
          <UButton
            :label="t('users.deleteSubmit')"
            color="error"
            :loading="deleting"
            :disabled="!canDelete"
            @click="deleteUser"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
