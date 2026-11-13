// migrate-to-flat-collections.js
// One-time migration. Move gallery images from existing subfolders into collections/.
// Original folder names, existing titles, and descriptions are saved in image-metadata.json.
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
const RESERVED = /^(homepage|icons|thumbs|imgstrip\d*)$/i;

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
function readObject(source, name) {
    const match = source.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;', 'm'));
    if (!match) return {};
    return vm.runInNewContext('(' + match[1] + ')');
}
function uniqueDestination(fileName) {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    let candidate = path.join(COLLECTIONS, fileName);
    let n = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(COLLECTIONS, stem + ' (' + n + ')' + ext);
        n++;
    }
    return candidate;
}
function collectNestedImages(dir, firstFolder, results) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectNestedImages(full, firstFolder, results);
        else if (entry.isFile() && IMAGE_EXT.test(entry.name)) results.push({
            source: full,
            oldWebPath: 'collections/' + path.relative(COLLECTIONS, full).split(path.sep).join('/'),
            originalFolder: path.relative(COLLECTIONS, path.dirname(full)).split(path.sep).join('/')
        });
    });
}

function main() {
    if (!fs.existsSync(COLLECTIONS) || !fs.statSync(COLLECTIONS).isDirectory()) throw new Error('collections folder not found: ' + COLLECTIONS);
    const registrySource = fs.existsSync(REGISTRY) ? fs.readFileSync(REGISTRY, 'utf8') : '';
    const oldTitles = readObject(registrySource, 'IMAGE_TITLES');
    const oldDescriptions = readObject(registrySource, 'IMAGE_DESCRIPTIONS');

    let store = { version: 1, images: {}, legacyUnmatched: { titles: {}, descriptions: {} } };
    if (fs.existsSync(METADATA_FILE)) {
        try { store = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')); }
        catch (error) { throw new Error('image-metadata.json is not valid JSON: ' + error.message); }
    }
    store.version = 1;
    store.images = store.images || {};
    store.legacyUnmatched = store.legacyUnmatched || { titles: {}, descriptions: {} };

    const nested = [];
    fs.readdirSync(COLLECTIONS, { withFileTypes: true }).forEach(entry => {
        if (entry.isDirectory() && !RESERVED.test(entry.name)) {
            collectNestedImages(path.join(COLLECTIONS, entry.name), entry.name, nested);
        }
    });

    const matchedTitles = new Set();
    const matchedDescriptions = new Set();
    let moved = 0;

    nested.forEach(item => {
        const sourceHash = sha256(item.source);
        const existing = store.images[sourceHash] || {};
        const oldTitle = oldTitles[item.oldWebPath];
        const oldDescription = oldDescriptions[item.oldWebPath];
        if (oldTitle) matchedTitles.add(item.oldWebPath);
        if (oldDescription !== undefined) matchedDescriptions.add(item.oldWebPath);

        const destination = uniqueDestination(path.basename(item.source));
        const sourceStat = fs.statSync(item.source);
        fs.copyFileSync(item.source, destination, fs.constants.COPYFILE_EXCL);
        fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
        if (sha256(destination) !== sourceHash) {
            fs.unlinkSync(destination);
            throw new Error('Copy verification failed; original was kept: ' + item.source);
        }

        store.images[sourceHash] = Object.assign({}, existing, {
            id: sourceHash,
            title: existing.title || oldTitle || path.basename(item.source, path.extname(item.source)),
            description: existing.description !== undefined ? existing.description : (oldDescription || ''),
            originalFolder: existing.originalFolder || item.originalFolder
        });
        fs.unlinkSync(item.source);
        moved++;
    });

    // Register images that were already directly in collections/ without changing their files.
    fs.readdirSync(COLLECTIONS, { withFileTypes: true }).forEach(entry => {
        if (!entry.isFile() || !IMAGE_EXT.test(entry.name)) return;
        const full = path.join(COLLECTIONS, entry.name);
        const id = sha256(full);
        if (!store.images[id]) store.images[id] = {
            id: id,
            title: oldTitles['collections/' + entry.name] || path.basename(entry.name, path.extname(entry.name)),
            description: oldDescriptions['collections/' + entry.name] || '',
            originalFolder: ''
        };
    });

    Object.keys(oldTitles).forEach(key => {
        if (!matchedTitles.has(key) && !nested.some(item => item.oldWebPath === key) && !fs.existsSync(path.join(ROOT, key.replace(/\//g, path.sep)))) {
            store.legacyUnmatched.titles[key] = oldTitles[key];
        }
    });
    Object.keys(oldDescriptions).forEach(key => {
        if (!matchedDescriptions.has(key) && !nested.some(item => item.oldWebPath === key) && !fs.existsSync(path.join(ROOT, key.replace(/\//g, path.sep)))) {
            store.legacyUnmatched.descriptions[key] = oldDescriptions[key];
        }
    });

    const tempMetadata = METADATA_FILE + '.tmp';
    fs.writeFileSync(tempMetadata, JSON.stringify(store, null, 4), 'utf8');
    fs.copyFileSync(tempMetadata, METADATA_FILE);
    fs.unlinkSync(tempMetadata);

    require('./generate-registry.js');
    console.log('Flat-folder migration complete. Images moved: ' + moved + '.');
    console.log('Original folder names and existing descriptions are in image-metadata.json.');
    console.log('Reserved folders such as Icons were left untouched.');
}

try { main(); }
catch (error) { console.error('\nFLAT-FOLDER MIGRATION FAILED\n' + error.message); process.exitCode = 1; }
