/**
 * 播放队列与切歌调度器
 * 负责管理各音箱的播放列表、自动切歌、后台预解析下一首歌曲
 */

import { MusicItem, PlayQueueItem } from '../types/index.js';
import { SourceEngine } from '../source_engine/sandbox.js';
import { XiaoAiClient } from '../speaker/client.js';
import { StreamProxy } from '../proxy/stream.js';
import { AppDatabase } from '../db/index.js';

export class PlayScheduler {
  private sourceEngine: SourceEngine;
  private fallbackClient: XiaoAiClient;
  private publicBaseUrl: string;
  private db?: AppDatabase;
  private currentPlayState: Map<string, PlayQueueItem> = new Map();
  private playlist: Map<string, MusicItem[]> = new Map();
  private currentIndex: Map<string, number> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private didClientMap: Map<string, XiaoAiClient> = new Map();
  /** Preferred playback quality per device, from the owning tenant's settings. */
  private didQuality: Map<string, string> = new Map();

  constructor(sourceEngine: SourceEngine, client: XiaoAiClient, publicBaseUrl: string, db?: AppDatabase) {
    this.sourceEngine = sourceEngine;
    this.fallbackClient = client;
    this.publicBaseUrl = publicBaseUrl;
    this.db = db;
  }

  private getClient(did: string, client?: XiaoAiClient): XiaoAiClient {
    if (client) {
      this.didClientMap.set(did, client);
      return client;
    }
    return this.didClientMap.get(did) || this.fallbackClient;
  }

  public async playMusicList(
    did: string,
    list: MusicItem[],
    startIndex = 0,
    client?: XiaoAiClient,
    quality?: string
  ): Promise<boolean> {
    if (!list || list.length === 0) return false;
    if (client) this.didClientMap.set(did, client);
    if (quality) this.didQuality.set(did, quality);
    this.playlist.set(did, list);
    this.currentIndex.set(did, startIndex);
    return await this.playCurrentIndex(did);
  }

  public async playSingle(
    did: string,
    item: MusicItem,
    client?: XiaoAiClient,
    quality?: string
  ): Promise<boolean> {
    if (client) this.didClientMap.set(did, client);
    if (quality) this.didQuality.set(did, quality);
    this.playlist.set(did, [item]);
    this.currentIndex.set(did, 0);
    return await this.playCurrentIndex(did);
  }

  public async next(did: string, client?: XiaoAiClient): Promise<boolean> {
    if (client) this.didClientMap.set(did, client);
    const list = this.playlist.get(did) || [];
    if (list.length === 0) return false;
    const current = this.currentIndex.get(did) || 0;
    const nextIdx = (current + 1) % list.length;
    this.currentIndex.set(did, nextIdx);
    return await this.playCurrentIndex(did);
  }

  public async prev(did: string, client?: XiaoAiClient): Promise<boolean> {
    if (client) this.didClientMap.set(did, client);
    const list = this.playlist.get(did) || [];
    if (list.length === 0) return false;
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

  public async resume(did: string, client?: XiaoAiClient): Promise<boolean> {
    if (client) this.didClientMap.set(did, client);
    const current = this.currentPlayState.get(did);
    if (!current) return false;
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

  private async playCurrentIndex(did: string): Promise<boolean> {
    this.clearTimer(did);
    const list = this.playlist.get(did) || [];
    const idx = this.currentIndex.get(did) || 0;
    const music = list[idx];
    if (!music) return false;

    console.log(
      `[PlayScheduler] 音箱 [${did}] 开始解析歌曲: ${music.singer} - ${music.name} [音源: ${music.source}]`
    );

    // 1. 获取音源直链（严格沿用该曲目自身所属音源，不擅自换源）
    const quality = this.didQuality.get(did) || '320k';
    const allowCrossSource =
      this.db?.getSystemSetting('allow_cross_source_fallback', 'false') === 'true';
    const urlRes = await this.sourceEngine.getMusicUrl(music, { quality, allowCrossSource });
    if (!urlRes || !urlRes.url) {
      console.warn(`[PlayScheduler] 无法获取歌曲播放直链: ${music.name} [音源: ${music.source}]`);
      return false;
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

    return ok;
  }
}

