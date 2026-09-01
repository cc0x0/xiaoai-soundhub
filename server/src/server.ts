/**
 * XiaoAi SoundHub - SaaS 多租户云平台架构主入口
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { AppDatabase } from './db/index.js';
import { SecurityCrypto } from './security/crypto.js';
import { SourceEngine } from './source_engine/sandbox.js';
import { StreamProxy } from './proxy/stream.js';
import { PlayScheduler } from './scheduler/queue.js';
import { MultiTenantSpeakerManager } from './speaker/multi_tenant_manager.js';
import { XiaoAiClient } from './speaker/client.js';
import { createAuthRouter, authMiddleware, adminOnlyMiddleware } from './routes/auth.js';
import { createUserRouter } from './routes/user.js';
import { createAdminRouter } from './routes/admin.js';
import { createPaymentRouter } from './routes/payment.js';
import { AGGREGATE_SOURCE, PLATFORM_IDS, PLATFORM_NAMES } from './source_engine/platforms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 全局未捕获异常防御机制
process.on('uncaughtException', (err) => {
  console.warn('[Server] 捕获未处理异常（已安全保护）:', err.message);
});
process.on('unhandledRejection', (reason: any) => {
  const msg = String(reason?.message || reason || '');
  if (reason?.name === 'AggregateError' || msg.includes('AggregateError') || msg.includes('FAILED')) {
    return;
  }
  console.warn('[Server] 捕获未处理 Promise Rejection（已安全保护）:', reason);
});

export async function bootstrap() {
  const port = Number(process.env.SERVER_PORT || process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
  const securitySalt = process.env.SECURITY_SALT || process.env.ACCESS_PASSWORD || 'SoundHub_Secure_Master_Key_2026';
  const jwtSecret = process.env.JWT_SECRET || securitySalt;

  console.log(`[XiaoAi SoundHub] 正在启动 SaaS 多租户云服务... (端口: ${port})`);

  // 1. 初始化 SQLite 多租户数据库
  const db = new AppDatabase();

  // 2. 自动迁移兼容：若 .env 中存有旧版个人账号，且全站没有任何租户绑定过此账号，才初始化 admin 占位
  const legacyUserId = process.env.XIAOI_USER_ID || process.env.MI_USER_ID;
  const legacyPassToken = process.env.XIAOI_PASS_TOKEN || process.env.MI_PASS_TOKEN;
  if (legacyUserId && legacyPassToken && legacyUserId !== '你的小米ID') {
    const existingBinding = db.findMiAccountByXiaomiId(legacyUserId);
    if (!existingBinding) {
      console.log('[Database] 🔄 自动迁移 .env 中的小米账号至超级管理员租户...');
      const enc = SecurityCrypto.encrypt(legacyPassToken, securitySalt);
      db.saveMiAccount('admin_root_001', legacyUserId, enc, '管理员音箱');
    }
  }

  // 3. 初始化音乐引擎与播放调度器 (从数据库持久化配置中读取当前生效音源插件)
  const sourcesDir = path.resolve(__dirname, '..', 'sources');
  const initialSource = db.getSystemSetting('active_source', process.env.ACTIVE_SOURCE || 'my-custom-source.js');
  const sourceEngine = new SourceEngine(sourcesDir, initialSource);
  await sourceEngine.loadSource();

  // 兜底虚拟 client 供全局单例调度使用
  const fallbackClient = new XiaoAiClient({
    userId: legacyUserId || '',
    passToken: legacyPassToken || '',
    defaultDid: process.env.XIAOI_DEFAULT_DID || '',
  });

  const scheduler = new PlayScheduler(sourceEngine, fallbackClient, publicBaseUrl, db);
  const speakerManager = new MultiTenantSpeakerManager(db, securitySalt, scheduler, sourceEngine);

  // 自动为超级管理员租户初始化并拉取音箱设备
  const adminAcc = db.getMiAccount('admin_root_001');
  if (adminAcc) {
    speakerManager.getClient('admin_root_001').then(async (client: any) => {
      if (client) {
        const devs = await client.listDevices();
        console.log(`[Database] 🚀 自动为超级管理员同步了 ${devs.length} 台小爱音箱`);
      }
    }).catch((err: any) => {
      console.warn('[Database] 自动拉取管理员音箱失败:', err.message);
    });
  }

  // 4. 启动所有租户的语音监听池
  if (process.env.ENABLE_LISTENER !== 'false') {
    speakerManager.startAllActiveListeners().catch(() => {});
  }

  // 5. 创建 Express Web 路由
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 静态资源托管
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // 流媒体中继代理
  app.get('/proxy/stream', (req: Request, res: Response) => {
    StreamProxy.handleProxy(req, res);
  });

  // REST API 模块挂载
  app.use('/api/auth', createAuthRouter(db, jwtSecret));
  app.use('/api/user', authMiddleware(jwtSecret), createUserRouter(db, speakerManager, securitySalt, sourceEngine, scheduler));
  app.use('/api/admin', authMiddleware(jwtSecret), adminOnlyMiddleware, createAdminRouter(db, sourceEngine, speakerManager));
  app.use('/api/payment', createPaymentRouter(db));

  // 兼容旧版客户端接口: /api/devices
  app.get('/api/devices', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const payload = SecurityCrypto.verifyToken<{ id: string }>(token, jwtSecret);
        if (payload?.id) {
          const speakers = db.getSpeakers(payload.id);
          res.json({ ok: true, data: speakers });
          return;
        }
      }
      const adminSpeakers = db.getSpeakers('admin_root_001');
      res.json({ ok: true, data: adminSpeakers });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Resolve the tenant id from a Bearer token, or null when anonymous. */
  const resolveUserId = (req: Request): string | null => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const payload = SecurityCrypto.verifyToken<{ id: string }>(authHeader.split(' ')[1], jwtSecret);
    return payload?.id || null;
  };

  /**
   * Decide which source a request should search.
   * Priority: explicit query param > tenant setting > global default.
   */
  const resolveSearchSource = (req: Request): string => {
    const explicit = String(req.query.source || '').trim();
    if (explicit) return explicit;

    const userId = resolveUserId(req);
    if (userId) {
      const settings = db.getUserSettings(userId);
      if (settings?.search_platform) return settings.search_platform;
    }
    return db.getSystemSetting('default_platform', AGGREGATE_SOURCE);
  };

  // 支持的音源渠道清单 (供前端渲染音源选择器)
  app.get('/api/sources', (req: Request, res: Response) => {
    const platforms = PLATFORM_IDS.map((id) => ({ id, name: PLATFORM_NAMES[id] }));
    res.json({
      ok: true,
      data: {
        aggregate: { id: AGGREGATE_SOURCE, name: PLATFORM_NAMES[AGGREGATE_SOURCE] },
        platforms,
        current: resolveSearchSource(req),
        activeScript: sourceEngine.getActiveSource(),
        scriptPlatforms: sourceEngine.getScriptPlatforms(),
      },
    });
  });

  // 公共音乐搜索接口 (source 支持 all 聚合 或 单一平台 wy/tx/kw/kg/mg)
  app.get('/api/search', async (req: Request, res: Response) => {
    try {
      const keyword = (req.query.keyword as string || '').trim();
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const source = resolveSearchSource(req);

      if (!keyword) {
        res.status(400).json({ ok: false, error: 'keyword is required' });
        return;
      }

      const result = await sourceEngine.search(keyword, page, limit, source);
      res.json({ ok: true, data: result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 语音播报广播接口 (支持 JWT 租户鉴权与多音箱并发)
  app.post('/api/tts', async (req: Request, res: Response) => {
    try {
      const { text, dids, did, chime } = req.body;
      if (!text) {
        res.status(400).json({ ok: false, error: 'text is required' });
        return;
      }

      let client = fallbackClient;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const payload = SecurityCrypto.verifyToken<{ id: string }>(token, jwtSecret);
        if (payload?.id) {
          const userClient = await speakerManager.getClient(payload.id);
          if (userClient) client = userClient;
        }
      }

      const targetDids = Array.isArray(dids) ? dids : (did ? [did] : (dids ? [dids] : []));
      const chimeType = chime !== undefined ? chime : 'dingdong';
      const enableChime = chimeType !== 'none';

      const playingDids = targetDids.filter((d: string) => !!scheduler.getCurrentState(d));

      const results = await client.ttsMulti(text, targetDids, {
        chime: enableChime ? chimeType : false,
        publicBaseUrl,
      });

      // 播报结束后自动断点续播音乐
      if (playingDids.length > 0) {
        const chimeDelayMs = enableChime ? (Number(db.getSystemSetting('chime_delay_ms', '1400')) || 1400) : 0;
        const textDurationMs = Math.max(1500, Math.ceil(text.length * 280));
        const resumeDelayMs = chimeDelayMs + textDurationMs + 1000;
        console.log(`[TTS] 检测到 ${playingDids.length} 台音箱正在播放，将在播报完毕后 (${resumeDelayMs}ms) 自动恢复音乐播放...`);
        setTimeout(() => {
          for (const pdid of playingDids) {
            scheduler.resume(pdid, client).catch(() => {});
          }
        }, resumeDelayMs);
      }

      res.json({ ok: true, msg: '📢 语音播报指令已成功下发', results });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 投播歌曲 / 歌单接口
  app.post('/api/play', async (req: Request, res: Response) => {
    try {
      const { music, dids, did, playlist, index } = req.body;
      const targetDids = Array.isArray(dids) ? dids : (did ? [did] : []);
      if (targetDids.length === 0) {
        res.status(400).json({ ok: false, error: '请指定至少一台目标音箱 did' });
        return;
      }

      let client = fallbackClient;
      let quality = '320k';
      const userId = resolveUserId(req);
      if (userId) {
        const userClient = await speakerManager.getClient(userId);
        if (userClient) client = userClient;
        quality = db.getUserSettings(userId)?.preferred_quality || '320k';
      }

      for (const targetDid of targetDids) {
        if (playlist && Array.isArray(playlist)) {
          await scheduler.playMusicList(targetDid, playlist, index || 0, client, quality);
        } else if (music) {
          await scheduler.playSingle(targetDid, music, client, quality);
        }
      }

      res.json({ ok: true, msg: '🎵 歌曲已成功投播至小爱音箱' });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 播放控制接口 (全屋/单设备 暂停/继续/切歌/停止)
  app.post('/api/control', async (req: Request, res: Response) => {
    try {
      const { action, did, dids, music, playlist, index, volume, text } = req.body;

      let client = fallbackClient;
      let quality = '320k';
      const userId = resolveUserId(req);
      if (userId) {
        const userClient = await speakerManager.getClient(userId);
        if (userClient) client = userClient;
        quality = db.getUserSettings(userId)?.preferred_quality || '320k';
      }

      // 智能解析目标音箱：支持 dids 数组、单个 did，或正在播放的活跃音箱
      let targetDids: string[] = [];
      if (Array.isArray(dids) && dids.length > 0) {
        targetDids = dids;
      } else if (did) {
        targetDids = [did];
      } else {
        targetDids = Object.keys(scheduler.getAllStates());
        if (targetDids.length === 0 && process.env.XIAOI_DEFAULT_DID) {
          targetDids = [process.env.XIAOI_DEFAULT_DID];
        }
      }

      if (targetDids.length === 0) {
        res.status(400).json({ ok: false, error: '未指定目标音箱 did 且当前无正在播放的音箱' });
        return;
      }

      for (const targetDid of targetDids) {
        switch (action) {
          case 'play_list':
            if (Array.isArray(playlist) && playlist.length > 0) {
              await scheduler.playMusicList(targetDid, playlist, index || 0, client, quality);
            }
            break;

          case 'play_music':
            if (music) {
              await scheduler.playMusicList(targetDid, [music], 0, client, quality);
            }
            break;

          case 'pause':
            await scheduler.pause(targetDid, client);
            break;

          case 'resume':
            await scheduler.resume(targetDid, client);
            break;

          case 'stop':
            await scheduler.stop(targetDid, client);
            break;

          case 'next':
            await scheduler.next(targetDid, client);
            break;

          case 'prev':
            await scheduler.prev(targetDid, client);
            break;

          case 'volume':
            if (volume !== undefined) {
              await client.setVolume(Number(volume), { did: targetDid });
            }
            break;

          case 'tts':
            if (text) {
              await client.tts(text, { did: targetDid, chime: true, publicBaseUrl });
            }
            break;
        }
      }

      res.json({ ok: true, msg: '播放控制指令已成功执行' });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 设备状态查询 (全屋音箱独立播放队列状态)
  app.get('/api/status', (req: Request, res: Response) => {
    const states = scheduler.getAllStates();
    res.json({
      ok: true,
      data: {
        states,
        activeQueues: states,
        activeSource: sourceEngine.getActiveSource(),
        timestamp: Date.now(),
      },
    });
  });

  // 页面重定向路由
  app.get('/app', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('/admin', (_req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
  app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));

  // 启动 HTTP 服务
  app.listen(port, host, () => {
    console.log(`
======================================================
🚀 XiaoAi SoundHub SaaS 多租户云平台已就绪!
🌐 用户控制台: ${publicBaseUrl}/app
🛠️ 超级管理后台: ${publicBaseUrl}/admin
🔑 用户登录/注册: ${publicBaseUrl}/login
🔌 REST API: ${publicBaseUrl}/api
======================================================
    `);
  });
}

bootstrap().catch((err: unknown) => {
  console.error('[Server] 启动失败:', err);
  process.exit(1);
});
