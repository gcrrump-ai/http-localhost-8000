const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'index.html');
const COLLECTIONS = path.join(__dirname, 'collections');
const METADATA_FILE = path.join(__dirname, 'image-metadata.json');
const PORT = 8001;
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)$/i;

function sendJson(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}
function readBody(req, callback) {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) req.destroy(new Error('Request body too large'));
    });
    req.on('end', () => callback(body));
}
function readMetadataStore() {
    if (!fs.existsSync(METADATA_FILE)) return { version: 1, images: {}, legacyUnmatched: { titles: {}, descriptions: {} } };
    const parsed = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    parsed.images = parsed.images || {};
    parsed.legacyUnmatched = parsed.legacyUnmatched || { titles: {}, descriptions: {} };
    return parsed;
}
function saveMetadataStore(store) {
    const temp = METADATA_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(store, null, 4), 'utf8');
    fs.copyFileSync(temp, METADATA_FILE);
    fs.unlinkSync(temp);
}
function hashBuffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readExifValue(tiff, little, type, count, valueOffset) {
    const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const size = sizes[type];
    if (!size || count < 1) return null;
    const byteLength = size * count;
    const offset = byteLength <= 4 ? valueOffset : (little ? tiff.readUInt32LE(valueOffset) : tiff.readUInt32BE(valueOffset));
    if (offset < 0 || offset + byteLength > tiff.length) return null;
    if (type === 2) return tiff.toString('ascii', offset, offset + byteLength).replace(/\0+$/, '').trim();
    if (type === 3) return little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
    if (type === 4) return little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
    if (type === 5 || type === 10) {
        const a = type === 5 ? (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset)) : (little ? tiff.readInt32LE(offset) : tiff.readInt32BE(offset));
        const b = type === 5 ? (little ? tiff.readUInt32LE(offset + 4) : tiff.readUInt32BE(offset + 4)) : (little ? tiff.readInt32LE(offset + 4) : tiff.readInt32BE(offset + 4));
        return b ? a / b : null;
    }
    return null;
}
function parseExifTiff(tiff) {
    const result = {};
    if (tiff.length < 8) return result;
    const order = tiff.toString('ascii', 0, 2);
    const little = order === 'II';
    if (!little && order !== 'MM') return result;
    const u16 = offset => little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
    const u32 = offset => little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
    if (u16(2) !== 42) return result;

    function readIfd(offset) {
        const entries = {};
        if (offset + 2 > tiff.length) return entries;
        const count = u16(offset);
        for (let i = 0; i < count; i++) {
            const entry = offset + 2 + i * 12;
            if (entry + 12 > tiff.length) break;
            const tag = u16(entry);
            const type = u16(entry + 2);
            const num = u32(entry + 4);
            entries[tag] = readExifValue(tiff, little, type, num, entry + 8);
        }
        return entries;
    }

    const ifd0 = readIfd(u32(4));
    if (ifd0[0x010F]) result.cameraMake = String(ifd0[0x010F]);
    if (ifd0[0x0110]) result.cameraModel = String(ifd0[0x0110]);
    if (ifd0[0x0112]) result.orientation = String(ifd0[0x0112]);
    if (ifd0[0x0132]) result.dateTaken = String(ifd0[0x0132]);
    const exifOffset = ifd0[0x8769];
    if (Number.isInteger(exifOffset) && exifOffset > 0) {
        const exif = readIfd(exifOffset);
        if (exif[0x9003]) result.dateTaken = String(exif[0x9003]);
        if (exif[0x829A] !== undefined) result.exposureTime = exif[0x829A] < 1 ? '1/' + Math.round(1 / exif[0x829A]) + ' s' : exif[0x829A] + ' s';
        if (exif[0x829D] !== undefined) result.aperture = 'f/' + Number(exif[0x829D]).toFixed(1).replace(/\.0$/, '');
        if (exif[0x8827] !== undefined) result.iso = String(exif[0x8827]);
        if (exif[0x920A] !== undefined) result.focalLength = Number(exif[0x920A]).toFixed(1).replace(/\.0$/, '') + ' mm';
        if (exif[0xA434]) result.lensModel = String(exif[0xA434]);
    }
    return result;
}
function readImageInfo(buffer, extension) {
    const info = { width: null, height: null, exif: {} };
    const ext = extension.toLowerCase();
    try {
        if (ext === '.png' && buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
            info.width = buffer.readUInt32BE(16); info.height = buffer.readUInt32BE(20);
        } else if (ext === '.gif' && buffer.length >= 10) {
            info.width = buffer.readUInt16LE(6); info.height = buffer.readUInt16LE(8);
        } else if (ext === '.webp' && buffer.length >= 30 && buffer.toString('ascii', 8, 12) === 'WEBP') {
            const chunk = buffer.toString('ascii', 12, 16);
            if (chunk === 'VP8X') {
                info.width = 1 + buffer.readUIntLE(24, 3);
                info.height = 1 + buffer.readUIntLE(27, 3);
            }
        } else if (ext === '.jpg' || ext === '.jpeg') {
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
                    info.exif = parseExifTiff(buffer.slice(dataStart + 6, dataEnd));
                }
                const isSof = [0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker);
                if (isSof && dataStart + 5 < dataEnd) {
                    info.height = buffer.readUInt16BE(dataStart + 1);
                    info.width = buffer.readUInt16BE(dataStart + 3);
                }
                offset += length;
            }
        }
    } catch (_) { /* Malformed or unsupported metadata: retain the fields that were readable. */ }
    if (!info.width || !info.height) { info.width = null; info.height = null; }
    return info;
}

function scanAndSyncMetadata() {
    const store = readMetadataStore();
    if (!fs.existsSync(COLLECTIONS)) throw new Error('collections folder not found: ' + COLLECTIONS);
    const files = fs.readdirSync(COLLECTIONS, { withFileTypes: true })
        .filter(entry => entry.isFile() && IMAGE_EXT.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const images = [];
    let changed = false;

    files.forEach(fileName => {
        const fullPath = path.join(COLLECTIONS, fileName);
        const buffer = fs.readFileSync(fullPath);
        const id = hashBuffer(buffer);
        const stat = fs.statSync(fullPath);
        const extension = path.extname(fileName).slice(1).toUpperCase();
        const info = readImageInfo(buffer, path.extname(fileName));
        let record = store.images[id];
        if (!record) {
            record = {
                id: id,
                title: path.basename(fileName, path.extname(fileName)),
                description: '',
                originalFolder: ''
            };
            store.images[id] = record;
            changed = true;
        }
        images.push(Object.assign({}, record, {
            id: id,
            path: 'collections/' + fileName,
            fileName: fileName,
            format: extension,
            sizeBytes: stat.size,
            lastModified: stat.mtime.toISOString(),
            width: info.width,
            height: info.height,
            dimensions: info.width && info.height ? info.width + ' × ' + info.height : '',
            exif: info.exif
        }));
    });
    if (changed || !fs.existsSync(METADATA_FILE)) saveMetadataStore(store);
    return images;
}

function handleLegacySave(req, res) {
    readBody(req, function (body) {
        try {
            const cfg = JSON.parse(body);
            let src = fs.readFileSync(FILE, 'utf8');
            const startMark = 'const DEFAULTS = {';
            const start = src.indexOf(startMark);
            if (start === -1) throw new Error('DEFAULTS not found');
            let depth = 0, end = start;
            for (let i = start; i < src.length; i++) {
                if (src[i] === '{') depth++;
                if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
            }
            const lines = [];
            lines.push('    const DEFAULTS = {');
            lines.push('        falloff: ' + cfg.falloff + ',');
            lines.push('        ramp: ' + cfg.ramp + ',');
            lines.push('        sliverPx: ' + cfg.sliverPx + ',');
            lines.push('        mirror: ' + cfg.mirror + ',');
            lines.push('        folderWeights: ' + JSON.stringify(cfg.folderWeights) + ',');
            lines.push('        albumLargest: ' + JSON.stringify(cfg.albumLargest) + ',');
            lines.push('        albumSmallest: ' + JSON.stringify(cfg.albumSmallest) + ',');
            lines.push('        folderHex: ' + JSON.stringify(cfg.folderHex) + ',');
            lines.push("        colourMode: '" + cfg.colourMode + "',");
            lines.push('        tint: ' + cfg.tint + ',');
            lines.push('        cellText: ' + JSON.stringify(cfg.cellText) + ',');
            lines.push('        cellFont: ' + JSON.stringify(cfg.cellFont) + ',');
            lines.push('        cellColour: ' + JSON.stringify(cfg.cellColour) + ',');
            lines.push('        cellSize: ' + JSON.stringify(cfg.cellSize) + ',');
            lines.push('        cellRot: ' + JSON.stringify(cfg.cellRot));
            lines.push('    };');
            src = src.slice(0, start) + lines.join('\n') + src.slice(end);
            fs.writeFileSync(FILE, src, 'utf8');
            sendJson(res, 200, { ok: true });
            console.log('Saved existing site configuration');
        } catch (e) {
            sendJson(res, 500, { ok: false, error: String(e) });
            console.error(e);
        }
    });
}

const server = http.createServer(function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/metadata') {
        try { sendJson(res, 200, { ok: true, images: scanAndSyncMetadata() }); }
        catch (error) { sendJson(res, 500, { ok: false, error: String(error.message || error) }); }
        return;
    }

    if (req.method === 'POST' && req.url === '/save-metadata') {
        readBody(req, function (body) {
            try {
                const input = JSON.parse(body);
                if (!/^[a-f0-9]{64}$/i.test(String(input.id || ''))) throw new Error('Invalid image ID');
                const images = scanAndSyncMetadata();
                const current = images.find(image => image.id === input.id);
                if (!current) throw new Error('Image not found. Refresh the website and try again.');

                const store = readMetadataStore();
                const record = store.images[input.id] || { id: input.id };
                record.title = String(input.title || '').slice(0, 300);
                record.description = String(input.description || '').slice(0, 10000);
                record.originalFolder = String(input.originalFolder || '').slice(0, 300);
                
                const linkColor = String(input.linkColor || '');
                if (linkColor && !/^#[0-9a-f]{6}$/i.test(linkColor)) {
                    throw new Error('Invalid link colour');
                }
                record.linkColor = linkColor;
                
                store.images[input.id] = record;
                saveMetadataStore(store);

                const updated = Object.assign({}, current, record);
                sendJson(res, 200, { ok: true, image: updated });
                console.log('Saved metadata for ' + current.fileName);
            } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error.message || error) });
            }
        });
        return;
    }

    // Existing configuration save endpoint retained.
    if (req.method === 'POST' && req.url === '/save') {
        handleLegacySave(req, res);
        return;
    }

    res.writeHead(404); res.end();
});

server.listen(PORT, '127.0.0.1', function () {
    console.log('Save server on http://localhost:' + PORT);
    console.log('Image metadata endpoint: http://localhost:' + PORT + '/metadata');
});
