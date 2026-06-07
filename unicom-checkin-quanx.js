/*
 * 中国联通 Quantumult X 自动签到脚本
 *
 * 模式：
 * 1) 抓取模式：打开联通 App/H5 登录后页面，自动保存签到所需 cookie
 * 2) 定时模式：读取本地 cookie，执行签到，并补做当前可直连完成的附加任务
 */

const CONFIG = {
  name: '中国联通签到',
  captureKey: 'china_unicom_cookie_store_v1',
  notifyTsKey: 'china_unicom_notify_ts_v1',
  requestTimeout: 20000,
  notifyCooldownMs: 15000,
  hosts: ['m.client.10010.com', 'img.client.10010.com', 'activity.10010.com'],
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 unicom{version:iphone_c@11.0602}',
  api: {
    sign: 'https://activity.10010.com/sixPalaceGridTurntableLottery/signin/daySign',
    taskInfo: 'https://act.10010.com/SigninApp/doTask/getTaskInfo',
    finishVideo: 'https://act.10010.com/SigninApp/doTask/finishVideo',
    getPrize: 'https://act.10010.com/SigninApp/doTask/getPrize'
  }
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

function loadDefaultAccount() {
  const store = currentStore();
  const account = store.__default || Object.keys(store).find((k) => !k.startsWith('__'));
  if (!account || !store[account] || !store[account].cookie) return null;
  return store[account];
}

function shortText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim().slice(0, 240) || '(空响应)';
}

function compactLine(label, value) {
  const text = shortText(value);
  return text && text !== '(空响应)' ? `${label}${text}` : '';
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

async function postJson(url, headers, body) {
  const resp = await fetchApi({ url, method: 'POST', headers, body: body === undefined ? '' : body });
  const mergedCookie = mergeSetCookie(headers.Cookie || '', getHeader(resp.headers, 'set-cookie'));
  return {
    statusCode: resp.statusCode,
    headers: resp.headers,
    body: resp.body,
    cookie: mergedCookie,
    data: safeJsonParse(resp.body, null)
  };
}

function updateCookieIfNeeded(account, nextCookie, sourceUrl) {
  if (nextCookie && nextCookie !== account.cookie) {
    account.cookie = nextCookie;
    saveCapturedCookie(nextCookie, { source: 'task-refresh', url: sourceUrl });
  }
}

function extractRewardText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const direct = [
    payload.redSignMessage,
    payload.prizeName,
    payload.equityValue,
    payload.returnStr,
    payload.statusDesc,
    payload.tips,
    payload.desc,
    payload.msg
  ].filter(Boolean).map((item) => shortText(item));
  return direct[0] || '';
}

async function runSign(headers, account) {
  const resp = await postJson(CONFIG.api.sign, headers);
  updateCookieIfNeeded(account, resp.cookie, CONFIG.api.sign);
  headers.Cookie = account.cookie;

  if (resp.statusCode < 200 || resp.statusCode >= 400) {
    throw new Error(`签到接口请求失败 ${resp.statusCode}：${shortText(resp.body)}`);
  }
  if (!resp.data) {
    throw new Error(`签到接口返回不是 JSON：${shortText(resp.body)}`);
  }

  const data = resp.data;
  const code = String(data.code || '');
  const desc = String(data.desc || data.msg || '').trim();
  const reward = data && data.data && typeof data.data === 'object' ? extractRewardText(data.data) : '';

  if (code === '0000') {
    return {
      ok: true,
      state: 'signed',
      title: '签到成功',
      detail: reward || desc || '已完成'
    };
  }
  if (code === '0002') {
    return {
      ok: true,
      state: 'already',
      title: '今日已签',
      detail: reward || desc || '联通返回已签到'
    };
  }

  return {
    ok: false,
    state: 'failed',
    title: '签到失败',
    detail: desc || JSON.stringify(data)
  };
}

async function getTaskInfo(headers, account) {
  const resp = await postJson(CONFIG.api.taskInfo, headers);
  updateCookieIfNeeded(account, resp.cookie, CONFIG.api.taskInfo);
  headers.Cookie = account.cookie;

  if (resp.statusCode < 200 || resp.statusCode >= 400 || !resp.data) {
    return {
      ok: false,
      lines: [`附加任务：查询失败 ${resp.statusCode}`]
    };
  }

  const taskList = resp.data && resp.data.data && Array.isArray(resp.data.data.taskList)
    ? resp.data.data.taskList
    : [];
  const actInfo = resp.data && resp.data.data && resp.data.data.taskInfo
    ? resp.data.data.taskInfo
    : {};
  const lines = [];

  if (taskList.length) {
    taskList.forEach((item) => {
      lines.push(`任务状态 | ${item.name || '未知任务'} | ${item.btn || item.status || '未知'}`);
    });
  }
  if (actInfo && actInfo.actDiscribe) {
    lines.push(`活动说明 | ${shortText(actInfo.actDiscribe)}`);
  }

  return { ok: true, taskList, actInfo, lines };
}

async function runVideoTask(headers, account, taskList) {
  const task = (taskList || []).find((item) => String(item.action || '') === 'LOCAL_DOTASK_WATCH_VIDEO');
  if (!task) {
    return ['附加任务 | 看视频 | 当前接口未返回该任务'];
  }
  if (String(task.status || '') === '0' || String(task.btn || '').includes('已完成')) {
    return ['附加任务 | 看视频 | 已完成'];
  }

  const finishResp = await postJson(CONFIG.api.finishVideo, headers);
  updateCookieIfNeeded(account, finishResp.cookie, CONFIG.api.finishVideo);
  headers.Cookie = account.cookie;

  const finishData = finishResp.data && finishResp.data.data ? finishResp.data.data : {};
  const finishStatus = finishData.statusDesc || finishData.returnStr || '未知结果';
  const lines = [`附加任务 | 看视频 | ${shortText(finishStatus)}`];

  const prizeResp = await postJson(CONFIG.api.getPrize, headers);
  updateCookieIfNeeded(account, prizeResp.cookie, CONFIG.api.getPrize);
  headers.Cookie = account.cookie;

  const prizeData = prizeResp.data && prizeResp.data.data ? prizeResp.data.data : {};
  const rewardBits = [
    prizeData.prizeName,
    prizeData.equityValue,
    prizeData.returnStr,
    prizeData.statusDesc
  ].filter(Boolean).map((item) => shortText(item));
  lines.push(`附加奖励 | ${rewardBits[0] || '未拿到明确奖励信息'}`);
  return lines;
}

async function runAllTasks() {
  const account = loadDefaultAccount();
  if (!account || !account.cookie) {
    notify(CONFIG.name, '未找到可用 cookie', '先打开联通 App 或签到页面抓取一次 cookie');
    return done();
  }

  const headers = {
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://img.client.10010.com',
    Referer: 'https://img.client.10010.com',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': CONFIG.userAgent,
    Cookie: account.cookie
  };

  const accountLabel = account.account || '联通账号';
  const bodyLines = [];

  const signResult = await runSign(headers, account);
  bodyLines.push(`${signResult.title} | ${signResult.detail}`);

  const taskInfo = await getTaskInfo(headers, account);
  if (taskInfo.lines && taskInfo.lines.length) bodyLines.push(...taskInfo.lines);
  if (taskInfo.ok) {
    const extraLines = await runVideoTask(headers, account, taskInfo.taskList || []);
    if (extraLines && extraLines.length) bodyLines.push(...extraLines);
  }

  const subtitle = `${signResult.title} | ${accountLabel}`;
  notify(CONFIG.name, subtitle, bodyLines.join('\n'));
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
  const reqCookie = getHeader(reqHeaders, 'cookie') || '';
  const merged = mergeSetCookie(reqCookie, getHeader(respHeaders, 'set-cookie'));
  if (!merged) return done({ headers: respHeaders });
  const saved = saveCapturedCookie(merged, { source: 'response-header', url });
  if (!saved.skipped && saved.changed && shouldNotify()) {
    notify(CONFIG.name, '已自动更新 cookie', saved.item && saved.item.account ? saved.item.account : url);
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
  return runAllTasks();
})().catch((error) => {
  notify(CONFIG.name, '执行异常', error && error.message ? error.message : String(error));
  done();
});
