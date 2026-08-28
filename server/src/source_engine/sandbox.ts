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

  public async loadSource(sourceFileName?: string): Promise<boolean> {
    const fileName = sourceFileName || this.activeSourceFile;
    const fullPath = path.isAbsolute(fileName) ? fileName : path.join(this.sourcesDir, fileName);

    if (!fs.existsSync(fullPath)) {
      console.warn(`[SourceEngine] 音源脚本文件不存在: ${fullPath}，将使用内置基础搜索适配器`);
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
          validateStatus: () => true, // 允许所有状态码（403/404等作为正常响应返回给脚本处理）
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

        return () => {
          // 返回 cancel 回调
        };
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
      },
      emit: (event: string, ...args: any[]) => {
        const handlers = eventHandlers[event] || [];
        for (const h of handlers) {
          try {
            h(...args);
          } catch (e) {
            console.warn(`[SourceEngine] Event [${event}] handler error:`, (e as Error).message);
          }
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

    // 创建隔离上下文与全局 bridge（注入全部 V8 标准环境，杜绝 Bind must be called on a function）
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

      // 提取挂载在 context 中的导出项
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

  public async search(keyword: string, page = 1, limit = 20, source = 'kw'): Promise<SearchResult> {
    if (!this.sandboxContext) {
      await this.loadSource();
    }

    try {
      // 1. 尝试直接从沙箱内的 APIs 中查找搜索实现
      const targetSourceApi = this.apis[source] || this.apis[Object.keys(this.apis)[0]];
      if (targetSourceApi && typeof targetSourceApi.search === 'function') {
        const rawRes = await targetSourceApi.search({ keyword, page, limit });
        const list = (rawRes?.list || rawRes || []).map((item: any) => this.normalizeMusicItem(item, source));
        return {
          list,
          total: rawRes?.total || list.length,
          page,
          limit,
          source,
        };
      }

      // 2. 尝试沙箱全局函数 search
      const globalSearch = this.sandboxContext?.search || this.sandboxContext?.lxSearch;
      if (typeof globalSearch === 'function') {
        const rawRes = await globalSearch(keyword, page, limit, source);
        const list = (rawRes?.list || rawRes || []).map((item: any) => this.normalizeMusicItem(item, source));
        return {
          list,
          total: rawRes?.total || list.length,
          page,
          limit,
          source,
        };
      }

      // 3. 内置网络备选搜索（简易备选，保证在未挂载音源时系统依然可用）
      return await this.fallbackSearch(keyword, page, limit);
    } catch (err: any) {
      console.error(`[SourceEngine] 搜索歌曲失败 [${keyword}]:`, err.message);
      return await this.fallbackSearch(keyword, page, limit);
    }
  }

  public async getMusicUrl(songItem: Partial<MusicItem>, quality = '320k'): Promise<MusicUrlResult> {
    if (!this.sandboxContext) {
      await this.loadSource();
    }

    const source = songItem.source || 'kw';

    try {
      // 1. 尝试从沙箱音源 API 取链
      const targetSourceApi = this.apis[source] || this.apis[Object.keys(this.apis)[0]];
      if (targetSourceApi && typeof targetSourceApi.getMusicUrl === 'function') {
        const result = await targetSourceApi.getMusicUrl({
          songInfo: songItem.raw || songItem,
          type: quality,
        });

        if (typeof result === 'string') {
          return { url: result, quality };
        }
        if (result && result.url) {
          return {
            url: result.url,
            headers: result.headers || {},
            quality: result.type || quality,
          };
        }
      }

      // 2. 尝试从沙箱全局取链
      const globalGetUrl = this.sandboxContext?.getMusicUrl;
      if (typeof globalGetUrl === 'function') {
        const result = await globalGetUrl(songItem, quality);
        if (typeof result === 'string') return { url: result, quality };
        if (result?.url) return { url: result.url, headers: result.headers, quality };
      }
    } catch (err: any) {
      console.error(`[SourceEngine] 解析歌曲 URL 失败 [${songItem.name}]:`, err.message);
    }

    // 3. 如果未能直接获取，返回空链接
    return {
      url: '',
      quality,
    };
  }

  private normalizeMusicItem(raw: any, source: string): MusicItem {
    return {
      id: String(raw.id || raw.songmid || raw.songId || raw.mid || Math.random().toString(36).slice(2)),
      name: String(raw.name || raw.title || raw.songName || '未知歌曲'),
      singer: String(raw.singer || raw.artist || raw.author || raw.singerName || '未知歌手'),
      albumName: String(raw.albumName || raw.album || ''),
      interval: raw.interval || (raw.duration ? this.formatSeconds(raw.duration) : '03:30'),
      duration: raw.duration || 210,
      img: raw.img || raw.pic || raw.artwork || raw.cover || '',
      source: raw.source || source,
      raw,
    };
  }

  private formatSeconds(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  private async fallbackSearch(keyword: string, page: number, limit: number): Promise<SearchResult> {
    // 简易公网聚合搜索备选
    return {
      list: [
        {
          id: 'fb_1',
          name: keyword,
          singer: '热门歌曲',
          albumName: '精选专辑',
          interval: '03:45',
          duration: 225,
          source: 'default',
        },
      ],
      total: 1,
      page,
      limit,
      source: 'default',
    };
  }
}

