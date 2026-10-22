// Draws the Ordyx app icons (the cut gem: facets in yellow tones, light from the top, on black) as PNGs: `node dev/icons.mjs`.
// No image tools needed: polygons are rasterised here with 4×4 supersampling and written with zlib.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLACK = [0x0d, 0x0d, 0x0c], WHITE = [0xff, 0xff, 0xff];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// facet i lies between OUTER[i]→OUTER[i+1] and INNER[i+1]→INNER[i]; same tones as public/brand/ordyx-mark.svg
const FACET = ['#FFEFA8', '#FFDD4D', '#F4C200', '#D6A400', '#C49500', '#DDAC00', '#FFD21F', '#FFF3C7'].map(hex);
const TABLE_TOP = hex('#FFD84A'), SHINE = hex('#FFF0B3'); // the shine sits on the top of the table at 70%
// the mark in a 100×100 box, as on the logo canvas
const OUTER = [[30, 4], [70, 4], [96, 30], [96, 70], [70, 96], [30, 96], [4, 70], [4, 30]];
const INNER = [[40, 24], [60, 24], [76, 40], [76, 60], [60, 76], [40, 76], [24, 60], [24, 40]];

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function segDist(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
const SHINE_POLY = [[40, 24], [60, 24], [67, 31], [33, 31]];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function gemColour(x, y) {
  if (inside(INNER, x, y)) return inside(SHINE_POLY, x, y) ? mix(TABLE_TOP, SHINE, 0.7) : TABLE_TOP;
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    if (inside([OUTER[i], OUTER[j], INNER[j], INNER[i]], x, y)) return FACET[i];
  }
  return FACET[6];
}
function onLines(x, y, half, facets) {
  for (let i = 0; i < 8; i++) {
    if (segDist(x, y, INNER[i], INNER[(i + 1) % 8]) <= half) return true;
    if (facets && segDist(x, y, OUTER[i], INNER[i]) <= half) return true;
  }
  return false;
}

/** size px; mark = share of the icon the octagon spans; stroke in mark units; alpha = transparent background (badge) */
function draw({ size, mark, stroke, facets = true, badge = false }) {
  const S = 4, px = new Uint8Array(size * size * 4), scale = (size * mark) / 100, off = (size - size * mark) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const mx = (x + (sx + 0.5) / S - off) / scale, my = (y + (sy + 0.5) / S - off) / scale;
      let c = badge ? null : BLACK;
      if (inside(OUTER, mx, my)) c = onLines(mx, my, stroke / 2, facets) ? (badge ? null : BLACK) : (badge ? WHITE : gemColour(mx, my));
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
    }
    const n = S * S, i = (y * size + x) * 4, cov = a / 255;
    px[i] = cov ? r / cov : 0; px[i + 1] = cov ? g / cov : 0; px[i + 2] = cov ? b / cov : 0; px[i + 3] = a / n;
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const out = new URL('../public/admin/', import.meta.url);
const files = {
  'icon-192.png': draw({ size: 192, mark: 0.66, stroke: 2.8 }),
  'icon-512.png': draw({ size: 512, mark: 0.66, stroke: 1.9 }),
  'icon-maskable-512.png': draw({ size: 512, mark: 0.52, stroke: 2.1 }), // inside the 80% safe circle
  'apple-touch-icon.png': draw({ size: 180, mark: 0.66, stroke: 2.8 }),
  'badge-96.png': draw({ size: 96, mark: 0.86, stroke: 6, facets: false, badge: true }), // Android shows only the alpha
};
for (const [name, buf] of Object.entries(files)) writeFileSync(new URL(name, out), buf);
console.log('written', Object.keys(files).join(', '));
