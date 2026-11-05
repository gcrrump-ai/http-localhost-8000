#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STRIP_DIR = path.join(ROOT, 'imgStrip');
const OUTPUT_FILE = path.join(ROOT, 'imgStrip.js');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico']);

function buildRegistry() {
    fs.mkdirSync(STRIP_DIR, { recursive: true });

    const files = fs.readdirSync(STRIP_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .filter(name => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .map(name => ({
            name,
            added: (() => {
                const stat = fs.statSync(path.join(STRIP_DIR, name));
                return stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
            })()
        }))
        .sort((a, b) => b.added - a.added || b.name.localeCompare(a.name));

    const paths = files.map(file => 'imgStrip/' + file.name.split(path.sep).map(encodeURIComponent).join('/'));
    const output = 'window.IMG_STRIP_REGISTRY = ' + JSON.stringify(paths, null, 4) + ';\n';
    fs.writeFileSync(OUTPUT_FILE, output, 'utf8');

    console.log('Updated imgStrip.js with ' + paths.length + ' image(s).');
    if (paths.length) console.log('Newest image: ' + files[0].name);
}

buildRegistry();

if (process.argv.includes('--watch')) {
    console.log('Watching imgStrip/ for added, changed or removed images. Press Ctrl+C to stop.');
    let timer = null;
    fs.watch(STRIP_DIR, { persistent: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            try { buildRegistry(); }
            catch (error) { console.error('Could not update image strip:', error.message); }
        }, 250);
    }).on('error', error => {
        console.error('Folder watch stopped:', error.message);
        process.exitCode = 1;
    });
}
