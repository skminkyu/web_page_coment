'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('./util');

const TEXT_EXTS = ['html', 'htm', 'css', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'vue', 'txt', 'json', 'md', 'xml', 'scss', 'less', 'svelte'];
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};
const FILE_RE = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/;

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

/** 파일 앞부분(매직 바이트)으로 실제 이미지 형식을 판별 */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  const head = buf.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  if ((head.startsWith('<?xml') || head.startsWith('<svg')) && head.includes('<svg')) return 'svg';
  return null;
}

function looksLikeKnownBinary(buf) {
  const h = buf.slice(0, 8);
  if (h.slice(0, 4).toString('ascii') === '%PDF') return 'PDF';
  if (h[0] === 0x50 && h[1] === 0x4b) return 'ZIP/Office 문서';
  return null;
}

function isProbablyText(buf) {
  const sample = buf.slice(0, Math.min(buf.length, 65536));
  if (sample.includes(0)) return false;
  // 잘못된 UTF-8 이 많으면 텍스트가 아님
  const s = sample.toString('utf8');
  const bad = (s.match(/�/g) || []).length;
  return bad < 8;
}

/**
 * 업로드 파일 저장소. 내용 해시(SHA-256)로 이름을 붙여 저장하므로
 * 같은 파일은 한 번만 저장되고, 저장된 파일은 절대 수정·덮어쓰기되지 않는다(불변).
 */
class FileStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'files');
    this.tmpDir = path.join(dataDir, 'tmp');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  isValidName(file) { return FILE_RE.test(String(file || '')); }
  pathOf(file) {
    if (!this.isValidName(file)) throw new HttpError(400, '잘못된 파일 이름', 'BAD_FILE');
    return path.join(this.dir, file);
  }
  exists(file) { return this.isValidName(file) && fs.existsSync(path.join(this.dir, file)); }

  /**
   * 버퍼 검증 후 저장. 반환: { file, kind: 'image'|'text', mime, size, ext }
   */
  save(buf, originalName) {
    if (!buf || buf.length === 0) throw new HttpError(400, '빈 파일입니다. 파일이 손상되었거나 내용이 없습니다.', 'EMPTY_FILE');
    const nameExt = extOf(originalName);
    const img = sniffImage(buf);
    let ext, kind;
    if (img === 'heic') {
      throw new HttpError(415, 'HEIC/HEIF(아이폰 사진) 형식은 브라우저에서 표시할 수 없습니다. JPG 또는 PNG로 변환한 뒤 다시 올려주세요.', 'UNSUPPORTED_HEIC');
    }
    if (img && (img !== 'svg' || nameExt === 'svg' || !TEXT_EXTS.includes(nameExt))) {
      ext = img; kind = 'image';
    } else if (TEXT_EXTS.includes(nameExt)) {
      if (!isProbablyText(buf)) throw new HttpError(415, `"${originalName}" 은(는) 텍스트 파일이 아닌 것 같습니다. 파일이 손상되었거나 확장자가 잘못되었습니다.`, 'NOT_TEXT');
      ext = nameExt === 'htm' ? 'html' : nameExt; kind = 'text';
    } else {
      const bin = looksLikeKnownBinary(buf);
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'].includes(nameExt)) {
        throw new HttpError(415, `"${originalName}" 은(는) 확장자는 이미지(.${nameExt})지만 실제 내용은 이미지가 아닙니다${bin ? ' (' + bin + ')' : ''}. 파일이 손상되었는지 확인해 주세요.`, 'INVALID_IMAGE');
      }
      throw new HttpError(415, `지원하지 않는 파일 형식입니다${bin ? ' (' + bin + ')' : ''}: "${originalName}". 이미지(JPG·PNG·GIF·WEBP·AVIF), HTML, 소스코드/텍스트 파일만 올릴 수 있습니다.`, 'UNSUPPORTED_TYPE');
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const file = hash + '.' + ext;
    const dest = path.join(this.dir, file);
    if (!fs.existsSync(dest)) {
      const tmp = path.join(this.tmpDir, file + '.' + process.pid + '.' + Date.now());
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, dest);
    }
    return { file, kind, ext, mime: kind === 'image' ? IMAGE_MIME[ext] : 'text/plain', size: buf.length };
  }

  mimeOf(file) {
    const ext = extOf(file);
    return IMAGE_MIME[ext] || 'text/plain; charset=utf-8';
  }

  list() { return fs.readdirSync(this.dir).filter(f => FILE_RE.test(f)); }
}

module.exports = { FileStore, TEXT_EXTS, extOf, sniffImage };
