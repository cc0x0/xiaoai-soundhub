import { Router, Request, Response, NextFunction } from 'express';
import { AppDatabase } from '../db/index.js';
import { SecurityCrypto } from '../security/crypto.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: 'user' | 'admin';
    plan: string;
  };
}

export function createAuthRouter(db: AppDatabase, jwtSecret: string): Router {
  const router = Router();

  // 1. 注册
  router.post('/register', (req: Request, res: Response) => {
    try {
      const allowReg = db.getSystemSetting('allow_registration', 'true') === 'true';
      if (!allowReg) {
        res.status(403).json({ ok: false, error: '管理员已暂停新用户注册' });
        return;
      }

      const { username, password } = req.body;
      if (!username || !password || username.length < 3 || password.length < 6) {
        res.status(400).json({ ok: false, error: '用户名至少3位，密码至少6位' });
        return;
      }

      const existing = db.findUserByUsername(username);
      if (existing) {
        res.status(409).json({ ok: false, error: '该用户名已被注册' });
        return;
      }

      const hash = SecurityCrypto.hashPassword(password);
      const userId = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      
      const user = db.createUser({
        id: userId,
        username,
        password_hash: hash,
        role: 'user',
        plan: 'free',
        max_devices: 3,
        expires_at: null,
        status: 'active',
      });

      const token = SecurityCrypto.signToken({ id: user.id, username: user.username, role: user.role, plan: user.plan }, jwtSecret);
      res.json({
        ok: true,
        data: {
          token,
          user: { id: user.id, username: user.username, role: user.role, plan: user.plan, maxDevices: user.max_devices, expiresAt: user.expires_at },
        },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 2. 登录
  router.post('/login', (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        res.status(400).json({ ok: false, error: '请输入用户名和密码' });
        return;
      }

      const user = db.findUserByUsername(username);
      if (!user) {
        res.status(401).json({ ok: false, error: '用户名或密码错误' });
        return;
      }

      if (user.status === 'banned') {
        res.status(403).json({ ok: false, error: '该账号已被管理员封禁，请联系客服' });
        return;
      }

      const isValid = SecurityCrypto.verifyPassword(password, user.password_hash);
      if (!isValid) {
        res.status(401).json({ ok: false, error: '用户名或密码错误' });
        return;
      }

      const token = SecurityCrypto.signToken({ id: user.id, username: user.username, role: user.role, plan: user.plan }, jwtSecret);
      res.json({
        ok: true,
        data: {
          token,
          user: { id: user.id, username: user.username, role: user.role, plan: user.plan, maxDevices: user.max_devices, expiresAt: user.expires_at },
        },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 3. 当前登录身份
  router.get('/me', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    const decoded = SecurityCrypto.verifyToken<{ id: string }>(token, jwtSecret);

    if (!decoded || !decoded.id) {
      res.status(401).json({ ok: false, error: '登录会话已过期，请重新登录' });
      return;
    }

    const user = db.findUserById(decoded.id);
    if (!user) {
      res.status(404).json({ ok: false, error: '用户不存在' });
      return;
    }

    res.json({
      ok: true,
      data: {
        id: user.id,
        username: user.username,
        role: user.role,
        plan: user.plan,
        maxDevices: user.max_devices,
        expiresAt: user.expires_at,
        status: user.status,
      },
    });
  });

  return router;
}

export function authMiddleware(jwtSecret: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    const decoded = SecurityCrypto.verifyToken<{ id: string; username: string; role: 'user' | 'admin'; plan: string }>(token, jwtSecret);

    if (!decoded || !decoded.id) {
      res.status(401).json({ ok: false, error: '未授权或登录已过期' });
      return;
    }

    req.user = decoded;
    next();
  };
}

export function adminOnlyMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ ok: false, error: '需要超级管理员权限' });
    return;
  }
  next();
}
