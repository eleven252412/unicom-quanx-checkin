/*
 * 中国联通 Quantumult X 自动签到脚本
 *
 * 模式：
 * 1) 抓取模式：打开联通 App/H5 登录后页面，自动保存签到所需 cookie
 * 2) 定时模式：读取本地多个账号 cookie，逐个调用当前可用签到接口执行签到并汇总结果
 */

const CONFIG = {
  name: '中国联通签到',
  captureKey: 'china_unicom_cookie_store_v1',
  notifyTsKey: 'china_unicom_notify_ts_v1',
  requestTimeout: 20000,
  notifyCooldownMs: 15000,
  signUrl: 'https://activity.10010.com/sixPalaceGridTurntableLottery/signin/daySign',
  hosts: ['m.client.10010.com', 'img.client.10010.com', 'activity.10010.com'],
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@11.0602}'
};

function now() { return Date.now(); }
function isoNow() { return new Date().toISOString(); }
function done(value) { $done(value || {}); }
function notify(title, subtitle, body) { $notify(title, subtitle || '', body || ''); }
function safeJsonParse(text, fallback) { try { return JSON.parse(text); } catch (_) { return fallback; } }
function readJSON(key, fallback) { return safeJsonParse($prefs.valueForKey(key) || '', fallback); }
function writeJSON(key, value) { return $prefs.setValueForKey(JSON.stringify(value), key); }

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function setHeader(headers, name, value) {
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (String(key).toLowerCase() === lower) {
      headers[key] = value;
      return;
    }
  }
  headers[name] = value;
}

function normalizeSetCookie(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return String(raw)
    .split(/\n|,(?=[^;]+?=)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCookie(cookie) {
  const jar = new Map();
  String(cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) return;
      jar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    });
  return jar;
}

function stringifyCookie(jar) {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function mergeSetCookie(cookie, setCookie) {
  const jar = parseCookie(cookie);
  normalizeSetCookie(setCookie).forEach((line) => {
    const first = String(line || '').split(';')[0].trim();
    const idx = first.indexOf('=');
    if (idx <= 0) return;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!name) return;
    if (!value || /^(deleted|null|undefined)$/i.test(value)) jar.delete(name);
    else jar.set(name, value);
  });
  return stringifyCookie(jar);
}

function isUsefulCookie(cookie) {
  const jar = parseCookie(cookie);
  const keys = ['t3_token', 'ecs_token', 'c_mobile'];
  return keys.every((key) => jar.has(key));
}

function currentStore() {
  return readJSON(CONFIG.captureKey, {});
}

function saveStore(store) {
  return writeJSON(CONFIG.captureKey, store || {});
}

function shouldNotify() {
  const last = Number($prefs.valueForKey(CONFIG.notifyTsKey) || 0);
  if (now() - last < CONFIG.notifyCooldownMs) return false;
  $prefs.setValueForKey(String(now()), CONFIG.notifyTsKey);
  return true;
}

function accountFromCookie(cookie) {
  const jar = parseCookie(cookie);
  return jar.get('c_mobile') || jar.get('u_account') || jar.get('desmobile') || '';
}

function saveCapturedCookie(cookie, meta) {
  if (!isUsefulCookie(cookie)) return { changed: false, skipped: true, store: currentStore() };
  const store = currentStore();
  const account = accountFromCookie(cookie) || 'default';
  const prev = store[account] || {};
  const next = {
    account,
    cookie,
    updatedAt: isoNow(),
    source: meta && meta.source ? meta.source : 'capture',
    url: meta && meta.url ? meta.url : ''
  };
  const changed = prev.cookie !== cookie;
  store[account] = next;
  store.__default = account;
  saveStore(store);
  return { changed, skipped: false, store, item: next };
}

function loadAccounts() {
  const store = currentStore();
  return Object.keys(store)
    .filter((key) => !String(key).startsWith('__'))
    .map((key) => store[key])
    .filter((item) => item && item.cookie)
    .map((item) => ({
      account: item.account || accountFromCookie(item.cookie) || 'default',
      cookie: item.cookie,
      updatedAt: item.updatedAt || '',
      source: item.source || '',
      url: item.url || ''
    }));
}

function saveCookieForAccount(accountName, cookie, meta) {
  if (!isUsefulCookie(cookie)) return { changed: false, skipped: true, store: currentStore() };
  const store = currentStore();
  const account = accountName || accountFromCookie(cookie) || 'default';
  const prev = store[account] || {};
  const next = {
    account,
    cookie,
    updatedAt: isoNow(),
    source: meta && meta.source ? meta.source : 'task-refresh',
    url: meta && meta.url ? meta.url : ''
  };
  const changed = prev.cookie !== cookie;
  store[account] = next;
  if (!store.__default) store.__default = account;
  saveStore(store);
  return { changed, skipped: false, store, item: next };
}

function shortText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim().slice(0, 240) || '(空响应)';
}

function extractStreakDays(data, fallbackTexts) {
  const exactKeys = new Set([
    'continueSignDays', 'continuousSignDays', 'continuousDays', 'consecutiveDays',
    'serialSignDays', 'seriesSignDays', 'signDays', 'signinDays', 'signInDays',
    'signedDays', 'signDay', 'dayCount', 'signCount', 'signNum'
  ]);
  const seen = new Set();

  function toDays(value) {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    if (!/^\d{1,4}$/.test(text)) return '';
    const num = Number(text);
    return num > 0 && num < 1000 ? String(num) : '';
  }

  function scan(obj) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return '';
    seen.add(obj);
    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();
      const value = obj[key];
      if (
        exactKeys.has(key) ||
        (/day|days|num|count/.test(lower) && /continue|continuous|consecutive|serial|series|streak|sign/.test(lower)) ||
        /连续|连签/.test(key)
      ) {
        const days = toDays(value);
        if (days) return days;
      }
      const nested = scan(value);
      if (nested) return nested;
    }
    return '';
  }

  const fromData = scan(data);
  if (fromData) return fromData;

  const text = (fallbackTexts || []).filter(Boolean).join(' ');
  const matched = text.match(/(?:连签|连续签到|已连续签到|连续已签到)\s*(\d{1,4})\s*天/);
  return matched ? toDays(matched[1]) : '';
}

function appendStreak(text, days) {
  const base = text || '已完成';
  return days ? `${base} | 已连签${days}天` : base;
}

async function fetchApi({ url, method = 'GET', headers = {}, body }) {
  const opts = {
    url,
    method,
    headers,
    timeout: CONFIG.requestTimeout,
    opts: { redirection: true }
  };
  if (body !== undefined) opts.body = body;
  const resp = await $task.fetch(opts);
  return {
    statusCode: resp.statusCode,
    headers: resp.headers || {},
    body: resp.body || ''
  };
}

async function signOneAccount(account) {
  const accountLabel = account.account || accountFromCookie(account.cookie) || '联通账号';

  // 优化1: 请求前校验 cookie 归属，防止串号
  const cookieMobile = accountFromCookie(account.cookie);
  if (cookieMobile && accountLabel !== '联通账号' && accountLabel !== 'default' && cookieMobile !== accountLabel) {
    return { account: accountLabel, status: 'cookie 串号', message: `cookie 中 c_mobile=${cookieMobile}，但账号标识=${accountLabel}，数据不匹配，请重新抓取`, failed: true };
  }

  // 优化2: 请求前校验 cookie 必要字段完整性
  const jar = parseCookie(account.cookie);
  const hasT3 = jar.has('t3_token') && String(jar.get('t3_token') || '').trim();
  const hasEcs = jar.has('ecs_token') && String(jar.get('ecs_token') || '').trim();
  const hasMobile = jar.has('c_mobile') && String(jar.get('c_mobile') || '').trim();
  if (!hasT3 || !hasEcs || !hasMobile) {
    return { account: accountLabel, status: 'cookie 不完整', message: `t3_token=${hasT3?'有':'缺'} ecs_token=${hasEcs?'有':'缺'} c_mobile=${hasMobile?'有':'缺'}，请重新抓取 cookie`, failed: true };
  }

  const headers = {
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://img.client.10010.com',
    Referer: 'https://img.client.10010.com',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': CONFIG.userAgent,
    Cookie: account.cookie
  };

  try {
    const resp = await fetchApi({ url: CONFIG.signUrl, method: 'POST', headers, body: '' });
    const mergedCookie = mergeSetCookie(account.cookie, getHeader(resp.headers, 'set-cookie'));
    if (mergedCookie && mergedCookie !== account.cookie) {
      saveCookieForAccount(accountLabel, mergedCookie, { source: 'task-refresh', url: CONFIG.signUrl });
      headers.Cookie = mergedCookie;
    }

    if (resp.statusCode < 200 || resp.statusCode >= 400) {
      return { account: accountLabel, status: `请求失败 ${resp.statusCode}`, message: shortText(resp.body), failed: true };
    }

    const data = safeJsonParse(resp.body, null);
    if (!data) {
      return { account: accountLabel, status: '返回不是 JSON', message: shortText(resp.body), failed: true };
    }

    const code = String(data.code || '');
    const desc = String(data.desc || data.msg || '').trim();
    const reward = data && data.data && typeof data.data === 'object'
      ? String(data.data.redSignMessage || '').trim()
      : '';
    const streakDays = extractStreakDays(data, [desc, reward, resp.body]);

    if (code === '0000') {
      return { account: accountLabel, status: '签到成功', message: appendStreak(reward || desc || '已完成', streakDays) };
    }
    if (code === '0002') {
      return { account: accountLabel, status: '今日已签', message: appendStreak(desc || '联通返回已签到', streakDays) };
    }

    return { account: accountLabel, status: '签到失败', message: `${desc || JSON.stringify(data)} | c_mobile=${cookieMobile}`, failed: true };
  } catch (error) {
    return { account: accountLabel, status: '执行异常', message: error && error.message ? error.message : String(error), failed: true };
  }
}

function formatSummary(results) {
  const successCount = results.filter((item) => !item.failed).length;
  const total = results.length;
  const lines = results.map((item) => `${item.account}：${item.status}${item.message ? ' | ' + item.message : ''}`);
  return {
    subtitle: `完成 ${successCount}/${total}`,
    body: lines.join('\n')
  };
}

async function runSign() {
  const accounts = loadAccounts();
  if (!accounts.length) {
    notify(CONFIG.name, '未找到可用 cookie', '先打开联通 App 或签到页面抓取一次 cookie；多账号请分别登录并打开页面抓取');
    return done();
  }

  const results = [];
  for (const account of accounts) {
    results.push(await signOneAccount(account));
  }

  const summary = formatSummary(results);
  notify(CONFIG.name, summary.subtitle, summary.body);
  return done();
}

function captureFromRequest() {
  const req = $request || {};
  const url = req.url || '';
  const headers = req.headers || {};
  const cookie = getHeader(headers, 'cookie') || '';
  if (!cookie) return done({ headers });
  const saved = saveCapturedCookie(cookie, { source: 'request-header', url });
  if (!saved.skipped && saved.changed && shouldNotify()) {
    notify(CONFIG.name, '已自动更新 cookie', saved.item && saved.item.account ? saved.item.account : url);
  }
  done({ headers });
}

function captureFromResponse() {
  const req = $request || {};
  const resp = $response || {};
  const url = req.url || '';
  const reqHeaders = req.headers || {};
  const respHeaders = resp.headers || {};
  const respSetCookie = getHeader(respHeaders, 'set-cookie') || '';
  if (!respSetCookie) return done({ headers: respHeaders });
  // 从响应 Set-Cookie 中提取 c_mobile，避免用请求 jar（含所有账号 cookie）造成污染
  const tempJar = parseCookie('');
  normalizeSetCookie(respSetCookie).forEach((line) => {
    const first = String(line || '').split(';')[0].trim();
    const idx = first.indexOf('=');
    if (idx <= 0) return;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name && value && !/^(deleted|null|undefined)$/i.test(value)) tempJar.set(name, value);
  });
  const respMobile = tempJar.get('c_mobile') || '';
  const store = currentStore();
  const existingCookie = respMobile && store[respMobile] ? store[respMobile].cookie || '' : '';
  const merged = mergeSetCookie(existingCookie, respSetCookie);
  if (!merged) return done({ headers: respHeaders });
  const saved = saveCapturedCookie(merged, { source: 'response-header', url });
  if (!saved.skipped) {
    if (saved.changed && shouldNotify()) {
      notify(CONFIG.name, '已自动更新 cookie', saved.item && saved.item.account ? saved.item.account : url);
    }
  } else {
    // cookie 缺少必要字段，给用户明确诊断
    const jar = parseCookie(merged);
    const missing = [];
    if (!jar.has('t3_token') || !String(jar.get('t3_token') || '').trim()) missing.push('t3_token');
    if (!jar.has('ecs_token') || !String(jar.get('ecs_token') || '').trim()) missing.push('ecs_token');
    if (!jar.has('c_mobile') || !String(jar.get('c_mobile') || '').trim()) missing.push('c_mobile');
    if (shouldNotify()) {
      notify(CONFIG.name, 'cookie 抓取失败', '缺少 ' + missing.join('、') + '，请确认从联通 H5/App 页面抓取，且重放已关闭');
    }
  }
  done({ headers: respHeaders });
}

(async () => {
  if (typeof $request !== 'undefined' && typeof $response === 'undefined') {
    return captureFromRequest();
  }
  if (typeof $request !== 'undefined' && typeof $response !== 'undefined') {
    return captureFromResponse();
  }
  return runSign();
})().catch((error) => {
  notify(CONFIG.name, '脚本异常', error && error.message ? error.message : String(error));
  done();
});
