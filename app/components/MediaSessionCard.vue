<script setup lang="ts">
import type { FileItem } from '~/types/file'
import type { CopyFormat, UploadMediaKind } from '~/composables/useUploadPreferences'

const props = defineProps<{
  item: FileItem
  kind: UploadMediaKind
  /** 已按访问模式拼接好的直链 */
  link: string
  /** 封面缩略图地址 */
  thumbLink?: string
}>()

const emit = defineEmits<{
  delete: []
}>()

const { formatFileSize } = useFileSize()
const { t, locale } = useI18n()
const transcodeFailureLabel = useTranscodeFailureLabel()
const { copyFormat } = useUploadPreferences(props.kind)

const copyFormatItems = computed(() => [
  { label: t('copy.url'), value: 'url' as const },
  { label: t('copy.markdown'), value: 'markdown' as const },
  { label: t('copy.html'), value: 'html' as const },
  { label: t('copy.bbcode'), value: 'bbcode' as const }
])

const uploadedLabel = computed(() => {
  try {
    return new Date(props.item.uploadedAt).toLocaleString(locale.value, { hour12: false })
  } catch {
    return props.item.uploadedAt
  }
})

const previewValue = computed(() => {
  switch (copyFormat.value) {
    case 'markdown':
      return `[${props.item.originalName}](${props.link})`
    case 'html':
      return `<a href="${props.link}">${props.item.originalName}</a>`
    case 'bbcode':
      return `[url=${props.link}]${props.item.originalName}[/url]`
    default:
      return props.link
  }
})

const copySuccessTitle = computed(() => {
  switch (copyFormat.value) {
    case 'markdown':
      return t('copy.copiedMarkdown')
    case 'html':
      return t('copy.copiedHtml')
    case 'bbcode':
      return t('copy.copiedBbcode')
    default:
      return t('copy.copiedUrl')
  }
})

function selectCopyFormat(value: CopyFormat) {
  copyFormat.value = value
}

const pending = computed(() => props.item.transcodeStatus === 'pending')
const running = computed(() => props.item.transcodeStatus === 'running')
/** 转码中源文件只是临时文件，链接还不能对外使用 */
const transcoding = computed(() => pending.value || running.value)

/** 转码完成后按 HLS 播放列表展示 */
const displayName = computed(() => {
  if (!props.item.hlsUrl) return props.item.originalName
  const dot = props.item.originalName.lastIndexOf('.')
  const base = dot > 0 ? props.item.originalName.slice(0, dot) : props.item.originalName
  return `${base}.m3u8`
})

/** 该视频使用的转码档位（等待/转码中时展示） */
const presetLabel = computed(() => {
  const [name, value] = (props.item.transcodePreset ?? '').split(':')
  switch (name) {
    case 'copy':
      return t('preferences.presetCopy')
    case 'veryfast':
      return t('preferences.presetSpeed')
    case 'medium':
      return t('preferences.presetBalanced')
    case 'slow':
      return t('preferences.presetQuality')
    case 'compress':
      return value
        ? `${t('preferences.presetCompress')} ${value}%`
        : t('preferences.presetCompress')
    default:
      return null
  }
})
</script>

<template>
  <div class="flex flex-col overflow-hidden rounded-xl border border-default bg-elevated shadow-sm">
    <div class="relative aspect-video shrink-0 overflow-hidden bg-muted">
      <VideoThumbnail
        v-if="kind === 'video'"
        :src="thumbLink"
        :alt="item.originalName"
      />
      <div
        v-else
        class="flex size-full items-center justify-center"
      >
        <UIcon
          name="i-lucide-file"
          class="size-10 text-dimmed"
        />
      </div>

      <div class="absolute top-2 right-2">
        <UButton
          icon="i-lucide-trash-2"
          variant="solid"
          color="neutral"
          size="xs"
          class="bg-black/55 text-white hover:bg-black/70"
          :aria-label="t('common.delete')"
          @click="emit('delete')"
        />
      </div>
    </div>

    <div class="flex flex-1 flex-col gap-2 p-3">
      <p
        class="truncate text-sm font-medium"
        :title="displayName"
      >
        {{ displayName }}
      </p>

      <p class="flex items-center gap-2 text-xs text-muted">
        <span class="truncate">{{ uploadedLabel }} · {{ formatFileSize(item.size) }}</span>
        <UBadge
          v-if="pending"
          color="neutral"
          variant="subtle"
          size="xs"
          class="shrink-0"
        >
          {{ t('library.transcodePending') }}
        </UBadge>
        <UBadge
          v-else-if="running"
          color="primary"
          variant="subtle"
          size="xs"
          class="shrink-0"
        >
          {{ t('library.transcoding') }} {{ item.transcodeProgress ?? 0 }}%
        </UBadge>
        <UBadge
          v-else-if="item.transcodeStatus === 'failed'"
          color="error"
          variant="subtle"
          size="xs"
          class="max-w-48 shrink-0 truncate"
          :title="transcodeFailureLabel(item.transcodeError)"
        >
          {{ transcodeFailureLabel(item.transcodeError) }}
        </UBadge>
        <UBadge
          v-else-if="item.hlsUrl"
          color="success"
          variant="subtle"
          size="xs"
          class="shrink-0"
        >
          m3u8
        </UBadge>
      </p>

      <UProgress
        v-if="running"
        :model-value="item.transcodeProgress ?? 0"
        size="xs"
        color="primary"
      />

      <div
        v-if="!transcoding"
        class="flex gap-1 rounded-lg border border-default p-0.5"
      >
        <UButton
          v-for="option in copyFormatItems"
          :key="option.value"
          size="xs"
          class="flex-1 justify-center"
          :variant="copyFormat === option.value ? 'solid' : 'ghost'"
          :color="copyFormat === option.value ? 'primary' : 'neutral'"
          :label="option.label"
          @click="selectCopyFormat(option.value)"
        />
      </div>

      <div
        v-if="!transcoding"
        class="flex items-center gap-1"
      >
        <UInput
          :model-value="previewValue"
          readonly
          size="xs"
          class="min-w-0 flex-1 font-mono text-xs"
        />
        <CopyButton
          :label="t('common.copy')"
          variant="solid"
          color="primary"
          :value="previewValue"
          :success-title="copySuccessTitle"
        />
      </div>

      <p
        v-else
        class="flex flex-wrap items-center gap-1.5"
      >
        <UBadge
          v-if="presetLabel"
          color="primary"
          variant="subtle"
          size="xs"
        >
          {{ presetLabel }}
        </UBadge>
      </p>
    </div>
  </div>
</template>
