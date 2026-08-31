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
  private lastGlobalTimestamp = 0;
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
        await this.checkGlobalAsk();
      } catch (err: any) {
        // 忽略单次网络闪断
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private async checkGlobalAsk(): Promise<void> {
    try {
      let devices = this.client.getCachedDevices().filter((d) => d.source === 'MiNA' && !d.did.startsWith('blt.'));
      if (devices.length === 0) {
        devices = (await this.client.listDevices()).filter((d) => d.source === 'MiNA' && !d.did.startsWith('blt.'));
      }
      if (devices.length === 0) return;

      // 使用主音箱作为网关拉取小米云端最新对话流（单路查询，杜绝全屋多音箱重复并发）
      const primaryDev = devices[0];
      const askResult = await this.client.getLatestAsk(primaryDev.did);
      if (!askResult) return;

      const records = Array.isArray(askResult)
        ? askResult
        : (askResult?.records || askResult?.data?.records || []);
      if (records.length === 0) return;

      const latestRecord = records[0];
      const timestamp = Number(latestRecord.time || latestRecord.timestamp_ms || Date.now());
      const query = String(latestRecord.query || latestRecord.response?.answer?.[0]?.question || '').trim();
      const reqId = String(latestRecord.requestId || `${timestamp}_${query}`);

      // 首次初始化时间戳，避免启动时误触发历史记录
      if (this.lastGlobalTimestamp === 0) {
        this.lastGlobalTimestamp = timestamp;
        this.handledKeys.add(reqId);
        return;
      }

      // 全局时间戳与唯一 Key 排重：已处理过的请求绝不重复触发
      if (timestamp <= this.lastGlobalTimestamp || this.handledKeys.has(reqId) || !query) {
        return;
      }

      this.lastGlobalTimestamp = timestamp;
      this.handledKeys.add(reqId);
      if (this.handledKeys.size > 200) {
        const keysArr = Array.from(this.handledKeys);
        this.handledKeys = new Set(keysArr.slice(keysArr.length - 100));
      }

      // 智能识别当前接收指令的目标音箱
      let targetSpeaker = devices.find(
        (d) =>
          (d.deviceId && d.deviceId === latestRecord.deviceId) ||
          (d.did && d.did === latestRecord.miotDID) ||
          (d.did && d.did === latestRecord.deviceId)
      );

      if (!targetSpeaker) {
        targetSpeaker = devices[0];
      }

      console.log(`[ConversationListener] 🎯 捕获到音箱 [${targetSpeaker.name || targetSpeaker.did}] (${targetSpeaker.did}) 语音指令: "${query}"`);

      const parsed = this.parser.parse(query);
      if (parsed.type !== 'unknown') {
        // 抢先掐断小爱官方自带播放或 VIP 提示音
        await this.client.pause({ did: targetSpeaker.did }).catch(() => {});

        if (this.commandHandler) {
          await this.commandHandler(targetSpeaker.did, parsed);
        }
      }
    } catch {}
  }
}

