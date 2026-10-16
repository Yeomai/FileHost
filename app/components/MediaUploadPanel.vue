<script setup lang="ts">
import type { FileItem } from '~/types/file'

const props = defineProps<{
  /** 视频床或文件床的上传页 */
  kind: 'video' | 'file'
}>()

const { t } = useI18n()
const toast = useToast()
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
  void loadActiveTranscodes()
})

const text = computed(() => props.kind === 'video'
  ? {
      uploadTitle: t('library.video.uploadTitle'),
      uploadHint: t('library.video.uploadHint'),
      uploadFormats: t('library.video.uploadFormats')
    }
  : {
      uploadTitle: t('library.file.uploadTitle'),
      uploadHint: t('library.file.uploadHint'),
      uploadFormats: t('library.file.uploadFormats')
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
