/* zd-orders · избор на офис Еконт / офис Спиди / адрес Спиди в чекаута на ConvertBuilder + копие на приетата поръчка. */
(function () {
  'use strict';

  var SCRIPT = typeof document !== 'undefined' ? document.currentScript : null;
  var TOKEN = 'zdo_pub_2026_k7q3'; // not a secret — only filters out random spam
  var SPEEDY_ORIGIN = 'https://services.speedy.bg';
  var SPEEDY_MAP = SPEEDY_ORIGIN + '/office_locator_widget_v3/office_locator.php?lang=bg&selectOfficeButtonCaption=' + encodeURIComponent('Избери');
  var COURIER_LABEL = { econt_office: 'ЕКОНТ', speedy_office: 'СПИДИ' };
  var OPTION_PATTERN = { econt_office: /офис\s+econt/i, speedy_office: /офис\s+speedy/i, speedy_address: /адрес\s+speedy/i };

  function clean(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function norm(v) { return clean(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

  /** Every word of the query must appear in the office's city, name, address or code. */
  function searchOffices(offices, query, limit) {
    var words = norm(query).split(' ').filter(Boolean);
    var out = [];
    if (!words.length) return out;
    for (var i = 0; i < offices.length && out.length < (limit || 80); i++) {
      var o = offices[i];
      var hay = o._hay || (o._hay = norm(o.city + ' ' + o.name + ' ' + o.address + ' ' + o.code));
      if (words.every(function (w) { return hay.indexOf(w) !== -1; })) out.push(o);
    }
    return out;
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

  function formatSelection(sel) {
    if (!sel) return null;
    if (sel.type === 'econt_office' || sel.type === 'speedy_office') {
      var o = sel.office;
      if (o) {
        return {
          address: COURIER_LABEL[sel.type] + ' – ' + (o.isAutomat ? 'автомат ' : 'офис ') + (o.name ? o.name + ' (' + o.code + ')' : '№' + o.code) + (o.address ? ', ' + o.address : ''),
          city: o.city || '', zip: o.postCode || '', officeId: o.id
        };
      }
      var text = clean(sel.officeText), city = clean(sel.city);
      if (!sel.fallback || !text || !city) return null;
      return { address: COURIER_LABEL[sel.type] + ' – офис: ' + text, city: city, zip: '', officeId: '' };
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
    if (type === 'econt_office' || type === 'speedy_office') {
      if (sel.office) return '';
      if (sel.fallback) {
        if (!clean(sel.city)) return 'Моля, въведете населено място.';
        if (!clean(sel.officeText)) return 'Моля, въведете име или адрес на офиса.';
        return '';
      }
      return type === 'econt_office' ? 'Моля, изберете офис или автомат на Еконт.' : 'Моля, изберете офис на Спиди от картата.';
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

  /** The Speedy map posts the chosen office to its parent page; anything from another origin is ignored. */
  function parseSpeedyMessage(origin, data) {
    if (origin !== SPEEDY_ORIGIN) return null;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return null; } }
    if (typeof data === 'number') data = { id: data }; // bare office id (also covers the string "79", parsed above)
    if (!data || typeof data !== 'object') return null;
    var id = clean(data.id);
    if (!/^\d{1,10}$/.test(id)) return null;
    var a = data.address || {};
    return {
      id: 'speedy:' + id, code: id, name: clean(data.name),
      address: clean(a.fullAddressString) || [clean(a.localAddressString), clean(a.siteAddressString)].filter(Boolean).join(', '),
      city: clean(a.siteName), postCode: clean(a.postCode), isAutomat: clean(data.type).toUpperCase() === 'APT'
    };
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

  var core = {
    TOKEN: TOKEN, norm: norm, searchOffices: searchOffices, searchCities: searchCities, formatSelection: formatSelection,
    validateSelection: validateSelection, pickOptionIndex: pickOptionIndex, parseSpeedyMessage: parseSpeedyMessage,
    buildOrderPayload: buildOrderPayload
  };
  if (typeof window !== 'undefined' && window.__ZDO_TEST__) { window.__zdoCore = core; return; }

  var API = '';
  var root = null, offices = null, cities = null;
  var state = {
    type: '', econt: null, econtFallback: false, econtCity: '', econtText: '',
    speedy: null, speedyFallback: false, speedyCity: '', speedyText: '',
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
    '.zdo-btn{display:block;width:100%;height:46px;border:0;border-radius:8px;background:#b0426b!important;color:#fff!important;font-size:16px;font-weight:700;cursor:pointer;margin:0 0 8px}',
    '.zdo-link{display:inline-block;font-size:13px;color:#7a6a6f!important;text-decoration:underline;margin:0 0 8px}',
    '.zdo-error:not(:empty){margin:4px 0 10px;padding:10px 12px;border-radius:8px;background:#fdecee;color:#a1122f;font-size:14px;font-weight:600}',
    '.zdo-modal{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:12px}',
    '.zdo-modal-box{background:#fff;border-radius:12px;width:100%;max-width:960px;height:90vh;display:flex;flex-direction:column;overflow:hidden}',
    '.zdo-modal-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #eee;font-size:15px}',
    '.zdo-modal-head button{border:0;background:#f4f4f4;border-radius:20px;padding:6px 12px;cursor:pointer;font-size:14px}',
    '.zdo-modal iframe{flex:1;width:100%;border:0}',
    '.zdo-modal-foot{padding:8px 14px;font-size:12px;color:#777;border-top:1px solid #eee}',
    '@media (max-width:600px){.zdo-modal{padding:0}.zdo-modal-box{height:100%;border-radius:0}}'
  ].join('');

  var TEMPLATE =
    '<div class="zdo-title">Доставка</div>' +
    '<label class="zdo-opt"><input type="radio" name="zdo-type" value="econt_office"><span>До офис или автомат на <b>Еконт</b></span><span class="zdo-price" data-price="econt_office"></span></label>' +
    '<div class="zdo-panel" data-for="econt_office">' +
      '<div class="zdo-picked" data-role="econt-picked"></div>' +
      '<div data-role="econt-pick"><input class="zdo-input" data-role="econt-search" type="text" placeholder="Напишете град или име на офис" autocomplete="off"><div class="zdo-list" data-role="econt-list"></div></div>' +
      '<div data-role="econt-fallback" hidden><div class="zdo-note">Списъкът с офиси не се зареди. Въведете офиса ръчно:</div>' +
        '<input class="zdo-input" data-role="econt-city" type="text" placeholder="Населено място"><input class="zdo-input" data-role="econt-text" type="text" placeholder="Име или адрес на офиса на Еконт"></div>' +
    '</div>' +
    '<label class="zdo-opt"><input type="radio" name="zdo-type" value="speedy_office"><span>До офис или автомат на <b>Спиди</b></span><span class="zdo-price" data-price="speedy_office"></span></label>' +
    '<div class="zdo-panel" data-for="speedy_office">' +
      '<div class="zdo-picked" data-role="speedy-picked"></div>' +
      '<div data-role="speedy-pick"><button type="button" class="zdo-btn" data-role="speedy-open">Избери офис от картата</button><a href="#" class="zdo-link" data-role="speedy-manual">Картата не се зарежда? Въведете офиса ръчно</a></div>' +
      '<div data-role="speedy-fallback" hidden><input class="zdo-input" data-role="speedy-city" type="text" placeholder="Населено място"><input class="zdo-input" data-role="speedy-text" type="text" placeholder="Име или адрес на офиса на Спиди"></div>' +
    '</div>' +
    '<label class="zdo-opt"><input type="radio" name="zdo-type" value="speedy_address"><span>До адрес със <b>Спиди</b></span><span class="zdo-price" data-price="speedy_address"></span></label>' +
    '<div class="zdo-panel" data-for="speedy_address">' +
      '<input class="zdo-input" data-role="addr-city" type="text" placeholder="Населено място" autocomplete="off"><div class="zdo-list" data-role="city-list"></div>' +
      '<input class="zdo-input" data-role="addr-street" type="text" placeholder="Улица, номер, блок, вход, етаж, апартамент">' +
    '</div>' +
    '<div class="zdo-error" role="alert"></div>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(role) { return root.querySelector('[data-role="' + role + '"]'); }
  function field(name) { return document.querySelector('[name="' + name + '"]'); }
  function val(name) { var f = field(name); return f ? f.value : ''; }
  function getJson(path) { return fetch(API + path).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  function loadOffices() { return offices ? Promise.resolve(offices) : getJson('/api/offices?courier=econt').then(function (d) { return (offices = d.offices || []); }); }
  function loadCities() { return cities ? Promise.resolve(cities) : getJson('/api/cities').then(function (d) { return (cities = d.cities || []); }); }

  function selection() {
    var t = state.type;
    if (t === 'econt_office') return { type: t, office: state.econtFallback ? null : state.econt, fallback: state.econtFallback, city: state.econtCity, officeText: state.econtText };
    if (t === 'speedy_office') return { type: t, office: state.speedyFallback ? null : state.speedy, fallback: state.speedyFallback, city: state.speedyCity, officeText: state.speedyText };
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

  /** Copies the choice into ConvertBuilder's own fields so its validation and order see it. Returns true if it had to click a shipping radio. */
  function sync() {
    var f = formatSelection(selection());
    setField('shippingAddress', f ? f.address : '');
    setField('shippingCity', f ? f.city : '');
    setField('shippingZipCode', f ? f.zip : '');
    return selectShippingOption();
  }

  function showError(msg) {
    var box = root.querySelector('.zdo-error');
    box.textContent = msg || '';
    if (msg) root.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function pickedHtml(o) {
    var title = o.name ? (o.isAutomat ? 'Автомат ' : 'Офис ') + o.name : 'Офис на Спиди №' + o.code;
    return '<b>' + esc(title) + '</b>' + (o.address ? '<br>' + esc(o.address) : '') +
      (o.city ? '<br>' + esc(o.city) : '') + ' <button type="button" data-role="change">Смени</button>';
  }

  function render() {
    [].forEach.call(root.querySelectorAll('.zdo-opt'), function (l) { l.classList.toggle('is-on', l.querySelector('input').value === state.type); });
    [].forEach.call(root.querySelectorAll('.zdo-panel'), function (p) { p.classList.toggle('is-on', p.getAttribute('data-for') === state.type); });
    el('econt-picked').innerHTML = state.econt && !state.econtFallback ? pickedHtml(state.econt) : '';
    el('econt-pick').hidden = !!state.econt || state.econtFallback;
    el('econt-fallback').hidden = !state.econtFallback;
    el('speedy-picked').innerHTML = state.speedy && !state.speedyFallback ? pickedHtml(state.speedy) : '';
    el('speedy-pick').hidden = !!state.speedy || state.speedyFallback;
    el('speedy-fallback').hidden = !state.speedyFallback;
  }

  function renderEcontList() {
    var list = el('econt-list'), q = el('econt-search').value;
    if (!norm(q)) { list.innerHTML = ''; return; }
    if (!offices) { list.innerHTML = '<div class="zdo-note">Зареждане…</div>'; return; }
    var found = searchOffices(offices, q, 80);
    list.innerHTML = found.length ? found.map(function (o) {
      return '<button type="button" class="zdo-item" data-id="' + esc(o.id) + '">' + esc(o.city + ' – ' + (o.isAutomat ? 'автомат ' : '') + o.name) + '<small>' + esc(o.address) + '</small></button>';
    }).join('') : '<div class="zdo-note">Няма намерен офис. Опитайте само с името на града.</div>';
  }

  function renderCityList() {
    var list = el('city-list'), q = el('addr-city').value;
    if (!cities || !norm(q) || (state.addrPost && q === state.addrCity)) { list.innerHTML = ''; return; }
    list.innerHTML = searchCities(cities, q, 8).map(function (c) {
      return '<button type="button" class="zdo-item" data-city="' + esc(c.id) + '">' + esc(c.name) + (c.region ? ' <small>обл. ' + esc(c.region) + '</small>' : '') + '</button>';
    }).join('');
  }

  function econtFailed() { state.econtFallback = true; render(); sync(); }

  /** True if src is the iframe's window or a frame nested up to 3 levels inside it (the widget may post from a child frame). */
  function fromFrame(src, win) {
    var w = src;
    for (var i = 0; w && win && i < 4; i++) {
      if (w === win) return true;
      try { w = w.parent === w ? null : w.parent; } catch (err) { return false; }
    }
    return false;
  }

  function openSpeedyMap() {
    var m = document.createElement('div');
    m.className = 'zdo-modal';
    m.innerHTML = '<div class="zdo-modal-box"><div class="zdo-modal-head"><b>Изберете офис на Спиди</b><button type="button">Затвори ✕</button></div>' +
      '<iframe title="Офиси на Спиди" allow="geolocation" src="' + SPEEDY_MAP + '"></iframe>' +
      '<div class="zdo-modal-foot">Потърсете града си, после натиснете „Избери“ на офиса.</div></div>';
    function close() { window.removeEventListener('message', onMessage); m.remove(); }
    function onMessage(e) {
      var frame = m.querySelector('iframe');
      if (!frame || !fromFrame(e.source, frame.contentWindow)) return;
      var o = parseSpeedyMessage(e.origin, e.data);
      if (!o) return;
      state.speedy = o; state.speedyFallback = false;
      close(); render(); sync(); showError('');
    }
    window.addEventListener('message', onMessage);
    m.querySelector('.zdo-modal-head button').addEventListener('click', close);
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    document.body.appendChild(m);
  }

  function fillPrices() {
    var o = shippingOptions(), anyAvailable = false, available = {};
    ['econt_office', 'speedy_office', 'speedy_address'].forEach(function (t) {
      var i = pickOptionIndex(o.labels, t);
      available[t] = i >= 0;
      anyAvailable = anyAvailable || i >= 0;
      var m = i >= 0 && o.labels[i].match(/(\d+[.,]\d{2})\s*€/);
      root.querySelector('[data-price="' + t + '"]').textContent = m ? m[1].replace(',', '.') + ' €' : '';
    });
    // hide only choices ConvertBuilder can't price; if it offers none, keep all (its own error will show)
    if (anyAvailable) [].forEach.call(root.querySelectorAll('.zdo-opt input'), function (r) { r.closest('.zdo-opt').hidden = !available[r.value]; });
  }

  function bind() {
    root.addEventListener('change', function (e) {
      if (e.target.name !== 'zdo-type') return;
      state.type = e.target.value;
      render(); sync(); showError('');
      if (state.type === 'econt_office' && !state.econt) loadOffices().then(renderEcontList, econtFailed);
      if (state.type === 'speedy_address') loadCities().then(renderCityList, function () {});
    });
    root.addEventListener('input', function (e) {
      var role = e.target.getAttribute('data-role'), v = e.target.value;
      if (role === 'econt-search') renderEcontList();
      else if (role === 'econt-city') state.econtCity = v;
      else if (role === 'econt-text') state.econtText = v;
      else if (role === 'speedy-city') state.speedyCity = v;
      else if (role === 'speedy-text') state.speedyText = v;
      else if (role === 'addr-city') { state.addrCity = v; state.addrPost = ''; renderCityList(); }
      else if (role === 'addr-street') state.addrStreet = v;
      else return;
      if (role !== 'econt-search') { sync(); showError(''); }
    });
    root.addEventListener('click', function (e) {
      var t = e.target.closest('button,a');
      if (!t || !root.contains(t)) return;
      var role = t.getAttribute('data-role');
      if (t.hasAttribute('data-id')) {
        var id = t.getAttribute('data-id');
        state.econt = offices.filter(function (o) { return o.id === id; })[0] || null;
        el('econt-search').value = ''; el('econt-list').innerHTML = '';
        render(); sync(); showError('');
      } else if (t.hasAttribute('data-city')) {
        var cid = Number(t.getAttribute('data-city'));
        var c = cities.filter(function (x) { return x.id === cid; })[0];
        if (c) { state.addrCity = c.name; state.addrPost = c.postCode; el('addr-city').value = c.name; }
        el('city-list').innerHTML = '';
        sync(); el('addr-street').focus();
      } else if (role === 'change') {
        if (state.type === 'econt_office') { state.econt = null; render(); sync(); el('econt-search').focus(); }
        else { state.speedy = null; render(); sync(); openSpeedyMap(); }
      } else if (role === 'speedy-open') openSpeedyMap();
      else if (role === 'speedy-manual') { e.preventDefault(); state.speedyFallback = true; render(); sync(); el('speedy-city').focus(); }
    });
  }

  var MSG_SHIPPING_UPDATED = 'Цената на доставката беше обновена – натиснете „ПОРЪЧАЙ СЕГА“ отново.';

  /** True when our widget isn't in play (unmounted, or ConvertBuilder itself hid the address part): never block checkout then. */
  function widgetInactive() {
    if (!root || !document.contains(root)) return true;
    var addr = field('shippingAddress'), part = addr && addr.closest('[data-role="address-part"]');
    return !!(part && part.style.display === 'none');
  }

  function installInterceptor() {
    var prev = window.WebPlatform.checkoutInterceptor || null;
    var mine = {
      beforeComplete: function (ok, fail) {
        var msg = '';
        try {
          if (!widgetInactive()) {
            msg = validateSelection(selection());
            // a clicked shipping radio starts an async price update in ConvertBuilder — don't submit before it settles
            if (!msg && sync()) msg = MSG_SHIPPING_UPDATED;
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
    fillPrices();
    bind();
    render();
    installInterceptor();
    document.addEventListener('platform.events.order_completed', onOrderCompleted, true);
    // ConvertBuilder may re-render its shipping methods after an address change: re-apply ours
    document.addEventListener('platform.events.order_changed', onOrderChanged, true);
    watchShipping();
    return true;
  }

  function boot() {
    API = SCRIPT && SCRIPT.src ? new URL(SCRIPT.src).origin : 'https://zd-orders.vercel.app';
    var tries = 0;
    (function attempt() { if (!mount() && ++tries < 40) setTimeout(attempt, 250); })();
  }

  if (window.WebPlatform && typeof window.WebPlatform.onReady === 'function') window.WebPlatform.onReady(boot);
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
