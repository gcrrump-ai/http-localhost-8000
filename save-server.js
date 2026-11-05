const http = require('http');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'index.html');
const PORT = 8001;

http.createServer(function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'POST' && req.url === '/save') {
        let body = '';
        req.on('data', function (c) { body += c; });
        req.on('end', function () {
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                console.log('Saved');
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: String(e) }));
                console.error(e);
            }
        });
        return;
    }
    res.writeHead(404); res.end();
}).listen(PORT, function () {
    console.log('Save server on http://localhost:' + PORT);
});