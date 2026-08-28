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
      request: (url: string, options: any = {}, callback?: (err: any, resp: any, body: any) => void) => {
        const method = (options.method || 'GET').toUpperCase();
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          ...(options.headers || {}),
        };
        const config: AxiosRequestConfig = {
          url,
          method,
          headers,
          timeout: options.timeout || 15000,
          responseType: options.responseType || 'text',
          validateStatus: () => true,
        };
        if (options.data || options.body || options.form) {
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
    try {
      // 优先从酷狗公开检索接口拉取真实歌曲
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

    // 备用：网易云公开检索接口
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

    // 1. 尝试酷狗官方取链
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
          console.log(`[SourceEngine] ✅ 酷狗直连解析成功: ${songName}`);
          return playUrl;
        }
      } catch {}
    }

    // 2. 尝试网易云官方高可用外链直通
    if (songItem.source === 'wy' || /^\d+$/.test(songId)) {
      try {
        const wyUrl = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
        const resp = await axios.head(wyUrl, { timeout: 6000, maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 400 });
        if (resp.status === 302 && resp.headers.location && !resp.headers.location.includes('404')) {
          console.log(`[SourceEngine] ✅ 网易云直连解析成功: ${songName}`);
          return resp.headers.location;
        }
      } catch {}
    }

    // 3. 尝试公网 GDAPI 聚合通道
    try {
      const gdUrl = `https://music-api.gdstudio.xyz/api.php?types=url&source=kugou&id=${encodeURIComponent(songId)}&br=320`;
      const resp = await axios.get(gdUrl, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (resp.data?.url && typeof resp.data.url === 'string' && resp.data.url.startsWith('http')) {
        console.log(`[SourceEngine] ✅ GDAPI 聚合解析成功: ${songName}`);
        return resp.data.url;
      }
    } catch {}

    // 4. 终极回退：根据歌名与歌手全网模糊搜取播放直链
    try {
      const searchKwd = `${singer} ${songName}`.trim();
      const backupSearch = `https://complexsearch.kugou.com/v2/search/song?keyword=${encodeURIComponent(searchKwd)}&page=1&pagesize=1&platform=WebFilter`;
      const resp = await axios.get(backupSearch, { timeout: 8000 });
      const firstHash = resp.data?.data?.lists?.[0]?.FileHash;
      if (firstHash) {
        const kgPlay = `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${firstHash}&mid=1`;
        const playResp = await axios.get(kgPlay, { timeout: 8000, headers: { Cookie: 'kg_mid=1' } });
        const playUrl = playResp.data?.data?.play_url;
        if (playUrl && typeof playUrl === 'string' && playUrl.startsWith('http')) {
          console.log(`[SourceEngine] ✅ 模糊匹配取链成功: ${searchKwd}`);
          return playUrl;
        }
      }
    } catch {}

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

