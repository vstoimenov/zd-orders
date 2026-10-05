import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { readRaw } from '../lib/http.js';

// what @vercel/node's addHelpers does before our handler runs: buffer the body, replay it via req.on('data'/'end'),
// and expose the parsed JSON as req.body (dist/dev-server.mjs: readBody → restoreBody, setLazyProp(req, 'body', …))
function vercelize(req, body) {
  const replay = new PassThrough();
  const on = replay.on.bind(replay), originalOn = req.on.bind(req);
  req.read = replay.read.bind(replay);
  req.on = req.addListener = (name, cb) => (name === 'data' || name === 'end' ? on(name, cb) : originalOn(name, cb));
  replay.write(body); replay.end();
  let parsed;
  Object.defineProperty(req, 'body', { get: () => (parsed ??= JSON.parse(body.toString('utf8'))) });
}

async function roundTrip(raw, { contentType = 'application/json', vercel = true } = {}) {
  let got;
  const srv = http.createServer(async (req, res) => {
    if (vercel && contentType) {
      const chunks = []; for await (const c of req) chunks.push(c);
      vercelize(req, Buffer.concat(chunks));
    }
    got = await readRaw(req);
    res.end();
  });
  await new Promise((r) => srv.listen(0, r));
  await new Promise((resolve, reject) => {
    const r = http.request({ port: srv.address().port, method: 'POST', headers: contentType ? { 'content-type': contentType } : {} }, (res) => { res.resume(); res.on('end', resolve); });
    r.on('error', reject); r.end(raw);
  });
  srv.close();
  return got;
}

const raw = '{"id":82,"customerName":"\\u041c\\u0430\\u0440\\u0438\\u044f","total":16.40,"url":"https:\\/\\/x.bg\\/"}';

test('readRaw returns the exact signed bytes when Vercel already parsed a JSON body', async () => {
  assert.equal(await roundTrip(raw), raw);
});

test('readRaw reads the untouched stream when there is no content type', async () => {
  assert.equal(await roundTrip(raw, { contentType: null }), raw);
});

test('readRaw takes a string body as is (tests)', async () => {
  assert.equal(await readRaw({ body: raw }), raw);
  assert.equal(await readRaw({ body: { id: 1 } }), null, 'never re-serializes a parsed body');
});
