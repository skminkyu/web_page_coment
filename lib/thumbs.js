'use strict';
/**
 * 썸네일 / 화면 표시용 축소본 생성 (sharp 가 설치되어 있을 때만).
 *  - 상세페이지 원본은 수 MB짜리 세로로 긴 이미지가 많아, 목록·썸네일에 원본을 쓰면 매우 느려진다.
 *  - 한 번 만든 썸네일은 DATA_DIR/thumbs 에 캐시 (원본에서 언제든 다시 만들 수 있으므로 백업 대상 아님)
 *  - sharp 를 쓸 수 없거나 변환에 실패하면 null → 호출 측에서 원본을 대신 사용
 */
const fs = require('fs');
const path = require('path');

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache(false);
  sharp.concurrency(1);
} catch (e) { sharp = null; }

const SIZES = {
  // 목록/썸네일: 위쪽 기준으로 잘라낸 작은 이미지
  thumb: { width: 240, height: 300, fit: 'cover', position: 'top', quality: 72 },
};
const RASTER = ['png', 'jpg', 'gif', 'webp', 'avif', 'bmp'];

class Thumbs {
  constructor(dataDir, files, log) {
    this.dir = path.join(dataDir, 'thumbs');
    this.files = files;
    this.log = log || console;
    this.pending = new Map();
    this.queue = [];
    this.active = 0;
    this.maxActive = 2;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  get available() { return !!sharp; }

  supports(file) {
    const ext = String(file).split('.').pop();
    return !!sharp && RASTER.includes(ext);
  }

  /** 썸네일 파일 경로를 돌려준다 (없으면 생성). 실패 시 null */
  get(file, size) {
    const spec = SIZES[size];
    if (!spec || !this.supports(file) || !this.files.exists(file)) return Promise.resolve(null);
    const out = path.join(this.dir, file.replace(/\.[a-z0-9]+$/, '') + '_' + size + '.webp');
    if (fs.existsSync(out)) return Promise.resolve(out);
    if (this.pending.has(out)) return this.pending.get(out);
    const p = new Promise(resolve => this.queue.push({ file, spec, out, resolve }))
      .finally(() => this.pending.delete(out));
    this.pending.set(out, p);
    this.pump();
    return p;
  }

  pump() {
    while (this.active < this.maxActive && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.render(job).then(job.resolve, () => job.resolve(null)).finally(() => { this.active--; this.pump(); });
    }
  }

  async render({ file, spec, out }) {
    try {
      const tmp = out + '.' + process.pid + '.tmp';
      await sharp(this.files.pathOf(file), { limitInputPixels: 400000000, animated: false })
        .rotate()
        .resize({ width: spec.width, height: spec.height, fit: spec.fit, position: spec.position, withoutEnlargement: false })
        .webp({ quality: spec.quality })
        .toFile(tmp);
      fs.renameSync(tmp, out);
      return out;
    } catch (e) {
      this.log.warn('[thumbs] 생성 실패', file, e.message);
      return null;
    }
  }
}

module.exports = { Thumbs };
