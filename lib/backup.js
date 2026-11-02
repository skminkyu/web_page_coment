'use strict';
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, ymd, hms, HttpError, copyDir } = require('./util');
const { writeTarGz } = require('./tar');

const NAME_RE = /^(auto|manual|pre-restore|pre-import)-[0-9_-]+$/;

/**
 * 백업 관리자
 *  - 매일 지정 시각(기본 21:00, Asia/Seoul)에 자동 백업
 *  - 서버가 그 시각에 꺼져 있었다면, 같은 날 서버가 켜지는 즉시 따라잡아 백업
 *  - 업로드 파일은 불변(내용 해시 이름)이므로 하드링크로 백업 → 디스크 사용량 최소화
 *  - 자동 백업은 최근 N개 보관
 */
class BackupManager {
  constructor({ dataDir, store, files, time, keep, log }) {
    this.dir = path.join(dataDir, 'backups');
    this.store = store;
    this.files = files;
    this.log = log || console;
    this.keep = keep || 30;
    const m = String(time || '21:00').match(/^(\d{1,2}):(\d{2})$/);
    this.hour = m ? Math.min(23, Number(m[1])) : 21;
    this.minute = m ? Math.min(59, Number(m[2])) : 0;
    this.timer = null;
    this.lastError = null;
    this.running = false;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  get timeLabel() { return String(this.hour).padStart(2, '0') + ':' + String(this.minute).padStart(2, '0'); }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 30 * 1000);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  todayAutoName(now) { return 'auto-' + ymd(now || new Date()); }

  tick(now) {
    now = now || new Date();
    const due = now.getHours() * 60 + now.getMinutes() >= this.hour * 60 + this.minute;
    if (!due) return null;
    const name = this.todayAutoName(now);
    if (fs.existsSync(path.join(this.dir, name))) return null;
    if (this.store.safeMode) {
      this.lastError = { at: Date.now(), message: '안전 모드라서 자동 백업을 건너뛰었습니다.' };
      return null;
    }
    try {
      const meta = this.create('auto', now);
      this.prune();
      return meta;
    } catch (e) {
      this.lastError = { at: Date.now(), message: e.message };
      this.log.error('[backup] 자동 백업 실패', e);
      return null;
    }
  }

  nextRun(now) {
    now = now || new Date();
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.hour, this.minute, 0, 0);
    if (now >= t && fs.existsSync(path.join(this.dir, this.todayAutoName(now)))) t.setDate(t.getDate() + 1);
    else if (now >= t) return now.getTime();
    return t.getTime();
  }

  create(kind, now) {
    if (this.running) throw new HttpError(409, '다른 백업이 진행 중입니다. 잠시 후 다시 시도하세요.', 'BACKUP_BUSY');
    this.running = true;
    try {
      now = now || new Date();
      const name = kind === 'auto' ? this.todayAutoName(now) : kind + '-' + ymd(now) + '_' + hms(now);
      const finalDir = path.join(this.dir, name);
      if (fs.existsSync(finalDir)) throw new HttpError(409, '같은 이름의 백업이 이미 있습니다. 1초 후 다시 시도하세요.', 'BACKUP_EXISTS');
      const tmpDir = path.join(this.dir, '.tmp-' + name);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(tmpDir, 'files'), { recursive: true });

      const data = this.store.data;
      writeFileAtomic(path.join(tmpDir, 'db.json'), JSON.stringify(data));
      let linked = 0, bytes = 0;
      for (const f of this.files.list()) {
        const src = path.join(this.files.dir, f), dst = path.join(tmpDir, 'files', f);
        try { fs.linkSync(src, dst); } catch (e) { fs.copyFileSync(src, dst); }
        linked++;
        try { bytes += fs.statSync(src).size; } catch (e) { /* ignore */ }
      }
      try { copyDir(this.store.historyDir, path.join(tmpDir, 'history')); } catch (e) { this.log.warn('[backup] 히스토리 복사 실패', e.message); }

      const products = Object.values(data.products || {}).filter(p => !p.deletedAt);
      let pageCount = 0, annotCount = 0;
      products.forEach(p => Object.values(p.rounds || {}).forEach(r => {
        pageCount += (r.pages || []).length;
        (r.pages || []).forEach(pg => { annotCount += (pg.annotations || []).length; });
      }));
      const meta = {
        name, kind, createdAt: now.getTime(),
        productCount: products.length, pageCount, annotCount,
        fileCount: linked, bytes: bytes + Buffer.byteLength(JSON.stringify(data)),
      };
      writeFileAtomic(path.join(tmpDir, 'meta.json'), JSON.stringify(meta, null, 2));
      fs.renameSync(tmpDir, finalDir);
      this.lastError = null;
      this.log.log('[backup] 완료:', name, `제품 ${meta.productCount} · 페이지 ${pageCount} · 주석 ${annotCount}`);
      return meta;
    } finally {
      this.running = false;
    }
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter(n => NAME_RE.test(n))
      .map(n => {
        try { return JSON.parse(fs.readFileSync(path.join(this.dir, n, 'meta.json'), 'utf8')); }
        catch (e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 최신순 백업 db.json 경로 (Store 복구용) */
  dbCandidates() {
    return this.list().map(m => path.join(this.dir, m.name, 'db.json'));
  }

  prune() {
    if (this.store.safeMode) return;
    const autos = this.list().filter(m => m.kind === 'auto');
    autos.slice(this.keep).forEach(m => this.remove(m.name, true));
    const others = this.list().filter(m => m.kind !== 'auto' && m.kind !== 'manual');
    others.slice(20).forEach(m => this.remove(m.name, true));
  }

  dirOf(name) {
    if (!NAME_RE.test(String(name || ''))) throw new HttpError(400, '잘못된 백업 이름', 'BAD_REQUEST');
    const d = path.join(this.dir, name);
    if (!fs.existsSync(path.join(d, 'meta.json'))) throw new HttpError(404, '백업을 찾을 수 없습니다.', 'NOT_FOUND');
    return d;
  }

  remove(name, internal) {
    const d = this.dirOf(name);
    if (!internal && this.list().length <= 1) throw new HttpError(400, '마지막 남은 백업은 삭제할 수 없습니다.', 'LAST_BACKUP');
    fs.rmSync(d, { recursive: true, force: true });
  }

  restore(name) {
    const d = this.dirOf(name);
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(d, 'db.json'), 'utf8')); }
    catch (e) { throw new HttpError(500, '백업 파일이 손상되어 복원할 수 없습니다: ' + e.message, 'BAD_BACKUP'); }
    // 복원 직전 현재 상태를 백업 (안전 모드가 아닐 때만 의미 있음)
    let pre = null;
    if (!this.store.safeMode) pre = this.create('pre-restore');
    const filesDir = path.join(d, 'files');
    if (fs.existsSync(filesDir)) {
      for (const f of fs.readdirSync(filesDir)) {
        const dst = path.join(this.files.dir, f);
        if (!fs.existsSync(dst)) {
          try { fs.linkSync(path.join(filesDir, f), dst); } catch (e) { fs.copyFileSync(path.join(filesDir, f), dst); }
        }
      }
    }
    const hist = path.join(d, 'history');
    if (fs.existsSync(hist)) { try { copyDir(hist, this.store.historyDir); } catch (e) { /* ignore */ } }
    this.store.replaceAll(data);
    return { restored: name, preRestoreBackup: pre && pre.name };
  }

  async download(name, res) {
    const d = this.dirOf(name);
    const entries = [
      { name: 'meta.json', path: path.join(d, 'meta.json') },
      { name: 'db.json', path: path.join(d, 'db.json') },
    ];
    const fd = path.join(d, 'files');
    if (fs.existsSync(fd)) fs.readdirSync(fd).forEach(f => entries.push({ name: 'files/' + f, path: path.join(fd, f) }));
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="web-comment-backup-${name}.tar.gz"`,
    });
    await writeTarGz(entries, res);
  }

  status() {
    const list = this.list();
    const lastAuto = list.find(m => m.kind === 'auto');
    return {
      time: this.timeLabel,
      timezone: process.env.TZ,
      keep: this.keep,
      last: list[0] || null,
      lastAuto: lastAuto || null,
      nextRun: this.nextRun(),
      lastError: this.lastError,
      count: list.length,
    };
  }
}

module.exports = { BackupManager };
