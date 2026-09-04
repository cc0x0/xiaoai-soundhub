/**
 * Maps lx-music's MusicInfo onto the shape the SoundHub server expects.
 *
 * The two sides identify a track differently, and getting this wrong shows up
 * as "cast succeeded but nothing plays":
 *
 *   lx  `MusicInfo.id`  is a composite key — `${source}_${songmid}`, except kg
 *                       which uses `${songmid}_${hash}`. It is NOT a platform id.
 *   lx  `meta.songId`   holds the real platform id for wy / tx / kw.
 *   lx  `meta.hash`     holds it for kg (32 hex chars).
 *   lx  `meta.copyrightId` holds it for mg.
 *
 * The server's platform adapters validate these: kg requires 32 hex characters,
 * wy and kw require digits. So each source has to be unpacked individually
 * rather than passing the composite id through.
 */

import type { CastMusicParams } from './xiaoaiService'

/** Parse lx's "03:55" (or "1:02:03") interval into seconds. */
export const parseIntervalToSeconds = (interval: string | null | undefined): number => {
  if (!interval) return 0
  const parts = String(interval).split(':').map(p => parseInt(p, 10))
  if (parts.some(isNaN)) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

/**
 * Extract the native platform id the server needs for this track's source.
 * Returns an empty string when it cannot be determined, so callers can refuse
 * to cast rather than sending a request that is guaranteed to fail.
 */
const resolvePlatformId = (musicInfo: any): string => {
  const meta = musicInfo?.meta ?? {}
  switch (musicInfo?.source) {
    case 'kg':
      // The server matches /^[a-fA-F0-9]{32}$/ against this.
      return String(meta.hash ?? '')
    case 'mg':
      return String(meta.copyrightId ?? meta.songId ?? '')
    case 'wy':
    case 'tx':
    case 'kw':
      return String(meta.songId ?? '')
    default:
      return String(meta.songId ?? '')
  }
}

/**
 * Unwrap whatever the player hands us into a plain MusicInfo.
 *
 * `playMusicInfo.musicInfo` is not always a MusicInfo: while a download is the
 * active item it is a `LX.Download.ListItem`, which carries the real track under
 * `metadata.musicInfo`.
 */
export const normalizeMusicInfo = (input: any): any => {
  if (!input) return null
  if (input.metadata?.musicInfo) return input.metadata.musicInfo
  return input
}

/** Sources the SoundHub server can actually resolve. `local` is excluded. */
const CASTABLE_SOURCES = ['wy', 'tx', 'kw', 'kg', 'mg'] as const

export const isCastableSource = (source: string | undefined): boolean =>
  CASTABLE_SOURCES.includes(source as typeof CASTABLE_SOURCES[number])

export interface MapResult {
  ok: boolean
  /** Present when ok; ready to POST to /api/play. */
  music?: CastMusicParams
  /** Present when !ok; a user-facing Chinese reason. */
  error?: string
}

/**
 * Convert one lx MusicInfo into the server's CastMusicParams.
 *
 * `raw` carries the platform id under every key the server's adapters and any
 * LX source script might look for, because each platform reads a different one.
 */
export const toCastParams = (rawInput: any): MapResult => {
  const musicInfo = normalizeMusicInfo(rawInput)
  if (!musicInfo) return { ok: false, error: '没有可投播的歌曲' }

  const source = String(musicInfo.source ?? '')
  if (source === 'local') {
    return { ok: false, error: '本地歌曲无法投播到小爱音箱' }
  }
  if (!isCastableSource(source)) {
    return { ok: false, error: `音源 ${source || '未知'} 暂不支持投播` }
  }

  const platformId = resolvePlatformId(musicInfo)
  if (!platformId) {
    return { ok: false, error: '无法识别该歌曲的音源 ID，投播已取消' }
  }

  const meta = musicInfo.meta ?? {}
  const interval = musicInfo.interval == null ? null : String(musicInfo.interval)
  const duration = parseIntervalToSeconds(interval)
  const directUrl = (musicInfo as any).streamUrl || (musicInfo as any).url || (musicInfo as any).playUrl

  return {
    ok: true,
    music: {
      id: platformId,
      name: String(musicInfo.name ?? ''),
      singer: String(musicInfo.singer ?? ''),
      albumName: meta.albumName ? String(meta.albumName) : undefined,
      interval: interval ?? undefined,
      duration: duration > 0 ? duration : undefined,
      img: meta.picUrl ? String(meta.picUrl) : undefined,
      source,
      streamUrl: typeof directUrl === 'string' && directUrl.startsWith('http') ? directUrl : undefined,
      raw: {
        id: platformId,
        songmid: platformId,
        hash: source === 'kg' ? platformId : undefined,
        copyrightId: source === 'mg' ? platformId : undefined,
        strMediaMid: meta.strMediaMid,
        name: musicInfo.name,
        singer: musicInfo.singer,
        albumName: meta.albumName,
      },
    },
  }
}
