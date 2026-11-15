/* Ordyx's own marketing tags (ordyx.eu and the registration on app.ordyx.eu): Meta Pixel and GA4 load only after the visitor
   accepts cookies. The choice is a first-party cookie on .ordyx.eu, so the registration on app.ordyx.eu knows it too.
   window.ordyxTrack: consent() → true/false/null · lead() · registered(eventId) · banner() */
(function () {
  if (window.ordyxTrack) return;
  var COOKIE = 'ordyx_consent', DAYS = 180;
  var onOrdyx = /(^|\.)ordyx\.eu$/.test(location.hostname);
  var API = (document.currentScript && document.currentScript.src) ? new URL(document.currentScript.src).origin : 'https://app.ordyx.eu';
  var ids = null, loaded = false, queue = [];

  function readConsent() {
    var m = document.cookie.match(/(?:^|;\s*)ordyx_consent=([01])/);
    if (m) return m[1] === '1';
    try { var v = localStorage.getItem(COOKIE); return v === '1' ? true : v === '0' ? false : null; } catch (e) { return null; }
  }
  function writeConsent(yes) {
    document.cookie = COOKIE + '=' + (yes ? '1' : '0') + '; max-age=' + DAYS * 86400 + '; path=/; SameSite=Lax' + (onOrdyx ? '; domain=.ordyx.eu' : '') + (location.protocol === 'https:' ? '; Secure' : '');
    try { localStorage.setItem(COOKIE, yes ? '1' : '0'); } catch (e) { /* private mode */ }
  }
  function getIds() {
    if (ids) return Promise.resolve(ids);
    return fetch(API + '/api/admin/track').then(function (r) { return r.ok ? r.json() : {}; }).then(function (d) { ids = d || {}; return ids; }, function () { ids = {}; return ids; });
  }
  function script(src) { var s = document.createElement('script'); s.async = true; s.src = src; document.head.appendChild(s); }
  /** the tags, once: Meta Pixel (PageView) and GA4 (page_view) */
  function load() {
    if (loaded) return Promise.resolve();
    loaded = true;
    return getIds().then(function (d) {
      if (d.pixelId) {
        /* Meta's base code */
        !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
        window.fbq('init', d.pixelId);
        window.fbq('track', 'PageView');
      }
      if (d.ga4Id) {
        script('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(d.ga4Id));
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
        window.gtag('js', new Date());
        window.gtag('config', d.ga4Id, onOrdyx ? { cookie_domain: 'ordyx.eu' } : {});
      }
      var q = queue; queue = []; q.forEach(function (f) { f(); });
    });
  }
  function whenLoaded(f) { if (!readConsent()) return; if (loaded && ids) f(); else { queue.push(f); load(); } }

  function banner() {
    if (readConsent() !== null || document.getElementById('ordyxCookies')) return;
    var css = '#ordyxCookies{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:560px;margin:0 auto;background:#0d0d0d;color:#f4f2ec;border-radius:16px;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.28);font:14px/1.5 Manrope,Inter,system-ui,sans-serif}' +
      '#ordyxCookies p{margin:0 0 12px}#ordyxCookies a{color:#ffd21f}#ordyxCookies .b{display:flex;gap:8px;flex-wrap:wrap}' +
      '#ordyxCookies button{font:inherit;font-weight:700;border-radius:10px;padding:9px 16px;cursor:pointer;border:1px solid #3a3a36;background:transparent;color:#f4f2ec}#ordyxCookies button.y{background:#ffd21f;border-color:#ffd21f;color:#0d0d0d}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var box = document.createElement('div'); box.id = 'ordyxCookies'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Бисквитки');
    box.innerHTML = '<p>Ползваме бисквитки на Meta и Google, за да мерим рекламите си и да покажем Ordyx на хора като теб. Без тях сайтът работи също толкова добре. <a href="/privacy">Повече</a></p>' +
      '<div class="b"><button type="button" class="y" data-c="1">Приемам</button><button type="button" data-c="0">Само необходимите</button></div>';
    box.addEventListener('click', function (e) {
      var c = e.target.getAttribute && e.target.getAttribute('data-c'); if (c == null) return;
      writeConsent(c === '1'); box.remove();
      if (c === '1') load();
    });
    document.body.appendChild(box);
  }

  window.ordyxTrack = {
    consent: readConsent,
    banner: banner,
    /** a click towards the registration */
    lead: function (plan) { whenLoaded(function () { if (window.fbq) window.fbq('track', 'Lead', plan ? { content_name: plan } : {}); if (window.gtag) window.gtag('event', 'generate_lead', plan ? { plan: plan } : {}); }); },
    /** after the registration: the browser half of CompleteRegistration (the server sent the other half with the same id) */
    registered: function (eventId) { whenLoaded(function () { if (window.fbq) window.fbq('track', 'CompleteRegistration', {}, eventId ? { eventID: eventId } : {}); }); },
  };
  if (readConsent()) load();
})();
