const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORTABLE = path.join(ROOT, 'totw.html');
const WEBSITE_DIR = path.join(ROOT, 'website');
const ASSET_DIR = path.join(WEBSITE_DIR, 'assets');
const WEBSITE_HTML = path.join(WEBSITE_DIR, 'index.html');
const WEBSITE_CSS = path.join(ASSET_DIR, 'totw.css');
const WEBSITE_JS = path.join(ASSET_DIR, 'totw.js');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function extractSingleTag(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(re);
  if (!match) throw new Error(`Could not find <${tag}> block in ${PORTABLE}`);
  return match[1].trim() + '\n';
}

function splitPortable() {
  const html = read(PORTABLE);
  const css = extractSingleTag(html, 'style');
  const js = extractSingleTag(html, 'script');

  const websiteHtml = html
    .replace(/<style>[\s\S]*?<\/style>/i, '<link rel="stylesheet" href="assets/totw.css">')
    .replace(/<script>[\s\S]*?<\/script>/i, '<script src="assets/totw.js"></script>');

  write(WEBSITE_CSS, css);
  write(WEBSITE_JS, js);
  write(WEBSITE_HTML, websiteHtml);
  console.log('Wrote website variant to website/');
}

function bundleWebsite() {
  const html = read(WEBSITE_HTML);
  const css = read(WEBSITE_CSS).trim();
  const js = read(WEBSITE_JS).trim();

  const portableHtml = html
    .replace(/<link\s+rel=["']stylesheet["']\s+href=["']assets\/totw\.css["']\s*\/?>/i, `<style>\n${css}\n</style>`)
    .replace(/<script\s+src=["']assets\/totw\.js["']><\/script>/i, `<script>\n${js}\n</script>`);

  write(PORTABLE, portableHtml);
  console.log('Wrote portable variant to totw.html');
}

const cmd = process.argv[2] || 'split';
if (cmd === 'split') splitPortable();
else if (cmd === 'bundle') bundleWebsite();
else {
  console.error('Usage: node scripts/build-variants.js [split|bundle]');
  process.exit(1);
}
