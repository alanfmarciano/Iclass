// Scripts do pacote de release (fase 3, A15 / P6-S3; OPS-01, OPS-21, CRIT-12; D8 e contrato
// C3 do P6). Antes não havia pacote: a escola instalava o Node, rodava npm install (com as
// dependências de desenvolvimento) e compilava a interface; nenhum aviso de licença de
// terceiros acompanhava o IClass. Estes testes cobrem as peças do montar-pacote.js e do
// licencas.js sem rede e sem montar o pacote inteiro (isso é o test/release, npm run
// test:release).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const arquivos = require('../../scripts/release/arquivos.js');
const licencas = require('../../scripts/release/licencas.js');
const montar = require('../../scripts/release/montar-pacote.js');
const buildIntegrity = require('../../backend/utils/buildIntegrity.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-release-scripts-'));
let counter = 0;
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function freshDir(prefix) {
    counter += 1;
    const dir = path.join(tempRoot, `${prefix}-${counter}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function write(base, relative, content) {
    const full = path.join(base, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

const binaries = montar.readBinaries();

// --- contrato C3: dependência de produção nativa só com binário conferido -------------------

function hasNativeCode(directory) {
    if (fs.existsSync(path.join(directory, 'binding.gyp'))) return true;
    try {
        if (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).gypfile) return true;
    } catch (e) { /* sem package.json */ }
    return arquivos.listFiles(directory).some(relative => /\.node$/i.test(relative) && !relative.includes('node_modules/'));
}

test('[UC-RELEASE-004] dependência de produção com módulo nativo ou script de instalação só se estiver em binarios.json (contrato C3)', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const native = [];
    Object.entries(lock.packages).forEach(([key, info]) => {
        if (!key || info.dev || info.devOptional || info.optional || info.link) return;
        const directory = path.join(ROOT, ...key.split('/'));
        if (info.hasInstallScript || (fs.existsSync(directory) && hasNativeCode(directory))) native.push(key.replace(/^.*node_modules\//, ''));
    });
    const allowed = Object.keys(binaries.addons);
    assert.deepEqual(native.filter(name => !allowed.includes(name)), [], 'pacote nativo de produção fora de scripts/release/binarios.json: o pacote do Windows não teria o binário (o npm ci do pacote roda com --ignore-scripts)');
    assert.deepEqual(allowed, ['sqlite3']);
    const sqlite = binaries.addons.sqlite3;
    const installed = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'sqlite3', 'package.json'), 'utf8')).version;
    assert.equal(sqlite.versao, installed, 'binarios.json acompanha a versão do sqlite3 do package-lock.json');
    Object.keys(montar.PLATFORMS).forEach(plataforma => {
        const entry = sqlite.plataformas[plataforma];
        assert.ok(entry, `sqlite3 para ${plataforma}`);
        assert.match(entry.sha256, /^[0-9a-f]{64}$/);
        assert.match(entry.binarioSha256, /^[0-9a-f]{64}$/);
        assert.ok(entry.url.endsWith(`/v${sqlite.versao}/${entry.arquivo}`));
        assert.ok(entry.arquivo.includes(`napi-v${sqlite.napi}-${plataforma}`));
        const node = binaries.node.plataformas[plataforma];
        assert.ok(node, `Node para ${plataforma}`);
        assert.match(node.sha256, /^[0-9a-f]{64}$/);
        assert.match(node.executavelSha256, /^[0-9a-f]{64}$/);
        assert.ok(node.url.startsWith(`https://nodejs.org/dist/v${binaries.node.versao}/`));
        assert.ok(node.url.endsWith(node.arquivo));
        assert.match(node.destino, /^node\/node(\.exe)?$/);
    });
    assert.match(binaries.node.versao, /^22\.\d+\.\d+$/, 'o pacote traz o Node 22 LTS (D9 do P6)');
});

// --- binários: SHA-256 fixado e SHASUMS256 do nodejs.org --------------------------------------

test('[UC-RELEASE-004] binário do cache com SHA-256 diferente do fixado, ou faltando sem rede: o script para', async () => {
    const cache = freshDir('cache');
    const good = write(cache, 'ok.tar.gz', 'conteúdo conferido');
    const entry = { arquivo: 'ok.tar.gz', url: 'https://exemplo.invalid/ok.tar.gz', sha256: arquivos.sha256File(good) };
    assert.equal(await montar.ensureCached(entry, cache, { offline: true }), good);
    await assert.rejects(montar.ensureCached({ ...entry, sha256: 'a'.repeat(64) }, cache, { offline: true }), /não confere com scripts\/release\/binarios\.json/);
    await assert.rejects(montar.ensureCached({ ...entry, arquivo: 'falta.zip' }, cache, { offline: true }), /Falta falta\.zip no cache/);

    const sums = arquivos.parseShasums(`${'b'.repeat(64)}  node-v22.23.5-win-x64.zip\n${'c'.repeat(64)}  node-v22.23.5-linux-x64.tar.gz\n`);
    assert.equal(sums['node-v22.23.5-win-x64.zip'], 'b'.repeat(64));
    assert.doesNotThrow(() => montar.checkNodeShasum({ arquivo: 'node-v22.23.5-win-x64.zip', sha256: 'b'.repeat(64) }, sums));
    assert.throws(() => montar.checkNodeShasum({ arquivo: 'node-v22.23.5-win-x64.zip', sha256: 'd'.repeat(64) }, sums), /SHASUMS256\.txt do nodejs\.org/);
});

// --- leitor de .tar.gz (Node e sqlite3) --------------------------------------------------------

function tarHeader(name, size, type = '0') {
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return header;
}

test('[UC-RELEASE-004] leitor de tar: nomes longos (pax e GNU), só as entradas pedidas, e recusa entrada com ".."', () => {
    const dir = freshDir('tar');
    const longName = `pasta/${'subpasta-longa/'.repeat(8)}arquivo-com-nome-comprido.txt`;
    write(dir, `origem/${longName}`, 'longo');
    write(dir, 'origem/bin/node', 'binário');
    ['pax', 'gnu'].forEach(format => {
        const out = path.join(dir, `${format}.tar.gz`);
        const result = spawnSync('tar', [`--format=${format}`, '-czf', out, '-C', path.join(dir, 'origem'), '.'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const all = arquivos.readTarGz(out);
        assert.ok(all.some(entry => entry.name === longName && entry.data.toString() === 'longo'), `${format}: nome longo`);
        const only = arquivos.readTarGz(out, { wanted: new Set(['bin/node']) });
        assert.deepEqual(only.map(entry => entry.name), ['bin/node']);
        assert.equal(only[0].data.toString(), 'binário');
    });
    const evil = Buffer.concat([tarHeader('../fora.txt', 3), Buffer.from('mal'.padEnd(512, '\0')), Buffer.alloc(1024, 0)]);
    assert.throws(() => arquivos.readTar(evil), /Entrada perigosa/);
    assert.throws(() => arquivos.readTar(Buffer.concat([tarHeader('/etc/passwd', 0), Buffer.alloc(1024, 0)])), /Entrada perigosa/);
});

// --- avisos de terceiros -----------------------------------------------------------------------

function fixtureProject() {
    const base = freshDir('licencas');
    const lock = {
        name: 'x',
        lockfileVersion: 3,
        packages: {
            '': { name: 'x' },
            'node_modules/com-arquivo': { version: '1.0.0' },
            'node_modules/com-readme': { version: '2.0.0' },
            'node_modules/sem-texto': { version: '3.0.0' },
            'node_modules/so-dev': { version: '4.0.0', dev: true },
            'node_modules/opcional': { version: '5.0.0', optional: true },
            'node_modules/com-arquivo/node_modules/aninhado': { version: '0.1.0' },
            'node_modules/apache': { version: '6.0.0' },
        },
    };
    write(base, 'package-lock.json', JSON.stringify(lock));
    write(base, 'node_modules/com-arquivo/package.json', JSON.stringify({ name: 'com-arquivo', version: '1.0.0', license: 'MIT' }));
    write(base, 'node_modules/com-arquivo/LICENSE', 'MIT License\nCopyright (c) Fulano');
    write(base, 'node_modules/com-arquivo/node_modules/aninhado/package.json', JSON.stringify({ name: 'aninhado', version: '0.1.0', license: 'ISC' }));
    write(base, 'node_modules/com-arquivo/node_modules/aninhado/LICENSE.md', 'ISC License\nCopyright (c) Beltrano');
    write(base, 'node_modules/com-readme/package.json', JSON.stringify({ name: 'com-readme', version: '2.0.0', license: 'MIT' }));
    write(base, 'node_modules/com-readme/README.md', `# com-readme\n\nUso.\n\n## License\n\n(MIT)\n\nCopyright (c) 2013 Ciclano &lt;c@exemplo.org&gt;\n\n${'Permission is hereby granted, free of charge, to any person obtaining a copy of this software. '.repeat(3)}\n\n## Outra seção\n\nnão entra`);
    write(base, 'node_modules/sem-texto/package.json', JSON.stringify({ name: 'sem-texto', version: '3.0.0', license: 'MIT' }));
    write(base, 'node_modules/sem-texto/index.js', '');
    write(base, 'node_modules/so-dev/package.json', JSON.stringify({ name: 'so-dev', version: '4.0.0' }));
    write(base, 'node_modules/opcional/package.json', JSON.stringify({ name: 'opcional', version: '5.0.0' }));
    write(base, 'node_modules/apache/package.json', JSON.stringify({ name: 'apache', version: '6.0.0', license: 'Apache-2.0' }));
    write(base, 'node_modules/apache/LICENSE', 'Apache License 2.0');
    write(base, 'node_modules/apache/NOTICE', 'Este produto inclui software de Exemplo.');
    return base;
}

test('[UC-RELEASE-004] avisos de terceiros: texto do LICENSE, do README ou do licencas-extras.json; sem texto, falha', () => {
    const base = fixtureProject();
    const lockFile = path.join(base, 'package-lock.json');
    const { packages, missing } = licencas.collectLicenses(base, lockFile, { omitOptional: true, origem: 'servidor' });
    assert.deepEqual(packages.map(item => item.nome).sort(), ['aninhado', 'apache', 'com-arquivo', 'com-readme']);
    assert.deepEqual(missing.map(item => item.nome), ['sem-texto'], 'o de desenvolvimento e o opcional não vão para o pacote');
    const readme = packages.find(item => item.nome === 'com-readme');
    assert.equal(readme.fonte, 'README');
    assert.match(readme.texto, /Copyright \(c\) 2013 Ciclano <c@exemplo\.org>/);
    assert.doesNotMatch(readme.texto, /Outra seção/);
    assert.equal(packages.find(item => item.nome === 'apache').aviso, 'Este produto inclui software de Exemplo.');

    const err = licencas.missingError(missing);
    assert.equal(err.code, 'ICLASS_LICENSE_MISSING');
    assert.match(err.message, /sem-texto 3\.0\.0/);
    assert.match(err.message, /licencas-extras\.json/);

    const extras = { 'sem-texto@3.0.0': { texto: 'MIT License\nCopyright (c) Autor declarado' } };
    const withExtras = licencas.collectLicenses(base, lockFile, { omitOptional: true, extras });
    assert.deepEqual(withExtras.missing, []);
    assert.equal(withExtras.packages.find(item => item.nome === 'sem-texto').fonte, 'licencas-extras.json');
    // Extra de outra versão não vale: versão nova precisa ser conferida de novo.
    assert.equal(licencas.collectLicenses(base, lockFile, { omitOptional: true, extras: { 'sem-texto@2.9.0': extras['sem-texto@3.0.0'] } }).missing.length, 1);

    const text = licencas.buildNotices({ version: '3.1.0', packages: licencas.mergePackages([withExtras.packages]), node: { versao: '22.23.5', texto: 'Node.js is licensed for use as follows' } });
    assert.match(text, /^AVISOS DE TERCEIROS DO ICLASS 3\.1\.0/);
    assert.match(text, /Node\.js 22\.23\.5/);
    assert.match(text, /--- NOTICE de apache ---/);
    assert.doesNotMatch(text, /so-dev|opcional 5/);
});

test('[UC-RELEASE-004] avisos do IClass de verdade: todas as dependências do servidor e do bundle têm o texto da licença', () => {
    const { text, packages } = licencas.noticesFor({ version: '0.0.0-teste' });
    const names = new Set(packages.map(item => item.nome));
    ['express', 'sqlite3', 'archiver', 'adm-zip', 'multer', 'react', 'react-dom', 'dompurify', 'marked', 'lucide-react'].forEach(name => assert.ok(names.has(name), `${name} nos avisos`));
    ['@playwright/test', 'supertest', 'axe-core', 'vite', 'vitest', 'node-gyp', 'tailwindcss'].forEach(name => assert.ok(!names.has(name), `${name} (desenvolvimento ou opcional) fora dos avisos`));
    assert.match(text, /domínio público/, 'o SQLite que vem dentro do sqlite3');
});

// --- conferência do pacote montado e manifesto ------------------------------------------------

function fakePackage({ plataforma = 'linux-x64' } = {}) {
    const pkg = freshDir('pacote');
    const addon = binaries.addons.sqlite3;
    write(pkg, 'package.json', JSON.stringify({ name: 'iclass-v3', version: '3.1.0' }));
    write(pkg, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/express': { version: '5' }, 'node_modules/supertest': { version: '7', dev: true }, 'node_modules/node-gyp': { version: '12', optional: true } } }));
    write(pkg, 'web/dist/index.html', '<!doctype html>');
    write(pkg, 'web/dist/build-meta.json', JSON.stringify({ sourceHash: 'e'.repeat(64) }));
    write(pkg, 'backend/server.js', '');
    write(pkg, 'node_modules/express/index.js', '');
    // O binário de verdade não está aqui: o teste troca o SHA-256 esperado pelo do arquivo falso.
    const fakeBinary = write(pkg, addon.binario, 'binário de mentira');
    const testBinaries = JSON.parse(JSON.stringify(binaries));
    testBinaries.addons.sqlite3.plataformas[plataforma].binarioSha256 = arquivos.sha256File(fakeBinary);
    return { pkg, testBinaries, plataforma };
}

test('[UC-RELEASE-004] pacote montado com web/src, pacote de desenvolvimento, node-gyp ou módulo nativo fora da lista: recusado', () => {
    const { pkg, testBinaries, plataforma } = fakePackage();
    assert.doesNotThrow(() => montar.checkPackage(pkg, { binaries: testBinaries, plataforma }));

    write(pkg, 'web/src/main.jsx', '');
    write(pkg, 'node_modules/supertest/index.js', '');
    write(pkg, 'node_modules/node-gyp/index.js', '');
    write(pkg, 'node_modules/express/build/Release/outro.node', 'nativo');
    let caught = null;
    try { montar.checkPackage(pkg, { binaries: testBinaries, plataforma }); } catch (err) { caught = err; }
    assert.ok(caught);
    assert.match(caught.message, /web\/src/);
    assert.match(caught.message, /node_modules\/supertest, que é de desenvolvimento ou opcional/);
    assert.match(caught.message, /node_modules\/node-gyp/);
    assert.match(caught.message, /outro\.node é um módulo nativo que não está em scripts\/release\/binarios\.json \(contrato C3\)/);

    // O binário do sqlite3 de outra plataforma (ou trocado) também é recusado.
    const other = fakePackage();
    assert.throws(() => montar.checkPackage(other.pkg, { binaries, plataforma: other.plataforma }), /não é o binário de linux-x64/);
});

test('[UC-RELEASE-004] o release-manifest.json do montar-pacote.js é o que o servidor confere no boot', () => {
    const { pkg } = fakePackage();
    const manifest = montar.writeReleaseManifest(pkg, { versao: '3.1.0', commit: 'abc', plataforma: 'linux-x64', node: 'v22.23.5' });
    assert.equal(manifest.produto, 'IClass');
    assert.equal(manifest.formato, buildIntegrity.RELEASE_MANIFEST_FORMAT);
    assert.ok(manifest.arquivos['web/dist/index.html']);
    assert.ok(manifest.arquivos['node_modules/express/index.js']);
    assert.ok(!manifest.arquivos['release-manifest.json'], 'o manifesto não lista a si mesmo');
    assert.equal(buildIntegrity.buildMode(pkg), 'pacote');
    assert.doesNotThrow(() => buildIntegrity.verifyReleaseBuild(pkg));
    fs.appendFileSync(path.join(pkg, 'web', 'dist', 'index.html'), 'x');
    assert.throws(() => buildIntegrity.verifyReleaseBuild(pkg), /Reinstale esta versão do IClass/);
});

test('[UC-RELEASE-004] opções do montar-pacote.js, nome do ZIP e Guia de instalação', () => {
    assert.equal(montar.parseArgs([]).plataforma, 'win32-x64');
    assert.equal(montar.parseArgs(['--plataforma', 'linux-x64', '--arvore', '--offline']).offline, true);
    assert.throws(() => montar.parseArgs(['--plataforma', 'mac']), /Plataforma desconhecida/);
    assert.throws(() => montar.parseArgs(['--qualquer']), /Opção desconhecida/);
    assert.throws(() => montar.parseArgs(['--ref']), /precisa de um valor/);
    assert.throws(() => montar.parseArgs(['--ref', 'HEAD;rm -rf /']), /Referência do git inválida/);
    assert.equal(montar.parseArgs(['--so-baixar', '--plataforma', 'todas']).plataforma, 'todas');
    assert.equal(montar.zipName('3.1.0', 'win32-x64'), 'IClass-3.1.0-windows-x64.zip');

    const marked = require(path.join(ROOT, 'web', 'node_modules', 'marked', 'lib', 'marked.cjs'));
    const html = montar.renderGuide('# Instalação e rede\n\n<!-- instrução para quem escreve -->\n\n## Rede e firewall {#rede-e-firewall}\n\nLibere a **porta TCP 3000**.\n', { version: '3.1.0', marked });
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<h2 id="rede-e-firewall">Rede e firewall<\/h2>/);
    assert.match(html, /<strong>porta TCP 3000<\/strong>/);
    assert.doesNotMatch(html, /instrução para quem escreve|\{#/);
});
