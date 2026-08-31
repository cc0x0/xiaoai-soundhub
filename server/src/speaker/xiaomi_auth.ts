import axios from 'axios';
import crypto from 'crypto';

export interface XiaomiLoginResult {
  ok: boolean;
  userId?: string;
  passToken?: string;
  ssecurity?: string;
  nickname?: string;
  error?: string;
}

export class XiaomiAuthService {
  /**
   * 使用小米账号（手机号/邮箱/小米ID）与密码，通过官方鉴权接口换取 userId 与 passToken
   */
  public static async loginWithPassword(account: string, password: string): Promise<XiaomiLoginResult> {
    try {
      const sid = 'micoapi';
      
      // 1. 获取登录握手上下文（_sign, qs, callback）
      const step1Url = "https://account.xiaomi.com/pass/serviceLogin?sid=" + sid + "&_json=true";
      const step1Res = await axios.get(step1Url, {
        headers: {
          'User-Agent': 'APP/com.xiaomi.mihome APPV/6.0.103 iosPassportSDK/3.9.0 iOS/14.4',
        },
        timeout: 10000,
      });

      const rawText1 = step1Res.data;
      const cleanText1 = typeof rawText1 === 'string' ? rawText1.replace('&&&START&&&', '') : JSON.stringify(rawText1);
      const step1Data = typeof rawText1 === 'object' ? rawText1 : JSON.parse(cleanText1);

      const { _sign, qs, callback } = step1Data;

      // 2. MD5 大写密码哈希
      const pwdHash = crypto.createHash('md5').update(password).digest('hex').toUpperCase();

      // 3. 构造认证表单
      const params = new URLSearchParams();
      params.append('_json', 'true');
      params.append('sid', sid);
      params.append('qs', qs || '');
      params.append('_sign', _sign || '');
      params.append('callback', callback || '');
      params.append('user', account.trim());
      params.append('hash', pwdHash);

      const cookies = step1Res.headers['set-cookie'] || [];
      const cookieHeader = cookies.map((c: string) => c.split(';')[0]).join('; ');

      // 4. 提交小米官方第二阶段登录
      const step2Res = await axios.post('https://account.xiaomi.com/pass/serviceLoginAuth2', params.toString(), {
        headers: {
          'User-Agent': 'APP/com.xiaomi.mihome APPV/6.0.103 iosPassportSDK/3.9.0 iOS/14.4',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookieHeader || 'sdkVersion=account-sdk-1.0.0',
        },
        timeout: 12000,
      });

      const rawText2 = step2Res.data;
      const cleanText2 = typeof rawText2 === 'string' ? rawText2.replace('&&&START&&&', '') : JSON.stringify(rawText2);
      const authData = typeof rawText2 === 'object' ? rawText2 : JSON.parse(cleanText2);

      if (authData.code === 0 && authData.passToken) {
        return {
          ok: true,
          userId: String(authData.userId),
          passToken: authData.passToken,
          ssecurity: authData.ssecurity,
          nickname: authData.nickname || account,
        };
      }

      // 错误码细化提示
      let errMsg = authData.description || '小米账号登录失败';
      if (authData.code === 70016) {
        errMsg = '小米账号或密码错误，请检查输入的账号与密码';
      } else if (authData.code === 87001 || authData.notificationUrl) {
        errMsg = '该账号触发了小米异地安全验证，请切换为“高级 passToken”模式手动填入凭证';
      }

      return { ok: false, error: errMsg };
    } catch (e: any) {
      return { ok: false, error: "连接小米云端鉴权接口失败: " + e.message };
    }
  }
}
