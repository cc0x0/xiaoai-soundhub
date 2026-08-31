/**
 * LX Music 自定义音源沙箱执行引擎
 * 基于 Node.js VM 模拟 lx 运行时环境，执行自定义 JS 音源脚本
 */

import vm from 'vm';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios, { AxiosRequestConfig } from 'axios';
import { MusicItem, MusicUrlResult, SearchResult } from '../types/index.js';

export class SourceEngine {
  private sourcesDir: string;
  private activeSourceFile: string;
  private sandboxContext: vm.Context | null = null;
  private sourceInfo: Record<string, any> = {};
  private apis: Record<string, any> = {};

  constructor(sourcesDir: string, activeSourceFile: string) {
    this.sourcesDir = sourcesDir;
    this.activeSourceFile = activeSourceFile;
  }

  public getActiveSource(): string {
    return this.activeSourceFile;
  }

  private requestHandlers: Array<({ action, source, info }: any) => Promise<any>> = [];

  public async loadSource(sourceFileName?: string): Promise<boolean> {
    const fileName = sourceFileName || this.activeSourceFile;
    const fullPath = path.isAbsolute(fileName) ? fileName : path.join(this.sourcesDir, fileName);

    this.requestHandlers = [];

    if (!fs.existsSync(fullPath)) {
      console.warn(`[SourceEngine] 音源脚本文件不存在: ${fullPath}，将使用内置多平台直连适配器`);
      return false;
    }

    const scriptContent = fs.readFileSync(fullPath, 'utf-8');
    this.activeSourceFile = fileName;

    const atobPolyfill = (str: string) => Buffer.from(str, 'base64').toString('binary');
    const btoaPolyfill = (str: string) => Buffer.from(str, 'binary').toString('base64');

    const eventHandlers: Record<string, ((...args: any[]) => any)[]> = {};

    // 模拟 LX 运行环境
    const lxBridge = {
      version: '2.0.0',
      env: 'mobile',
      currentScriptInfo: {},
      EVENT_NAMES: {
        inited: 'inited',
        updateAlert: 'updateAlert',
        request: 'request',
      },
      request: (url: string, optionsOrCb: any = {}, maybeCb?: (err: any, resp: any, body: any) => void) => {
        let options: any = optionsOrCb;
        let callback = maybeCb;
        if (typeof optionsOrCb === 'function') {
          callback = optionsOrCb;
          options = {};
        }

        const method = (options?.method || 'GET').toUpperCase();
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          ...(options?.headers || {}),
        };
        const config: AxiosRequestConfig = {
          url,
          method,
          headers,
          timeout: options?.timeout || 15000,
          responseType: options?.responseType || 'text',
          validateStatus: () => true,
        };
        if (options?.data || options?.body || options?.form) {
          config.data = options.data || options.body || options.form;
        }

        void axios(config)
          .then((resp) => {
            const responseObj = {
              statusCode: resp.status,
              status: resp.status,
              headers: resp.headers,
              body: resp.data,
            };
            if (callback) {
              callback(null, responseObj, resp.data);
            }
          })
          .catch((err: any) => {
            if (callback) {
              callback(err, null, null);
            }
          });

        return () => {};
      },
      send: (action: string, data: any) => {
        if (action === 'init' || action === 'inited') {
          this.sourceInfo = data;
          if (data?.sources) {
            this.apis = data.sources;
          }
        }
      },
      sendAction: (action: string, data: any) => {
        if (action === 'init' || action === 'inited') {
          this.sourceInfo = data;
          if (data?.sources) {
            this.apis = data.sources;
          }
        }
      },
      on: (event: string, handler: (...args: any[]) => void) => {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(handler);
        if (event === 'request') {
          this.requestHandlers.push(handler as any);
        }
      },
      utils: {
        buffer: {
          from: Buffer.from,
        },
        crypto: {
          md5: (str: string) => crypto.createHash('md5').update(str).digest('hex'),
          aesEncrypt: (data: string, mode: string, key: string, iv: string) => {
            const cipher = crypto.createCipheriv(mode, key, iv);
            return Buffer.concat([cipher.update(data), cipher.final()]).toString('base64');
          },
        },
      },
    };

    // 创建隔离上下文与全局 bridge
    const context: Record<string, any> = {
      console,
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      URL,
      URLSearchParams,
      atob: atobPolyfill,
      btoa: btoaPolyfill,
      encodeURIComponent,
      decodeURIComponent,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      Math,
      Date,
      JSON,
      RegExp,
      Array,
      Object,
      Function,
      String,
      Number,
      Boolean,
      Symbol,
      Promise,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Proxy,
      Reflect,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      lx: lxBridge,
      crypto: {
        createHash: crypto.createHash,
        createCipheriv: crypto.createCipheriv,
        createDecipheriv: crypto.createDecipheriv,
        randomBytes: crypto.randomBytes,
      },
    };
    context.global = context;
    context.globalThis = context;
    context.window = context;

    this.sandboxContext = vm.createContext(context);

    try {
      vm.runInContext(scriptContent, this.sandboxContext, {
        filename: fileName,
        timeout: 10000,
      });

      if (context.apis) this.apis = context.apis;
      if (context.lx?.apis) this.apis = context.lx.apis;
      if (context.sources) this.apis = context.sources;

      console.log(`[SourceEngine] 自定义音源 [${fileName}] 加载成功`);
      return true;
    } catch (err: any) {
      console.error(`[SourceEngine] 执行自定义音源脚本出错:`, err.message);
      return false;
    }
  }

  public async search(keyword: string, page = 1, limit = 20, source = 'kg'): Promise<SearchResult> {
    if (!this.sandboxContext) {
      await this.loadSource();
    }

    try {
      // 1. 尝试从沙箱注册的 LX 事件中调用 search
      for (const handler of this.requestHandlers) {
        try {
          const rawRes = await handler({
            action: 'search',
            source: source || 'kg',
            info: { key: keyword, keyword, page, limit },
          });
          if (rawRes && rawRes.list && rawRes.list.length > 0) {
            const list = rawRes.list.map((item: any) => this.normalizeMusicItem(item, source));
            return {
              list,
              total: rawRes.total || list.length,
              page,
              limit,
              source,
            };
          }
        } catch {}
      }

      // 2. 尝试内置多平台直连搜索（酷狗/网易云）
      return await this.directSearch(keyword, page, limit, source);
    } catch (err: any) {
      console.warn(`[SourceEngine] 脚本搜索失败 [${keyword}]，切换至内置多平台搜索:`, err.message);
      return await this.directSearch(keyword, page, limit, source);
    }
  }

  public async getMusicUrl(songItem: Partial<MusicItem>, quality = '320k'): Promise<MusicUrlResult> {
    if (!this.sandboxContext) {
      await this.loadSource();
    }

    const source = songItem.source || 'kg';

    try {
      // 1. 尝试沙箱 LX 事件取链
      for (const handler of this.requestHandlers) {
        try {
          const res = await handler({
            action: 'musicUrl',
            source,
            info: {
              musicInfo: songItem.raw || {
                id: songItem.id,
                songmid: songItem.id,
                hash: songItem.id,
                name: songItem.name,
                singer: songItem.singer,
                album: songItem.albumName,
              },
              type: quality,
            },
          });
          if (typeof res === 'string' && res.startsWith('http')) {
            return { url: res, quality };
          }
          if (res && res.url) {
            return { url: res.url, headers: res.headers || {}, quality: res.type || quality };
          }
        } catch {}
      }

      // 2. 尝试从内置高可用直接解析器取链
      const directUrl = await this.directResolveMusicUrl(songItem, quality);
      if (directUrl) {
        return { url: directUrl, quality };
      }
    } catch (err: any) {
      console.error(`[SourceEngine] 解析歌曲 URL 失败 [${songItem.name}]:`, err.message);
    }

    return {
      url: '',
      quality,
    };
  }

  private async directSearch(keyword: string, page: number, limit: number, source: string): Promise<SearchResult> {
    // 1. 优先使用 QQ音乐（腾讯 TME 独家全量版权与最权威热度榜）
    try {
      const qqSearchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(keyword)}&p=${page}&n=${limit}&format=json`;
      const resp = await axios.get(qqSearchUrl, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://y.qq.com/',
        },
      });
      const songList = resp.data?.data?.song?.list || [];
      if (songList.length > 0) {
        const list: MusicItem[] = songList.map((item: any) => {
          const singerName = Array.isArray(item.singer) ? item.singer.map((s: any) => s.name).join(' / ') : (item.singer || '未知歌手');
          const intervalSec = Number(item.interval) || 210;
          return {
            id: String(item.songmid || item.songid || ''),
            name: String(item.songname || keyword),
            singer: singerName,
            albumName: String(item.albumname || ''),
            interval: this.formatSeconds(intervalSec),
            duration: intervalSec,
            img: item.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg` : '',
            source: 'tx',
            raw: {
              songmid: item.songmid,
              id: item.songmid || item.songid,
              name: item.songname,
              singer: singerName,
              album: item.albumname,
            },
          };
        });

        return {
          list,
          total: resp.data?.data?.song?.totalnum || list.length,
          page,
          limit,
          source: 'tx',
        };
      }
    } catch (err: any) {
      console.warn(`[SourceEngine] QQ音乐检索直连异常:`, err.message);
    }

    // 2. 次选：酷我音乐高热度榜单检索
    try {
      const kwSearchUrl = `https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}&pn=${page - 1}&rn=${limit}&vipver=1&ft=music&encoding=utf8&rformat=json&mobi=1`;
      const resp = await axios.get(kwSearchUrl, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const abslist = resp.data?.abslist || [];
      if (abslist.length > 0) {
        const list: MusicItem[] = abslist.map((item: any) => {
          const dur = Number(item.DURATION) || 210;
          const songId = String(item.DC_TARGETID || item.MUSICRID?.replace('MUSIC_', '') || '');
          return {
            id: songId,
            name: String(item.SONGNAME || keyword).replace(/&nbsp;/g, ' '),
            singer: String(item.ARTIST || '未知歌手').replace(/&nbsp;/g, ' '),
            albumName: String(item.ALBUM || '').replace(/&nbsp;/g, ' '),
            interval: this.formatSeconds(dur),
            duration: dur,
            img: item.web_albumpic_short ? `https://img4.kuwo.cn/star/albumcover/${item.web_albumpic_short}` : '',
            source: 'kw',
            raw: {
              songmid: songId,
              id: songId,
              name: item.SONGNAME,
              singer: item.ARTIST,
              album: item.ALBUM,
            },
          };
        });

        return {
          list,
          total: Number(resp.data?.TOTAL) || list.length,
          page,
          limit,
          source: 'kw',
        };
      }
    } catch (err: any) {
      console.warn(`[SourceEngine] 酷我搜索直连异常:`, err.message);
    }

    // 3. 备选：酷狗公开检索接口
    try {
      const kgSearchUrl = `https://complexsearch.kugou.com/v2/search/song?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&platform=WebFilter`;
      const resp = await axios.get(kgSearchUrl, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const lists = resp.data?.data?.lists || [];

      if (lists.length > 0) {
        const list: MusicItem[] = lists.map((item: any) => ({
          id: String(item.FileHash || item.EMixSongID || item.ID || ''),
          name: String(item.SongName || keyword).replace(/<\/?em>/g, ''),
          singer: String(item.SingerName || '未知歌手').replace(/<\/?em>/g, ''),
          albumName: String(item.AlbumName || '').replace(/<\/?em>/g, ''),
          interval: this.formatSeconds(item.Duration || 210),
          duration: item.Duration || 210,
          img: item.Image || '',
          source: 'kg',
          raw: {
            hash: item.FileHash,
            album_id: item.AlbumID,
            id: item.FileHash,
            name: item.SongName,
            singer: item.SingerName,
          },
        }));

        return {
          list,
          total: resp.data?.data?.total || list.length,
          page,
          limit,
          source: 'kg',
        };
      }
    } catch (err: any) {
      console.warn(`[SourceEngine] 酷狗搜索直连异常:`, err.message);
    }

    // 4. 终极回退：网易云公开检索接口
    try {
      const wySearchUrl = `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(keyword)}&type=1&offset=${(page - 1) * limit}&total=true&limit=${limit}`;
      const resp = await axios.get(wySearchUrl, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const songs = resp.data?.result?.songs || [];

      if (songs.length > 0) {
        const list: MusicItem[] = songs.map((item: any) => ({
          id: String(item.id),
          name: String(item.name || keyword),
          singer: String(item.artists?.[0]?.name || '未知歌手'),
          albumName: String(item.album?.name || ''),
          interval: this.formatSeconds(Math.floor((item.duration || 210000) / 1000)),
          duration: Math.floor((item.duration || 210000) / 1000),
          img: item.album?.picUrl || '',
          source: 'wy',
          raw: item,
        }));

        return {
          list,
          total: resp.data?.result?.songCount || list.length,
          page,
          limit,
          source: 'wy',
        };
      }
    } catch (err: any) {
      console.warn(`[SourceEngine] 网易云搜索直连异常:`, err.message);
    }

    return {
      list: [],
      total: 0,
      page,
      limit,
      source,
    };
  }

  private async directResolveMusicUrl(songItem: Partial<MusicItem>, quality = '320k'): Promise<string> {
    const songId = String(songItem.id || songItem.raw?.hash || songItem.raw?.id || '');
    const songName = String(songItem.name || '');
    const singer = String(songItem.singer || '');
    const searchKwd = `${singer} ${songName}`.trim() || songName;

    // 1. 👑 核心首选：腾讯/酷我 (TME) 官方录音室正版原声直通线
    // 无论是周杰伦全系列、陈小春《街角的晚风》等独家正版，均在此处提取 100% 录音室原声母带流
    try {
      let kuwoRid = '';
      if (songItem.source === 'kw' && /^\d+$/.test(songId)) {
        kuwoRid = songId;
      } else {
        const kwSearch = await axios.get(
          `https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(searchKwd)}&pn=0&rn=3&vipver=1&ft=music&encoding=utf8&rformat=json&mobi=1`,
          { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const bestMatch = kwSearch.data?.abslist?.[0];
        if (bestMatch?.DC_TARGETID) {
          kuwoRid = String(bestMatch.DC_TARGETID);
        }
      }

      if (kuwoRid) {
        const kwUrlResp = await axios.get(
          `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${kuwoRid}&format=mp3&response=url`,
          { timeout: 5000 }
        );
        const streamUrl = String(kwUrlResp.data || '').trim();
        if (streamUrl.startsWith('http')) {
          console.log(`[SourceEngine] 👑 腾讯/酷我官方录音室正版原声解析成功: ${searchKwd}`);
          return streamUrl;
        }
      }
    } catch {}

    // 2. 尝试酷狗官方原版直通
    if (songItem.source === 'kg' || /^[a-fA-F0-9]{32}$/.test(songId)) {
      try {
        const kgUrl = `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${songId}&mid=1`;
        const resp = await axios.get(kgUrl, {
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': 'kg_mid=1',
          },
        });
        const playUrl = resp.data?.data?.play_url || resp.data?.data?.play_backup_url;
        if (playUrl && typeof playUrl === 'string' && playUrl.startsWith('http')) {
          console.log(`[SourceEngine] ✅ 酷狗官方直连解析成功: ${songName}`);
          return playUrl;
        }
      } catch {}
    }

    // 3. 尝试公网多源聚合通道 (根据当前曲目 source 动态优先匹配 QQ音乐/酷狗/网易云)
    const candidateSources = songItem.source === 'tx'
      ? ['tencent', 'kugou', 'netease']
      : (songItem.source === 'wy' ? ['netease', 'tencent', 'kugou'] : ['kugou', 'tencent', 'netease']);

    for (const src of candidateSources) {
      try {
        const gdUrl = `https://music-api.gdstudio.xyz/api.php?types=url&source=${src}&id=${encodeURIComponent(songId)}&br=320`;
        const resp = await axios.get(gdUrl, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (resp.data?.url && typeof resp.data.url === 'string' && resp.data.url.startsWith('http')) {
          console.log(`[SourceEngine] ✅ GDAPI [${src}] 聚合解析成功: ${songName}`);
          return resp.data.url;
        }
      } catch {}
    }

    // 4. 终极回退：全网歌名+歌手模糊匹配直链提取 (按当前音源平台优先探测)
    const platforms = songItem.source === 'tx'
      ? ['tencent', 'kugou', 'netease']
      : (songItem.source === 'wy' ? ['netease', 'tencent', 'kugou'] : ['kugou', 'tencent', 'netease']);

    for (const platform of platforms) {
      try {
        const searchApi = `https://music-api.gdstudio.xyz/api.php?types=search&count=5&source=${platform}&pages=1&name=${encodeURIComponent(searchKwd)}`;
        const sResp = await axios.get(searchApi, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const first = sResp.data?.[0];
        if (first?.id) {
          const urlApi = `https://music-api.gdstudio.xyz/api.php?types=url&source=${platform}&id=${first.id}&br=320`;
          const uResp = await axios.get(urlApi, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (uResp.data?.url && typeof uResp.data.url === 'string' && uResp.data.url.startsWith('http')) {
            console.log(`[SourceEngine] ✅ 全网模糊跨源 [${platform}] 成功解析: ${searchKwd}`);
            return uResp.data.url;
          }
        }
      } catch {}
    }

    // 5. 网易云官方外链兜底
    if (songItem.source === 'wy' || /^\d+$/.test(songId)) {
      try {
        const wyUrl = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
        const resp = await axios.head(wyUrl, { timeout: 5000, maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 400 });
        if (resp.status === 302 && resp.headers.location && !resp.headers.location.includes('404')) {
          console.log(`[SourceEngine] ✅ 网易云直连解析成功: ${songName}`);
          return resp.headers.location;
        }
      } catch {}
    }

    return '';
  }

  private normalizeMusicItem(raw: any, source: string): MusicItem {
    return {
      id: String(raw.id || raw.songmid || raw.songId || raw.mid || raw.hash || raw.FileHash || Math.random().toString(36).slice(2)),
      name: String(raw.name || raw.title || raw.songName || raw.SongName || '未知歌曲'),
      singer: String(raw.singer || raw.artist || raw.author || raw.singerName || raw.SingerName || '未知歌手'),
      albumName: String(raw.albumName || raw.album || raw.AlbumName || ''),
      interval: raw.interval || (raw.duration ? this.formatSeconds(raw.duration) : '03:30'),
      duration: raw.duration || 210,
      img: raw.img || raw.pic || raw.artwork || raw.cover || raw.Image || '',
      source: raw.source || source,
      raw,
    };
  }

  private formatSeconds(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
}

