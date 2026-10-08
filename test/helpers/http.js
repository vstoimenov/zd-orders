const DEFAULT_SHOP = '00000000-0000-4000-8000-000000000001';

/** Requests name the default shop unless a test sets ?shop= itself (single-shop tests predate shops). */
export function fakeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const withShop = /[?&]shop=/.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}shop=${DEFAULT_SHOP}`;
  return { method, url: withShop, headers, body, socket: { remoteAddress: '127.0.0.1' } };
}

export function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b = '') { this.body = String(b); },
  };
}

export const json = (res) => JSON.parse(res.body);
