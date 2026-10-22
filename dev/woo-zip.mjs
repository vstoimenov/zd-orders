// Builds the WooCommerce plugin zip and its update file: `node dev/woo-zip.mjs`
// → public/integrations/ordyx-woocommerce.zip (what the admin downloads) and public/integrations/woocommerce.json (what the
// plugin's self-update reads). Both are committed; the version comes from the plugin header.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = path.join(root, 'integrations', 'woocommerce');
const out = path.join(root, 'public', 'integrations');
const header = readFileSync(path.join(src, 'ordyx', 'ordyx.php'), 'utf8');
const version = (header.match(/^\s*\*\s*Version:\s*([\d.]+)/m) || [])[1];
if (!version) throw new Error('no Version in ordyx.php');

mkdirSync(out, { recursive: true });
const zip = path.join(out, 'ordyx-woocommerce.zip');
rmSync(zip, { force: true });
// the archive holds one top-level folder `ordyx/` — what WordPress expects on upload
execFileSync('zip', ['-r', '-X', '-q', zip, 'ordyx', '-x', '*.DS_Store', '-x', '__MACOSX/*'], { cwd: src, stdio: 'inherit' });

const base = process.env.PUBLIC_BASE_URL || 'https://app.ordyx.eu';
writeFileSync(path.join(out, 'woocommerce.json'), JSON.stringify({
  version, api: 1, tested: '7.1', requires: '6.4', requires_php: '7.4',
  download: `${base}/integrations/ordyx-woocommerce.zip`,
  changelog: `${version}: първа версия — избор на офис/автомат в чекаута, поръчките в Ordyx, товарителница и проследяване обратно в WooCommerce.`,
}, null, 2) + '\n');
console.log(`written ${path.relative(root, zip)} and woocommerce.json (version ${version})`);
