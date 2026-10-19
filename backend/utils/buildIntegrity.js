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

// Versão do build que este servidor serve (sourceHash de web/dist/build-meta.json). Vai
// no cabeçalho X-IClass-Build de toda resposta da API: o navegador compara com a versão
// gravada no bundle dele e, se for outra (o IClass foi atualizado com a página aberta),
// recarrega sozinho. O arquivo é relido quando muda (o build pode ser refeito com o
// servidor ligado), assim o servidor nunca anuncia uma versão que não está servindo.
const BUILD_ID_HEADER = 'X-IClass-Build';
const BUILD_ID_RECHECK_MS = 2000;
let buildIdCache = { checkedAt: 0, mtimeMs: null, id: null };

function currentBuildId(now = Date.now()) {
    if (buildIdCache.checkedAt && now - buildIdCache.checkedAt < BUILD_ID_RECHECK_MS) return buildIdCache.id;
    buildIdCache.checkedAt = now;
    const metaPath = path.join(runtimePaths.WEB_DIST_DIR, 'build-meta.json');
    try {
        const { mtimeMs } = fs.statSync(metaPath);
        if (mtimeMs !== buildIdCache.mtimeMs) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            buildIdCache.mtimeMs = mtimeMs;
            buildIdCache.id = typeof meta.sourceHash === 'string' && /^[0-9a-f]{16,128}$/.test(meta.sourceHash) ? meta.sourceHash : null;
        }
    } catch (error) {
        buildIdCache.mtimeMs = null;
        buildIdCache.id = null;
    }
    return buildIdCache.id;
}

function resetBuildIdCache() {
    buildIdCache = { checkedAt: 0, mtimeMs: null, id: null };
}

module.exports = { BUILD_ID_HEADER, computeSourceHash, currentBuildId, resetBuildIdCache, verifyBuild };
