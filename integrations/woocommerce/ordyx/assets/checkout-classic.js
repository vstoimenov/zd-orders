/* Ordyx for WooCommerce — the classic (shortcode) checkout: shows the Ordyx picker for the chosen shipping method and fills the hidden fields. */
(function ($) {
  if (!window.OrdyxWC || !$) return;
  var cfg = window.OrdyxWC, handle = null, lastType = '';
  function chosenType() {
    var checked = $('input[name^="shipping_method"]:checked');
    var id = checked.length ? checked.val() : $('input[name^="shipping_method"][type="hidden"]').val();
    return (id && cfg.rates[id]) || '';
  }
  function set(name, v) { var f = document.getElementById('ordyx_' + name); if (f) f.value = v || ''; }
  function apply() {
    var box = document.getElementById('ordyx-pick');
    if (!box) return;
    var type = chosenType();
    var office = cfg.officeTypes.indexOf(type) >= 0;
    box.hidden = !office;
    set('type', type);
    if (!office) { set('office_id', ''); set('office_text', ''); set('city', ''); set('post_code', ''); if (handle) handle.setType(''); lastType = type; return; }
    if (!window.OrdyxPicker) return;
    if (!handle) {
      handle = window.OrdyxPicker.mount(document.getElementById('ordyx-pick-widget'), {
        api: cfg.api, host: cfg.host, type: type,
        onChange: function (v) { set('office_id', v.officeId); set('office_text', v.officeText); set('city', v.city); set('post_code', v.postCode); }
      });
    } else if (type !== lastType) handle.setType(type);
    lastType = type;
  }
  $(document.body).on('updated_checkout', apply);
  $(document).on('change', 'input[name^="shipping_method"]', function () { setTimeout(apply, 50); });
  $(apply);
})(window.jQuery);
