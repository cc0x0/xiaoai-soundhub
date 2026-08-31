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
    get_latest_ask?: (deviceId: string) => Promise<unknown>;
    getConversations?: (options?: { limit?: number; timestamp?: number }) => Promise<unknown>;
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
    const originalExit = process.exit;
    const cacheDir = this.getMiCacheDir();

    // 拦截底层 @mi-gpt/miot 触发的 process.exit 异常退出调用，保护容器 100% 稳定运行
    (process as any).exit = (code?: number) => {
      console.warn(`[XiaoAiClient] 🛡️ 拦截到底层退出信号 (code: ${code})，已安全保护容器常驻运行`);
    };

    try {
      process.chdir(cacheDir);
      return await fn();
    } finally {
      process.exit = originalExit;
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

    // 确保设备缓存已就绪
    if (this.deviceCache.length === 0) {
      try {
        await this.listDevices();
      } catch {}
    }
    
    // 优先选取支持 MiNA 协议的真实小爱主音箱进行账号初始化
    let didToUse = targetDid || this.config.defaultDid || this.config.did || '';
    const minaSpeaker = this.deviceCache.find(d => d.source === 'MiNA' && !d.did.startsWith('blt.'));
    
    if (!didToUse || didToUse.startsWith('blt.') || (this.deviceCache.find(d => d.did === didToUse)?.source === 'MIoT' && minaSpeaker)) {
      if (minaSpeaker) {
        didToUse = minaSpeaker.did;
      }
    }
    
    if (this.initialized && this.activeDid === didToUse) {
      return;
    }

    const currentConfig: SpeakerConfig = {
      ...this.config,
      did: didToUse,
    };

    try {
      await this.withMiCwd(async () => {
        if (!this.miService) throw new Error('MiService 加载失败');
        await this.miService.init({
          debug: false,
          speaker: currentConfig,
        });
      });
      this.activeDid = didToUse;
      this.initialized = true;
    } catch (err: any) {
      console.warn(`[XiaoAiClient] 音箱 [${didToUse}] 初始化提示:`, err.message || err);
    }
  }

  public isAuthSuspended = false;
  public authErrorMessage = '';

  public async listDevices(): Promise<DeviceInfo[]> {
    if (this.isAuthSuspended) {
      return this.deviceCache;
    }

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
      pass: this.config.passToken ? { passToken: this.config.passToken } : undefined,
      did: '',
      debug: !!this.config.verboseLog,
      relogin: false,
    };

    try {
      const [MiNAClient, MIoTClient] = await this.withMiCwd(() =>
        Promise.all([getMiNA(serviceConfig), getMIoT(serviceConfig)])
      );

      const [minaResult, miotResult] = await Promise.allSettled([
        MiNAClient?.getDevices?.(),
        MIoTClient?.getDevices?.(),
      ]);

      const rawMina = minaResult.status === 'fulfilled' && Array.isArray(minaResult.value) ? minaResult.value : [];
      const rawMiot = miotResult.status === 'fulfilled' && Array.isArray(miotResult.value) ? miotResult.value : [];

      if (rawMina.length === 0 && rawMiot.length === 0) {
        console.warn('⚠️ [XiaomiAuth] 小米账号认证未获取到设备（可能是 passToken 过期或触发了风控验证码）。');
      }

      const isSpeaker = (model: string, name: string, did: string) => {
        const m = model.toLowerCase();
        const n = name.toLowerCase();
        const d = did.toLowerCase();
        // 过滤蓝牙 Mesh 子设备
        if (d.startsWith('blt.') || d.includes('blt') || m.includes('blt')) {
          return false;
        }
        // 排除万能遥控版及红外遥控类设备
        if (m.includes('remote') || m.includes('ir') || n.includes('遥控') || n.includes('万能') || did === '376878467') {
          return false;
        }
        // 排除常见的非音箱设备类别
        if (m.includes('camera') || m.includes('switch') || m.includes('plug') || m.includes('light') || m.includes('vacuum') || m.includes('sensor') || m.includes('lock') || m.includes('curtain') || m.includes('router') || m.includes('gateway')) {
          return false;
        }
        if (n.includes('摄像') || n.includes('插座') || n.includes('开关') || n.includes('灯') || n.includes('门锁') || n.includes('网关') || n.includes('窗帘') || n.includes('温湿度') || n.includes('传感器')) {
          return false;
        }
        // 匹配音箱特征
        return m.includes('wifispeaker') || m.includes('soundbox') || m.includes('speaker') || n.includes('音箱') || n.includes('音响') || n.includes('小爱');
      };

      const deviceMap = new Map<string, DeviceInfo>();

      for (const dev of rawMina) {
        const did = String(dev.miotDID || dev.deviceID || dev.deviceId || '').trim();
        if (!did) continue;
        const name = String(dev.alias || dev.name || did).trim();
        const model = String(dev.hardware || '').trim().toLowerCase();
        if (!isSpeaker(model, name, did)) continue;
        deviceMap.set(did, {
          did,
          deviceId: String(dev.deviceID || dev.deviceId || '').trim(),
          hardware: String(dev.hardware || '').trim().toLowerCase(),
          name,
          alias: String(dev.alias || '').trim(),
          model,
          mac: String(dev.mac || '').trim(),
          online: dev.presence === 'online' || dev.presence === true,
          source: 'MiNA',
        });
      }

      for (const dev of rawMiot) {
        const did = String(dev.did || '').trim();
        if (!did) continue;
        const name = String(dev.name || did).trim();
        const model = String(dev.model || '').trim().toLowerCase();
        const existing = deviceMap.get(did);
        if (existing) {
          if (dev.model) existing.model = model;
          if (dev.isOnline !== undefined) existing.online = !!dev.isOnline;
        } else if (isSpeaker(model, name, did)) {
          deviceMap.set(did, {
            did,
            deviceId: '',
            hardware: model,
            name,
            alias: '',
            model,
            mac: String(dev.mac || '').trim(),
            online: !!dev.isOnline,
            source: 'MIoT',
          });
        }
      }

      // 最终二次过滤，确保所有输出均为纯正音箱
      const finalDevices = Array.from(deviceMap.values()).filter(d => isSpeaker(d.model, d.name, d.did));
      this.deviceCache = finalDevices;
      return this.deviceCache;
    } catch (err: any) {
      this.isAuthSuspended = true;
      this.authErrorMessage = err.message || '小米账号登录认证遇到风控或凭证失效';
      console.warn(`[XiaomiAuth] ⚠️ 认证异常已熔断保护，停止后台循环重试:`, err.message);
      return this.deviceCache;
    }
  }

  public getCachedDevices(): DeviceInfo[] {
    return this.deviceCache;
  }

  public async tts(
    text: string,
    options?: { did?: string; chime?: string | boolean; publicBaseUrl?: string }
  ): Promise<boolean> {
    const targetDid = options?.did || this.config.defaultDid || this.config.did || '';
    await this.init(targetDid);

    // 如果指定了提示音（如 'dingdong', 'gentle', 'marimba' 或 true）
    if (options?.chime && options.chime !== 'none') {
      const chimeName = typeof options.chime === 'string' && ['gentle', 'marimba', 'dingdong'].includes(options.chime)
        ? options.chime
        : 'dingdong';
      const baseUrl = options.publicBaseUrl || 'http://localhost:8080';
      const chimeUrl = `${baseUrl.replace(/\/$/, '')}/audio/${chimeName}.wav`;
      
      try {
        await this.playAudio(chimeUrl, { did: targetDid });
        // 等待提示音播放结束并让音箱声道释放（约 1400ms）再启动朗读
        await new Promise((resolve) => setTimeout(resolve, 1400));
      } catch {}
    }

    // 优先使用 MiSpeaker / MiNA 原生强插语音通道（在放歌时具有最高硬件优先级）
    try {
      if (this.miSpeaker) {
        const ok = await this.miSpeaker.play({ text });
        if (ok) return true;
      }
    } catch {}

    // 次选 MiOT doAction 通道
    const device = this.deviceCache.find((d) => d.did === targetDid);
    const model = device?.model || '';
    const [siid, aiid] = resolveTTSCommand(
      model,
      this.config.ttsFallbackCommands,
      this.config.ttsFallbackCommand || [5, 1]
    );

    try {
      if (this.miService) {
        const res = await this.miService.MiOT.doAction(siid, aiid, text);
        if (res) return true;
      }
    } catch {}

    return false;
  }

  public async ttsMulti(
    text: string,
    dids: string[],
    options?: { chime?: string | boolean; publicBaseUrl?: string }
  ): Promise<Record<string, boolean>> {
    const targetDids = dids.length > 0 ? dids : [this.config.defaultDid || this.config.did || ''];
    const results: Record<string, boolean> = {};

    await Promise.allSettled(
      targetDids.map(async (did) => {
        try {
          const ok = await this.tts(text, { did, chime: options?.chime, publicBaseUrl: options?.publicBaseUrl });
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
    if (targetDid) {
      const client = await this.getMiNAClient(targetDid);
      if (client && typeof client.play === 'function') {
        return await client.play({ url });
      }
    }
    await this.init(targetDid);
    if (this.miSpeaker) {
      const res = await this.miSpeaker.play({ url });
      return !!res;
    }
    return false;
  }

  public async pause(options?: { did?: string }): Promise<boolean> {
    const targetDid = options?.did || this.config.defaultDid || this.config.did || '';
    if (targetDid) {
      const client: any = await this.getMiNAClient(targetDid);
      if (client) {
        if (typeof client.pause === 'function') {
          return !!(await client.pause());
        }
        if (typeof client.callUbus === 'function') {
          const res = await client.callUbus('mediaplayer', 'player_play_operation', { action: 'pause' });
          return res?.code === 0;
        }
      }
    }
    const mina: any = this.miService?.MiNA;
    if (mina) {
      if (typeof mina.pause === 'function') return !!(await mina.pause());
      if (typeof mina.player_pause === 'function') return !!(await mina.player_pause(targetDid));
    }
    return false;
  }

  public async stop(options?: { did?: string }): Promise<boolean> {
    const targetDid = options?.did || this.config.defaultDid || this.config.did || '';
    if (targetDid) {
      const client: any = await this.getMiNAClient(targetDid);
      if (client) {
        if (typeof client.stop === 'function') {
          return !!(await client.stop());
        }
        if (typeof client.callUbus === 'function') {
          const res = await client.callUbus('mediaplayer', 'player_play_operation', { action: 'stop' });
          return res?.code === 0;
        }
      }
    }
    const mina: any = this.miService?.MiNA;
    if (mina) {
      if (typeof mina.stop === 'function') return !!(await mina.stop());
      if (typeof mina.player_stop === 'function') return !!(await mina.player_stop(targetDid));
    }
    return false;
  }

  public async setVolume(volume: number, options?: { did?: string }): Promise<boolean> {
    const targetDid = options?.did || this.config.defaultDid || this.config.did || '';
    if (targetDid) {
      const client: any = await this.getMiNAClient(targetDid);
      if (client && typeof client.setVolume === 'function') {
        return !!(await client.setVolume(volume));
      }
    }
    const mina: any = this.miService?.MiNA;
    if (mina && typeof mina.setVolume === 'function') {
      return !!(await mina.setVolume(volume));
    }
    return false;
  }

  private minaClients = new Map<string, any>();

  public async getMiNAClient(did: string): Promise<any> {
    const existing = this.minaClients.get(did);
    if (existing) return existing;
    await this.loadModules();
    const getMiNA = this.miotModule.getMiNA || this.miotModule.default?.getMiNA;
    const client = await this.withMiCwd(() =>
      getMiNA({
        userId: this.config.userId,
        password: this.config.password,
        passToken: this.config.passToken,
        pass: this.config.passToken ? { passToken: this.config.passToken } : undefined,
        did,
        debug: false,
      })
    );
    if (client) this.minaClients.set(did, client);
    return client;
  }

  public async getPlayStatus(did?: string): Promise<'playing' | 'paused' | 'stopped' | 'idle' | 'unknown'> {
    const targetDid = did || this.config.defaultDid || this.config.did || '';
    if (!targetDid) return 'unknown';

    try {
      const client = await this.getMiNAClient(targetDid);
      if (client) {
        if (typeof client.getStatus === 'function') {
          const res = await client.getStatus();
          if (res?.status) return res.status;
        }
        if (typeof client.callUbus === 'function') {
          const ubusRes = await client.callUbus('mediaplayer', 'player_get_play_status');
          if (ubusRes) {
            const s = ubusRes.info?.status ?? ubusRes.status;
            if (s === 1 || s === 'playing') return 'playing';
            if (s === 2 || s === 'paused') return 'paused';
            if (s === 0 || s === 'stopped' || s === 'idle') return 'stopped';
          }
        }
      }
    } catch {}

    return 'unknown';
  }

  public async getLatestAsk(did?: string): Promise<any> {
    let targetDid = did;
    if (!targetDid) {
      const mainSpeaker = this.deviceCache.find((d) => d.source === 'MiNA' && !d.did.startsWith('blt.'));
      targetDid = mainSpeaker?.did || '';
    }
    if (!targetDid) return null;

    try {
      const client = await this.getMiNAClient(targetDid);
      if (client && typeof client.getConversations === 'function') {
        return await client.getConversations({ limit: 2 });
      }
      if (client && typeof client.get_latest_ask === 'function') {
        return await client.get_latest_ask(targetDid);
      }
    } catch {}

    return null;
  }
}

