import { Linking, Platform } from 'react-native'
import { getMusicUrl } from './index'
import {
  getPicUrl,
  getLyricInfo,
} from './online'
import { getPlayQuality } from './utils'
import settingState from '@/store/setting/state'
import {
  downloadFile,
  ensureMusicDownloadDirectory,
  existsMusicDownloadTarget,
  removeMusicDownloadTarget,
  scanMusicDownloadFile,
  stopDownload,
  temporaryDirectoryPath,
} from '@/utils/fs'
import { filterFileName } from '@/utils/common'
import { sizeFormate } from '@/utils'
import { confirmDialog, requestStoragePermission, toast } from '@/utils/tools'
import { writeLyric, writePic } from '@/utils/localMediaMetadata'
import { buildLyrics } from '@/utils/lrcTools'

const AUDIO_EXT_RXP = /\.([a-zA-Z0-9]{2,5})(?:\?|#|$)/
const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36'

type DownloadTaskStatus = 'waiting' | 'run' | 'error' | 'completed'

export interface DownloadTaskItem {
  id: string
  musicInfo: LX.Music.MusicInfoOnline
  filePath: string
  fileName: string
  quality: LX.Quality
  ext: string
  status: DownloadTaskStatus
  statusText: string
  progress: number
  downloaded: number
  total: number
  speed: string
  errorMessage: string
}

interface DownloadTaskState extends DownloadTaskItem {
  jobId: number | null
}

const downloadingTasks = new Map<string, Promise<string>>()
const downloadTaskStates = new Map<string, DownloadTaskState>()

const getDownloadTaskKey = (musicInfo: LX.Music.MusicInfoOnline) => `${musicInfo.source}:${musicInfo.id}`
const notifyDownloadListUpdate = () => {
  global.app_event.downloadListUpdate()
}

const createTaskState = (musicInfo: LX.Music.MusicInfoOnline): DownloadTaskState => ({
  id: getDownloadTaskKey(musicInfo),
  musicInfo,
  filePath: '',
  fileName: '',
  quality: '128k',
  ext: 'mp3',
  status: 'waiting',
  statusText: global.i18n.t('download_start', { name: musicInfo.name }),
  progress: 0,
  downloaded: 0,
  total: 0,
  speed: '',
  errorMessage: '',
  jobId: null,
})

const updateTaskState = (taskId: string, state: Partial<DownloadTaskState>) => {
  const prev = downloadTaskStates.get(taskId)
  if (!prev) return
  downloadTaskStates.set(taskId, { ...prev, ...state })
  notifyDownloadListUpdate()
}

export const getDownloadTasks = (): DownloadTaskItem[] => {
  return Array.from(downloadTaskStates.values()).map(({ jobId, ...item }) => ({ ...item }))
}

export const isMusicDownloading = (musicInfo: LX.Music.MusicInfoOnline) => {
  return downloadingTasks.has(getDownloadTaskKey(musicInfo))
}

export const removeDownloadTask = async(taskId: string, removeFile = false) => {
  const task = downloadTaskStates.get(taskId)
  if (!task) return
  downloadTaskStates.delete(taskId)
  if (task.jobId && task.status !== 'completed') {
    stopDownload(task.jobId)
  }
  if (removeFile && task.filePath) {
    await removeMusicDownloadTarget(task.filePath).catch(() => {})
  }
  notifyDownloadListUpdate()
}

const buildMusicDownloadHeaders = (url: string, musicInfo: LX.Music.MusicInfoOnline): Record<string, string> => {
  const headers: Record<string, string> = {
    'User-Agent': DOWNLOAD_USER_AGENT,
  }
  const refererBySource: Partial<Record<LX.OnlineSource, string>> = {
    wy: 'https://music.163.com/',
    kg: 'https://www.kugou.com/',
    kw: 'https://www.kuwo.cn/',
    tx: 'https://y.qq.com/portal/player.html',
    mg: 'https://music.migu.cn/v3',
  }
  const fromSource = refererBySource[musicInfo.source]
  if (fromSource) {
    headers.Referer = fromSource
    return headers
  }
  try {
    const u = new URL(url)
    headers.Referer = `${u.protocol}//${u.host}/`
  } catch {}
  return headers
}

const createBaseFileName = (musicInfo: LX.Music.MusicInfoOnline) => {
  const template = settingState.setting['download.fileName']
  const name = template
    .replace('歌名', musicInfo.name)
    .replace('歌手', musicInfo.singer || '未知歌手')
    .trim()
  return filterFileName(name) || `${Date.now()}`
}

const parseExtByUrl = (url: string) => {
  const ext = url.match(AUDIO_EXT_RXP)?.[1]?.toLowerCase()
  return ext && ext.length <= 5 ? ext : 'mp3'
}

const parsePicExtByUrl = (url: string) => {
  const ext = url.match(AUDIO_EXT_RXP)?.[1]?.toLowerCase()
  return ext && ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg'
}

const writeDownloadPic = async(filePath: string, musicInfo: LX.Music.MusicInfoOnline) => {
  if (!settingState.setting['download.isEmbedPic']) return

  const picUrl = await getPicUrl({
    musicInfo,
    isRefresh: false,
    allowToggleSource: true,
  })
  if (!picUrl) return

  const picExt = parsePicExtByUrl(picUrl)
  const picPath = `${temporaryDirectoryPath}/download-pic-${Date.now()}.${picExt}`.replace(/\/+/g, '/')
  try {
    const result = await downloadFile(picUrl, picPath).promise
    if (result.statusCode >= 200 && result.statusCode < 300) {
      await writePic(filePath, picPath)
    }
  } finally {
    await removeMusicDownloadTarget(picPath).catch(() => {})
  }
}

const writeDownloadLyric = async(filePath: string, musicInfo: LX.Music.MusicInfoOnline) => {
  if (!settingState.setting['download.isEmbedLyric']) return

  const lyricInfo = await getLyricInfo({
    musicInfo,
    isRefresh: false,
    allowToggleSource: true,
  })
  const rawlrcInfo = lyricInfo.rawlrcInfo ?? lyricInfo
  if (!rawlrcInfo.lyric) return

  const lyric = buildLyrics(
    rawlrcInfo,
    settingState.setting['download.isEmbedLyricAwlrc'],
    settingState.setting['download.isEmbedLyricTranslation'],
    settingState.setting['download.isEmbedLyricRoma'],
  )
  if (lyric) await writeLyric(filePath, lyric)
}

const writeDownloadMetadata = async(filePath: string, musicInfo: LX.Music.MusicInfoOnline) => {
  if (!settingState.setting['download.isEmbedPic'] && !settingState.setting['download.isEmbedLyric']) return

  updateTaskState(getDownloadTaskKey(musicInfo), {
    statusText: global.i18n.t('download_write_metadata'),
  })

  await writeDownloadPic(filePath, musicInfo).catch(err => {
    console.warn('write download pic failed', err)
  })
  await writeDownloadLyric(filePath, musicInfo).catch(err => {
    console.warn('write download lyric failed', err)
  })
}

const ensureAndroidStorageForPublicDownload = async() => {
  if (Platform.OS !== 'android') return

  const result = await requestStoragePermission()
  if (result === true) return

  if (result === false) {
    toast(global.i18n.t('download_permission_denied'), 'long')
    throw new Error(global.i18n.t('download_permission_denied'))
  }

  const openSettings = await confirmDialog({
    title: global.i18n.t('download_permission_blocked_title'),
    message: global.i18n.t('download_permission_blocked_message'),
    confirmButtonText: global.i18n.t('download_go_settings'),
    cancelButtonText: global.i18n.t('dialog_cancel'),
  })
  if (openSettings) {
    await Linking.openSettings()
  }
  throw new Error(global.i18n.t('download_permission_blocked_message'))
}

const runDownloadMusicToLocal = async(musicInfo: LX.Music.MusicInfoOnline) => {
  await ensureAndroidStorageForPublicDownload()

  const taskId = getDownloadTaskKey(musicInfo)
  const downloadDir = await ensureMusicDownloadDirectory()
  const quality = getPlayQuality(settingState.setting['download.quality'], musicInfo)
  const url = await getMusicUrl({ musicInfo, isRefresh: false, quality })
  const ext = parseExtByUrl(url)
  const baseName = createBaseFileName(musicInfo)
  let index = 0
  let savePath = ''
  while (true) {
    const suffix = index === 0 ? '' : ` (${index})`
    savePath = `${downloadDir}/${baseName}${suffix}.${ext}`.replace(/\/+/g, '/')
    if (!(await existsMusicDownloadTarget(savePath))) break
    index++
  }

  updateTaskState(taskId, {
    filePath: savePath,
    fileName: savePath.split(/\/|\\/).at(-1) ?? '',
    quality,
    ext,
    status: 'waiting',
    statusText: global.i18n.t('download_start', { name: musicInfo.name }),
  })

  let lastProgressTime = Date.now()
  let lastWritten = 0

  const result = await downloadFile(url, savePath, {
    background: true,
    headers: buildMusicDownloadHeaders(url, musicInfo),
    progressInterval: 500,
    begin: ({ jobId, contentLength }) => {
      updateTaskState(taskId, {
        jobId,
        status: 'run',
        total: contentLength,
        statusText: global.i18n.t('download_start', { name: musicInfo.name }),
      })
    },
    progress: ({ bytesWritten, contentLength }) => {
      const now = Date.now()
      const timeDiff = Math.max(now - lastProgressTime, 1)
      const byteDiff = Math.max(bytesWritten - lastWritten, 0)
      lastProgressTime = now
      lastWritten = bytesWritten
      const speed = byteDiff > 0 ? `${sizeFormate(byteDiff * 1000 / timeDiff)}/s` : ''
      updateTaskState(taskId, {
        status: 'run',
        downloaded: bytesWritten,
        total: contentLength,
        progress: contentLength > 0 ? bytesWritten / contentLength : 0,
        speed,
        statusText: speed ? `下载中 ${speed}` : '下载中',
      })
    },
  }).promise
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`download failed: ${result.statusCode}`)
  }

  await writeDownloadMetadata(savePath, musicInfo)

  if (Platform.OS === 'android') {
    await scanMusicDownloadFile(savePath)
  }

  updateTaskState(taskId, {
    status: 'completed',
    statusText: global.i18n.t('download_success', { path: savePath }),
    progress: 1,
    downloaded: result.bytesWritten ?? downloadTaskStates.get(taskId)?.downloaded ?? 0,
    total: result.bytesWritten ?? downloadTaskStates.get(taskId)?.total ?? 0,
    speed: '',
    errorMessage: '',
    jobId: null,
  })

  return savePath
}

export const downloadMusicToLocal = async(musicInfo: LX.Music.MusicInfoOnline) => {
  const taskKey = getDownloadTaskKey(musicInfo)
  const downloadingTask = downloadingTasks.get(taskKey)
  if (downloadingTask) return downloadingTask

  downloadTaskStates.set(taskKey, createTaskState(musicInfo))
  notifyDownloadListUpdate()
  toast(global.i18n.t('download_start', { name: musicInfo.name }))

  const task = runDownloadMusicToLocal(musicInfo)
    .catch((err: any) => {
      updateTaskState(taskKey, {
        status: 'error',
        statusText: err?.message || global.i18n.t('download_failed'),
        errorMessage: err?.message || global.i18n.t('download_failed'),
        speed: '',
        jobId: null,
      })
      throw err
    })
    .finally(() => {
      downloadingTasks.delete(taskKey)
    })
  downloadingTasks.set(taskKey, task)
  return task
}
