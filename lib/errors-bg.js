// Integration errors as the shop owner sees them in the admin: what to fix, in Bulgarian, keeping the HTTP code for support.
export function humanize(err) {
  const m = err?.message || String(err);
  if (/^Nekorekten: HTTP (401|403)/.test(m)) return `Ключът за НЕкоректен е отхвърлен (${m}). Проверете го в nekorekten.com → API ключове.`;
  if (m === 'invalid domain') return 'Невалиден домейн — въведете само домейна на магазина, напр. adhdbg.eu';
  if (/HTTP (401|403)/.test(m)) return `Ключът е отхвърлен (${m}). Проверете API ключа и домейна.`;
  if (/HTTP 404/.test(m)) return `Домейнът не отговаря като ConvertBuilder магазин (${m}). Проверете домейна.`;
  if (/HTTP 429/.test(m)) return `Твърде много заявки (${m}). Опитайте след минута.`;
  if (/HTTP 5\d\d/.test(m)) return `Услугата временно не отговаря (${m}). Опитайте по-късно.`;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'Магазинът не отговори навреме. Опитайте отново.';
  if (/fetch failed|ENOTFOUND|EAI_AGAIN/.test(m)) return 'Домейнът не е достъпен. Проверете домейна.';
  if (m === 'ConvertBuilder is not connected') return 'ConvertBuilder не е свързан';
  if (m === 'INTEGRATIONS_SECRET is not set') return 'Сървърът не е настроен за пазене на ключове (липсва INTEGRATIONS_SECRET).';
  if (/unable to authenticate data|invalid sealed secret/.test(m)) return 'Запазеният ключ не може да се разчете — въведете ключа отново.';
  if (/[А-Яа-я]/.test(m)) return m; // already ours
  return `Неочаквана грешка: ${m}`;
}
