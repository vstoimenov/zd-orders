/** Replaces one courier's offices. An empty list (e.g. a failed fetch) never wipes the cache. */
export async function replaceOffices(q, courier, offices, { minRatio = 0 } = {}) {
  if (!offices.length) return { upserted: 0, removed: 0 };
  if (minRatio) {
    // a parse that suddenly finds far fewer offices (third-party page changed) must not delete the rest
    const [{ n }] = await q(`select count(*)::int as n from zd.offices where courier = $1`, [courier]);
    if (offices.length < n * minRatio) return { upserted: 0, removed: 0, skipped: true, current: n, parsed: offices.length };
  }
  const rows = offices.map((o) => ({
    id: o.id, courier, code: o.code, name: o.name, city: o.city, city_id: o.cityId ?? null,
    post_code: o.postCode, address: o.address, is_automat: o.isAutomat,
    lat: Number.isFinite(o.lat) ? o.lat : null, lng: Number.isFinite(o.lng) ? o.lng : null, hours: String(o.hours || ''),
  }));
  await q(
    `insert into zd.offices (id, courier, code, name, city, city_id, post_code, address, is_automat, lat, lng, hours, updated_at)
     select id, courier, code, name, city, city_id, post_code, address, is_automat, lat, lng, hours, now()
     from jsonb_to_recordset($1::text::jsonb)
       as r(id text, courier text, code text, name text, city text, city_id int, post_code text, address text, is_automat boolean, lat double precision, lng double precision, hours text)
     on conflict (id) do update set code = excluded.code, name = excluded.name, city = excluded.city,
       city_id = excluded.city_id, post_code = excluded.post_code, address = excluded.address,
       is_automat = excluded.is_automat, lat = excluded.lat, lng = excluded.lng, hours = excluded.hours, updated_at = now()`,
    [JSON.stringify(rows)],
  );
  const removed = await q(
    `delete from zd.offices where courier = $1
       and id not in (select jsonb_array_elements_text($2::text::jsonb)) returning id`,
    [courier, JSON.stringify(rows.map((r) => r.id))],
  );
  return { upserted: rows.length, removed: removed.length };
}

export async function replaceCities(q, cities) {
  if (!cities.length) return { upserted: 0, removed: 0 };
  const rows = cities.map((c) => ({ id: c.id, name: c.name, post_code: c.postCode, region: c.region, has_office: c.hasOffice }));
  await q(
    `insert into zd.cities (id, name, post_code, region, has_office, updated_at)
     select id, name, post_code, region, has_office, now()
     from jsonb_to_recordset($1::text::jsonb) as r(id int, name text, post_code text, region text, has_office boolean)
     on conflict (id) do update set name = excluded.name, post_code = excluded.post_code,
       region = excluded.region, has_office = excluded.has_office, updated_at = now()`,
    [JSON.stringify(rows)],
  );
  const removed = await q(
    `delete from zd.cities where id not in (select (jsonb_array_elements_text($1::text::jsonb))::int) returning id`,
    [JSON.stringify(rows.map((r) => r.id))],
  );
  return { upserted: rows.length, removed: removed.length };
}

export async function listOffices(q, courier) {
  const rows = await q(
    `select id, code, name, city, post_code, address, is_automat, lat, lng, hours from zd.offices
     where courier = $1 order by city, name`,
    [courier],
  );
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, city: r.city, postCode: r.post_code, address: r.address, isAutomat: r.is_automat,
    lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng), hours: r.hours || '',
  }));
}

export async function listCities(q) {
  const rows = await q(`select id, name, post_code, region, has_office from zd.cities order by has_office desc, name`);
  return rows.map((r) => ({ id: r.id, name: r.name, postCode: r.post_code, region: r.region, hasOffice: r.has_office }));
}
