import { XiaoAiClient } from './client.js';
import { AppDatabase } from '../db/index.js';
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

      // 动态选择网关音箱：优先用户手动设定的 is_gateway = 1
      const gatewaySpeaker = speakers.find((s) => s.is_gateway === 1) || speakers[0];

      const res = await client.getLatestAsk(gatewaySpeaker.did);
      const records = Array.isArray(res) ? res : res?.records || res?.data?.records || [];
      if (!records || records.length === 0) return;

      const latestRecord = records[0];
      const timestamp = Number(latestRecord.time || latestRecord.timestamp_ms || Date.now());
      const query = String(latestRecord.query || latestRecord.response?.answer?.[0]?.question || '').trim();
      const reqId = String(latestRecord.requestId || `${timestamp}_${query}`);

      const lastTime = this.lastTimestamps.get(userId) || 0;
      const userHandled = this.handledKeys.get(userId)!;

      if (lastTime === 0) {
        this.lastTimestamps.set(userId, timestamp);
        userHandled.add(reqId);
        return;
      }

      if (timestamp <= lastTime || userHandled.has(reqId) || !query) {
        return;
      }

      this.lastTimestamps.set(userId, timestamp);
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

      console.log(`[MultiTenant] 🎯 用户 [${userId}] 音箱 [${gatewaySpeaker.name}] 捕获指令: "${query}" => ${cmd.type}`);

      if (cmd.type !== 'unknown') {
        // 抢先掐断官方声音
        await client.pause({ did: gatewaySpeaker.did }).catch(() => {});
        await this.handleVoiceCommand(userId, gatewaySpeaker.did, cmd, client);
      }
    } catch {}
  }

  private async handleVoiceCommand(userId: string, did: string, cmd: ParsedVoiceCommand, client: XiaoAiClient): Promise<void> {
    if (cmd.type === 'play' && cmd.keyword) {
      console.log(`[MultiTenant] 用户 [${userId}] 搜索音乐: ${cmd.keyword}`);
      const searchRes = await this.sourceEngine.search(cmd.keyword, 1, 20);
      if (searchRes.list.length > 0) {
        await this.scheduler.playMusicList(did, searchRes.list, 0);
      }
    } else if (cmd.type === 'stop') {
      await this.scheduler.stop(did);
    } else if (cmd.type === 'pause') {
      await this.scheduler.pause(did);
    } else if (cmd.type === 'resume') {
      await this.scheduler.resume(did);
    } else if (cmd.type === 'next') {
      await this.scheduler.next(did);
    } else if (cmd.type === 'prev') {
      await this.scheduler.prev(did);
    } else if (cmd.type === 'volume' && cmd.volume !== undefined) {
      await client.setVolume(cmd.volume, { did });
    }
  }
}
