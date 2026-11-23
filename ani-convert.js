'use strict';
/* Pure Node (no installs). Turns a Windows animated cursor (.ani) into an animated PNG
   that a web page can show. The original file is only ever read. */
const zlib = require('zlib');

// ---------- PNG writing ----------
const CRC_TABLE = (function() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}
function rawScanlines(rgba, w, h) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
    return zlib.deflateSync(raw, { level: 9 });
}
const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function ihdr(w, h) { const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[9] = 6; return chunk('IHDR', b); }
function encodePng(rgba, w, h) {
    return Buffer.concat([SIG, ihdr(w, h), chunk('IDAT', rawScanlines(rgba, w, h)), chunk('IEND', Buffer.alloc(0))]);
}
// frames: [{rgba, w, h, delayMs}]
function encodeApng(frames, w, h) {
    if (frames.length === 1) return encodePng(placeOnCanvas(frames[0], w, h), w, h);
    const parts = [SIG, ihdr(w, h)];
    const actl = Buffer.alloc(8); actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(0, 4); // 0 = loop forever
    parts.push(chunk('acTL', actl));
    let seq = 0;
    frames.forEach(function(f, i) {
        const fctl = Buffer.alloc(26);
        fctl.writeUInt32BE(seq++, 0); fctl.writeUInt32BE(w, 4); fctl.writeUInt32BE(h, 8);
        fctl.writeUInt32BE(0, 12); fctl.writeUInt32BE(0, 16);
        fctl.writeUInt16BE(Math.max(1, Math.round(f.delayMs)), 20); fctl.writeUInt16BE(1000, 22);
        fctl[24] = 1;  // dispose to transparent between frames
        fctl[25] = 0;  // replace, no blending
        parts.push(chunk('fcTL', fctl));
        const data = rawScanlines(placeOnCanvas(f, w, h), w, h);
        if (i === 0) parts.push(chunk('IDAT', data));
        else { const fd = Buffer.alloc(4 + data.length); fd.writeUInt32BE(seq++, 0); data.copy(fd, 4); parts.push(chunk('fdAT', fd)); }
    });
    parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
}
function placeOnCanvas(f, w, h) {
    if (f.w === w && f.h === h) return f.rgba;
    const out = Buffer.alloc(w * h * 4);
    const ox = Math.floor((w - f.w) / 2), oy = Math.floor((h - f.h) / 2);
    for (let y = 0; y < f.h; y++) f.rgba.copy(out, ((y + oy) * w + ox) * 4, y * f.w * 4, (y + 1) * f.w * 4);
    return out;
}

// ---------- PNG reading (only for ICO/CUR frames that hold a PNG) ----------
function decodePng(buf) {
    if (buf.length < 33 || buf.compare(SIG, 0, 8, 0, 8) !== 0) throw new Error('not a PNG');
    let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0; const idat = []; let plte = null, trns = null;
    while (p + 8 <= buf.length) {
        const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
        if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
        else if (type === 'PLTE') plte = d; else if (type === 'tRNS') trns = d; else if (type === 'IDAT') idat.push(d);
        else if (type === 'IEND') break;
        p += 12 + len;
    }
    if (interlace) throw new Error('interlaced PNG frames are not supported');
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
    const bpp = Math.max(1, channels * depth / 8), stride = Math.ceil(w * channels * depth / 8);
    const raw = zlib.inflateSync(Buffer.concat(idat)); const px = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? px[dst + x - Math.ceil(bpp)] : 0, b = y ? px[dst - stride + x] : 0, c = x >= bpp && y ? px[dst - stride + x - Math.ceil(bpp)] : 0;
            let v = raw[src + x];
            if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
            px[dst + x] = v & 255;
        }
    }
    const rgba = Buffer.alloc(w * h * 4);
    const sample = function(row, i) { // i-th sample in a row
        if (depth === 8) return px[row * stride + i];
        if (depth === 16) return px[row * stride + i * 2];
        const per = 8 / depth, byte = px[row * stride + Math.floor(i / per)], shift = 8 - depth * ((i % per) + 1);
        return (byte >> shift) & ((1 << depth) - 1);
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4; let r, g, b, a = 255;
        if (ctype === 6) { r = sample(y, x * 4); g = sample(y, x * 4 + 1); b = sample(y, x * 4 + 2); a = sample(y, x * 4 + 3); }
        else if (ctype === 2) { r = sample(y, x * 3); g = sample(y, x * 3 + 1); b = sample(y, x * 3 + 2); }
        else if (ctype === 0) { const s = sample(y, x), v = depth < 8 ? Math.round(s * 255 / ((1 << depth) - 1)) : s; r = g = b = v; }
        else if (ctype === 4) { r = g = b = sample(y, x * 2); a = sample(y, x * 2 + 1); }
        else { const i = sample(y, x); r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2]; a = trns && i < trns.length ? trns[i] : 255; }
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
    return { rgba, w, h };
}

// ---------- ICO / CUR frame -> RGBA ----------
function decodeIcoFrame(buf) {
    if (buf.length < 22) throw new Error('icon frame too short');
    const type = buf.readUInt16LE(2), count = buf.readUInt16LE(4);
    if ((type !== 1 && type !== 2) || count < 1) throw new Error('frame is not an icon/cursor');
    // choose the largest image in the frame
    let best = null;
    for (let i = 0; i < count; i++) {
        const e = 6 + i * 16; if (e + 16 > buf.length) break;
        const w = buf[e] || 256, h = buf[e + 1] || 256, size = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
        if (!best || w * h > best.w * best.h) best = { w, h, size, off };
    }
    const img = buf.subarray(best.off, best.off + best.size);
    if (img.length >= 8 && img.compare(SIG, 0, 8, 0, 8) === 0) return decodePng(img);
    return decodeDib(img);
}
function decodeDib(d) {
    const hdr = d.readUInt32LE(0);
    if (hdr < 40) throw new Error('unsupported bitmap header');
    const w = d.readInt32LE(4); let h2 = d.readInt32LE(8); const planes = d.readUInt16LE(12), bits = d.readUInt16LE(14), comp = d.readUInt32LE(16);
    let used = d.readUInt32LE(32);
    if (comp !== 0 && comp !== 3) throw new Error('compressed bitmap frames are not supported');
    const h = Math.abs(h2) / 2, topDown = h2 < 0;
    const palCount = bits <= 8 ? (used || (1 << bits)) : 0;
    let p = hdr + (comp === 3 && hdr === 40 ? 12 : 0);
    const pal = []; for (let i = 0; i < palCount; i++) { pal.push([d[p + i * 4 + 2], d[p + i * 4 + 1], d[p + i * 4]]); }
    p += palCount * 4;
    const xorStride = Math.ceil(w * bits / 32) * 4, andStride = Math.ceil(w / 32) * 4;
    const andOff = p + xorStride * h;
    if (andOff > d.length) throw new Error('the file is damaged (a frame is cut short)');
    const rgba = Buffer.alloc(w * h * 4); let anyAlpha = false;
    for (let y = 0; y < h; y++) {
        const sy = topDown ? y : h - 1 - y, row = p + sy * xorStride;
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4; let r, g, b, a = 255;
            if (bits === 32) { b = d[row + x * 4]; g = d[row + x * 4 + 1]; r = d[row + x * 4 + 2]; a = d[row + x * 4 + 3]; if (a) anyAlpha = true; }
            else if (bits === 24) { b = d[row + x * 3]; g = d[row + x * 3 + 1]; r = d[row + x * 3 + 2]; }
            else if (bits === 8) { const c = pal[d[row + x]] || [0, 0, 0]; r = c[0]; g = c[1]; b = c[2]; }
            else if (bits === 4) { const v = d[row + (x >> 1)]; const c = pal[(x & 1) ? v & 15 : v >> 4] || [0, 0, 0]; r = c[0]; g = c[1]; b = c[2]; }
            else if (bits === 1) { const v = (d[row + (x >> 3)] >> (7 - (x & 7))) & 1; const c = pal[v] || [0, 0, 0]; r = c[0]; g = c[1]; b = c[2]; }
            else throw new Error(bits + '-bit frames are not supported');
            rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
        }
    }
    // transparency: use the AND mask unless the 32-bit image already carries alpha
    if (!(bits === 32 && anyAlpha)) {
        for (let y = 0; y < h; y++) {
            const sy = topDown ? y : h - 1 - y, row = andOff + sy * andStride;
            for (let x = 0; x < w; x++) {
                const masked = row + (x >> 3) < d.length ? (d[row + (x >> 3)] >> (7 - (x & 7))) & 1 : 0;
                const o = (y * w + x) * 4;
                rgba[o + 3] = masked ? 0 : 255;
                if (bits === 32 && !masked) rgba[o + 3] = 255;
            }
        }
    }
    return { rgba, w, h };
}

// ---------- .ani ----------
function convertAni(buf) {
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'ACON') throw new Error('not a Windows animated cursor (.ani)');
    let nFrames = 0, nSteps = 0, jif = 6, flags = 1; const rates = []; const seq = []; const icons = [];
    function walk(start, end) {
        let p = start;
        while (p + 8 <= end) {
            const id = buf.toString('latin1', p, p + 4); const size = buf.readUInt32LE(p + 4); const data = p + 8;
            if (id === 'LIST') { if (buf.toString('latin1', data, data + 4) === 'fram') walk(data + 4, Math.min(end, data + size)); }
            else if (id === 'anih') { nFrames = buf.readUInt32LE(data + 4); nSteps = buf.readUInt32LE(data + 8); jif = buf.readUInt32LE(data + 28); flags = buf.readUInt32LE(data + 32); }
            else if (id === 'rate') { for (let i = 0; i + 4 <= size; i += 4) rates.push(buf.readUInt32LE(data + i)); }
            else if (id === 'seq ') { for (let i = 0; i + 4 <= size; i += 4) seq.push(buf.readUInt32LE(data + i)); }
            else if (id === 'icon') {
                if (data + size > buf.length) throw new Error('the file is damaged (cut short)');
                icons.push(buf.subarray(data, data + size));
            }
            p = data + size + (size & 1);
        }
    }
    if (8 + buf.readUInt32LE(4) > buf.length + 1) throw new Error('the file is damaged (cut short)');
    walk(12, Math.min(buf.length, 8 + buf.readUInt32LE(4)));
    if (!icons.length) throw new Error('no frames found in the .ani file');
    if (nFrames && icons.length < nFrames) throw new Error('the file is damaged (' + icons.length + ' of ' + nFrames + ' frames present)');
    const decoded = icons.map(function(b) { return decodeIcoFrame(b); });
    const steps = nSteps || decoded.length;
    const frames = []; let w = 0, h = 0;
    for (let s = 0; s < steps; s++) {
        const idx = seq.length ? seq[s] : s;
        const f = decoded[idx];
        if (!f) throw new Error('the file is damaged (a step points to a missing frame)');
        const jifs = rates.length ? rates[s] : jif;
        frames.push({ rgba: f.rgba, w: f.w, h: f.h, delayMs: (jifs || jif || 6) * 1000 / 60 });
        w = Math.max(w, f.w); h = Math.max(h, f.h);
    }
    return { png: encodeApng(frames, w, h), frames: frames.length, w, h };
}

module.exports = { convertAni, encodePng, encodeApng };
