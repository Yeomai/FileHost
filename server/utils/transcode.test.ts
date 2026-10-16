import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRANSCODE_CONCURRENCY,
  DEFAULT_TRANSCODE_PRESET,
  DEFAULT_TRANSCODE_THREADS,
  getTranscodeConcurrency,
  getTranscodeSettings,
  hlsPlaylistKey,
  parseTranscodePreset,
  setTranscodeSettings,
  thumbKeyFor
} from './transcode'
import { isVideoSidecarKey, mediaTypeForKey } from './image-key'

describe('hlsPlaylistKey', () => {
  it('uses the video key without extension as the hls directory', () => {
    expect(hlsPlaylistKey('videos/2026/10/abc123.mp4'))
      .toBe('videos/2026/10/abc123/index.m3u8')
    expect(hlsPlaylistKey('videos/abc123.mkv'))
      .toBe('videos/abc123/index.m3u8')
  })
})

describe('isVideoSidecarKey', () => {
  it('detects playlists, segments and thumbnails', () => {
    expect(isVideoSidecarKey('videos/2026/10/abc/index.m3u8')).toBe(true)
    expect(isVideoSidecarKey('videos/2026/10/abc/seg000.ts')).toBe(true)
    expect(isVideoSidecarKey('videos/2026/10/abc.webp')).toBe(true)
  })

  it('leaves the original video and other media out', () => {
    expect(isVideoSidecarKey('videos/2026/10/abc.mp4')).toBe(false)
    expect(isVideoSidecarKey('files/2026/10/abc.pdf')).toBe(false)
    expect(isVideoSidecarKey('images/2026/10/abc.webp')).toBe(false)
  })

  it('builds thumbnail keys next to the video', () => {
    expect(thumbKeyFor('videos/2026/10/abc.mp4')).toBe('videos/2026/10/abc.webp')
  })
})

describe('mediaTypeForKey', () => {
  it('maps folders to media types', () => {
    expect(mediaTypeForKey('images/2026/10/a.webp')).toBe('image')
    expect(mediaTypeForKey('videos/2026/10/a.mp4')).toBe('video')
    expect(mediaTypeForKey('files/2026/10/a.pdf')).toBe('file')
  })
})

describe('transcode settings', () => {
  it('defaults to one concurrent job with one thread', () => {
    expect(DEFAULT_TRANSCODE_CONCURRENCY).toBe(1)
    expect(DEFAULT_TRANSCODE_THREADS).toBe(1)
    expect(getTranscodeSettings()).toEqual({
      concurrency: 1,
      threads: 1,
      preset: 'veryfast',
      bitratePercent: 80
    })
  })

  it('round-trips stored values', () => {
    setTranscodeSettings({ concurrency: 3, threads: 2 })
    expect(getTranscodeSettings()).toEqual({
      concurrency: 3,
      threads: 2,
      preset: 'veryfast',
      bitratePercent: 80
    })
  })

  it('falls back to the default when the stored value is out of range', () => {
    setTranscodeSettings({ concurrency: 99 })
    expect(getTranscodeConcurrency()).toBe(DEFAULT_TRANSCODE_CONCURRENCY)

    setTranscodeSettings({ concurrency: 1, threads: 1 })
  })

  it('stores the quality preset and rejects unknown ones', () => {
    setTranscodeSettings({ preset: 'slow' })
    expect(getTranscodeSettings().preset).toBe('slow')

    expect(parseTranscodePreset('nope')).toBeNull()
    setTranscodeSettings({ preset: DEFAULT_TRANSCODE_PRESET })
  })
})
