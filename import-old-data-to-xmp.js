// import-old-data-to-xmp.js  (run ONCE, only if you want to keep your old data)
// Run from WEB.300:  node .\import-old-data-to-xmp.js
// Copies old titles, descriptions and colours (from image-metadata.json and the
// old registry.js) into XnView .xmp sidecars, so XnView becomes the only source.
// It NEVER changes a photo or an existing .xmp file. It only creates missing ones
// named  <photo>.jpg.xmp  (example: Walking_1.jpg.xmp). Exact colours are stored as a
// keyword like  link:#c07b21  so XnView keeps them.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = __dirname;
const DIR = path.join(ROOT, 'collections');
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
const xmp = require('./xmp-tools.js');

if (!fs.existsSync(DIR)) { console.error('ERROR: folder "collections" not found here.'); process.exit(1); }

const cleanHex = value => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';

let store = {};
try { store = JSON.parse(fs.readFileSync(path.join(ROOT, 'image-metadata.json'), 'utf8')).images || {}; } catch (e) {}
let oldTitles = {}, oldDescs = {};
try {
    const r = vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'registry.js'), 'utf8') +
        '\n;({t: IMAGE_TITLES || {}, d: IMAGE_DESCRIPTIONS || {}})', Object.create(null), { timeout: 1000 });
    for (const k of Object.keys(r.t)) oldTitles[k.split('/').pop().toLowerCase()] = r.t[k];
    for (const k of Object.keys(r.d)) oldDescs[k.split('/').pop().toLowerCase()] = r.d[k];
} catch (e) {}

const names = fs.readdirSync(DIR, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
const lower = new Set(names.map(n => n.toLowerCase()));
let made = 0, skipped = 0, empty = 0;
for (const file of names.filter(n => IMAGE_EXT.test(n))) {
    const base = file.replace(/\.[^.]+$/, '');
    if (lower.has((file + '.xmp').toLowerCase()) || lower.has((base + '.xmp').toLowerCase())) { skipped++; continue; }
    const id = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, file))).digest('hex');
    const saved = store[id] || {};
    let title = oldTitles[file.toLowerCase()] || '';
    if (!title && saved.title && saved.title !== base) title = saved.title;
    if (title.toLowerCase() === base.toLowerCase()) title = '';   // a title equal to the file name adds nothing
    const desc = oldDescs[file.toLowerCase()] || saved.description || '';
    const colour = cleanHex(saved.linkColor);
    if (!title && !desc && !colour) { empty++; continue; }
    const changes = {};
    if (title) changes.title = title;
    if (desc) changes.description = desc;
    if (colour) changes.linkColor = colour;   // exact colour, stored as a  link:#rrggbb  keyword
    xmp.writeChanges(DIR, file, changes);
    made++;
}
console.log('Created ' + made + ' .xmp files. Skipped ' + skipped + ' photos that already have one. ' + empty + ' had nothing to import.');
console.log('Now run: node .\\generateRegistry.js');
