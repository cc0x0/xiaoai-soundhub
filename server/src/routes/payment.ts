import { Router, Request, Response } from 'express';
import { AppDatabase } from '../db/index.js';

export function createPaymentRouter(db: AppDatabase): Router {
  const router = Router();

  /**
   * 预留自动收款 Webhook 回调入口
   * 兼容 爱发电 (Afdian) / 面包多 / 微信支付商户回调
   */
  router.post('/webhook', (req: Request, res: Response) => {
    try {
      console.log('[PaymentWebhook] 收到外部支付回调数据:', req.body);

      // 示例: 爱发电订单回调解析
      const body = req.body || {};
      const order = body.data?.order;
      if (order) {
        const customParam = order.custom_order_id || order.remark || ''; // 用户填写的用户名或 user_id
        const user = db.findUserByUsername(customParam) || db.findUserById(customParam);
        
        if (user) {
          const now = Date.now();
          const oneYear = now + 365 * 24 * 60 * 60 * 1000;
          db.updateUserPlan(user.id, 'pro', oneYear, 10);
          console.log(`[PaymentWebhook] ✅ 成功自动为用户 [${user.username}] 激活 VIP 专业版！`);
        }
      }

      res.json({ ec: 200, em: 'ok' });
    } catch (err: any) {
      console.error('[PaymentWebhook] 处理支付回调失败:', err);
      res.status(500).json({ ec: 500, em: err.message });
    }
  });

  return router;
}
