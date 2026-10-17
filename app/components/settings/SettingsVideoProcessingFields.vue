<script setup lang="ts">
const { transcodeToHls, loadPreferences } = useUploadPreferences('video')
const { t } = useI18n()

onMounted(() => {
  loadPreferences()
})
</script>

<template>
  <SettingsToggleRow
    v-model="transcodeToHls"
    :title="t('preferences.transcodeToHls')"
    :hint="t('preferences.transcodeToHlsHint')"
  />
  <div
    v-if="transcodeToHls"
    class="border-t border-default/50 py-4"
  >
    <TranscodeSettingsControls />
  </div>
</template>
