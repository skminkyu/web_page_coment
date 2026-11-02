'use strict';
const dns = require('dns').promises;
const net = require('net');
const { HttpError } = require('./util');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new HttpError(400, '올바른 URL이 아닙니다: ' + raw, 'BAD_URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'http/https 주소만 사용할 수 있습니다.', 'BAD_URL');
  if (process.env.ALLOW_PRIVATE_FETCH === '1') return u;
  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); }
  catch (e) { throw new HttpError(400, '도메인을 찾을 수 없습니다: ' + u.hostname, 'DNS_FAILED'); }
  if (addrs.some(a => isPrivateIp(a.address))) throw new HttpError(400, '내부 네트워크 주소는 사용할 수 없습니다.', 'BAD_URL');
  return u;
}

/** 외부 URL 을 크기/시간 제한 하에 내려받는다. 리다이렉트도 매 단계 검사. */
async function fetchRemote(raw, { maxBytes = 30 * 1024 * 1024, timeoutMs = 30000, accept } = {}) {
  let url = raw;
  for (let hop = 0; hop < 6; hop++) {
    const u = await assertPublicUrl(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(u.href, {
        redirect: 'manual', signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (WebComment)', 'Referer': u.origin + '/', ...(accept ? { Accept: accept } : {}) },
      });
    } catch (e) {
      clearTimeout(timer);
      throw new HttpError(502, (e.name === 'AbortError' ? '응답 시간 초과' : '연결 실패') + ': ' + u.href, 'FETCH_FAILED');
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      clearTimeout(timer);
      url = new URL(res.headers.get('location'), u.href).href;
      continue;
    }
    try {
      if (!res.ok) throw new HttpError(502, `원격 서버 오류 (HTTP ${res.status}): ${u.href}`, 'FETCH_FAILED');
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) throw new HttpError(413, `파일이 너무 큽니다 (${Math.round(len / 1048576)}MB).`, 'TOO_LARGE');
      const chunks = []; let total = 0;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) { ctrl.abort(); throw new HttpError(413, `파일이 너무 큽니다 (최대 ${Math.round(maxBytes / 1048576)}MB).`, 'TOO_LARGE'); }
        chunks.push(Buffer.from(chunk));
      }
      return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type') || '', finalUrl: u.href };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(502, '리다이렉트가 너무 많습니다.', 'FETCH_FAILED');
}

module.exports = { fetchRemote, assertPublicUrl, isPrivateIp };
