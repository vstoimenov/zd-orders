/* Break-even ROAS calculator (no dependencies; window.zdRoas). All money per order, in the shop's currency. */
(function () {
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  /**
   * aov — average order value (what Meta counts as purchase value) · productCost — cost of goods per order
   * shipping — delivery you pay + packaging per order · codPct — cash-on-delivery fee % · returnPct — share of orders returned
   * returnCost — cost of one returned parcel · targetMarginPct — profit you want to keep, % of the order value
   */
  function breakEven(i) {
    var aov = num(i.aov), returned = Math.min(Math.max(num(i.returnPct), 0), 95) / 100, kept = 1 - returned;
    // a returned order brings no money and costs the return; its goods come back
    var profit = aov * kept - num(i.productCost) * kept - num(i.shipping) - aov * kept * num(i.codPct) / 100 - returned * num(i.returnCost);
    var target = profit - aov * num(i.targetMarginPct) / 100;
    return {
      profit: profit,
      margin: aov ? profit / aov : null,
      beRoas: profit > 0 ? aov / profit : null, // above this ROAS the ads pay for themselves
      beCpa: profit,                             // the most one order may cost in ads
      targetCpa: target,
      targetRoas: target > 0 ? aov / target : null,
    };
  }
  window.zdRoas = { breakEven: breakEven };
})();
