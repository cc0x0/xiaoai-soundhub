/**
 * 播放队列与切歌调度器
 * 负责管理各音箱的播放列表、自动切歌、后台预解析下一首歌曲
 */

import { MusicItem, PlayQueueItem, ResolveFailureReason } from '../types/index.js';
import { SourceEngine } from '../source_engine/sandbox.js';
import { CredentialStore } from '../source_engine/platforms.js';
import { XiaoAiClient } from '../speaker/client.js';
import { StreamProxy } from '../proxy/stream.js';
import { AppDatabase } from '../db/index.js';

/**
 * Outcome of a playback attempt. Carries the reason on failure so the API can
 * tell the user *why* nothing played — "QQ音乐 needs credentials" is a fixable
 * problem, and swallowing it into a bare `false` is what made the old behaviour
 * feel like a silent bug.
 */
export interface PlayResult {
  ok: boolean;
  reason?: ResolveFailureReason;
  message?: string;
  /** Platform the stream actually came from, when it differs from the request. */
  resolvedSource?: string;
  /** True when a same-recording copy on another platform was used. */
  crossSource?: boolean;
}

/** Everything the scheduler needs to resolve a stream for one tenant's device. */
export interface PlaybackContext {
  client?: XiaoAiClient;
  quality?: string;
  /** Tenant id, used to read their credentials and fallback policy. */
  userId?: string;
}

export class PlayScheduler {
  private sourceEngine: SourceEngine;
  private fallbackClient: XiaoAiClient;
  private publicBaseUrl: string;
  private db?: AppDatabase;
  private securitySalt: string;
  private currentPlayState: Map<string, PlayQueueItem> = new Map();
  private playlist: Map<string, MusicItem[]> = new Map();
  private currentIndex: Map<string, number> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private didClientMap: Map<string, XiaoAiClient> = new Map();
  /** Preferred playback quality per device, from the owning tenant's settings. */
  private didQuality: Map<string, string> = new Map();
  /** Owning tenant per device, so resolution can read their credentials. */
  private didUserId: Map<string, string> = new Map();

  constructor(
    sourceEngine: SourceEngine,
    client: XiaoAiClient,
    publicBaseUrl: string,
    db?: AppDatabase,
    securitySalt = ''
  ) {
    this.sourceEngine = sourceEngine;
    this.fallbackClient = client;
    this.publicBaseUrl = publicBaseUrl;
    this.db = db;
    this.securitySalt = securitySalt;
  }

  private getClient(did: string, client?: XiaoAiClient): XiaoAiClient {
    if (client) {
      this.didClientMap.set(did, client);
      return client;
    }
    return this.didClientMap.get(did) || this.fallbackClient;
  }

  /** Remember per-device context so later next/prev keep the same tenant scope. */
  private applyContext(did: string, ctx?: PlaybackContext): void {
    if (!ctx) return;
    if (ctx.client) this.didClientMap.set(did, ctx.client);
    if (ctx.quality) this.didQuality.set(did, ctx.quality);
    if (ctx.userId) this.didUserId.set(did, ctx.userId);
  }

  public async playMusicList(
    did: string,
    list: MusicItem[],
    startIndex = 0,
    ctx?: PlaybackContext
  ): Promise<PlayResult> {
    if (!list || list.length === 0) {
      return { ok: false, reason: 'not_available', message: '播放列表为空' };
    }
    this.applyContext(did, ctx);
    this.playlist.set(did, list);
    this.currentIndex.set(did, startIndex);
    return await this.playCurrentIndex(did);
  }

  public async playSingle(did: string, item: MusicItem, ctx?: PlaybackContext): Promise<PlayResult> {
    this.applyContext(did, ctx);
    this.playlist.set(did, [item]);
    this.currentIndex.set(did, 0);
    return await this.playCurrentIndex(did);
  }

  public async next(did: string, client?: XiaoAiClient): Promise<PlayResult> {
    if (client) this.didClientMap.set(did, client);
    const list = this.playlist.get(did) || [];
    if (list.length === 0) {
      return { ok: false, reason: 'not_available', message: '当前播放队列为空' };
    }
    // 🛑 单曲播放防死循环：如果列表只有 1 首歌曲，播放完毕后直接停止并清空，不单曲重复回放！
    if (list.length <= 1) {
      console.log(`[PlayScheduler] 音箱 [${did}] 单曲播放完毕，自动安全结束（不自动循环）`);
      await this.stop(did, client);
      return { ok: true, message: '单曲播放完毕，已正常停止' };
    }
    const current = this.currentIndex.get(did) || 0;
    const nextIdx = (current + 1) % list.length;
    this.currentIndex.set(did, nextIdx);
    return await this.playCurrentIndex(did);
  }

  public async prev(did: string, client?: XiaoAiClient): Promise<PlayResult> {
    if (client) this.didClientMap.set(did, client);
    const list = this.playlist.get(did) || [];
    if (list.length === 0) {
      return { ok: false, reason: 'not_available', message: '当前播放队列为空' };
    }
    const current = this.currentIndex.get(did) || 0;
    const prevIdx = (current - 1 + list.length) % list.length;
    this.currentIndex.set(did, prevIdx);
    return await this.playCurrentIndex(did);
  }

  public async stop(did: string, client?: XiaoAiClient): Promise<boolean> {
    this.clearTimer(did);
    this.currentPlayState.delete(did);
    this.playlist.delete(did);
    this.currentIndex.delete(did);
    console.log(`[PlayScheduler] 音箱 [${did}] 已彻底停止播放并清空队列与定时器`);
    const activeClient = this.getClient(did, client);
    return await activeClient.stop({ did });
  }

  public async pause(did: string, client?: XiaoAiClient): Promise<boolean> {
    this.clearTimer(did);
    console.log(`[PlayScheduler] 音箱 [${did}] 已暂停播放并取消自动切歌定时器`);
    const activeClient = this.getClient(did, client);
    return await activeClient.pause({ did });
  }

  public async resume(did: string, client?: XiaoAiClient): Promise<PlayResult> {
    if (client) this.didClientMap.set(did, client);
    const current = this.currentPlayState.get(did);
    if (!current) {
      return { ok: false, reason: 'not_available', message: '该音箱当前没有可恢复的播放任务' };
    }
    console.log(`[PlayScheduler] 为音箱 [${did}] 恢复音乐播放: ${current.music.singer} - ${current.music.name}`);
    return await this.playCurrentIndex(did);
  }

  public getCurrentState(did?: string): PlayQueueItem | undefined {
    if (did) return this.currentPlayState.get(did);
    const firstKey = this.currentPlayState.keys().next().value;
    return firstKey ? this.currentPlayState.get(firstKey) : undefined;
  }

  public getAllStates(): Record<string, PlayQueueItem> {
    const res: Record<string, PlayQueueItem> = {};
    for (const [did, state] of this.currentPlayState.entries()) {
      res[did] = state;
    }
    return res;
  }

  private clearTimer(did: string): void {
    const timer = this.timers.get(did);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(did);
    }
  }

  /**
   * Resolve the effective fallback policy for a device.
   *
   * The tenant's own `strict` / `cross_source` choice wins; the global system
   * setting is only the default for tenants who never expressed one. Strict
   * means: never quietly substitute another platform's recording — report the
   * reason instead.
   */
  private allowCrossSourceFor(userId?: string): boolean {
    const globalAllowed =
      this.db?.getSystemSetting('allow_cross_source_fallback', 'true') !== 'false';
    if (!userId || !this.db) return globalAllowed;
    const policy = this.db.getUserSettings(userId)?.fallback_policy;
    if (policy === 'strict') return false;
    if (policy === 'cross_source') return true;
    return globalAllowed;
  }

  private credentialsFor(userId?: string): CredentialStore | undefined {
    if (!userId || !this.db) return undefined;
    const store = this.db.getSourceCredentials(userId, this.securitySalt);
    return Object.keys(store).length > 0 ? (store as CredentialStore) : undefined;
  }

  private async playCurrentIndex(did: string): Promise<PlayResult> {
    this.clearTimer(did);
    const list = this.playlist.get(did) || [];
    const idx = this.currentIndex.get(did) || 0;
    const music = list[idx];
    if (!music) {
      return { ok: false, reason: 'not_available', message: '播放队列中没有可播放的歌曲' };
    }

    console.log(
      `[PlayScheduler] 音箱 [${did}] 开始解析歌曲: ${music.singer} - ${music.name} [音源: ${music.source}]`
    );

    // 1. 获取音源直链（若客户端已试听成功并携带直链，支持极速直通，免二次解析）
    const quality = this.didQuality.get(did) || '320k';
    const userId = this.didUserId.get(did);
    const allowCrossSource = this.allowCrossSourceFor(userId);

    let urlRes: any = null;
    const directUrl = music.streamUrl || music.url;
    if (directUrl && typeof directUrl === 'string' && (directUrl.startsWith('http://') || directUrl.startsWith('https://'))) {
      console.log(
        `[PlayScheduler] ⚡ 音箱 [${did}] 收到客户端直通有效直链，直接投播: ${music.singer} - ${music.name}`
      );
      urlRes = { url: directUrl, resolvedSource: music.source, crossSource: false };
    } else {
      urlRes = await this.sourceEngine.getMusicUrl(music, {
        quality,
        allowCrossSource,
        credentials: this.credentialsFor(userId),
      });
    }
    if (!urlRes || !urlRes.url) {
      console.warn(
        `[PlayScheduler] 无法获取歌曲播放直链: ${music.name} [音源: ${music.source}] 原因: ${urlRes?.reason || 'unknown'}`
      );
      return {
        ok: false,
        reason: urlRes?.reason || 'not_available',
        message: urlRes?.message || `《${music.name}》暂无可用播放地址`,
      };
    }

    // 2. 包装中继代理地址（解决小爱防盗链）
    const proxyStreamUrl = StreamProxy.buildProxyUrl(this.publicBaseUrl, urlRes.url, urlRes.headers);

    // 3. 记录播放状态
    const duration = music.duration || 210;
    this.currentPlayState.set(did, {
      music,
      streamUrl: proxyStreamUrl,
      targetDid: did,
      startTime: Date.now(),
      duration,
    });

    // 4. 命令小爱开始播放
    const activeClient = this.getClient(did);
    console.log(`[PlayScheduler] 下发直链至音箱 [${did}]: ${proxyStreamUrl}`);
    const ok = await activeClient.playAudio(proxyStreamUrl, { did });

    // 5. 设置自动切歌定时器 (带硬件真实状态感知守护锁 & 动态读取 switch_buffer_ms)
    if (ok && duration > 5) {
      const bufferMs = Number(this.db?.getSystemSetting('switch_buffer_ms', '2000')) || 2000;
      const timeoutMs = (duration * 1000) + bufferMs;
      const timer = setTimeout(async () => {
        try {
          // 守护锁：在切歌前主动探测小爱硬件当前真实状态
          const hwStatus = await activeClient.getPlayStatus(did);
          if (hwStatus === 'paused' || hwStatus === 'stopped' || hwStatus === 'idle') {
            console.log(`[PlayScheduler] 🛑 探测到音箱 [${did}] 当前处于 [${hwStatus}] 状态（用户已手动暂停/停止），安全取消自动切歌。`);
            this.clearTimer(did);
            this.currentPlayState.delete(did);
            return;
          }
        } catch {}

        console.log(`[PlayScheduler] 歌曲播放结束，自动切下一首 [${did}]`);
        this.next(did).catch(() => {});
      }, timeoutMs);
      this.timers.set(did, timer);
    }

    if (!ok) {
      return { ok: false, reason: 'not_available', message: '直链已取到，但音箱未接受播放指令' };
    }

    return {
      ok: true,
      resolvedSource: urlRes.resolvedSource,
      crossSource: urlRes.crossSource,
      message: urlRes.crossSource
        ? `已用其他平台的同一首录音播放《${music.name}》`
        : undefined,
    };
  }
}

