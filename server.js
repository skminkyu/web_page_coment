'use strict';
// 모든 날짜/백업 시각은 한국 시간 기준 (환경변수 TZ 로 변경 가능)
process.env.TZ = process.env.TZ || 'Asia/Seoul';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, emptyRound } = require('./lib/store');
const { FileStore } = require('./lib/files');
const { BackupManager } = require('./lib/backup');
const { fetchRemote } = require('./lib/remote');
const { HttpError } = require('./lib/util');
const { sanitizePages, productSummary, roundMeta, sortedRoundKeys } = require('./lib/model');
const legacy = require('./lib/legacy');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH);
  return path.join(__dirname, 'data');
}

function storageWarning(dataDir) {
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  if (!onRailway) return null;
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!vol) return 'Railway 영구 볼륨(Volume)이 연결되어 있지 않습니다. 재배포·재시작 시 모든 데이터와 백업이 사라집니다. Railway 대시보드에서 Volume을 추가해 주세요.';
  const rel = path.relative(path.resolve(vol), dataDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return `데이터 폴더(${dataDir})가 영구 볼륨(${vol}) 밖에 있습니다. 재배포 시 데이터가 사라질 수 있습니다.`;
  return null;
}

function createApp(opts = {}) {
  const log = opts.log || console;
  const dataDir = opts.dataDir || resolveDataDir();
  const maxUploadBytes = (opts.maxUploadMB || Number(process.env.MAX_UPLOAD_MB) || 30) * 1024 * 1024;
  const appPassword = opts.appPassword !== undefined ? opts.appPassword : (process.env.APP_PASSWORD || '');
  const sessionSecret = crypto.createHash('sha256').update('wpc:' + appPassword).digest('hex');

  fs.mkdirSync(dataDir, { recursive: true });
  const files = new FileStore(dataDir);
  const store = new Store(dataDir, log);
  const backups = new BackupManager({
    dataDir, store, files, log,
    time: opts.backupTime || process.env.BACKUP_TIME || '21:00',
    keep: Number(process.env.BACKUP_KEEP) || 30,
  });
  store.load(() => backups.dbCandidates());
  const warning = opts.storageWarning !== undefined ? opts.storageWarning : storageWarning(dataDir);
  const jobs = new Map();

  // ── helpers ──
  function send(res, status, data, headers) {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
    res.end(JSON.stringify(data));
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > limit) {
        req.resume();
        return reject(new HttpError(413, `파일/요청이 너무 큽니다 (${(declared / 1048576).toFixed(1)}MB). 최대 ${Math.round(limit / 1048576)}MB까지 가능합니다.`, 'TOO_LARGE'));
      }
      const chunks = []; let total = 0; let failed = false;
      req.on('data', c => {
        if (failed) return;
        total += c.length;
        if (total > limit) {
          failed = true;
          reject(new HttpError(413, `파일/요청이 너무 큽니다. 최대 ${Math.round(limit / 1048576)}MB까지 가능합니다.`, 'TOO_LARGE'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
      req.on('error', e => { if (!failed) reject(new HttpError(400, '업로드가 중간에 끊겼습니다: ' + e.message, 'UPLOAD_ABORTED')); });
      req.on('aborted', () => { if (!failed) { failed = true; reject(new HttpError(400, '업로드가 중간에 끊겼습니다.', 'UPLOAD_ABORTED')); } });
    });
  }

  async function readJson(req, limit) {
    const buf = await readBody(req, limit || 10 * 1024 * 1024);
    try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; }
    catch (e) { throw new HttpError(400, '요청 데이터(JSON)가 올바르지 않습니다.', 'BAD_JSON'); }
  }

  function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
  }
  function isAuthed(req) {
    if (!appPassword) return true;
    const c = parseCookies(req).wpc_session;
    return c && c.length === sessionSecret.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(sessionSecret));
  }

  function serveStatic(res, rel) {
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': STATIC_MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  function newShareToken() { return crypto.randomBytes(18).toString('base64url'); }

  function statusPayload() {
    return {
      ok: !store.safeMode,
      safeMode: store.safeMode,
      recoveredFrom: store.recoveredFrom,
      storageWarning: warning,
      dataDir: opts.hideDataDir ? undefined : dataDir,
      maxUploadMB: Math.round(maxUploadBytes / 1048576),
      backup: backups.status(),
      authRequired: !!appPassword,
      serverTime: Date.now(),
    };
  }

  function touchProduct(p) { p.updatedAt = Date.now(); }

  function startJob(fn) {
    const id = crypto.randomUUID();
    const job = { id, status: 'running', progress: null, result: null, error: null, startedAt: Date.now() };
    jobs.set(id, job);
    Promise.resolve()
      .then(() => fn(pr => { job.progress = pr; }))
      .then(r => { job.status = 'done'; job.result = r; })
      .catch(e => { job.status = 'error'; job.error = e.message; log.error('[job]', e); });
    return job;
  }

  // ── routes ──
  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const m = req.method;
    let mt;

    // 공개 리소스 (읽기 전용 뷰어 / 로그인 / 정적 파일)
    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, safeMode: !!store.safeMode });
    if (m === 'GET' && (mt = p.match(/^\/files\/([a-f0-9]{64}\.[a-z0-9]{1,8})$/))) {
      if (!files.exists(mt[1])) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('file not found'); }
      res.writeHead(200, {
        'Content-Type': files.mimeOf(mt[1]),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      return fs.createReadStream(files.pathOf(mt[1])).pipe(res);
    }
    if (m === 'GET' && (mt = p.match(/^\/s\/([A-Za-z0-9_-]{8,64})$/))) return serveStatic(res, 'viewer.html');
    if (m === 'GET' && (mt = p.match(/^\/api\/public\/share\/([A-Za-z0-9_-]{8,64})$/))) {
      const prod = store.findByShareToken(mt[1]);
      const s = productSummary(prod);
      return send(res, 200, { name: s.name, updatedAt: s.updatedAt, rounds: s.rounds });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/public\/share\/([A-Za-z0-9_-]{8,64})\/rounds\/(\d+)$/))) {
      const prod = store.findByShareToken(mt[1]);
      const rd = prod.rounds[mt[2]];
      if (!rd) throw new HttpError(404, '해당 차수가 없습니다.', 'NOT_FOUND');
      return send(res, 200, { pages: rd.pages, completed: !!rd.completed, completedAt: rd.completedAt, updatedAt: rd.updatedAt });
    }
    if (m === 'POST' && p === '/api/login') {
      const body = await readJson(req, 10000);
      if (!appPassword) return send(res, 200, { ok: true });
      const a = crypto.createHash('sha256').update(String(body.password || '')).digest();
      const b = crypto.createHash('sha256').update(appPassword).digest();
      if (!crypto.timingSafeEqual(a, b)) throw new HttpError(401, '비밀번호가 올바르지 않습니다.', 'BAD_PASSWORD');
      return send(res, 200, { ok: true }, { 'Set-Cookie': `wpc_session=${sessionSecret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}` });
    }
    if (m === 'GET' && (p.startsWith('/css/') || p.startsWith('/js/') || p === '/favicon.svg' || p === '/login.html')) return serveStatic(res, p.slice(1));

    // ── 이하 편집 권한 필요 ──
    if (!isAuthed(req)) {
      if (p.startsWith('/api/')) throw new HttpError(401, '로그인이 필요합니다.', 'AUTH_REQUIRED');
      return serveStatic(res, 'login.html');
    }
    if (m === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (m === 'GET' && p === '/api/status') return send(res, 200, statusPayload());

    // 제품 목록 / 생성
    if (p === '/api/products' && m === 'GET') {
      const includeDeleted = u.searchParams.get('deleted') === '1';
      const list = Object.values(store.data.products)
        .filter(x => includeDeleted ? !!x.deletedAt : !x.deletedAt)
        .map(productSummary)
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
      return send(res, 200, list);
    }
    if (p === '/api/products' && m === 'POST') {
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 200);
      if (!name) throw new HttpError(400, '제품명을 입력하세요.', 'BAD_REQUEST');
      const id = crypto.randomUUID();
      const prod = store.transact(d => {
        d.products[id] = { id, name, createdAt: Date.now(), updatedAt: Date.now(), shareToken: newShareToken(), rounds: { '1': emptyRound(), '2': emptyRound() } };
        return d.products[id];
      });
      return send(res, 200, productSummary(prod));
    }

    if ((mt = p.match(/^\/api\/products\/([\w-]+)$/))) {
      const id = mt[1];
      if (m === 'GET') return send(res, 200, productSummary(store.getProduct(id)));
      if (m === 'PATCH') {
        const body = await readJson(req);
        const name = String(body.name || '').trim().slice(0, 200);
        if (!name) throw new HttpError(400, '제품명을 입력하세요.', 'BAD_REQUEST');
        store.getProduct(id);
        store.transact(d => { d.products[id].name = name; touchProduct(d.products[id]); });
        return send(res, 200, { ok: true });
      }
      if (m === 'DELETE') {
        const prod = store.getProduct(id, true);
        if (u.searchParams.get('permanent') === '1') {
          if (!prod.deletedAt) throw new HttpError(400, '휴지통에 있는 제품만 영구 삭제할 수 있습니다.', 'BAD_REQUEST');
          store.transact(d => { delete d.products[id]; });
        } else {
          store.transact(d => { d.products[id].deletedAt = Date.now(); });
        }
        return send(res, 200, { ok: true });
      }
    }
    if (m === 'POST' && (mt = p.match(/^\/api\/products\/([\w-]+)\/restore$/))) {
      store.getProduct(mt[1], true);
      store.transact(d => { delete d.products[mt[1]].deletedAt; touchProduct(d.products[mt[1]]); });
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && (mt = p.match(/^\/api\/products\/([\w-]+)\/share\/reset$/))) {
      store.getProduct(mt[1]);
      const token = store.transact(d => { d.products[mt[1]].shareToken = newShareToken(); return d.products[mt[1]].shareToken; });
      return send(res, 200, { shareToken: token });
    }

    // 차수 추가
    if (m === 'POST' && (mt = p.match(/^\/api\/products\/([\w-]+)\/rounds$/))) {
      const prod = store.getProduct(mt[1]);
      const keys = sortedRoundKeys(prod);
      const next = String((keys.length ? Number(keys[keys.length - 1]) : 0) + 1);
      store.transact(d => { d.products[mt[1]].rounds[next] = emptyRound(); touchProduct(d.products[mt[1]]); });
      return send(res, 200, { round: next });
    }

    if ((mt = p.match(/^\/api\/products\/([\w-]+)\/rounds\/(\d+)$/))) {
      const [, id, r] = mt;
      const prod = store.getProduct(id);
      if (m === 'GET') {
        const rd = prod.rounds[r] || emptyRound();
        return send(res, 200, { pages: rd.pages, completed: !!rd.completed, completedAt: rd.completedAt, updatedAt: rd.updatedAt, revision: rd.revision || 0 });
      }
      if (m === 'PUT') {
        const body = await readJson(req);
        const cur = prod.rounds[r] || emptyRound();
        if (cur.completed) throw new HttpError(423, `${r}차는 완료 처리되어 수정할 수 없습니다. 수정하려면 먼저 '완료 취소'를 하세요.`, 'ROUND_COMPLETED');
        if (Number(body.baseRevision) !== (cur.revision || 0)) {
          throw new HttpError(409, '다른 사람(또는 다른 창)이 이 차수를 먼저 저장했습니다.', 'CONFLICT', { serverRevision: cur.revision || 0, serverUpdatedAt: cur.updatedAt });
        }
        const pages = sanitizePages(body.pages, files);
        if (cur.pages.length > 0 && pages.length < cur.pages.length && !body.allowShrink) {
          throw new HttpError(409, `저장하면 페이지가 ${cur.pages.length}개 → ${pages.length}개로 줄어듭니다. 의도한 것이 맞는지 확인이 필요합니다.`, 'SHRINK_GUARD', { from: cur.pages.length, to: pages.length });
        }
        store.snapshotRound(id, r, cur);
        const saved = store.transact(d => {
          const prev = d.products[id].rounds[r] || emptyRound();
          d.products[id].rounds[r] = Object.assign({}, prev, { pages, updatedAt: Date.now(), revision: (prev.revision || 0) + 1 });
          touchProduct(d.products[id]);
          return d.products[id].rounds[r];
        });
        return send(res, 200, { ok: true, revision: saved.revision, updatedAt: saved.updatedAt, meta: roundMeta(saved) });
      }
      if (m === 'DELETE') {
        const rd = prod.rounds[r];
        if (!rd) throw new HttpError(404, '해당 차수가 없습니다.', 'NOT_FOUND');
        if (rd.pages.length) throw new HttpError(400, '내용이 있는 차수는 삭제할 수 없습니다. 페이지를 먼저 모두 지워주세요.', 'NOT_EMPTY');
        if (sortedRoundKeys(prod).length <= 1) throw new HttpError(400, '마지막 차수는 삭제할 수 없습니다.', 'BAD_REQUEST');
        store.transact(d => { delete d.products[id].rounds[r]; touchProduct(d.products[id]); });
        return send(res, 200, { ok: true });
      }
    }
    if (m === 'PATCH' && (mt = p.match(/^\/api\/products\/([\w-]+)\/rounds\/(\d+)\/complete$/))) {
      const [, id, r] = mt;
      store.getProduct(id);
      const body = await readJson(req);
      const meta = store.transact(d => {
        const prod = d.products[id];
        if (!prod.rounds[r]) prod.rounds[r] = emptyRound();
        prod.rounds[r].completed = !!body.completed;
        prod.rounds[r].completedAt = body.completed ? Date.now() : null;
        touchProduct(prod);
        return roundMeta(prod.rounds[r]);
      });
      return send(res, 200, { ok: true, meta });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/products\/([\w-]+)\/rounds\/(\d+)\/history$/))) {
      store.getProduct(mt[1]);
      return send(res, 200, store.listHistory(mt[1], mt[2]));
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/products\/([\w-]+)\/rounds\/(\d+)\/history\/([\w-]+)$/))) {
      store.getProduct(mt[1]);
      const h = store.getHistory(mt[1], mt[2], mt[3]);
      return send(res, 200, { id: h.id, savedAt: h.savedAt, pages: (h.round && h.round.pages) || [] });
    }

    // 파일 업로드 (원본 바이너리). 실패해도 기존 데이터에는 아무 영향이 없다.
    if (m === 'POST' && p === '/api/files') {
      if (store.safeMode) throw new HttpError(503, store.safeMode, 'SAFE_MODE');
      const name = String(u.searchParams.get('name') || 'file').slice(0, 200);
      const buf = await readBody(req, maxUploadBytes);
      try {
        return send(res, 200, files.save(buf, name));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(507, '서버에 파일을 저장하지 못했습니다 (' + (e.code || e.message) + ').', 'DISK_WRITE_FAILED');
      }
    }
    if (m === 'POST' && p === '/api/files/from-url') {
      if (store.safeMode) throw new HttpError(503, store.safeMode, 'SAFE_MODE');
      const body = await readJson(req);
      const r = await fetchRemote(String(body.url || ''), { maxBytes: maxUploadBytes, accept: 'image/*,*/*;q=0.5' });
      let name = String(body.name || '').trim();
      if (!name) {
        name = decodeURIComponent(new URL(r.finalUrl).pathname.split('/').pop() || 'image');
        if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.' + ((r.contentType.match(/image\/(\w+)/) || [])[1] || 'jpg');
      }
      const saved = files.save(r.buffer, name.slice(0, 120));
      if (saved.kind !== 'image') throw new HttpError(415, '해당 주소는 이미지가 아닙니다. 이미지 파일의 직접 주소인지 확인하세요.', 'NOT_IMAGE');
      return send(res, 200, Object.assign({ name: name.slice(0, 120) }, saved));
    }

    // 백업
    if (p === '/api/backups' && m === 'GET') return send(res, 200, { status: backups.status(), list: backups.list() });
    if (p === '/api/backups' && m === 'POST') {
      if (store.safeMode) throw new HttpError(503, '안전 모드에서는 새 백업을 만들 수 없습니다 (기존 백업 보호).', 'SAFE_MODE');
      const meta = backups.create('manual');
      return send(res, 200, meta);
    }
    if ((mt = p.match(/^\/api\/backups\/([\w-]+)\/download$/)) && m === 'GET') { await backups.download(mt[1], res); return; }
    if ((mt = p.match(/^\/api\/backups\/([\w-]+)\/restore$/)) && m === 'POST') return send(res, 200, backups.restore(mt[1]));
    if ((mt = p.match(/^\/api\/backups\/([\w-]+)$/)) && m === 'DELETE') { backups.remove(mt[1]); return send(res, 200, { ok: true }); }

    // 기존 시스템 데이터 가져오기
    if (m === 'POST' && p === '/api/import/legacy-url') {
      if (store.safeMode) throw new HttpError(503, store.safeMode, 'SAFE_MODE');
      const body = await readJson(req);
      if (!body.url) throw new HttpError(400, '기존 서버 주소를 입력하세요.', 'BAD_REQUEST');
      backups.create('pre-import');
      const job = startJob(onProgress => legacy.importFromUrl(body.url, { store, files, maxBytes: maxUploadBytes, onProgress }));
      return send(res, 200, { jobId: job.id });
    }
    if (m === 'POST' && p === '/api/import/legacy-file') {
      if (store.safeMode) throw new HttpError(503, store.safeMode, 'SAFE_MODE');
      const buf = await readBody(req, 500 * 1024 * 1024);
      let obj;
      try { obj = JSON.parse(buf.toString('utf8')); } catch (e) { throw new HttpError(400, 'JSON 파일을 해석할 수 없습니다. products.json 파일이 맞는지 확인하세요.', 'BAD_JSON'); }
      backups.create('pre-import');
      const job = startJob(onProgress => legacy.importFromJson(obj, { store, files, onProgress }));
      return send(res, 200, { jobId: job.id });
    }
    if (m === 'GET' && (mt = p.match(/^\/api\/import\/jobs\/([\w-]+)$/))) {
      const job = jobs.get(mt[1]);
      if (!job) throw new HttpError(404, '작업을 찾을 수 없습니다.', 'NOT_FOUND');
      return send(res, 200, job);
    }

    if (p.startsWith('/api/')) throw new HttpError(404, '알 수 없는 요청입니다: ' + m + ' ' + p, 'NOT_FOUND');
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (res.headersSent) { try { res.end(); } catch (e) { /* ignore */ } return; }
      if (err instanceof HttpError) {
        return send(res, err.status, Object.assign({ error: err.message, code: err.code }, err.extra || {}));
      }
      log.error('[server] 처리 중 오류', req.method, req.url, err);
      send(res, 500, { error: '서버 내부 오류: ' + err.message, code: 'INTERNAL' });
    });
  });
  server.requestTimeout = 10 * 60 * 1000;

  return { server, store, files, backups, dataDir };
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 8080;
  app.backups.start();
  app.server.listen(port, () => {
    const st = app.backups.status();
    console.log('');
    console.log('  상세페이지 주석 검토 서버 실행 중');
    console.log('  주소     : http://localhost:' + port);
    console.log('  데이터   : ' + app.dataDir);
    console.log('  자동백업 : 매일 ' + st.time + ' (' + process.env.TZ + ')');
    if (app.store.safeMode) console.log('  ⚠ 안전 모드: ' + app.store.safeMode);
    console.log('');
  });
  process.on('uncaughtException', e => console.error('[uncaughtException]', e));
  process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
  const shutdown = () => { app.backups.stop(); app.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp };
