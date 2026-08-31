import { Router, Response } from 'express';
import { AppDatabase } from '../db/index.js';
import { AuthRequest } from './auth.js';
import { SourceEngine } from '../source_engine/sandbox.js';
import { MultiTenantSpeakerManager } from '../speaker/multi_tenant_manager.js';
import fs from 'fs';
import path from 'path';

export function createAdminRouter(
  db: AppDatabase,
  sourceEngine?: SourceEngine,
  speakerManager?: MultiTenantSpeakerManager
): Router {
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

  // 4. 获取全局可用音源插件列表 (扫描 sources/ 目录)
  router.get('/sources', (req: AuthRequest, res: Response) => {
    try {
      const sourcesDir = path.resolve(process.cwd(), 'sources');
      if (!fs.existsSync(sourcesDir)) {
        res.json({ ok: true, data: ['my-custom-source.js'] });
        return;
      }
      const files = fs.readdirSync(sourcesDir).filter((f) => f.endsWith('.js'));
      res.json({ ok: true, data: files });
    } catch {
      res.json({ ok: true, data: ['my-custom-source.js'] });
    }
  });

  // 5. 获取全局系统设置
  router.get('/settings', (req: AuthRequest, res: Response) => {
    const list = db.getAllSystemSettings();
    res.json({ ok: true, data: list });
  });

  // 6. 在线热更新系统设置 (即时触发音源重载与监听池启停)
  router.post('/settings', async (req: AuthRequest, res: Response) => {
    const { settings } = req.body; // array of { key, value }
    if (!Array.isArray(settings)) {
      res.status(400).json({ ok: false, error: 'settings must be an array' });
      return;
    }

    let newActiveSource = '';
    let newEnableListener = '';

    for (const item of settings) {
      if (item.key && item.value !== undefined) {
        db.updateSystemSetting(item.key, String(item.value));
        if (item.key === 'active_source') newActiveSource = String(item.value);
        if (item.key === 'enable_listener') newEnableListener = String(item.value);
      }
    }

    // 1. 若音源发生变更，即刻热加载新音源
    if (newActiveSource && sourceEngine) {
      try {
        await sourceEngine.loadSource(newActiveSource);
        console.log(`[Admin] 🎵 全局音源已热切换为: ${newActiveSource}`);
      } catch (e: any) {
        console.error('[Admin] 音源热切换失败:', e.message);
      }
    }

    // 2. 若语音监听开关发生变更，即刻启停监听池
    if (newEnableListener && speakerManager) {
      if (newEnableListener === 'false') {
        speakerManager.stopAllListeners();
        console.log('[Admin] 🔇 全局语音监听已暂停');
      } else {
        speakerManager.startAllActiveListeners().catch(() => {});
        console.log('[Admin] 📢 全局语音监听已恢复运行');
      }
    }

    const currentActiveSource = sourceEngine ? sourceEngine.getActiveSource() : newActiveSource;
    res.json({
      ok: true,
      msg: `系统参数已热更新！当前全局生效音源: ${currentActiveSource}`,
      data: { activeSource: currentActiveSource }
    });
  });

  return router;
}
