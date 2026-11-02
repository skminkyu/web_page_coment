'use strict';
const fs = require('fs');
const zlib = require('zlib');

/** 의존성 없는 최소 tar 작성기 (ustar). entries: [{ name, path? , data? }] */
function header(name, size, mtime) {
  const buf = Buffer.alloc(512, 0);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const idx = name.lastIndexOf('/', name.length - 1);
    prefix = name.slice(0, idx);
    name = name.slice(idx + 1);
  }
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'ascii');
  buf.write('0000000\0', 108, 8, 'ascii');
  buf.write('0000000\0', 116, 8, 'ascii');
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  buf.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii');
  buf.write('0', 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  if (prefix) buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

async function writeTarGz(entries, out) {
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(out);
  const write = (chunk) => new Promise((resolve) => { if (gz.write(chunk)) resolve(); else gz.once('drain', resolve); });
  for (const e of entries) {
    let data = e.data;
    if (!data && e.path) data = fs.readFileSync(e.path);
    if (typeof data === 'string') data = Buffer.from(data, 'utf8');
    await write(header(e.name, data.length, e.mtime || Date.now()));
    await write(data);
    const padLen = (512 - (data.length % 512)) % 512;
    if (padLen) await write(Buffer.alloc(padLen, 0));
  }
  await write(Buffer.alloc(1024, 0));
  gz.end();
}

module.exports = { writeTarGz };
