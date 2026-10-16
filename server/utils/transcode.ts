import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { getDataDir } from './data-dir'
import {
  listAllImageIndexRows,
  listPendingTranscodeKeys,
  listTranscodedSourceRows,
  updateImageTranscode
} from './image-index'
import {
  VIDEO_FOLDER,
  extensionFromFilename,
  isVideoSidecarKey,
  validateStorageKey,
  validateVideoKey
} from './image-key'
import {
  createImageStream,
  deleteImage,
  headImage
} from './storage'
import { getBackendForKey } from './storage/resolver'
import { logException, logInfo } from './logger'
import {
  getSetting,
  SETTINGS_TRANSCODE_CONCURRENCY,
  SETTINGS_TRANSCODE_BITRATE,
  SETTINGS_TRANSCODE_PRESET,
  SETTINGS_TRANSCODE_THREADS,
  setSetting
} from './db'

/** HLS 分片时长（秒） */
const HLS_SEGMENT_TIME = 6

export const DEFAULT_TRANSCODE_CONCURRENCY = 1
export const DEFAULT_TRANSCODE_THREADS = 1
export const MAX_TRANSCODE_CONCURRENCY = 8
export const MAX_TRANSCODE_THREADS = 64

/**
 * 转码档位：直接封装（不重编码）/ 速度 / 平衡 / 质量。
 * 注意 CRF 模式下 preset 越慢画质越好、体积也越大。
 */
export const TRANSCODE_PRESETS = ['copy', 'veryfast', 'medium', 'slow', 'compress'] as const
export type TranscodePreset = (typeof TRANSCODE_PRESETS)[number]
export const DEFAULT_TRANSCODE_PRESET: TranscodePreset = 'veryfast'

/** 「压缩」档的目标码率占源码率的百分比 */
export const DEFAULT_TRANSCODE_BITRATE_PERCENT = 80
export const MIN_TRANSCODE_BITRATE_PERCENT = 10
export const MAX_TRANSCODE_BITRATE_PERCENT = 100

export function getTranscodeBitratePercent(): number {
  return parseBoundedInt(
    getSetting(SETTINGS_TRANSCODE_BITRATE),
    DEFAULT_TRANSCODE_BITRATE_PERCENT,
    MIN_TRANSCODE_BITRATE_PERCENT,
    MAX_TRANSCODE_BITRATE_PERCENT
  )
}

export function parseTranscodePreset(raw: string | null | undefined): TranscodePreset | null {
  const value = raw?.trim()
  if (!value) return null
  return (TRANSCODE_PRESETS as readonly string[]).includes(value)
    ? value as TranscodePreset
    : null
}

function parseBoundedInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return fallback
  return value
}

export interface TranscodeSettings {
  concurrency: number
  threads: number
  preset: TranscodePreset
  bitratePercent: number
}

/** 同时进行的转码任务数，默认 1（串行） */
export function getTranscodeConcurrency(): number {
  return parseBoundedInt(
    getSetting(SETTINGS_TRANSCODE_CONCURRENCY),
    DEFAULT_TRANSCODE_CONCURRENCY,
    1,
    MAX_TRANSCODE_CONCURRENCY
  )
}

/** 每个转码任务使用的 CPU 核心数，默认 1 */
export function getTranscodeThreads(): number {
  return parseBoundedInt(
    getSetting(SETTINGS_TRANSCODE_THREADS),
    DEFAULT_TRANSCODE_THREADS,
    1,
    MAX_TRANSCODE_THREADS
  )
}

export function getTranscodeSettings(): TranscodeSettings {
  return {
    concurrency: getTranscodeConcurrency(),
    threads: getTranscodeThreads(),
    preset: parseTranscodePreset(getSetting(SETTINGS_TRANSCODE_PRESET)) ?? DEFAULT_TRANSCODE_PRESET,
    bitratePercent: getTranscodeBitratePercent()
  }
}

export function setTranscodeSettings(patch: {
  concurrency?: number
  threads?: number
  preset?: TranscodePreset
  bitratePercent?: number
}): TranscodeSettings {
  if (patch.concurrency !== undefined) {
    setSetting(SETTINGS_TRANSCODE_CONCURRENCY, String(patch.concurrency))
  }
  if (patch.threads !== undefined) {
    setSetting(SETTINGS_TRANSCODE_THREADS, String(patch.threads))
  }
  if (patch.preset !== undefined) {
    setSetting(SETTINGS_TRANSCODE_PRESET, patch.preset)
  }
  if (patch.bitratePercent !== undefined) {
    setSetting(SETTINGS_TRANSCODE_BITRATE, String(patch.bitratePercent))
  }
  return getTranscodeSettings()
}

function stripExtension(key: string): string {
  const slash = key.lastIndexOf('/')
  const dot = key.lastIndexOf('.')
  return dot > slash ? key.slice(0, dot) : key
}

function extensionOf(key: string): string {
  const dot = key.lastIndexOf('.')
  return dot > 0 ? key.slice(dot + 1) : 'mp4'
}

/** 视频 key 对应的 HLS 播放列表 key（去扩展名后作为目录） */
export function hlsPlaylistKey(videoKey: string): string {
  return `${stripExtension(videoKey)}/index.m3u8`
}

/** 视频 key 对应的封面缩略图 key（同目录同名，扩展名换成 webp） */
export function thumbKeyFor(videoKey: string): string {
  return `${stripExtension(videoKey)}.webp`
}

function runThumbFfmpeg(inputPath: string, outputPath: string, seek: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', String(seek),
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', 'scale=640:-2',
      '-c:v', 'libwebp',
      '-quality', '80',
      outputPath
    ], { windowsHide: true })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const detail = stderr.trim().split('\n').filter(Boolean).pop()
      reject(new Error(detail || `ffmpeg 退出码 ${code}`))
    })
  })
}

/**
 * 抽取视频封面并写入存储，返回缩略图 key。
 * 优先取第 1 秒的画面，短视频或抽取失败时退回第一帧。
 */
export async function generateVideoThumbnail(videoKey: string): Promise<string | null> {
  const stored = await headImage(videoKey)
  if (!stored) return null

  const workDir = join(tmpdir(), `pichost-thumb-${randomUUID()}`)
  const inputPath = join(workDir, `input.${extensionOf(videoKey)}`)
  const outputPath = join(workDir, 'thumb.webp')

  await fs.mkdir(workDir, { recursive: true })

  try {
    await streamToFile(await createImageStream(videoKey), inputPath)

    try {
      await runThumbFfmpeg(inputPath, outputPath, 1)
    } catch {
      await runThumbFfmpeg(inputPath, outputPath, 0)
    }

    const bytes = await fs.readFile(outputPath)
    const thumbKey = thumbKeyFor(videoKey)
    const backend = await getBackendForKey(videoKey)

    await backend.put(thumbKey, new Uint8Array(bytes), {
      originalName: `${basename(thumbKey)}`,
      uploadedAt: new Date().toISOString(),
      contentType: 'image/webp',
      size: bytes.byteLength,
      userId: stored.userId ?? null,
      mediaType: 'video'
    })

    return thumbKey
  } catch (error) {
    logException('video thumbnail failed', error, { key: videoKey })
    return null
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 正在转码的视频 → ffmpeg 进程，用于删除时中断 */
const runningProcesses = new Map<string, ChildProcess>()

/** 读取视频总时长（秒）；失败返回 0，表示无法计算进度 */
function probeDuration(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath
    ], { windowsHide: true })

    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', () => resolve(0))
    child.on('close', () => {
      const value = Number.parseFloat(output.trim())
      resolve(Number.isFinite(value) && value > 0 ? value : 0)
    })
  })
}

/** 读取视频总码率（bps）；失败返回 0 */
function probeBitrate(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=bit_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath
    ], { windowsHide: true })

    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', () => resolve(0))
    child.on('close', () => {
      const value = Number.parseInt(output.trim(), 10)
      resolve(Number.isFinite(value) && value > 0 ? value : 0)
    })
  })
}

/**
 * 读取音轨码率（bps）；没有音轨或读不到时返回 0。
 * 音频目标码率会取「128k 与源音频码率」中的较小值，避免低码率音频被放大。
 */
function probeAudioBitrate(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=bit_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath
    ], { windowsHide: true })

    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', () => resolve(0))
    child.on('close', () => {
      const value = Number.parseInt(output.trim(), 10)
      resolve(Number.isFinite(value) && value > 0 ? value : 0)
    })
  })
}

/** 单码率 H.264 + AAC 切片，产出 index.m3u8 与 segNNN.ts */
function runFfmpeg(
  videoKey: string,
  inputPath: string,
  outputDir: string,
  sourceBitrate: number,
  sourceAudioBitrate: number,
  onProgressUs: (outTimeUs: number) => void
): Promise<void> {
  const { preset, bitratePercent } = getTranscodeSettings()

  // 音频不放大也不压缩：跟随源音轨码率（读不到时才用 128k）
  const audioBitrate = sourceAudioBitrate > 0
    ? sourceAudioBitrate
    : 128_000
  const audioKbps = `${Math.round(audioBitrate / 1000)}k`

  let codecArgs: string[]
  if (preset === 'copy') {
    // 不重新编码：只把音视频流重新封装成 HLS 切片
    codecArgs = ['-c', 'copy', '-bsf:v', 'h264_mp4toannexb']
  } else if (preset === 'compress') {
    // 目标「总码率」= 源码率 × 比例，再扣掉音频预算得到视频码率，避免总量反超
    const targetTotal = Math.round(sourceBitrate * bitratePercent / 100)
    const targetVideo = Math.max(80_000, targetTotal - audioBitrate)
    codecArgs = [
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-b:v', String(targetVideo),
      '-maxrate', String(Math.round(targetVideo * 1.2)),
      '-bufsize', String(targetVideo * 2),
      '-c:a', 'aac',
      '-b:a', audioKbps
    ]
  } else {
    // 恒定质量优先，但用「源码率 - 音频预算」卡住视频峰值，避免体积反超源文件
    const ceiling = sourceBitrate > audioBitrate ? sourceBitrate - audioBitrate : 0
    codecArgs = [
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', '23',
      ...(ceiling
        ? ['-maxrate', String(ceiling), '-bufsize', String(ceiling * 2)]
        : []),
      '-c:a', 'aac',
      '-b:a', audioKbps
    ]
  }

  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostats',
      '-progress', 'pipe:1',
      '-y',
      '-i', inputPath,
      '-threads', String(getTranscodeThreads()),
      ...codecArgs,
      '-f', 'hls',
      '-hls_time', String(HLS_SEGMENT_TIME),
      '-hls_playlist_type', 'vod',
      // 分片写相对名，避免播放列表里出现本机绝对路径
      '-hls_segment_filename', 'seg%03d.ts',
      'index.m3u8'
    ], { cwd: outputDir, windowsHide: true })

    runningProcesses.set(videoKey, child)
    const release = () => {
      runningProcesses.delete(videoKey)
    }

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout.on('data', (chunk) => {
      const match = /out_time_us=(\d+)/.exec(String(chunk))
      if (match?.[1]) onProgressUs(Number(match[1]))
    })
    child.on('error', (error) => {
      release()
      reject(error)
    })
    child.on('close', (code) => {
      release()
      if (code === 0) {
        resolve()
        return
      }
      const detail = stderr.trim().split('\n').filter(Boolean).pop()
      reject(new Error(detail || `ffmpeg 退出码 ${code}`))
    })
  })
}

async function streamToFile(stream: NodeJS.ReadableStream, filePath: string): Promise<void> {
  await pipeline(stream, createWriteStream(filePath))
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 把视频转成 HLS 并写入存储，返回播放列表 key 与产物总大小 */
export async function transcodeVideoToHls(
  videoKey: string
): Promise<{ playlistKey: string, totalBytes: number }> {
  const stored = await headImage(videoKey)
  if (!stored) throw new Error('视频不存在')

  const workDir = join(tmpdir(), `pichost-hls-${randomUUID()}`)
  const inputPath = join(workDir, `input.${extensionOf(videoKey)}`)
  const outputDir = join(workDir, 'out')
  const dirKey = stripExtension(videoKey)
  const playlistKey = hlsPlaylistKey(videoKey)

  await fs.mkdir(outputDir, { recursive: true })

  // 记录已写入存储的产物，中途失败时要逐个回收，避免留下残缺切片
  const writtenKeys: string[] = []
  const backend = await getBackendForKey(videoKey)

  try {
    await streamToFile(await createImageStream(videoKey), inputPath)
    const durationSec = await probeDuration(inputPath)
    const sourceBitrate = await probeBitrate(inputPath)
    const sourceAudioBitrate = await probeAudioBitrate(inputPath)
    let lastProgressAt = 0

    await runFfmpeg(videoKey, inputPath, outputDir, sourceBitrate, sourceAudioBitrate, (outTimeUs) => {
      if (!durationSec) return
      const now = Date.now()
      if (now - lastProgressAt < 1000) return
      lastProgressAt = now
      const percent = Math.round((outTimeUs / (durationSec * 1_000_000)) * 100)
      updateImageTranscode(videoKey, {
        status: 'running',
        progress: Math.min(99, Math.max(1, percent))
      })
    })

    const uploadedAt = new Date().toISOString()

    let totalBytes = 0
    for (const name of await fs.readdir(outputDir)) {
      const bytes = await fs.readFile(join(outputDir, name))
      const objectKey = `${dirKey}/${name}`
      await backend.put(objectKey, new Uint8Array(bytes), {
        originalName: name,
        uploadedAt,
        contentType: name.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/mp2t',
        size: bytes.byteLength,
        userId: stored.userId ?? null,
        mediaType: 'video'
      })
      writtenKeys.push(objectKey)
      totalBytes += bytes.byteLength
    }

    return { playlistKey, totalBytes }
  } catch (error) {
    for (const key of writtenKeys) {
      await backend.delete(key).catch(() => {})
    }
    if (backend.type === 'local') {
      await fs.rmdir(join(getDataDir(), ...dirKey.split('/'))).catch(() => {})
    }
    throw error
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 删除视频对应的 HLS 播放列表与分片 */
export async function removeHlsArtifacts(videoKey: string): Promise<void> {
  const playlistKey = hlsPlaylistKey(videoKey)

  // 封面缩略图与播放列表无关，必须先于提前返回处理
  await deleteImage(thumbKeyFor(videoKey)).catch(() => {})

  if (!await headImage(playlistKey)) return

  const dirKey = stripExtension(videoKey)
  const text = await streamToString(await createImageStream(playlistKey))

  for (const line of text.split('\n')) {
    const name = line.trim()
    if (!name || name.startsWith('#')) continue
    const segmentKey = `${dirKey}/${basename(name)}`
    if (!validateStorageKey(segmentKey)) continue
    await deleteImage(segmentKey).catch(() => {})
  }

  await deleteImage(playlistKey).catch(() => {})

  // 本地磁盘上把清空后的分片目录一并移除
  const backend = await getBackendForKey(videoKey)
  if (backend.type === 'local') {
    await fs.rmdir(join(getDataDir(), ...dirKey.split('/'))).catch(() => {})
  }
}

const queue: string[] = []
const queued = new Set<string>()
let activeCount = 0

async function processOne(videoKey: string): Promise<void> {
  updateImageTranscode(videoKey, { status: 'running' })

  try {
    const { playlistKey, totalBytes } = await transcodeVideoToHls(videoKey)

    // 转码成功后源文件不再需要，直接删除以节省空间
    const backend = await getBackendForKey(videoKey)
    await backend.delete(videoKey).catch(() => {})

    updateImageTranscode(videoKey, {
      status: 'done',
      hlsKey: playlistKey,
      progress: 100,
      sourceDeleted: true,
      size: totalBytes
    })
    logInfo('transcode done', { key: videoKey, hlsKey: playlistKey })
  } catch (error) {
    updateImageTranscode(videoKey, { status: 'failed' })
    logException('transcode failed', error, { key: videoKey })
  }
}

/** 按设置的并发数消费队列（默认 1，即串行） */
function drain(): void {
  while (queue.length && activeCount < getTranscodeConcurrency()) {
    const key = queue.shift()!
    activeCount += 1

    void processOne(key).finally(() => {
      activeCount -= 1
      queued.delete(key)
      drain()
    })
  }
}

export function enqueueTranscode(videoKey: string): void {
  if (!validateVideoKey(videoKey) || queued.has(videoKey)) return
  queued.add(videoKey)
  queue.push(videoKey)
  // 记录本视频使用的档位，便于上传页展示
  const preset = getTranscodeSettings().preset
  updateImageTranscode(videoKey, {
    status: 'pending',
    // 压缩档带上百分比，例如 compress:80
    preset: preset === 'compress'
      ? `compress:${getTranscodeBitratePercent()}`
      : preset
  })
  drain()
}

/** 取消排队中或正在转码的任务（删除视频时调用） */
export function cancelTranscode(videoKey: string): void {
  const index = queue.indexOf(videoKey)
  if (index >= 0) queue.splice(index, 1)
  queued.delete(videoKey)

  const child = runningProcesses.get(videoKey)
  if (child) {
    runningProcesses.delete(videoKey)
    child.kill()
  }
}

/**
 * 补删转码完成后仍保留的源文件。
 * 仅当 HLS 播放列表确实存在时才删除，避免产物缺失时把视频删没。
 */
export async function cleanupTranscodedSources(): Promise<number> {
  let removed = 0

  for (const row of listTranscodedSourceRows()) {
    try {
      if (!await headImage(row.hlsKey)) continue

      const backend = await getBackendForKey(row.key)
      await backend.delete(row.key).catch(() => {})
      updateImageTranscode(row.key, { status: 'done', sourceDeleted: true })
      removed += 1
    } catch (error) {
      logException('cleanup transcoded source failed', error, { key: row.key })
    }
  }

  return removed
}

/** 启动时把上次中断的任务重新排队 */
export function resumePendingTranscodes(): void {
  for (const key of listPendingTranscodeKeys()) {
    enqueueTranscode(key)
  }
}

/**
 * 清理遗留的转码进程。
 * 开发时热重载会重建模块，队列里的旧 ffmpeg 仍在跑，必须按命令行特征回收。
 */
export function killOrphanFfmpeg(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const psScript = 'Get-CimInstance Win32_Process -Filter "Name=\'ffmpeg.exe\'" '
        + '| Where-Object { $_.CommandLine -like \'*pichost-hls-*\' } '
        + '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'

      const child = process.platform === 'win32'
        ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
            windowsHide: true,
            stdio: 'ignore'
          })
        : spawn('pkill', ['-f', 'pichost-hls-'], { stdio: 'ignore' })

      child.on('error', () => resolve())
      child.on('close', () => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * 清理没有对应主视频记录的附属文件（缩略图、HLS 播放列表与分片）。
 * 正常删除流程已经清理，这里兜底历史残留。
 */
export async function purgeOrphanVideoAssets(): Promise<number> {
  const root = join(getDataDir(), VIDEO_FOLDER)
  const owners = new Set(
    listAllImageIndexRows()
      .filter(row => row.key.startsWith(`${VIDEO_FOLDER}/`))
      .map(row => stripExtension(row.key))
  )

  let removed = 0

  async function walk(dir: string, keyPrefix: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const name = String(entry.name)
      const key = `${keyPrefix}/${name}`

      if (entry.isDirectory()) {
        await walk(join(dir, name), key)
        // 附属文件清空后的空目录一并移除
        await fs.rmdir(join(dir, name)).catch(() => {})
        continue
      }

      if (!isVideoSidecarKey(key)) continue

      const extension = extensionFromFilename(name)
      // 缩略图与视频同名前缀；播放列表和分片归属所在目录
      const owner = ['webp', 'jpg', 'jpeg', 'png'].includes(extension)
        ? stripExtension(key)
        : keyPrefix

      if (owners.has(owner)) continue

      await fs.rm(join(dir, name), { force: true }).catch(() => {})
      removed += 1
    }
  }

  await walk(root, VIDEO_FOLDER)
  return removed
}

/** 进程退出时尽量带走正在运行的 ffmpeg，避免留下孤儿进程 */
function killRunningProcesses(): void {
  for (const child of runningProcesses.values()) {
    child.kill()
  }
  runningProcesses.clear()
}

process.on('exit', killRunningProcesses)
process.on('SIGINT', killRunningProcesses)
process.on('SIGTERM', killRunningProcesses)
