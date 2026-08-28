/**
 * 小爱音箱云端客户端 (MiNA / MiOT 协议封装)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { DeviceInfo, SpeakerConfig } from '../types/index.js';
import { resolveTTSCommand } from './model_map.js';

interface MiServiceInstance {
  init(params: { debug: boolean; speaker: SpeakerConfig }): Promise<void>;
  MiOT: {
    doAction(siid: number, aiid: number, params: unknown): Promise<unknown>;
    getProperty(siid: number, piid: number): Promise<unknown>;
    account?: {
      device?: {
        model?: string;
      };
    };
  };
  MiNA: {
    setVolume(volume: number): Promise<unknown>;
    player_pause(deviceId?: string): Promise<unknown>;
    player_stop(deviceId?: string): Promise<unknown>;
    play_by_url(deviceId: string, url: string): Promise<unknown>;
    text_to_speech(deviceId: string, text: string): Promise<unknown>;
    get_latest_ask(deviceId: string): Promise<unknown>;
    account?: {
      device?: {
        hardware?: string;
      };
    };
  };
}

interface MiSpeakerInstance {
  play(params: { text?: string; url?: string }): Promise<unknown>;
}

export class XiaoAiClient {
  private config: SpeakerConfig;
  private initialized = false;
  private miService: MiServiceInstance | null = null;
  private miSpeaker: MiSpeakerInstance | null = null;
  private miotModule: any = null;
  private deviceCache: DeviceInfo[] = [];
  private activeDid = '';

  constructor(config: SpeakerConfig) {
    this.config = config;
  }

  private getMiCacheDir(): string {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const dir = path.join(home, '.xiaoai-soundhub');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private async withMiCwd<T>(fn: () => Promise<T>): Promise<T> {
    const originalCwd = process.cwd();
    const cacheDir = this.getMiCacheDir();
    try {
      process.chdir(cacheDir);
      return await fn();
    } finally {
      try {
        process.chdir(originalCwd);
      } catch {
        // ignore
      }
    }
  }

  private async loadModules(): Promise<void> {
    if (this.miService && this.miSpeaker && this.miotModule) return;
    const serviceModule: any = await import('@mi-gpt/next/service' as string);
    const speakerModule: any = await import('@mi-gpt/next/speaker' as string);
    this.miotModule = await import('@mi-gpt/miot' as string);
    this.miService = serviceModule.MiService;
    this.miSpeaker = speakerModule.MiSpeaker;
  }

  public async init(targetDid?: string): Promise<void> {
    await this.loadModules();
    const didToUse = targetDid || this.config.defaultDid || this.config.did || '';
    
    if (this.initialized && this.activeDid === didToUse) {
      return;
    }

    const currentConfig: SpeakerConfig = {
      ...this.config,
      did: didToUse,
    };

    await this.withMiCwd(async () => {
      if (!this.miService) throw new Error('MiService 加载失败');
      await this.miService.init({
        debug: !!this.config.verboseLog,
        speaker: currentConfig,
      });
    });

    this.activeDid = didToUse;
    this.initialized = true;
  }

  public async listDevices(): Promise<DeviceInfo[]> {
    await this.loadModules();
    if (!this.config.userId || !(this.config.passToken || this.config.password)) {
      throw new Error('请在配置中提供 userId 与 passToken（或 password）');
    }

    const getMiNA = this.miotModule.getMiNA || this.miotModule.default?.getMiNA;
    const getMIoT = this.miotModule.getMIoT || this.miotModule.default?.getMIoT;

    const serviceConfig = {
      userId: this.config.userId,
      password: this.config.password,
      passToken: this.config.passToken,
      did: '',
      debug: false,
      relogin: true,
    };

    const [MiNAClient, MIoTClient] = await this.withMiCwd(() =>
      Promise.all([getMiNA(serviceConfig), getMIoT(serviceConfig)])
    );

    const [minaResult, miotResult] = await Promise.allSettled([
      MiNAClient?.getDevices?.(),
      MIoTClient?.getDevices?.(),
    ]);

    const rawMina = minaResult.status === 'fulfilled' && Array.isArray(minaResult.value) ? minaResult.value : [];
    const rawMiot = miotResult.status === 'fulfilled' && Array.isArray(miotResult.value) ? miotResult.value : [];

    const deviceMap = new Map<string, DeviceInfo>();

    for (const dev of rawMina) {
      const did = String(dev.miotDID || dev.deviceID || dev.deviceId || '').trim();
      if (!did) continue;
      deviceMap.set(did, {
        did,
        name: String(dev.alias || dev.name || did).trim(),
        alias: String(dev.alias || '').trim(),
        model: String(dev.hardware || '').trim().toLowerCase(),
        mac: String(dev.mac || '').trim(),
        online: dev.presence === 'online' || dev.presence === true,
        source: 'MiNA',
      });
    }

    for (const dev of rawMiot) {
      const did = String(dev.did || '').trim();
      if (!did) continue;
      const existing = deviceMap.get(did);
      if (existing) {
        if (dev.model) existing.model = String(dev.model).trim().toLowerCase();
        if (dev.isOnline !== undefined) existing.online = !!dev.isOnline;
      } else {
        deviceMap.set(did, {
          did,
          name: String(dev.name || did).trim(),
          alias: '',
          model: String(dev.model || '').trim().toLowerCase(),
          mac: String(dev.mac || '').trim(),
          online: !!dev.isOnline,
          source: 'MIoT',
        });
      }
    }

    this.deviceCache = Array.from(deviceMap.values());
    return this.deviceCache;
  }

  public getCachedDevices(): DeviceInfo[] {
    return this.deviceCache;
  }

  public async tts(text: string, options?: { did?: string }): Promise<boolean> {
    const targetDid = options?.did || this.config.defaultDid || this.config.did || '';
    await this.init(targetDid);

    const device = this.deviceCache.find((d) => d.did === targetDid);
    const model = device?.model || '';
    const [siid, aiid] = resolveTTSCommand(
      model,
      this.config.ttsFallbackCommands,
      this.config.ttsFallbackCommand || [5, 1]
    );

    // 优先尝试 MiOT doAction
    try {
      if (this.miService) {
        const res = await this.miService.MiOT.doAction(siid, aiid, text);
        if (res) return true;
      }
    } catch {
      // 回退至默认 MiSpeaker / MiNA
    }

    if (this.miSpeaker) {
      await this.miSpeaker.play({ text });
      return true;
    }

    return false;
  }

  public async ttsMulti(text: string, dids: string[]): Promise<Record<string, boolean>> {
    const targetDids = dids.length > 0 ? dids : [this.config.defaultDid || this.config.did || ''];
    const results: Record<string, boolean> = {};

    await Promise.allSettled(
      targetDids.map(async (did) => {
        try {
          const ok = await this.tts(text, { did });
          results[did] = ok;
        } catch {
          results[did] = false;
        }
      })
    );

    return results;
  }

  public async playAudio(url: string, options?: { did?: string }): Promise<boolean> {
    const targetDid = options?.did || this.config.defaultDid || this.config.did || '';
    await this.init(targetDid);

    if (this.miSpeaker) {
      const res = await this.miSpeaker.play({ url });
      return !!res;
    }
    return false;
  }

  public async pause(options?: { did?: string }): Promise<boolean> {
    const targetDid = options?.did || this.config.defaultDid || this.config.did || '';
    await this.init(targetDid);

    if (this.miService?.MiNA) {
      await this.miService.MiNA.player_pause(targetDid);
      return true;
    }
    return false;
  }

  public async setVolume(volume: number, options?: { did?: string }): Promise<boolean> {
    const targetDid = options?.did || this.config.defaultDid || this.config.did || '';
    await this.init(targetDid);

    if (this.miService?.MiNA) {
      await this.miService.MiNA.setVolume(volume);
      return true;
    }
    return false;
  }

  public async getLatestAsk(deviceId: string): Promise<any> {
    await this.loadModules();
    if (this.miService?.MiNA?.get_latest_ask) {
      return await this.miService.MiNA.get_latest_ask(deviceId);
    }
    return null;
  }
}

