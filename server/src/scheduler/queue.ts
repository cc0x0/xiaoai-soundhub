/**
 * 播放队列与切歌调度器
 * 负责管理各音箱的播放列表、自动切歌、后台预解析下一首歌曲
 */

import { MusicItem, PlayQueueItem } from '../types/index.js';
import { SourceEngine } from '../source_engine/sandbox.js';
import { XiaoAiClient } from '../speaker/client.js';
import { StreamProxy } from '../proxy/stream.js';

export class PlayScheduler {
  private sourceEngine: SourceEngine;
  private client: XiaoAiClient;
  private publicBaseUrl: string;
  private currentPlayState: Map<string, PlayQueueItem> = new Map();
  private playlist: Map<string, MusicItem[]> = new Map();
  private currentIndex: Map<string, number> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();

  constructor(sourceEngine: SourceEngine, client: XiaoAiClient, publicBaseUrl: string) {
    this.sourceEngine = sourceEngine;
    this.client = client;
    this.publicBaseUrl = publicBaseUrl;
  }

  public async playMusicList(did: string, list: MusicItem[], startIndex = 0): Promise<boolean> {
    if (!list || list.length === 0) return false;
    this.playlist.set(did, list);
    this.currentIndex.set(did, startIndex);
    return await this.playCurrentIndex(did);
  }

  public async playSingle(did: string, item: MusicItem): Promise<boolean> {
    this.playlist.set(did, [item]);
    this.currentIndex.set(did, 0);
    return await this.playCurrentIndex(did);
  }

  public async next(did: string): Promise<boolean> {
    const list = this.playlist.get(did) || [];
    if (list.length === 0) return false;
    const current = this.currentIndex.get(did) || 0;
    const nextIdx = (current + 1) % list.length;
    this.currentIndex.set(did, nextIdx);
    return await this.playCurrentIndex(did);
  }

  public async prev(did: string): Promise<boolean> {
    const list = this.playlist.get(did) || [];
    if (list.length === 0) return false;
    const current = this.currentIndex.get(did) || 0;
    const prevIdx = (current - 1 + list.length) % list.length;
    this.currentIndex.set(did, prevIdx);
    return await this.playCurrentIndex(did);
  }

  public async stop(did: string): Promise<boolean> {
    this.clearTimer(did);
    this.currentPlayState.delete(did);
    this.playlist.delete(did);
    this.currentIndex.delete(did);
    console.log(`[PlayScheduler] 音箱 [${did}] 已彻底停止播放并清空队列与定时器`);
    return await this.client.stop({ did });
  }

  public async pause(did: string): Promise<boolean> {
    this.clearTimer(did);
    console.log(`[PlayScheduler] 音箱 [${did}] 已暂停播放并取消自动切歌定时器`);
    return await this.client.pause({ did });
  }

  public async resume(did: string): Promise<boolean> {
    const current = this.currentPlayState.get(did);
    if (!current) return false;
    console.log(`[PlayScheduler] 语音播报结束，自动为音箱 [${did}] 恢复音乐播放: ${current.music.singer} - ${current.music.name}`);
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

    console.log(`[PlayScheduler] 音箱 [${did}] 开始解析歌曲: ${music.singer} - ${music.name}`);

    // 1. 获取音源直链
    const urlRes = await this.sourceEngine.getMusicUrl(music, '320k');
    if (!urlRes || !urlRes.url) {
      console.warn(`[PlayScheduler] 无法获取歌曲播放直链: ${music.name}`);
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
    console.log(`[PlayScheduler] 下发直链至音箱 [${did}]: ${proxyStreamUrl}`);
    const ok = await this.client.playAudio(proxyStreamUrl, { did });

    // 5. 设置自动切歌定时器
    if (ok && duration > 5) {
      const timeoutMs = (duration + 2) * 1000;
      const timer = setTimeout(() => {
        console.log(`[PlayScheduler] 歌曲播放结束，自动切下一首 [${did}]`);
        this.next(did).catch(() => {});
      }, timeoutMs);
      this.timers.set(did, timer);
    }

    return ok;
  }
}

