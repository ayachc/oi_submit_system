import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'oi-submit-test-'));
  const publicDir = path.join(directory, 'public');
  const dataDir = path.join(directory, 'data');
  const archive = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  await mkdir(path.join(publicDir, 'exam'), { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>考试系统</title>');
  await writeFile(path.join(publicDir, 'app.js'), 'console.log("test");');
  await writeFile(path.join(publicDir, 'source-file.js'), 'export const test = true;');
  await writeFile(path.join(publicDir, 'styles.css'), 'body{margin:0}');
  await writeFile(path.join(publicDir, 'exam', 'day1.zip'), archive);
  const servers = [];

  async function start(overrides = {}) {
    const app = createApp({ dataDir, publicDir, username: 'student01', password: '123456', ...options, ...overrides });
    servers.push(app);
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const baseUrl = `http://127.0.0.1:${app.address().port}`;
    function newClient() {
      let cookie = '';
      return {
        app,
        baseUrl,
        newClient,
        async request(url, { method = 'GET', body, headers = {}, anonymous = false, agent, chunked = false } = {}) {
          const rawBody = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
          // OS-assigned ephemeral ports may be on fetch's browser-unsafe port list.
          // Native HTTP keeps the fixture independent of both that list and fixed ports.
          const response = await new Promise((resolve, reject) => {
            const request = httpRequest(`${baseUrl}${url}`, {
              method,
              agent,
              headers: {
                ...(rawBody === undefined ? {} : {
                  'Content-Type': 'application/json',
                  ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': Buffer.byteLength(rawBody) }),
                }),
                ...(!anonymous && cookie ? { Cookie: cookie } : {}),
                ...headers,
              },
            }, incoming => {
              const chunks = [];
              incoming.on('data', chunk => chunks.push(chunk));
              incoming.once('error', reject);
              incoming.once('end', () => {
                const responseHeaders = new Headers();
                for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
                  responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
                }
                resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
              });
            });
            request.once('error', reject);
            request.end(rawBody);
          });
          if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
          return response;
        },
        async login(username = 'student01', password = '123456') {
          const response = await this.request('/api/login', { method: 'POST', body: { username, password } });
          assert.equal(response.status, 200);
          return response;
        },
      };
    }
    return newClient();
  }

  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
    const relative = path.relative(tmpdir(), directory);
    assert.ok(relative.startsWith('oi-submit-test-') && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  });

  return { ...(await start()), start, archive, dataDir };
}

test('serves both pages and assets; private files are never public', async t => {
  const client = await fixture(t);
  for (const url of ['/', '/student/', '/styles.css', '/app.js', '/source-file.js']) {
    const response = await client.request(url);
    assert.equal(response.status, 200, url);
    await response.arrayBuffer();
  }
  for (const url of ['/exam/day1.zip', '/public/exam/day1.zip', '/config.mjs', '/data/a.json', '/unknown']) {
    assert.equal((await client.request(url)).status, 404, url);
  }
  assert.equal((await client.request('/api/exam/download')).status, 401);
  assert.equal((await client.request('/api/submissions/a')).status, 401);
  assert.equal((await client.request('/api/submissions/a', { method: 'POST', body: { fileName: 'a.cpp', content: 'hello' } })).status, 401);
});

test('login validates credentials, sets private cookie, and logout revokes session', async t => {
  const client = await fixture(t);
  assert.deepEqual(await (await client.request('/api/session')).json(), { authenticated: false });
  assert.equal((await client.request('/api/login', { method: 'POST', body: { username: 'bad!', password: '123456' } })).status, 400);
  assert.equal((await client.request('/api/login', { method: 'POST', body: { username: 'student01', password: 'wrongpassword' } })).status, 401);
  assert.equal((await client.request('/api/login', { method: 'POST', body: { username: 'student02', password: '123456' } })).status, 401);
  const login = await client.login();
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=28800/);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const body = await login.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.user.candidateId, 'student01');
  assert.deepEqual(body.exam.problems, ['a', 'b', 'c', 'd']);
  assert.deepEqual(body.submissions, {});
  assert.equal((await (await client.request('/api/session')).json()).authenticated, true);
  const logout = await client.request('/api/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await client.request('/api/submissions/a')).status, 401);
});

test('rejects cross-site mutations and malformed JSON without stopping server', async t => {
  const client = await fixture(t);
  const body = { username: 'student01', password: '123456' };
  assert.equal((await client.request('/api/login', { method: 'POST', body, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await client.request('/api/login', { method: 'POST', body, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await client.request('/api/login', { method: 'POST', body: '{bad' })).status, 400);
  assert.equal((await client.request('/api/login', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await client.request('/api/login')).status, 405);
  assert.equal((await client.request('/api/login', { method: 'POST', body, headers: { Origin: client.baseUrl } })).status, 200);
});

test('uploads persist with correct UTF-8 byte size, can be read and replaced', async t => {
  const client = await fixture(t);
  await client.login();
  assert.equal((await client.request('/api/submissions/a')).status, 404);
  const content = '#include <iostream>\n// 中文测试\nint main() { return 0; }\n';
  const result = await client.request('/api/submissions/a', { method: 'POST', body: { fileName: 'a.cpp', content } });
  assert.equal(result.status, 200);
  const { submission } = await result.json();
  assert.equal(submission.size, Buffer.byteLength(content));
  assert.equal(submission.fileName, 'a.cpp');
  assert.ok(Number.isFinite(Date.parse(submission.submittedAt)));
  assert.equal(submission.content, undefined);
  assert.equal((await (await client.request('/api/submissions/a')).json()).content, content);
  const state = await (await client.request('/api/session')).json();
  assert.deepEqual(state.submissions.a, submission);
  assert.equal(state.submissions.a.content, undefined);
  const secondContent = 'print("new version")\n';
  assert.equal((await client.request('/api/submissions/a', { method: 'POST', body: { fileName: 'a.py', content: secondContent } })).status, 200);
  const saved = await (await client.request('/api/submissions/a')).json();
  assert.equal(saved.fileName, 'a.py');
  assert.equal(saved.content, secondContent);
  const directories = await readdir(client.dataDir);
  assert.equal(directories.length, 1);
  assert.deepEqual(await readdir(path.join(client.dataDir, directories[0])), ['a.json']);
});

test('rejects an oversized chunked request and accepts the next request on the same connection', async t => {
  const client = await fixture(t);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  let connections = 0;
  client.app.on('connection', () => { connections += 1; });
  const response = await client.request('/api/login', {
    method: 'POST',
    body: 'x'.repeat(7 * 1024 * 1024),
    chunked: true,
    agent,
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /1 MB/);
  const following = await client.request('/api/session', { agent });
  assert.equal(following.status, 200);
  assert.deepEqual(await following.json(), { authenticated: false });
  assert.equal(connections, 1, 'the rejected upload must not destroy the keep-alive socket');
});

test('rejects unknown problems, unsafe names, binary, empty and oversized sources', async t => {
  const client = await fixture(t);
  await client.login();
  const submit = (body, problem = 'a') => client.request(`/api/submissions/${problem}`, { method: 'POST', body });
  assert.equal((await submit({ fileName: 'a.cpp', content: 'int main(){}' }, 'z')).status, 404);
  for (const fileName of ['../a.cpp', '..\\a.cpp', 'a.exe', 'a.cpp\0', '.hidden.cpp', 'a.cpp ', 'C:a.cpp']) {
    assert.equal((await submit({ fileName, content: 'source' })).status, 400, fileName);
  }
  for (const content of ['', '  \n\t', '\0binary', null, 15]) {
    assert.equal((await submit({ fileName: 'a.cpp', content })).status, 400);
  }
  assert.equal((await submit({ fileName: 'a.cpp', content: '中'.repeat(350000) })).status, 413);
  assert.equal((await client.request('/api/submissions/a')).status, 404);
  assert.equal((await submit({ fileName: 'a.CPP', content: 'int main(){}' })).status, 200);
});

test('restarting keeps submissions but requires a new login; accounts remain isolated', async t => {
  const client = await fixture(t);
  await client.login();
  await client.request('/api/submissions/b', { method: 'POST', body: { fileName: 'b.cpp', content: 'int main() {return 7;}' } });
  const restarted = await client.start();
  assert.equal((await restarted.request('/api/submissions/b')).status, 401);
  await restarted.login();
  assert.equal((await (await restarted.request('/api/submissions/b')).json()).content, 'int main() {return 7;}');
  const other = await client.start({ username: 'student02' });
  await other.login('student02');
  assert.equal((await other.request('/api/submissions/b')).status, 404);
  assert.deepEqual((await (await other.request('/api/session')).json()).submissions, {});
  await other.request('/api/submissions/b', { method: 'POST', body: { fileName: 'b.py', content: 'print(8)' } });
  assert.equal((await (await restarted.request('/api/submissions/b')).json()).fileName, 'b.cpp');
});

test('authenticated download returns the actual archive with attachment headers', async t => {
  const client = await fixture(t);
  await client.login();
  const response = await client.request('/api/exam/download');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="day1.zip"/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), client.archive);
});

test('expired sessions cannot read or change submissions', async t => {
  const client = await fixture(t, { sessionDurationMs: 30 });
  await client.login();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await (await client.request('/api/session')).json(), { authenticated: false });
  assert.equal((await client.request('/api/exam/download')).status, 401);
});

test('closed exams retain readable submissions but reject new uploads', async t => {
  const client = await fixture(t, { exam: { title: '结束的考试', status: 'ended', password: null, problems: ['a'] } });
  await client.login();
  const result = await client.request('/api/submissions/a', { method: 'POST', body: { fileName: 'a.cpp', content: 'int main(){}' } });
  assert.equal(result.status, 409);
});

test('all 999 default exam accounts log in with their own candidate ID and reject accounts outside the range', async t => {
  const client = await fixture(t, { username: undefined, password: undefined });
  const authenticatedUsers = new Set();
  for (let number = 1; number <= 999; number += 1) {
    const username = `LN-${String(number).padStart(4, '0')}`;
    const response = await client.login(username, 'abc123');
    const session = await response.json();
    assert.equal(session.authenticated, true, username);
    assert.equal(session.user.username, username);
    assert.equal(session.user.candidateId, username);
    assert.deepEqual(session.submissions, {});
    assert.equal(session.accounts, undefined);
    assert.equal(session.user.password, undefined);
    authenticatedUsers.add(session.user.username);
  }
  assert.equal(authenticatedUsers.size, 999);
  for (const username of ['LN-0000', 'LN-1000', 'LN-9999', 'LN-001', 'student01']) {
    const response = await client.request('/api/login', { method: 'POST', body: { username, password: 'abc123' } });
    assert.equal(response.status, 401, username);
  }
  assert.equal((await client.request('/api/login', { method: 'POST', body: { username: 'LN-0001', password: 'wrong123' } })).status, 401);
});

test('simultaneous exam accounts keep sessions, uploads and logout isolated on one server', async t => {
  const first = await fixture(t, { username: undefined, password: undefined });
  const middle = first.newClient();
  const last = first.newClient();
  await Promise.all([
    first.login('LN-0001', 'abc123'),
    middle.login('LN-0500', 'abc123'),
    last.login('LN-0999', 'abc123'),
  ]);
  const post = (client, content) => client.request('/api/submissions/a', { method: 'POST', body: { fileName: 'a.cpp', content } });
  assert.equal((await post(first, 'source of LN-0001')).status, 200);
  assert.equal((await middle.request('/api/submissions/a')).status, 404);
  assert.deepEqual((await (await last.request('/api/session')).json()).submissions, {});
  assert.equal((await post(middle, 'source of LN-0500')).status, 200);
  assert.equal((await post(last, 'source of LN-0999')).status, 200);
  for (const [client, username] of [[first, 'LN-0001'], [middle, 'LN-0500'], [last, 'LN-0999']]) {
    const session = await (await client.request('/api/session')).json();
    assert.equal(session.user.username, username);
    assert.equal((await (await client.request('/api/submissions/a?username=LN-0001')).json()).content, `source of ${username}`);
  }
  assert.equal((await post(middle, 'replacement from LN-0500')).status, 200);
  assert.equal((await (await first.request('/api/submissions/a')).json()).content, 'source of LN-0001');
  assert.equal((await (await last.request('/api/submissions/a')).json()).content, 'source of LN-0999');
  await first.request('/api/logout', { method: 'POST' });
  assert.equal((await first.request('/api/submissions/a')).status, 401);
  assert.equal((await middle.request('/api/submissions/a')).status, 200);
  assert.equal((await last.request('/api/submissions/a')).status, 200);
  assert.equal((await readdir(first.dataDir)).length, 3);

  const restarted = await first.start();
  assert.equal((await restarted.request('/api/submissions/a')).status, 401);
  await restarted.login('LN-0001', 'abc123');
  assert.equal((await (await restarted.request('/api/submissions/a')).json()).content, 'source of LN-0001');
  await restarted.login('LN-0500', 'abc123');
  assert.equal((await (await restarted.request('/api/submissions/a')).json()).content, 'replacement from LN-0500');
});
