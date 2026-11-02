'use strict';
const crypto = require('crypto');
const { HttpError } = require('./util');

const PAGE_TYPES = ['image', 'html', 'code'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function clamp01(n) { n = Number(n); if (!isFinite(n)) return 0; return Math.max(0, Math.min(1, n)); }
function str(v, max) { return String(v == null ? '' : v).slice(0, max); }

function sanitizeAnnotation(a, i) {
  if (!a || typeof a !== 'object') return null;
  const kind = a.kind === 'pin' ? 'pin' : 'box';
  const x = clamp01(a.x), y = clamp01(a.y);
  const out = {
    id: str(a.id || crypto.randomUUID(), 64),
    number: Math.max(1, Math.floor(Number(a.number)) || i + 1),
    kind,
    color: COLOR_RE.test(a.color) ? a.color : '#e5484d',
    comment: str(a.comment, 10000),
    done: !!a.done,
    x, y,
    width: kind === 'pin' ? 0 : Math.min(clamp01(a.width), 1 - x),
    height: kind === 'pin' ? 0 : Math.min(clamp01(a.height), 1 - y),
    createdAt: Number(a.createdAt) || Date.now(),
  };
  return out;
}

/**
 * 클라이언트가 보낸 페이지 배열 검증. 참조 파일이 실제로 서버에 없으면 저장을 거부한다.
 * (깨진 이미지가 저장되어 데이터가 망가지는 것을 원천 차단)
 */
function sanitizePages(pages, files) {
  if (!Array.isArray(pages)) throw new HttpError(400, 'pages 형식이 올바르지 않습니다.', 'BAD_REQUEST');
  if (pages.length > 500) throw new HttpError(400, '한 차수에 페이지는 최대 500개까지 가능합니다.', 'TOO_MANY_PAGES');
  const problems = [];
  const out = pages.map((p, i) => {
    if (!p || typeof p !== 'object') { problems.push(`${i + 1}번째 페이지 데이터가 비어 있습니다.`); return null; }
    const type = PAGE_TYPES.includes(p.type) ? p.type : 'image';
    if (!files.exists(p.file)) {
      problems.push(`${i + 1}번째 페이지("${str(p.name, 80) || '이름 없음'}")의 파일이 서버에 없습니다. 업로드가 완료되지 않았거나 실패했습니다.`);
      return null;
    }
    const anns = Array.isArray(p.annotations) ? p.annotations.slice(0, 2000).map(sanitizeAnnotation).filter(Boolean) : [];
    const maxNum = anns.reduce((m, a) => Math.max(m, a.number), 0);
    return {
      id: str(p.id || crypto.randomUUID(), 64),
      type,
      name: str(p.name, 200),
      file: p.file,
      width: Number(p.width) > 0 ? Math.round(Number(p.width)) : null,
      height: Number(p.height) > 0 ? Math.round(Number(p.height)) : null,
      annotations: anns,
      nextNum: Math.max(maxNum + 1, Math.floor(Number(p.nextNum)) || 1),
    };
  });
  if (problems.length) throw new HttpError(400, '저장할 수 없습니다. 문제가 있는 페이지가 있습니다.', 'INVALID_PAGES', { problems });
  return out;
}

function roundMeta(rd) {
  if (!rd) return null;
  const pages = rd.pages || [];
  return {
    pageCount: pages.length,
    annotCount: pages.reduce((s, p) => s + (p.annotations || []).length, 0),
    openCount: pages.reduce((s, p) => s + (p.annotations || []).filter(a => !a.done).length, 0),
    completed: !!rd.completed,
    completedAt: rd.completedAt || null,
    updatedAt: rd.updatedAt || null,
    revision: rd.revision || 0,
    firstFile: pages[0] && pages[0].type === 'image' ? pages[0].file : null,
  };
}

function sortedRoundKeys(p) {
  return Object.keys(p.rounds || {}).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
}

/** 제품 완료 기준: 어느 차수든 '완료' 값이 지정되어 있으면 완료 제품으로 본다. */
function isProductCompleted(p) {
  return Object.keys(p.rounds || {}).some(k => p.rounds[k] && p.rounds[k].completed);
}

function productSummary(p) {
  const rounds = {};
  sortedRoundKeys(p).forEach(k => { rounds[k] = roundMeta(p.rounds[k]); });
  return { id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, deletedAt: p.deletedAt || null, shareToken: p.shareToken, completed: isProductCompleted(p), rounds };
}

module.exports = { sanitizePages, sanitizeAnnotation, roundMeta, productSummary, sortedRoundKeys, isProductCompleted };
