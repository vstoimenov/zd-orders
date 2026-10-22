// Print files for the hidden event offer: `node dev/print.mjs` (needs Google Chrome; fonts load from Google Fonts).
// Writes public/brand/qr-oferta.svg|png and the business card (85 × 55 mm + 3 mm bleed): vizitka.pdf, vizitka-front.png, vizitka-back.png.
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_OFFER = 'https://ordyx.eu/oferta';
const brand = new URL('../public/brand/', import.meta.url);
const MARK = readFileSync(new URL('ordyx-mark.svg', brand), 'utf8').replace(/^<svg[^>]*>|<\/svg>\s*$/g, '');

/** QR with the gem in the middle: error correction H survives the ~5% of modules the badge covers. */
function qrSvg(px) {
  const qr = QRCode.create(URL_OFFER, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size, quiet = 4, total = n + quiet * 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const b = total * 0.22, at = (total - b) / 2, pad = b * 0.12;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${px ? ` width="${px}" height="${px}"` : ''} shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#0d0d0c"/>` +
    `<rect x="${at}" y="${at}" width="${b}" height="${b}" rx="${b * 0.18}" fill="#fff"/>` +
    `<svg x="${at + pad}" y="${at + pad}" width="${b - pad * 2}" height="${b - pad * 2}" viewBox="0 0 100 100" shape-rendering="geometricPrecision">${MARK}</svg></svg>`;
}

const FONTS = '<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;800&family=Manrope:wght@500;600;800&display=block" rel="stylesheet">';
const lockup = (size, color) => `<div style="display:flex;align-items:center;gap:${size * 0.3}mm"><svg viewBox="0 0 100 100" style="width:${size}mm;height:${size}mm">${MARK}</svg>` +
  `<b style="font:800 ${size * 0.82}mm Unbounded;letter-spacing:-.02em;color:${color}">ordyx</b></div>`;
// trim 85 × 55 mm, bleed 3 mm each side → page 91 × 61 mm; content stays 3 mm inside the trim
const FRONT = `<section class="card" style="background:#0d0d0c;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3.2mm">
  ${lockup(11, '#fff')}<div style="font:600 2.3mm Manrope;letter-spacing:.14em;color:#a9a79f">ВСИЧКО СЛЕД ПОРЪЧКАТА</div></section>`;
const BACK = `<section class="card" style="background:#fff;display:flex;align-items:center;gap:4.5mm;padding:0 9mm">
  <div style="width:31mm;height:31mm;flex:none">${qrSvg()}</div>
  <div><div style="display:inline-block;font:800 2.2mm Manrope;background:#0d0d0c;color:#FFD21F;padding:1mm 2mm;border-radius:9mm">СКРИТА ОФЕРТА</div>
  <div style="font:800 4.9mm/1.12 Unbounded;color:#0d0d0c;margin:2.2mm 0 1.6mm">3 месеца<br><span style="background:#FFD21F;padding:0 1mm;border-radius:1mm">безплатно</span></div>
  <div style="font:500 2.35mm/1.4 Manrope;color:#44433d">за хората от това събитие.<br>Най-високият план — без лимит<br>на магазини и поръчки.</div>
  <div style="font:800 2.6mm Manrope;color:#0d0d0c;margin-top:2mm">ordyx.eu/oferta</div></div></section>`;
const page = (body) => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
  @page{size:91mm 61mm;margin:0}html,body{margin:0;padding:0}
  .card{width:91mm;height:61mm;box-sizing:border-box;overflow:hidden;page-break-after:always;break-after:page}
  .card:last-child{page-break-after:auto;break-after:auto}</style></head><body>${body}</body></html>`;

function chrome(args) { execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=8000', ...args], { stdio: 'ignore' }); }

const tmp = mkdtempSync(path.join(tmpdir(), 'ordyx-print-'));
try {
  writeFileSync(new URL('qr-oferta.svg', brand), qrSvg() + '\n');
  const qrHtml = path.join(tmp, 'qr.html');
  writeFileSync(qrHtml, `<!doctype html><html><body style="margin:0">${qrSvg(1200)}</body></html>`);
  chrome([`--screenshot=${new URL('qr-oferta.png', brand).pathname}`, '--window-size=1200,1200', `file://${qrHtml}`]);

  const pdfHtml = path.join(tmp, 'card.html');
  writeFileSync(pdfHtml, page(FRONT + BACK));
  chrome(['--no-pdf-header-footer', `--print-to-pdf=${new URL('vizitka.pdf', brand).pathname}`, `file://${pdfHtml}`]);
  // 91 × 61 mm at 300 dpi = 1075 × 720 px; CSS mm are 96 dpi, so scale by 300/96
  for (const [name, body] of [['vizitka-front.png', FRONT], ['vizitka-back.png', BACK]]) {
    const f = path.join(tmp, name + '.html');
    writeFileSync(f, page(body));
    chrome([`--screenshot=${new URL(name, brand).pathname}`, '--window-size=344,231', '--force-device-scale-factor=3.125', `file://${f}`]);
  }
  console.log('written qr-oferta.svg, qr-oferta.png, vizitka.pdf, vizitka-front.png, vizitka-back.png');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
