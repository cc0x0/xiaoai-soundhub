/**
 * LX Music 自定义音源沙箱执行引擎 + 多平台音源调度器
 *
 * 分层职责：
 *   1. LX 沙箱层：用 Node VM 模拟 lx 运行时，执行 sources/*.js 自定义音源脚本；
 *   2. 平台适配层 (platforms.ts)：每个平台(网易/QQ/酷我/酷狗/咪咕)自带原生搜索与取链；
 *   3. 调度层：严格按调用方指定的 source 走对应平台，`all` 时并发聚合。
 *
 * 关键约束：任何一次搜索/取链都只在"用户所选的音源"内完成，绝不擅自跨平台
 * 顶替（避免搜出翻唱版 / 换成别家录音）。仅当调用方显式允许时才跨源兜底。
 */

import vm from 'vm';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios, { AxiosRequestConfig } from 'axios';
import { MusicItem, MusicUrlResult, SearchResult } from '../types/index.js';
import {
  AGGREGATE_SOURCE,
  CREDENTIAL_PLATFORMS,
  CredentialStore,
  PLATFORM_IDS,
  PLATFORM_NAMES,
  PLATFORM_QUALITIES,
  PlatformId,
  findSameTrackOnPlatform,
  getAdapter,
  hasUsableCredentials,
  isPlatformId,
  mapQuality,
  mergeAggregatedResults,
  resolveViaAggregator,
} from './platforms.js';

export interface SearchOptions {
  /** Platform id (wy/tx/kw/kg/mg) or `all` for aggregated search. */
  source?: string;
  page?: number;
  limit?: number;
}

export interface ResolveOptions {
  quality?: string;
  /**
   * Allow falling back to other platforms when the track's own platform cannot
   * produce a stream. Off by default so the selected source is respected.
   */
  allowCrossSource?: boolean;
  /**
   * The tenant's own per-platform account keys. Adapters that can sign an
   * official stream URL (QQ音乐 vkey, 网易云 MUSIC_U) use these first, which is
   * both higher quality and steadier than any relayed link.
   */
  credentials?: CredentialStore;
}

export class SourceEngine {
  private sourcesDir: string;
  private activeSourceFile: string;
  private sandboxContext: vm.Context | null = null;
  private sourceInfo: Record<string, any> = {};
  private apis: Record<string, any> = {};
  private requestHandlers: Array<(payload: any) => Promise<any>> = [];
  /** Platforms the currently loaded LX script declares support for. */
  private scriptPlatforms = new Set<string>();
  /**
   * Circuit breaker per `${platform}:${action}`. Many published LX scripts talk
   * to a private server that may be offline or geo-blocked; once a channel has
   * failed repeatedly we stop paying its timeout on every request.
   */
  private scriptFailures = new Map<string, number>();
  private static readonly SCRIPT_FAILURE_LIMIT = 3;

  constructor(sourcesDir: string, activeSourceFile: string) {
    this.sourcesDir = sourcesDir;
    this.activeSourceFile = activeSourceFile;
  }

  public getActiveSource(): string {
    return this.activeSourceFile;
  }

  /** Platform ids the loaded LX script can serve, for diagnostics/UI. */
  public getScriptPlatforms(): string[] {
    return Array.from(this.scriptPlatforms);
  }

  public async loadSource(sourceFileName?: string): Promise<boolean> {
    const fileName = sourceFileName || this.activeSourceFile;
    const fullPath = path.isAbsolute(fileName) ? fileName : path.join(this.sourcesDir, fileName);

    this.requestHandlers = [];
    this.scriptPlatforms = new Set();
    this.apis = {};
    this.sourceInfo = {};

    if (!fs.existsSync(fullPath)) {
      console.warn(`[SourceEngine] 音源脚本不存在: ${fullPath}，将仅使用内置多平台适配器`);
      this.activeSourceFile = fileName;
      return false;
    }

    const scriptContent = fs.readFileSync(fullPath, 'utf-8');
    this.activeSourceFile = fileName;

    const atobPolyfill = (str: string) => Buffer.from(str, 'base64').toString('binary');
    const btoaPolyfill = (str: string) => Buffer.from(str, 'binary').toString('base64');

    const eventHandlers: Record<string, ((...args: any[]) => any)[]> = {};

    const onInited = (data: any) => {
      this.sourceInfo = data || {};
      if (data?.sources && typeof data.sources === 'object') {
        this.apis = data.sources;
        for (const key of Object.keys(data.sources)) {
          this.scriptPlatforms.add(key);
        }
        console.log(
          `[SourceEngine] 音源 [${fileName}] 声明支持平台: ${Array.from(this.scriptPlatforms).join(', ') || '无'}`
        );
      }
    };

    // 模拟 LX 运行环境
    const lxBridge = {
      version: '2.0.0',
      env: 'mobile',
      currentScriptInfo: { name: fileName, description: '', rawScript: scriptContent, version: '1' },
      EVENT_NAMES: {
        inited: 'inited',
        updateAlert: 'updateAlert',
        request: 'request',
      },
      request: (
        url: string,
        optionsOrCb: any = {},
        maybeCb?: (err: any, resp: any, body: any) => void
      ) => {
        let options: any = optionsOrCb;
        let callback = maybeCb;
        if (typeof optionsOrCb === 'function') {
          callback = optionsOrCb;
          options = {};
        }

        const method = (options?.method || 'GET').toUpperCase();
        const headers = {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
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
            if (callback) callback(null, responseObj, resp.data);
          })
          .catch((err: any) => {
            if (callback) callback(err, null, null);
          });

        return () => {};
      },
      send: (action: string, data: any) => {
        if (action === 'init' || action === 'inited') onInited(data);
      },
      sendAction: (action: string, data: any) => {
        if (action === 'init' || action === 'inited') onInited(data);
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
          bufToString: (buf: Buffer, encoding: BufferEncoding = 'utf8') =>
            Buffer.from(buf).toString(encoding),
        },
        crypto: {
          md5: (str: string) => crypto.createHash('md5').update(str).digest('hex'),
          randomBytes: (size: number) => crypto.randomBytes(size),
          aesEncrypt: (data: string, mode: string, key: string, iv: string) => {
            const cipher = crypto.createCipheriv(mode, key, iv);
            return Buffer.concat([cipher.update(data), cipher.final()]).toString('base64');
          },
          rsaEncrypt: (data: string, key: string) =>
            crypto.publicEncrypt(key, Buffer.from(data)).toString('base64'),
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
      TextEncoder,
      TextDecoder,
      atob: atobPolyfill,
      btoa: btoaPolyfill,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
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

    // Published LX scripts routinely kick off an async self-init whose rejection
    // nobody awaits (offline private server, geo-block, expired key). Left alone
    // that surfaces as an unhandledRejection and can take the process down, so
    // rejections raised while the script boots are swallowed deliberately.
    const swallowScriptRejection = (reason: any) => {
      console.warn(
        `[SourceEngine] 音源 [${fileName}] 初始化期间抛出未处理异常（已隔离）: ${reason?.message || reason}`
      );
    };
    process.on('unhandledRejection', swallowScriptRejection);
    setTimeout(() => process.off('unhandledRejection', swallowScriptRejection), 20000);

    try {
      vm.runInContext(scriptContent, this.sandboxContext, {
        filename: fileName,
        timeout: 10000,
      });

      if (context.apis) this.apis = context.apis;
      if (context.lx?.apis) this.apis = context.lx.apis;
      if (context.sources) this.apis = context.sources;
      for (const key of Object.keys(this.apis || {})) {
        this.scriptPlatforms.add(key);
      }

      console.log(`[SourceEngine] 自定义音源 [${fileName}] 加载成功`);
      return true;
    } catch (err: any) {
      console.error('[SourceEngine] 执行自定义音源脚本出错:', err.message);
      return false;
    }
  }

  /**
   * Search music. `source` decides where the query goes and is honoured
   * strictly: a platform id searches only that platform, `all` fans out to
   * every platform concurrently (LX 聚合搜索).
   */
  public async search(
    keyword: string,
    page = 1,
    limit = 20,
    source: string = AGGREGATE_SOURCE
  ): Promise<SearchResult> {
    const normalized = this.normalizeSource(source);

    if (normalized === AGGREGATE_SOURCE) {
      return await this.aggregatedSearch(keyword, page, limit);
    }

    const list = await this.searchOnePlatform(keyword, page, limit, normalized);
    return { list, total: list.length, page, limit, source: normalized };
  }

  /** Fan out to every platform concurrently and interleave the results. */
  private async aggregatedSearch(keyword: string, page: number, limit: number): Promise<SearchResult> {
    const perPlatform = Math.max(5, Math.ceil(limit / PLATFORM_IDS.length) + 3);

    const settled = await Promise.allSettled(
      PLATFORM_IDS.map((platform) => this.searchOnePlatform(keyword, page, perPlatform, platform))
    );

    const lists: MusicItem[][] = [];
    const okPlatforms: string[] = [];
    settled.forEach((result, idx) => {
      const platform = PLATFORM_IDS[idx];
      if (result.status === 'fulfilled' && result.value.length > 0) {
        lists.push(result.value);
        okPlatforms.push(platform);
      }
    });

    const merged = mergeAggregatedResults(lists, limit, keyword);
    console.log(
      `[SourceEngine] 🔀 聚合搜索 [${keyword}] 命中平台: ${okPlatforms.join(', ') || '无'}，合并 ${merged.length} 首`
    );

    return { list: merged, total: merged.length, page, limit, source: AGGREGATE_SOURCE };
  }

  /**
   * Search a single platform: LX script first (when it declares support for
   * that platform), then the platform's own native API.
   */
  private async searchOnePlatform(
    keyword: string,
    page: number,
    limit: number,
    platform: PlatformId
  ): Promise<MusicItem[]> {
    if (this.scriptSupports(platform, 'search')) {
      try {
        const scriptList = await this.callScript('search', platform, {
          key: keyword,
          keyword,
          page,
          limit,
        });
        if (scriptList.length > 0) {
          this.noteScriptSuccess(platform, 'search');
          console.log(
            `[SourceEngine] 🎵 [${PLATFORM_NAMES[platform]}] 音源脚本搜索命中 ${scriptList.length} 首`
          );
          return scriptList;
        }
        this.noteScriptFailure(platform, 'search');
      } catch (err: any) {
        this.noteScriptFailure(platform, 'search');
        console.warn(
          `[SourceEngine] [${PLATFORM_NAMES[platform]}] 音源脚本搜索失败，转内置接口: ${err.message}`
        );
      }
    }

    const adapter = getAdapter(platform);
    if (!adapter) return [];

    try {
      const list = await adapter.search(keyword, page, limit);
      if (list.length > 0) {
        console.log(`[SourceEngine] ✅ [${adapter.name}] 原生接口搜索命中 ${list.length} 首`);
      }
      return list;
    } catch (err: any) {
      console.warn(`[SourceEngine] [${adapter.name}] 搜索接口异常: ${err.message}`);
      return [];
    }
  }

  /**
   * Resolve a playable stream URL for a track, staying on the track's own
   * platform: LX script -> platform native endpoint -> aggregated API (same
   * platform). Cross-platform fallback only when explicitly allowed.
   */
  public async getMusicUrl(
    songItem: Partial<MusicItem>,
    qualityOrOptions: string | ResolveOptions = '320k'
  ): Promise<MusicUrlResult> {
    const options: ResolveOptions =
      typeof qualityOrOptions === 'string' ? { quality: qualityOrOptions } : qualityOrOptions;
    const requestedQuality = options.quality || '320k';

    const platform = isPlatformId(String(songItem.source)) ? (songItem.source as PlatformId) : null;
    if (!platform) {
      console.warn(`[SourceEngine] 歌曲 [${songItem.name}] 缺少有效音源标识，无法解析直链`);
      return {
        url: '',
        quality: requestedQuality,
        reason: 'no_source',
        message: '该歌曲缺少有效的音源标识，无法解析播放地址',
      };
    }

    const quality = mapQuality(requestedQuality, PLATFORM_QUALITIES[platform]);
    if (quality !== requestedQuality) {
      console.log(`[SourceEngine] [${PLATFORM_NAMES[platform]}] 音质映射: ${requestedQuality} -> ${quality}`);
    }

    const resolved = await this.resolveOnPlatform(songItem, quality, platform, options.credentials);
    if (resolved) return { ...resolved, resolvedSource: platform };

    // 宽松跨源兜底（恢复 8月28日机制）：默认允许跨源兜底，除非显式指定 false
    const allowCrossSource = options.allowCrossSource !== false;

    if (allowCrossSource) {
      // 1. 优先尝试聚合搜索时携带的同曲跨源副本
      for (const alt of songItem.alternates || []) {
        if (!isPlatformId(alt.source) || alt.source === platform) continue;
        const altPlatform = alt.source as PlatformId;
        const res = await this.resolveOnPlatform(
          { ...alt, albumName: songItem.albumName, img: songItem.img },
          mapQuality(requestedQuality, PLATFORM_QUALITIES[altPlatform]),
          altPlatform,
          options.credentials
        );
        if (res && res.url) {
          console.log(
            `[SourceEngine] ⚠️ [${PLATFORM_NAMES[platform]}] 无可用直链，已改用聚合副本 [${PLATFORM_NAMES[altPlatform]}]: ${alt.singer} - ${alt.name}`
          );
          return { ...res, resolvedSource: altPlatform, crossSource: true };
        }
      }

      // 2. 在其它原生平台精准匹配同名同歌手录音
      const triedSources = new Set([platform, ...(songItem.alternates || []).map((a) => a.source)]);
      for (const fallback of PLATFORM_IDS) {
        if (triedSources.has(fallback)) continue;

        const twin = await findSameTrackOnPlatform(songItem, fallback);
        if (!twin) continue;

        const alt = await this.resolveOnPlatform(
          twin,
          mapQuality(requestedQuality, PLATFORM_QUALITIES[fallback]),
          fallback,
          options.credentials
        );
        if (alt && alt.url) {
          console.log(
            `[SourceEngine] ⚠️ [${PLATFORM_NAMES[platform]}] 无可用直链，已精确匹配同一首歌并回退至 [${PLATFORM_NAMES[fallback]}]: ${twin.singer} - ${twin.name}`
          );
          return { ...alt, resolvedSource: fallback, crossSource: true };
        }
      }

      // 3. 终极回退（8月28日版本特性）：全网歌名+歌手模糊匹配直链提取 (GDStudio 跨源通道)
      const searchKwd = `${songItem.singer || ''} ${songItem.name || ''}`.trim() || String(songItem.name || '');
      for (const p of ['netease', 'kugou', 'tencent', 'kuwo']) {
        try {
          const sResp = await axios.get(
            `https://music-api.gdstudio.xyz/api.php?types=search&count=5&source=${p}&pages=1&name=${encodeURIComponent(searchKwd)}`,
            { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
          );
          const candidates = Array.isArray(sResp.data) ? sResp.data : [];
          if (candidates.length > 0 && candidates[0]?.id) {
            const uResp = await axios.get(
              `https://music-api.gdstudio.xyz/api.php?types=url&source=${p}&id=${encodeURIComponent(String(candidates[0].id))}&br=320`,
              { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
            );
            const rawUrl = uResp.data?.url;
            if (typeof rawUrl === 'string' && rawUrl.startsWith('http')) {
              console.log(`[SourceEngine] ✅ 全网模糊跨源 [${p}] 成功解析: ${searchKwd}`);
              return { url: rawUrl, quality: '320k', resolvedSource: p, crossSource: true };
            }
          }
        } catch {}
      }

      // 4. 网易云免费外链终极兜底
      try {
        const wySearch = await axios.get(
          `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(searchKwd)}&type=1&offset=0&total=true&limit=5`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }
        );
        const songs = wySearch.data?.result?.songs || [];
        for (const s of songs) {
          const wyUrl = `https://music.163.com/song/media/outer/url?id=${s.id}.mp3`;
          try {
            const head = await axios.head(wyUrl, {
              maxRedirects: 0,
              validateStatus: (st) => st >= 200 && st < 400,
              timeout: 4000,
            });
            if (head.status === 302 && head.headers.location && !head.headers.location.includes('404')) {
              console.log(`[SourceEngine] ✅ 网易云外链终极兜底解析成功: ${searchKwd}`);
              return { url: head.headers.location, quality: '128k', resolvedSource: 'wy', crossSource: true };
            }
          } catch {}
        }
      } catch {}
    }

    console.warn(
      `[SourceEngine] ❌ [${PLATFORM_NAMES[platform]}] 未能解析出直链: ${songItem.singer} - ${songItem.name}`
    );

    const platformName = PLATFORM_NAMES[platform];
    return {
      url: '',
      quality,
      reason: 'not_available',
      message: `${platformName} 及全网暂未找到《${songItem.name}》的可播放资源`,
    };
  }

  /** Try every resolution channel available for one specific platform. */
  private async resolveOnPlatform(
    songItem: Partial<MusicItem>,
    quality: string,
    platform: PlatformId,
    credentials?: CredentialStore
  ): Promise<MusicUrlResult | null> {
    const adapter = getAdapter(platform);
    const platformCred = credentials?.[platform];
    const credentialed = hasUsableCredentials(platform, credentials);

    // 1. 凭证直通：租户配置了自己的账号时，原平台官方接口是最高优先级——
    //    音质由其订阅决定，链路也比任何中转都稳定。
    if (credentialed && adapter) {
      try {
        const url = await adapter.resolveUrl(songItem, quality, platformCred);
        if (url) {
          console.log(
            `[SourceEngine] 🔑 [${adapter.name}] 凭证直通官方接口取链成功: ${songItem.name}`
          );
          return { url, quality };
        }
        console.warn(
          `[SourceEngine] [${adapter.name}] 凭证直通未取到链（凭证可能已过期或该曲目无版权）`
        );
      } catch (err: any) {
        console.warn(`[SourceEngine] [${adapter.name}] 凭证直通取链异常: ${err.message}`);
      }
    }

    // 2. LX 自定义音源脚本 (仅当脚本声明支持该平台且未被熔断)
    if (this.scriptSupports(platform, 'musicUrl')) {
      try {
        const res = await this.callScriptMusicUrl(songItem, quality, platform);
        if (res) {
          this.noteScriptSuccess(platform, 'musicUrl');
          console.log(
            `[SourceEngine] 🎵 [${PLATFORM_NAMES[platform]}] 音源脚本取链成功: ${songItem.name}`
          );
          return res;
        }
        this.noteScriptFailure(platform, 'musicUrl');
      } catch (err: any) {
        this.noteScriptFailure(platform, 'musicUrl');
        console.warn(
          `[SourceEngine] [${PLATFORM_NAMES[platform]}] 音源脚本取链失败: ${err.message}`
        );
      }
    }

    // 3. 平台原生官方接口（无凭证的匿名通道，部分曲目仍可放行）
    if (adapter && !credentialed) {
      try {
        const url = await adapter.resolveUrl(songItem, quality, platformCred);
        if (url) {
          console.log(`[SourceEngine] ✅ [${adapter.name}] 原生接口取链成功: ${songItem.name}`);
          return { url, quality };
        }
      } catch (err: any) {
        console.warn(`[SourceEngine] [${adapter.name}] 原生取链异常: ${err.message}`);
      }
    }

    // 4. 聚合 API（同平台，不换源）
    try {
      const url = await resolveViaAggregator(songItem, quality, platform);
      if (url) {
        console.log(
          `[SourceEngine] ✅ [${PLATFORM_NAMES[platform]}] 聚合接口取链成功: ${songItem.name}`
        );
        return { url, quality };
      }
    } catch (err: any) {
      console.warn(`[SourceEngine] [${PLATFORM_NAMES[platform]}] 聚合取链异常: ${err.message}`);
    }

    return null;
  }

  /** Ask the LX script for a music url; returns null when it cannot serve it. */
  private async callScriptMusicUrl(
    songItem: Partial<MusicItem>,
    quality: string,
    platform: PlatformId
  ): Promise<MusicUrlResult | null> {
    const musicInfo = songItem.raw || {
      id: songItem.id,
      songmid: songItem.id,
      hash: songItem.id,
      name: songItem.name,
      singer: songItem.singer,
      album: songItem.albumName,
    };

    for (const handler of this.requestHandlers) {
      try {
        const res = await handler({
          action: 'musicUrl',
          source: platform,
          info: { musicInfo, type: quality },
        });
        if (typeof res === 'string' && res.startsWith('http')) {
          return { url: res, quality };
        }
        if (res?.url && String(res.url).startsWith('http')) {
          return { url: res.url, headers: res.headers || {}, quality: res.type || quality };
        }
      } catch {
        // try the next registered handler
      }
    }
    return null;
  }

  /** Ask the LX script to search; normalizes whatever shape it returns. */
  private async callScript(
    action: 'search',
    platform: PlatformId,
    info: Record<string, unknown>
  ): Promise<MusicItem[]> {
    for (const handler of this.requestHandlers) {
      try {
        const raw = await handler({ action, source: platform, info });
        const list = Array.isArray(raw) ? raw : raw?.list;
        if (Array.isArray(list) && list.length > 0) {
          return list.map((item: any) => this.normalizeMusicItem(item, platform));
        }
      } catch {
        // try the next registered handler
      }
    }
    return [];
  }

  private scriptSupports(platform: string, action: 'search' | 'musicUrl'): boolean {
    if (this.requestHandlers.length === 0) return false;
    // Scripts that never declared their platforms are given a chance anyway.
    if (this.scriptPlatforms.size > 0 && !this.scriptPlatforms.has(platform)) return false;
    return (this.scriptFailures.get(`${platform}:${action}`) || 0) < SourceEngine.SCRIPT_FAILURE_LIMIT;
  }

  private noteScriptFailure(platform: string, action: 'search' | 'musicUrl'): void {
    const key = `${platform}:${action}`;
    const count = (this.scriptFailures.get(key) || 0) + 1;
    this.scriptFailures.set(key, count);
    if (count === SourceEngine.SCRIPT_FAILURE_LIMIT) {
      console.warn(
        `[SourceEngine] ⛔ 音源脚本在 [${PLATFORM_NAMES[platform] || platform}] 的 ${action} 通道连续失败 ${count} 次，已熔断，后续直接走内置接口`
      );
    }
  }

  private noteScriptSuccess(platform: string, action: 'search' | 'musicUrl'): void {
    this.scriptFailures.delete(`${platform}:${action}`);
  }

  /** Normalize a requested source into a platform id or the aggregate marker. */
  private normalizeSource(source?: string): PlatformId | typeof AGGREGATE_SOURCE {
    const value = String(source || '').trim().toLowerCase();
    if (!value || value === AGGREGATE_SOURCE || value === 'aggregate' || value === 'all') {
      return AGGREGATE_SOURCE;
    }
    if (isPlatformId(value)) return value;
    console.warn(`[SourceEngine] 未知音源标识 [${source}]，已回退为聚合搜索`);
    return AGGREGATE_SOURCE;
  }

  private normalizeMusicItem(raw: any, source: string): MusicItem {
    const duration = Number(raw.duration) || this.parseInterval(raw.interval) || 210;
    return {
      id: String(
        raw.id || raw.songmid || raw.songId || raw.mid || raw.hash || raw.FileHash || raw.copyrightId || ''
      ),
      name: String(raw.name || raw.title || raw.songName || raw.SongName || '未知歌曲'),
      singer: String(
        raw.singer || raw.artist || raw.author || raw.singerName || raw.SingerName || '未知歌手'
      ),
      albumName: String(raw.albumName || raw.album || raw.AlbumName || ''),
      interval: typeof raw.interval === 'string' ? raw.interval : this.formatSeconds(duration),
      duration,
      img: raw.img || raw.pic || raw.artwork || raw.cover || raw.Image || '',
      source: isPlatformId(String(raw.source)) ? String(raw.source) : source,
      raw,
    };
  }

  /** Parse "03:45" (or a ms number) into seconds. */
  private parseInterval(interval: unknown): number {
    if (typeof interval === 'number') {
      return interval > 10000 ? Math.floor(interval / 1000) : interval;
    }
    const match = String(interval || '').match(/^(\d{1,3}):(\d{2})$/);
    if (!match) return 0;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  private formatSeconds(sec: number): string {
    const total = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
}
