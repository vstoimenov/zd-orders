/* Europe: the countries and local couriers Ordyx is coming to, with cash on delivery (no dependencies; window.ORDYX_EU).
   One list for the landing (ordyx.eu) and Интеграции → Куриери. A courier in a country's `live` works today; every other one is
   „скоро“ until its integration ships — then it moves into `live` and both pages show it as working.
   `domain` is where the logo comes from (Google's favicon service); empty where it only has a blank globe — the letters show instead. */
(function () {
  var couriers = {
    econt: { name: 'Еконт', short: 'E', domain: 'econt.com', color: '#1d4f91', about: 'Офиси, автомати и до адрес' },
    speedy: { name: 'Спиди', short: 'S', domain: 'speedy.bg', color: '#d4141c', about: 'Офиси, автомати и до адрес' },
    boxnow: { name: 'BOX NOW', short: 'BN', domain: 'boxnow.bg', color: '#44c2a0', about: 'Автомати за пратки' },
    sameday: { name: 'Sameday', short: 'SD', domain: 'sameday.ro', color: '#003c7e', about: 'Куриер и easybox автомати' },
    pigeon: { name: 'Pigeon Express', short: 'PE', domain: 'pigeonexpress.com', color: '#e4572e', about: 'Куриерски услуги' },
    fan: { name: 'Fan Courier', short: 'FC', domain: 'fancourier.ro', color: '#0058a3', about: 'Куриер и FANbox автомати' },
    cargus: { name: 'Cargus', short: 'CG', domain: 'cargus.ro', color: '#f15a22', about: 'Куриер и пунктове Ship & Go' },
    packeta: { name: 'Packeta', short: 'PK', domain: 'packeta.com', color: '#ba1b02', about: 'Пунктове и Z-BOX автомати' },
    gls: { name: 'GLS', short: 'GLS', domain: 'gls-pakete.de', color: '#061ab1', about: 'Пунктове, автомати и до адрес' },
    acs: { name: 'ACS', short: 'ACS', domain: 'acscourier.net', color: '#c8102e', about: 'Офиси, автомати и до адрес' },
    elta: { name: 'ELTA Courier', short: 'EL', domain: 'elta-courier.gr', color: '#004b93', about: 'Куриерът на гръцките пощи' },
    geniki: { name: 'Geniki Taxydromiki', short: 'GT', domain: 'taxydromiki.com', color: '#d71920', about: 'Офиси в цяла Гърция' },
    expressone: { name: 'Express One', short: 'E1', domain: 'expressone.hu', color: '#e30613', about: 'Куриер до адрес' },
    dexpress: { name: 'D Express', short: 'DX', domain: 'dexpress.rs', color: '#e30613', about: 'Куриер до адрес и пунктове' },
    bex: { name: 'BEX', short: 'BX', domain: '', color: '#ed1c24', about: 'Куриер до адрес' },
    cityexpress: { name: 'City Express', short: 'CE', domain: 'cityexpress.rs', color: '#00539f', about: 'Куриер до адрес' },
    inpost: { name: 'InPost', short: 'IP', domain: 'inpost.pl', color: '#b38f00', about: 'Пачкомати и пунктове' },
    ppl: { name: 'PPL', short: 'PPL', domain: 'ppl.cz', color: '#004b93', about: 'Куриер и пунктове' },
    sps: { name: 'Slovak Parcel Service', short: 'SPS', domain: '', color: '#e30613', about: 'Куриер и пунктове' },
    hermes: { name: 'Hermes', short: 'HE', domain: 'myhermes.de', color: '#0091cd', about: 'Пунктове и до адрес' },
    ctt: { name: 'CTT', short: 'CTT', domain: 'ctt.pt', color: '#df0024', about: 'Пощи и куриер' },
    dhl: { name: 'DHL', short: 'DHL', domain: 'dhl.de', color: '#d40511', about: 'Международни пратки', intl: true },
    fedex: { name: 'FedEx', short: 'FX', domain: 'fedex.com', color: '#4d148c', about: 'Международни пратки', intl: true }
  };
  var countries = [
    { code: 'BG', name: 'България', flag: '🇧🇬', currency: 'EUR', couriers: ['econt', 'speedy', 'boxnow', 'sameday', 'pigeon', 'dhl', 'fedex'], live: ['econt', 'speedy', 'boxnow'] },
    { code: 'RO', name: 'Румъния', flag: '🇷🇴', currency: 'RON', couriers: ['fan', 'cargus', 'sameday', 'packeta', 'gls', 'dhl', 'fedex'] },
    { code: 'GR', name: 'Гърция', flag: '🇬🇷', currency: 'EUR', couriers: ['acs', 'elta', 'geniki', 'boxnow', 'dhl', 'fedex'] },
    { code: 'RS', name: 'Сърбия', flag: '🇷🇸', currency: 'RSD', couriers: ['dexpress', 'bex', 'cityexpress', 'gls', 'dhl', 'fedex'] },
    { code: 'MK', name: 'Северна Македония', flag: '🇲🇰', currency: 'MKD', couriers: ['dhl', 'fedex'] },
    { code: 'BA', name: 'Босна и Херцеговина', flag: '🇧🇦', currency: 'BAM', couriers: ['dhl', 'fedex'] },
    { code: 'ME', name: 'Черна гора', flag: '🇲🇪', currency: 'EUR', couriers: ['dhl', 'fedex'] },
    { code: 'HR', name: 'Хърватия', flag: '🇭🇷', currency: 'EUR', couriers: ['gls', 'boxnow', 'dhl', 'fedex'] },
    { code: 'SI', name: 'Словения', flag: '🇸🇮', currency: 'EUR', couriers: ['gls', 'dhl', 'fedex'] },
    { code: 'HU', name: 'Унгария', flag: '🇭🇺', currency: 'HUF', couriers: ['expressone', 'gls', 'packeta', 'sameday', 'dhl', 'fedex'] },
    { code: 'PL', name: 'Полша', flag: '🇵🇱', currency: 'PLN', couriers: ['inpost', 'gls', 'packeta', 'dhl', 'fedex'] },
    { code: 'CZ', name: 'Чехия', flag: '🇨🇿', currency: 'CZK', couriers: ['ppl', 'packeta', 'gls', 'dhl', 'fedex'] },
    { code: 'SK', name: 'Словакия', flag: '🇸🇰', currency: 'EUR', couriers: ['sps', 'packeta', 'gls', 'dhl', 'fedex'] },
    { code: 'AT', name: 'Австрия', flag: '🇦🇹', currency: 'EUR', couriers: ['gls', 'dhl', 'fedex'] },
    { code: 'DE', name: 'Германия', flag: '🇩🇪', currency: 'EUR', couriers: ['dhl', 'hermes', 'gls', 'fedex'] },
    { code: 'LT', name: 'Литва', flag: '🇱🇹', currency: 'EUR', couriers: ['dhl', 'fedex'] },
    { code: 'LV', name: 'Латвия', flag: '🇱🇻', currency: 'EUR', couriers: ['dhl', 'fedex'] },
    { code: 'EE', name: 'Естония', flag: '🇪🇪', currency: 'EUR', couriers: ['dhl', 'fedex'] },
    { code: 'IT', name: 'Италия', flag: '🇮🇹', currency: 'EUR', couriers: ['gls', 'inpost', 'dhl', 'fedex'] },
    { code: 'ES', name: 'Испания', flag: '🇪🇸', currency: 'EUR', couriers: ['ctt', 'gls', 'inpost', 'dhl', 'fedex'] },
    { code: 'PT', name: 'Португалия', flag: '🇵🇹', currency: 'EUR', couriers: ['ctt', 'gls', 'dhl', 'fedex'] },
    { code: 'IE', name: 'Ирландия', flag: '🇮🇪', currency: 'EUR', couriers: ['gls', 'dhl', 'fedex'] },
    { code: 'CY', name: 'Кипър', flag: '🇨🇾', currency: 'EUR', couriers: ['acs', 'boxnow', 'dhl', 'fedex'] },
    { code: 'MT', name: 'Малта', flag: '🇲🇹', currency: 'EUR', couriers: ['dhl', 'fedex'] }
  ];
  // what the customer pays the courier in, by country
  var currencies = { EUR: 'евро', RON: 'румънски леи', RSD: 'сръбски динари', MKD: 'македонски денари', BAM: 'конвертируеми марки', HUF: 'унгарски форинти', PLN: 'полски злоти', CZK: 'чешки крони' };
  var regions = [
    { name: 'Балкани', countries: ['BG', 'RO', 'GR', 'RS', 'MK', 'BA', 'ME', 'HR', 'SI'] },
    { name: 'Централна Европа', countries: ['HU', 'PL', 'CZ', 'SK', 'AT', 'DE'] },
    { name: 'Балтика', countries: ['LT', 'LV', 'EE'] },
    { name: 'Юг и запад', countries: ['IT', 'ES', 'PT', 'IE', 'CY', 'MT'] }
  ];
  function country(code) {
    for (var i = 0; i < countries.length; i++) if (countries[i].code === code) return countries[i];
    return null;
  }
  function withId(id) { var k = couriers[id], o = { id: id }; for (var f in k) o[f] = k[f]; return o; }
  // the couriers still to come in a country, in the order they are listed
  function soon(code) {
    var c = country(code);
    if (!c) return [];
    return c.couriers.filter(function (id) { return (c.live || []).indexOf(id) < 0; }).map(withId);
  }
  function live(code) { var c = country(code); return c ? (c.live || []).map(withId) : []; }
  window.ORDYX_EU = { couriers: couriers, countries: countries, currencies: currencies, regions: regions, country: country, soon: soon, live: live };
})();
