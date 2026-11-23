const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtimePaths.js');

// Arquivos do backend que o web/vite.config.js usa para montar o build: mudam o que o
// build grava, então entram no hash como as fontes da interface. Os nomes de /assets saem
// de toServableAssetName (utils/staticAssets.js), a mesma regra com que o servidor entrega;
// com a regra trocada e o build antigo, um arquivo do build poderia dar 404. O próprio
// buildIntegrity.js fica de fora: mudar o cálculo já muda o hash.
const BACKEND_BUILD_FILES = ['backend/utils/staticAssets.js'];
// Arquivos da raiz que o bundle leva (fase 3, A1 / P6-S2): as Novidades da tela Sistema e
// da Ajuda são o CHANGELOG.md, importado com ?raw. Mudar o texto sem refazer o build
// deixaria a tela com as Novidades de antes.
const ROOT_BUILD_FILES = ['CHANGELOG.md'];

// Versão do IClass (SemVer do package.json da raiz, a fonte única, D7 do P6). Só o campo
// version entra no hash (o bundle mostra a versão por __ICLASS_VERSION__, vite.config.js):
// trocar a versão sem refazer o build deixaria a barra lateral com a versão de antes. O
// resto do package.json da raiz (scripts, dependências do servidor) não muda o build.
// Lido a cada chamada, da pasta do programa de agora (os testes trocam PROJECT_ROOT).
function appVersion(root = runtimePaths.PROJECT_ROOT) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version.trim() : '';
    } catch (err) {
        return '';
    }
}

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
    [...BACKEND_BUILD_FILES, ...ROOT_BUILD_FILES].forEach(name => {
        const full = path.join(runtimePaths.PROJECT_ROOT, ...name.split('/'));
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
    hash.update('package.json#version');
    hash.update('\0');
    hash.update(appVersion());
    hash.update('\0');
    return hash.digest('hex');
}

// O código diz ao boot (server.js) qual falha foi: build ausente ou desatualizado (saída 2,
// configuração; H3c), arquivos do pacote alterados ou pasta sem a interface (A15).
function buildError(code, message, details) {
    const err = new Error(message);
    err.code = code;
    if (details) err.details = details;
    return err;
}

// Pacote de release (fase 3, A15 / P6-S3, D14 do P6). O pacote não leva o código-fonte da
// interface (web/src): leva o web/dist já compilado e, na raiz, o release-manifest.json
// com a versão e o SHA-256 de cada arquivo. Na pasta do git (desenvolvimento e o Alan
// hoje), web/src existe e vale o sourceHash de sempre.
const RELEASE_MANIFEST_FILE = 'release-manifest.json';
const RELEASE_MANIFEST_FORMAT = 1;
const RELEASE_TAMPERED_TEXT = 'Os arquivos da interface estão incompletos ou foram alterados. Reinstale esta versão do IClass.';

function interfaceSourceDir(root = runtimePaths.PROJECT_ROOT) {
    return path.join(root, 'web', 'src');
}

// 'desenvolvimento' com web/src (mesmo que um release-manifest.json tenha sobrado na
// pasta); 'pacote' sem web/src e com o manifesto; sem nenhum dos dois, 'desenvolvimento'
// (o verifyBuild recusa a pasta com ICLASS_BUILD_NO_SOURCE).
function buildMode(root = runtimePaths.PROJECT_ROOT) {
    if (fs.existsSync(interfaceSourceDir(root))) return 'desenvolvimento';
    return fs.existsSync(path.join(root, RELEASE_MANIFEST_FILE)) ? 'pacote' : 'desenvolvimento';
}

function sha256OfFile(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Caminho do manifesto ("web/dist/assets/x.js"): relativo, com /, sem "..", sem letra de
// unidade e sem barra invertida. Outro formato não é lido (nunca sai da pasta do programa).
function safeManifestPath(relative) {
    if (typeof relative !== 'string' || !relative || relative.length > 400) return false;
    if (relative.includes('\\') || relative.includes('\0') || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return false;
    return relative.split('/').every(part => part && part !== '.' && part !== '..');
}

function readReleaseManifest(root = runtimePaths.PROJECT_ROOT) {
    const file = path.join(root, RELEASE_MANIFEST_FILE);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw buildError('ICLASS_BUILD_TAMPERED', `${RELEASE_TAMPERED_TEXT} (O ${RELEASE_MANIFEST_FILE} está ilegível.)`, { manifesto: 'ilegivel' });
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
        || !manifest.arquivos || typeof manifest.arquivos !== 'object' || Array.isArray(manifest.arquivos)) {
        throw buildError('ICLASS_BUILD_TAMPERED', `${RELEASE_TAMPERED_TEXT} (O ${RELEASE_MANIFEST_FILE} não tem a lista de arquivos.)`, { manifesto: 'invalido' });
    }
    if (Number(manifest.formato) > RELEASE_MANIFEST_FORMAT) {
        throw buildError('ICLASS_BUILD_TAMPERED', `${RELEASE_TAMPERED_TEXT} (O ${RELEASE_MANIFEST_FILE} é de um formato mais novo que este programa.)`, { manifesto: 'formato' });
    }
    return manifest;
}

// Confere o web/dist do pacote pelo manifesto: a versão do manifesto é a do package.json
// (pasta com partes de duas versões é recusada) e cada arquivo de web/dist listado existe
// com o mesmo SHA-256. Só no boot (uns 300 arquivos, 3 MB). Arquivo a mais em web/dist
// não conta (o Windows pode criar desktop.ini ou Thumbs.db), mas o index.html e o
// build-meta.json precisam estar no manifesto: o que o navegador carrega sai dele.
// `root` e `distDir` vêm de fora no montar-pacote.js (confere o pacote que acabou de montar);
// no boot são a pasta do programa e o runtimePaths.WEB_DIST_DIR.
function verifyReleaseBuild(root = runtimePaths.PROJECT_ROOT, distDir = root === runtimePaths.PROJECT_ROOT ? runtimePaths.WEB_DIST_DIR : path.join(root, 'web', 'dist')) {
    const manifest = readReleaseManifest(root);
    const version = appVersion(root);
    if (typeof manifest.versao !== 'string' || manifest.versao !== version) {
        throw buildError(
            'ICLASS_BUILD_TAMPERED',
            `${RELEASE_TAMPERED_TEXT} (Esta pasta mistura versões: o programa é a ${version || 'desconhecida'} e a interface, a ${typeof manifest.versao === 'string' && manifest.versao ? manifest.versao : 'desconhecida'}.)`,
            { versaoPrograma: version, versaoManifesto: manifest.versao },
        );
    }
    const distRelative = path.relative(root, distDir).split(path.sep).join('/');
    const prefix = `${distRelative}/`;
    const entries = Object.entries(manifest.arquivos).filter(([relative]) => typeof relative === 'string' && relative.startsWith(prefix));
    const missing = [];
    const changed = [];
    const required = [`${prefix}index.html`, `${prefix}build-meta.json`];
    required.forEach(relative => {
        if (!Object.prototype.hasOwnProperty.call(manifest.arquivos, relative)) missing.push(relative);
    });
    entries.forEach(([relative, expected]) => {
        if (!safeManifestPath(relative) || typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
            changed.push(relative);
            return;
        }
        const full = path.join(root, ...relative.split('/'));
        let actual;
        try {
            actual = sha256OfFile(full);
        } catch (err) {
            missing.push(relative);
            return;
        }
        if (actual !== expected) changed.push(relative);
    });
    if (missing.length || changed.length) {
        throw buildError('ICLASS_BUILD_TAMPERED', RELEASE_TAMPERED_TEXT, { faltando: missing, alterados: changed });
    }
    const metaPath = path.join(distDir, 'build-meta.json');
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (err) {
        throw buildError('ICLASS_BUILD_TAMPERED', RELEASE_TAMPERED_TEXT, { faltando: [], alterados: [`${prefix}build-meta.json`] });
    }
}

function verifyBuild() {
    const root = runtimePaths.PROJECT_ROOT;
    if (!fs.existsSync(interfaceSourceDir(root))) {
        if (fs.existsSync(path.join(root, RELEASE_MANIFEST_FILE))) return verifyReleaseBuild(root);
        // Antes: o readdirSync de web/src lançava ENOENT e o boot saía com uma mensagem
        // crua ("ENOENT: no such file or directory, scandir .../web/src").
        throw buildError('ICLASS_BUILD_NO_SOURCE', 'Esta pasta não tem o código da interface (web/src) nem o release-manifest.json do pacote.');
    }
    const metaPath = path.join(runtimePaths.WEB_DIST_DIR, 'build-meta.json');
    if (!fs.existsSync(path.join(runtimePaths.WEB_DIST_DIR, 'index.html')) || !fs.existsSync(metaPath)) {
        throw buildError('ICLASS_BUILD_MISSING', 'Build do frontend ausente. Execute npm run build antes de iniciar o servidor.');
    }
    let meta;
    try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (err) {
        throw buildError('ICLASS_BUILD_MISSING', 'Build do frontend ilegível (web/dist/build-meta.json). Execute npm run build novamente.');
    }
    const currentHash = computeSourceHash();
    if (meta.sourceHash !== currentHash) throw buildError('ICLASS_BUILD_OUTDATED', 'Build do frontend desatualizado. Execute npm run build novamente.');
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

module.exports = {
    BACKEND_BUILD_FILES,
    BUILD_ID_HEADER,
    RELEASE_MANIFEST_FILE,
    RELEASE_MANIFEST_FORMAT,
    RELEASE_TAMPERED_TEXT,
    ROOT_BUILD_FILES,
    appVersion,
    buildMode,
    computeSourceHash,
    currentBuildId,
    readReleaseManifest,
    resetBuildIdCache,
    safeManifestPath,
    verifyBuild,
    verifyReleaseBuild,
};
