/**
 * 实体小爱音箱对话轮询监听器
 * 定期从小爱 MiNA 接口拉取最新对话记录，秒级捕获语音指令并触发回调
 */

import { XiaoAiClient } from '../speaker/client.js';
import { VoiceParser, ParsedVoiceCommand } from './parser.js';

export type VoiceCommandHandler = (did: string, cmd: ParsedVoiceCommand) => Promise<void>;

export class ConversationListener {
  private client: XiaoAiClient;
  private parser: VoiceParser;
  private isRunning = false;
  private pollIntervalMs: number;
  private lastTimestamps: Map<string, number> = new Map();
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
        const askResult = await this.client.getLatestAsk();
        if (askResult) {
          const records = Array.isArray(askResult)
            ? askResult
            : (askResult?.records || askResult?.data?.records || []);
          
          if (records.length > 0) {
            const latestRecord = records[0];
            const timestamp = Number(latestRecord.time || latestRecord.timestamp_ms || Date.now());
            const query = String(latestRecord.query || latestRecord.response?.answer?.[0]?.question || '').trim();
            const recordDid = String(latestRecord.miotDID || latestRecord.deviceID || latestRecord.deviceId || 'global').trim();

            const lastTime = this.lastTimestamps.get(recordDid) || 0;

            // 首次初始化时间戳，避免启动时误触发历史记录
            if (lastTime === 0) {
              this.lastTimestamps.set(recordDid, timestamp);
            } else if (timestamp > lastTime && query) {
              this.lastTimestamps.set(recordDid, timestamp);
              
              // 匹配真实设备 DID
              const devices = this.client.getCachedDevices();
              const matchedDev = devices.find(d => d.did === recordDid || d.did.includes(recordDid) || recordDid.includes(d.did));
              const activeDid = matchedDev?.did || (devices[0]?.did || recordDid);

              console.log(`[ConversationListener] 🎯 捕获到音箱 [${activeDid}] 语音指令: "${query}"`);

              const parsed = this.parser.parse(query);
              if (parsed.type !== 'unknown') {
                // 抢先掐断小爱官方的 VIP 提示
                await this.client.pause({ did: activeDid }).catch(() => {});

                if (this.commandHandler) {
                  await this.commandHandler(activeDid, parsed);
                }
              }
            }
          }
        }
      } catch (err: any) {
        // 忽略单次网络闪断
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}

