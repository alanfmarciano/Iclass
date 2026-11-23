#!/usr/bin/env node
// Monta o pacote de release do IClass (fase 3, A15 / P6-S3; OPS-01, OPS-21, ENG-10; D8, D9 e
// D14 do P6). Uso:
//   node scripts/release/montar-pacote.js [--plataforma win32-x64|linux-x64]
//        [--saida <pasta>] [--cache <pasta>] [--ref <commit> | --arvore] [--offline]
//        [--so-baixar] [--manter-trabalho]
// Sem pacote npm novo e sem compilar nada: o pacote sai da nuvem (Linux) também para o
// Windows. Passos:
//  1. cópia limpa do código: `git archive <ref>` (padrão HEAD) ou, com --arvore, os arquivos
//     da árvore de trabalho que o git conhece (para testar antes do commit);
//  2. npm ci e build da interface nessa cópia (o bundle e o build-meta.json);
//  3. pasta do pacote com backend/, web/dist/, package.json, package-lock.json, CHANGELOG.md
//     e LICENSE.txt; sem web/src, sem testes, sem content/ (o conteúdo do autor não vai,
//     D25) e sem os mockups;
//  4. `npm ci --omit=dev --omit=optional --ignore-scripts` na pasta do pacote: só as
//     dependências de produção, sem node-gyp (e sem a cadeia das 5 altas do test:audit);
//  5. o binário do sqlite3 da plataforma alvo e o Node portátil, baixados uma vez para o
//     cache e conferidos pelo SHA-256 de scripts/release/binarios.json (o do Node também
//     pelo SHASUMS256.txt do nodejs.org); um .node que não esteja em binarios.json para
//     tudo (contrato C3);
//  6. THIRD_PARTY_NOTICES.txt (scripts/release/licencas.js), "Guia de instalação.html"
//     (do instalacao-e-rede.md da ajuda) e o que houver em scripts/release/modelos/
//     (IClass.cmd e o instalador, das subetapas seguintes);
//  7. release-manifest.json (versão, commit, data, Node, plataforma e o SHA-256 de cada
//     arquivo), que o servidor confere no boot (backend/utils/buildIntegrity.js);
//  8. IClass-<versão>-windows-x64.zip (ou -linux-x64.zip, só para testar na nuvem), com o
//     .sha256 ao lado.
// --offline: não baixa nada (o cache precisa estar completo) e o npm só usa o cache dele.
// --so-baixar: só baixa e confere os binários da plataforma (ou de todas, com
// --plataforma todas) para o cache, sem montar.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const arquivos = require('./arquivos.js');
const licencas = require('./licencas.js');
const buildIntegrity = require('../../backend/utils/buildIntegrity.js');

const ROOT = path.resolve(__dirname, '..', '..');
const BINARIES_FILE = path.join(__dirname, 'binarios.json');
const DEFAULT_CACHE = path.join(__dirname, '.cache');
const DEFAULT_OUTPUT = path.join(ROOT, 'pacotes');
const MANIFEST_FILE = buildIntegrity.RELEASE_MANIFEST_FILE;
const MANIFEST_FORMAT = buildIntegrity.RELEASE_MANIFEST_FORMAT;
const PLATFORMS = Object.freeze({
    'win32-x64': { zipSuffix: 'windows-x64', nome: 'Windows 64 bits' },
    'linux-x64': { zipSuffix: 'linux-x64', nome: 'Linux 64 bits (só para testar o pacote na nuvem)' },
});
// O que vai da raiz da cópia para o pacote (além de backend/ e web/dist/).
const ROOT_FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'LICENSE.txt'];
const GUIDE_SOURCE = 'web/src/features/help/conteudo/instalacao-e-rede.md';
const GUIDE_FILE = 'Guia de instalação.html';
const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';
const MODELS_DIR = 'scripts/release/modelos';

class ReleaseError extends Error {}

function say(text) {
    process.stdout.write(`${text}\n`);
}

function parseArgs(argv) {
    const options = { plataforma: 'win32-x64', saida: DEFAULT_OUTPUT, cache: process.env.ICLASS_RELEASE_CACHE || DEFAULT_CACHE, ref: 'HEAD', arvore: false, offline: false, soBaixar: false, manterTrabalho: false };
    const value = (i, name) => {
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new ReleaseError(`A opção ${name} precisa de um valor.`);
        return argv[i + 1];
    };
    const withValue = { '--plataforma': 'plataforma', '--saida': 'saida', '--cache': 'cache', '--ref': 'ref' };
    const flags = { '--arvore': 'arvore', '--offline': 'offline', '--so-baixar': 'soBaixar', '--manter-trabalho': 'manterTrabalho', '--ajuda': 'ajuda', '-h': 'ajuda' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (withValue[arg]) {
            const key = withValue[arg];
            options[key] = key === 'saida' || key === 'cache' ? path.resolve(value(i, arg)) : value(i, arg);
            i += 1;
        } else if (flags[arg]) {
            options[flags[arg]] = true;
        } else {
            throw new ReleaseError(`Opção desconhecida: ${arg}`);
        }
    }
    const valid = options.soBaixar ? [...Object.keys(PLATFORMS), 'todas'] : Object.keys(PLATFORMS);
    if (!valid.includes(options.plataforma)) throw new ReleaseError(`Plataforma desconhecida: ${options.plataforma} (use ${valid.join(', ')}).`);
    if (!/^[\w./~^@{}-]+$/.test(options.ref)) throw new ReleaseError(`Referência do git inválida: ${options.ref}`);
    return options;
}

function readBinaries(file = BINARIES_FILE) {
    const binaries = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!binaries.node || !binaries.node.plataformas || !binaries.addons) throw new ReleaseError(`${file} sem "node" ou "addons".`);
    return binaries;
}

// Um binário no cache: baixa se faltar (a não ser offline) e confere o SHA-256 fixado.
// Arquivo do cache que não confere é apagado e baixado de novo (download interrompido).
async function ensureCached(entry, cacheDir, { offline = false } = {}) {
    const file = path.join(cacheDir, entry.arquivo);
    if (fs.existsSync(file)) {
        const actual = arquivos.sha256File(file);
        if (actual === entry.sha256) return file;
        if (offline) throw new ReleaseError(`O SHA-256 de ${file} não confere com scripts/release/binarios.json (${actual} em vez de ${entry.sha256}).`);
        fs.rmSync(file, { force: true });
    }
    if (offline) throw new ReleaseError(`Falta ${entry.arquivo} no cache (${cacheDir}). Rode uma vez com rede: node scripts/release/montar-pacote.js --so-baixar --plataforma <plataforma>.`);
    say(`  baixando ${entry.url}`);
    await arquivos.download(entry.url, file);
    const actual = arquivos.sha256File(file);
    if (actual !== entry.sha256) {
        fs.rmSync(file, { force: true });
        throw new ReleaseError(`O SHA-256 de ${entry.arquivo} baixado não confere com scripts/release/binarios.json (${actual} em vez de ${entry.sha256}). Nada foi montado.`);
    }
    return file;
}

// O SHASUMS256.txt do nodejs.org (no cache com o nome da versão) confirma o SHA-256 fixado.
async function ensureNodeShasums(binaries, cacheDir, { offline = false } = {}) {
    const file = path.join(cacheDir, `SHASUMS256-node-v${binaries.node.versao}.txt`);
    if (!fs.existsSync(file)) {
        if (offline) throw new ReleaseError(`Falta o SHASUMS256.txt do Node ${binaries.node.versao} no cache (${cacheDir}).`);
        say(`  baixando ${binaries.node.shasums}`);
        await arquivos.download(binaries.node.shasums, file);
    }
    return arquivos.parseShasums(fs.readFileSync(file, 'utf8'));
}

function checkNodeShasum(entry, sums) {
    if (sums[entry.arquivo] !== entry.sha256) {
        throw new ReleaseError(`O SHA-256 de ${entry.arquivo} em scripts/release/binarios.json não é o do SHASUMS256.txt do nodejs.org (${sums[entry.arquivo] || 'ausente'}).`);
    }
}

async function downloadPlatform(binaries, plataforma, cacheDir, options) {
    const nodeEntry = binaries.node.plataformas[plataforma];
    if (!nodeEntry) throw new ReleaseError(`scripts/release/binarios.json não tem o Node para ${plataforma}.`);
    const sums = await ensureNodeShasums(binaries, cacheDir, options);
    checkNodeShasum(nodeEntry, sums);
    const nodeArchive = await ensureCached(nodeEntry, cacheDir, options);
    const addons = {};
    for (const [name, addon] of Object.entries(binaries.addons)) {
        const entry = addon.plataformas && addon.plataformas[plataforma];
        if (!entry) throw new ReleaseError(`scripts/release/binarios.json não tem o ${name} para ${plataforma}.`);
        addons[name] = await ensureCached(entry, cacheDir, options);
    }
    return { nodeEntry, nodeArchive, addons };
}

function run(command, args, { cwd, env = process.env } = {}) {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' && /\.cmd$/i.test(command) });
    if (result.error) throw new ReleaseError(`Não foi possível rodar ${command}: ${result.error.message}`);
    if (result.status !== 0) throw new ReleaseError(`${command} ${args.join(' ')} saiu com ${result.status} (em ${cwd}).`);
}

// npm: o mesmo que chamou este script (npm run release) ou o do PATH.
function npm(args, cwd, { offline = false } = {}) {
    const flags = [...args, '--no-audit', '--no-fund', offline ? '--offline' : '--prefer-offline'];
    const env = { ...process.env };
    // Variáveis de pasta do IClass do ambiente de quem monta não podem vazar para o build.
    ['ICLASS_DATA_DIR', 'ICLASS_CONTENT_DIR', 'ICLASS_ARCHIVE_DIR', 'NODE_ENV'].forEach(name => { delete env[name]; });
    const npmCli = process.env.npm_execpath;
    if (npmCli && /npm-cli\.js$/.test(npmCli)) return run(process.execPath, [npmCli, ...flags], { cwd, env });
    return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', flags, { cwd, env });
}

function git(args, { encoding = 'utf8' } = {}) {
    const result = spawnSync('git', ['-C', ROOT, ...args], { encoding, maxBuffer: 512 * 1024 * 1024 });
    if (result.error) throw new ReleaseError(`Não foi possível rodar o git: ${result.error.message}`);
    if (result.status !== 0) throw new ReleaseError(`git ${args.join(' ')} falhou: ${String(result.stderr || '').trim()}`);
    return result.stdout;
}

// Cópia limpa do código em `dir`. Devolve o commit (com "+alterações" na árvore de trabalho
// com mudança que ainda não foi para o git).
function prepareSource(dir, { ref = 'HEAD', arvore = false } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const head = git(['rev-parse', arvore ? 'HEAD' : `${ref}^{commit}`]).trim();
    const dirty = git(['status', '--porcelain']).trim() !== '';
    if (arvore) {
        const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
        listed.forEach(relative => {
            const source = path.join(ROOT, relative);
            let stat;
            try { stat = fs.lstatSync(source); } catch (e) { return; }
            if (!stat.isFile()) return;
            const target = path.join(dir, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target);
        });
        return { commit: dirty ? `${head}+alterações` : head };
    }
    if (dirty && ref === 'HEAD') say('  aviso: há alterações fora do git; o pacote usa o último commit, sem elas (use --arvore para incluí-las).');
    const tar = git(['archive', '--format=tar', head], { encoding: 'buffer' });
    arquivos.readTar(tar).forEach(entry => {
        const target = path.join(dir, ...entry.name.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.data);
    });
    return { commit: head };
}

function buildInterface(srcDir, { offline = false } = {}) {
    const webDir = path.join(srcDir, 'web');
    say('  npm ci da interface');
    npm(['ci'], webDir, { offline });
    say('  build da interface');
    npm(['run', 'build'], webDir, { offline });
    if (!fs.existsSync(path.join(webDir, 'dist', 'index.html')) || !fs.existsSync(path.join(webDir, 'dist', 'build-meta.json'))) {
        throw new ReleaseError('O build da interface não gerou web/dist/index.html e web/dist/build-meta.json.');
    }
}

function assemblePackage(srcDir, pkgDir) {
    fs.mkdirSync(pkgDir, { recursive: true });
    arquivos.copyDirectory(path.join(srcDir, 'backend'), path.join(pkgDir, 'backend'));
    arquivos.copyDirectory(path.join(srcDir, 'web', 'dist'), path.join(pkgDir, 'web', 'dist'));
    ROOT_FILES.forEach(name => {
        const source = path.join(srcDir, name);
        if (!fs.existsSync(source)) throw new ReleaseError(`Falta ${name} no código.`);
        fs.copyFileSync(source, path.join(pkgDir, name));
    });
    const models = path.join(srcDir, ...MODELS_DIR.split('/'));
    if (fs.existsSync(models)) arquivos.copyDirectory(models, pkgDir);
}

function installProduction(pkgDir, { offline = false } = {}) {
    say('  npm ci só com as dependências de produção');
    npm(['ci', '--omit=dev', '--omit=optional', '--ignore-scripts'], pkgDir, { offline });
}

function placeAddons(pkgDir, binaries, plataforma, addonArchives) {
    Object.entries(binaries.addons).forEach(([name, addon]) => {
        const entry = addon.plataformas[plataforma];
        const [found] = arquivos.readTarGz(addonArchives[name], { wanted: new Set([entry.entrada]) });
        if (!found) throw new ReleaseError(`${entry.arquivo} não tem ${entry.entrada}.`);
        if (arquivos.sha256Buffer(found.data) !== entry.binarioSha256) {
            throw new ReleaseError(`O SHA-256 de ${entry.entrada} de ${entry.arquivo} não confere com scripts/release/binarios.json.`);
        }
        const target = path.join(pkgDir, ...addon.binario.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, found.data, { mode: 0o755 });
    });
}

// Node portátil em node/ e o texto da licença dele (vai para os avisos e para node/LICENSE).
function placeNode(pkgDir, nodeEntry, archive) {
    const wanted = new Set([nodeEntry.executavel, nodeEntry.licenca]);
    let entries;
    if (/\.zip$/i.test(archive)) {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(archive);
        entries = [...wanted].map(name => {
            const item = zip.getEntry(name);
            return item ? { name, data: item.getData() } : null;
        }).filter(Boolean);
    } else {
        entries = arquivos.readTarGz(archive, { wanted });
    }
    const executable = entries.find(item => item.name === nodeEntry.executavel);
    const license = entries.find(item => item.name === nodeEntry.licenca);
    if (!executable || !license) throw new ReleaseError(`${nodeEntry.arquivo} não tem ${nodeEntry.executavel} e ${nodeEntry.licenca}.`);
    if (arquivos.sha256Buffer(executable.data) !== nodeEntry.executavelSha256) {
        throw new ReleaseError(`O SHA-256 de ${nodeEntry.executavel} não confere com scripts/release/binarios.json.`);
    }
    const target = path.join(pkgDir, ...nodeEntry.destino.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, executable.data, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    fs.writeFileSync(path.join(path.dirname(target), 'LICENSE'), license.data);
    return license.data.toString('utf8');
}

// Conferências do pacote montado (OPS-01, C3): sem o código da interface, sem pacote de
// desenvolvimento nem opcional (node-gyp), e todo .node é um dos de binarios.json com o
// SHA-256 fixado para a plataforma.
function checkPackage(pkgDir, { binaries, plataforma, lockFile = path.join(pkgDir, 'package-lock.json') }) {
    const problems = [];
    if (fs.existsSync(path.join(pkgDir, 'web', 'src'))) problems.push('o pacote tem web/src (o código da interface não vai para a escola)');
    ['test', 'content', 'docs', 'data'].forEach(name => {
        if (fs.existsSync(path.join(pkgDir, name))) problems.push(`o pacote tem a pasta ${name}/`);
    });
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    Object.entries(lock.packages || {}).forEach(([key, info]) => {
        if (!key || !info || !(info.dev || info.devOptional || info.optional)) return;
        if (fs.existsSync(path.join(pkgDir, ...key.split('/')))) problems.push(`o pacote tem ${key}, que é de desenvolvimento ou opcional`);
    });
    if (fs.existsSync(path.join(pkgDir, 'node_modules', 'node-gyp'))) problems.push('o pacote tem node_modules/node-gyp');
    const allowed = new Map(Object.values(binaries.addons).map(addon => [addon.binario, addon.plataformas[plataforma] && addon.plataformas[plataforma].binarioSha256]));
    arquivos.listFiles(pkgDir).filter(relative => /\.node$/i.test(relative)).forEach(relative => {
        if (!allowed.has(relative)) {
            problems.push(`${relative} é um módulo nativo que não está em scripts/release/binarios.json (contrato C3)`);
            return;
        }
        if (arquivos.sha256File(path.join(pkgDir, ...relative.split('/'))) !== allowed.get(relative)) problems.push(`${relative} não é o binário de ${plataforma} conferido em scripts/release/binarios.json`);
    });
    allowed.forEach((sha, relative) => {
        if (!fs.existsSync(path.join(pkgDir, ...relative.split('/')))) problems.push(`falta ${relative}`);
    });
    if (problems.length) throw new ReleaseError(`O pacote montado não passou na conferência:\n  - ${problems.join('\n  - ')}`);
}

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// "Guia de instalação.html" a partir do guia do técnico da Ajuda (D20): o mesmo texto,
// numa página que abre no navegador sem o IClass ligado. Os comentários do arquivo (as
// instruções para quem escreve) não vão; o {#id} do título vira a âncora.
function renderGuide(markdown, { version, marked }) {
    const body = String(markdown)
        .replace(/<!--[\s\S]*?-->/g, '')
        .split(/\r?\n/)
        .map(line => {
            const match = /^(#{1,6})\s+(.*?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/.exec(line);
            if (!match) return line;
            const level = match[1].length;
            return `<h${level} id="${match[3]}">${marked.parseInline(match[2])}</h${level}>`;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
    const html = marked.parse(body);
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guia de instalação do IClass ${escapeHtml(version)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #1f2937; background: #ffffff; margin: 0; }
  main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  h1 { font-size: 1.8rem; margin-top: 0; } h2 { margin-top: 2.2rem; border-bottom: 1px solid #e5e7eb; padding-bottom: .3rem; }
  code, pre { background: #f3f4f6; border-radius: 4px; } code { padding: .1rem .3rem; } pre { padding: .8rem; overflow-x: auto; }
  table { border-collapse: collapse; display: block; overflow-x: auto; } td, th { border: 1px solid #d1d5db; padding: .3rem .6rem; }
  footer { margin-top: 3rem; font-size: .85rem; color: #6b7280; }
  @media (prefers-color-scheme: dark) { body { background: #111827; color: #e5e7eb; } code, pre { background: #1f2937; } h2 { border-color: #374151; } }
</style>
</head>
<body>
<main>
${html}
<footer>IClass ${escapeHtml(version)}. Este guia também está dentro do IClass, em Ajuda &gt; Instalação e rede.</footer>
</main>
</body>
</html>
`;
}

function writeGuide(pkgDir, srcDir, version) {
    const source = path.join(srcDir, ...GUIDE_SOURCE.split('/'));
    if (!fs.existsSync(source)) throw new ReleaseError(`Falta ${GUIDE_SOURCE} (o texto do Guia de instalação).`);
    const marked = require(path.join(srcDir, 'web', 'node_modules', 'marked', 'lib', 'marked.cjs'));
    fs.writeFileSync(path.join(pkgDir, GUIDE_FILE), renderGuide(fs.readFileSync(source, 'utf8'), { version, marked }));
}

function writeNotices(pkgDir, srcDir, { version, nodeVersion, nodeLicense }) {
    try {
        const { text, packages } = licencas.noticesFor({
            serverDir: pkgDir,
            webDir: path.join(srcDir, 'web'),
            version,
            node: { versao: nodeVersion, texto: nodeLicense },
        });
        fs.writeFileSync(path.join(pkgDir, NOTICES_FILE), text);
        return packages.length;
    } catch (err) {
        throw new ReleaseError(err && err.message ? err.message : String(err));
    }
}

// release-manifest.json: o SHA-256 de cada arquivo do pacote (menos o próprio manifesto).
function writeReleaseManifest(pkgDir, { versao, commit, plataforma, node, geradoEm = new Date().toISOString() }) {
    const files = {};
    arquivos.listFiles(pkgDir).filter(relative => relative !== MANIFEST_FILE).forEach(relative => {
        files[relative] = arquivos.sha256File(path.join(pkgDir, ...relative.split('/')));
    });
    const manifest = { produto: 'IClass', formato: MANIFEST_FORMAT, versao, commit, geradoEm, node, plataforma, arquivos: files };
    fs.writeFileSync(path.join(pkgDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

function zipPackage(pkgDir, zipFile) {
    const archiver = require('archiver');
    fs.mkdirSync(path.dirname(zipFile), { recursive: true });
    const partial = `${zipFile}.parcial`;
    fs.rmSync(partial, { force: true });
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(partial);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => {
            fs.renameSync(partial, zipFile);
            resolve(zipFile);
        });
        archive.on('warning', reject);
        archive.on('error', reject);
        archive.pipe(output);
        arquivos.listFiles(pkgDir).forEach(relative => {
            const full = path.join(pkgDir, ...relative.split('/'));
            const executable = (fs.statSync(full).mode & 0o111) !== 0;
            archive.file(full, { name: relative, mode: executable ? 0o755 : 0o644 });
        });
        archive.finalize();
    });
}

function zipName(version, plataforma) {
    return `IClass-${version}-${PLATFORMS[plataforma].zipSuffix}.zip`;
}

async function build(options) {
    const binaries = readBinaries();
    const platforms = options.soBaixar && options.plataforma === 'todas' ? Object.keys(PLATFORMS) : [options.plataforma];
    if (options.soBaixar) {
        for (const plataforma of platforms) {
            say(`Binários de ${plataforma} no cache (${options.cache}):`);
            await downloadPlatform(binaries, plataforma, options.cache, options);
        }
        say('Pronto: o cache tem os binários conferidos.');
        return null;
    }
    const plataforma = options.plataforma;
    say(`Montando o pacote do IClass para ${PLATFORMS[plataforma].nome}`);
    const downloads = await downloadPlatform(binaries, plataforma, options.cache, options);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-release-'));
    const srcDir = path.join(work, 'codigo');
    const pkgDir = path.join(work, 'pacote');
    try {
        say(options.arvore ? '  cópia da árvore de trabalho' : `  cópia limpa do código (git archive ${options.ref})`);
        const { commit } = prepareSource(srcDir, options);
        const version = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8')).version;
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version || ''))) throw new ReleaseError(`Versão inválida no package.json: ${version}`);
        buildInterface(srcDir, options);
        assemblePackage(srcDir, pkgDir);
        installProduction(pkgDir, options);
        placeAddons(pkgDir, binaries, plataforma, downloads.addons);
        const nodeLicense = placeNode(pkgDir, downloads.nodeEntry, downloads.nodeArchive);
        checkPackage(pkgDir, { binaries, plataforma });
        const count = writeNotices(pkgDir, srcDir, { version, nodeVersion: binaries.node.versao, nodeLicense });
        say(`  avisos de terceiros: ${count} pacotes`);
        writeGuide(pkgDir, srcDir, version);
        const manifest = writeReleaseManifest(pkgDir, { versao: version, commit, plataforma, node: `v${binaries.node.versao}` });
        // O pacote passa na mesma conferência que o servidor faz no boot.
        buildIntegrity.verifyReleaseBuild(pkgDir);
        const zipFile = path.join(options.saida, zipName(version, plataforma));
        say(`  compactando ${zipFile}`);
        await zipPackage(pkgDir, zipFile);
        const sha256 = arquivos.sha256File(zipFile);
        fs.writeFileSync(`${zipFile}.sha256`, `${sha256}  ${path.basename(zipFile)}\n`);
        const bytes = fs.statSync(zipFile).size;
        say(`Pronto: ${zipFile}`);
        say(`  ${(bytes / 1024 / 1024).toFixed(1)} MB, ${Object.keys(manifest.arquivos).length + 1} arquivos, versão ${version}, commit ${commit}`);
        say(`  SHA-256: ${sha256}`);
        return { zipFile, sha256, bytes, manifest, pkgDir: options.manterTrabalho ? pkgDir : null, work: options.manterTrabalho ? work : null };
    } finally {
        if (!options.manterTrabalho) fs.rmSync(work, { recursive: true, force: true });
        else say(`  pasta de trabalho mantida: ${work}`);
    }
}

const HELP = `Uso: node scripts/release/montar-pacote.js [opções]
  --plataforma win32-x64|linux-x64  pacote do Windows (padrão) ou do Linux (só para testar)
  --saida <pasta>                   onde gravar o ZIP (padrão: pacotes/)
  --cache <pasta>                   cache dos binários (padrão: scripts/release/.cache)
  --ref <commit>                    o que vai no pacote (padrão: HEAD)
  --arvore                          usa a árvore de trabalho, com o que ainda não foi para o git
  --offline                         não baixa nada (cache e npm só do que já está no disco)
  --so-baixar                       só baixa e confere os binários (com --plataforma todas, de todas)
  --manter-trabalho                 não apaga a pasta temporária do pacote montado`;

async function main(argv = process.argv.slice(2)) {
    let options;
    try {
        options = parseArgs(argv);
        if (options.ajuda) {
            say(HELP);
            return 0;
        }
        await build(options);
        return 0;
    } catch (err) {
        process.stderr.write(`⛔ ${err && err.message ? err.message : String(err)}\n`);
        return 1;
    }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = {
    MANIFEST_FILE,
    PLATFORMS,
    ReleaseError,
    build,
    checkNodeShasum,
    checkPackage,
    ensureCached,
    parseArgs,
    readBinaries,
    renderGuide,
    writeReleaseManifest,
    zipName,
};
