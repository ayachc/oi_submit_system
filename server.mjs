import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { accountConfig, examConfig, userConfig } from './config.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const deriveKey = promisify(scrypt);
const MAX_FILE_BYTES = 1024 * 1024;
// JSON escaping can increase the request size, even when the source file is small.
const MAX_BODY_BYTES = MAX_FILE_BYTES * 6 + 4096;
const COOKIE_NAME = 'oi_session';
const usernamePattern = /^[a-zA-Z0-9-]{4,20}$/;
const extensions = new Set(['.cpp', '.cc', '.cxx', '.c', '.py', '.java', '.pas']);
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/student', ['index.html', 'text/html; charset=utf-8']],
  ['/student/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/source-file.js', ['source-file.js', 'text/javascript; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function requireMethod(req, method) {
  if (req.method !== method) throw new HttpError(405, '请求方法不支持。');
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, '请使用 JSON 格式提交。');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, '提交内容过大，每个源文件最多 1 MB。');
  }
  const chunks = [];
  let total = 0;
  // Keep the socket usable when rejecting a streaming request before its end.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) break;
    chunks.push(chunk);
  }
  if (total > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, '提交内容过大，每个源文件最多 1 MB。');
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, '请求内容不是有效的 JSON。');
  }
}

function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, '不允许跨站提交。');
  }
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, '请求来源无效。'); }
    const protocol = req.socket.encrypted ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) {
      throw new HttpError(403, '不允许跨站提交。');
    }
  }
}

function metadata(submission) {
  const { fileName, size, submittedAt } = submission;
  return { fileName, size, submittedAt };
}

/** Create an isolated app instance; importing this module never starts a listener. */
export function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(rootDir, 'data'));
  const publicDir = path.resolve(options.publicDir || path.join(rootDir, 'public'));
  const exam = structuredClone(options.exam || examConfig);
  const sessionDurationMs = options.sessionDurationMs ?? 8 * 60 * 60 * 1000;
  if (!Array.isArray(exam.problems) || !exam.problems.length || exam.problems.some(id => !/^[a-zA-Z0-9_-]{1,32}$/.test(id))) {
    throw new Error('考试题目标识只能包含字母、数字、下划线和短横线。');
  }
  const accounts = new Map();
  const password = options.username === undefined ? accountConfig.password : options.password ?? accountConfig.password;
  if (typeof password !== 'string' || password.length < 6 || password.length > 32) {
    throw new Error('账号密码需为 6–32 位字符。');
  }
  // The requested accounts share one password, so derive it once at startup.
  const salt = randomBytes(16);
  const passwordHash = scryptSync(password, salt, 64);
  function addAccount(username) {
    if (typeof username !== 'string' || !usernamePattern.test(username)) {
      throw new Error('用户名需为 4–20 位字母、数字或连字符。');
    }
    accounts.set(username, {
      user: { ...(options.user || userConfig), username, candidateId: username },
      directory: path.join(dataDir, createHash('sha256').update(username).digest('hex')),
    });
  }
  if (options.username !== undefined) {
    addAccount(options.username);
  } else {
    if (!Number.isInteger(accountConfig.start) || !Number.isInteger(accountConfig.end) || accountConfig.start < 1 || accountConfig.end < accountConfig.start || accountConfig.end > 9999) {
      throw new Error('账号范围需为 1–9999 内的连续整数。');
    }
    for (let number = accountConfig.start; number <= accountConfig.end; number += 1) {
      addAccount(`${accountConfig.prefix}${String(number).padStart(4, '0')}`);
    }
  }
  const sessions = new Map();

  function sessionToken(req) {
    return (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  }

  function authenticated(req) {
    const token = sessionToken(req);
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return accounts.get(session.username) || null;
  }

  function requireAuth(req) {
    const account = authenticated(req);
    if (!account) throw new HttpError(401, '登录已过期，请重新登录。');
    return account;
  }

  function cookie(req, token, maxAge) {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.socket.encrypted ? '; Secure' : ''}`;
  }

  async function readSubmission(account, problemId) {
    try {
      return JSON.parse(await readFile(path.join(account.directory, `${problemId}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function sessionData(account) {
    const submissions = {};
    for (const problemId of exam.problems) {
      const submission = await readSubmission(account, problemId);
      if (submission) submissions[problemId] = metadata(submission);
    }
    return { authenticated: true, user: account.user, exam, submissions };
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) checkOrigin(req);

    if (pathname === '/api/session') {
      requireMethod(req, 'GET');
      const account = authenticated(req);
      return sendJson(res, 200, account ? await sessionData(account) : { authenticated: false });
    }

    if (pathname === '/api/login') {
      requireMethod(req, 'POST');
      const body = await readJson(req);
      if (typeof body.username !== 'string' || !usernamePattern.test(body.username) || typeof body.password !== 'string' || body.password.length < 6 || body.password.length > 32) {
        throw new HttpError(400, '用户名需为 4–20 位字母、数字或连字符，密码需为 6–32 位字符。');
      }
      const candidateHash = await deriveKey(body.password, salt, 64);
      const passwordMatches = timingSafeEqual(passwordHash, candidateHash);
      const account = accounts.get(body.username);
      if (!passwordMatches || !account) throw new HttpError(401, '用户名或密码错误。');
      for (const [token, session] of sessions) {
        if (session.expiresAt <= Date.now()) sessions.delete(token);
      }
      sessions.delete(sessionToken(req));
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { username: account.user.username, expiresAt: Date.now() + sessionDurationMs });
      res.setHeader('Set-Cookie', cookie(req, token, Math.floor(sessionDurationMs / 1000)));
      return sendJson(res, 200, await sessionData(account));
    }

    if (pathname === '/api/logout') {
      requireMethod(req, 'POST');
      sessions.delete(sessionToken(req));
      res.setHeader('Set-Cookie', cookie(req, '', 0));
      return sendJson(res, 200, { authenticated: false });
    }

    if (pathname === '/api/exam/download') {
      requireMethod(req, 'GET');
      requireAuth(req);
      let archive;
      try { archive = await readFile(path.join(publicDir, 'exam', 'day1.zip')); } catch (error) {
        if (error.code === 'ENOENT') throw new HttpError(404, '试题包尚未准备好，请联系管理员。');
        throw error;
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="day1.zip"',
        'Content-Length': archive.length,
      });
      return res.end(archive);
    }

    const submissionMatch = /^\/api\/submissions\/([a-zA-Z0-9_-]+)$/.exec(pathname);
    if (submissionMatch) {
      const account = requireAuth(req);
      const problemId = submissionMatch[1];
      if (!exam.problems.includes(problemId)) throw new HttpError(404, '题目不存在。');
      if (req.method === 'GET') {
        const submission = await readSubmission(account, problemId);
        if (!submission) throw new HttpError(404, '这道题尚未提交代码。');
        return sendJson(res, 200, submission);
      }
      requireMethod(req, 'POST');
      if (exam.status !== 'ongoing') throw new HttpError(409, '当前考试未开放提交。');
      const { fileName, content } = await readJson(req);
      if (typeof fileName !== 'string' || !fileName || fileName.length > 128 || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(fileName) || fileName.startsWith('.') || /[. ]$/.test(fileName) || path.basename(fileName) !== fileName) {
        throw new HttpError(400, '文件名无效，请使用普通源代码文件名。');
      }
      if (!extensions.has(path.extname(fileName).toLowerCase())) {
        throw new HttpError(400, '请选择 C、C++、Python、Java 或 Pascal 源代码文件。');
      }
      if (typeof content !== 'string' || !content.trim() || content.includes('\0')) {
        throw new HttpError(400, '源代码不能为空，且必须是文本文件。');
      }
      const size = Buffer.byteLength(content, 'utf8');
      if (size > MAX_FILE_BYTES) throw new HttpError(413, '文件过大，每个源文件最多 1 MB。');
      const submission = { fileName, size, submittedAt: new Date().toISOString(), content };
      const accountDir = account.directory;
      await mkdir(accountDir, { recursive: true });
      const temporaryPath = path.join(accountDir, `${problemId}.${randomBytes(8).toString('hex')}.tmp`);
      try {
        await writeFile(temporaryPath, JSON.stringify(submission), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, path.join(accountDir, `${problemId}.json`));
      } finally {
        await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return sendJson(res, 200, { submission: metadata(submission) });
    }

    if (staticFiles.has(pathname)) {
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '请求方法不支持。');
      const [file, contentType] = staticFiles.get(pathname);
      let content;
      try { content = await readFile(path.join(publicDir, file)); } catch (error) {
        if (error.code === 'ENOENT') throw new HttpError(404, '页面文件不存在。');
        throw error;
      }
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : content);
    }
    throw new HttpError(404, '页面或接口不存在。');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.destroyed || res.writableEnded) return;
      if (!error.status) console.error('Request failed:', error.message);
      if (res.headersSent) return res.destroy();
      sendJson(res, error.status || 500, { error: error.status ? error.message : '服务暂时无法处理请求，请稍后重试。' });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || 'localhost';
  const server = createApp();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置其他 PORT。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`考试提交系统已启动：http://${host}:${server.address().port}`));
}
