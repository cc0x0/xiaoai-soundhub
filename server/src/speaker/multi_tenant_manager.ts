import { XiaoAiClient } from './client.js';
import { AppDatabase, SpeakerRow } from '../db/index.js';
import { SecurityCrypto } from '../security/crypto.js';
import { VoiceParser, ParsedVoiceCommand } from '../listener/parser.js';
import { PlayScheduler } from '../scheduler/queue.js';
import { SourceEngine } from '../source_engine/sandbox.js';

export class MultiTenantSpeakerManager {
  private db: AppDatabase;
  private securitySalt: string;
  private clients = new Map<string, XiaoAiClient>();
  private activeListeners = new Map<string, NodeJS.Timeout>();
  private lastTimestamps = new Map<string, number>();
  private handledKeys = new Map<string, Set<string>>();
  private scheduler: PlayScheduler;
  private sourceEngine: SourceEngine;

  constructor(db: AppDatabase, securitySalt: string, scheduler: PlayScheduler, sourceEngine: SourceEngine) {
    this.db = db;
    this.securitySalt = securitySalt;
    this.scheduler = scheduler;
    this.sourceEngine = sourceEngine;
  }

  public async getClient(userId: string): Promise<XiaoAiClient | null> {
    const existing = this.clients.get(userId);
    if (existing) return existing;

    const miAcc = this.db.getMiAccount(userId);
    if (!miAcc || !miAcc.xiaomi_user_id || !miAcc.encrypted_pass_token) {
      return null;
    }

    const passToken = SecurityCrypto.decrypt(miAcc.encrypted_pass_token, this.securitySalt);
    if (!passToken) return null;

    const client = new XiaoAiClient({
      userId: miAcc.xiaomi_user_id,
      passToken: passToken,
      defaultDid: '',
    });

    try {
      const devices = await client.listDevices();
      if (devices && devices.length > 0) {
        this.db.syncSpeakers(userId, devices);
      }
    } catch {}

    this.clients.set(userId, client);
    return client;
  }

  public invalidateClient(userId: string): void {
    this.stopListener(userId);
    this.clients.delete(userId);
  }

  public async startAllActiveListeners(): Promise<void> {
    const isEnabled = this.db.getSystemSetting('enable_listener', 'true') !== 'false';
    if (!isEnabled) {
      console.log('[MultiTenant] 🔇 全局语音监听已被管理员设为关闭，跳过启动');
      return;
    }
    const allAccs = this.db.getAllMiAccounts();
    console.log(`[MultiTenant] 正在启动 ${allAccs.length} 个租户的小爱语音监听池...`);
    const startedXiaomiIds = new Set<string>();
    for (const acc of allAccs) {
      if (startedXiaomiIds.has(acc.xiaomi_user_id)) {
        console.warn(`[MultiTenant] ⚠️ 拦截重复小米账号监听 (ID: ${acc.xiaomi_user_id}, 租户: ${acc.user_id})`);
        continue;
      }
      startedXiaomiIds.add(acc.xiaomi_user_id);
      this.startListener(acc.user_id).catch(() => {});
    }
  }

  public stopAllListeners(): void {
    for (const userId of Array.from(this.activeListeners.keys())) {
      this.stopListener(userId);
    }
    console.log('[MultiTenant] 🔇 已暂停所有租户的语音监听池');
  }

  public async startListener(userId: string): Promise<boolean> {
    this.stopListener(userId);

    const isEnabled = this.db.getSystemSetting('enable_listener', 'true') !== 'false';
    if (!isEnabled) return false;

    const client = await this.getClient(userId);
    if (!client) return false;

    if (!this.handledKeys.has(userId)) {
      this.handledKeys.set(userId, new Set());
    }

    const pollIntervalMs = Number(this.db.getSystemSetting('poll_interval_ms', '1200')) || 1200;

    const timer = setInterval(() => {
      this.pollTenantConversation(userId, client).catch(() => {});
    }, pollIntervalMs);

    this.activeListeners.set(userId, timer);
    console.log(`[MultiTenant] 用户 [${userId}] 语音监听已启动 (间隔: ${pollIntervalMs}ms)`);
    return true;
  }

  public stopListener(userId: string): void {
    const timer = this.activeListeners.get(userId);
    if (timer) {
      clearInterval(timer);
      this.activeListeners.delete(userId);
      console.log(`[MultiTenant] 用户 [${userId}] 语音监听已停止`);
    }
  }

  private async pollTenantConversation(userId: string, client: XiaoAiClient): Promise<void> {
    try {
      const speakers = this.db.getSpeakers(userId).filter((s) => s.is_ignored === 0 && s.is_listener_enabled === 1);
      if (speakers.length === 0) return;

      // 对所有启用监听的音箱进行并行极速轮询 (恢复 8月28日机制)
      await Promise.allSettled(
        speakers.map((spk) => this.checkTenantSpeakerAsk(userId, spk, client, speakers))
      );
    } catch {}
  }

  private async checkTenantSpeakerAsk(
    userId: string,
    speaker: SpeakerRow,
    client: XiaoAiClient,
    allSpeakers: SpeakerRow[]
  ): Promise<void> {
    try {
      const res = await client.getLatestAsk(speaker.did);
      const records = Array.isArray(res) ? res : res?.records || res?.data?.records || [];
      if (!records || records.length === 0) return;

      const latestRecord = records[0];
      const timestamp = Number(latestRecord.time || latestRecord.timestamp_ms || Date.now());
      const query = String(latestRecord.query || latestRecord.response?.answer?.[0]?.question || '').trim();
      const reqId = `${speaker.did}_${timestamp}_${query}`;

      const speakerKey = `${userId}:${speaker.did}`;
      const lastTime = this.lastTimestamps.get(speakerKey) || 0;
      const userHandled = this.handledKeys.get(userId)!;

      if (lastTime === 0) {
        this.lastTimestamps.set(speakerKey, timestamp);
        userHandled.add(reqId);
        return;
      }

      if (timestamp <= lastTime || userHandled.has(reqId) || !query) {
        return;
      }

      this.lastTimestamps.set(speakerKey, timestamp);
      userHandled.add(reqId);
      if (userHandled.size > 200) {
        const arr = Array.from(userHandled);
        this.handledKeys.set(userId, new Set(arr.slice(arr.length - 100)));
      }

      // 获取用户个性化口令与设置
      const userSettings = this.db.getUserSettings(userId);
      let customStop: string[] = [];
      let customPrefixes: string[] = [];
      try {
        customStop = JSON.parse(userSettings.custom_stop_keywords || '[]');
      } catch {}
      try {
        customPrefixes = JSON.parse(userSettings.custom_prefixes || '[]');
      } catch {}

      const parser = new VoiceParser(customStop, customPrefixes);
      const cmd = parser.parse(query);

      console.log(
        `[MultiTenant] 🎯 用户 [${userId}] 音箱 [${speaker.name || speaker.did}] 捕获指令: "${query}" => ${cmd.type} (全屋: ${!!cmd.isAllSpeakers})`
      );

      if (cmd.type !== 'unknown') {
        // 抢先掐断官方声音
        await client.pause({ did: speaker.did }).catch(() => {});
        await this.handleVoiceCommand(userId, speaker.did, cmd, client, allSpeakers);
      }
    } catch {}
  }

  private async handleVoiceCommand(
    userId: string,
    currentDid: string,
    cmd: ParsedVoiceCommand,
    client: XiaoAiClient,
    allSpeakers: SpeakerRow[] = []
  ): Promise<void> {
    const targetDids = cmd.isAllSpeakers
      ? (allSpeakers.length > 0 ? allSpeakers.map((s) => s.did) : [currentDid])
      : [currentDid];

    if (cmd.type === 'play' && cmd.keyword) {
      const settings = this.db.getUserSettings(userId);
      const platform =
        settings.search_platform || this.db.getSystemSetting('default_platform', 'all');
      const quality = settings.preferred_quality || '320k';

      console.log(
        `[MultiTenant] 用户 [${userId}] 搜索音乐: ${cmd.keyword} [音源: ${platform} | 目标音箱: ${targetDids.join(',')}]`
      );
      const searchRes = await this.sourceEngine.search(cmd.keyword, 1, 20, platform);
      if (searchRes.list.length === 0) {
        console.warn(`[MultiTenant] 用户 [${userId}] 在音源 [${platform}] 下未搜索到: ${cmd.keyword}`);
        await this.speakFailure(client, currentDid, `没有找到${cmd.keyword}`);
        return;
      }

      // 并发下发到目标设备（单台或全屋）
      const playPromises = targetDids.map((did) =>
        this.scheduler.playMusicList(did, searchRes.list, 0, {
          client,
          quality,
          userId,
        })
      );

      const results = await Promise.allSettled(playPromises);
      const anySuccess = results.some((r) => r.status === 'fulfilled' && r.value.ok);

      if (!anySuccess) {
        const firstFailure = results.find(
          (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && !r.value.ok
        );
        const failMsg = firstFailure?.value?.message || '暂时无法播放这首歌';
        console.warn(`[MultiTenant] 用户 [${userId}] 点歌失败: ${failMsg}`);
        await this.speakFailure(client, currentDid, failMsg);
      }
    } else if (cmd.type === 'stop') {
      await Promise.allSettled(targetDids.map((did) => this.scheduler.stop(did, client)));
    } else if (cmd.type === 'pause') {
      await Promise.allSettled(targetDids.map((did) => this.scheduler.pause(did, client)));
    } else if (cmd.type === 'resume') {
      await Promise.allSettled(targetDids.map((did) => this.scheduler.resume(did, client)));
    } else if (cmd.type === 'next') {
      await Promise.allSettled(targetDids.map((did) => this.scheduler.next(did, client)));
    } else if (cmd.type === 'prev') {
      await Promise.allSettled(targetDids.map((did) => this.scheduler.prev(did, client)));
    } else if (cmd.type === 'volume' && cmd.volume !== undefined) {
      await Promise.allSettled(targetDids.map((did) => client.setVolume(cmd.volume!, { did })));
    }
  }

  /**
   * Read a failure back to the user on the speaker itself, without a chime —
   * a ding before an error message just sounds like something broke twice.
   * Long messages are trimmed because the setup hints they contain ("设置 →
   * 音源账号") only make sense on screen.
   */
  private async speakFailure(client: XiaoAiClient, did: string, message: string): Promise<void> {
    const spoken = message.split(/[（(]/)[0].trim().slice(0, 60);
    if (!spoken) return;
    await client.tts(spoken, { did, chime: false }).catch(() => {});
  }
}
