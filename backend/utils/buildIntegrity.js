const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtimePaths.js');

function sourceFiles() {
    const webRoot = path.join(runtimePaths.PROJECT_ROOT, 'web');
    const files = [];
    function walk(directory) {
        fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else files.push(full);
        });
    }
    walk(path.join(webRoot, 'src'));
    ['package.json', 'package-lock.json', 'vite.config.js'].forEach(name => {
        const full = path.join(webRoot, name);
        if (fs.existsSync(full)) files.push(full);
    });
    return files.sort();
}

function computeSourceHash() {
    const hash = crypto.createHash('sha256');
    sourceFiles().forEach(file => {
        hash.update(path.relative(runtimePaths.PROJECT_ROOT, file).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
    });
    return hash.digest('hex');
}

function verifyBuild() {
    const metaPath = path.join(runtimePaths.WEB_DIST_DIR, 'build-meta.json');
    if (!fs.existsSync(path.join(runtimePaths.WEB_DIST_DIR, 'index.html')) || !fs.existsSync(metaPath)) {
        throw new Error('Build do frontend ausente. Execute npm run build antes de iniciar o servidor.');
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const currentHash = computeSourceHash();
    if (meta.sourceHash !== currentHash) throw new Error('Build do frontend desatualizado. Execute npm run build novamente.');
    return meta;
}

module.exports = { computeSourceHash, verifyBuild };
