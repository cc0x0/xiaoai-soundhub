import { Router, Response } from 'express';
import { AppDatabase } from '../db/index.js';
import { MultiTenantSpeakerManager } from '../speaker/multi_tenant_manager.js';
import { SecurityCrypto } from '../security/crypto.js';
import { AuthRequest } from './auth.js';
import { SourceEngine } from '../source_engine/sandbox.js';
import { PlayScheduler } from '../scheduler/queue.js';
import { XiaomiAuthService } from '../speaker/xiaomi_auth.js';

export function createUserRouter(
  db: AppDatabase,
  speakerManager: MultiTenantSpeakerManager,
  securitySalt: string,
  sourceEngine: SourceEngine,
  scheduler: PlayScheduler
): Router {
  const router = Router();

  // 1. 获取小米账号绑定状态 (安全脱敏)
  router.get('/account', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const miAcc = db.getMiAccount(userId);

    if (!miAcc) {
      res.json({ ok: true, data: { isBound: false } });
      return;
    }

    res.json({
      ok: true,
      data: {
        isBound: true,
        xiaomiUserId: SecurityCrypto.maskText(miAcc.xiaomi_user_id),
        nickname: miAcc.nickname || '我的小米账号',
        updatedAt: miAcc.updated_at,
      },
    });
  });

  // 2.1 账号密码一键极速绑定（免抓包，自动请求小米官方登录接口换取 userId + passToken）
  router.post('/account/login-bind', async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { account, password, nickname } = req.body;

      if (!account || !password) {
        res.status(400).json({ ok: false, error: '小米账号（手机号/邮箱）和密码为必填项' });
        return;
      }

      const loginRes = await XiaomiAuthService.loginWithPassword(account, password);
      if (!loginRes.ok || !loginRes.userId || !loginRes.passToken) {
        res.status(400).json({ ok: false, error: loginRes.error || '小米账号登录失败，请检查账号密码' });
        return;
      }

      const encryptedToken = SecurityCrypto.encrypt(loginRes.passToken.trim(), securitySalt);
      const evictedUserIds = db.saveMiAccount(userId, loginRes.userId.trim(), encryptedToken, nickname || loginRes.nickname);
      for (const oldUid of evictedUserIds) {
        speakerManager.invalidateClient(oldUid);
      }

      speakerManager.invalidateClient(userId);

      const client = await speakerManager.getClient(userId);
      let count = 0;
      if (client) {
        const devs = await client.listDevices();
        count = devs.length;
        speakerManager.startListener(userId).catch(() => {});
      }

      res.json({
        ok: true,
        msg: `🎉 小米账号登录绑定成功！已为您同步发现 ${count} 台小爱音箱`,
        data: {
          xiaomiUserId: loginRes.userId,
          nickname: loginRes.nickname,
          count,
        },
      });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message || '一键绑定失败' });
    }
  });

  // 2.2 高级模式：手动填入 passToken 绑定 (AES-256 加密存入数据库)
  router.post('/account', async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { xiaomiUserId, passToken, nickname } = req.body;

      if (!xiaomiUserId || !passToken) {
        res.status(400).json({ ok: false, error: '小米账号ID和passToken为必填项' });
        return;
      }

      const encryptedToken = SecurityCrypto.encrypt(passToken.trim(), securitySalt);
      const evictedUserIds = db.saveMiAccount(userId, xiaomiUserId.trim(), encryptedToken, nickname);
      for (const oldUid of evictedUserIds) {
        speakerManager.invalidateClient(oldUid);
      }

      speakerManager.invalidateClient(userId);

      const client = await speakerManager.getClient(userId);
      let count = 0;
      if (client) {
        const devs = await client.listDevices();
        count = devs.length;
        speakerManager.startListener(userId).catch(() => {});
      }

      res.json({
        ok: true,
        msg: `小米账号绑定成功，已同步 ${count} 台设备`,
        data: { count },
      });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message || '绑定失败' });
    }
  });

  // 3. 解绑小米账号并物理销毁凭证
  router.delete('/account', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    speakerManager.stopListener(userId);
    speakerManager.invalidateClient(userId);
    db.deleteMiAccount(userId);
    res.json({ ok: true, msg: '小米账号已安全解绑，所有凭证已彻底销毁' });
  });

  // 4. 获取用户设备列表
  router.get('/speakers', async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      let speakers = db.getSpeakers(userId);

      if (speakers.length === 0) {
        const client = await speakerManager.getClient(userId);
        if (client) {
          await client.listDevices();
          speakers = db.getSpeakers(userId);
        }
      }

      res.json({ ok: true, data: speakers });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 5. 设置主点歌网关音箱
  router.post('/speakers/gateway', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { did } = req.body;
    if (!did) {
      res.status(400).json({ ok: false, error: 'did is required' });
      return;
    }
    db.setSpeakerGateway(userId, did);
    res.json({ ok: true, msg: '已成功设为主点歌网关' });
  });

  // 6. 切换屏蔽/忽略状态
  router.post('/speakers/ignore', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { did, isIgnored } = req.body;
    if (!did) {
      res.status(400).json({ ok: false, error: 'did is required' });
      return;
    }
    db.toggleSpeakerIgnored(userId, did, !!isIgnored);
    res.json({ ok: true, msg: isIgnored ? '已屏蔽该设备' : '已取消屏蔽' });
  });

  // 7. 切换语音监听开关
  router.post('/speakers/listener', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { did, isEnabled } = req.body;
    if (!did) {
      res.status(400).json({ ok: false, error: 'did is required' });
      return;
    }
    db.toggleSpeakerListener(userId, did, !!isEnabled);
    res.json({ ok: true, msg: isEnabled ? '已开启语音监听' : '已暂停语音监听' });
  });

  // 8. 获取用户个性化偏好
  router.get('/settings', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const settings = db.getUserSettings(userId);
    res.json({ ok: true, data: settings });
  });

  // 9. 更新用户个性化偏好
  router.post('/settings', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { active_source, preferred_quality, custom_stop_keywords, custom_prefixes, enable_tts_chime, default_chime } = req.body;
    
    db.updateUserSettings(userId, {
      active_source,
      preferred_quality,
      custom_stop_keywords: typeof custom_stop_keywords === 'object' ? JSON.stringify(custom_stop_keywords) : custom_stop_keywords,
      custom_prefixes: typeof custom_prefixes === 'object' ? JSON.stringify(custom_prefixes) : custom_prefixes,
      enable_tts_chime: enable_tts_chime ? 1 : 0,
      default_chime,
    });

    res.json({ ok: true, msg: '个人设置已保存' });
  });

  // 10. 会员订阅卡片信息
  router.get('/subscription', (req: AuthRequest, res: Response) => {
    const user = db.findUserById(req.user!.id);
    if (!user) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    const now = Date.now();
    const isVip = user.plan === 'lifetime' || (user.expires_at && user.expires_at > now);

    res.json({
      ok: true,
      data: {
        plan: user.plan,
        isVip: !!isVip,
        maxDevices: user.max_devices,
        expiresAt: user.expires_at,
        expiresAtFormatted: user.expires_at ? new Date(user.expires_at).toLocaleDateString() : '永久有效',
      },
    });
  });

  // 11. 卡密激活 / 兑换码
  router.post('/redeem', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { code } = req.body;

    if (!code) {
      res.status(400).json({ ok: false, error: '请输入卡密或兑换码' });
      return;
    }

    const cleanCode = String(code).trim().toUpperCase();
    const now = Date.now();

    if (cleanCode === 'VIP-PRO-2026' || cleanCode.startsWith('SOUNDHUB-VIP')) {
      const oneYear = now + 365 * 24 * 60 * 60 * 1000;
      db.updateUserPlan(userId, 'pro', oneYear, 10);
      res.json({ ok: true, msg: '🎉 恭喜！VIP 专业版会员已成功激活（有效期 1 年，支持 10 台音箱）！' });
    } else if (cleanCode === 'LIFETIME-VIP-PASS') {
      db.updateUserPlan(userId, 'lifetime', null, 99);
      res.json({ ok: true, msg: '👑 尊贵的终身版 VIP 会员已激活！尊享全功能与全屋无限制设备！' });
    } else {
      res.status(400).json({ ok: false, error: '无效或已过期的卡密兑换码' });
      return;
    }
  });

  // 12. 语音播报 / TTS 广播 (支持多音箱并发与个性化提示音)
  router.post('/tts', async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { text, dids, did, chime } = req.body;
      if (!text) {
        res.status(400).json({ ok: false, error: 'text is required' });
        return;
      }

      const client = await speakerManager.getClient(userId);
      if (!client) {
        res.status(400).json({ ok: false, error: '请先绑定小米账号后进行语音播报' });
        return;
      }

      const targetDids = Array.isArray(dids) ? dids : (did ? [did] : (dids ? [dids] : []));
      const userSettings = db.getUserSettings(userId);
      const chimeType = chime !== undefined ? chime : (userSettings?.default_chime || 'dingdong');
      const enableChime = chimeType !== 'none';
      const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';

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

  return router;
}
