/**
 * 实体小爱音箱对话轮询监听器
 * 定期从小爱 MiNA 接口拉取最新对话记录，秒级捕获语音指令并触发回调
 */

import { XiaoAiClient } from '../speaker/client.js';
import { DeviceInfo } from '../types/index.js';
import { VoiceParser, ParsedVoiceCommand } from './parser.js';

export type VoiceCommandHandler = (did: string, cmd: ParsedVoiceCommand) => Promise<void>;

export class ConversationListener {
  private client: XiaoAiClient;
  private parser: VoiceParser;
  private isRunning = false;
  private pollIntervalMs: number;
  private lastTimestamps: Map<string, number> = new Map();
  private handledKeys: Set<string> = new Set();
  private commandHandler: VoiceCommandHandler | null = null;

  constructor(client: XiaoAiClient, pollIntervalMs = 1200) {
    this.client = client;
    this.parser = new VoiceParser();
    this.pollIntervalMs = pollIntervalMs;
  }

  public setCommandHandler(handler: VoiceCommandHandler): void {
    this.commandHandler = handler;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[ConversationListener] 实体小爱对话监听已启动 (轮询间隔: ${this.pollIntervalMs}ms)`);
    this.pollLoop();
  }

  public stop(): void {
    this.isRunning = false;
    console.log('[ConversationListener] 对话监听已停止');
  }

  private async pollLoop(): Promise<void> {
    while (this.isRunning) {
      if (this.client.isAuthSuspended) {
        console.warn('[ConversationListener] ⚠️ 账号认证遇阻或出现风控，监听器已自动安全停机，停止后续轮询。');
        this.stop();
        break;
      }

      try {
        let devices = this.client.getCachedDevices().filter((d) => d.source === 'MiNA' && !d.did.startsWith('blt.'));
        if (devices.length === 0) {
          devices = (await this.client.listDevices()).filter((d) => d.source === 'MiNA' && !d.did.startsWith('blt.'));
        }

        // 仅对真正的物理 WiFi 小爱音箱进行并行极速对话轮询 (恢复 8月28日机制)
        await Promise.allSettled(
          devices.map((dev) => this.checkSpeakerAsk(dev, devices))
        );
      } catch {
        // 忽略单次网络闪断
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private async checkSpeakerAsk(dev: DeviceInfo, allDevices: DeviceInfo[]): Promise<void> {
    try {
      const askResult = await this.client.getLatestAsk(dev.did);
      if (!askResult) return;

      const records = Array.isArray(askResult)
        ? askResult
        : askResult?.records || askResult?.data?.records || [];
      if (records.length === 0) return;

      const latestRecord = records[0];
      const timestamp = Number(latestRecord.time || latestRecord.timestamp_ms || Date.now());
      const query = String(latestRecord.query || latestRecord.response?.answer?.[0]?.question || '').trim();
      const reqId = `${dev.did}_${timestamp}_${query}`;

      const lastTime = this.lastTimestamps.get(dev.did) || 0;

      // 首次初始化时间戳，避免启动时误触发历史记录
      if (lastTime === 0) {
        this.lastTimestamps.set(dev.did, timestamp);
        this.handledKeys.add(reqId);
        return;
      }

      // 时间戳与排重校验
      if (timestamp <= lastTime || this.handledKeys.has(reqId) || !query) {
        return;
      }

      this.lastTimestamps.set(dev.did, timestamp);
      this.handledKeys.add(reqId);
      if (this.handledKeys.size > 200) {
        const keysArr = Array.from(this.handledKeys);
        this.handledKeys = new Set(keysArr.slice(keysArr.length - 100));
      }

      console.log(`[ConversationListener] 🎯 捕获到音箱 [${dev.name || dev.did}] (${dev.did}) 语音指令: "${query}"`);

      const parsed = this.parser.parse(query);
      if (parsed.type !== 'unknown') {
        // 抢先掐断当前小爱官方自带播放或 VIP 提示音
        await this.client.pause({ did: dev.did }).catch(() => {});

        if (this.commandHandler) {
          // 若指令明确要求全屋播放，通知所有音箱；否则只定向在当前听到的音箱 (dev.did) 上播放
          await this.commandHandler(dev.did, parsed);
        }
      }
    } catch {}
  }
}

