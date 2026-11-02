'use strict';
/**
 * 기존 "webpage-magician" 주석검토 데이터 가져오기.
 *  - 기존 서버 URL 에서 직접 가져오기 (/api/products, /api/products/:id/rounds/:r 사용)
 *  - 또는 기존 products.json 파일 업로드
 * 기존 형식: page = { imageDataUrl: 'data:...;base64,...', type: 'image'|'source', name, annotations, nextNum }
 */
const crypto = require('crypto');
const { fetchRemote } = require('./remote');
const { sanitizeAnnotation } = require('./model');
const { emptyRound } = require('./store');
const { extOf } = require('./files');

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mime: m[1] || '', buffer: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8') };
}

function convertPage(pg, files, warnings, label) {
  const decoded = decodeDataUrl(pg.imageDataUrl);
  if (!decoded) { warnings.push(`${label}: 이미지 데이터가 없어 건너뜀`); return null; }
  let name = String(pg.name || '');
  const isSource = pg.type === 'source';
  if (isSource && !extOf(name)) name = (name || 'source') + (decoded.mime.includes('html') ? '.html' : '.txt');
  if (!isSource && !extOf(name)) name = (name || 'image') + '.png';
  let saved;
  try { saved = files.save(decoded.buffer, name); }
  catch (e) { warnings.push(`${label} ("${name}"): ${e.message}`); return null; }
  const ext = extOf(name);
  const type = saved.kind === 'image' ? 'image' : (ext === 'html' || ext === 'htm' ? 'html' : 'code');
  const anns = (pg.annotations || []).map((a, i) => sanitizeAnnotation({ ...a, kind: 'box' }, i)).filter(Boolean);
  return {
    id: crypto.randomUUID(), type, name, file: saved.file, width: null, height: null,
    annotations: anns,
    nextNum: Math.max(Number(pg.nextNum) || 1, anns.reduce((m, a) => Math.max(m, a.number), 0) + 1),
  };
}

function buildProduct(legacyId, name, createdAt, roundsSrc, files, warnings) {
  const rounds = {};
  Object.keys(roundsSrc || {}).filter(k => /^\d+$/.test(k)).forEach(k => {
    const src = roundsSrc[k];
    if (!src) return;
    const rd = emptyRound();
    rd.pages = (src.pages || []).map((pg, i) => convertPage(pg, files, warnings, `${name} ${k}차 ${i + 1}번째 페이지`)).filter(Boolean);
    rd.completed = !!src.completed;
    rd.completedAt = rd.completed ? Date.now() : null;
    rd.updatedAt = src.updatedAt || Date.now();
    rd.revision = 1;
    rounds[k] = rd;
  });
  if (!rounds['1']) rounds['1'] = emptyRound();
  if (!rounds['2']) rounds['2'] = emptyRound();
  return {
    id: crypto.randomUUID(), legacyId, name: String(name || '이름 없음').slice(0, 200),
    createdAt: Number(createdAt) || Date.now(), updatedAt: Date.now(),
    shareToken: crypto.randomBytes(18).toString('base64url'), rounds,
  };
}

function alreadyImported(store, legacyId) {
  return Object.values(store.data.products).some(p => p.legacyId === legacyId && !p.deletedAt);
}

function commit(store, product) {
  store.transact(d => { d.products[product.id] = product; });
}

async function importFromUrl(baseUrl, { store, files, maxBytes, onProgress }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const result = { imported: 0, skipped: 0, warnings: [] };
  const listRes = await fetchRemote(base + '/api/products', { maxBytes: 50 * 1024 * 1024, accept: 'application/json' });
  let list;
  try { list = JSON.parse(listRes.buffer.toString('utf8')); } catch (e) { throw new Error('기존 서버 응답을 해석할 수 없습니다. 주소를 확인하세요.'); }
  if (!Array.isArray(list)) throw new Error('기존 서버에서 제품 목록을 가져오지 못했습니다.');
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    onProgress && onProgress({ done: i, total: list.length, current: p.name });
    if (alreadyImported(store, p.id)) { result.skipped++; continue; }
    const roundsSrc = {};
    for (const r of Object.keys(p.rounds || {})) {
      if (!p.rounds[r]) continue;
      try {
        const rr = await fetchRemote(`${base}/api/products/${encodeURIComponent(p.id)}/rounds/${r}`, { maxBytes: Math.max(maxBytes, 800 * 1024 * 1024), timeoutMs: 180000, accept: 'application/json' });
        const rd = JSON.parse(rr.buffer.toString('utf8'));
        roundsSrc[r] = { pages: rd.pages || [], completed: rd.completed, updatedAt: p.rounds[r].updatedAt };
      } catch (e) {
        result.warnings.push(`${p.name} ${r}차: 가져오기 실패 (${e.message})`);
      }
    }
    commit(store, buildProduct(p.id, p.name, p.createdAt, roundsSrc, files, result.warnings));
    result.imported++;
  }
  onProgress && onProgress({ done: list.length, total: list.length });
  return result;
}

function importFromJson(obj, { store, files, onProgress }) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('products.json 형식이 아닙니다.');
  const result = { imported: 0, skipped: 0, warnings: [] };
  const ids = Object.keys(obj);
  ids.forEach((id, i) => {
    const p = obj[id];
    onProgress && onProgress({ done: i, total: ids.length, current: p && p.name });
    if (!p || typeof p !== 'object' || !p.name) { result.warnings.push(`${id}: 형식 오류로 건너뜀`); return; }
    if (alreadyImported(store, id)) { result.skipped++; return; }
    commit(store, buildProduct(id, p.name, p.createdAt, p.rounds, files, result.warnings));
    result.imported++;
  });
  onProgress && onProgress({ done: ids.length, total: ids.length });
  return result;
}

module.exports = { importFromUrl, importFromJson, decodeDataUrl };
