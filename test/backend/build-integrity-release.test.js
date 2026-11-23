// Conferência do build em dois modos (fase 3, A15 / P6-S3; OPS-01, OPS-18, OPS-21; D14 do P6).
// Antes: o servidor só subia com o código-fonte da interface (web/src) na pasta. Sem ele,
// o readdirSync lançava ENOENT e o boot saía com "ENOENT: no such file or directory,
// scandir .../web/src"; toda escola precisava receber web/src. Agora o pacote leva só o
// web/dist e o release-manifest.json, e o servidor confere a versão e o SHA-256 de cada
// arquivo de web/dist no boot. Com web/src, vale o sourceHash de sempre.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-build-release-test-'));
process.env.ICLASS_DATA_DIR = path.join(tempRoot, 'data');
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const runtimePaths = require('../../backend/runtimePaths.js');
const buildIntegrity = require('../../backend/utils/buildIntegrity.js');
const { describeBootFailure } = require('../../backend/server.js');
const { EXIT_CODES } = require('../../backend/utils/serverLifecycle.js');

const original = { root: runtimePaths.PROJECT_ROOT, dist: runtimePaths.WEB_DIST_DIR };
let counter = 0;

test.after(() => {
    runtimePaths.PROJECT_ROOT = original.root;
    runtimePaths.WEB_DIST_DIR = original.dist;
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

// Uma pasta de programa como a do pacote: package.json, web/dist e o manifesto.
function makeProgram({ version = '3.1.0', manifestVersion = version, withSource = false, withManifest = true, mutate } = {}) {
    counter += 1;
    const root = path.join(tempRoot, `programa-${counter}`);
    const files = {
        'package.json': JSON.stringify({ name: 'iclass-v3', version }),
        'web/dist/index.html': '<!doctype html><html><body><div id="root"></div><script src="/assets/index-abc.js"></script></body></html>',
        'web/dist/assets/index-abc.js': 'console.log("iclass")',
        'web/dist/assets/index-abc.js.br': Buffer.from([1, 2, 3, 4]),
        'web/dist/build-meta.json': JSON.stringify({ sourceHash: 'f'.repeat(64), builtAt: '2026-11-23T00:00:00.000Z', node: 'v22.23.5' }),
        'backend/server.js': '// servidor',
    };
    Object.entries(files).forEach(([relative, content]) => {
        const full = path.join(root, ...relative.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    });
    if (withSource) {
        fs.mkdirSync(path.join(root, 'web', 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'web', 'src', 'main.jsx'), 'export {}');
    }
    const manifest = {
        produto: 'IClass',
        formato: 1,
        versao: manifestVersion,
        commit: 'abc1234',
        geradoEm: '2026-11-23T00:00:00.000Z',
        node: 'v22.23.5',
        plataforma: 'win32-x64',
        arquivos: Object.fromEntries(Object.entries(files).map(([relative, content]) => [relative, sha256(content)])),
    };
    if (mutate) mutate(manifest, root);
    if (withManifest) fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(manifest));
    runtimePaths.PROJECT_ROOT = root;
    runtimePaths.WEB_DIST_DIR = path.join(root, 'web', 'dist');
    return root;
}

function expectCode(fn, code) {
    let caught = null;
    try { fn(); } catch (err) { caught = err; }
    assert.ok(caught, `esperava o erro ${code}`);
    assert.equal(caught.code, code, caught.message);
    return caught;
}

test('[UC-RELEASE-001] pacote sem web/src e com o release-manifest.json válido: o build é aceito', () => {
    const root = makeProgram();
    assert.equal(buildIntegrity.buildMode(root), 'pacote');
    const meta = buildIntegrity.verifyBuild();
    assert.equal(meta.sourceHash, 'f'.repeat(64), 'devolve o build-meta.json do pacote');
    // Arquivo a mais em web/dist (desktop.ini do Windows) não conta.
    fs.writeFileSync(path.join(root, 'web', 'dist', 'desktop.ini'), '[.ShellClassInfo]');
    assert.doesNotThrow(() => buildIntegrity.verifyBuild());
});

test('[UC-RELEASE-001] arquivo do web/dist alterado ou faltando: ICLASS_BUILD_TAMPERED com "Reinstale esta versão"', () => {
    const root = makeProgram();
    fs.appendFileSync(path.join(root, 'web', 'dist', 'assets', 'index-abc.js'), '\n// mudado');
    const changed = expectCode(() => buildIntegrity.verifyBuild(), 'ICLASS_BUILD_TAMPERED');
    assert.match(changed.message, /Os arquivos da interface estão incompletos ou foram alterados\. Reinstale esta versão do IClass\./);
    assert.deepEqual(changed.details.alterados, ['web/dist/assets/index-abc.js']);

    const second = makeProgram();
    fs.rmSync(path.join(second, 'web', 'dist', 'assets', 'index-abc.js.br'));
    const missing = expectCode(() => buildIntegrity.verifyBuild(), 'ICLASS_BUILD_TAMPERED');
    assert.deepEqual(missing.details.faltando, ['web/dist/assets/index-abc.js.br']);

    // A mensagem do boot: saída 2 (configuração), nada de "npm run build" (o pacote nem
    // tem web/src), e o nome dos arquivos para o suporte.
    const failure = describeBootFailure('build', missing);
    assert.equal(failure.exitCode, EXIT_CODES.CONFIG);
    assert.match(failure.message, /Reinstale esta versão do IClass/);
    assert.match(failure.message, /web\/dist\/assets\/index-abc\.js\.br \(faltando\)/);
    assert.doesNotMatch(failure.message, /npm run build|opção \[4\]/);
});

test('[UC-RELEASE-001] manifesto de outra versão, sem o index.html, com caminho perigoso ou ilegível: recusado', () => {
    makeProgram({ version: '3.1.1', manifestVersion: '3.1.0' });
    const mixed = expectCode(() => buildIntegrity.verifyBuild(), 'ICLASS_BUILD_TAMPERED');
    assert.match(mixed.message, /mistura versões: o programa é a 3\.1\.1 e a interface, a 3\.1\.0/);

    makeProgram({ mutate: manifest => { delete manifest.arquivos['web/dist/index.html']; } });
    const noIndex = expectCode(() => buildIntegrity.verifyBuild(), 'ICLASS_BUILD_TAMPERED');
    assert.ok(noIndex.details.faltando.includes('web/dist/index.html'));

    // Um caminho que sai da pasta nunca é lido: conta como alterado.
    const outside = path.join(tempRoot, 'fora.txt');
    fs.writeFileSync(outside, 'segredo');
    makeProgram({ mutate: manifest => { manifest.arquivos['web/dist/../../fora.txt'] = sha256('segredo'); } });
    const traversal = expectCode(() => buildIntegrity.verifyBuild(), 'ICLASS_BUILD_TAMPERED');
    assert.deepEqual(traversal.details.alterados, ['web/dist/../../fora.txt']);

    const broken = makeProgram();
    fs.writeFileSync(path.join(broken, 'release-manifest.json'), '{ isto não é json');
    const unreadable = expectCode(() => buildIntegrity.verifyBuild(), 'ICLASS_BUILD_TAMPERED');
    assert.match(unreadable.message, /release-manifest\.json está ilegível/);

    makeProgram({ mutate: manifest => { manifest.formato = 2; } });
    expectCode(() => buildIntegrity.verifyBuild(), 'ICLASS_BUILD_TAMPERED');
});

test('[UC-RELEASE-001] sem web/src e sem manifesto: ICLASS_BUILD_NO_SOURCE (antes, ENOENT cru no scandir)', () => {
    makeProgram({ withManifest: false });
    const err = expectCode(() => buildIntegrity.verifyBuild(), 'ICLASS_BUILD_NO_SOURCE');
    assert.doesNotMatch(err.message, /ENOENT|scandir/);
    const failure = describeBootFailure('build', err);
    assert.equal(failure.exitCode, EXIT_CODES.CONFIG);
    assert.match(failure.message, /não tem o código da interface \(web\/src\) nem o release-manifest\.json/);
});

test('[UC-RELEASE-001] com web/src a conferência continua pelo sourceHash, mesmo com um manifesto na pasta', () => {
    const root = makeProgram({ withSource: true });
    assert.equal(buildIntegrity.buildMode(root), 'desenvolvimento');
    // O build-meta.json do teste não é o hash das fontes: na pasta do git isso é "desatualizado".
    expectCode(() => buildIntegrity.verifyBuild(), 'ICLASS_BUILD_OUTDATED');
    const meta = path.join(root, 'web', 'dist', 'build-meta.json');
    fs.writeFileSync(meta, JSON.stringify({ sourceHash: buildIntegrity.computeSourceHash() }));
    assert.doesNotThrow(() => buildIntegrity.verifyBuild());
    // Mexer no web/dist com o web/src presente não é conferido pelo manifesto (é a pasta do git).
    fs.appendFileSync(path.join(root, 'web', 'dist', 'index.html'), '<!-- dev -->');
    assert.doesNotThrow(() => buildIntegrity.verifyBuild());
});
