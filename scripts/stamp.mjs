// Cache-busting without a build step.
//
// GitHub Pages lets browsers cache files for 10 minutes, so after a deploy a
// visitor can keep running old JavaScript. This script gives every module a
// content-hash query string through an import map in index.html, and stamps the
// stylesheet and entry script the same way. Changed files get new URLs; unchanged
// ones stay cached.
//
// Run before committing:  node scripts/stamp.mjs
// CI fails if it was forgotten:  node scripts/stamp.mjs --check
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const hash = (file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex').slice(0, 10);

function walk(dir) {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = join(dir, name);
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : rel.endsWith('.js') || rel.endsWith('.mjs') ? [rel] : [];
  });
}

const modules = walk('js').sort();
const imports = Object.fromEntries(modules.map((m) => [`./${m}`, `./${m}?v=${hash(m)}`]));
const importMap = `<script type="importmap">\n${JSON.stringify({ imports }, null, 2)}\n</script>`;

const htmlPath = join(root, 'index.html');
const before = readFileSync(htmlPath, 'utf8');
let html = before;

const START = '<!-- stamp:importmap -->';
const END = '<!-- /stamp:importmap -->';
const block = `${START}\n${importMap}\n${END}`;
if (html.includes(START)) {
  html = html.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
} else {
  html = html.replace('<script type="module"', `${block}\n  <script type="module"`);
}
html = html
  .replace(/href="css\/app\.css(\?v=[^"]*)?"/, `href="css/app.css?v=${hash('css/app.css')}"`)
  .replace(/src="js\/main\.js(\?v=[^"]*)?"/, `src="js/main.js?v=${hash('js/main.js')}"`);

if (process.argv.includes('--check')) {
  if (html !== before) {
    console.error('index.html version stamps are out of date. Run: node scripts/stamp.mjs');
    process.exit(1);
  }
  console.log(`Stamps up to date (${modules.length} modules).`);
} else {
  writeFileSync(htmlPath, html);
  console.log(`Stamped ${modules.length} modules${html === before ? ' (no changes)' : ''}.`);
}
