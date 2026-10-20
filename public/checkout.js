/* zd-orders · избор на офис Еконт / офис Спиди / адрес Спиди / автомат BOX NOW в чекаута на ConvertBuilder + копие на приетата поръчка. */
(function () {
  'use strict';

  var SCRIPT = typeof document !== 'undefined' ? document.currentScript : null;
  var TOKEN = 'zdo_pub_2026_k7q3'; // not a secret — only filters out random spam
  var COURIER_LABEL = { econt_office: 'ЕКОНТ', speedy_office: 'СПИДИ', boxnow_locker: 'BOX NOW' };
  // ConvertBuilder method names differ per store ("До офис ECONT", "Доставка до офис на Еконт"…): match the kind + courier in Latin or Cyrillic
  var OPTION_PATTERN = { econt_office: /офис.*(econt|еконт)/i, speedy_office: /офис.*(speedy|спиди)/i, speedy_address: /адрес.*(speedy|спиди)/i, boxnow_locker: /box\s*now|бокс\s*нау/i };
  var OFFICE_TYPES = { econt_office: 'econt', speedy_office: 'speedy', boxnow_locker: 'boxnow' }; // type → courier of its office list

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
    if (sel.type === 'speedy_address') {
      var c = clean(sel.city), street = clean(sel.street);
      if (!c || !street) return null;
      return { address: 'СПИДИ – адрес: ' + street, city: c, zip: sel.postCode || '', officeId: '' };
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
    if (type === 'speedy_address') {
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

  var TYPES = ['econt_office', 'speedy_office', 'speedy_address', 'boxnow_locker'];
  /**
   * Which of our choices to show from ConvertBuilder's shipping labels: the ones it offers (normal); none offered at all → 'none'
   * (the cart has no shipping method — a message, never made-up choices); only unknown names → 'all' (the shop prices them).
   */
  function shippingView(labels) {
    var available = {}, any = false;
    TYPES.forEach(function (t) { available[t] = pickOptionIndex(labels, t) >= 0; any = any || available[t]; });
    if (any) return { mode: 'normal', available: available };
    if (!labels.length) return { mode: 'none', available: { econt_office: false, speedy_office: false, speedy_address: false, boxnow_locker: false } };
    // BOX NOW only when the shop offers it by name: a shop without a BOX NOW contract must never get locker orders
    return { mode: 'all', available: { econt_office: true, speedy_office: true, speedy_address: true, boxnow_locker: false } };
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
      address_text: sel && sel.type === 'speedy_address' ? clean(sel.street) : '',
      items: ((order.items && order.items.length ? order.items : detail.items) || []).map(function (it) {
        return { name: clean(it.title || it.name || it.productId || it.id), qty: Number(it.quantity) || 1, price: Number(it.price != null ? it.price : it.item_price) || 0 };
      }),
      total: Number(detail.total != null ? detail.total : order.total) || 0,
      currency: clean(detail.currency || order.currency || 'EUR'),
      payment_method: clean(order.paymentType),
      page_url: pageUrl
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

  var core = {
    TOKEN: TOKEN, norm: norm, searchOffices: searchOffices, searchCities: searchCities, formatSelection: formatSelection,
    validateSelection: validateSelection, pickOptionIndex: pickOptionIndex, optionPrice: optionPrice, officeLabel: officeLabel,
    buildOrderPayload: buildOrderPayload, visitPayload: visitPayload, shippingView: shippingView, cartFrom: cartFrom, cartPayload: cartPayload
  };
  if (typeof window !== 'undefined' && window.__ZDO_TEST__) { window.__zdoCore = core; return; }

  var API = '';
  var root = null, cities = null, offices = { econt: null, speedy: null, boxnow: null };
  var state = {
    type: '', econt: null, econtFallback: false, econtCity: '', econtText: '',
    speedy: null, speedyFallback: false, speedyCity: '', speedyText: '',
    boxnow: null, boxnowFallback: false, boxnowCity: '', boxnowText: '',
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
    '.zdo-panel{display:none;margin:-2px 0 10px}.zdo-panel.is-on{display:block}',
    '.zdo-input{display:block;width:100%!important;height:46px!important;padding:0 12px!important;margin:0 0 8px!important;border:1.5px solid #d9c3ca!important;border-radius:8px!important;font-size:16px!important;background:#fff!important;color:#222!important}',
    '.zdo-list{max-height:260px;overflow-y:auto;border-radius:8px}',
    '.zdo-list:not(:empty){border:1px solid #e8d3da;margin:-4px 0 8px}',
    '.zdo-item{display:block;width:100%;text-align:left;padding:10px 12px;border:0;border-bottom:1px solid #f1e4e8;background:#fff;font-size:14px;line-height:1.35;cursor:pointer;color:#222}',
    '.zdo-item:hover,.zdo-item:focus{background:#fdf3f6}.zdo-item small{display:block;color:#7a6a6f}',
    '.zdo-note{padding:8px 2px;font-size:14px;color:#7a6a6f}',
    '.zdo-picked:not(:empty){padding:10px 12px;margin:0 0 8px;border-radius:8px;background:#f3faf4;border:1px solid #bfe0c6;font-size:14px;line-height:1.4}',
    '.zdo-picked button{border:0;background:none;color:#b0426b;text-decoration:underline;padding:0;margin-left:6px;cursor:pointer;font-size:14px}',
    '.zdo-link{display:inline-block;font-size:13px;color:#7a6a6f!important;text-decoration:underline;margin:0 0 8px}',
    '.zdo-none{margin:4px 0 10px;padding:12px 14px;border-radius:10px;background:#fff7ed;color:#7c2d12;font-size:14px;line-height:1.4}',
    '.zdo-error:not(:empty){margin:4px 0 10px;padding:10px 12px;border-radius:8px;background:#fdecee;color:#a1122f;font-size:14px;font-weight:600}'
  ].join('');

  function officePanel(courier, type, name, lockersOnly) {
    var where = lockersOnly ? 'автомат' : 'офис';
    return '<label class="zdo-opt"><input type="radio" name="zdo-type" value="' + type + '"><span>До ' + (lockersOnly ? '' : 'офис или ') + 'автомат на <b>' + name + '</b></span><span class="zdo-price" data-price="' + type + '"></span></label>' +
      '<div class="zdo-panel" data-for="' + type + '">' +
        '<div class="zdo-picked" data-role="' + courier + '-picked"></div>' +
        '<div data-role="' + courier + '-pick"><input class="zdo-input" data-role="' + courier + '-search" type="text" placeholder="Напишете град или ' + (lockersOnly ? 'адрес на автомат' : 'име на офис') + '" autocomplete="off"><div class="zdo-list" data-role="' + courier + '-list"></div>' +
          '<a href="#" class="zdo-link" data-role="' + courier + '-manual">Не намирам ' + where + 'а си – въведи ръчно</a></div>' +
        '<div data-role="' + courier + '-fallback" hidden><div class="zdo-note">Въведете ' + where + 'а ръчно:</div>' +
          '<input class="zdo-input" data-role="' + courier + '-city" type="text" placeholder="Населено място"><input class="zdo-input" data-role="' + courier + '-text" type="text" placeholder="' + (lockersOnly ? 'Адрес на автомата' : 'Име или адрес на офиса') + ' на ' + name + '"></div>' +
      '</div>';
  }

  var TEMPLATE =
    '<div class="zdo-title">Доставка</div>' +
    '<div class="zdo-none" hidden></div>' +
    officePanel('econt', 'econt_office', 'Еконт') +
    officePanel('speedy', 'speedy_office', 'Спиди') +
    '<label class="zdo-opt"><input type="radio" name="zdo-type" value="speedy_address"><span>До адрес със <b>Спиди</b></span><span class="zdo-price" data-price="speedy_address"></span></label>' +
    '<div class="zdo-panel" data-for="speedy_address">' +
      '<input class="zdo-input" data-role="addr-city" type="text" placeholder="Населено място" autocomplete="off"><div class="zdo-list" data-role="city-list"></div>' +
      '<input class="zdo-input" data-role="addr-street" type="text" placeholder="Улица, номер, блок, вход, етаж, апартамент">' +
    '</div>' +
    officePanel('boxnow', 'boxnow_locker', 'BOX NOW', true) +
    '<div class="zdo-error" role="alert"></div>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(role) { return root.querySelector('[data-role="' + role + '"]'); }
  function field(name) { return document.querySelector('[name="' + name + '"]'); }
  function val(name) { var f = field(name); return f ? f.value : ''; }
  function getJson(path) { return fetch(API + path).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  function loadOffices(courier) {
    if (offices[courier]) return Promise.resolve(offices[courier]);
    return getJson('/api/offices?courier=' + courier).then(function (d) {
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
    if (t === 'speedy_address') return { type: t, city: state.addrCity, postCode: state.addrPost, street: state.addrStreet };
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

  /** Copies the choice into ConvertBuilder's own fields so its validation and order see it. Returns true if it had to click a shipping radio. */
  function sync() {
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
      (o.city ? '<br>' + esc(o.city) : '') + ' <button type="button" data-role="change">Смени</button>';
  }

  function render() {
    [].forEach.call(root.querySelectorAll('.zdo-opt'), function (l) { l.classList.toggle('is-on', l.querySelector('input').value === state.type); });
    [].forEach.call(root.querySelectorAll('.zdo-panel'), function (p) { p.classList.toggle('is-on', p.getAttribute('data-for') === state.type); });
    ['econt', 'speedy', 'boxnow'].forEach(function (c) {
      var picked = state[c], fallback = state[c + 'Fallback'];
      el(c + '-picked').innerHTML = picked && !fallback ? pickedHtml(picked) : '';
      el(c + '-pick').hidden = !!picked || fallback;
      el(c + '-fallback').hidden = !fallback;
    });
  }

  function renderOfficeList(courier) {
    var list = el(courier + '-list'), q = el(courier + '-search').value;
    if (!norm(q)) { list.innerHTML = ''; return; }
    if (!offices[courier]) { list.innerHTML = '<div class="zdo-note">Зареждане…</div>'; return; }
    var found = searchOffices(offices[courier], q, 80);
    list.innerHTML = found.length ? found.map(function (o) {
      return '<button type="button" class="zdo-item" data-id="' + esc(o.id) + '">' + esc(officeLabel(o)) + (o.address ? '<small>' + esc(o.address) + '</small>' : '') + '</button>';
    }).join('') : '<div class="zdo-note">Няма намерен ' + (courier === 'boxnow' ? 'автомат' : 'офис') + '. Опитайте само с името на града.</div>';
  }

  function renderCityList() {
    var list = el('city-list'), q = el('addr-city').value;
    if (!cities || !norm(q) || (state.addrPost && q === state.addrCity)) { list.innerHTML = ''; return; }
    list.innerHTML = searchCities(cities, q, 8).map(function (c) {
      return '<button type="button" class="zdo-item" data-city="' + esc(c.id) + '">' + esc(c.name) + (c.region ? ' <small>обл. ' + esc(c.region) + '</small>' : '') + '</button>';
    }).join('');
  }

  function officesFailed(courier) { state[courier + 'Fallback'] = true; render(); sync(); loadCities().then(sync, function () {}); }

  var mountedAt = 0, noShippingSent = false;
  var NO_SHIPPING_GRACE_MS = 3000; // ConvertBuilder may still be loading its methods (slow phones)
  function fillPrices() {
    var o = shippingOptions(), view = shippingView(o.labels);
    TYPES.forEach(function (t) {
      var i = pickOptionIndex(o.labels, t);
      root.querySelector('[data-price="' + t + '"]').textContent = i >= 0 ? optionPrice(o.labels[i]) : '';
    });
    var waiting = view.mode === 'none' && Date.now() - mountedAt < NO_SHIPPING_GRACE_MS;
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
      if (e.target.name !== 'zdo-type') return;
      state.type = e.target.value;
      render(); sync(); showError('');
      var courier = officeCourier(state.type);
      if (courier && !state[courier]) loadOffices(courier).then(function () { renderOfficeList(courier); }, function () { officesFailed(courier); });
      if (state.type === 'speedy_address') loadCities().then(renderCityList, function () {});
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

  function readFields() {
    var dummy = document.querySelector('input[id^="shippingPhone_"][id$="_dummy"]');
    return { name: val('name'), email: val('email'), phone: val('shippingPhone') || (dummy ? dummy.value : ''), address: val('shippingAddress'), city: val('shippingCity'), zip: val('shippingZipCode') };
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

  function mount() {
    var addr = field('shippingAddress');
    var part = addr && addr.closest('[data-role="address-part"]');
    if (!part || !window.WebPlatform || !document.querySelector('a[data-role="continue"]')) return false;
    if (document.querySelector('.zdo')) return true;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    root = document.createElement('div');
    root.className = 'zdo';
    root.innerHTML = TEMPLATE;
    part.parentNode.insertBefore(root, part);
    mountedAt = Date.now();
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

  function boot() {
    API = SCRIPT && SCRIPT.src ? new URL(SCRIPT.src).origin : 'https://zd-orders.vercel.app';
    trackVisit();
    var tries = 0;
    (function attempt() { if (!mount() && ++tries < 40) setTimeout(attempt, 250); })();
  }

  if (window.WebPlatform && typeof window.WebPlatform.onReady === 'function') window.WebPlatform.onReady(boot);
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
