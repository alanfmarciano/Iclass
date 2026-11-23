// Pastas de dados pelo iclass-pastas.json (fase 3, A15 / P6-S3; OPS-02; D10 e contrato C2 do
// P6). Antes, sem as variáveis de ambiente, os dados ficavam sempre em <pasta do
// programa>/data: no pacote instalado (C:\IClass\programa\<versão>) cada atualização
// trocaria a pasta e os dados ficariam para trás. Agora a pasta da versão traz um
// iclass-pastas.json com dados, conteudo e cursosArquivados, lido por toda porta de entrada
// (servidor, supervisor, backup-cli, redefinir senha); a variável de ambiente continua
// ganhando, e arquivo ilegível vale o padrão de hoje com aviso.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runtimePaths = require('../../backend/runtimePaths.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-runtime-paths-'));
let counter = 0;

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function programDir(content) {
    counter += 1;
    const root = path.join(tempRoot, `programa-${counter}`);
    fs.mkdirSync(root, { recursive: true });
    if (content !== undefined) fs.writeFileSync(path.join(root, 'iclass-pastas.json'), content);
    return root;
}

const absolute = name => path.join(tempRoot, 'instalacao', name);

test('[UC-RELEASE-002] iclass-pastas.json na pasta do programa define DATA_DIR, CONTENT_DIR e ARCHIVE_DIR', () => {
    const root = programDir(JSON.stringify({ dados: absolute('dados'), conteudo: absolute('conteudo'), cursosArquivados: absolute('cursos-arquivados') }));
    const folders = runtimePaths.resolveRuntimeFolders({ projectRoot: root, env: {} });
    assert.equal(folders.DATA_DIR, absolute('dados'));
    assert.equal(folders.CONTENT_DIR, absolute('conteudo'));
    assert.equal(folders.ARCHIVE_DIR, absolute('cursos-arquivados'));
    assert.deepEqual(folders.origem, { DATA_DIR: 'arquivo', CONTENT_DIR: 'arquivo', ARCHIVE_DIR: 'arquivo' });
    assert.deepEqual(folders.avisos, []);
    assert.equal(folders.arquivo, path.join(root, 'iclass-pastas.json'));
});

test('[UC-RELEASE-002] a variável de ambiente ganha do arquivo, pasta por pasta', () => {
    const root = programDir(JSON.stringify({ dados: absolute('dados'), conteudo: absolute('conteudo'), cursosArquivados: absolute('cursos-arquivados') }));
    const folders = runtimePaths.resolveRuntimeFolders({ projectRoot: root, env: { ICLASS_DATA_DIR: absolute('teste'), ICLASS_CONTENT_DIR: '  ' } });
    assert.equal(folders.DATA_DIR, absolute('teste'));
    assert.equal(folders.CONTENT_DIR, absolute('conteudo'), 'variável vazia não conta');
    assert.equal(folders.ARCHIVE_DIR, absolute('cursos-arquivados'));
    assert.deepEqual(folders.origem, { DATA_DIR: 'variavel', CONTENT_DIR: 'arquivo', ARCHIVE_DIR: 'arquivo' });
});

test('[UC-RELEASE-002] sem arquivo, vale o padrão de hoje (data, content e cursos_arquivados na pasta do programa)', () => {
    const root = programDir();
    const folders = runtimePaths.resolveRuntimeFolders({ projectRoot: root, env: {} });
    assert.equal(folders.DATA_DIR, path.join(root, 'data'));
    assert.equal(folders.CONTENT_DIR, path.join(root, 'content'));
    assert.equal(folders.ARCHIVE_DIR, path.join(root, 'cursos_arquivados'));
    assert.equal(folders.arquivo, null);
    assert.deepEqual(folders.avisos, []);
});

test('[UC-RELEASE-002] arquivo ilegível ou campo inválido: padrão com aviso, sem derrubar nada', () => {
    const broken = programDir('{ "dados": ');
    const fromBroken = runtimePaths.resolveRuntimeFolders({ projectRoot: broken, env: {} });
    assert.equal(fromBroken.DATA_DIR, path.join(broken, 'data'));
    assert.equal(fromBroken.avisos.length, 1);
    assert.match(fromBroken.avisos[0], /ilegível/);

    const notObject = programDir('["C:/IClass/dados"]');
    assert.match(runtimePaths.resolveRuntimeFolders({ projectRoot: notObject, env: {} }).avisos[0], /formato esperado/);

    const badField = programDir(JSON.stringify({ dados: 42, conteudo: absolute('conteudo') }));
    const partial = runtimePaths.resolveRuntimeFolders({ projectRoot: badField, env: {} });
    assert.equal(partial.DATA_DIR, path.join(badField, 'data'));
    assert.equal(partial.CONTENT_DIR, absolute('conteudo'));
    assert.equal(partial.ARCHIVE_DIR, path.join(badField, 'cursos_arquivados'), 'campo ausente: padrão, sem aviso');
    assert.equal(partial.avisos.length, 1);
    assert.match(partial.avisos[0], /"dados"/);
});

test('[UC-RELEASE-002] arquivo com BOM (UTF-8 ou UTF-16 do Bloco de Notas) e caminho relativo à pasta do programa', () => {
    const content = JSON.stringify({ dados: absolute('dados-bom'), conteudo: '../conteudo' });
    const utf8 = programDir(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]));
    const fromUtf8 = runtimePaths.resolveRuntimeFolders({ projectRoot: utf8, env: {} });
    assert.equal(fromUtf8.DATA_DIR, absolute('dados-bom'));
    assert.equal(fromUtf8.CONTENT_DIR, path.resolve(utf8, '..', 'conteudo'));
    const utf16 = programDir(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
    assert.equal(runtimePaths.resolveRuntimeFolders({ projectRoot: utf16, env: {} }).DATA_DIR, absolute('dados-bom'));
});

// O módulo de verdade, carregado de uma pasta de programa como a do pacote: as pastas
// derivadas (uploads, backups, entregas) seguem o DATA_DIR do arquivo.
test('[UC-RELEASE-002] o runtimePaths carregado de uma pasta de programa lê o arquivo dela no require', () => {
    const root = programDir(JSON.stringify({ dados: absolute('dados-mod'), conteudo: absolute('conteudo-mod'), cursosArquivados: absolute('arquivados-mod') }));
    fs.mkdirSync(path.join(root, 'backend'), { recursive: true });
    fs.copyFileSync(require.resolve('../../backend/runtimePaths.js'), path.join(root, 'backend', 'runtimePaths.js'));
    const env = { ...process.env };
    ['ICLASS_DATA_DIR', 'ICLASS_CONTENT_DIR', 'ICLASS_ARCHIVE_DIR', 'NODE_TEST_CONTEXT'].forEach(name => { delete env[name]; });
    const script = `const p = require(${JSON.stringify(path.join(root, 'backend', 'runtimePaths.js'))}); console.log(JSON.stringify({ d: p.DATA_DIR, c: p.CONTENT_DIR, a: p.ARCHIVE_DIR, b: p.BACKUPS_DIR, e: p.ASSIGNMENT_FILES_DIR, u: p.UPLOADS_DIR, o: p.FOLDERS_SOURCE, f: p.FOLDERS_FILE }))`;
    const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const paths = JSON.parse(result.stdout.trim());
    assert.equal(paths.d, absolute('dados-mod'));
    assert.equal(paths.c, absolute('conteudo-mod'));
    assert.equal(paths.a, absolute('arquivados-mod'));
    assert.equal(paths.b, path.join(absolute('dados-mod'), 'backups'));
    assert.equal(paths.e, path.join(absolute('dados-mod'), 'entregas'));
    assert.equal(paths.u, path.join(absolute('dados-mod'), 'uploads'));
    assert.deepEqual(paths.o, { DATA_DIR: 'arquivo', CONTENT_DIR: 'arquivo', ARCHIVE_DIR: 'arquivo' });
    assert.equal(paths.f, path.join(root, 'iclass-pastas.json'));

    // Arquivo estragado: o processo sobe com o padrão e o aviso vai para o console.
    fs.writeFileSync(path.join(root, 'iclass-pastas.json'), 'não é json');
    const broken = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    assert.equal(broken.status, 0, broken.stderr);
    assert.equal(JSON.parse(broken.stdout.trim()).d, path.join(root, 'data'));
    assert.match(broken.stderr, /iclass-pastas\.json está ilegível/);
});
