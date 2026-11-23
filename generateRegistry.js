// generateRegistry.js
// Run from WEB.300: node .\generateRegistry.js
// Scans photographs directly inside the collections folder and publishes their
// link colours, embedded EXIF capture/scan dates, and XnView tags into registry.js.
//
// XnView tags (colour label, stars, title, description, groups) are read from the
// .xmp sidecar file beside each photo. When a photo has an XnView value, it is used.
// XnView is the ONLY source of colour, title, description, rating and groups.
// image-metadata.json and old titles in registry.js are no longer read.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xmpTools = require('./xmp-tools.js');

const ROOT = __dirname;
// The photo folder is called "collections" (all lowercase). The live site is
// case-sensitive, so the real folder name on disk must match exactly.
const COLLECTIONS_NAME = 'collections';
(function () {
    const found = fs.readdirSync(ROOT, { withFileTypes: true })
        .find(entry => entry.isDirectory() && entry.name.toLowerCase() === 'collections');
    if (found && found.name !== COLLECTIONS_NAME) {
        console.error('\nERROR: the folder is named "' + found.name + '" but must be named "collections" (all lowercase). Nothing was changed.');
        process.exit(1);
    }
})();
const COLLECTIONS = path.join(ROOT, COLLECTIONS_NAME);
const REGISTRY = path.join(ROOT, 'registry.js');
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)$/i;

function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function hashBuffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---- XnView .xmp sidecar reading (shared code in xmp-tools.js) --------------
// Returns { name, data } for the sidecar beside this photo, or null.
// Colour names you picked in the window are listed in palette.json.
const PALETTE = xmpTools.paletteMap(xmpTools.loadPalette(ROOT));
const unknownColourNames = new Map();

function readSidecarFor(fileName, folderNames) {
    const sidecar = xmpTools.readSidecar(COLLECTIONS, fileName, folderNames, PALETTE);
    return sidecar ? { name: sidecar.name, data: sidecar.data } : null;
}

// Read only the ASCII EXIF date tags needed for capture/scan-date sorting.
function parseExifTiffDate(tiff) {
    try {
        if (!Buffer.isBuffer(tiff) || tiff.length < 8) return '';
        const order = tiff.toString('ascii', 0, 2);
        const little = order === 'II';
        if (!little && order !== 'MM') return '';

        const u16 = offset => little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
        const u32 = offset => little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
        if (u16(2) !== 42) return '';

        function readIfd(offset) {
            const tags = {};
            if (!Number.isInteger(offset) || offset < 0 || offset + 2 > tiff.length) return tags;
            const count = u16(offset);
            for (let i = 0; i < count; i++) {
                const entry = offset + 2 + i * 12;
                if (entry + 12 > tiff.length) break;
                const tag = u16(entry);
                const type = u16(entry + 2);
                const itemCount = u32(entry + 4);
                if (tag === 0x8769 && type === 4 && itemCount === 1) {
                    tags[tag] = little ? tiff.readUInt32LE(entry + 8) : tiff.readUInt32BE(entry + 8);
                    continue;
                }
                if (type !== 2 || itemCount < 1 || itemCount > 128) continue;
                const byteLength = itemCount;
                const valueOffset = byteLength <= 4
                    ? entry + 8
                    : (little ? tiff.readUInt32LE(entry + 8) : tiff.readUInt32BE(entry + 8));
                if (valueOffset < 0 || valueOffset + byteLength > tiff.length) continue;
                tags[tag] = tiff.toString('ascii', valueOffset, valueOffset + byteLength).replace(/\0+$/, '').trim();
            }
            return tags;
        }

        const ifd0 = readIfd(u32(4));
        let date = '';
        const exifOffset = ifd0[0x8769];
        if (exifOffset) {
            const exif = readIfd(exifOffset);
            date = exif[0x9003] || exif[0x9004] || '';
        }
        return date || ifd0[0x0132] || '';
    } catch (_) {
        return '';
    }
}

function readExifDate(buffer, extension) {
    const ext = extension.toLowerCase();
    try {
        if (ext === '.jpg' || ext === '.jpeg') {
            let offset = 2;
            while (offset + 4 < buffer.length) {
                if (buffer[offset] !== 0xFF) { offset++; continue; }
                while (buffer[offset] === 0xFF) offset++;
                const marker = buffer[offset++];
                if (marker === 0xD9 || marker === 0xDA) break;
                if (offset + 2 > buffer.length) break;
                const length = buffer.readUInt16BE(offset);
                if (length < 2 || offset + length > buffer.length) break;
                const dataStart = offset + 2;
                const dataEnd = offset + length;
                if (marker === 0xE1 && buffer.toString('ascii', dataStart, dataStart + 6) === 'Exif\0\0') {
                    const date = parseExifTiffDate(buffer.slice(dataStart + 6, dataEnd));
                    if (date) return date;
                }
                offset += length;
            }
        } else if (ext === '.png') {
            let offset = 8;
            while (offset + 12 <= buffer.length) {
                const length = buffer.readUInt32BE(offset);
                const type = buffer.toString('ascii', offset + 4, offset + 8);
                const dataStart = offset + 8;
                const dataEnd = dataStart + length;
                if (length < 0 || dataEnd + 4 > buffer.length) break;
                if (type === 'eXIf') {
                    const date = parseExifTiffDate(buffer.slice(dataStart, dataEnd));
                    if (date) return date;
                }
                offset = dataEnd + 4;
                if (type === 'IEND') break;
            }
        } else if (ext === '.webp' && buffer.length >= 12 && buffer.toString('ascii', 8, 12) === 'WEBP') {
            let offset = 12;
            while (offset + 8 <= buffer.length) {
                const type = buffer.toString('ascii', offset, offset + 4);
                const length = buffer.readUInt32LE(offset + 4);
                const dataStart = offset + 8;
                const dataEnd = dataStart + length;
                if (length < 0 || dataEnd > buffer.length) break;
                if (type === 'EXIF') {
                    let tiff = buffer.slice(dataStart, dataEnd);
                    if (tiff.toString('ascii', 0, 6) === 'Exif\0\0') tiff = tiff.slice(6);
                    const date = parseExifTiffDate(tiff);
                    if (date) return date;
                }
                offset = dataEnd + (length & 1);
            }
        }
    } catch (_) {
        // Unsupported or malformed image metadata: the image stays in the registry.
    }
    return '';
}

if (!fs.existsSync(COLLECTIONS) || !fs.statSync(COLLECTIONS).isDirectory()) {
    throw new Error('collections folder not found: ' + COLLECTIONS + '. Nothing was changed.');
}

const files = fs.readdirSync(COLLECTIONS, { withFileTypes: true })
    .filter(entry => entry.isFile() && IMAGE_EXT.test(entry.name))
    .map(entry => entry.name)
    .sort(naturalCompare);

if (files.length === 0) {
    throw new Error('No photographs found directly inside collections/. registry.js was not overwritten.');
}

// Every file name in the folder (lower case -> real name), used to find .xmp sidecars.
const folderNames = new Map(
    fs.readdirSync(COLLECTIONS, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => [entry.name.toLowerCase(), entry.name])
);
const usedSidecars = new Set();
// Safety: a first run with no XnView files would erase the old titles stored in registry.js.
(function guardOldData() {
    const hasSidecars = Array.from(folderNames.values()).some(n => /\.xmp$/i.test(n));
    if (hasSidecars || process.argv.includes('--force') || !fs.existsSync(REGISTRY)) return;
    const old = fs.readFileSync(REGISTRY, 'utf8');
    if (/IMAGE_(TITLES|DESCRIPTIONS)\s*=\s*\{\s*"/.test(old)) {
        console.error('\nSTOPPED: registry.js still holds old titles/descriptions and there are no XnView .xmp files yet.');
        console.error('Run  node .\\import-old-data-to-xmp.js  first to keep them,');
        console.error('or run  node .\\generateRegistry.js --force  to start empty. Nothing was changed.');
        process.exit(1);
    }
})();
const xmpCounts = { sidecars: 0, colours: 0, ratings: 0, groups: 0, titles: 0, descriptions: 0 };

// Return-home pictures: every picture in assets/home, in name order (numbers count as numbers,
// so return-icon2.png comes before return-icon10.png). Any name works. Every picture type a
// web browser can display is used as it is (animated ones animate).
// A Windows animated cursor (.ani) cannot be shown by a browser, so a PNG copy is made in
// assets/home-converted. The original .ani is only read, never changed.
const HOME_ICON_TYPES = 'png|apng|jpe?g|jpe|jfif|pjpeg|pjp|gif|webp|avif|svg|ico|cur|bmp';
function findHomeIcons() {
    const dir = path.join(ROOT, 'assets', 'home');
    const outDir = path.join(ROOT, 'assets', 'home-converted');
    const wantedCopies = new Set();
    const found = [];
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const pattern = new RegExp('\\.(' + HOME_ICON_TYPES + ')$', 'i');
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile() || /^\./.test(entry.name) || /\.db$/i.test(entry.name)) continue;
            if (pattern.test(entry.name)) {
                found.push({ sort: entry.name, url: 'assets/home/' + entry.name });
            } else if (/\.ani$/i.test(entry.name)) {
                const copyName = entry.name + '.png';
                const source = path.join(dir, entry.name);
                const copy = path.join(outDir, copyName);
                try {
                    const stale = !fs.existsSync(copy) || fs.statSync(copy).mtimeMs < fs.statSync(source).mtimeMs || fs.statSync(copy).size === 0;
                    if (stale) {
                        const result = require('./ani-convert.js').convertAni(fs.readFileSync(source));
                        fs.mkdirSync(outDir, { recursive: true });
                        const temp = copy + '.tmp';
                        fs.writeFileSync(temp, result.png);
                        fs.renameSync(temp, copy);
                        console.log('Converted ' + entry.name + ' (' + result.frames + ' frames, ' + result.w + 'x' + result.h + ') -> assets/home-converted/' + copyName + '. The original was not changed.');
                    }
                    wantedCopies.add(copyName);
                    found.push({ sort: entry.name, url: 'assets/home-converted/' + copyName });
                } catch (error) {
                    console.warn('NOT USED: ' + entry.name + ' - could not convert it (' + error.message + ').');
                }
            } else {
                console.warn('NOT USED: ' + entry.name + ' - web browsers cannot display this file type. Convert it to .png, .gif (animated) or .webp and keep the name.');
            }
        }
    }
    // Remove only OUR old converted copies whose .ani is gone. Never touches assets/home.
    if (fs.existsSync(outDir)) {
        for (const name of fs.readdirSync(outDir)) {
            if (/\.ani\.png(\.tmp)?$/i.test(name) && !wantedCopies.has(name)) {
                try { fs.unlinkSync(path.join(outDir, name)); } catch (_) {}
            }
        }
    }
    found.sort((a, b) => naturalCompare(a.sort, b.sort));
    return found.map(item => item.url);
}
const homeIcons = findHomeIcons();

const imagePaths = [];
const imageFileMetadata = {};
const titles = {};
const descriptions = {};
const iconPaths = {
    magnifier: 'assets/magnifier-icon.png',
    dark: 'assets/dark-icon.png',
    light: 'assets/light-icon.png',
    returnHome: 'assets/return-icon.png',
    magnifierCorner: 'assets/magnifier-corner-icon.png',
    magnifierDetail: 'assets/red-dot.png'
};

for (const fileName of files) {
    const imagePath = COLLECTIONS_NAME + '/' + fileName;
    const fullPath = path.join(COLLECTIONS, fileName);
    const buffer = fs.readFileSync(fullPath);
    const id = hashBuffer(buffer);
    const dateTaken = readExifDate(buffer, path.extname(fileName));

    // XnView (.xmp) is the only source of colour, title and description.
    const sidecar = readSidecarFor(fileName, folderNames);
    const xmp = sidecar ? sidecar.data : null;
    if (sidecar) {
        usedSidecars.add(sidecar.name.toLowerCase());
        xmpCounts.sidecars++;
    }
    const linkColor = (xmp && xmp.linkColor) || '';
    if (xmp && xmp.unknownName) {
        unknownColourNames.set(xmp.unknownName, (unknownColourNames.get(xmp.unknownName) || 0) + 1);
    }

    imagePaths.push(imagePath);
    if (xmp && xmp.title) { titles[imagePath] = xmp.title; xmpCounts.titles++; }
    if (xmp && xmp.description) { descriptions[imagePath] = xmp.description; xmpCounts.descriptions++; }

    const record = {
        id: id,
        fileName: fileName,
        format: path.extname(fileName).slice(1).toUpperCase(),
        sizeBytes: buffer.length,
        linkColor: linkColor,
        linkKeyword: (xmp && xmp.linkKeyword) || '',
        exif: dateTaken ? { dateTaken: dateTaken } : {}
    };
    // Extra XnView tags, ready for future sort and filter buttons on the page.
    if (xmp && xmp.linkColor) { record.colourLabel = xmp.label; xmpCounts.colours++; }
    if (xmp && xmp.rating) { record.rating = xmp.rating; xmpCounts.ratings++; }
    if (xmp && xmp.groups.length) { record.groups = xmp.groups; xmpCounts.groups++; }
    imageFileMetadata[imagePath] = record;
}

const output = [
    '// Generated by generateRegistry.js from photographs directly inside ' + COLLECTIONS_NAME + '/.',
    'const GALLERY_ASSET_ROOT = ' + JSON.stringify(COLLECTIONS_NAME) + ';',
    'const GALLERY_ICON_PATHS = ' + JSON.stringify(iconPaths, null, 4) + ';',
    'const HOME_ICON_PATHS = ' + JSON.stringify(homeIcons, null, 4) + ';',
    'const MASTER_IMAGE_REGISTRY = ' + JSON.stringify(imagePaths, null, 4) + ';',
    'const IMAGE_TITLES = ' + JSON.stringify(titles, null, 4) + ';',
    'const IMAGE_DESCRIPTIONS = ' + JSON.stringify(descriptions, null, 4) + ';',
    'const IMAGE_FILE_METADATA = ' + JSON.stringify(imageFileMetadata, null, 4) + ';',
    'function getImageTitle(path) {',
    "    const key = String(path).replace(/\\\\/g, '/');",
    "    return IMAGE_TITLES[key] || key.split('/').pop().replace(/\\.[^/.]+$/, '');",
    '}',
    'function getImageDescription(path) {',
    "    const key = String(path).replace(/\\\\/g, '/');",
    "    return IMAGE_DESCRIPTIONS[key] || '';",
    '}',
    ''
].join('\n');

const temp = REGISTRY + '.tmp';
fs.writeFileSync(temp, output, 'utf8');
fs.renameSync(temp, REGISTRY);

const colourCount = Object.values(imageFileMetadata).filter(item => item.linkColor).length;
const dateCount = Object.values(imageFileMetadata).filter(item => item.exif && item.exif.dateTaken).length;
console.log('registry.js updated: ' + imagePaths.length + ' photographs found directly inside collections/.');
console.log('Return-home pictures found in assets/home: ' + homeIcons.length + '.');
console.log('Published ' + colourCount + ' XnView link colours and ' + dateCount + ' embedded EXIF dates.');
console.log('XnView sidecars read: ' + xmpCounts.sidecars + ' photos (' +
    xmpCounts.colours + ' colours, ' + xmpCounts.ratings + ' star ratings, ' +
    xmpCounts.groups + ' with groups, ' + xmpCounts.titles + ' titles, ' +
    xmpCounts.descriptions + ' descriptions).');

// A .xmp file with no matching photo usually means a photo was renamed or removed.
const orphanSidecars = Array.from(folderNames.values())
    .filter(name => /\.xmp$/i.test(name) && !usedSidecars.has(name.toLowerCase()));
if (orphanSidecars.length) {
    console.log('\nWARNING: ' + orphanSidecars.length + ' .xmp file(s) have no matching photo and were ignored:');
    orphanSidecars.slice(0, 10).forEach(name => console.log('  ' + name));
    if (orphanSidecars.length > 10) console.log('  ...and ' + (orphanSidecars.length - 10) + ' more');
}

// A photo tagged link:SomeName where SomeName is not in palette.json gets no colour.
if (unknownColourNames.size) {
    console.log('\nWARNING: these colour names are not in palette.json, so those photos use their XnView colour label instead:');
    unknownColourNames.forEach((count, name) => console.log('  link:' + name + '  (' + count + ' photo' + (count === 1 ? '' : 's') + ')'));
}
