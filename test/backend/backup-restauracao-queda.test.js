// Restauração interrompida no meio (decisões do coordenador §12, sobra do H4a). Antes,
// uma queda do processo (falta de luz, kill) durante o applyRestore, depois de copiar as
// teclas do backup ou de trocar as pastas, deixava o banco de antes com as teclas e as
// pastas do backup: o boot só devolvia a pasta "anterior" quando o destino faltava. Agora
// a restauração grava um marcador antes da primeira mudança, e o boot seguinte desfaz
// tudo (banco, teclas, pastas e cursos arquivados) e registra na auditoria. Cada caso
// derruba o processo de verdade (SIGKILL) num ponto da restauração.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-restauracao-queda-'));
const child = path.join(__dirname, 'fixtures', 'restore-crash-child.js');

function run(dataDir, args, extraEnv = {}) {
    const env = {
        ...process.env,
        ICLASS_DATA_DIR: path.join(dataDir, 'data'),
        ICLASS_CONTENT_DIR: path.join(dataDir, 'content'),
        ICLASS_ARCHIVE_DIR: path.join(dataDir, 'cursos_arquivados'),
        TEST_MODE: '1',
        ...extraEnv,
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [child, ...args], { env, encoding: 'utf8', timeout: 60000 });
    const output = result.stdout || '';
    const at = output.lastIndexOf('@@');
    return { status: result.status, signal: result.signal, body: at >= 0 ? JSON.parse(output.slice(at + 2)) : null, output: `${output}\n${result.stderr || ''}` };
}

test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// Cada ponto: logo depois do marcador (nada mudou), depois de trocar a primeira pasta,
// depois de acrescentar o curso arquivado, depois de copiar as teclas do backup e depois
// de gravar o banco restaurado (antes de apagar o marcador).
for (const point of ['marcador', 'pasta', 'cursos', 'teclas', 'banco']) {
    test(`[UC-BACKUP-003] queda no meio da restauração (${point}): o boot seguinte desfaz tudo e registra na auditoria`, () => {
        const dataDir = fs.mkdtempSync(path.join(tempRoot, `${point}-`));
        const prepared = run(dataDir, ['preparar']);
        assert.equal(prepared.status, 0, prepared.output);
        const before = prepared.body.state;
        assert.deepEqual(before.students, ['atual@queda.local']);
        assert.equal(before.teclas, 5);

        const crashed = run(dataDir, ['restaurar', prepared.body.zip], { ICLASS_TEST_RESTORE_CRASH_AT: point });
        assert.equal(crashed.signal, 'SIGKILL', `o processo devia cair no ponto ${point}:\n${crashed.output}`);
        assert.ok(fs.existsSync(path.join(dataDir, 'data', '.restauracao-desfazer', 'marcador.json')), 'o marcador ficou');

        const booted = run(dataDir, ['boot']);
        assert.equal(booted.status, 0, booted.output);
        const after = booted.body.state;
        assert.deepEqual(after.students, before.students, 'o banco voltou ao de antes');
        assert.equal(after.teclas, before.teclas, 'as teclas voltaram às de antes');
        assert.equal(after.content, before.content);
        assert.deepEqual(after.uploads, before.uploads);
        assert.deepEqual(after.alunos, before.alunos);
        assert.deepEqual(after.arquivados, before.arquivados, 'o curso arquivado acrescentado saiu');
        assert.equal(after.marcador, false, 'o marcador saiu');
        assert.deepEqual(after.sobrasDeTroca, [], 'nenhuma pasta de troca ficou para trás');
        assert.equal(after.network, 'local');
        assert.equal(after.auditoria.length, 1, JSON.stringify(after.auditoria));
        assert.equal(after.auditoria[0].actor, 'sistema');
        assert.equal(after.auditoria[0].details.desfeita, true);
        assert.match(booted.output, /restauração de backup foi interrompida no meio/);
        assert.match(fs.readFileSync(path.join(dataDir, 'data', 'crash.log'), 'utf8'), /restauração interrompida/);

        // E a restauração de novo, sem queda, funciona e não deixa marcador.
        const again = run(dataDir, ['restaurar', prepared.body.zip]);
        assert.equal(again.status, 0, again.output);
        assert.deepEqual(again.body.state.students, ['do-backup@queda.local']);
        assert.equal(again.body.state.teclas, 3);
        assert.deepEqual(again.body.state.arquivados, ['curso_2024']);
        assert.equal(again.body.state.marcador, false);
    });
}

test('[UC-BACKUP-003] boot sem marcador não mexe em nada nem registra queda', () => {
    const dataDir = fs.mkdtempSync(path.join(tempRoot, 'sem-marcador-'));
    const prepared = run(dataDir, ['preparar']);
    assert.equal(prepared.status, 0, prepared.output);
    const booted = run(dataDir, ['boot']);
    assert.equal(booted.status, 0, booted.output);
    assert.deepEqual(booted.body.state.students, prepared.body.state.students);
    assert.equal(booted.body.state.teclas, prepared.body.state.teclas);
    assert.deepEqual(booted.body.state.auditoria, []);
});
