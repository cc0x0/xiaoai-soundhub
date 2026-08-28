/**
 * 音频流中继代理 (Stream Proxy)
 * 解决小爱音箱无法自主携带防盗链 Headers (Referer/User-Agent) 的问题，
 * 并支持 HTTP Range 分片流传输。
 */

import { Request, Response } from 'express';
import axios from 'axios';

export class StreamProxy {
  public static async handleProxy(req: Request, res: Response): Promise<void> {
    const rawUrl = req.query.url as string;
    const rawHeaders = req.query.headers as string;

    if (!rawUrl) {
      res.status(400).send('Missing url parameter');
      return;
    }

    let targetUrl: string;
    try {
      targetUrl = decodeURIComponent(rawUrl);
    } catch {
      targetUrl = rawUrl;
    }

    let extraHeaders: Record<string, string> = {};
    if (rawHeaders) {
      try {
        extraHeaders = JSON.parse(decodeURIComponent(rawHeaders));
      } catch {
        // ignore parse error
      }
    }

    const requestHeaders: Record<string, string> = {
      'User-Agent':
        extraHeaders['User-Agent'] ||
        extraHeaders['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...extraHeaders,
    };

    // 传递 Range 头以支持音频跳转和分片缓冲
    if (req.headers.range) {
      requestHeaders['Range'] = req.headers.range as string;
    }

    try {
      const response = await axios({
        method: 'GET',
        url: targetUrl,
        headers: requestHeaders,
        responseType: 'stream',
        timeout: 30000,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      // 转发关键响应头
      const contentType = response.headers['content-type'];
      res.setHeader('Content-Type', typeof contentType === 'string' ? contentType : 'audio/mpeg');

      const contentLength = response.headers['content-length'];
      if (contentLength !== undefined) {
        res.setHeader('Content-Length', String(contentLength));
      }

      const contentRange = response.headers['content-range'];
      if (contentRange !== undefined) {
        res.setHeader('Content-Range', String(contentRange));
      }

      const acceptRanges = response.headers['accept-ranges'];
      res.setHeader('Accept-Ranges', typeof acceptRanges === 'string' ? acceptRanges : 'bytes');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(response.status);

      response.data.pipe(res);

      response.data.on('error', (err: any) => {
        console.error('[StreamProxy] 流读取错误:', err.message);
        if (!res.headersSent) {
          res.status(502).end();
        }
      });
    } catch (err: any) {
      console.error(`[StreamProxy] 拉流失败 [${targetUrl}]:`, err.message);
      if (!res.headersSent) {
        res.status(502).send(`Proxy fetch failed: ${err.message}`);
      }
    }
  }

  public static buildProxyUrl(baseUrl: string, rawUrl: string, headers?: Record<string, string>): string {
    const encodedUrl = encodeURIComponent(rawUrl);
    let proxyUrl = `${baseUrl.replace(/\/$/, '')}/proxy/stream?url=${encodedUrl}`;
    if (headers && Object.keys(headers).length > 0) {
      const encodedHeaders = encodeURIComponent(JSON.stringify(headers));
      proxyUrl += `&headers=${encodedHeaders}`;
    }
    return proxyUrl;
  }
}

