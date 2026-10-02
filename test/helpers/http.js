export function fakeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  return { method, url, headers, body, socket: { remoteAddress: '127.0.0.1' } };
}

export function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b = '') { this.body = String(b); },
  };
}

export const json = (res) => JSON.parse(res.body);
