const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const portable = path.join(ROOT, 'totw.html');
const websiteHtml = path.join(ROOT, 'website', 'index.html');
const websiteJs = path.join(ROOT, 'website', 'assets', 'totw.js');
const websiteCss = path.join(ROOT, 'website', 'assets', 'totw.css');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const html = fs.readFileSync(portable, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i);
assert(scriptMatch, 'portable totw.html is missing inline <script>');
new vm.Script(scriptMatch[1], { filename: 'totw-inline.js' });

assert(fs.existsSync(websiteHtml), 'website/index.html is missing');
assert(fs.existsSync(websiteJs), 'website/assets/totw.js is missing');
assert(fs.existsSync(websiteCss), 'website/assets/totw.css is missing');
new vm.Script(fs.readFileSync(websiteJs, 'utf8'), { filename: 'website/assets/totw.js' });

const splitHtml = fs.readFileSync(websiteHtml, 'utf8');
assert(splitHtml.includes('assets/totw.css'), 'website HTML does not reference assets/totw.css');
assert(splitHtml.includes('assets/totw.js'), 'website HTML does not reference assets/totw.js');

console.log('TOTW smoke test passed');
