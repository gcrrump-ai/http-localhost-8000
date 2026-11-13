// generate-registry.js
// Run from any directory: paths resolve relative to this script.
// Gallery images are stored directly in collections/. Subfolders such as Icons are ignored.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = __dirname;
const COLLECTIONS = path.join(ROOT, 'collections');
const REGISTRY = path.join(ROOT, 'registry.js');
const METADATA_FILE = path.join(ROOT, 'image-metadata.json');
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)$/i;

function readObject(source, name) {
    const match = source.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;', 'm'));
    if (!match) return {};
    try { return vm.runInNewContext('(' + match[1] + ')'); }
    catch (error) { throw new Error('Cannot read ' + name + ' from registry.js: ' + error.message); }
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
    if (!fs.existsSync(COLLECTIONS) || !fs.statSync(COLLECTIONS).isDirectory()) {
        throw new Error('collections folder not found: ' + COLLECTIONS);
    }

    const existingSource = fs.existsSync(REGISTRY) ? fs.readFileSync(REGISTRY, 'utf8') : '';
    const oldTitles = readObject(existingSource, 'IMAGE_TITLES');
    const oldDescriptions = readObject(existingSource, 'IMAGE_DESCRIPTIONS');
    let store = { version: 1, images: {}, legacyUnmatched: { titles: {}, descriptions: {} } };
    if (fs.existsSync(METADATA_FILE)) {
        try { store = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')); }
        catch (error) { throw new Error('image-metadata.json is not valid JSON: ' + error.message); }
    }
    store.images = store.images || {};

    const files = fs.readdirSync(COLLECTIONS, { withFileTypes: true })
        .filter(entry => entry.isFile() && IMAGE_EXT.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const imagePaths = [];
    const titles = {};
    const descriptions = {};
    files.forEach(fileName => {
        const fullPath = path.join(COLLECTIONS, fileName);
        const webPath = 'collections/' + fileName;
        const id = sha256(fullPath);
        const record = store.images[id] || {};
        imagePaths.push(webPath);
        if (record.title || oldTitles[webPath]) titles[webPath] = record.title || oldTitles[webPath];
        else titles[webPath] = path.basename(fileName, path.extname(fileName));
        if (record.description || oldDescriptions[webPath]) descriptions[webPath] = record.description || oldDescriptions[webPath];
    });

    const output =
        '// Generated flat image registry. Image metadata is stored in image-metadata.json.\n' +
        'const MASTER_IMAGE_REGISTRY = ' + JSON.stringify(imagePaths, null, 4) + ';\n\n' +
        'const IMAGE_TITLES = ' + JSON.stringify(titles, null, 4) + ';\n\n' +
        'const IMAGE_DESCRIPTIONS = ' + JSON.stringify(descriptions, null, 4) + ';\n\n' +
        'function getImageTitle(path) {\n' +
        '    const key = String(path).replace(/\\\\/g, \'/\');\n' +
        '    return IMAGE_TITLES[key] || key.split(\'/\').pop().replace(/\\.[^/.]+$/, \'\');\n' +
        '}\n\n' +
        'function getImageDescription(path) {\n' +
        '    const key = String(path).replace(/\\\\/g, \'/\');\n' +
        '    return IMAGE_DESCRIPTIONS[key] || \'\';\n' +
        '}\n';

    new vm.Script(output, { filename: 'registry.js' });
    const temp = REGISTRY + '.tmp';
    fs.writeFileSync(temp, output, 'utf8');
    fs.copyFileSync(temp, REGISTRY);
    fs.unlinkSync(temp);
    console.log('registry.js updated: ' + imagePaths.length + ' images directly in collections/.');
}

try { main(); }
catch (error) { console.error('\nREGISTRY GENERATION FAILED\n' + error.message); process.exitCode = 1; }
