'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '_site');

function walk(dir){
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = dir + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Site assets must not be symlinks: ' + relative);
    return entry.isDirectory() ? walk(relative) : [relative];
  });
}

const files = ['index.html', ...walk('assets'), ...walk('js'), ...walk('vendor')].sort();
const assets = files.map(file => ({ path: file,
  integrity: 'sha256-' + crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('base64')
}));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)){
  if (!files.includes(match[1])) throw new Error('Missing or external entry asset: ' + match[1]);
}
const template = fs.readFileSync(path.join(__dirname, 'service-worker.template.js'), 'utf8');
const version = crypto.createHash('sha256').update(JSON.stringify(assets)).update(template).digest('hex').slice(0, 20);
const worker = template.replace('__CACHE_VERSION__', version)
  .replace('/* __ASSETS__ */ []', JSON.stringify(assets, null, 2));

fs.rmSync(output, { recursive: true, force: true });
for (const file of [...files, 'LICENSE', '.nojekyll']){
  const dest = path.join(output, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, file), dest);
}
fs.writeFileSync(path.join(output, 'sw.js'), worker);
console.log(`Built ${files.length} cached assets, version ${version}, into _site/`);
