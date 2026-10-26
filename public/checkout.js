/* zd-orders · избор на офис Еконт / офис Спиди / адрес Спиди / автомат BOX NOW в чекаута на ConvertBuilder + копие на приетата поръчка. */
(function () {
  'use strict';

  var SCRIPT = typeof document !== 'undefined' ? document.currentScript : null;
  var TOKEN = 'zdo_pub_2026_k7q3'; // not a secret — only filters out random spam
  var COURIER_LABEL = { econt_office: 'ЕКОНТ', speedy_office: 'СПИДИ', boxnow_locker: 'BOX NOW' };
  // ConvertBuilder method names differ per store ("До офис ECONT", "Доставка до офис на Еконт"…): match the kind + courier in Latin or Cyrillic
  // …or courier first ("ЕКОНТ Офис", "ЕКОНТ до адрес" — dokatospish.convertbuilder.com)
  var OPTION_PATTERN = {
    econt_office: /офис.*(econt|еконт)|(econt|еконт).*офис/i, econt_address: /адрес.*(econt|еконт)|(econt|еконт).*адрес/i,
    speedy_office: /офис.*(speedy|спиди)|(speedy|спиди).*офис/i, speedy_address: /адрес.*(speedy|спиди)|(speedy|спиди).*адрес/i, boxnow_locker: /box\s*now|бокс\s*нау/i
  };
  var OFFICE_TYPES = { econt_office: 'econt', speedy_office: 'speedy', boxnow_locker: 'boxnow' }; // type → courier of its office list
  var TYPE_COURIER = { econt_office: 'econt', econt_address: 'econt', speedy_office: 'speedy', speedy_address: 'speedy', boxnow_locker: 'boxnow' };
  var ADDRESS_LABEL = { econt_address: 'ЕКОНТ', speedy_address: 'СПИДИ' }; // address types → the courier as written in the address
  /** The courier's logo, served from our own domain (never a third-party CDN in a checkout). */
  function logoFor(api, type) { return (window.__zdoLogoBase || api + '/logos/') + TYPE_COURIER[type] + '.svg'; }
  /** The shop's delivery-time line for an option ('' = none); nothing until the shop info has arrived. */
  function etaFor(info, type) { var e = info && info.eta; return e && typeof e[TYPE_COURIER[type]] === 'string' ? e[TYPE_COURIER[type]] : ''; }
  var ICON_LOCATE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
  var ICON_MAP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></svg>';

  function clean(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function norm(v) { return clean(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

  /** Every word of the query must appear in the office's city, name, address or code; offices in a city that starts with the first word come first. */
  function searchOffices(offices, query, limit) {
    var words = norm(query).split(' ').filter(Boolean);
    if (!words.length) return [];
    var first = [], rest = [], max = limit || 80;
    for (var i = 0; i < offices.length && first.length < max; i++) {
      var o = offices[i];
      var hay = o._hay || (o._hay = norm(o.city + ' ' + o.name + ' ' + o.address + ' ' + o.code));
      if (!words.every(function (w) { return hay.indexOf(w) !== -1; })) continue;
      var city = o._city || (o._city = norm(o.city));
      (city.indexOf(words[0]) === 0 ? first : rest).push(o);
    }
    return first.concat(rest).slice(0, max);
  }

  function searchCities(cities, query, limit) {
    var q = norm(query);
    if (!q) return [];
    var starts = [], inner = [];
    for (var i = 0; i < cities.length; i++) {
      var n = cities[i]._n || (cities[i]._n = norm(cities[i].name));
      var at = n.indexOf(q);
      if (at === 0) starts.push(cities[i]);
      else if (at > 0) inner.push(cities[i]);
    }
    return starts.concat(inner).slice(0, limit || 8);
  }

  /* ---- „Намери ме“: everything about the customer's location stays in the browser ---- */
  function distanceM(a, b) {
    if (!a || !b || typeof a.lat !== 'number' || typeof a.lng !== 'number' || typeof b.lat !== 'number' || typeof b.lng !== 'number' || !isFinite(a.lat + a.lng + b.lat + b.lng)) return null;
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  /** 650 m (50 m steps) under a kilometre, otherwise 2,3 km. */
  function distanceText(m) {
    if (m == null || !isFinite(m)) return '';
    if (m < 1000) return Math.max(50, Math.round(m / 50) * 50) + ' m';
    return (Math.round(m / 100) / 10).toFixed(1).replace('.', ',') + ' km';
  }
  /** Points with coordinates sorted by distance from `point` (kept on `_dist`); a point without coordinates is never "nearest". */
  function nearestOffices(offices, point, limit) {
    if (!point) return [];
    var withDist = [];
    for (var i = 0; i < offices.length; i++) {
      var d = distanceM(point, offices[i]);
      offices[i]._dist = d;
      if (d != null) withDist.push(offices[i]);
    }
    withDist.sort(function (a, b) { return a._dist - b._dist; });
    return withDist.slice(0, limit || 8);
  }
  function hoursLine(o) {
    var h = clean(o && o.hours);
    return h === '24/7' ? 'денонощно (24/7)' : h;
  }

  /* ---- the map: a free library and free tiles (no keys), loaded only when the customer asks for it ---- */
  var MAP_SCRIPT = 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/maplibre-gl.js';
  var MAP_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/maplibre-gl.css';
  var MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  var MAP_MAX = 400; // markers at once: enough for a city view, light enough for a phone
  /** Points with coordinates inside `bounds` ({south, west, north, east}), nearest to its centre first, at most `max`. */
  function markerPoints(offices, bounds, max) {
    var c = { lat: (bounds.south + bounds.north) / 2, lng: (bounds.west + bounds.east) / 2 }, out = [];
    for (var i = 0; i < offices.length; i++) {
      var o = offices[i];
      if (typeof o.lat !== 'number' || typeof o.lng !== 'number' || !isFinite(o.lat + o.lng)) continue;
      if (o.lat < bounds.south || o.lat > bounds.north || o.lng < bounds.west || o.lng > bounds.east) continue;
      o._dc = distanceM(c, o);
      out.push(o);
    }
    out.sort(function (a, b) { return a._dc - b._dc; });
    return out.slice(0, max || MAP_MAX);
  }

  /** "автомат " / "офис " before a name, unless the name already says it (Speedy: "… (АВТОМАТ)"). */
  function kindPrefix(o, capital) {
    if (o.isAutomat && /автомат/i.test(o.name || '')) return '';
    var w = o.isAutomat ? 'автомат ' : 'офис ';
    return capital ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  }

  function formatSelection(sel) {
    if (!sel) return null;
    if (OFFICE_TYPES[sel.type]) {
      var o = sel.office;
      if (o) {
        return {
          address: COURIER_LABEL[sel.type] + ' – ' + kindPrefix(o) + o.name + ' (' + o.code + ')' + (o.address ? ', ' + o.address : ''),
          city: o.city || '', zip: o.postCode || '', officeId: o.id
        };
      }
      var text = clean(sel.officeText), city = clean(sel.city);
      if (!sel.fallback || !text || !city) return null;
      return { address: COURIER_LABEL[sel.type] + (sel.type === 'boxnow_locker' ? ' – автомат: ' : ' – офис: ') + text, city: city, zip: '', officeId: '' };
    }
    if (ADDRESS_LABEL[sel.type]) {
      var c = clean(sel.city), street = clean(sel.street);
      if (!c || !street) return null;
      return { address: ADDRESS_LABEL[sel.type] + ' – адрес: ' + street, city: c, zip: sel.postCode || '', officeId: '' };
    }
    return null;
  }

  function validateSelection(sel) {
    var type = sel && sel.type;
    if (OFFICE_TYPES[type]) {
      if (sel.office) return '';
      if (sel.fallback) {
        if (!clean(sel.city)) return 'Моля, въведете населено място.';
        if (!clean(sel.officeText)) return type === 'boxnow_locker' ? 'Моля, въведете адрес на автомата.' : 'Моля, въведете име или адрес на офиса.';
        return '';
      }
      return type === 'econt_office' ? 'Моля, изберете офис или автомат на Еконт.' : type === 'boxnow_locker' ? 'Моля, изберете автомат на BOX NOW.' : 'Моля, изберете офис или автомат на Спиди.';
    }
    if (ADDRESS_LABEL[type]) {
      if (!clean(sel.city)) return 'Моля, въведете населено място.';
      if (!clean(sel.street)) return 'Моля, въведете адрес за доставка.';
      return '';
    }
    return 'Моля, изберете начин на доставка.';
  }

  function pickOptionIndex(labels, type) {
    var re = OPTION_PATTERN[type];
    if (!re) return -1;
    for (var i = 0; i < labels.length; i++) if (re.test(labels[i])) return i;
    return -1;
  }

  /** Price as printed in a shipping label: "4.07€" → "4.07 €", "$2.48" → "$2.48", "5,10 лв." → "5.10 лв."; '' when none. */
  function optionPrice(label) {
    var m = String(label).match(/([$€£])\s*(\d+[.,]\d{2})|(\d+[.,]\d{2})\s*(€|лв\.?)/i);
    if (!m) return '';
    if (Number((m[2] || m[3]).replace(',', '.')) === 0) return 'Безплатна';
    return m[1] ? m[1] + m[2].replace(',', '.') : m[3].replace(',', '.') + ' ' + m[4];
  }

  var TYPES = ['econt_office', 'econt_address', 'speedy_office', 'speedy_address', 'boxnow_locker'];
  /**
   * Which of our choices to show from ConvertBuilder's shipping labels: the ones it offers (normal); none offered at all → 'none'
   * (the cart has no shipping method — a message, never made-up choices); only unknown names → 'all' (the shop prices them).
   * BOX NOW also needs the shop's switch in Ordyx (opts.boxnow); a BOX NOW method that is not switched on is known, not unknown.
   */
  function shippingView(labels, opts) {
    var available = {}, any = false, known = false;
    TYPES.forEach(function (t) {
      var offered = pickOptionIndex(labels, t) >= 0;
      known = known || offered;
      available[t] = offered && (t !== 'boxnow_locker' || !!(opts && opts.boxnow));
      any = any || available[t];
    });
    if (any) return { mode: 'normal', available: available };
    // only methods we know but may not show (a switched-off BOX NOW): a message; an unknown method among them: the classic choices
    var allKnown = labels.every(function (l) { return TYPES.some(function (t) { return OPTION_PATTERN[t].test(l); }); });
    if (!labels.length || (known && allKnown)) return { mode: 'none', available: { econt_office: false, econt_address: false, speedy_office: false, speedy_address: false, boxnow_locker: false } };
    // BOX NOW only when the shop offers it by name: a shop without a BOX NOW contract must never get locker orders
    return { mode: 'all', available: { econt_office: true, econt_address: false, speedy_office: true, speedy_address: true, boxnow_locker: false } };
  }

  /** List label: Speedy names already start with the city ("АЙТОС - …") and may say "(АВТОМАТ)" — don't repeat either. */
  function officeLabel(o) {
    var name = clean(o.name), city = clean(o.city);
    var prefix = city && norm(name).indexOf(norm(city)) !== 0 ? city + ' – ' : '';
    return prefix + (o.isAutomat ? kindPrefix(o) : '') + name;
  }

  /** detail = CustomEvent detail of platform.events.order_completed; order.items[].price is the line total. */
  function buildOrderPayload(detail, sel, fields, pageUrl) {
    detail = detail || {};
    fields = fields || {};
    var order = detail.order || {};
    var f = formatSelection(sel) || { address: fields.address || '', city: fields.city || '', zip: fields.zip || '', officeId: '' };
    return {
      token: TOKEN,
      cb_order_id: clean(detail.id) || clean(order.id),
      name: clean(order.customerName || detail.customerName || fields.name),
      email: clean(order.customerEmail || detail.customerEmail || fields.email),
      phone: clean((order.shippingAddress && order.shippingAddress.phone) || fields.phone),
      delivery_type: sel && sel.type ? sel.type : '',
      office_id: f.officeId,
      office_text: f.address,
      city: f.city,
      post_code: f.zip,
      address_text: sel && ADDRESS_LABEL[sel.type] ? clean(sel.street) : '',
      items: ((order.items && order.items.length ? order.items : detail.items) || []).map(function (it) {
        return { name: clean(it.title || it.name || it.productId || it.id), qty: Number(it.quantity) || 1, price: Number(it.price != null ? it.price : it.item_price) || 0 };
      }),
      total: Number(detail.total != null ? detail.total : order.total) || 0,
      currency: clean(detail.currency || order.currency || 'EUR'),
      payment_method: clean(order.paymentType),
      page_url: pageUrl,
      invoice: fields.invoice || undefined
    };
  }

  /** The cart being bought: from ConvertBuilder's order event (funnel checkouts), the store cart, or the analytics data layer. */
  function cartFrom(src) {
    src = src || {};
    var map = function (list) {
      return (list || []).slice(0, 50).map(function (it) {
        return { name: clean(it.title || it.name || it.productId || it.id), qty: Number(it.quantity) || 1, price: Number(it.price) || 0 };
      }).filter(function (it) { return it.name; });
    };
    var ev = src.eventOrder && (src.eventOrder.order || src.eventOrder);
    if (ev && ev.items && ev.items.length) return { items: map(ev.items), total: Number(ev.total) || 0, currency: clean(ev.currency || src.currency || 'EUR') };
    var sc = src.storeCart;
    if (sc && sc.items && sc.items.length) return { items: map(sc.items), total: Number(sc.total) || 0, currency: clean(sc.currency || src.currency || 'EUR') };
    var dl = src.dataLayer || [];
    for (var i = dl.length - 1; i >= 0; i--) {
      var e = dl[i];
      if (e && e[0] === 'event' && /^(begin_checkout|add_payment_info|add_shipping_info)$/.test(e[1]) && e[2] && e[2].items) {
        var items = map(e[2].items);
        return { items: items, total: Math.round(items.reduce(function (a, it) { return a + it.price * it.qty; }, 0) * 100) / 100, currency: clean(e[2].currency || src.currency || 'EUR') };
      }
    }
    return { items: [], total: 0, currency: clean(src.currency || 'EUR') };
  }

  /** What the customer typed, sent for abandoned carts once the phone looks real; null before that. */
  function cartPayload(fields, cart, delivery, pageUrl) {
    fields = fields || {};
    var phone = clean(fields.phone), d = phone.replace(/[^\d+]/g, '');
    // the same forms the server accepts (lib/phone.js): 0…, +359…, 00…, + international, or 9 digits after a +359 picker
    if (!/^(\+359|00359|359|0)[2-9]\d{7,8}$/.test(d) && !/^(\+|00)[1-9]\d{7,14}$/.test(d) && !/^[89]\d{8}$/.test(d)) return null;
    cart = cart || { items: [], total: 0, currency: 'EUR' };
    return { e: 'cart', phone: phone, name: clean(fields.name), email: clean(fields.email), items: cart.items.slice(0, 50), total: cart.total, currency: cart.currency, delivery: clean(delivery), page: pageUrl };
  }

  /** Anonymous page view for the shop's visit statistics: page, query (UTM / ad click ids) and referrer — no cookies, nothing personal. */
  function visitPayload(loc, doc) {
    return JSON.stringify({ p: String(loc.pathname || '/').slice(0, 200), s: String(loc.search || '').slice(0, 400), r: String(doc.referrer || '').slice(0, 400) });
  }

  /** The address part of the checkout copy the customer sees. ConvertBuilder can render a second copy hidden with its `none`
   *  class (or an inline display:none) before the real one (dokatospish.convertbuilder.com, 2026-10-26). Starts above the part:
   *  our own CSS hides the part itself. null = several copies, none shown yet. */
  function visiblePart(parts) {
    if (parts.length === 1) return parts[0]; // one copy is the checkout, even while hidden (an empty store cart)
    for (var i = 0; i < parts.length; i++) {
      var shown = true;
      for (var x = parts[i].parentElement; x && shown; x = x.parentElement) {
        if ((x.classList && x.classList.contains('none')) || (x.style && x.style.display === 'none')) shown = false;
      }
      if (shown) return parts[i];
    }
    return null;
  }

  var core = {
    TOKEN: TOKEN, norm: norm, searchOffices: searchOffices, searchCities: searchCities, formatSelection: formatSelection,
    validateSelection: validateSelection, pickOptionIndex: pickOptionIndex, optionPrice: optionPrice, officeLabel: officeLabel,
    buildOrderPayload: buildOrderPayload, visitPayload: visitPayload, shippingView: shippingView, cartFrom: cartFrom, cartPayload: cartPayload, logoFor: logoFor, etaFor: etaFor,
    distanceM: distanceM, distanceText: distanceText, nearestOffices: nearestOffices, hoursLine: hoursLine, visiblePart: visiblePart,
    MAP_SCRIPT: MAP_SCRIPT, MAP_CSS: MAP_CSS, MAP_STYLE: MAP_STYLE, markerPoints: markerPoints
  };
  if (typeof window !== 'undefined' && window.__ZDO_TEST__) { window.__zdoCore = core; return; }

  var API = '';
  var root = null, cities = null, offices = { econt: null, speedy: null, boxnow: null };
  // another platform (the WooCommerce plugin) mounted the picker itself: no ConvertBuilder fields, choices go to its onChange
  var standalone = null;
  var state = {
    type: '', econt: null, econtFallback: false, econtCity: '', econtText: '',
    speedy: null, speedyFallback: false, speedyCity: '', speedyText: '',
    boxnow: null, boxnowFallback: false, boxnowCity: '', boxnowText: '',
    geo: null, // the customer's location after „Намери ме“ ({lat, lng}); never sent anywhere
    addrCity: '', addrPost: '', addrStreet: ''
  };

  var CSS = [
    '.tick-wrapper:has(input[name="shippingOption"]),[data-role="address-part"]:has(input[name="shippingAddress"]){display:none!important}',
    '.zdo{margin:10px 0 14px;color:#3a2b2f;text-align:left;font-family:inherit}',
    '.zdo *{box-sizing:border-box}.zdo [hidden]{display:none!important}',
    '.zdo-title{font-weight:700;font-size:17px;margin:0 0 8px}',
    '.zdo-opt{display:flex;align-items:center;gap:10px;padding:12px 14px;margin:0 0 8px;border:1.5px solid #e8d3da;border-radius:10px;background:#fff;cursor:pointer;font-size:15px;line-height:1.3}',
    '.zdo-opt.is-on{border-color:#b0426b;background:#fdf3f6}',
    '.zdo-opt input{accent-color:#b0426b;width:18px;height:18px;margin:0;flex:none}',
    '.zdo-price{margin-left:auto;font-weight:700;white-space:nowrap}',
    '.zdo-logo{width:44px;height:30px;flex:none;object-fit:contain;border-radius:6px;background:#fff}',
    '.zdo-opt-text{display:flex;flex-direction:column;gap:2px;min-width:0}.zdo-opt-text small{font-size:13px;color:#7a6a6f}.zdo-opt-text small:empty{display:none}',
    '.zdo-tool svg{vertical-align:-4px;margin-right:6px}',
    '.zdo-panel{display:none;margin:-2px 0 10px}.zdo-panel.is-on{display:block}',
    '.zdo-inv{margin:10px 0 0}.zdo-inv-on{display:flex;gap:8px;align-items:center;font-size:15px;cursor:pointer;margin:0 0 8px}.zdo-inv-on input{width:18px;height:18px}',
    '.zdo-input{display:block;float:none!important;width:100%!important;height:46px!important;padding:0 12px!important;margin:0 0 8px!important;border:1.5px solid #d9c3ca!important;border-radius:8px!important;font-size:16px!important;background:#fff!important;color:#222!important}',
    '.zdo-list{max-height:260px;overflow-y:auto;border-radius:8px}',
    '.zdo-list:not(:empty){border:1px solid #e8d3da;margin:-4px 0 8px}',
    '.zdo-item{display:block;width:100%;text-align:left;padding:10px 12px;border:0;border-bottom:1px solid #f1e4e8;background:#fff;font-size:14px;line-height:1.35;cursor:pointer;color:#222}',
    '.zdo-item:hover,.zdo-item:focus{background:#fdf3f6}.zdo-item small{display:block;color:#7a6a6f}',
    '.zdo-dist{float:right;margin-left:8px;color:#b0426b;font-weight:700;font-size:13px}',
    '.zdo-tools{display:flex;gap:8px;margin:0 0 8px}',
    '.zdo-tool{flex:1;min-height:40px;padding:6px 8px;line-height:1.2;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1.5px solid #b0426b;border-radius:8px;background:#fff;color:#b0426b;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}',
    '.zdo-tool:disabled{opacity:.6;cursor:default}',
    '.zdo-map{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;background:#fff;display:flex;flex-direction:column;font-family:inherit;color:#3a2b2f}',
    '.zdo-map-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #e8d3da;font-size:16px}',
    '.zdo-map-head b{flex:1}.zdo-map-x{width:40px;height:40px;border:0;border-radius:8px;background:#f3e6ea;color:#3a2b2f;font-size:26px;line-height:1;cursor:pointer}',
    '.zdo-map-note{padding:8px 14px;font-size:14px;color:#7a6a6f}.zdo-map-note:empty{display:none}',
    '.zdo-map-canvas{flex:1;min-height:0}',
    '.zdo-pin{width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#b0426b;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:pointer}',
    '.zdo-pin.is-automat{background:#2563eb}.zdo-pin.is-me{width:16px;height:16px;border-radius:50%;transform:none;background:#16a34a;cursor:default}',
    '.zdo-map .maplibregl-popup-content{font-family:inherit;font-size:14px;line-height:1.4;padding:12px 14px;border-radius:10px}',
    '.zdo-map-pick{display:block;width:100%;margin-top:8px;height:38px;border:0;border-radius:8px;background:#b0426b;color:#fff;font-size:15px;font-weight:700;cursor:pointer}',
    '.zdo-note{padding:8px 2px;font-size:14px;color:#7a6a6f}',
    '.zdo-picked:not(:empty){padding:10px 12px;margin:0 0 8px;border-radius:8px;background:#f3faf4;border:1px solid #bfe0c6;font-size:14px;line-height:1.4}',
    '.zdo-picked button{border:0;background:none;color:#b0426b;text-decoration:underline;padding:0;margin-left:6px;cursor:pointer;font-size:14px}',
    '.zdo-link{display:inline-block;font-size:13px;color:#7a6a6f!important;text-decoration:underline;margin:0 0 8px}',
    '.zdo-none{margin:4px 0 10px;padding:12px 14px;border-radius:10px;background:#fff7ed;color:#7c2d12;font-size:14px;line-height:1.4}',
    '.zdo-error:not(:empty){margin:4px 0 10px;padding:10px 12px;border-radius:8px;background:#fdecee;color:#a1122f;font-size:14px;font-weight:600}'
  ].join('');

  function officePanel(courier, type, name, lockersOnly) {
    var where = lockersOnly ? 'автомат' : 'офис';
    return '<label class="zdo-opt"><input type="radio" name="zdo-type" value="' + type + '"><img class="zdo-logo" data-logo="' + type + '" alt=""><span class="zdo-opt-text"><span>До ' + (lockersOnly ? '' : 'офис или ') + 'автомат на <b>' + name + '</b></span><small data-eta="' + type + '"></small></span><span class="zdo-price" data-price="' + type + '"></span></label>' +
      '<div class="zdo-panel" data-for="' + type + '">' +
        '<div class="zdo-picked" data-role="' + courier + '-picked"></div>' +
        '<div data-role="' + courier + '-pick"><div class="zdo-tools"><button type="button" class="zdo-tool" data-role="' + courier + '-locate">' + ICON_LOCATE + 'Намери ме</button><button type="button" class="zdo-tool" data-role="' + courier + '-map">' + ICON_MAP + 'Виж на картата</button></div><div class="zdo-note" data-role="' + courier + '-geo" hidden></div>' +
          '<input class="zdo-input" data-role="' + courier + '-search" type="text" placeholder="Напишете град или ' + (lockersOnly ? 'адрес на автомат' : 'име на офис') + '" autocomplete="off"><div class="zdo-list" data-role="' + courier + '-list"></div>' +
          '<a href="#" class="zdo-link" data-role="' + courier + '-manual">Не намирам ' + where + 'а си – въведи ръчно</a></div>' +
        '<div data-role="' + courier + '-fallback" hidden><div class="zdo-note">Въведете ' + where + 'а ръчно:</div>' +
          '<input class="zdo-input" data-role="' + courier + '-city" type="text" placeholder="Населено място"><input class="zdo-input" data-role="' + courier + '-text" type="text" placeholder="' + (lockersOnly ? 'Адрес на автомата' : 'Име или адрес на офиса') + ' на ' + name + '"></div>' +
      '</div>';
  }

  var TEMPLATE =
    '<div class="zdo-title">Доставка</div>' +
    '<div class="zdo-none" hidden></div>' +
    officePanel('econt', 'econt_office', 'Еконт') +
    '<label class="zdo-opt"><input type="radio" name="zdo-type" value="econt_address"><img class="zdo-logo" data-logo="econt_address" alt=""><span class="zdo-opt-text"><span>До адрес с <b>Еконт</b></span><small data-eta="econt_address"></small></span><span class="zdo-price" data-price="econt_address"></span></label>' +
    officePanel('speedy', 'speedy_office', 'Спиди') +
    '<label class="zdo-opt"><input type="radio" name="zdo-type" value="speedy_address"><img class="zdo-logo" data-logo="speedy_address" alt=""><span class="zdo-opt-text"><span>До адрес със <b>Спиди</b></span><small data-eta="speedy_address"></small></span><span class="zdo-price" data-price="speedy_address"></span></label>' +
    '<div class="zdo-panel" data-for="address">' + // one address panel, moved under the chosen address option
      '<input class="zdo-input" data-role="addr-city" type="text" placeholder="Населено място" autocomplete="off"><div class="zdo-list" data-role="city-list"></div>' +
      '<input class="zdo-input" data-role="addr-street" type="text" placeholder="Улица, номер, блок, вход, етаж, апартамент">' +
    '</div>' +
    officePanel('boxnow', 'boxnow_locker', 'BOX NOW', true) +
    '<div class="zdo-error" role="alert"></div>' +
    // invoice details: only on a checkout, off by default (a platform's own form asks for them itself)
    '<div class="zdo-inv"><label class="zdo-inv-on"><input type="checkbox" data-role="inv-on"> Искам фактура</label>' +
      '<div data-role="inv-fields" hidden>' +
        '<input class="zdo-input" data-inv="company" type="text" maxlength="160" placeholder="Фирма">' +
        '<input class="zdo-input" data-inv="eik" type="text" inputmode="numeric" maxlength="13" placeholder="ЕИК / Булстат">' +
        '<input class="zdo-input" data-inv="vat" type="text" maxlength="12" placeholder="ДДС номер (ако има)">' +
        '<input class="zdo-input" data-inv="mol" type="text" maxlength="120" placeholder="МОЛ">' +
        '<input class="zdo-input" data-inv="address" type="text" maxlength="200" placeholder="Адрес по регистрация">' +
      '</div></div>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(role) { return root.querySelector('[data-role="' + role + '"]'); }
  var form = null; // the checkout copy the widget is in: its fields, not a hidden copy's
  function field(name) { var q = '[name="' + name + '"]'; return (form && form.querySelector(q)) || document.querySelector(q); }
  function val(name) { var f = field(name); return f ? f.value : ''; }
  function getJson(path) { return fetch(API + path).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  function loadOffices(courier) {
    if (offices[courier]) return Promise.resolve(offices[courier]);
    var site = courier === 'boxnow' ? '&host=' + encodeURIComponent(location.host) : ''; // BOX NOW only for shops that switched it on
    return getJson('/api/offices?courier=' + courier + site).then(function (d) {
      if (!d.offices || !d.offices.length) throw new Error('empty office list'); // treat as a failure → manual entry
      return (offices[courier] = d.offices);
    });
  }
  /** 'econt_office' → 'econt' for the office/locker types, '' otherwise */
  function officeCourier(type) { return OFFICE_TYPES[type] || ''; }
  function loadCities() { return cities ? Promise.resolve(cities) : getJson('/api/cities').then(function (d) { return (cities = d.cities || []); }); }

  function selection() {
    var t = state.type;
    if (t === 'econt_office') return { type: t, office: state.econtFallback ? null : state.econt, fallback: state.econtFallback, city: state.econtCity, officeText: state.econtText };
    if (t === 'speedy_office') return { type: t, office: state.speedyFallback ? null : state.speedy, fallback: state.speedyFallback, city: state.speedyCity, officeText: state.speedyText };
    if (t === 'boxnow_locker') return { type: t, office: state.boxnowFallback ? null : state.boxnow, fallback: state.boxnowFallback, city: state.boxnowCity, officeText: state.boxnowText };
    if (ADDRESS_LABEL[t]) return { type: t, city: state.addrCity, postCode: state.addrPost, street: state.addrStreet };
    return { type: '' };
  }

  function shippingOptions() {
    var radios = [].slice.call(document.querySelectorAll('input[name="shippingOption"]'));
    var labels = radios.map(function (r) { var w = r.closest('.tick-wrapper') || r.parentElement; return w ? w.textContent : ''; });
    return { radios: radios, labels: labels };
  }

  function setField(name, value) {
    var f = field(name);
    if (!f || f.value === value) return;
    f.value = value;
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectShippingOption() {
    if (!state.type) return false;
    var o = shippingOptions(), i = pickOptionIndex(o.labels, state.type);
    if (i < 0) { console.warn('[zdo] no ConvertBuilder shipping method for', state.type); return false; }
    if (o.radios[i].checked) return false;
    o.radios[i].click();
    return true;
  }

  /** Post code for a typed city name (ConvertBuilder requires one); '0000' for places missing from the list so the sale is never blocked. */
  function zipFor(city) {
    var n = norm(city);
    if (!n) return '';
    var hits = (cities || []).filter(function (c) { return (c._n || (c._n = norm(c.name))) === n; });
    var best = hits.filter(function (c) { return c.hasOffice; })[0] || hits[0];
    return best ? best.postCode : '0000';
  }

  /** What is chosen now, for another platform: the same fields the order gets (office id/text, city, post code, address) and what is missing. */
  function currentValue() {
    var sel = selection(), f = formatSelection(sel);
    return {
      type: sel.type || '', officeId: f ? f.officeId : '', officeText: f ? f.address : '', city: f ? f.city : '',
      postCode: f ? (f.zip || zipFor(f.city)) : '', addressText: ADDRESS_LABEL[sel.type] ? clean(sel.street) : '', error: validateSelection(sel)
    };
  }
  /** Copies the choice into ConvertBuilder's own fields so its validation and order see it. Returns true if it had to click a shipping radio. */
  function sync() {
    if (standalone) { try { standalone.onChange(currentValue()); } catch (e) { /* the host's handler must not break the picker */ } return false; }
    var f = formatSelection(selection());
    setField('shippingAddress', f ? f.address : '');
    setField('shippingCity', f ? f.city : '');
    setField('shippingZipCode', f ? f.zip || zipFor(f.city) : '');
    return selectShippingOption();
  }

  function showError(msg) {
    var box = root.querySelector('.zdo-error');
    box.textContent = msg || '';
    if (msg) root.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function pickedHtml(o) {
    var title = kindPrefix(o, true) + o.name;
    return '<b>' + esc(title) + '</b>' + (o.address ? '<br>' + esc(o.address) : '') +
      (o.city ? '<br>' + esc(o.city) : '') + (hoursLine(o) ? '<br>🕒 ' + esc(hoursLine(o)) : '') + ' <button type="button" data-role="change">Смени</button>';
  }

  function panelFor(p, type) { var f = p.getAttribute('data-for'); return f === type || (f === 'address' && !!ADDRESS_LABEL[type]); }
  /** The shared address panel sits right under the address option that is chosen (Econt or Speedy). */
  function placeAddressPanel() {
    if (!ADDRESS_LABEL[state.type]) return;
    var panel = root.querySelector('.zdo-panel[data-for="address"]'), input = root.querySelector('input[name="zdo-type"][value="' + state.type + '"]');
    var label = input && input.closest('.zdo-opt');
    if (panel && label && label.nextSibling !== panel) label.parentNode.insertBefore(panel, label.nextSibling);
  }
  function render() {
    [].forEach.call(root.querySelectorAll('.zdo-opt'), function (l) { l.classList.toggle('is-on', l.querySelector('input').value === state.type); });
    if (standalone) fillPrices();
    else [].forEach.call(root.querySelectorAll('.zdo-panel'), function (p) { p.classList.toggle('is-on', panelFor(p, state.type)); });
    placeAddressPanel();
    ['econt', 'speedy', 'boxnow'].forEach(function (c) {
      var picked = state[c], fallback = state[c + 'Fallback'];
      el(c + '-picked').innerHTML = picked && !fallback ? pickedHtml(picked) : '';
      el(c + '-pick').hidden = !!picked || fallback;
      el(c + '-fallback').hidden = !fallback;
    });
  }

  function officeItem(o) {
    var dist = state.geo ? distanceText(o._dist != null ? o._dist : distanceM(state.geo, o)) : '';
    var sub = [o.address, hoursLine(o)].filter(Boolean).join(' · ');
    return '<button type="button" class="zdo-item" data-id="' + esc(o.id) + '">' + (dist ? '<span class="zdo-dist">' + esc(dist) + '</span>' : '') +
      esc(officeLabel(o)) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</button>';
  }
  /** Typed query → matches; nothing typed but located → the nearest points. */
  function renderOfficeList(courier) {
    var list = el(courier + '-list'), q = el(courier + '-search').value;
    if (!norm(q) && !state.geo) { list.innerHTML = ''; return; }
    if (!offices[courier]) { list.innerHTML = '<div class="zdo-note">Зареждане…</div>'; return; }
    var found = norm(q) ? searchOffices(offices[courier], q, 80) : nearestOffices(offices[courier], state.geo, 8);
    var noun = courier === 'boxnow' ? 'автомат' : 'офис';
    list.innerHTML = found.length ? (norm(q) ? '' : '<div class="zdo-note">Най-близките до вас:</div>') + found.map(officeItem).join('')
      : '<div class="zdo-note">' + (norm(q) ? 'Няма намерен ' + noun + '. Опитайте само с името на града.' : 'В момента няма данни за близките точки — напишете град или ' + noun + '.') + '</div>';
  }
  var mapLib = null; // the loading library, shared by every open of the map
  function loadMap() {
    if (mapLib) return mapLib;
    mapLib = new Promise(function (resolve, reject) {
      if (window.maplibregl) return resolve(window.maplibregl);
      if (!document.querySelector('link[href="' + MAP_CSS + '"]')) { var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = MAP_CSS; document.head.appendChild(css); }
      var s = document.createElement('script'); s.src = window.__zdoMapScript || MAP_SCRIPT; s.async = true;
      var timer = setTimeout(fail, 15000);
      function fail() { clearTimeout(timer); mapLib = null; reject(new Error('map script')); }
      s.onload = function () { clearTimeout(timer); if (window.maplibregl) resolve(window.maplibregl); else fail(); };
      s.onerror = fail;
      document.head.appendChild(s);
    });
    return mapLib;
  }
  var mapUi = null; // { root, map, markers, courier, overflow, onKey }
  var MAP_FAIL = 'Картата не се зареди — ползвайте търсенето или „Намери ме“.';
  var COURIER_NAME = { econt: 'Еконт', speedy: 'Спиди', boxnow: 'BOX NOW' };
  function closeMap() {
    if (!mapUi) return;
    try { if (mapUi.map) mapUi.map.remove(); } catch (e) { /* already gone */ }
    if (mapUi.root.parentNode) mapUi.root.parentNode.removeChild(mapUi.root);
    document.body.style.overflow = mapUi.overflow;
    document.removeEventListener('keydown', mapUi.onKey);
    mapUi = null;
  }
  /** Where the map opens: the customer's location, else the city typed in the search, else Bulgaria. */
  function mapView(courier) {
    if (state.geo) {
      // the customer and the 5 nearest points in one frame (a city view that is never empty)
      var near = nearestOffices(offices[courier] || [], state.geo, 5).filter(function (o) { return o._dist != null; });
      if (!near.length) return { center: [state.geo.lng, state.geo.lat], zoom: 13 };
      var s = state.geo.lat, n = s, w = state.geo.lng, e = w;
      near.forEach(function (o) { s = Math.min(s, o.lat); n = Math.max(n, o.lat); w = Math.min(w, o.lng); e = Math.max(e, o.lng); });
      return { bounds: [[w, s], [e, n]] };
    }
    var q = el(courier + '-search').value, hit = norm(q) ? searchOffices(offices[courier] || [], q, 1)[0] : null;
    if (hit && typeof hit.lat === 'number') return { center: [hit.lng, hit.lat], zoom: 12 };
    return { center: [25.48, 42.73], zoom: 6.3 };
  }
  function popupHtml(o) {
    var sub = [o.address, o.city, hoursLine(o)].filter(Boolean);
    return '<b>' + esc(kindPrefix(o, true) + o.name) + '</b>' + (sub.length ? '<br>' + esc(sub.join(' · ')) : '') +
      (state.geo && o._dist != null ? '<br>' + esc(distanceText(o._dist)) + ' от вас' : '') +
      '<button type="button" class="zdo-map-pick" data-pick="' + esc(o.id) + '">Избери</button>';
  }
  function showPopup(lib, ui, o) {
    if (ui.popup) ui.popup.remove();
    ui.popup = new lib.Popup({ offset: 24, maxWidth: '280px' }).setLngLat([o.lng, o.lat]).setHTML(popupHtml(o)).addTo(ui.map);
  }
  /** Markers for the points in view: only what changed is added or removed, so an open popup survives a pan; popups are made on tap. */
  function placeMarkers(lib) {
    var ui = mapUi;
    if (!ui || !ui.map) return;
    var b = ui.map.getBounds();
    var all = markerPoints(offices[ui.courier] || [], { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, 1e9);
    var pts = all.slice(0, MAP_MAX), keep = {};
    pts.forEach(function (o) { keep[o.id] = true; });
    Object.keys(ui.markers).forEach(function (id) { if (!keep[id]) { ui.markers[id].remove(); delete ui.markers[id]; } });
    pts.forEach(function (o) {
      if (ui.markers[o.id]) return;
      if (state.geo) o._dist = distanceM(state.geo, o);
      var pin = document.createElement('div');
      pin.className = 'zdo-pin' + (o.isAutomat ? ' is-automat' : '');
      pin.title = kindPrefix(o, true) + o.name;
      pin.addEventListener('click', function (e) { e.stopPropagation(); showPopup(lib, ui, o); });
      ui.markers[o.id] = new lib.Marker({ element: pin, anchor: 'bottom' }).setLngLat([o.lng, o.lat]).addTo(ui.map);
    });
    var hint = ui.root.querySelector('.zdo-map-hint');
    hint.textContent = all.length > MAP_MAX ? 'Показваме най-близките ' + MAP_MAX + ' точки — приближете картата, за да видите всички.' : '';
  }
  function openMap(courier) {
    closeMap();
    var noun = courier === 'boxnow' ? 'Автомати' : 'Офиси и автомати';
    var wrap = document.createElement('div');
    wrap.className = 'zdo-map';
    wrap.innerHTML = '<div class="zdo-map-head"><b>' + noun + ' на ' + COURIER_NAME[courier] + '</b><button type="button" class="zdo-map-x" data-role="map-close" aria-label="Затвори">×</button></div>' +
      '<div class="zdo-map-note">Зареждаме картата…</div><div class="zdo-map-note zdo-map-hint"></div><div class="zdo-map-canvas"></div>';
    var ui = { root: wrap, map: null, markers: {}, popup: null, courier: courier, overflow: document.body.style.overflow, onKey: function (e) { if (e.key === 'Escape') closeMap(); } };
    mapUi = ui;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(wrap);
    document.addEventListener('keydown', ui.onKey);
    var note = wrap.querySelector('.zdo-map-note');
    wrap.addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (!t) return;
      if (t.getAttribute('data-role') === 'map-close') closeMap();
      else if (t.hasAttribute('data-pick')) pickFromMap(courier, t.getAttribute('data-pick'));
    });
    loadMap().then(function (lib) {
      if (mapUi !== ui) return; // closed while loading
      var view = mapView(courier), map;
      try {
        var opts = { container: wrap.querySelector('.zdo-map-canvas'), style: MAP_STYLE, attributionControl: { compact: true } };
        if (view.bounds) { opts.bounds = view.bounds; opts.fitBoundsOptions = { padding: 70, maxZoom: 15 }; } else { opts.center = view.center; opts.zoom = view.zoom; }
        map = new lib.Map(opts);
      } catch (err) { note.textContent = MAP_FAIL; return; }
      ui.map = map;
      map.addControl(new lib.NavigationControl({ showCompass: false }));
      // the view has no size until the first frame: markers go on at load (or after a moment, if the tiles never come) and on every move
      map.on('load', function () { note.textContent = ''; placeMarkers(lib); });
      map.on('error', function () { if (note.textContent) note.textContent = MAP_FAIL; }); // tiles failed: markers still work
      map.on('moveend', function () { placeMarkers(lib); });
      setTimeout(function () { if (mapUi === ui && !Object.keys(ui.markers).length) placeMarkers(lib); }, 1500);
      if (state.geo) { var me = document.createElement('div'); me.className = 'zdo-pin is-me'; me.title = 'Вие сте тук'; new lib.Marker({ element: me }).setLngLat([state.geo.lng, state.geo.lat]).addTo(map); }
    }, function () { if (mapUi === ui) note.textContent = MAP_FAIL; });
  }
  function pickFromMap(courier, id) {
    var o = (offices[courier] || []).filter(function (x) { return x.id === id; })[0];
    if (!o) return;
    state[courier] = o; state[courier + 'Fallback'] = false;
    el(courier + '-search').value = ''; el(courier + '-list').innerHTML = '';
    closeMap();
    render(); sync(); showError('');
  }
  var GEO_FAIL = 'Браузърът не даде местоположение — напишете град или офис.';
  /** „Намери ме“: asks the browser once, remembers the answer for every courier; any failure only shows a note. */
  function locate(courier) {
    var note = el(courier + '-geo'), btn = el(courier + '-locate');
    var done = function (msg) { btn.disabled = false; note.hidden = !msg; note.textContent = msg || ''; };
    if (state.geo) { renderOfficeList(courier); return done(''); }
    if (!navigator.geolocation || (typeof isSecureContext !== 'undefined' && !isSecureContext)) return done(GEO_FAIL);
    btn.disabled = true; note.hidden = false; note.textContent = 'Търсим най-близките…';
    // the customer may read the browser's permission prompt for a while: a late answer is still used (the note only says what to do meanwhile)
    var answered = false;
    var fail = function () { if (answered) return; done(GEO_FAIL); };
    var timer = setTimeout(fail, 30000);
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        if (answered) return;
        answered = true; clearTimeout(timer);
        var c = pos && pos.coords;
        if (!c || !isFinite(c.latitude) || !isFinite(c.longitude)) return done(GEO_FAIL);
        state.geo = { lat: c.latitude, lng: c.longitude };
        done('');
        ['econt', 'speedy', 'boxnow'].forEach(function (k) { if (offices[k]) renderOfficeList(k); });
        if (!offices[courier]) loadOffices(courier).then(function () { renderOfficeList(courier); }, function () { officesFailed(courier); });
      }, function () { answered = true; clearTimeout(timer); done(GEO_FAIL); }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 300000 });
    } catch (e) { answered = true; clearTimeout(timer); done(GEO_FAIL); }
  }

  function renderCityList() {
    var list = el('city-list'), q = el('addr-city').value;
    if (!cities || !norm(q) || (state.addrPost && q === state.addrCity)) { list.innerHTML = ''; return; }
    list.innerHTML = searchCities(cities, q, 8).map(function (c) {
      return '<button type="button" class="zdo-item" data-city="' + esc(c.id) + '">' + esc(c.name) + (c.region ? ' <small>обл. ' + esc(c.region) + '</small>' : '') + '</button>';
    }).join('');
  }

  function officesFailed(courier) { state[courier + 'Fallback'] = true; render(); sync(); loadCities().then(sync, function () {}); }

  var mountedAt = 0, noShippingSent = false, boxnowOn = false, boxnowPending = false, shopInfo = null;
  /** Asked once per page: is BOX NOW switched on for this shop, and what delivery-time lines to show. */
  function loadShopInfo() {
    boxnowPending = true;
    getJson('/api/offices?courier=shop&host=' + encodeURIComponent(standalone && standalone.host ? standalone.host : location.host)).then(function (d) {
      shopInfo = d || null; boxnowOn = Boolean(d && d.boxnow);
    }, function () {}).then(function () {
      boxnowPending = false;
      TYPES.forEach(function (t) { var e = root.querySelector('[data-eta="' + t + '"]'); if (e) e.textContent = etaFor(shopInfo, t); });
      fillPrices();
    });
  }
  var NO_SHIPPING_GRACE_MS = 3000; // ConvertBuilder may still be loading its methods (slow phones)
  function fillPrices() {
    if (standalone) { // the host platform shows its own methods and prices: only the asked-for panel, BOX NOW only when the shop switched it on
      [].forEach.call(root.querySelectorAll('.zdo-opt input'), function (r) { r.closest('.zdo-opt').hidden = true; });
      var ok = state.type && (state.type !== 'boxnow_locker' || boxnowOn || boxnowPending);
      [].forEach.call(root.querySelectorAll('.zdo-panel'), function (p) { p.classList.toggle('is-on', ok && panelFor(p, state.type)); });
      placeAddressPanel();
      var note = root.querySelector('.zdo-none');
      note.hidden = ok || !state.type;
      note.textContent = 'BOX NOW не е включен за този магазин.';
      return;
    }
    var o = shippingOptions(), view = shippingView(o.labels, { boxnow: boxnowOn });
    TYPES.forEach(function (t) {
      var i = pickOptionIndex(o.labels, t);
      root.querySelector('[data-price="' + t + '"]').textContent = i >= 0 ? optionPrice(o.labels[i]) : '';
    });
    var waiting = view.mode === 'none' && (Date.now() - mountedAt < NO_SHIPPING_GRACE_MS || boxnowPending); // still asking whether BOX NOW is on
    var none = view.mode === 'none' && !waiting;
    [].forEach.call(root.querySelectorAll('.zdo-opt input'), function (r) { r.closest('.zdo-opt').hidden = view.mode === 'none' || !view.available[r.value]; });
    if (view.mode === 'none') [].forEach.call(root.querySelectorAll('.zdo-panel'), function (p) { p.classList.remove('is-on'); });
    var msg = root.querySelector('.zdo-none');
    msg.hidden = view.mode !== 'none';
    msg.textContent = waiting ? 'Зареждаме начините на доставка…' : 'За тази поръчка в момента няма настроена доставка. Моля, свържете се с магазина — ще я изпратим веднага.';
    if (none && !noShippingSent) { noShippingSent = true; alertNoShipping(); }
  }

  /** The shop hears that a customer reached the checkout but ConvertBuilder offers no shipping for this cart. */
  function alertNoShipping() {
    try {
      var body = JSON.stringify({ e: 'no_shipping', p: String(location.pathname || '/').slice(0, 200) }), url = API + '/api/visit';
      if (!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' })))) fetch(url, { method: 'POST', body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* never disturb the checkout */ }
  }

  function bind() {
    root.addEventListener('change', function (e) {
      if (e.target.getAttribute('data-role') === 'inv-on') { el('inv-fields').hidden = !e.target.checked; return; }
      if (e.target.name !== 'zdo-type') return;
      state.type = e.target.value;
      render(); sync(); showError('');
      var courier = officeCourier(state.type);
      if (courier && !state[courier]) loadOffices(courier).then(function () { renderOfficeList(courier); }, function () { officesFailed(courier); });
      if (ADDRESS_LABEL[state.type]) loadCities().then(renderCityList, function () {});
    });
    root.addEventListener('input', function (e) {
      var role = e.target.getAttribute('data-role'), v = e.target.value;
      if (role === 'econt-search' || role === 'speedy-search' || role === 'boxnow-search') renderOfficeList(role.split('-')[0]);
      else if (role === 'econt-city') state.econtCity = v;
      else if (role === 'econt-text') state.econtText = v;
      else if (role === 'speedy-city') state.speedyCity = v;
      else if (role === 'speedy-text') state.speedyText = v;
      else if (role === 'boxnow-city') state.boxnowCity = v;
      else if (role === 'boxnow-text') state.boxnowText = v;
      else if (role === 'addr-city') { state.addrCity = v; state.addrPost = ''; renderCityList(); }
      else if (role === 'addr-street') state.addrStreet = v;
      else return;
      if (!/-search$/.test(role)) { sync(); showError(''); }
    });
    root.addEventListener('click', function (e) {
      var t = e.target.closest('button,a');
      if (!t || !root.contains(t)) return;
      var role = t.getAttribute('data-role');
      if (t.hasAttribute('data-id')) {
        var id = t.getAttribute('data-id'), c = id.split(':')[0];
        state[c] = (offices[c] || []).filter(function (o) { return o.id === id; })[0] || null;
        el(c + '-search').value = ''; el(c + '-list').innerHTML = '';
        render(); sync(); showError('');
      } else if (t.hasAttribute('data-city')) {
        var cid = Number(t.getAttribute('data-city'));
        var c = cities.filter(function (x) { return x.id === cid; })[0];
        if (c) { state.addrCity = c.name; state.addrPost = c.postCode; el('addr-city').value = c.name; }
        el('city-list').innerHTML = '';
        sync(); el('addr-street').focus();
      } else if (/-locate$/.test(role || '')) {
        locate(role.split('-')[0]);
      } else if (/-map$/.test(role || '')) {
        var mc2 = role.split('-')[0];
        (offices[mc2] ? Promise.resolve() : loadOffices(mc2)).then(function () { openMap(mc2); }, function () { officesFailed(mc2); });
      } else if (role === 'econt-manual' || role === 'speedy-manual' || role === 'boxnow-manual') {
        e.preventDefault();
        var mc = role.split('-')[0];
        state[mc + 'Fallback'] = true; render(); sync(); el(mc + '-city').focus();
        loadCities().then(sync, function () {});
      } else if (role === 'change') {
        var cc = officeCourier(state.type);
        if (cc) { state[cc] = null; render(); sync(); el(cc + '-search').focus(); }
      }
    });
  }

  var MSG_SHIPPING_UPDATED = 'Цената на доставката беше обновена – натиснете „ПОРЪЧАЙ СЕГА“ отново.';

  /** True when our widget isn't in play (unmounted, or ConvertBuilder itself hid the address part): never block checkout then. */
  function widgetInactive() {
    if (!root || !document.contains(root)) return true;
    var addr = field('shippingAddress'), part = addr && addr.closest('[data-role="address-part"]');
    // ConvertBuilder hides it with its `none` class (toggleDisplay); our own hiding is the :has() CSS rule
    return !!(part && (part.classList.contains('none') || part.style.display === 'none'));
  }

  var shippingFailedAt = 0;

  function installInterceptor() {
    var prev = window.WebPlatform.checkoutInterceptor || null;
    var mine = {
      beforeComplete: function (ok, fail) {
        var msg = '';
        try {
          if (!widgetInactive()) {
            msg = validateSelection(selection());
            // a clicked shipping radio starts an async price update in ConvertBuilder — don't submit before it settles
            // ask for one more press at most once per 30 s, so a store that keeps resetting the method can't lock the customer out
            if (!msg && sync()) {
              if (Date.now() - shippingFailedAt > 30000) { shippingFailedAt = Date.now(); msg = MSG_SHIPPING_UPDATED; }
              else console.warn('[zdo] shipping option not accepted by the store');
            }
          }
        } catch (err) {
          // never hang or break the store's checkout because of our code
          console.warn('[zdo]', err);
          msg = '';
        }
        if (msg) {
          try { showError(msg); } catch (err) { console.warn('[zdo]', err); }
          fail(msg);
          return;
        }
        if (prev && prev.beforeComplete) prev.beforeComplete(ok, fail); else ok();
      }
    };
    if (prev && prev.onCompleted) mine.onCompleted = prev.onCompleted;
    window.WebPlatform.checkoutInterceptor = mine;
  }

  /** The invoice details typed under the picker (only when „Искам фактура“ is ticked). */
  function readInvoice() {
    var on = root && el('inv-on');
    if (!on || !on.checked) return undefined;
    var out = {};
    [].forEach.call(root.querySelectorAll('[data-inv]'), function (i) { out[i.getAttribute('data-inv')] = clean(i.value); });
    return out;
  }
  function readFields() {
    var dummy = (form || document).querySelector('input[id^="shippingPhone_"][id$="_dummy"]');
    return { name: val('name'), email: val('email'), phone: val('shippingPhone') || (dummy ? dummy.value : ''), address: val('shippingAddress'), city: val('shippingCity'), zip: val('shippingZipCode'), invoice: readInvoice() };
  }

  /** platform.events.order_completed fires after ConvertBuilder accepted the order, before its thank-you redirect. */
  function onOrderCompleted(e) {
    cartDone = true; clearTimeout(cartTimer);
    try {
      var body = JSON.stringify(buildOrderPayload(e.detail, selection(), readFields(), location.href));
      var url = API + '/api/orders';
      if (!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' })))) {
        fetch(url, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      }
    } catch (err) { console.warn('[zdo]', err); }
  }

  function shippingNeedsClick() {
    if (!state.type) return false;
    var o = shippingOptions(), i = pickOptionIndex(o.labels, state.type);
    return i >= 0 && !o.radios[i].checked;
  }

  var reselectTimes = [];
  /** Re-apply our shipping option and prices after ConvertBuilder re-rendered; at most 3 re-select clicks per 5 s. */
  function reapplyShipping() {
    try {
      var now = Date.now();
      reselectTimes = reselectTimes.filter(function (t) { return now - t < 5000; });
      if (reselectTimes.length >= 3) { if (shippingNeedsClick()) console.warn('[zdo] shipping option keeps resetting'); }
      else if (selectShippingOption()) reselectTimes.push(now);
      fillPrices();
    } catch (err) { console.warn('[zdo]', err); }
  }

  function onOrderChanged() { setTimeout(reapplyShipping, 50); }

  /** ConvertBuilder rebuilds the shipping radios after an address change without always firing order_changed — watch them. */
  function watchShipping() {
    if (typeof MutationObserver === 'undefined') return;
    var radio = document.querySelector('input[name="shippingOption"]');
    var wrap = radio && radio.closest('.tick-wrapper');
    var box = document.querySelector('[data-role="shipping-methods"]') || (wrap && wrap.parentNode) || document.body;
    var timer = null;
    new MutationObserver(function (muts) {
      try {
        if (!muts.some(function (m) { return !root || !root.contains(m.target); })) return; // ignore our own .zdo changes
        clearTimeout(timer);
        timer = setTimeout(reapplyShipping, 100);
      } catch (err) { console.warn('[zdo]', err); }
    }).observe(box, { childList: true, subtree: true });
  }

  function mount(last) {
    var parts = [].map.call(document.querySelectorAll('[name="shippingAddress"]'), function (a) { return a.closest('[data-role="address-part"]'); }).filter(Boolean);
    var part = visiblePart(parts) || (last ? parts[0] : null); // wait for the shown copy; in the end take the first, as before
    if (!part || !window.WebPlatform || !document.querySelector('a[data-role="continue"]')) return false;
    if (document.querySelector('.zdo')) return true;
    form = part.closest('.checkout-info') || part.parentNode;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    root = document.createElement('div');
    root.className = 'zdo';
    root.innerHTML = TEMPLATE;
    part.parentNode.insertBefore(root, part);
    mountedAt = Date.now();
    [].forEach.call(root.querySelectorAll('[data-logo]'), function (img) { img.src = logoFor(API, img.getAttribute('data-logo')); img.onerror = function () { img.remove(); }; });
    loadShopInfo();
    fillPrices();
    setTimeout(fillPrices, NO_SHIPPING_GRACE_MS + 100); // decide "no shipping" only after ConvertBuilder had time to load
    bind();
    render();
    installInterceptor();
    document.addEventListener('platform.events.order_completed', onOrderCompleted, true);
    // ConvertBuilder may re-render its shipping methods after an address change: re-apply ours
    document.addEventListener('platform.events.order_changed', onOrderChanged, true);
    watchShipping();
    watchCart();
    return true;
  }

  /* Abandoned carts: once a real phone is typed, what the customer entered goes to Ordyx — debounced, silent, never in the way.
     Funnel checkouts keep the cart only in ConvertBuilder's order events and the analytics data layer (adhdbg.eu, 2026-10-17);
     store checkouts in WebPlatform.Store.cart (tiarracosmetics.com). */
  var lastOrderEvent = null, cartTimer = null, lastCartSent = '', cartDone = false;
  function watchCart() {
    var remember = function (e) { if (e && e.detail) lastOrderEvent = e.detail; queueCart(); };
    document.addEventListener('platform.events.order_changed', remember, true);
    document.addEventListener('platform.events.order_initiate_checkout', remember, true);
    var ours = /^(name|email|shippingPhone|zdo-type)$/;
    document.addEventListener('input', function (e) { if (e.target && ours.test(e.target.name || '')) queueCart(); }, true);
    document.addEventListener('change', function (e) { if (e.target && ours.test(e.target.name || '')) queueCart(); }, true);
  }
  function queueCart() { clearTimeout(cartTimer); cartTimer = setTimeout(sendCart, 1500); }
  function sendCart() {
    if (cartDone) return; // the order went through: this checkout is not abandoned
    try {
      var S = (window.WebPlatform && window.WebPlatform.Store) || {};
      var cart = cartFrom({ eventOrder: lastOrderEvent, storeCart: S.cart, dataLayer: window.dataLayer, currency: S.currency });
      var sel = formatSelection(selection());
      var p = cartPayload({ name: val('name'), email: val('email'), phone: val('shippingPhone') }, cart, sel ? sel.address : '', location.href.split(/[?#]/)[0]);
      if (!p) return;
      var body = JSON.stringify(p);
      if (body === lastCartSent) return;
      lastCartSent = body;
      var url = API + '/api/visit';
      if (!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' })))) {
        fetch(url, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      }
    } catch (e) { /* abandoned carts must never disturb the checkout */ }
  }

  function trackVisit() {
    if (window.__zdoVisitSent) return; // once per page load
    window.__zdoVisitSent = true;
    try {
      var body = visitPayload(location, document), url = API + '/api/visit';
      if (!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' })))) {
        fetch(url, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
      }
    } catch (e) { /* statistics must never disturb the shop */ }
  }

  /**
   * Another platform mounts the picker: OrdyxPicker.mount(el, { api, host, type, onChange }) → { value(), setType(type), destroy() }.
   * type: econt_office | econt_address | speedy_office | speedy_address | boxnow_locker (the platform shows its own shipping methods and prices);
   * onChange gets { type, officeId, officeText, city, postCode, addressText, error } on every change; value() the same now.
   */
  function mountStandalone(target, opts) {
    opts = opts || {};
    if (root) destroyStandalone();
    API = opts.api || API || (SCRIPT && SCRIPT.src ? new URL(SCRIPT.src).origin : 'https://app.ordyx.eu');
    standalone = { host: opts.host || location.host, onChange: typeof opts.onChange === 'function' ? opts.onChange : function () {} };
    if (!document.querySelector('style[data-zdo]')) { var style = document.createElement('style'); style.setAttribute('data-zdo', '1'); style.textContent = CSS; document.head.appendChild(style); }
    root = document.createElement('div');
    root.className = 'zdo zdo-standalone';
    root.innerHTML = TEMPLATE;
    root.querySelector('.zdo-title').hidden = true;
    root.querySelector('.zdo-inv').hidden = true; // the platform's own form asks for invoice details
    target.appendChild(root);
    mountedAt = Date.now();
    [].forEach.call(root.querySelectorAll('[data-logo]'), function (img) { img.src = logoFor(API, img.getAttribute('data-logo')); img.onerror = function () { img.remove(); }; });
    loadShopInfo();
    bind();
    var handle = {
      value: currentValue,
      setType: function (type) {
        state.type = TYPES.indexOf(type) >= 0 ? type : '';
        render(); showError('');
        var courier = officeCourier(state.type);
        if (courier && !state[courier]) loadOffices(courier).then(function () { renderOfficeList(courier); }, function () { officesFailed(courier); });
        if (ADDRESS_LABEL[state.type]) loadCities().then(renderCityList, function () {});
        sync();
      },
      showError: showError,
      destroy: destroyStandalone
    };
    handle.setType(opts.type || '');
    return handle;
  }
  function destroyStandalone() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null; standalone = null; state.type = '';
    // the next mount is a new customer: forget the choice, keep the downloaded office lists
    ['econt', 'speedy', 'boxnow'].forEach(function (c) { state[c] = null; state[c + 'Fallback'] = false; state[c + 'City'] = ''; state[c + 'Text'] = ''; });
    state.geo = null; state.addrCity = ''; state.addrPost = ''; state.addrStreet = '';
  }
  if (typeof window !== 'undefined') window.OrdyxPicker = { mount: mountStandalone };

  /**
   * The picker in any form, with no code: <div data-ordyx-picker data-type="econt_office" data-into="#office" data-city="#city"
   * data-zip="#zip" data-office-id="#office_id"></div>. data-type is a fixed type or "select:#how" (a <select> whose option values
   * are Ordyx types; the picker follows it). The chosen point is written into those inputs; nothing is written until a choice is made.
   */
  function fieldsOf(el) {
    var pick = function (attr) { var sel = el.getAttribute(attr); return sel ? document.querySelector(sel) : null; };
    return { into: pick('data-into'), city: pick('data-city'), zip: pick('data-zip'), id: pick('data-office-id'), address: pick('data-address') };
  }
  /** writes through the native setter, so frameworks that watch the input (React, Vue) see the change too */
  function put(input, value) {
    if (!input || input.value === value) return;
    var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    if (desc && desc.set) desc.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function mountDeclared(el) {
    var f = fieldsOf(el), typeAttr = el.getAttribute('data-type') || 'econt_office', sel = null, wrote = false;
    if (/^select:/.test(typeAttr)) { sel = document.querySelector(typeAttr.slice(7)); typeAttr = sel ? sel.value : ''; }
    var handle = mountStandalone(el, {
      api: API, host: el.getAttribute('data-host') || location.host, type: typeAttr,
      onChange: function (v) {
        var has = Boolean(v.officeText || v.addressText);
        if (!has && !wrote) return; // nothing chosen yet: leave the site's fields alone
        // a choice, or the previous choice gone (the type changed): the site's fields follow — an old office never stays behind
        put(f.into, has ? v.officeText : ''); put(f.city, has ? v.city : ''); put(f.zip, has ? v.postCode : ''); put(f.id, has ? v.officeId : ''); put(f.address, has ? v.addressText : '');
        wrote = has;
      }
    });
    if (sel) sel.addEventListener('change', function () { handle.setType(sel.value); });
    el.ordyxPicker = handle;
  }
  /** one picker per page (the widget keeps one selection); extra data-ordyx-picker divs are left empty */
  function mountDeclaredAll() { var el = document.querySelector('[data-ordyx-picker]'); if (el && !el.ordyxPicker) mountDeclared(el); }
  if (typeof window !== 'undefined' && window.__ZDO_NO_BOOT__) return; // only the picker is wanted (the Ordyx admin)

  function boot() {
    API = SCRIPT && SCRIPT.src ? new URL(SCRIPT.src).origin : 'https://zd-orders.vercel.app';
    trackVisit();
    if (document.querySelector('[data-ordyx-picker]')) mountDeclaredAll(); // a custom site's form; ConvertBuilder pages still get their checkout below
    var tries = 0;
    (function attempt() { if (!mount(tries >= 39) && ++tries < 40) setTimeout(attempt, 250); })();
  }

  if (window.WebPlatform && typeof window.WebPlatform.onReady === 'function') window.WebPlatform.onReady(boot);
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
