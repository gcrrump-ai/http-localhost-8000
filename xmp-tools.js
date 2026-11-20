// xmp-tools.js
// The ONLY code that reads or writes XnView .xmp sidecar files.
// Used by generateRegistry.js (reads) and save-server.js (reads and writes).
//
// Rules this file follows so XnView and the floating window never fight:
//  - Every read opens the file, reads it, and closes it. Nothing is cached.
//  - A write changes ONLY the fields asked for. Everything else XnView wrote stays.
//  - A write goes to a temporary file first and is then swapped in, so a crash can
//    never leave a half-written .xmp.
//  - After writing, the file is read back and checked before reporting success.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// XnView colour label -> link colour on the website. Edit a hex value to change a colour.
const XMP_COLOURS = {
    red: '#d32f2f',
    orange: '#ef7d00',
    yellow: '#d4a000',
    green: '#2e9e2e',
    blue: '#1565c0',
    purple: '#800080',
    grey: '#808080',
    black: '#222222',
    white: '#bdbdbd'
};
// Other names XnView can read for the same colours (Settings > Metadata > Color labels).
const XMP_COLOUR_ALIASES = {
    gray: 'grey', select: 'red', second: 'yellow', approved: 'green', review: 'blue',
    'to do': 'purple', '6': 'orange', '7': 'grey', '8': 'black', '9': 'white'
};

// A link colour is stored as an ordinary XnView keyword:
//   link:Sunset      a name from palette.json (you pick the shade once, there)
//   link:#c07b21     an exact colour, used directly
const LINK_PREFIX = 'link:';
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
const PALETTE_FILE = 'palette.json';

// ---- reading ---------------------------------------------------------------
function decodeXml(text) {
    return String(text)
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
}
function encodeXml(text) {
    return String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        // XML cannot hold most control characters.
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

// Text of every <rdf:li> inside <tag>...</tag> (title, description and subject are lists).
function listItems(xml, tag) {
    const block = xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>'));
    if (!block) return [];
    return Array.from(block[1].matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g))
        .map(match => decodeXml(match[1]))
        .filter(Boolean);
}

// A simple value can be written as <xmp:Rating>5</xmp:Rating> or as an attribute.
function simpleValue(xml, name) {
    const element = xml.match(new RegExp('<' + name + '>([^<]*)</' + name + '>'));
    if (element) return decodeXml(element[1]);
    const attribute = xml.match(new RegExp('\\b' + name + '="([^"]*)"'));
    return attribute ? decodeXml(attribute[1]) : '';
}

function colourFromLabel(label) {
    let key = String(label || '').trim().toLowerCase();
    if (!key) return '';
    if (XMP_COLOUR_ALIASES[key]) key = XMP_COLOUR_ALIASES[key];
    return XMP_COLOURS[key] || '';
}

// palette: { 'lower-case name': '#rrggbb' } (see paletteMap). Optional.
function parse(xml, palette) {
    const rating = parseInt(simpleValue(xml, 'xmp:Rating'), 10);
    const groups = [];
    let keyword = '';
    listItems(xml, 'dc:subject').forEach(item => {
        if (item.toLowerCase().startsWith(LINK_PREFIX)) {
            const value = item.slice(LINK_PREFIX.length).trim();
            if (!keyword && value) keyword = HEX_PATTERN.test(value) ? value.toLowerCase() : value;
            return; // never shown as a group
        }
        if (!groups.some(existing => existing.toLowerCase() === item.toLowerCase())) groups.push(item);
    });
    let keywordColour = '';
    if (keyword) {
        if (HEX_PATTERN.test(keyword)) keywordColour = keyword;
        else if (palette && palette[keyword.toLowerCase()]) keywordColour = palette[keyword.toLowerCase()];
    }
    const label = simpleValue(xml, 'xmp:Label');
    return {
        title: listItems(xml, 'dc:title')[0] || '',
        description: listItems(xml, 'dc:description')[0] || '',
        rating: Number.isFinite(rating) && rating > 0 ? Math.min(rating, 5) : 0,
        label: label,
        linkKeyword: keyword,                 // 'Sunset' or '#c07b21' or ''
        unknownName: keyword && !keywordColour ? keyword : '',
        keywordColour: keywordColour,
        // The colour keyword wins; otherwise the XnView colour label decides.
        linkColor: keywordColour || colourFromLabel(label),
        groups: groups
    };
}

// ---- finding the sidecar for a photo ----------------------------------------
// XnView names the sidecar either "photo.jpg.xmp" or "photo.xmp" depending on its setting.
function sidecarNames(fileName) {
    const base = path.basename(fileName, path.extname(fileName));
    return [fileName + '.xmp', base + '.xmp'];
}

// folderNames: Map(lower-case file name -> real file name) for the folder.
// Returns { name, full } of the newest existing sidecar, or null.
function findSidecar(dir, fileName, folderNames) {
    const names = folderNames || new Map(
        fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile())
            .map(e => [e.name.toLowerCase(), e.name]));
    const found = sidecarNames(fileName)
        .map(name => names.get(name.toLowerCase()))
        .filter(Boolean)
        .map(name => ({ name: name, full: path.join(dir, name) }))
        .filter(item => { try { return fs.statSync(item.full).isFile(); } catch (_) { return false; } });
    if (!found.length) return null;
    found.sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs);
    return found[0];
}

function versionOf(text) {
    return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

// Fresh read from disk. Returns { name, full, xml, data, version } or null when there is no sidecar.
function readSidecar(dir, fileName, folderNames, palette) {
    const found = findSidecar(dir, fileName, folderNames);
    if (!found) return null;
    let raw;
    try { raw = fs.readFileSync(found.full, 'utf8'); } catch (_) { return null; }
    const xml = raw.replace(/^﻿/, '');
    return { name: found.name, full: found.full, xml: xml, data: parse(xml, palette), version: versionOf(raw) };
}

// ---- editing ---------------------------------------------------------------
function listProperty(tag, kind, items, indent) {
    const pad = indent + '   ';
    const lis = items.map(value =>
        pad + '   ' + (kind === 'Alt' ? '<rdf:li xml:lang="x-default">' : '<rdf:li>') + encodeXml(value) + '</rdf:li>');
    return indent + '<' + tag + '>\n' + pad + '<rdf:' + kind + '>\n' + lis.join('\n') + '\n' +
        pad + '</rdf:' + kind + '>\n' + indent + '</' + tag + '>';
}

function openDescription(xml) {
    // A self-closing <rdf:Description ... /> cannot hold properties; turn it into an open one.
    return xml.replace(/<rdf:Description\b([^>]*?)\s*\/>/, '<rdf:Description$1>\n   </rdf:Description>');
}
function ensureNamespace(xml, prefix, uri) {
    const open = /<rdf:Description\b[^>]*>/.exec(xml);
    if (!open) throw new Error('This .xmp file has no rdf:Description block, so it was left alone.');
    if (new RegExp('xmlns:' + prefix + '\\s*=').test(open[0])) return xml;
    const fixed = open[0].replace(/>$/, ' xmlns:' + prefix + '="' + uri + '">');
    return xml.slice(0, open.index) + fixed + xml.slice(open.index + open[0].length);
}
function removeProperty(xml, tag) {
    const element = new RegExp('[ \\t]*<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?</' + tag + '>[ \\t]*\\r?\\n?');
    let out = xml.replace(element, '');
    out = out.replace(new RegExp('\\s' + tag + '="[^"]*"'), ''); // attribute form
    return out;
}
function setProperty(xml, tag, kind, items) {
    const exists = new RegExp('<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?</' + tag + '>').test(xml) ||
        new RegExp('\\s' + tag + '="').test(xml);
    if (!items.length) return exists ? removeProperty(xml, tag) : xml;
    const element = new RegExp('<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?</' + tag + '>');
    if (element.test(xml)) {
        const lineStart = new RegExp('([ \\t]*)<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?</' + tag + '>').exec(xml);
        const indent = lineStart ? lineStart[1] : '         ';
        return xml.replace(new RegExp('[ \\t]*<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?</' + tag + '>'),
            () => listProperty(tag, kind, items, indent));
    }
    xml = removeProperty(xml, tag); // drop an attribute-form copy, if any
    const close = xml.lastIndexOf('</rdf:Description>');
    if (close < 0) throw new Error('This .xmp file has no closing rdf:Description, so it was left alone.');
    const before = xml.slice(0, close).replace(/[ \t]*$/, '');
    return before + listProperty(tag, kind, items, '         ') + '\n      ' + xml.slice(close);
}

// The colour keyword a change asks for: undefined (leave alone), '' (remove), '#rrggbb' or a name.
// changes.linkKeyword wins; changes.linkColor (a hex) is the older way to ask for a hex.
function wantedKeyword(changes) {
    let value = changes.linkKeyword !== undefined ? changes.linkKeyword : changes.linkColor;
    if (value === undefined) return undefined;
    value = String(value || '').trim();
    if (!value) return '';
    if (changes.linkKeyword === undefined && !HEX_PATTERN.test(value)) throw new Error('Link colour must look like #c07b21.');
    if (HEX_PATTERN.test(value)) return value.toLowerCase();
    if (!NAME_PATTERN.test(value)) throw new Error('A colour name may use letters, numbers, spaces, - and _ (up to 40 characters).');
    return value;
}

// changes: { title?, description?, linkKeyword? | linkColor? }  - a missing key is left untouched;
// an empty string clears the field. Returns the new XML text.
function applyChanges(xml, changes) {
    let out = openDescription(xml);
    if (changes.title !== undefined || changes.description !== undefined || wantedKeyword(changes) !== undefined) {
        out = ensureNamespace(out, 'dc', 'http://purl.org/dc/elements/1.1/');
    }
    if (changes.title !== undefined) {
        out = setProperty(out, 'dc:title', 'Alt', changes.title ? [String(changes.title)] : []);
    }
    if (changes.description !== undefined) {
        out = setProperty(out, 'dc:description', 'Alt', changes.description ? [String(changes.description)] : []);
    }
    if (wantedKeyword(changes) !== undefined) {
        const keyword = wantedKeyword(changes);
        // Keep every ordinary keyword, replace only the link: keyword.
        const keep = listItems(out, 'dc:subject').filter(item => !item.toLowerCase().startsWith(LINK_PREFIX));
        const subject = keyword ? keep.concat(LINK_PREFIX + keyword) : keep;
        out = setProperty(out, 'dc:subject', 'Bag', subject);
        // XnView also lists keywords here; keep the two lists the same if it exists.
        if (/<lr:hierarchicalSubject/.test(out)) {
            const keepH = listItems(out, 'lr:hierarchicalSubject').filter(item => !item.toLowerCase().startsWith(LINK_PREFIX));
            out = setProperty(out, 'lr:hierarchicalSubject', 'Bag', keyword ? keepH.concat(LINK_PREFIX + keyword) : keepH);
        }
    }
    return out;
}

function newSidecarXml(changes) {
    const skeleton =
        '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 6.0.0">\n' +
        '   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
        '      <rdf:Description rdf:about=""\n' +
        '            xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
        '      </rdf:Description>\n' +
        '   </rdf:RDF>\n' +
        '</x:xmpmeta>\n';
    return applyChanges(skeleton, changes);
}

// ---- writing ---------------------------------------------------------------
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Write to a temporary file in the same folder, then swap it in. If another program
// (for example XnView) has the file open at that moment, try again a few times.
function atomicWrite(fullPath, text) {
    const temp = fullPath + '.tmp-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(temp, text, 'utf8');
    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt++) {
        try { fs.renameSync(temp, fullPath); return; }
        catch (error) {
            lastError = error;
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) break;
            sleepMs(150 * (attempt + 1));
        }
    }
    try { fs.unlinkSync(temp); } catch (_) {}
    throw new Error('Could not save the .xmp file. Another program (such as XnView) may be using it. Try again in a moment. (' +
        (lastError && lastError.code) + ')');
}

// Apply changes to the photo's sidecar (creating it when there is none), then read it
// back from disk to confirm. Returns the fresh { name, data, version }.
function writeChanges(dir, fileName, changes) {
    const existing = readSidecar(dir, fileName);
    let target, before, text;
    if (existing) {
        target = existing.full;
        before = existing.data;
        const hadBom = /^﻿/.test(fs.readFileSync(target, 'utf8'));
        text = (hadBom ? '﻿' : '') + applyChanges(existing.xml, changes);
    } else {
        target = path.join(dir, fileName + '.xmp');
        before = parse('');
        text = newSidecarXml(changes);
    }
    // Check the result BEFORE touching the disk.
    const expected = parse(text.replace(/^﻿/, ''));
    ['rating', 'label'].forEach(key => {
        if (expected[key] !== before[key]) throw new Error('Safety check failed (' + key + '). Nothing was saved.');
    });
    if (JSON.stringify(expected.groups) !== JSON.stringify(before.groups)) {
        throw new Error('Safety check failed (groups). Nothing was saved.');
    }
    if (changes.title !== undefined && expected.title !== String(changes.title).trim()) throw new Error('Safety check failed (title). Nothing was saved.');
    if (changes.description !== undefined && expected.description !== String(changes.description).trim()) throw new Error('Safety check failed (description). Nothing was saved.');
    if (wantedKeyword(changes) !== undefined && expected.linkKeyword !== wantedKeyword(changes)) throw new Error('Safety check failed (colour). Nothing was saved.');

    atomicWrite(target, text);
    const fresh = readSidecar(dir, fileName);
    if (!fresh) throw new Error('The .xmp file could not be read back after saving.');
    return fresh;
}

// ---- the colour palette (palette.json) ---------------------------------------
function loadPalette(rootDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, PALETTE_FILE), 'utf8').replace(/^\uFEFF/, ''));
        const colours = (Array.isArray(parsed.colours) ? parsed.colours : [])
            .filter(item => item && NAME_PATTERN.test(String(item.name || '')) && HEX_PATTERN.test(String(item.hex || '')))
            .map(item => ({ name: String(item.name), hex: String(item.hex).toLowerCase() }));
        return { colours: colours };
    } catch (_) {
        return { colours: [] };
    }
}
function paletteMap(palette) {
    const map = {};
    palette.colours.forEach(item => { map[item.name.toLowerCase()] = item.hex; });
    return map;
}
function savePalette(rootDir, palette) {
    atomicWrite(path.join(rootDir, PALETTE_FILE), JSON.stringify({ colours: palette.colours }, null, 2) + '\n');
}
function cleanName(name) {
    const value = String(name || '').trim();
    if (!NAME_PATTERN.test(value)) throw new Error('A colour name may use letters, numbers, spaces, - and _ (up to 40 characters).');
    return value;
}
function cleanHex(hex) {
    const value = String(hex || '').trim().toLowerCase();
    if (!HEX_PATTERN.test(value)) throw new Error('A colour must look like #c07b21.');
    return value;
}

// Every photo with its sidecar, read fresh. Used by the palette tools.
function eachPhoto(dir, callback) {
    const names = new Map(fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile())
        .map(e => [e.name.toLowerCase(), e.name]));
    Array.from(names.values()).filter(name => IMAGE_EXT.test(name)).forEach(name => {
        const sidecar = readSidecar(dir, name, names);
        if (sidecar) callback(name, sidecar);
    });
}

// How many photos use each colour keyword. [{ keyword, count }]
function keywordUse(dir) {
    const counts = new Map();
    eachPhoto(dir, (name, sidecar) => {
        const keyword = sidecar.data.linkKeyword;
        if (!keyword) return;
        const key = keyword.toLowerCase();
        counts.set(key, { keyword: keyword, count: (counts.get(key) ? counts.get(key).count : 0) + 1 });
    });
    return Array.from(counts.values());
}

// Change the colour keyword on every photo that has `from` (a name or a #hex) to `to`.
function convertKeyword(dir, from, to) {
    const fromKey = String(from).toLowerCase();
    const targets = [];
    eachPhoto(dir, (name, sidecar) => {
        if (sidecar.data.linkKeyword && sidecar.data.linkKeyword.toLowerCase() === fromKey) targets.push(name);
    });
    const failed = [];
    let changed = 0;
    targets.forEach(name => {
        try { writeChanges(dir, name, { linkKeyword: to }); changed++; }
        catch (error) { failed.push(name + ': ' + error.message); }
    });
    return { changed: changed, failed: failed };
}

// Palette edits. Each saves palette.json BEFORE touching photos, so a photo never
// points at a name that does not exist yet. Safe to run again if one photo failed.
function paletteSet(rootDir, dir, input) {
    const name = cleanName(input.name);
    const hex = cleanHex(input.hex);
    const palette = loadPalette(rootDir);
    const find = n => palette.colours.find(item => item.name.toLowerCase() === String(n).toLowerCase());
    const oldName = input.oldName ? String(input.oldName).trim() : '';
    const existingOld = oldName ? find(oldName) : null;
    const clash = find(name);
    let result = { changed: 0, failed: [] };
    if (existingOld && existingOld.name.toLowerCase() !== name.toLowerCase()) {
        if (clash) throw new Error('A colour called "' + clash.name + '" already exists.');
        palette.colours.push({ name: name, hex: hex });          // 1. add the new name
        savePalette(rootDir, palette);
        result = convertKeyword(dir, existingOld.name, name);     // 2. move the photos
        if (!result.failed.length) {                              // 3. drop the old name
            palette.colours = palette.colours.filter(item => item.name.toLowerCase() !== existingOld.name.toLowerCase());
            savePalette(rootDir, palette);
        }
    } else if (existingOld || clash) {
        const entry = existingOld || clash;
        entry.name = name; entry.hex = hex;                       // same name, new shade
        savePalette(rootDir, palette);
    } else {
        palette.colours.push({ name: name, hex: hex });           // brand new colour
        savePalette(rootDir, palette);
    }
    return result;
}
function paletteRemove(rootDir, dir, nameInput) {
    const name = cleanName(nameInput);
    const used = keywordUse(dir).find(item => item.keyword.toLowerCase() === name.toLowerCase());
    if (used) throw new Error('"' + name + '" is used by ' + used.count + ' photo(s). Move them to another colour first.');
    const palette = loadPalette(rootDir);
    palette.colours = palette.colours.filter(item => item.name.toLowerCase() !== name.toLowerCase());
    savePalette(rootDir, palette);
    return { changed: 0, failed: [] };
}
// Give a name to an exact colour already used on photos: link:#c07b21 -> link:Sunset
function paletteAdopt(rootDir, dir, input) {
    const name = cleanName(input.name);
    const hex = cleanHex(input.hex);
    const palette = loadPalette(rootDir);
    const clash = palette.colours.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (clash && clash.hex !== hex) throw new Error('A colour called "' + clash.name + '" already exists with a different shade.');
    if (!clash) { palette.colours.push({ name: name, hex: hex }); savePalette(rootDir, palette); }
    return convertKeyword(dir, hex, name);
}

module.exports = {
    XMP_COLOURS, XMP_COLOUR_ALIASES, LINK_PREFIX,
    parse, findSidecar, readSidecar, sidecarNames, applyChanges, newSidecarXml,
    writeChanges, atomicWrite, versionOf, colourFromLabel,
    HEX_PATTERN, NAME_PATTERN,
    loadPalette, paletteMap, savePalette, keywordUse, convertKeyword, paletteSet, paletteRemove, paletteAdopt
};
