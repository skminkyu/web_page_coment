'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, HttpError } = require('./util');

const HISTORY_KEEP = 50;

function emptyData() { return { schema: 1, products: {} }; }
function emptyRound() { return { pages: [], completed: false, completedAt: null, updatedAt: null, revision: 0 }; }

function isValidData(d) {
  return d && typeof d === 'object' && d.products && typeof d.products === 'object' && !Array.isArray(d.products);
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/**
 * 메타데이터 저장소 (제품/차수/페이지/주석). 이미지 원본은 FileStore 에 별도 보관한다.
 *
 * 안전 장치
 *  - 모든 쓰기는 "복제본 수정 → 원자적 디스크 저장 → 성공 시에만 메모리 반영" 순서 (transact)
 *  - 저장 직전 파일을 db.json.bak 으로 보존
 *  - 시작 시 db.json 이 손상되었으면 .bak → 최신 백업 순으로 복구
 *  - 그래도 읽을 수 없으면 "안전 모드" 로 전환하여 쓰기를 전면 차단 (빈 데이터로 덮어쓰기 방지)
 */
class Store {
  constructor(dataDir, log) {
    this.dir = dataDir;
    this.log = log || console;
    this.dbFile = path.join(dataDir, 'db.json');
    this.bakFile = path.join(dataDir, 'db.json.bak');
    this.historyDir = path.join(dataDir, 'history');
    this.data = emptyData();
    this.safeMode = null;
    this.recoveredFrom = null;
  }

  /** @param {() => string[]} backupDbCandidates 최신순 백업 db.json 경로 목록 */
  load(backupDbCandidates) {
    fs.mkdirSync(this.dir, { recursive: true });
    const exists = fs.existsSync(this.dbFile);
    const tryRead = (file) => {
      try {
        if (!fs.existsSync(file)) return null;
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        return isValidData(d) ? d : null;
      } catch (e) {
        this.log.error('[store] 읽기 실패', file, e.message);
        return null;
      }
    };

    let d = tryRead(this.dbFile);
    if (d) { this.data = d; return; }

    const candidates = [this.bakFile].concat(backupDbCandidates ? backupDbCandidates() : []);
    if (!exists && !fs.existsSync(this.bakFile)) {
      // 완전히 새로운 설치
      this.data = emptyData();
      this.persist(this.data);
      return;
    }
    for (const c of candidates) {
      d = tryRead(c);
      if (d) {
        this.log.warn('[store] db.json 손상 → 복구 원본:', c);
        if (exists) {
          try { fs.copyFileSync(this.dbFile, this.dbFile + '.corrupt-' + Date.now()); } catch (e) { /* ignore */ }
        }
        this.data = d;
        this.recoveredFrom = path.relative(this.dir, c);
        this.persist(this.data);
        return;
      }
    }
    this.safeMode = '저장된 데이터 파일(db.json)을 읽을 수 없고 복구 가능한 백업도 없습니다. 데이터 보호를 위해 쓰기를 차단했습니다. 관리자에게 문의하세요.';
    this.log.error('[store] 안전 모드 진입:', this.safeMode);
  }

  persist(data) {
    if (this.safeMode) throw new HttpError(503, this.safeMode, 'SAFE_MODE');
    const json = JSON.stringify(data);
    if (fs.existsSync(this.dbFile)) {
      try { fs.copyFileSync(this.dbFile, this.bakFile); } catch (e) { this.log.warn('[store] bak 생성 실패', e.message); }
    }
    writeFileAtomic(this.dbFile, json);
  }

  /** 복제본에 변경을 적용하고 디스크 저장이 성공했을 때만 메모리에 반영한다. */
  transact(fn) {
    if (this.safeMode) throw new HttpError(503, this.safeMode, 'SAFE_MODE');
    const draft = clone(this.data);
    const result = fn(draft);
    try {
      this.persist(draft);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      this.log.error('[store] 저장 실패', e);
      throw new HttpError(507, '서버 디스크에 저장하지 못했습니다 (' + e.code + '). 데이터는 변경되지 않았습니다. 잠시 후 다시 시도하세요.', 'DISK_WRITE_FAILED');
    }
    this.data = draft;
    return result;
  }

  replaceAll(data) {
    if (!isValidData(data)) throw new HttpError(400, '백업 데이터 형식이 올바르지 않습니다.', 'BAD_BACKUP');
    const wasSafe = this.safeMode;
    this.safeMode = null;
    try { this.persist(data); } catch (e) { this.safeMode = wasSafe; throw e; }
    this.data = data;
  }

  // ── 조회 ──
  getProduct(id, includeDeleted) {
    const p = this.data.products[id];
    if (!p || (p.deletedAt && !includeDeleted)) throw new HttpError(404, '제품을 찾을 수 없습니다.', 'NOT_FOUND');
    return p;
  }
  findByShareToken(token) {
    for (const id of Object.keys(this.data.products)) {
      const p = this.data.products[id];
      if (!p.deletedAt && p.shareToken === token) return p;
    }
    throw new HttpError(404, '존재하지 않거나 만료된 공유 링크입니다.', 'NOT_FOUND');
  }

  // ── 히스토리 (차수별 저장 직전 상태 스냅샷) ──
  roundHistoryDir(pid, round) { return path.join(this.historyDir, pid, String(round)); }

  snapshotRound(pid, round, rd) {
    if (!rd || !rd.pages || rd.pages.length === 0) return;
    try {
      const dir = this.roundHistoryDir(pid, round);
      const id = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
      writeFileAtomic(path.join(dir, id + '.json'), JSON.stringify({ id, savedAt: Date.now(), revision: rd.revision, round: rd }));
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
      while (files.length > HISTORY_KEEP) fs.unlinkSync(path.join(dir, files.shift()));
    } catch (e) {
      this.log.warn('[store] 히스토리 저장 실패', e.message);
    }
  }

  listHistory(pid, round) {
    const dir = this.roundHistoryDir(pid, round);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().map(f => {
      try {
        const h = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const pages = (h.round && h.round.pages) || [];
        return {
          id: h.id, savedAt: h.savedAt, revision: h.revision,
          pageCount: pages.length,
          annotCount: pages.reduce((s, p) => s + (p.annotations || []).length, 0),
        };
      } catch (e) { return null; }
    }).filter(Boolean);
  }

  getHistory(pid, round, hid) {
    if (!/^[0-9a-f-]+$/i.test(hid)) throw new HttpError(400, '잘못된 버전 ID', 'BAD_REQUEST');
    const file = path.join(this.roundHistoryDir(pid, round), hid + '.json');
    if (!fs.existsSync(file)) throw new HttpError(404, '해당 버전을 찾을 수 없습니다.', 'NOT_FOUND');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
}

module.exports = { Store, emptyRound, emptyData, isValidData };
