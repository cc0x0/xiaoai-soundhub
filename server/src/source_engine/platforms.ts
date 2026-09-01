/**
 * Multi-platform music adapter registry (LX Music compatible)
 *
 * Every supported platform is described by a PlatformAdapter that knows how to
 * search its own catalogue and how to resolve a playable stream URL for one of
 * its own tracks. Platform identifiers follow the LX Music convention so that
 * custom LX source scripts (sources/*.js) stay drop-in compatible:
 *
 *   wy = 网易云音乐 | tx = QQ音乐 | kw = 酷我音乐 | kg = 酷狗音乐 | mg = 咪咕音乐
 *
 * The special identifier `all` means "aggregated search" (LX 聚合搜索): fan out
 * to every enabled platform concurrently and interleave the results.
 */

import axios from 'axios';
import { MusicItem } from '../types/index.js';

export const AGGREGATE_SOURCE = 'all';

export type PlatformId = 'wy' | 'tx' | 'kw' | 'kg' | 'mg';

export const PLATFORM_IDS: PlatformId[] = ['wy', 'tx', 'kw', 'kg', 'mg'];

export const PLATFORM_NAMES: Record<string, string> = {
  wy: '网易云音乐',
  tx: 'QQ音乐',
  kw: '酷我音乐',
  kg: '酷狗音乐',
  mg: '咪咕音乐',
  [AGGREGATE_SOURCE]: '聚合搜索',
};

/** GDStudio aggregated API platform names, keyed by LX platform id. */
export const GD_SOURCE_MAP: Record<PlatformId, string> = {
  wy: 'netease',
  tx: 'tencent',
  kw: 'kuwo',
  kg: 'kugou',
  mg: 'migu',
};

/** Quality levels each platform is able to serve, ordered low -> high. */
export const PLATFORM_QUALITIES: Record<PlatformId, string[]> = {
  wy: ['128k', '192k', '320k', 'flac'],
  tx: ['128k', '192k', '320k', 'flac'],
  kw: ['128k', '192k', '320k', 'flac'],
  kg: ['128k', '192k', '320k', 'flac'],
  mg: ['128k', '192k', '320k', 'flac'],
};

/** Map a requested quality onto the closest one the platform can serve. */
export function mapQuality(requested: string, available: string[]): string {
  if (available.includes(requested)) return requested;
  const order = ['flac', '320k', '192k', '128k'];
  const wantedIdx = order.indexOf(requested);
  // Degrade downwards from the requested level first, then upgrade.
  for (let i = wantedIdx < 0 ? 1 : wantedIdx; i < order.length; i++) {
    if (available.includes(order[i])) return order[i];
  }
  for (const q of order) {
    if (available.includes(q)) return q;
  }
  return '320k';
}

/** GDStudio bitrate parameter for a given quality. */
export function qualityToBitrate(quality: string): string {
  switch (quality) {
    case 'flac':
      return '999';
    case '128k':
      return '128';
    case '192k':
      return '192';
    default:
      return '320';
  }
}

export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as string[]).includes(value);
}

export interface PlatformAdapter {
  id: PlatformId;
  name: string;
  /** Search this platform only. Returns [] when nothing matched. */
  search(keyword: string, page: number, limit: number): Promise<MusicItem[]>;
  /** Resolve a playable stream URL using the platform's own endpoints. */
  resolveUrl(item: Partial<MusicItem>, quality: string): Promise<string>;
}

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HTTP_TIMEOUT = 8000;

function formatSeconds(sec: number): string {
  const total = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function stripTags(text: unknown): string {
  return String(text ?? '')
    .replace(/<\/?em>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function toMusicItem(partial: Omit<MusicItem, 'interval'> & { duration: number }): MusicItem {
  return {
    ...partial,
    interval: formatSeconds(partial.duration),
  };
}

// ============================ 网易云音乐 (wy) ============================
const neteaseAdapter: PlatformAdapter = {
  id: 'wy',
  name: PLATFORM_NAMES.wy,

  async search(keyword, page, limit) {
    const url =
      `https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(keyword)}` +
      `&type=1&offset=${(page - 1) * limit}&total=true&limit=${limit}`;
    const resp = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://music.163.com/' },
    });

    const songs = resp.data?.result?.songs || [];
    return songs.map((item: any) => {
      const duration = Math.floor((Number(item.duration) || 210000) / 1000);
      return toMusicItem({
        id: String(item.id),
        name: stripTags(item.name) || keyword,
        singer: (item.artists || []).map((a: any) => a.name).join(' / ') || '未知歌手',
        albumName: stripTags(item.album?.name),
        duration,
        img: item.album?.picUrl || '',
        source: 'wy',
        raw: { id: String(item.id), songmid: String(item.id), name: item.name, singer: item.artists?.[0]?.name },
      });
    });
  },

  async resolveUrl(item) {
    const songId = String(item.id || item.raw?.id || '');
    if (!/^\d+$/.test(songId)) return '';
    const resp = await axios.head(`https://music.163.com/song/media/outer/url?id=${songId}.mp3`, {
      timeout: 6000,
      maxRedirects: 0,
      headers: { 'User-Agent': UA_DESKTOP },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const location = String(resp.headers?.location || '');
    // 网易云 returns a redirect to a 404 placeholder for VIP-only tracks.
    if (location.startsWith('http') && !location.includes('404')) return location;
    return '';
  },
};

// ============================ QQ音乐 (tx) ============================
const tencentAdapter: PlatformAdapter = {
  id: 'tx',
  name: PLATFORM_NAMES.tx,

  async search(keyword, page, limit) {
    const url =
      `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(keyword)}` +
      `&p=${page}&n=${limit}&format=json&platform=yqq.json`;
    const resp = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://y.qq.com/' },
    });

    const songs = resp.data?.data?.song?.list || [];
    return songs.map((item: any) => {
      const duration = Number(item.interval) || 210;
      const songmid = String(item.songmid || item.songid || '');
      return toMusicItem({
        id: songmid,
        name: stripTags(item.songname) || keyword,
        singer: (item.singer || []).map((s: any) => s.name).join(' / ') || '未知歌手',
        albumName: stripTags(item.albumname),
        duration,
        img: item.albummid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg`
          : '',
        source: 'tx',
        raw: {
          songmid,
          id: songmid,
          hash: songmid,
          name: item.songname,
          singer: (item.singer || []).map((s: any) => s.name).join(' / '),
          albumMid: item.albummid,
        },
      });
    });
  },

  // QQ音乐 direct links require a signed vkey tied to a logged-in cookie, so the
  // aggregated resolver (GDStudio, same platform) is used instead.
  async resolveUrl() {
    return '';
  },
};

// ============================ 酷我音乐 (kw) ============================
const kuwoAdapter: PlatformAdapter = {
  id: 'kw',
  name: PLATFORM_NAMES.kw,

  async search(keyword, page, limit) {
    const url =
      `https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}` +
      `&pn=${Math.max(0, page - 1)}&rn=${limit}&vipver=1&ft=music&encoding=utf8&rformat=json&mobi=1`;
    const resp = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': UA_DESKTOP },
    });

    const abslist = resp.data?.abslist || [];
    return abslist.map((item: any) => {
      const duration = Number(item.DURATION) || 210;
      const rid = String(item.DC_TARGETID || String(item.MUSICRID || '').replace('MUSIC_', ''));
      return toMusicItem({
        id: rid,
        name: stripTags(item.SONGNAME) || keyword,
        singer: stripTags(item.ARTIST) || '未知歌手',
        albumName: stripTags(item.ALBUM),
        duration,
        img: item.web_albumpic_short
          ? `https://img4.kuwo.cn/star/albumcover/${item.web_albumpic_short}`
          : '',
        source: 'kw',
        raw: { songmid: rid, id: rid, hash: rid, name: item.SONGNAME, singer: item.ARTIST },
      });
    });
  },

  async resolveUrl(item, quality) {
    const rid = String(item.id || item.raw?.id || '');
    if (!/^\d+$/.test(rid)) return '';

    // The anti-leech endpoint answers `refuse request!` for lossless formats,
    // so try flac first only when asked and always fall back to mp3.
    const formats = quality === 'flac' ? ['flac', 'mp3'] : ['mp3'];
    for (const format of formats) {
      try {
        const resp = await axios.get(
          `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${rid}&format=${format}&response=url`,
          { timeout: 6000, headers: { 'User-Agent': UA_DESKTOP } }
        );
        const url = String(resp.data || '').trim();
        if (url.startsWith('http')) return url;
      } catch {
        // try the next format
      }
    }
    return '';
  },
};

// ============================ 酷狗音乐 (kg) ============================
const kugouAdapter: PlatformAdapter = {
  id: 'kg',
  name: PLATFORM_NAMES.kg,

  async search(keyword, page, limit) {
    const url =
      `https://mobiles.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(keyword)}` +
      `&page=${page}&pagesize=${limit}&showtype=1`;
    const resp = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://m.kugou.com/' },
    });

    const info = resp.data?.data?.info || [];
    return info.map((item: any) => {
      const duration = Number(item.duration) || 210;
      const hash = String(item.hash || item.filehash || '');
      return toMusicItem({
        id: hash,
        name: stripTags(item.songname || item.filename) || keyword,
        singer: stripTags(item.singername) || '未知歌手',
        albumName: stripTags(item.album_name),
        duration,
        img: '',
        source: 'kg',
        raw: {
          hash,
          id: hash,
          songmid: hash,
          album_id: item.album_id,
          name: item.songname,
          singer: item.singername,
        },
      });
    });
  },

  async resolveUrl(item) {
    const hash = String(item.id || item.raw?.hash || '');
    if (!/^[a-fA-F0-9]{32}$/.test(hash)) return '';
    const resp = await axios.get(
      `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${hash}&mid=1&platid=4`,
      {
        timeout: HTTP_TIMEOUT,
        headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://www.kugou.com/', Cookie: 'kg_mid=1' },
      }
    );
    const playUrl = resp.data?.data?.play_url || resp.data?.data?.play_backup_url;
    return typeof playUrl === 'string' && playUrl.startsWith('http') ? playUrl : '';
  },
};

// ============================ 咪咕音乐 (mg) ============================
const miguAdapter: PlatformAdapter = {
  id: 'mg',
  name: PLATFORM_NAMES.mg,

  async search(keyword, page, limit) {
    // The legacy m.music.migu.cn/scr_search_tag endpoint now serves an HTML
    // shell; the mobile app search API is the working one.
    const url =
      `https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do` +
      `?ua=Android_migu&version=5.0.1&text=${encodeURIComponent(keyword)}` +
      `&pageNo=${page}&pageSize=${limit}&searchSwitch=${encodeURIComponent('{"song":1}')}`;
    const resp = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': UA_DESKTOP },
    });

    const results = resp.data?.songResultData?.result || [];
    return results.slice(0, limit).map((item: any) => {
      const singers = Array.isArray(item.singers)
        ? item.singers.map((s: any) => s.name).join(' / ')
        : '';
      // Migu reports file size per bitrate tier but never a duration, so the
      // duration is derived from size / bitrate. Each tier has its own bitrate
      // (LQ=64k, PQ=128k, HQ=320k) — using the wrong one skews auto-advance.
      const duration = estimateMiguDuration(item.rateFormats || item.newRateFormats || []);

      return toMusicItem({
        id: String(item.copyrightId || item.id || ''),
        name: stripTags(item.name) || keyword,
        singer: singers || '未知歌手',
        albumName: stripTags(item.album || item.albumName),
        duration,
        img: item.imgItems?.[0]?.img || '',
        source: 'mg',
        raw: {
          copyrightId: String(item.copyrightId || ''),
          contentId: String(item.contentId || ''),
          songId: String(item.id || ''),
          id: String(item.copyrightId || item.id || ''),
          songmid: String(item.copyrightId || item.id || ''),
          name: item.name,
          singer: singers,
        },
      });
    });
  },

  // 咪咕 stream links are signed per app session, so resolution goes through
  // the aggregated resolver / cross-source matching instead.
  async resolveUrl() {
    return '';
  },
};

/** Bytes-per-second for each Migu quality tier. */
const MIGU_TIER_BYTES_PER_SEC: Record<string, number> = {
  LQ: (64 * 1024) / 8,
  PQ: (128 * 1024) / 8,
  HQ: (320 * 1024) / 8,
  SQ: (320 * 1024) / 8,
};

function estimateMiguDuration(rateFormats: any[]): number {
  for (const tier of ['HQ', 'PQ', 'LQ', 'SQ']) {
    const entry = rateFormats.find((f: any) => f?.formatType === tier && Number(f?.size) > 0);
    if (!entry) continue;
    const seconds = Math.round(Number(entry.size) / MIGU_TIER_BYTES_PER_SEC[tier]);
    if (seconds > 0) return Math.min(Math.max(seconds, 30), 1800);
  }
  return 210;
}

export const PLATFORM_ADAPTERS: Record<PlatformId, PlatformAdapter> = {
  wy: neteaseAdapter,
  tx: tencentAdapter,
  kw: kuwoAdapter,
  kg: kugouAdapter,
  mg: miguAdapter,
};

export function getAdapter(source: string): PlatformAdapter | undefined {
  return isPlatformId(source) ? PLATFORM_ADAPTERS[source] : undefined;
}

// ============================ 聚合解析器 (GDStudio) ============================

const GD_API = 'https://music-api.gdstudio.xyz/api.php';

/**
 * Resolve a stream URL through the GDStudio aggregated API, staying on the
 * track's own platform. Tries the native id first; if that platform indexes
 * songs differently, falls back to a name+singer match within the SAME
 * platform so the recording never silently switches label.
 */
export async function resolveViaAggregator(
  item: Partial<MusicItem>,
  quality: string,
  platform: PlatformId
): Promise<string> {
  const gdSource = GD_SOURCE_MAP[platform];
  const bitrate = qualityToBitrate(quality);
  const songId = String(item.id || item.raw?.id || item.raw?.hash || '');

  if (songId) {
    try {
      const resp = await axios.get(
        `${GD_API}?types=url&source=${gdSource}&id=${encodeURIComponent(songId)}&br=${bitrate}`,
        { timeout: HTTP_TIMEOUT, headers: { 'User-Agent': UA_DESKTOP } }
      );
      const url = resp.data?.url;
      if (typeof url === 'string' && url.startsWith('http')) return url;
    } catch {
      // fall through to the name-based match below
    }
  }

  const keyword = `${item.singer || ''} ${item.name || ''}`.trim();
  if (!keyword) return '';

  try {
    const searchResp = await axios.get(
      `${GD_API}?types=search&source=${gdSource}&count=5&pages=1&name=${encodeURIComponent(keyword)}`,
      { timeout: HTTP_TIMEOUT, headers: { 'User-Agent': UA_DESKTOP } }
    );
    const candidates = Array.isArray(searchResp.data) ? searchResp.data : [];
    const best = pickBestMatch(candidates, item.name || '', item.singer || '');
    if (!best?.id) return '';

    const urlResp = await axios.get(
      `${GD_API}?types=url&source=${gdSource}&id=${encodeURIComponent(String(best.id))}&br=${bitrate}`,
      { timeout: HTTP_TIMEOUT, headers: { 'User-Agent': UA_DESKTOP } }
    );
    const url = urlResp.data?.url;
    if (typeof url === 'string' && url.startsWith('http')) return url;
  } catch {
    // resolution failed on this platform
  }

  return '';
}

function normalizeForMatch(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[^一-龥a-z0-9]/g, '');
}

function similarity(a: string, b: string): number {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const shorter = x.length < y.length ? x : y;
  const longer = x.length < y.length ? y : x;
  let hits = 0;
  for (const ch of new Set(shorter)) {
    if (longer.includes(ch)) hits++;
  }
  return (hits / new Set(shorter).size) * 0.6;
}

/** Score candidates on name (weight .65) + singer (weight .35); require >= .45. */
function pickBestMatch(candidates: any[], name: string, singer: string): any | null {
  let best: any = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const candidateSinger = Array.isArray(candidate.artist)
      ? candidate.artist.join(' / ')
      : String(candidate.artist || candidate.singer || '');
    const score =
      similarity(name, String(candidate.name || candidate.title || '')) * 0.65 +
      similarity(singer, candidateSinger) * 0.35;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 0.45 ? best : null;
}

/**
 * Locate the SAME recording on a different platform.
 *
 * Deliberately strict: the title must match exactly after normalization and the
 * artist must overlap, plus the duration must be within 8s when both sides
 * report one. This is what keeps a cross-source fallback from quietly serving a
 * cover, a live cut or a 90-second short-video edit in place of the original.
 */
export async function findSameTrackOnPlatform(
  item: Partial<MusicItem>,
  platform: PlatformId
): Promise<MusicItem | null> {
  const name = String(item.name || '');
  const singer = String(item.singer || '');
  if (!name) return null;

  const adapter = PLATFORM_ADAPTERS[platform];
  const keyword = `${singer} ${name}`.trim();

  let candidates: MusicItem[] = [];
  try {
    candidates = await adapter.search(keyword, 1, 10);
  } catch {
    return null;
  }

  const wantedName = normalizeForMatch(name);
  const wantedSingers = splitSingers(singer);
  const wantedDuration = Number(item.duration) || 0;

  for (const candidate of candidates) {
    if (normalizeForMatch(candidate.name) !== wantedName) continue;

    const candidateSingers = splitSingers(candidate.singer);
    const singerMatches =
      wantedSingers.length === 0 ||
      wantedSingers.some((w) => candidateSingers.some((c) => c === w || c.includes(w) || w.includes(c)));
    if (!singerMatches) continue;

    const candidateDuration = Number(candidate.duration) || 0;
    if (wantedDuration > 0 && candidateDuration > 0 && Math.abs(wantedDuration - candidateDuration) > 8) {
      continue;
    }

    return candidate;
  }

  return null;
}

function splitSingers(singer: string): string[] {
  return String(singer || '')
    .split(/[/、,&，]+/)
    .map((s) => normalizeForMatch(s))
    .filter(Boolean);
}

/**
 * Merge the per-platform result lists of an aggregated search.
 *
 * Plain round-robin interleaving (what LX does) lets whichever platform happens
 * to be first inject its noise at the top — and some catalogues are heavily
 * polluted with covers and short-video edits. So results are ranked by how well
 * they match the query, with the platform's own ranking as the tie-breaker, and
 * duplicates of the same recording across platforms are collapsed.
 */
export function mergeAggregatedResults(
  lists: MusicItem[][],
  limit: number,
  keyword = ''
): MusicItem[] {
  interface Scored {
    item: MusicItem;
    key: string;
    score: number;
    rank: number;
  }

  const trackKey = (item: MusicItem) =>
    `${normalizeForMatch(item.name)}|${normalizeForMatch(item.singer)}`;

  // Cross-platform consensus: when several catalogues independently list the
  // same title+artist it is almost certainly the official release, whereas a
  // cover or a short-video rip usually exists on a single platform only. This
  // is the strongest signal available without a licensing database.
  const platformsPerTrack = new Map<string, Set<string>>();
  for (const list of lists) {
    for (const item of list) {
      const key = trackKey(item);
      if (!platformsPerTrack.has(key)) platformsPerTrack.set(key, new Set());
      platformsPerTrack.get(key)!.add(item.source);
    }
  }

  const scored: Scored[] = [];
  for (const list of lists) {
    list.forEach((item, rank) => {
      const key = trackKey(item);
      const consensus = platformsPerTrack.get(key)?.size || 1;
      scored.push({
        item,
        key,
        rank,
        score: relevanceScore(item, keyword) + Math.min(consensus - 1, 4) * 0.3,
      });
    });
  }

  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);

  const merged: MusicItem[] = [];
  const seen = new Set<string>();
  for (const entry of scored) {
    if (merged.length >= limit) break;
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    merged.push(entry.item);
  }

  return merged;
}

/**
 * Score how well a track answers the query. Penalises the tell-tale markers of
 * a non-original upload (伴奏 / 翻唱 / DJ remix / short-video snippets) and the
 * padded artist names ("陈小春-", "粤语陈小春") that cover uploads use to rank
 * against the real artist.
 */
function relevanceScore(item: MusicItem, keyword: string): number {
  const query = normalizeForMatch(keyword);
  const name = normalizeForMatch(item.name);
  const singer = normalizeForMatch(item.singer);

  let score = 0;

  if (query) {
    // Reward the query's own terms appearing in the title / artist.
    if (query.includes(name) || name.includes(query)) score += 0.35;
    for (const term of String(keyword).split(/\s+/).filter(Boolean)) {
      const t = normalizeForMatch(term);
      if (!t) continue;
      if (name.includes(t)) score += 0.25;
      if (singer.includes(t)) score += 0.2;
    }
  }

  const rawName = String(item.name || '');
  if (/伴奏|翻唱|remix|dj|铃声|片段|纯音乐|instrumental|cover/i.test(rawName)) score -= 0.5;
  if (/live|现场|演唱会|版\)|版）/i.test(rawName)) score -= 0.15;

  // Cover uploads pad the artist field to piggyback on the real name.
  if (/[-、.．\s]$/.test(String(item.singer || '').trim())) score -= 0.3;
  if (String(item.singer || '').split(/[/、,&，]/).length > 2) score -= 0.15;

  // Full-length tracks are far more likely to be the actual release.
  const duration = Number(item.duration) || 0;
  if (duration > 0 && duration < 100) score -= 0.45;
  else if (duration >= 150) score += 0.15;

  return score;
}
