/* Ordyx for WooCommerce — the block checkout: the picker under the shipping options, the choice as Store API extension data. */
(function () {
  if (!window.OrdyxWC || !window.wp || !window.wc || !wc.blocksCheckout || !wp.plugins || !wp.element || !wp.data) return;
  var cfg = window.OrdyxWC;
  var el = wp.element.createElement, useEffect = wp.element.useEffect, useRef = wp.element.useRef;
  var useSelect = wp.data.useSelect, useDispatch = wp.data.useDispatch;
  var Slot = wc.blocksCheckout.ExperimentalOrderShippingPackages;

  function Picker() {
    var rates = useSelect(function (select) { return select('wc/store/cart').getShippingRates(); }, []);
    var selected = '';
    (rates || []).forEach(function (pkg) { (pkg.shipping_rates || []).forEach(function (r) { if (r.selected) selected = r.rate_id; }); });
    var type = cfg.rates[selected] || '';
    var office = cfg.officeTypes.indexOf(type) >= 0;
    var box = useRef(null), handle = useRef(null);
    var checkout = useDispatch('wc/store/checkout');
    function push(v) {
      var data = { type: type, office_id: v ? v.officeId : '', office_text: v ? v.officeText : '', city: v ? v.city : '', post_code: v ? v.postCode : '' };
      if (checkout.setExtensionData) checkout.setExtensionData('ordyx', data);
      else if (checkout.__internalSetExtensionData) checkout.__internalSetExtensionData('ordyx', data);
    }
    // mount/setType both call onChange with what is chosen now (kept across re-renders), so a failed submit keeps the office
    useEffect(function () {
      if (!office) { if (handle.current) handle.current.setType(''); push(null); return; }
      if (!window.OrdyxPicker || !box.current) return;
      if (!handle.current) {
        handle.current = window.OrdyxPicker.mount(box.current, { api: cfg.api, host: cfg.host, type: type, onChange: push });
      } else handle.current.setType(type);
    }, [type]);
    useEffect(function () { return function () { if (handle.current) { handle.current.destroy(); handle.current = null; } }; }, []);
    return el('div', { className: 'ordyx-block', style: { display: office ? 'block' : 'none', marginTop: '12px' } },
      el('h3', { className: 'wc-block-components-title' }, cfg.heading),
      el('div', { ref: box }));
  }

  wp.plugins.registerPlugin('ordyx-picker', {
    render: function () { return el(Slot, null, el(Picker)); },
    scope: 'woocommerce-checkout'
  });
})();
