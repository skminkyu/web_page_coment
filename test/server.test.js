'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createApp } = require('../server');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const quiet = { log() {}, warn() {}, error() {} };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-test-')); }

async function start(dataDir, extra) {
  const app = createApp(Object.assign({ dataDir, log: quiet, storageWarning: null, appPassword: '' }, extra || {}));
  await new Promise(r => app.server.listen(0, r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const req = async (method, url, body, headers) => {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      headers: Object.assign(body !== undefined ? { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json' } : {}, headers || {}),
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { app, base, req, close: () => new Promise(r => app.server.close(r)) };
}

async function seed(s) {
  const p = (await s.req('POST', '/api/products', { name: '테스트 제품' })).data;
  const up = (await s.req('POST', '/api/files?name=a.png', PNG)).data;
  const pages = [{ id: 'p1', type: 'image', name: 'a.png', file: up.file, annotations: [{ id: 'a1', number: 1, kind: 'box', color: '#e5484d', comment: '수정', x: .1, y: .1, width: .2, height: .2 }], nextNum: 2 }];
  const put = await s.req('PUT', `/api/products/${p.id}/rounds/1`, { pages, baseRevision: 0 });
  assert.strictEqual(put.status, 200, JSON.stringify(put.data));
  return { p, up, pages };
}

test('제품 생성 / 업로드 / 저장 / 공유 읽기전용', async () => {
  const s = await start(tmpDir());
  try {
    const { p } = await seed(s);
    const list = (await s.req('GET', '/api/products')).data;
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual(Object.keys(list[0].rounds), ['1', '2']);
    assert.strictEqual(list[0].rounds['1'].annotCount, 1);

    const share = await s.req('GET', `/api/public/share/${p.shareToken}`);
    assert.strictEqual(share.status, 200);
    assert.strictEqual(share.data.name, '테스트 제품');
    const sr = await s.req('GET', `/api/public/share/${p.shareToken}/rounds/1`);
    assert.strictEqual(sr.data.pages[0].annotations[0].comment, '수정');
    // 공유 API 에는 쓰기 경로가 없다
    assert.strictEqual((await s.req('PUT', `/api/public/share/${p.shareToken}/rounds/1`, { pages: [] })).status, 404);
    // 재발급 후 기존 토큰 무효
    const reset = await s.req('POST', `/api/products/${p.id}/share/reset`);
    assert.strictEqual((await s.req('GET', `/api/public/share/${p.shareToken}`)).status, 404);
    assert.strictEqual((await s.req('GET', `/api/public/share/${reset.data.shareToken}`)).status, 200);
  } finally { await s.close(); }
});

test('잘못된 파일 업로드는 거부되고 기존 데이터는 그대로', async () => {
  const s = await start(tmpDir(), { maxUploadMB: 1 });
  try {
    const { p } = await seed(s);
    const bad1 = await s.req('POST', '/api/files?name=photo.jpg', Buffer.from('this is not an image at all'));
    assert.strictEqual(bad1.status, 415);
    assert.match(bad1.data.error, /이미지가 아닙니다/);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(20)]);
    const bad2 = await s.req('POST', '/api/files?name=IMG_0001.HEIC', heic);
    assert.strictEqual(bad2.status, 415);
    assert.strictEqual(bad2.data.code, 'UNSUPPORTED_HEIC');
    const big = await s.req('POST', '/api/files?name=big.png', Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
    assert.strictEqual(big.status, 413);
    const empty = await s.req('POST', '/api/files?name=x.png', Buffer.alloc(0));
    assert.strictEqual(empty.status, 400);

    // 존재하지 않는 파일을 참조하는 페이지 저장 → 거부, 기존 데이터 유지
    const bad = await s.req('PUT', `/api/products/${p.id}/rounds/1`, {
      baseRevision: 1, pages: [{ type: 'image', name: 'ghost.png', file: 'f'.repeat(64) + '.png', annotations: [] }],
    });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.data.code, 'INVALID_PAGES');
    const rd = (await s.req('GET', `/api/products/${p.id}/rounds/1`)).data;
    assert.strictEqual(rd.pages.length, 1);
    assert.strictEqual(rd.pages[0].annotations[0].comment, '수정');
  } finally { await s.close(); }
});

test('동시 수정 충돌 / 페이지 감소 확인 / 완료 차수 잠금 / 버전 기록', async () => {
  const s = await start(tmpDir());
  try {
    const { p, pages } = await seed(s);
    const stale = await s.req('PUT', `/api/products/${p.id}/rounds/1`, { pages, baseRevision: 0 });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.data.code, 'CONFLICT');

    const shrink = await s.req('PUT', `/api/products/${p.id}/rounds/1`, { pages: [], baseRevision: 1 });
    assert.strictEqual(shrink.status, 409);
    assert.strictEqual(shrink.data.code, 'SHRINK_GUARD');
    assert.strictEqual((await s.req('GET', `/api/products/${p.id}/rounds/1`)).data.pages.length, 1);

    await s.req('PATCH', `/api/products/${p.id}/rounds/1/complete`, { completed: true });
    const locked = await s.req('PUT', `/api/products/${p.id}/rounds/1`, { pages, baseRevision: 1 });
    assert.strictEqual(locked.status, 423);
    await s.req('PATCH', `/api/products/${p.id}/rounds/1/complete`, { completed: false });

    const ok = await s.req('PUT', `/api/products/${p.id}/rounds/1`, { pages: [], baseRevision: 1, allowShrink: true });
    assert.strictEqual(ok.status, 200);
    const hist = (await s.req('GET', `/api/products/${p.id}/rounds/1/history`)).data;
    assert.strictEqual(hist.length, 1);
    const v = (await s.req('GET', `/api/products/${p.id}/rounds/1/history/${hist[0].id}`)).data;
    assert.strictEqual(v.pages.length, 1);
  } finally { await s.close(); }
});

test('db.json 손상 시 .bak 으로 자동 복구 / 복구 불가 시 안전 모드', async () => {
  const dir = tmpDir();
  let s = await start(dir);
  await seed(s);
  await s.req('POST', '/api/products', { name: '두번째' });
  await s.close();

  fs.writeFileSync(path.join(dir, 'db.json'), '{"products": {broken');
  s = await start(dir);
  try {
    const st = (await s.req('GET', '/api/status')).data;
    assert.strictEqual(st.safeMode, null);
    assert.ok(st.recoveredFrom);
    assert.ok((await s.req('GET', '/api/products')).data.length >= 1);
  } finally { await s.close(); }

  fs.writeFileSync(path.join(dir, 'db.json'), 'garbage');
  fs.writeFileSync(path.join(dir, 'db.json.bak'), 'garbage');
  fs.rmSync(path.join(dir, 'backups'), { recursive: true, force: true });
  s = await start(dir);
  try {
    const st = (await s.req('GET', '/api/status')).data;
    assert.ok(st.safeMode);
    const w = await s.req('POST', '/api/products', { name: 'x' });
    assert.strictEqual(w.status, 503);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), 'garbage', '손상된 원본을 빈 데이터로 덮어쓰면 안 됨');
  } finally { await s.close(); }
});

test('매일 21:00 자동 백업 / 따라잡기 / 복원 / 다운로드', async () => {
  const dir = tmpDir();
  const s = await start(dir);
  try {
    const { p } = await seed(s);
    const bm = s.app.backups;
    assert.strictEqual(bm.tick(new Date(2026, 10, 2, 20, 59)), null, '21시 전에는 백업 안 함');
    const m = bm.tick(new Date(2026, 10, 2, 21, 0));
    assert.ok(m && m.name === 'auto-2026-11-02');
    assert.strictEqual(m.productCount, 1);
    assert.strictEqual(bm.tick(new Date(2026, 10, 2, 22, 0)), null, '하루 한 번만');
    // 21시에 서버가 꺼져 있다가 23시에 켜진 경우 → 즉시 백업
    assert.ok(bm.tick(new Date(2026, 10, 3, 23, 10)).name === 'auto-2026-11-03');
    assert.ok(fs.existsSync(path.join(dir, 'backups', 'auto-2026-11-02', 'files')));

    // 데이터 삭제 후 복원
    await s.req('DELETE', `/api/products/${p.id}`);
    await s.req('DELETE', `/api/products/${p.id}?permanent=1`);
    assert.strictEqual((await s.req('GET', '/api/products')).data.length, 0);
    const r = await s.req('POST', '/api/backups/auto-2026-11-02/restore');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.preRestoreBackup);
    assert.strictEqual((await s.req('GET', '/api/products')).data.length, 1);

    const dl = await fetch(s.base + '/api/backups/auto-2026-11-02/download');
    assert.strictEqual(dl.status, 200);
    const tar = zlib.gunzipSync(Buffer.from(await dl.arrayBuffer()));
    assert.ok(tar.includes(Buffer.from('db.json')));

    const st = bm.status();
    assert.strictEqual(st.time, '21:00');
  } finally { await s.close(); }
});

test('휴지통: 삭제 → 공유 링크 차단 → 복원', async () => {
  const s = await start(tmpDir());
  try {
    const { p } = await seed(s);
    await s.req('DELETE', `/api/products/${p.id}`);
    assert.strictEqual((await s.req('GET', `/api/public/share/${p.shareToken}`)).status, 404);
    assert.strictEqual((await s.req('GET', '/api/products?deleted=1')).data.length, 1);
    await s.req('POST', `/api/products/${p.id}/restore`);
    assert.strictEqual((await s.req('GET', `/api/public/share/${p.shareToken}`)).status, 200);
  } finally { await s.close(); }
});

test('기존 webpage-magician products.json 가져오기', async () => {
  const s = await start(tmpDir());
  try {
    const legacy = {
      'old-1': { name: '기존 제품', createdAt: 1, rounds: { '1': { completed: true, pages: [
        { imageDataUrl: 'data:image/png;base64,' + PNG.toString('base64'), type: 'image', name: 'x.png', annotations: [{ id: 5, number: 1, color: '#e53e3e', comment: '옛 주석', x: .1, y: .1, width: .1, height: .1 }], nextNum: 2 },
        { imageDataUrl: 'data:text/html;base64,' + Buffer.from('<h1>hi</h1>').toString('base64'), type: 'source', name: 'a.html', annotations: [] },
      ] } } },
    };
    const r = await s.req('POST', '/api/import/legacy-file', Buffer.from(JSON.stringify(legacy)));
    assert.strictEqual(r.status, 200);
    let job;
    for (let i = 0; i < 50; i++) {
      job = (await s.req('GET', '/api/import/jobs/' + r.data.jobId)).data;
      if (job.status !== 'running') break;
      await new Promise(res => setTimeout(res, 50));
    }
    assert.strictEqual(job.status, 'done', job.error);
    assert.strictEqual(job.result.imported, 1);
    const list = (await s.req('GET', '/api/products')).data;
    const rd = (await s.req('GET', `/api/products/${list[0].id}/rounds/1`)).data;
    assert.strictEqual(rd.completed, true);
    assert.strictEqual(rd.pages[0].annotations[0].comment, '옛 주석');
    assert.strictEqual(rd.pages[1].type, 'html');
  } finally { await s.close(); }
});

test('APP_PASSWORD 설정 시 편집 API 보호, 공유 링크는 공개', async () => {
  const s = await start(tmpDir(), { appPassword: 'secret' });
  try {
    assert.strictEqual((await s.req('GET', '/api/products')).status, 401);
    assert.strictEqual((await s.req('POST', '/api/login', { password: 'nope' })).status, 401);
    const ok = await s.req('POST', '/api/login', { password: 'secret' });
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.strictEqual((await s.req('GET', '/api/products', undefined, { Cookie: cookie })).status, 200);
  } finally { await s.close(); }
});

test('완료 판정: 어느 차수든 완료 값이 있으면 완료 제품', async () => {
  const s = await start(tmpDir());
  try {
    const { p } = await seed(s);
    assert.strictEqual((await s.req('GET', '/api/products')).data[0].completed, false);
    await s.req('PATCH', `/api/products/${p.id}/rounds/2/complete`, { completed: true }); // 내용 없는 2차만 완료
    assert.strictEqual((await s.req('GET', '/api/products')).data[0].completed, true);
  } finally { await s.close(); }
});

test('완료 제품만 따로 백업 → 다른 제품은 건드리지 않고 되살리기', async () => {
  const dir = tmpDir();
  const s = await start(dir);
  try {
    const { p } = await seed(s);
    const other = (await s.req('POST', '/api/products', { name: '진행중 제품' })).data;
    assert.strictEqual((await s.req('POST', '/api/backups', { scope: 'completed' })).status, 400, '완료 제품이 없으면 거부');
    await s.req('PATCH', `/api/products/${p.id}/rounds/1/complete`, { completed: true });
    const b = await s.req('POST', '/api/backups', { scope: 'completed' });
    assert.strictEqual(b.status, 200, JSON.stringify(b.data));
    assert.strictEqual(b.data.kind, 'completed');
    assert.strictEqual(b.data.productCount, 1);
    assert.strictEqual(b.data.fileCount, 1);
    const db = JSON.parse(fs.readFileSync(path.join(dir, 'backups', b.data.name, 'db.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(db.products), [p.id]);

    // 완료 제품 영구 삭제 후, 완료 백업에서 되살리기 → 다른 제품은 유지
    await s.req('DELETE', `/api/products/${p.id}`);
    await s.req('DELETE', `/api/products/${p.id}?permanent=1`);
    const r = await s.req('POST', `/api/backups/${b.data.name}/restore`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.merged, 1);
    const names = (await s.req('GET', '/api/products')).data.map(x => x.name).sort();
    assert.deepStrictEqual(names, ['진행중 제품', '테스트 제품']);
    assert.ok(other.id);
    // 자동 정리 대상이 아님
    s.app.backups.prune();
    assert.ok(s.app.backups.list().some(m => m.name === b.data.name));
  } finally { await s.close(); }
});

test('썸네일: 작은 webp 생성 (sharp 없으면 원본으로 이동)', async () => {
  const s = await start(tmpDir());
  try {
    const { up } = await seed(s);
    const res = await fetch(s.base + '/thumbs/' + up.file, { redirect: 'manual' });
    if (s.app.thumbs.available) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'image/webp');
    } else {
      assert.strictEqual(res.status, 302);
    }
    const txt = (await s.req('POST', '/api/files?name=a.css', Buffer.from('a{}'))).data;
    const r2 = await fetch(s.base + '/thumbs/' + txt.file, { redirect: 'manual' });
    assert.strictEqual(r2.status, 302, '이미지가 아니면 원본으로');
  } finally { await s.close(); }
});
