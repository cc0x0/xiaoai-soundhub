/**
 * XiaoAi SoundHub - RESTful API & Web Server 主入口
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { AppConfig, ApiResponse } from './types/index.js';
import { XiaoAiClient } from './speaker/client.js';
import { SourceEngine } from './source_engine/sandbox.js';
import { StreamProxy } from './proxy/stream.js';
import { PlayScheduler } from './scheduler/queue.js';
import { ConversationListener } from './listener/conversation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. 加载配置
function loadConfig(): AppConfig {
  const configPath = path.join(__dirname, '..', 'config.json');
  const examplePath = path.join(__dirname, '..', 'config.example.json');

  let rawConfig: any = {};
  try {
    if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
      rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else if (fs.existsSync(examplePath) && fs.statSync(examplePath).isFile()) {
      rawConfig = JSON.parse(fs.readFileSync(examplePath, 'utf-8'));
    }
  } catch (e) {
    console.warn('[Config] 配置文件读取跳过，将使用环境变量配置:', (e as Error).message);
  }

  // 环境变量覆盖
  return {
    server: {
      port: Number(process.env.PORT || process.env.XIAOI_PORT || rawConfig.server?.port || 8080),
      host: process.env.HOST || rawConfig.server?.host || '0.0.0.0',
      token: process.env.XIAOI_TOKEN || rawConfig.server?.token || '',
      publicBaseUrl: process.env.PUBLIC_BASE_URL || rawConfig.server?.publicBaseUrl || `http://localhost:${rawConfig.server?.port || 8080}`,
    },
    speaker: {
      userId: process.env.XIAOI_USER_ID || process.env.MI_USER_ID || rawConfig.speaker?.userId || '',
      passToken: process.env.XIAOI_PASS_TOKEN || process.env.MI_PASS_TOKEN || rawConfig.speaker?.passToken || '',
      password: process.env.XIAOI_PASSWORD || rawConfig.speaker?.password || '',
      did: process.env.XIAOI_DID || rawConfig.speaker?.did || '',
      defaultDid: process.env.XIAOI_DEFAULT_DID || rawConfig.speaker?.defaultDid || '',
      ttsMode: (process.env.XIAOI_TTS_MODE as any) || rawConfig.speaker?.ttsMode || 'auto',
      verboseLog: process.env.XIAOI_VERBOSE_LOG === 'true' || !!rawConfig.speaker?.verboseLog,
      ttsFallbackCommand: rawConfig.speaker?.ttsFallbackCommand || [5, 1],
      ttsFallbackCommands: rawConfig.speaker?.ttsFallbackCommands || {},
    },
    listener: {
      enabled: process.env.ENABLE_LISTENER !== 'false' && (rawConfig.listener?.enabled !== false),
      pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || rawConfig.listener?.pollIntervalMs || 1200),
      keywords: rawConfig.listener?.keywords || ['播放', '播放歌曲', '我想听', '放一首'],
      controlKeywords: rawConfig.listener?.controlKeywords || {
        stop: ['停止播放', '别唱了', '闭嘴', '关机'],
        pause: ['暂停', '暂停播放'],
        resume: ['继续播放', '恢复播放'],
        next: ['下一首', '切歌', '换一首'],
        prev: ['上一首'],
      },
    },
    sourceEngine: {
      activeSource: process.env.ACTIVE_SOURCE || rawConfig.sourceEngine?.activeSource || 'my-custom-source.js',
      sourcesDir: path.resolve(__dirname, '..', rawConfig.sourceEngine?.sourcesDir || './sources'),
      defaultQuality: rawConfig.sourceEngine?.defaultQuality || '320k',
      proxyStream: rawConfig.sourceEngine?.proxyStream !== false,
    },
  };
}

async function bootstrap() {
  const config = loadConfig();
  console.log(`[XiaoAi SoundHub] 正在启动服务... (端口: ${config.server.port})`);

  // 2. 初始化核心组件
  const speakerClient = new XiaoAiClient(config.speaker);
  const sourceEngine = new SourceEngine(config.sourceEngine.sourcesDir, config.sourceEngine.activeSource);
  const scheduler = new PlayScheduler(sourceEngine, speakerClient, config.server.publicBaseUrl);
  const listener = new ConversationListener(speakerClient, config.listener.pollIntervalMs);

  // 异步加载音源脚本
  await sourceEngine.loadSource();

  // 3. 配置实体语音指令监听逻辑
  listener.setCommandHandler(async (did, cmd) => {
    console.log(`[Server] 处理来自音箱 [${did}] 的语音指令:`, cmd);
    if (cmd.type === 'play' && cmd.keyword) {
      // 搜歌并自动开播
      const searchRes = await sourceEngine.search(cmd.keyword, 1, 20);
      if (searchRes.list && searchRes.list.length > 0) {
        console.log(`[Server] 语音搜歌成功，即将为音箱 [${did}] 播放首曲: ${searchRes.list[0].singer} - ${searchRes.list[0].name}`);
        await scheduler.playMusicList(did, searchRes.list, 0);
      } else {
        await speakerClient.tts(`抱歉，没有找到 ${cmd.keyword} 的相关歌曲`, { did });
      }
    } else if (cmd.type === 'stop') {
      await scheduler.stop(did);
    } else if (cmd.type === 'pause') {
      await speakerClient.pause({ did });
    } else if (cmd.type === 'resume') {
      // 尝试继续播放
      const current = scheduler.getCurrentState(did);
      if (current) {
        await speakerClient.playAudio(current.streamUrl, { did });
      }
    } else if (cmd.type === 'next') {
      await scheduler.next(did);
    } else if (cmd.type === 'prev') {
      await scheduler.prev(did);
    } else if (cmd.type === 'volume' && cmd.volume !== undefined) {
      await speakerClient.setVolume(cmd.volume, { did });
    }
  });

  // 如果配置了小米账号，启动语音监听
  if (config.speaker.userId && (config.speaker.passToken || config.speaker.password)) {
    try {
      await speakerClient.listDevices();
      console.log(`[Server] 小米账号认证成功，已拉取 ${speakerClient.getCachedDevices().length} 台音箱设备`);
      if (config.listener.enabled) {
        listener.start();
      }
    } catch (err: any) {
      console.warn(`[Server] 首次连接小米账号警告:`, err.message);
    }
  } else {
    console.warn(`[Server] 尚未配置小米账号凭证 (userId / passToken)，请在 config.json 或环境变量中配置`);
  }

  // 4. 构建 Express App
  const app = express();
  app.use(cors());
  app.use(express.json());

  // 静态托管 Web 控制台
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // 认证 Token 中间件 (若配置了 Token)
  app.use((req, res, next) => {
    if (!config.server.token) return next();
    if (req.path.startsWith('/proxy/stream') || req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
      return next();
    }
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-token'] || req.query.token;
    if (token !== config.server.token) {
      res.status(401).json({ ok: false, error: 'Unauthorized: invalid token' });
      return;
    }
    next();
  });

  // --- RESTful API 路由定义 ---

  // 1. 获取音箱列表
  app.get('/api/devices', async (req: Request, res: Response) => {
    try {
      const devices = await speakerClient.listDevices();
      res.json({ ok: true, data: devices } as ApiResponse);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message } as ApiResponse);
    }
  });

  // 2. 发送文本语音 TTS (单选或多选全屋广播)
  app.post('/api/tts', async (req: Request, res: Response) => {
    try {
      const { text, did, dids } = req.body;
      if (!text) {
        res.status(400).json({ ok: false, error: 'text is required' });
        return;
      }

      const targetDids: string[] = dids || (did ? [did] : []);
      const results = await speakerClient.ttsMulti(text, targetDids);
      res.json({ ok: true, data: results } as ApiResponse);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message } as ApiResponse);
    }
  });

  // 3. 全网搜索音乐 (调取云端 LX 音源)
  app.get('/api/search', async (req: Request, res: Response) => {
    try {
      const keyword = req.query.keyword as string;
      const page = Number(req.query.page || 1);
      const limit = Number(req.query.limit || 20);
      const source = (req.query.source as string) || 'kw';

      if (!keyword) {
        res.status(400).json({ ok: false, error: 'keyword is required' });
        return;
      }

      const results = await sourceEngine.search(keyword, page, limit, source);
      res.json({ ok: true, data: results } as ApiResponse);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message } as ApiResponse);
    }
  });

  // 4. 获取音乐播放直链
  app.get('/api/url', async (req: Request, res: Response) => {
    try {
      const songId = req.query.songId as string;
      const songName = req.query.name as string;
      const singer = req.query.singer as string;
      const quality = (req.query.quality as string) || config.sourceEngine.defaultQuality;

      const urlRes = await sourceEngine.getMusicUrl({ id: songId, name: songName, singer }, quality);
      res.json({ ok: true, data: urlRes } as ApiResponse);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message } as ApiResponse);
    }
  });

  // 5. 投播歌曲到指定音箱
  app.post('/api/play', async (req: Request, res: Response) => {
    try {
      const { music, did, dids } = req.body;
      if (!music) {
        res.status(400).json({ ok: false, error: 'music item is required' });
        return;
      }

      const targetDids: string[] = dids || (did ? [did] : []);
      const results: Record<string, boolean> = {};

      for (const targetDid of targetDids) {
        const ok = await scheduler.playSingle(targetDid, music);
        results[targetDid] = ok;
      }

      res.json({ ok: true, data: results } as ApiResponse);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message } as ApiResponse);
    }
  });

  // 6. 播放控制 (暂停/继续/下一首/上一首/音量)
  app.post('/api/control', async (req: Request, res: Response) => {
    try {
      const { action, did, value } = req.body;
      const targetDid = did || config.speaker.defaultDid || '';

      switch (action) {
        case 'pause':
          await speakerClient.pause({ did: targetDid });
          break;
        case 'resume':
          const current = scheduler.getCurrentState(targetDid);
          if (current) {
            await speakerClient.playAudio(current.streamUrl, { did: targetDid });
          }
          break;
        case 'stop':
          await scheduler.stop(targetDid);
          break;
        case 'next':
          await scheduler.next(targetDid);
          break;
        case 'prev':
          await scheduler.prev(targetDid);
          break;
        case 'volume':
          if (typeof value === 'number') {
            await speakerClient.setVolume(value, { did: targetDid });
          }
          break;
        default:
          res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
          return;
      }

      res.json({ ok: true, msg: `Action ${action} executed` } as ApiResponse);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message } as ApiResponse);
    }
  });

  // 7. 音频流中继代理 (Range 支持)
  app.get('/proxy/stream', StreamProxy.handleProxy);

  // 8. 状态监控
  app.get('/api/status', (req: Request, res: Response) => {
    res.json({
      ok: true,
      data: {
        server: 'XiaoAi SoundHub',
        version: '1.0.0',
        activeSource: config.sourceEngine.activeSource,
        devicesCount: speakerClient.getCachedDevices().length,
        listenerRunning: config.listener.enabled,
        currentPlayState: scheduler.getCurrentState(),
      },
    } as ApiResponse);
  });

  // 启动监听
  app.listen(config.server.port, config.server.host, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 XiaoAi SoundHub 服务已就绪!`);
    console.log(`🌐 Web 控制台访问: http://localhost:${config.server.port}`);
    console.log(`🔌 REST API 基础路径: http://localhost:${config.server.port}/api`);
    console.log(`======================================================\n`);
  });
}

bootstrap().catch((err) => {
  console.error('[XiaoAi SoundHub] 启动失败:', err);
  process.exit(1);
});

