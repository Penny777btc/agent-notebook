// Generates web/icon-180.png and web/icon-512.png (home-screen icons) without any image library.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; for (let x = 0; x < size; x++) { const [r, g, b, a] = pixel(x, y); const o = y * (size * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const inRound = (x, y, x0, y0, x1, y1, r) => { if (x < x0 || x > x1 || y < y0 || y > y1) return false; const cx = Math.max(x0 + r, Math.min(x1 - r, x)), cy = Math.max(y0 + r, Math.min(y1 - r, y)); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
function draw(size, maskable) {
  const s = size;
  return png(s, (x, y) => {
    const u = x / s, v = y / s;
    // background: full-bleed for maskable, rounded (iOS-like 22%) otherwise
    if (!maskable && !inRound(u, v, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0];
    const t = (u + v) / 2;
    let r = Math.round(10 + (0 - 10) * t + 0), g = Math.round(132 + (113 - 132) * t), b = Math.round(255 + (227 - 255) * t);
    // notebook page
    const px0 = 0.30, py0 = 0.24, px1 = 0.74, py1 = 0.78;
    if (inRound(u, v, px0, py0, px1, py1, 0.045)) {
      [r, g, b] = [255, 255, 255];
      // spine rings on the left edge
      for (const ry of [0.36, 0.51, 0.66]) if (u < px0 + 0.07 && Math.abs(v - ry) < 0.022) [r, g, b] = [10, 132, 255];
      // text lines
      for (const ly of [0.40, 0.50, 0.60]) if (u > px0 + 0.13 && u < px1 - 0.08 && Math.abs(v - ly) < 0.013) [r, g, b] = [190, 215, 245];
    }
    return [r, g, b, 255];
  });
}
fs.writeFileSync(path.join(here, '..', 'web', 'icon-180.png'), draw(180, false));
fs.writeFileSync(path.join(here, '..', 'web', 'icon-512.png'), draw(512, true));
console.log('icons written');
