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
          address: COURIER_LABEL[sel.type] + ' – ' + (o.isAutomat ? 'автомат ' : 'офис ') + o.name + ' (' + o.code + ')' + (o.address ? ', ' + o.address : ''),
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
      items: (order.items || []).map(function (it) {
        return { name: clean(it.title || it.name || it.productId), qty: Number(it.quantity) || 1, price: Number(it.price) || 0 };
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

  /* ---- DOM widget (Task 9) ---- */
})();
