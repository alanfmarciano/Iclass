// Fase 2, H2-A (DES-05, DES-06): o build grava ao lado de cada arquivo de texto de
// web/dist/assets as versões .gz e .br (web/scripts/compress-assets.mjs), e o
// `npm run check:bundle` (web/scripts/check-bundle-size.mjs, na suíte rápida e no
// `npm run check`) falha quando o JavaScript da primeira abertura passa de 130 KB em gzip,
// quando um .js passa de 350 KB ou quando alguma tela importa todos os ícones
// (`import * as` de 'lucide-react', como o StatCard fazia: o pacote único chegava a
// 1,5 MB, baixado até pelo celular do aluno).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-bundle-budget-test-'));

function loadScript(name) {
    return import(pathToFileURL(path.join(ROOT, 'web', 'scripts', name)).href);
}

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function texto(kb) {
    return `export const texto = ${JSON.stringify('tela do IClass '.repeat(Math.ceil(kb * 1024 / 15)))};\n`;
}

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-DESEMPENHO-001] pré-compressão: .gz e .br para texto de 1 KB ou mais; pequeno, binário e incompressível ficam sem', async () => {
    const { compressAssets } = await loadScript('compress-assets.mjs');
    const assets = path.join(tempRoot, 'compress', 'assets');
    const big = texto(20);
    write(path.join(assets, 'index-aaa111.js'), big);
    write(path.join(assets, 'index-bbb222.css'), `.x{color:red}\n${'.y{margin:0 auto}'.repeat(200)}`);
    write(path.join(assets, 'pequeno-ccc333.js'), 'export const a = 1;\n');
    write(path.join(assets, 'logo-ddd444.png'), crypto.randomBytes(4096));
    // .js com conteúdo que não comprime: a versão não ficaria abaixo de 95%.
    write(path.join(assets, 'aleatorio-eee555.js'), crypto.randomBytes(8192));
    // Sobra de um build anterior, sem o original.
    write(path.join(assets, 'antigo-fff666.js.gz'), zlib.gzipSync('velho'));
    // Variante antiga de um arquivo que agora não comprime mais.
    write(path.join(assets, 'aleatorio-eee555.js.br'), 'sobra');

    const summary = compressAssets(assets);
    assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(assets, 'index-aaa111.js.gz'))).toString('utf8'), big);
    assert.equal(zlib.brotliDecompressSync(fs.readFileSync(path.join(assets, 'index-aaa111.js.br'))).toString('utf8'), big);
    assert.ok(fs.existsSync(path.join(assets, 'index-bbb222.css.gz')));
    assert.ok(fs.existsSync(path.join(assets, 'index-bbb222.css.br')));
    assert.equal(fs.existsSync(path.join(assets, 'pequeno-ccc333.js.gz')), false);
    assert.equal(fs.existsSync(path.join(assets, 'logo-ddd444.png.gz')), false);
    assert.equal(fs.existsSync(path.join(assets, 'antigo-fff666.js.gz')), false);
    assert.equal(fs.existsSync(path.join(assets, 'aleatorio-eee555.js.gz')), false);
    assert.equal(fs.existsSync(path.join(assets, 'aleatorio-eee555.js.br')), false);
    assert.equal(summary.removed, 1);
    // Mesma data do original: o ETag e o Last-Modified acompanham o arquivo do build.
    assert.equal(
        Math.floor(fs.statSync(path.join(assets, 'index-aaa111.js.gz')).mtimeMs / 1000),
        Math.floor(fs.statSync(path.join(assets, 'index-aaa111.js')).mtimeMs / 1000),
    );
    // Sem a pasta (build que falhou antes): nada a fazer, sem erro.
    assert.deepEqual(compressAssets(path.join(tempRoot, 'nao-existe')).files, 0);
});

function fakeBuild(name, { entryKb = 20, preloadKb = 10, extraRaw = null, wildcard = false } = {}) {
    const base = path.join(tempRoot, name);
    const dist = path.join(base, 'dist');
    const src = path.join(base, 'src');
    write(path.join(dist, 'index.html'), [
        '<!doctype html><html lang="pt-BR"><head>',
        '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
        '<link rel="modulepreload" crossorigin href="/assets/icons-def.js">',
        '<link rel="stylesheet" crossorigin href="/assets/index-ghi.css">',
        '</head><body><div id="root"></div></body></html>',
    ].join('\n'));
    write(path.join(dist, 'assets', 'index-abc.js'), entryKb === 'random' ? crypto.randomBytes(200 * 1024).toString('base64') : texto(entryKb));
    write(path.join(dist, 'assets', 'icons-def.js'), texto(preloadKb));
    write(path.join(dist, 'assets', 'index-ghi.css'), 'body{}');
    write(path.join(dist, 'assets', 'MonitorPage-jkl.js'), extraRaw ? 'x'.repeat(extraRaw) : texto(5));
    write(path.join(src, 'components', 'Card.jsx'), "import { Users } from 'lucide-react'\nexport const Card = () => Users\n");
    if (wildcard) write(path.join(src, 'components', 'Todos.jsx'), "import * as Icons from 'lucide-react'\nexport const all = Icons\n");
    return { distDir: dist, srcDir: src };
}

test('[UC-DESEMPENHO-001] orçamento: dentro do limite passa e conta só o JavaScript da primeira abertura', async () => {
    const { checkBundle, initialScripts } = await loadScript('check-bundle-size.mjs');
    const dirs = fakeBuild('ok');
    const result = checkBundle(dirs);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.built, true);
    assert.match(result.lines.join('\n'), /JavaScript da primeira abertura: .* em gzip \(limite 130,0 KB\), 2 arquivo\(s\)\./);
    assert.deepEqual(initialScripts(fs.readFileSync(path.join(dirs.distDir, 'index.html'), 'utf8')), ['assets/index-abc.js', 'assets/icons-def.js']);
    // Com o .gz do build, o tamanho vem dele.
    fs.writeFileSync(path.join(dirs.distDir, 'assets', 'index-abc.js.gz'), Buffer.alloc(140 * 1024));
    const withGz = checkBundle(dirs);
    assert.equal(withGz.ok, false);
    assert.match(withGz.errors.join('\n'), /primeira abertura tem .* acima do limite de 130,0 KB.*lazyPage/);
});

test('[UC-DESEMPENHO-001] orçamento: entrada acima de 130 KB em gzip, .js acima de 350 KB e import * de ícones falham com mensagem em português', async () => {
    const { checkBundle } = await loadScript('check-bundle-size.mjs');
    const heavy = checkBundle(fakeBuild('pesado', { entryKb: 'random' }));
    assert.equal(heavy.ok, false);
    assert.match(heavy.errors.join('\n'), /JavaScript da primeira abertura tem .* acima do limite/);

    const raw = checkBundle(fakeBuild('arquivo-grande', { extraRaw: 360 * 1024 }));
    assert.equal(raw.ok, false);
    assert.match(raw.errors.join('\n'), /assets\/MonitorPage-jkl\.js tem 360,0 KB sem compressão, acima do limite de 350,0 KB/);

    const icons = checkBundle(fakeBuild('icones', { wildcard: true }));
    assert.equal(icons.ok, false);
    assert.match(icons.errors.join('\n'), /components\/Todos\.jsx importa todos os ícones/);

    // index.html apontando para arquivo que sumiu: build quebrado.
    const broken = fakeBuild('quebrado');
    fs.rmSync(path.join(broken.distDir, 'assets', 'icons-def.js'));
    assert.match(checkBundle(broken).errors.join('\n'), /aponta para assets\/icons-def\.js, que não está no build/);
});

test('[UC-DESEMPENHO-001] orçamento sem build: avisa e passa; o código-fonte ainda é conferido', async () => {
    const { checkBundle, NO_BUILD_MESSAGE } = await loadScript('check-bundle-size.mjs');
    const src = path.join(tempRoot, 'sem-build', 'src');
    write(path.join(src, 'App.jsx'), "import { Users } from 'lucide-react'\n");
    const result = checkBundle({ distDir: path.join(tempRoot, 'sem-build', 'dist'), srcDir: src });
    assert.equal(result.ok, true);
    assert.equal(result.built, false);
    assert.deepEqual(result.lines, [NO_BUILD_MESSAGE]);
    assert.equal(NO_BUILD_MESSAGE, 'Sem build da interface: orçamento não conferido.');
    write(path.join(src, 'Todos.jsx'), "import * as Icons from 'lucide-react'\n");
    assert.equal(checkBundle({ distDir: path.join(tempRoot, 'sem-build', 'dist'), srcDir: src }).ok, false);
});

test('[UC-DESEMPENHO-001] web/src não importa todos os ícones (StatCard usa o mapa de ícones nomeados)', async () => {
    const { findWildcardIconImports } = await loadScript('check-bundle-size.mjs');
    assert.deepEqual(findWildcardIconImports(path.join(ROOT, 'web', 'src')), []);
});

test('[UC-DESEMPENHO-001] build e suítes: pré-compressão no npm run build; check:bundle fora do build e dentro da suíte rápida e do npm run check', () => {
    const webPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'package.json'), 'utf8'));
    assert.match(webPackage.scripts.build, /^vite build && node scripts\/compress-assets\.mjs && node scripts\/write-build-meta\.mjs$/);
    assert.doesNotMatch(webPackage.scripts.build, /check-bundle/);
    const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(rootPackage.scripts['check:bundle'], 'node web/scripts/check-bundle-size.mjs');
    assert.doesNotMatch(rootPackage.scripts.build, /check/);
    const runner = fs.readFileSync(path.join(ROOT, 'test', 'run-module.js'), 'utf8');
    for (const suite of ['quick', 'full']) {
        const block = runner.slice(runner.indexOf(`  ${suite}: [`), runner.indexOf('],', runner.indexOf(`  ${suite}: [`)));
        assert.match(block, /npmScript\('check:bundle'/, suite);
    }
    assert.match(rootPackage.scripts.check, /test:full/);
});
