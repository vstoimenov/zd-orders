// Packing slip: one print page per order (recipient, delivery, items with a checkbox each, payment) with a QR code that opens the
// order in Ordyx on the phone. Rendered on the server; the QR is inline SVG (nothing leaves our domain).
import QRCode from 'qrcode';
import { waybillText } from './waybill.js';

export const ADMIN_BASE = (process.env.ADMIN_BASE_URL || 'https://app.ordyx.eu').replace(/\/$/, '');
export const orderLink = (id) => `${ADMIN_BASE}/admin/?order=${encodeURIComponent(id)}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => new Date(iso).toLocaleString('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const money = (n, cur) => `${Number(n).toFixed(2)} ${cur || 'EUR'}`;
const PAYMENT = { cod: 'Наложен платеж', '': 'Наложен платеж' };

async function qrSvg(text) {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  return svg.replace(/<\?xml[^>]*>/, '').replace('<svg ', '<svg class="qr" ');
}

async function slip(order, shopName) {
  const items = (order.items || []).map((it) => `<li><span class="box"></span><span class="name">${esc(it.name)}</span><span class="qty">× ${esc(it.qty)}</span></li>`).join('');
  const pay = Object.hasOwn(PAYMENT, order.paymentMethod || '') ? PAYMENT[order.paymentMethod || ''] : 'Платена';
  const delivery = waybillText(order).split('\n').filter((l) => /^(Куриер|Доставка|Град):/.test(l)).map(esc).join('<br>');
  const w = order.shipment;
  return `<section class="slip">
  <div class="head"><div><b>${esc(shopName)}</b><br>Поръчка <b>${esc(order.cbOrderId)}</b> · ${esc(when(order.createdAt))}</div><div class="qrwrap">${await qrSvg(orderLink(order.id))}<small>${esc(orderLink(order.id))}</small></div></div>
  <div class="who"><b>${esc(order.name)}</b> · ${esc(order.phone)}</div>
  <div class="delivery">${delivery}${w ? `<br>Товарителница: <b>${esc(w.number)}</b>` : ''}</div>
  <ul class="items">${items}</ul>
  <div class="total">${esc(pay)}: <b>${esc(money(order.total, order.currency))}</b>${order.packedAt ? ` · пакетирана ${esc(when(order.packedAt))}` : ''}</div>
  <div class="sign">Пакетирал: ____________ &nbsp; Проверил: ____________</div>
</section>`;
}

/** The print page: one slip per order (empty list → a friendly note). `shopName` may be a string or a map {shopId: name}. */
export async function slipHtml(shop, orders, { capped = false } = {}) {
  const nameOf = (o) => (typeof shop === 'string' ? shop : shop?.name) || (shop && shop[o.shopId]) || '';
  const slips = await Promise.all((orders || []).map((o) => slip(o, nameOf(o))));
  const body = slips.length ? slips.join('\n') : '<p class="empty">Няма поръчки за пакетиране.</p>';
  return `<!doctype html>
<html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Листове за пакетиране</title>
<style>
  body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111;margin:0;padding:16px;background:#f3f3f3}
  .bar{display:flex;gap:10px;align-items:center;margin:0 0 14px}.bar button{height:40px;padding:0 16px;border:0;border-radius:8px;background:#111;color:#fff;font-size:15px;cursor:pointer}
  .slip{background:#fff;border:1px solid #ddd;border-radius:10px;padding:16px 18px;margin:0 auto 14px;max-width:720px;page-break-after:always;break-after:page}
  .head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;font-size:14px}.qrwrap{text-align:center}.qr{width:96px;height:96px}.qrwrap small{display:block;font-size:9px;color:#777;max-width:140px;word-break:break-all}
  .who{font-size:18px;margin:10px 0 4px}.delivery{font-size:14px;line-height:1.45;color:#333}
  .items{list-style:none;padding:0;margin:12px 0;font-size:16px}.items li{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid #eee}
  .box{width:18px;height:18px;border:2px solid #333;border-radius:4px;flex:none}.name{flex:1}.qty{font-weight:700;font-size:18px;min-width:44px;text-align:right}
  .total{font-size:16px;margin:8px 0}.sign{font-size:12px;color:#777;margin-top:10px}.empty{text-align:center;color:#555;padding:40px}
  .note{font-size:13px;color:#777;margin:0 0 10px}
  @media print{body{background:#fff;padding:0}.bar,.note{display:none}.slip{border:0;border-radius:0;max-width:none;margin:0 0 20px;padding:0 0 20px}}
</style></head><body>
<div class="bar"><button type="button" onclick="window.print()">🖨 Печат</button><span>${slips.length} ${slips.length === 1 ? 'лист' : 'листа'}</span></div>
${capped ? '<p class="note">Показваме първите 200 поръчки — отпечатайте ги и отворете листовете отново за останалите.</p>' : ''}
${body}
</body></html>`;
}
