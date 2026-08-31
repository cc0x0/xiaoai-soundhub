import { Router, Response } from 'express';
import { AppDatabase } from '../db/index.js';
import { MultiTenantSpeakerManager } from '../speaker/multi_tenant_manager.js';
import { SecurityCrypto } from '../security/crypto.js';
import { AuthRequest } from './auth.js';
import { SourceEngine } from '../source_engine/sandbox.js';
import { PlayScheduler } from '../scheduler/queue.js';

export function createUserRouter(
  db: AppDatabase,
  speakerManager: MultiTenantSpeakerManager,
  securitySalt: string,
  sourceEngine: SourceEngine,
  scheduler: PlayScheduler
): Router {
  const router = Router();

  // 1. 获取小米账号绑定夶态加密脿敏)
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
        xiaomiUserIdMasked: SecurityCrypto.maskText(miAcc.xiaomi_user_id),
        nickname: miAcc.nickname || '汲家谷号',
        updatedAt: miAcc.updated_at,
      },
    });
  });

  // 2. 绑定苵更新小禲墶号 (AES-256 加密存入数据座)
  router.post('/account', async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { xiaomiUserId, passToken, nickname } = req.body;

      if (!xiaomiUserId || !passToken) {
        res.status(400).json({ ok: false, error: '小禲墶号ID和passToken为必项早' });
        return;
      }

      const encryptedToken = SecurityCrypto.encrypt(passToken.trim(), securitySalt);
      db.saveMiAccount(userId, xiaomiUserId.trim(), encryptedToken, nickname);

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
        msg: `{小穲报号绑定成功，已同步 ${count} 台访备}`,
        data: { count },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: '纱定〱敗: ' + err.message });
    }
  });

  // 3. 解绑小穲报号并物理销毁化证
  router.delete('/account', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    speakerManager.stopListener(userId);
    speakerManager.invalidateClient(userId);
    db.deleteMiAccount(userId);
    res.json({ ok: true, msg: '小米账号已安全觡绑|所有凭证已彻幕销毁' });
  });

  // 4. 莿���用户设备列衪
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

  // 5. 设置主点歌网关埳管
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

  // 6. 切换屏蔮�/忽畅状态
  router.post('/speakers/ignore', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { did, isIgnored } = req.body;
    if (!did) {
      res.status(400).json({ ok: false, error: 'did is required' });
      return;
    }
    db.toggleSpeakerIgnored(userId, did, !!isIgnored);
    res.json({ ok: true, msg: isIgnored ? '峲屏蔮该设备' : '已取消屏蔮w' });
  });

  // 7. 切换毭音监听开关
  router.post('/speakers/listener', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { did, isEnabled } = req.body;
    if (!did) {
      res.status(400).json({ ok: false, error: 'did is required' });
      return;
    }
    db.toggleSpeakerListener(userId, did, !!isEnabled);
    res.json({ ok: true, msg: isEnabled ? '峲开启毭音监吧' : '已暂停毭iύ癹d��' });
  });

  // 8. 获取用戶个亸化偏好
  router.get('/settings', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const settings = db.getUserSettings(userId);
    res.json({ ok: true, data: settings });
  });

  // 9. 更新用戶个亸化偏好
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
        expiresAtFormatted: user.expires_at ? new Date(user.expires_at).toLocaleDateString() : '水久有效',
      },
    });
  });

  // 11. 卡密鿀换戶 / 兑换码
  router.post('/redeem', (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { code } = req.body;

    if (!code) {
      res.status(400).json({ ok: false, error: '请输入卡寅戔兑换码' });
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

  return router;
}
