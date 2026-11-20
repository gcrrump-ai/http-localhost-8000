// save-server.js  -  small local helper for the floating window (your PC only).
// It reads and writes the XnView .xmp files beside the photos in collections\,
// and renames photos. It keeps NO copy of any data and holds NO file open:
// every request reads the file fresh from disk, and every write is one quick,
// checked swap. XnView and the window can both edit the same photo safely.
// It does not use image-metadata.json at all.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const xmp = require('./xmp-tools.js');

const FILE = path.join(__dirname, 'index.html');
const COLLECTIONS = path.join(__dirname, 'collections');
const PORT = 8001;
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)$/i;

function sendJson(res, status, value) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
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

function validateFilenameTitle(value, extension) {
    let title = String(value == null ? '' : value).trim();
    if (extension && title.toLowerCase().endsWith(extension.toLowerCase())) {
        title = title.slice(0, -extension.length).trim();
    }
    if (!title) throw new Error('Title cannot be blank.');
    if (title.length > 200) throw new Error('Title is too long (maximum 200 characters).');
    const invalidFilenameCharacters = ['<', '>', '"', ':', '/', '\\', '|', '?', '*'];
    if (Array.from(title).some(character =>
        invalidFilenameCharacters.includes(character) || character.charCodeAt(0) < 32
    )) {
        throw new Error('Title contains a character Windows cannot use in a filename.');
    }
    if (/[. ]$/.test(title)) throw new Error('A filename cannot end with a dot or space.');
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)/i.test(title)) {
        throw new Error('That title is reserved by Windows and cannot be used as a filename.');
    }
    return title;
}


// 'collections/Name.jpg' -> real file name inside collections, or throws.
function resolvePhoto(webPath) {
    const parts = String(webPath || '').replace(/\\/g, '/').split('/');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'collections' || !IMAGE_EXT.test(parts[1])) {
        throw new Error('That is not a photo inside collections.');
    }
    const names = new Map(fs.readdirSync(COLLECTIONS, { withFileTypes: true })
        .filter(entry => entry.isFile()).map(entry => [entry.name.toLowerCase(), entry.name]));
    const real = names.get(parts[1].toLowerCase());
    if (!real) throw new Error('Photo not found. It may have been renamed or moved. Refresh the website.');
    return { fileName: real, names: names };
}

// What the window needs, read fresh from disk.
function describePhoto(fileName) {
    const sidecar = xmp.readSidecar(COLLECTIONS, fileName, null, xmp.paletteMap(xmp.loadPalette(__dirname)));
    const data = sidecar ? sidecar.data : xmp.parse('');
    let sizeBytes = null;
    try { sizeBytes = fs.statSync(path.join(COLLECTIONS, fileName)).size; } catch (_) {}
    return {
        path: 'collections/' + fileName,
        fileName: fileName,
        stem: path.basename(fileName, path.extname(fileName)),
        hasSidecar: !!sidecar,
        sidecarName: sidecar ? sidecar.name : '',
        title: data.title,
        description: data.description,
        linkColor: data.linkColor,
        linkKeyword: data.linkKeyword,
        label: data.label,
        rating: data.rating,
        groups: data.groups,
        sizeBytes: sizeBytes,
        version: sidecar ? sidecar.version : ''
    };
}

function sameSidecarSet(oldFile, newFile) {
    const pairs = [];
    const oldNames = xmp.sidecarNames(oldFile);
    const newNames = xmp.sidecarNames(newFile);
    const present = new Map(fs.readdirSync(COLLECTIONS, { withFileTypes: true })
        .filter(entry => entry.isFile()).map(entry => [entry.name.toLowerCase(), entry.name]));
    oldNames.forEach((name, index) => {
        const real = present.get(name.toLowerCase());
        if (real) pairs.push({ from: path.join(COLLECTIONS, real), to: path.join(COLLECTIONS, newNames[index]) });
    });
    return pairs;
}

// Rename the photo and its .xmp together. Undo everything if any step fails.
function renamePhotoWithSidecars(oldFile, newFile) {
    const moves = [{ from: path.join(COLLECTIONS, oldFile), to: path.join(COLLECTIONS, newFile) }]
        .concat(sameSidecarSet(oldFile, newFile));
    const done = [];
    try {
        moves.forEach(move => {
            // Two-step move so a change of capital letters works on Windows.
            const temp = path.join(COLLECTIONS, '.rename-' + crypto.randomBytes(6).toString('hex'));
            fs.renameSync(move.from, temp);
            try { fs.renameSync(temp, move.to); }
            catch (error) { try { fs.renameSync(temp, move.from); } catch (_) {} throw error; }
            done.push(move);
        });
    } catch (error) {
        done.reverse().forEach(move => { try { fs.renameSync(move.to, move.from); } catch (_) {} });
        throw new Error('Could not rename. Another program may be using the file. (' + (error.code || error.message) + ')');
    }
    return function undo() {
        done.slice().reverse().forEach(move => { try { fs.renameSync(move.to, move.from); } catch (_) {} });
    };
}

// registry.js is written ONLY by generateRegistry.js. After a rename we run it.
function rebuildRegistry() {
    try {
        execFileSync(process.execPath, [path.join(__dirname, 'generateRegistry.js')],
            { cwd: __dirname, stdio: 'pipe', timeout: 120000 });
        return '';
    } catch (error) {
        return 'Renamed, but registry.js was not rebuilt. Run node .\\generateRegistry.js. ' +
            String((error.stderr || error.message || '')).split('\n').filter(Boolean).slice(0, 2).join(' ');
    }
}

// What the window needs to draw the Colours section, read fresh from disk.
function describePalette() {
    const palette = xmp.loadPalette(__dirname);
    const use = xmp.keywordUse(COLLECTIONS);
    const known = new Set(palette.colours.map(item => item.name.toLowerCase()));
    return {
        colours: palette.colours.map(item => {
            const used = use.find(entry => entry.keyword.toLowerCase() === item.name.toLowerCase());
            return { name: item.name, hex: item.hex, count: used ? used.count : 0 };
        }),
        // exact #hex colours on photos that have no name yet
        unnamed: use.filter(entry => xmp.HEX_PATTERN.test(entry.keyword)).map(entry => ({ hex: entry.keyword, count: entry.count })),
        // names used on photos but missing from palette.json
        missing: use.filter(entry => !xmp.HEX_PATTERN.test(entry.keyword) && !known.has(entry.keyword.toLowerCase()))
            .map(entry => ({ name: entry.keyword, count: entry.count }))
    };
}

function paletteAction(action, input) {
    let result;
    if (action === 'set') result = xmp.paletteSet(__dirname, COLLECTIONS, input);
    else if (action === 'remove') result = xmp.paletteRemove(__dirname, COLLECTIONS, input.name);
    else if (action === 'adopt') result = xmp.paletteAdopt(__dirname, COLLECTIONS, input);
    else throw new Error('Unknown palette action.');
    return { result: result, palette: describePalette() };
}

function saveFromWindow(input) {
    const photo = resolvePhoto(input.path);
    const base = input.base || {};
    const fields = input.fields || {};

    // 1. Read the file fresh and see what XnView (or anything else) has changed since the window loaded it.
    const current = describePhoto(photo.fileName);
    const conflicts = [];
    ['title', 'description', 'linkKeyword'].forEach(key => {
        if (fields[key] === undefined) return;
        const changedInWindow = String(fields[key]) !== String(base[key] || '');
        const changedOnDisk = String(current[key] || '') !== String(base[key] || '');
        if (changedInWindow && changedOnDisk && String(current[key] || '') !== String(fields[key])) conflicts.push(key);
    });
    if (conflicts.length) {
        const error = new Error('Changed in XnView since you opened it: ' + conflicts.join(', ') +
            '. Nothing was saved. The window has reloaded the new values.');
        error.conflict = true;
        throw error;
    }

    // 2. Work out ONLY the fields the window changed.
    const changes = {};
    if (fields.title !== undefined && String(fields.title) !== String(base.title || '')) changes.title = String(fields.title).trim();
    if (fields.description !== undefined && String(fields.description) !== String(base.description || '')) changes.description = String(fields.description).trim();
    if (fields.linkKeyword !== undefined && String(fields.linkKeyword) !== String(base.linkKeyword || '')) {
        changes.linkKeyword = String(fields.linkKeyword || '').trim();   // '' removes, '#hex' or a palette name
    }

    // 3. Rename (photo and .xmp move together).
    let newFile = photo.fileName;
    let undoRename = null;
    const extension = path.extname(photo.fileName);
    if (fields.filename !== undefined) {
        const stem = validateFilenameTitle(fields.filename, extension);
        if (stem + extension !== photo.fileName) {
            newFile = stem + extension;
            const collision = Array.from(photo.names.values())
                .some(name => name.toLowerCase() === newFile.toLowerCase() && name !== photo.fileName);
            if (collision) throw new Error('Another image already has that filename.');
            undoRename = renamePhotoWithSidecars(photo.fileName, newFile);
        }
    }

    // 4. Write the changed fields into the .xmp, then read it back.
    try {
        if (Object.keys(changes).length) xmp.writeChanges(COLLECTIONS, newFile, changes);
    } catch (error) {
        if (undoRename) undoRename();
        throw error;
    }

    const warning = newFile !== photo.fileName ? rebuildRegistry() : '';
    return { image: describePhoto(newFile), renamed: newFile !== photo.fileName, warning: warning };
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
    const origin = req.headers.origin || '';
    const allowedOrigins = new Set(['http://127.0.0.1:8000', 'http://localhost:8000']);
    if (origin && !allowedOrigins.has(origin)) {
        sendJson(res, 403, { ok: false, error: 'The image editor is available only from this computer.' });
        return;
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
        if (!origin) { res.writeHead(403); res.end(); return; }
        res.writeHead(204); res.end(); return;
    }



    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/ping') {
        sendJson(res, 200, { ok: true });
        return;
    }

    // Fresh read of one photo's .xmp. Called whenever the window opens a photo.
    if (req.method === 'GET' && url.pathname === '/xmp') {
        try {
            const photo = resolvePhoto(url.searchParams.get('path'));
            sendJson(res, 200, { ok: true, image: describePhoto(photo.fileName) });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error.message || error) }); }
        return;
    }

    if (req.method === 'GET' && url.pathname === '/palette') {
        try { sendJson(res, 200, { ok: true, palette: describePalette() }); }
        catch (error) { sendJson(res, 400, { ok: false, error: String(error.message || error) }); }
        return;
    }

    if (req.method === 'POST' && url.pathname.indexOf('/palette/') === 0) {
        readBody(req, function (body) {
            try {
                const done = paletteAction(url.pathname.slice('/palette/'.length), JSON.parse(body));
                let note = done.result.failed.length
                    ? done.result.failed.length + ' photo(s) could not be changed (another program may be using them). Press the button again.'
                    : '';
                // Photos got a new colour name, so registry.js is rebuilt (by generateRegistry.js only).
                if (done.result.changed > 0) note = rebuildRegistry() || note;
                sendJson(res, 200, { ok: true, changed: done.result.changed, warning: note, palette: done.palette });
                console.log('Palette ' + url.pathname.slice('/palette/'.length) + ' (' + done.result.changed + ' photos changed)');
            } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error.message || error) });
            }
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/save-xmp') {
        readBody(req, function (body) {
            try {
                const result = saveFromWindow(JSON.parse(body));
                sendJson(res, 200, Object.assign({ ok: true }, result));
                console.log((result.renamed ? 'Renamed and saved ' : 'Saved ') + result.image.fileName);
            } catch (error) {
                let fresh = null;
                if (error.conflict) {
                    try { fresh = describePhoto(resolvePhoto(JSON.parse(body).path).fileName); } catch (_) {}
                }
                sendJson(res, error.conflict ? 409 : 400,
                    { ok: false, conflict: !!error.conflict, error: String(error.message || error), image: fresh });
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
    console.log('Reads and writes the XnView .xmp files in collections\\. Press Ctrl+C to stop.');
});
