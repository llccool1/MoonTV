/* eslint-disable no-console,@typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';

import { generateAuthCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

// 读取存储类型环境变量，默认 localstorage
const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | 'kvrocks'
    | 'sqlite'
    | undefined) || 'localstorage';

// 登录暴力破解限流：以“账号 + 来源”作为主要限流维度，避免共享代理 IP
// 把所有用户一起锁定；IP 维度只做较宽的兜底保护。
const LOGIN_ACCOUNT_RATE_LIMIT = 5;
const LOGIN_IP_RATE_LIMIT = 100;
const LOGIN_RATE_WINDOW_MS = 30 * 60 * 1000; // 30 分钟

function getClientIP(request: NextRequest): string {
  // 优先使用由受信任代理写入的专用头；XFF 取末项，避免直接信任客户端伪造的首项。
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',').pop()?.trim() ||
    'unknown'
  );
}

function normalizeUsername(username?: string): string | undefined {
  const normalized = username?.trim().toLowerCase();
  return normalized || undefined;
}

function getLoginRateLimitKey(
  ip: string,
  username?: string,
  includeIp = true
): string {
  const normalizedUsername = normalizeUsername(username);
  if (normalizedUsername && includeIp) {
    return `login-rate-limit:account:${normalizedUsername}:ip:${ip}`;
  }
  return normalizedUsername
    ? `login-rate-limit:account:${normalizedUsername}`
    : `login-rate-limit:ip:${ip}`;
}

async function getRateLimitCount(key: string): Promise<number> {
  return Number((await db.getCache(key)) || 0);
}

async function isLoginRateLimited(
  ip: string,
  username?: string
): Promise<boolean> {
  if (STORAGE_TYPE === 'localstorage') return false;

  try {
    const accountIpCount = username
      ? await getRateLimitCount(getLoginRateLimitKey(ip, username))
      : 0;
    const ipCount = await getRateLimitCount(getLoginRateLimitKey(ip));
    return (
      accountIpCount >= LOGIN_ACCOUNT_RATE_LIMIT || ipCount >= LOGIN_IP_RATE_LIMIT
    );
  } catch (error) {
    console.error('登录限流检查失败:', error);
    // 数据库故障时不能因此锁死正常登录，fail-open
    return false;
  }
}

async function recordLoginFailure(ip: string, username?: string): Promise<void> {
  if (STORAGE_TYPE === 'localstorage') return;

  const keys = Array.from(
    new Set([getLoginRateLimitKey(ip, username), getLoginRateLimitKey(ip)])
  );
  try {
    await Promise.all(
      keys.map(async (key) => {
        const currentCount = await getRateLimitCount(key);
        await db.setCache(
          key,
          currentCount + 1,
          Math.ceil(LOGIN_RATE_WINDOW_MS / 1000)
        );
      })
    );
  } catch (error) {
    console.error('登录失败计数写入失败:', error);
  }
}

async function clearLoginFailures(ip: string, username?: string): Promise<void> {
  if (STORAGE_TYPE === 'localstorage') return;

  try {
    await Promise.all([
      ...(username
        ? [db.deleteCache(getLoginRateLimitKey(ip, username))]
        : []),
    ]);
  } catch (error) {
    console.error('登录限流计数清理失败:', error);
  }
}

// 判断当前请求是否走 HTTPS，用于决定 Cookie 的 Secure 属性
// 仅在确定为 https 时才置为 true，http 部署保持原有行为，避免 Cookie 被浏览器丢弃
function isHttpsRequest(req: NextRequest): boolean {
  const forwardedProto = req.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    .trim()
    .toLowerCase();
  if (forwardedProto) {
    return forwardedProto === 'https';
  }
  return req.nextUrl.protocol === 'https:';
}

// generateSignature / generateAuthCookie 统一使用 @/lib/auth 中的实现
// （cookie 不存明文密码，改存 HMAC 哈希）

export async function POST(req: NextRequest) {
  const useSecureCookie = isHttpsRequest(req);
  const clientIP = getClientIP(req);

  try {
    // 本地 / localStorage 模式——仅校验固定密码
    if (STORAGE_TYPE === 'localstorage') {
      const envPassword = process.env.PASSWORD;

      // 未配置 PASSWORD 时直接放行
      if (!envPassword) {
        const response = NextResponse.json({ ok: true });

        // 清除可能存在的认证cookie
        response.cookies.set('user_auth', '', {
          path: '/',
          expires: new Date(0),
          sameSite: 'lax', // 改为 lax 以支持 PWA
          httpOnly: false, // PWA 需要客户端可访问
          secure: useSecureCookie, // 仅 HTTPS 下启用 Secure
        });

        return response;
      }

      const { password } = await req.json();
      if (typeof password !== 'string') {
        return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
      }

      if (password !== envPassword) {
        await recordLoginFailure(clientIP);
        return NextResponse.json(
          { ok: false, error: '密码错误' },
          { status: 401 }
        );
      }

      // 验证成功，设置认证cookie
      const response = NextResponse.json({ ok: true });
      const cookieValue = await generateAuthCookie(
        undefined,
        'user',
        password,
        true
      ); // localstorage 模式包含 password 哈希（非明文）
      const expires = new Date();
      expires.setDate(expires.getDate() + 7); // 7天过期

      response.cookies.set('user_auth', cookieValue, {
        path: '/',
        expires,
        sameSite: 'lax', // 改为 lax 以支持 PWA
        httpOnly: false, // PWA 需要客户端可访问
        secure: useSecureCookie, // 仅 HTTPS 下启用 Secure
      });

      return response;
    }

    // 数据库 / redis 模式——校验用户名并尝试连接数据库
    const { username, password } = await req.json();

    if (!username || typeof username !== 'string') {
      return NextResponse.json({ error: '用户名不能为空' }, { status: 400 });
    }
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
    }

    if (await isLoginRateLimited(clientIP, username)) {
      return NextResponse.json(
        { error: '登录尝试次数过多，请 30 分钟后再试' },
        { status: 429 }
      );
    }

    // 可能是站长，直接读环境变量
    if (
      username === process.env.USERNAME &&
      password === process.env.PASSWORD
    ) {
      await clearLoginFailures(clientIP, username);
      // 验证成功，设置认证cookie
      const response = NextResponse.json({ ok: true });
      const cookieValue = await generateAuthCookie(
        username,
        'owner',
        password,
        false
      ); // 数据库模式不包含 password
      const expires = new Date();
      expires.setDate(expires.getDate() + 7); // 7天过期

      response.cookies.set('user_auth', cookieValue, {
        path: '/',
        expires,
        sameSite: 'lax', // 改为 lax 以支持 PWA
        httpOnly: false, // PWA 需要客户端可访问
        secure: useSecureCookie, // 仅 HTTPS 下启用 Secure
      });

      return response;
    } else if (username === process.env.USERNAME) {
      await recordLoginFailure(clientIP, username);
      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
    }

    const config = await getConfig();
    const user = config.UserConfig.Users.find((u) => u.username === username);
    if (user && user.banned) {
      return NextResponse.json({ error: '用户被封禁' }, { status: 401 });
    }

    // 校验用户密码（V1）
    try {
      const pass = await db.verifyUser(username, password);

      if (!pass) {
        await recordLoginFailure(clientIP, username);
        return NextResponse.json(
          { error: '用户名或密码错误' },
          { status: 401 }
        );
      }

      await clearLoginFailures(clientIP, username);

      // 验证成功，设置认证cookie
      const response = NextResponse.json({ ok: true });
      const cookieValue = await generateAuthCookie(
        username,
        user?.role || 'user',
        password,
        false
      );
      const expires = new Date();
      expires.setDate(expires.getDate() + 7); // 7天过期

      response.cookies.set('user_auth', cookieValue, {
        path: '/',
        expires,
        sameSite: 'lax',
        httpOnly: false,
        secure: useSecureCookie,
      });

      return response;
    } catch (err) {
      console.error('数据库验证失败', err);
      return NextResponse.json({ error: '数据库错误' }, { status: 500 });
    }
  } catch (error) {
    console.error('登录接口异常', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
