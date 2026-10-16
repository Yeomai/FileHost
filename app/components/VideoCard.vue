<script setup lang="ts">
import type { FileItem } from '~/types/file'

const props = defineProps<{
  item: FileItem
  /** 已按访问模式拼接好的视频直链 */
  link: string
  /** 缩略图直链 */
  thumbLink: string
  /** 原始视频下载地址 */
  downloadLink: string
  selected?: boolean
  selectable?: boolean
}>()

const emit = defineEmits<{
  'play': []
  'delete': []
  'update:selected': [value: boolean]
}>()

const { formatFileSize } = useFileSize()
const { t, locale } = useI18n()

/** 转码完成后按 HLS 播放列表展示 */
const displayName = computed(() => {
  if (!props.item.hlsUrl) return props.item.originalName
  const dot = props.item.originalName.lastIndexOf('.')
  const base = dot > 0 ? props.item.originalName.slice(0, dot) : props.item.originalName
  return `${base}.m3u8`
})

const uploadedLabel = computed(() => {
  try {
    return new Date(props.item.uploadedAt).toLocaleString(locale.value, { hour12: false })
  } catch {
    return props.item.uploadedAt
  }
})

const thumbFailed = ref(false)

watch(() => props.item.thumbUrl, () => {
  thumbFailed.value = false
})
</script>

<template>
  <div class="flex flex-col overflow-hidden rounded-xl border border-default bg-elevated">
    <div class="relative aspect-video shrink-0 overflow-hidden bg-muted">
      <img
        v-if="item.thumbUrl && !thumbFailed"
        :src="thumbLink"
        :alt="displayName"
        loading="lazy"
        class="size-full object-cover object-center"
        @error="thumbFailed = true"
      >
      <div
        v-else
        class="flex size-full items-center justify-center"
      >
        <UIcon
          name="i-lucide-film"
          class="size-10 text-dimmed"
        />
      </div>

      <button
        type="button"
        class="absolute inset-0 flex items-center justify-center transition-colors hover:bg-black/20"
        :aria-label="t('library.play')"
        @click="emit('play')"
      >
        <span class="rounded-full bg-black/55 p-3 text-white backdrop-blur-sm">
          <UIcon
            name="i-lucide-play"
            class="size-6"
          />
        </span>
      </button>

      <div
        v-if="selectable"
        class="absolute top-2 left-2 z-10"
        @click.stop
      >
        <UCheckbox
          :model-value="selected"
          @update:model-value="emit('update:selected', $event === true)"
        />
      </div>

      <div
        class="absolute top-2 right-2 z-10"
        @click.stop
      >
        <UBadge
          v-if="item.hlsUrl"
          color="success"
          variant="solid"
          size="xs"
        >
          m3u8
        </UBadge>
        <UBadge
          v-else-if="item.transcodeStatus === 'failed'"
          color="error"
          variant="solid"
          size="xs"
        >
          {{ t('library.transcodeFailed') }}
        </UBadge>
      </div>
    </div>

    <div class="flex flex-1 flex-col gap-1.5 p-3">
      <p
        class="truncate text-sm font-semibold"
        :title="displayName"
      >
        {{ displayName }}
      </p>
      <p class="truncate text-xs text-muted">
        {{ uploadedLabel }} · {{ formatFileSize(item.size) }}
      </p>
      <div
        v-if="item.tags?.length"
        class="flex flex-wrap gap-1"
      >
        <TagBadge
          v-for="tag in item.tags"
          :key="tag.id"
          :tag="tag"
        />
      </div>
    </div>

    <div class="flex items-center justify-around border-t border-default px-2 py-2">
      <CopyButton
        icon="i-lucide-link"
        icon-only
        :label="t('library.copyVideoLink')"
        :value="link"
        :success-title="t('copy.copiedUrl')"
      />
      <CopyButton
        icon="i-lucide-image"
        icon-only
        :label="t('library.copyThumbLink')"
        :value="thumbLink"
        :success-title="t('copy.copiedUrl')"
      />
      <UButton
        v-if="!item.sourceDeleted"
        icon="i-lucide-download"
        variant="ghost"
        color="neutral"
        size="sm"
        :to="downloadLink"
        target="_blank"
        rel="noopener"
        :aria-label="t('files.download')"
      />
      <UButton
        icon="i-lucide-trash-2"
        variant="ghost"
        color="neutral"
        size="sm"
        :aria-label="t('common.delete')"
        @click="emit('delete')"
      />
    </div>
  </div>
</template>
