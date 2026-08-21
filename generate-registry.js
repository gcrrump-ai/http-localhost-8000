// ============================================================
// generateRegistry.js - Run this when you add/remove images!
// ============================================================

const fs = require('fs');
const path = require('path');

const collectionsDir = './collections';

// ============================================================
// SCAN FOR IMAGES
// ============================================================
const folders = fs.readdirSync(collectionsDir).filter(f => 
    fs.statSync(path.join(collectionsDir, f)).isDirectory()
);

const imagePaths = [];

folders.forEach(folder => {
    const folderPath = path.join(collectionsDir, folder);
    const files = fs.readdirSync(folderPath)
        .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
        .map(f => `collections/${folder}/${f}`);
    imagePaths.push(...files);
});

// ============================================================
// PRESERVE EXISTING DESCRIPTIONS
// ============================================================
let existingDescriptions = {};
try {
    if (fs.existsSync('registry.js')) {
        const existing = fs.readFileSync('registry.js', 'utf8');
        const match = existing.match(/const CUSTOM_DESCRIPTIONS = ({[\s\S]*?});/);
        if (match) {
            eval('existingDescriptions = ' + match[1]);
            console.log('✅ Preserved existing descriptions');
        }
    }
} catch (e) {
    console.log('ℹ️ No existing registry found');
}

// ============================================================
// GENERATE DESCRIPTIONS (keep existing, use placeholder for new)
// ============================================================
const descriptions = {};
imagePaths.forEach(path => {
    descriptions[path] = existingDescriptions[path] || "Image description";
});

// ============================================================
// WRITE registry.js
// ============================================================
const output = `// ============================================================
// MASTER_IMAGE_REGISTRY - Auto-generated
// ============================================================
const MASTER_IMAGE_REGISTRY = ${JSON.stringify(imagePaths, null, 4)};

// ============================================================
// CUSTOM DESCRIPTIONS - Edit the text inside the quotes!
// ============================================================
const CUSTOM_DESCRIPTIONS = ${JSON.stringify(descriptions, null, 4)};

// ============================================================
// GET DESCRIPTION FUNCTION
// ============================================================
function getImageDescription(path) {
    if (CUSTOM_DESCRIPTIONS[path]) {
        return CUSTOM_DESCRIPTIONS[path];
    }
    const filename = path.split('/').pop();
    const name = filename.replace(/\\.[^/.]+$/, '');
    return name.replace(/[-_]/g, ' ').replace(/\\b\\w/g, l => l.toUpperCase());
}`;

fs.writeFileSync('registry.js', output);
console.log(`✅ registry.js generated with ${imagePaths.length} images.`);
console.log('ℹ️ Edit descriptions in CUSTOM_DESCRIPTIONS inside registry.js');