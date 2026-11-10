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
const { execFileSync } = require('node:child_process');
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

test('[UC-DESEMPENHO-001] orçamento: todo arquivo de web/dist/assets tem um nome que o servidor entrega em /assets', async () => {
    // Antes, o servidor recusava nomes começando com '_', que o Vite dá a pedaços
    // compartilhados (_commonjsHelpers-<hash>.js, ou um módulo _baseHelper.js de uma
    // dependência): o arquivo dava 404 e a tela quebrava, sem o check:bundle perceber.
    const { checkBundle, unservableAssetNames } = await loadScript('check-bundle-size.mjs');
    const dirs = fakeBuild('nomes');
    const assets = path.join(dirs.distDir, 'assets');
    for (const name of ['_commonjsHelpers-Bx1a.js', '__vite-browser-external-9aZ.js', '_baseHelper-Do-915rM.js', 'EscolaEditPage--m_4JLv_.js']) {
        write(path.join(assets, name), texto(2));
        write(path.join(assets, `${name}.gz`), zlib.gzipSync(Buffer.from(texto(2))));
    }
    assert.deepEqual(unservableAssetNames(assets), []);
    assert.equal(checkBundle(dirs).ok, true, checkBundle(dirs).errors.join('\n'));

    write(path.join(assets, 'Matrícula-abc.js'), texto(1));
    write(path.join(assets, 'Minha Tela-abc.js'), texto(1));
    write(path.join(assets, '.oculto-abc.js'), texto(1));
    write(path.join(assets, 'img', 'logo-abc.png'), 'png');
    // .gz sem o original ao lado não é versão comprimida de nada.
    write(path.join(assets, 'sozinho-abc.js.gz'), zlib.gzipSync(Buffer.from('x')));
    assert.deepEqual(unservableAssetNames(assets), ['.oculto-abc.js', 'Matrícula-abc.js', 'Minha Tela-abc.js', 'img/', 'sozinho-abc.js.gz']);
    const result = checkBundle(dirs);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /assets\/Matrícula-abc\.js tem um nome que o servidor não entrega em \/assets/);
    assert.match(result.errors.join('\n'), /assets\/img\/ tem um nome que o servidor não entrega/);
});

test('[UC-DESEMPENHO-001] o build só grava nomes que o servidor entrega (sanitizeFileName do vite.config.js)', () => {
    const { isServableAssetName, toServableAssetName } = require('../../backend/utils/staticAssets.js');
    const viteConfig = fs.readFileSync(path.join(ROOT, 'web', 'vite.config.js'), 'utf8');
    assert.match(viteConfig, /require\('\.\.\/backend\/utils\/staticAssets\.js'\)/);
    assert.match(viteConfig, /sanitizeFileName: toServableAssetName/);
    // Nomes que o Rollup deixaria passar com a regra padrão dele: com o padrão do Vite
    // ([name]-[hash].js), o arquivo final sempre passa na regra do servidor.
    for (const name of ['Matrícula', 'Minha Tela', 'tela(1)', ".oculto", '\0commonjsHelpers', '_baseHelper', 'ação!@~', 'índice.css', 'ExamRunner']) {
        const fileName = `${toServableAssetName(name)}-AbC_9-x.js`;
        assert.equal(isServableAssetName(fileName), true, `${name} → ${fileName}`);
    }
    assert.equal(toServableAssetName('ExamRunner'), 'ExamRunner');
    assert.equal(toServableAssetName('_commonjsHelpers'), '_commonjsHelpers');
    assert.equal(toServableAssetName('pasta/Matrícula'), 'pasta/Matr_cula');
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

test('[UC-DESEMPENHO-001] scripts chamados por um caminho que passa por link simbólico (ou junção do Windows) rodam de verdade', (t) => {
    // Antes, comparar process.argv[1] cru com o import.meta.url (que o Node resolve) fazia
    // os dois scripts saírem com 0 sem fazer nada: sem pré-compressão e com o orçamento
    // "aprovado" sem conferir, se a pasta do IClass estivesse atrás de um link.
    const real = path.join(tempRoot, 'pasta-real');
    const scripts = path.join(real, 'web', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    for (const name of ['compress-assets.mjs', 'check-bundle-size.mjs']) {
        fs.copyFileSync(path.join(ROOT, 'web', 'scripts', name), path.join(scripts, name));
    }
    // O check:bundle usa a regra de nomes do servidor (backend/utils/staticAssets.js).
    fs.mkdirSync(path.join(real, 'backend', 'utils'), { recursive: true });
    for (const name of ['staticAssets.js', 'httpCompression.js']) {
        fs.copyFileSync(path.join(ROOT, 'backend', 'utils', name), path.join(real, 'backend', 'utils', name));
    }
    const { distDir, srcDir } = fakeBuild('pasta-real/web');
    assert.equal(distDir, path.join(real, 'web', 'dist'));
    assert.equal(srcDir, path.join(real, 'web', 'src'));
    const link = path.join(tempRoot, 'pasta-pelo-link');
    try {
        fs.symlinkSync(real, link, 'junction');
    } catch (error) {
        t.skip(`sem permissão para criar link: ${error.code}`);
        return;
    }
    const viaLink = path.join(link, 'web', 'scripts');

    const compressed = execFileSync(process.execPath, [path.join(viaLink, 'compress-assets.mjs')], { encoding: 'utf8' });
    assert.match(compressed, /^Pré-compressão: \d+ arquivo\(s\), \d+ versão\(ões\) \.gz\/\.br gravada\(s\)/);
    assert.ok(fs.existsSync(path.join(distDir, 'assets', 'index-abc.js.gz')));
    assert.ok(fs.existsSync(path.join(distDir, 'assets', 'index-abc.js.br')));

    const budget = execFileSync(process.execPath, [path.join(viaLink, 'check-bundle-size.mjs')], { encoding: 'utf8' });
    assert.match(budget, /JavaScript da primeira abertura: .* em gzip \(limite 130,0 KB\), 2 arquivo\(s\)\./);
    assert.match(budget, /Orçamento do pacote da interface: dentro do limite\./);

    // Orçamento estourado pelo link: sai com 1, não com 0 calado.
    fs.writeFileSync(path.join(distDir, 'assets', 'MonitorPage-jkl.js'), 'x'.repeat(360 * 1024));
    assert.throws(
        () => execFileSync(process.execPath, [path.join(viaLink, 'check-bundle-size.mjs')], { encoding: 'utf8', stdio: 'pipe' }),
        (error) => error.status === 1 && /acima do limite de 350,0 KB/.test(String(error.stderr)),
    );
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
