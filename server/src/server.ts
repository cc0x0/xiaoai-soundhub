/**
 * XiaoAi SoundHub - SaaS 多租户云平台架构主入口
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
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

async function bootstrap() {
  const port = Number(process.env.SERVER_PORT || process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
  const securitySalt = process.env.SECURITY_SALT || process.env.ACCESS_PASSWORD || 'SoundHub_Secure_Master_Key_2026';
  const jwtSecret = process.env.JWT_SECRET || securitySalt;

  console.log(`[XiaoAi SoundHub] 正在启动 SaaS 多租户云服务... (端口: ${port})`);

  // 1. 初始化 SQLite 多租户数据库
  const db = new AppDatabase();

  // 2. 自动迁移兼容：若 .env 中存有旧版个人账号，自动同步至 admin 账号
  const legacyUserId = process.env.XIAOI_USER_ID || process.env.MI_USER_ID;
  const legacyPassToken = process.env.XIAOI_PASS_TOKEN || process.env.MI_PASS_TOKEN;
  if (legacyUserId && legacyPassToken && legacyUserId !== '你的小米ID') {
    const adminAcc = db.getMiAccount('admin_root_001');
    if (!adminAcc) {
      console.log('[Database] 🔄 自动迁移 .env 中的小米账号至超级管理员租户...');
      const enc = SecurityCrypto.encrypt(legacyPassToken, securitySalt);
      db.saveMiAccount('admin_root_001', legacyUserId, enc, '管理员音箱');
    }
  }

  // 3. 初始化音乐引擎与播放调度器
  const sourcesDir = path.resolve(__dirname, '..', 'sources');
  const sourceEngine = new SourceEngine(sourcesDir, process.env.ACTIVE_SOURCE || 'my-custom-source.js');
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

  // 公共音乐搜索接口
  app.get('/api/search', async (req: Request, res: Response) => {
    try {
      const keyword = (req.query.keyword as string || '').trim();
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const source = (req.query.source as string) || db.getSystemSetting('default_platform', 'kw');

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

      const results = await client.ttsMulti(text, targetDids, {
        chime: enableChime ? chimeType : false,
        publicBaseUrl,
      });

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

      for (const targetDid of targetDids) {
        if (playlist && Array.isArray(playlist)) {
          await scheduler.playMusicList(targetDid, playlist, index || 0);
        } else if (music) {
          await scheduler.playSingle(targetDid, music);
        }
      }

      res.json({ ok: true, msg: '🎵 歌曲已成功投播至小爱音箱' });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 播放控制接口
  app.post('/api/control', async (req: Request, res: Response) => {
    try {
      const { action, did, music, playlist, index, volume, text, speed } = req.body;
      const targetDid = did || process.env.XIAOI_DEFAULT_DID || '';

      switch (action) {
        case 'play_list':
          if (!Array.isArray(playlist) || playlist.length === 0) {
            res.status(400).json({ ok: false, error: 'playlist must be a non-empty array' });
            return;
          }
          await scheduler.playMusicList(targetDid, playlist, index || 0);
          res.json({ ok: true, msg: '播放列表已下发' });
          break;

        case 'play_music':
          if (!music) {
            res.status(400).json({ ok: false, error: 'music object is required' });
            return;
          }
          await scheduler.playMusicList(targetDid, [music], 0);
          res.json({ ok: true, msg: `正在为音箱播放: ${music.singer} - ${music.name}` });
          break;

        case 'pause':
          await scheduler.pause(targetDid);
          res.json({ ok: true, msg: '已暂停播放' });
          break;

        case 'resume':
          await scheduler.resume(targetDid);
          res.json({ ok: true, msg: '已恢复播放' });
          break;

        case 'stop':
          await scheduler.stop(targetDid);
          res.json({ ok: true, msg: '已停止播放并清空定时器' });
          break;

        case 'next':
          await scheduler.next(targetDid);
          res.json({ ok: true, msg: '已切下一首' });
          break;

        case 'prev':
          await scheduler.prev(targetDid);
          res.json({ ok: true, msg: '已切上一首' });
          break;

        case 'volume':
          if (volume === undefined) {
            res.status(400).json({ ok: false, error: 'volume is required' });
            return;
          }
          await fallbackClient.setVolume(Number(volume), { did: targetDid });
          res.json({ ok: true, msg: `音量已调整为 ${volume}%` });
          break;

        case 'tts':
          if (!text) {
            res.status(400).json({ ok: false, error: 'text is required' });
            return;
          }
          await fallbackClient.tts(text, { did: targetDid, chime: true, publicBaseUrl });
          res.json({ ok: true, msg: '语音已插播' });
          break;

        default:
          res.status(400).json({ ok: false, error: `不支持的控制动作: ${action}` });
      }
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 设备状态查询
  app.get('/api/status', (req: Request, res: Response) => {
    const states = scheduler.getAllStates();
    res.json({ ok: true, data: { states, timestamp: Date.now() } });
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

bootstrap().catch((err) => {
  console.error('[Server] 启动失败:', err);
  process.exit(1);
});
