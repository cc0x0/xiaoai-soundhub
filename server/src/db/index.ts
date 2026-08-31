// @ts-ignore
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { SecurityCrypto } from '../security/crypto.js';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'user' | 'admin';
  plan: 'free' | 'pro' | 'lifetime';
  max_devices: number;
  expires_at: number | null;
  status: 'active' | 'banned';
  created_at: number;
}

export interface MiAccountRow {
  id: string;
  user_id: string;
  xiaomi_user_id: string;
  encrypted_pass_token: string;
  nickname: string;
  updated_at: number;
}

export interface SpeakerRow {
  id: string;
  user_id: string;
  did: string;
  name: string;
  model: string;
  hardware: string;
  is_gateway: number;
  is_ignored: number;
  is_listener_enabled: number;
  updated_at: number;
}

export interface UserSettingsRow {
  user_id: string;
  active_source: string;
  preferred_quality: string;
  custom_stop_keywords: string;
  custom_prefixes: string;
  enable_tts_chime: number;
  default_chime: string;
}

export interface SystemSettingRow {
  key: string;
  value: string;
  category: string;
  description: string;
  updated_at: number;
}

export class AppDatabase {
  private db: DatabaseSync;

  constructor(dbFilePath?: string) {
    const defaultPath = path.join(process.cwd(), 'data', 'soundhub.db');
    const targetPath = dbFilePath || process.env.DATABASE_PATH || defaultPath;
    
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(targetPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        plan TEXT NOT NULL DEFAULT 'free',
        max_devices INTEGER NOT NULL DEFAULT 3,
        expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mi_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        xiaomi_user_id TEXT NOT NULL,
        encrypted_pass_token TEXT NOT NULL,
        nickname TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS speakers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        did TEXT NOT NULL,
        name TEXT NOT NULL,
        model TEXT,
        hardware TEXT,
        is_gateway INTEGER NOT NULL DEFAULT 0,
        is_ignored INTEGER NOT NULL DEFAULT 0,
        is_listener_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id, did),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        active_source TEXT NOT NULL DEFAULT 'my-custom-source.js',
        preferred_quality TEXT NOT NULL DEFAULT '320k',
        custom_stop_keywords TEXT NOT NULL DEFAULT '[]',
        custom_prefixes TEXT NOT NULL DEFAULT '[]',
        enable_tts_chime INTEGER NOT NULL DEFAULT 1,
        default_chime TEXT NOT NULL DEFAULT 'dingdong',
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        trade_no TEXT,
        payment_gateway TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        amount REAL NOT NULL DEFAULT 0.0,
        start_date INTEGER NOT NULL,
        end_date INTEGER NOT NULL,
        remarks TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        description TEXT,
        updated_at INTEGER NOT NULL
      );
    `);

    this.seedDefaults();
  }

  private seedDefaults(): void {
    // 1. 初始化超级管理员 (若无 admin)
    const adminUser = this.db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get() as unknown as UserRow | undefined;
    if (!adminUser) {
      const adminPass = process.env.ADMIN_PASSWORD || 'admin123456';
      const hash = SecurityCrypto.hashPassword(adminPass);
      const adminId = 'admin_root_001';
      const now = Date.now();
      
      this.db.prepare(`
        INSERT INTO users (id, username, password_hash, role, plan, max_devices, created_at)
        VALUES (?, ?, ?, 'admin', 'lifetime', 99, ?)
      `).run(adminId, 'admin', hash, now);

      this.db.prepare(`
        INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)
      `).run(adminId);

      console.log('[Database] 🚀 超级管理员账号已自动就绪 (用户名: admin)');
    }

    // 2. 初始化全局系统魔数参数
    const defaultSettings: [string, string, string, string][] = [
      ['poll_interval_ms', '1200', 'listener', '小爱云端对话轮询间隔 (毫秒)'],
      ['switch_buffer_ms', '2000', 'scheduler', '切歌等待缓冲区冗余时间 (毫秒)'],
      ['chime_delay_ms', '1400', 'audio', '提示音播放与语音朗读间隔等待延时 (毫秒)'],
      ['default_platform', 'kw', 'source', '音乐搜索默认平台 (kw/wy/tx/kg/mg)'],
      ['allow_registration', 'true', 'auth', '是否允许新用户注册 (true/false)'],
      ['system_notice', '欢迎使用 XiaoAi SoundHub 小爱全屋音乐声枢！', 'general', '全站公告信息']
    ];

    const insertSetting = this.db.prepare(`
      INSERT OR IGNORE INTO system_settings (key, value, category, description, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    for (const [k, v, cat, desc] of defaultSettings) {
      insertSetting.run(k, v, cat, desc, now);
    }
  }

  // ====== 用户相关 CRUD ======
  public findUserByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as UserRow | undefined;
  }

  public findUserById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  }

  public createUser(user: Omit<UserRow, 'created_at'>): UserRow {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO users (id, username, password_hash, role, plan, max_devices, expires_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.username, user.password_hash, user.role, user.plan, user.max_devices, user.expires_at, user.status, now);

    this.db.prepare(`INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)`).run(user.id);
    return this.findUserById(user.id)!;
  }

  public updateUserPlan(userId: string, plan: 'free' | 'pro' | 'lifetime', expiresAt: number | null, maxDevices: number): void {
    this.db.prepare(`
      UPDATE users SET plan = ?, expires_at = ?, max_devices = ? WHERE id = ?
    `).run(plan, expiresAt, maxDevices, userId);
  }

  public listAllUsers(): UserRow[] {
    return this.db.prepare('SELECT id, username, role, plan, max_devices, expires_at, status, created_at FROM users ORDER BY created_at DESC').all() as unknown as UserRow[];
  }

  // ====== 小米账号绑定 ======
  public getMiAccount(userId: string): MiAccountRow | undefined {
    return this.db.prepare('SELECT * FROM mi_accounts WHERE user_id = ?').get(userId) as unknown as MiAccountRow | undefined;
  }

  public getAllMiAccounts(): MiAccountRow[] {
    return this.db.prepare('SELECT * FROM mi_accounts').all() as unknown as MiAccountRow[];
  }

  public saveMiAccount(userId: string, xiaomiUserId: string, encryptedToken: string, nickname?: string): void {
    const id = `mi_${userId}`;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO mi_accounts (id, user_id, xiaomi_user_id, encrypted_pass_token, nickname, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        xiaomi_user_id = excluded.xiaomi_user_id,
        encrypted_pass_token = excluded.encrypted_pass_token,
        nickname = excluded.nickname,
        updated_at = excluded.updated_at
    `).run(id, userId, xiaomiUserId, encryptedToken, nickname || '', now);
  }

  public deleteMiAccount(userId: string): void {
    this.db.prepare('DELETE FROM mi_accounts WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM speakers WHERE user_id = ?').run(userId);
  }

  // ====== 音箱设备表 ======
  public getSpeakers(userId: string): SpeakerRow[] {
    return this.db.prepare('SELECT * FROM speakers WHERE user_id = ? ORDER BY is_gateway DESC, did ASC').all(userId) as unknown as SpeakerRow[];
  }

  public syncSpeakers(userId: string, discovered: { did: string; name: string; model?: string; hardware?: string }[]): void {
    const now = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO speakers (id, user_id, did, name, model, hardware, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, did) DO UPDATE SET
        name = excluded.name,
        model = excluded.model,
        hardware = excluded.hardware,
        updated_at = excluded.updated_at
    `);

    for (const dev of discovered) {
      const id = `${userId}_${dev.did}`;
      insert.run(id, userId, dev.did, dev.name, dev.model || '', dev.hardware || '', now);
    }
  }

  public setSpeakerGateway(userId: string, did: string): void {
    this.db.prepare('UPDATE speakers SET is_gateway = 0 WHERE user_id = ?').run(userId);
    this.db.prepare('UPDATE speakers SET is_gateway = 1 WHERE user_id = ? AND did = ?').run(userId, did);
  }

  public toggleSpeakerIgnored(userId: string, did: string, isIgnored: boolean): void {
    this.db.prepare('UPDATE speakers SET is_ignored = ? WHERE user_id = ? AND did = ?').run(isIgnored ? 1 : 0, userId, did);
  }

  public toggleSpeakerListener(userId: string, did: string, isListenerEnabled: boolean): void {
    this.db.prepare('UPDATE speakers SET is_listener_enabled = ? WHERE user_id = ? AND did = ?').run(isListenerEnabled ? 1 : 0, userId, did);
  }

  // ====== 用户个性化设置 ======
  public getUserSettings(userId: string): UserSettingsRow {
    let row = this.db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as unknown as UserSettingsRow | undefined;
    if (!row) {
      this.db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(userId);
      row = this.db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as unknown as UserSettingsRow;
    }
    return row;
  }

  public updateUserSettings(userId: string, settings: Partial<UserSettingsRow>): void {
    const current = this.getUserSettings(userId);
    const updated = { ...current, ...settings };
    this.db.prepare(`
      UPDATE user_settings
      SET active_source = ?, preferred_quality = ?, custom_stop_keywords = ?, custom_prefixes = ?, enable_tts_chime = ?, default_chime = ?
      WHERE user_id = ?
    `).run(updated.active_source, updated.preferred_quality, updated.custom_stop_keywords, updated.custom_prefixes, updated.enable_tts_chime, updated.default_chime, userId);
  }

  // ====== 系统全局参数 ======
  public getSystemSetting(key: string, defaultVal = ''): string {
    const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as unknown as { value: string } | undefined;
    return row ? row.value : defaultVal;
  }

  public getAllSystemSettings(): SystemSettingRow[] {
    return this.db.prepare('SELECT * FROM system_settings ORDER BY category ASC, key ASC').all() as unknown as SystemSettingRow[];
  }

  public updateSystemSetting(key: string, value: string): void {
    const now = Date.now();
    this.db.prepare('UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?').run(value, now, key);
  }
}
