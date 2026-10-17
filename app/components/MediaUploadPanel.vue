<script setup lang="ts">
import type { FileItem } from '~/types/file'

const props = defineProps<{
  /** 视频床或文件床的上传页 */
  kind: 'video' | 'file'
}>()

const { t } = useI18n()
const toast = useToast()
const {
  policy: uploadPolicy,
  load: loadUploadPolicy
} = useUploadPolicy()
const {
  uploading,
  progressItems,
  sessionItems,
  linkUrl,
  thumbLink,
  loadActiveTranscodes,
  uploadFiles
} = useMediaUpload(props.kind)

onMounted(() => {
  void Promise.all([
    loadActiveTranscodes(),
    loadUploadPolicy().catch(() => {})
  ])
})

const text = computed(() => {
  const allowedVideos = uploadPolicy.value?.allowedVideoExtensions ?? []
  const forbiddenFiles = uploadPolicy.value?.forbiddenFileExtensions ?? []
  return props.kind === 'video'
    ? {
        uploadTitle: t('library.video.uploadTitle'),
        uploadHint: t('library.video.uploadHint'),
        uploadFormats: allowedVideos.length
          ? t('library.video.uploadFormatsAllowed', {
              formats: allowedVideos.map(item => item.toUpperCase()).join(' / ')
            })
          : t('library.video.uploadFormats')
      }
    : {
        uploadTitle: t('library.file.uploadTitle'),
        uploadHint: t('library.file.uploadHint'),
        uploadFormats: forbiddenFiles.length
          ? t('library.file.uploadFormatsBlocked', {
              formats: forbiddenFiles.map(item => item.toUpperCase()).join(' / ')
            })
          : t('library.file.uploadFormatsUnrestricted')
      }
})

const accept = computed(() => {
  if (props.kind !== 'video') return undefined
  const extensions = uploadPolicy.value?.allowedVideoExtensions ?? []
  if (!extensions.length) return undefined
  return extensions
    .map(extension => `.${extension}`)
    .join(',')
})

const showProgress = computed(() =>
  uploading.value
  || progressItems.value.some(
    item =>
      item.status === 'pending'
      || item.status === 'uploading'
      || item.status === 'error'
  )
)

async function removeItem(item: FileItem) {
  try {
    await $fetch('/api/files', {
      method: 'DELETE',
      credentials: 'include',
      query: { key: item.key }
    })
    sessionItems.value = sessionItems.value.filter(entry => entry.key !== item.key)
    toast.add({ title: t('files.deleted'), color: 'success' })
  } catch {
    toast.add({ title: t('files.deleteFailed'), color: 'error' })
  }
}
</script>

<template>
  <div class="space-y-6">
    <UploadFlipCard
      :kind="kind"
      :title="text.uploadTitle"
      :hint="text.uploadHint"
      :formats="text.uploadFormats"
      :accept="accept"
      :disabled="uploading"
      @upload="uploadFiles"
    />

    <UploadResult
      v-if="showProgress"
      :items="progressItems"
    />

    <section
      v-if="sessionItems.length"
      class="space-y-4"
    >
      <h2 class="text-lg font-medium">
        {{ t('upload.sessionTitle') }}
        <span class="ml-1 text-sm font-normal text-muted">({{ sessionItems.length }})</span>
      </h2>

      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <MediaSessionCard
          v-for="item in sessionItems"
          :key="item.key"
          :item="item"
          :kind="kind"
          :link="linkUrl(item)"
          :thumb-link="thumbLink(item)"
          @delete="removeItem(item)"
        />
      </div>
    </section>
  </div>
</template>
