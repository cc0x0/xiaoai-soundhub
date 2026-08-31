import { Router, Response } from 'express';
import { AppDatabase } from '../db/index.js';
import { AuthRequest } from './auth.js';

export function createAdminRouter(db: AppDatabase): Router {
  const router = Router();

  // 1. 系统运行大屏概览
  router.get('/overview', (req: AuthRequest, res: Response) => {
    const users = db.listAllUsers();
    const accounts = db.getAllMiAccounts();
    const settings = db.getAllSystemSettings();

    const proUsers = users.filter((u) => u.plan === 'pro' || u.plan === 'lifetime').length;

    res.json({
      ok: true,
      data: {
        totalUsers: users.length,
        proUsers,
        totalBoundMiAccounts: accounts.length,
        systemSettingsCount: settings.length,
        allowRegistration: db.getSystemSetting('allow_registration', 'true') === 'true',
        notice: db.getSystemSetting('system_notice', ''),
      },
    });
  });

  // 2. 租户用户列表
  router.get('/users', (req: AuthRequest, res: Response) => {
    const users = db.listAllUsers();
    res.json({ ok: true, data: users });
  });

  // 3. 管理员手动授予/调整用户套餐权益
  router.post('/users/plan', (req: AuthRequest, res: Response) => {
    const { userId, plan, durationDays, maxDevices } = req.body;
    if (!userId || !plan) {
      res.status(400).json({ ok: false, error: 'userId and plan are required' });
      return;
    }

    let expiresAt: number | null = null;
    if (plan === 'pro') {
      const days = Number(durationDays) || 365;
      expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    } else if (plan === 'lifetime') {
      expiresAt = null;
    } else {
      expiresAt = null;
    }

    const devices = Number(maxDevices) || (plan === 'free' ? 3 : 10);
    db.updateUserPlan(userId, plan, expiresAt, devices);

    res.json({
      ok: true,
      msg: `用户套餐已更新为: ${plan.toUpperCase()}`,
      data: { userId, plan, expiresAt, maxDevices: devices },
    });
  });

  // 4. 获取全局系统设置
  router.get('/settings', (req: AuthRequest, res: Response) => {
    const list = db.getAllSystemSettings();
    res.json({ ok: true, data: list });
  });

  // 5. 在线热更新系统设置
  router.post('/settings', (req: AuthRequest, res: Response) => {
    const { settings } = req.body; // array of { key, value }
    if (!Array.isArray(settings)) {
      res.status(400).json({ ok: false, error: 'settings must be an array' });
      return;
    }

    for (const item of settings) {
      if (item.key && item.value !== undefined) {
        db.updateSystemSetting(item.key, String(item.value));
      }
    }

    res.json({ ok: true, msg: '系统全局参数已热更新' });
  });

  return router;
}
