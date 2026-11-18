// Marcador da restauração em andamento (decisões §12, revisão do H4b), no mesmo processo:
// - o marcador fica em data/.restauracao/desfazer (dentro de .restauracao, como pede o
//   contrato "Arquivos fora do banco"), e a limpeza do boot apaga o resto de .restauracao,
//   nunca ele;
// - o fim da restauração apaga primeiro o marcador.json: antes, fs.rmSync na pasta inteira
//   podia falhar no meio (antes.db preso pelo antivírus no Windows) e deixar o marcador, e
//   o boot seguinte "desfazia" uma restauração que deu certo;
// - pasta de preparo deixada por uma queda depois do fim da restauração sai no boot;
// - o desligamento no meio de uma restauração a interrompe no próximo passo e ela se
//   desfaz ainda com o banco aberto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-marcador-test-'));
process.env.ICLASS_DATA_DIR = path.join(tempRoot, 'data');
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'cursos_arquivados');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const backup = require('../../backend/utils/backup.js');

const MARKER = path.join(backup.UNDO_DIR, 'marcador.json');

function students(...emails) {
    db.memory.students = emails.map(email => ({ name: email.split('@')[0], email, status: 'Ativo', classes: [] }));
}

function emails() {
    return (db.memory.students || []).map(student => student.email);
}

// Um marcador de verdade: o antes.db é uma cópia do banco com o aluno "antes".
async function writeMarker() {
    fs.rmSync(backup.UNDO_DIR, { recursive: true, force: true });
    fs.mkdirSync(backup.UNDO_DIR, { recursive: true });
    await db.snapshotTo(path.join(backup.UNDO_DIR, 'antes.db'));
    fs.writeFileSync(MARKER, JSON.stringify({ id: 'abc', iniciadoEm: new Date().toISOString(), banco: 'antes.db', pastas: [], conteudo: [], cursos: [], teclas: false }));
}

// fs.rmSync que falha (EBUSY, como o arquivo preso no Windows) para os caminhos dados.
function lockedRm(paths, fn) {
    const original = fs.rmSync;
    const locked = new Set(paths.map(item => path.resolve(item)));
    fs.rmSync = (target, options) => {
        if (locked.has(path.resolve(String(target)))) throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${target}'`), { code: 'EBUSY' });
        return original(target, options);
    };
    try { return fn(); } finally { fs.rmSync = original; }
}

test.before(async () => {
    fs.mkdirSync(runtimePaths.CONTENT_DIR, { recursive: true });
    await db.init();
});

test.after(async () => {
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-BACKUP-003] o marcador fica em data/.restauracao/desfazer e a limpeza do boot não o apaga', () => {
    assert.equal(backup.UNDO_DIR, path.join(runtimePaths.DATA_DIR, '.restauracao', 'desfazer'));
    fs.mkdirSync(backup.UNDO_DIR, { recursive: true });
    fs.writeFileSync(MARKER, '{}');
    const inbox = path.join(backup.RESTORE_DIR, 'envios');
    const staging = path.join(backup.RESTORE_DIR, 'abc123');
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'enviado.zip'), 'x');
    backup.cleanWorkDirs();
    assert.equal(fs.existsSync(inbox), false, 'envios saem');
    assert.equal(fs.existsSync(staging), false, 'prévias extraídas saem');
    assert.equal(fs.existsSync(MARKER), true, 'o marcador fica para o boot seguinte');
    fs.rmSync(backup.UNDO_DIR, { recursive: true, force: true });
});

test('[UC-BACKUP-003] fim da restauração com o antes.db preso: o marcador.json sai primeiro e o boot não desfaz nada', async () => {
    students('antes@marcador.local');
    await db.save();
    await writeMarker();
    students('restaurado@marcador.local');
    await db.save();

    // A pasta não sai (antes.db preso), mas o marcador.json já saiu: a restauração vale.
    const definitive = lockedRm([backup.UNDO_DIR], () => backup.clearUndoMarker());
    assert.equal(definitive, true);
    assert.equal(fs.existsSync(MARKER), false, 'o marcador.json saiu antes do resto da pasta');
    assert.equal(fs.existsSync(path.join(backup.UNDO_DIR, 'antes.db')), true, 'o antes.db ficou (preso)');

    assert.equal(await backup.recoverInterruptedRestore(), null, 'nada a desfazer');
    assert.deepEqual(emails(), ['restaurado@marcador.local'], 'o boot não voltou ao banco de antes');
    assert.equal(fs.existsSync(backup.UNDO_DIR), false, 'a sobra sai no boot');
    assert.equal((db.memory.auditLogs || []).some(entry => entry.action === 'backup_restore_interrupted'), false);
});

test('[UC-BACKUP-003] marcador.json que não sai nem com novas tentativas: "concluida" ao lado, e o boot não desfaz', async () => {
    students('antes@marcador.local');
    await db.save();
    await writeMarker();
    students('restaurado@marcador.local');
    await db.save();

    const definitive = lockedRm([MARKER], () => backup.clearUndoMarker());
    assert.equal(definitive, true);
    assert.equal(fs.existsSync(MARKER), true, 'o marcador ficou (preso)');
    assert.equal(fs.existsSync(path.join(backup.UNDO_DIR, 'concluida')), true);

    assert.equal(await backup.recoverInterruptedRestore(), null);
    assert.deepEqual(emails(), ['restaurado@marcador.local']);
    assert.equal(fs.existsSync(backup.UNDO_DIR), false);

    // Sem nenhum dos dois (nem o "concluida" pôde ser gravado): quem chama fica sabendo, e o
    // boot desfaz (a restauração inteira volta).
    await writeMarker();
    const original = fs.writeFileSync;
    fs.writeFileSync = (file, ...rest) => {
        if (String(file).endsWith('concluida')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        return original(file, ...rest);
    };
    try {
        assert.equal(lockedRm([MARKER], () => backup.clearUndoMarker()), false);
    } finally {
        fs.writeFileSync = original;
    }
    const summary = await backup.recoverInterruptedRestore();
    assert.equal(summary.desfeita, true);
    fs.rmSync(backup.UNDO_DIR, { recursive: true, force: true });
});

test('[UC-BACKUP-003] pasta de preparo de uma restauração que terminou (marcador já fora) sai no boot; a de troca pendente e a do formato antigo ficam', () => {
    const parent = path.dirname(runtimePaths.UPLOADS_DIR);
    // As pastas de destino existem (sem elas, a "anterior" do formato antigo voltaria para
    // o lugar, como sempre).
    [runtimePaths.UPLOADS_DIR, runtimePaths.STUDENTS_DIR, runtimePaths.CONTENT_DIR, runtimePaths.ARCHIVE_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'novo.pdf'), 'novo');
    const finished = path.join(parent, `.iclass-restauracao-a1b2c3-${path.basename(runtimePaths.UPLOADS_DIR)}`);
    const legacy = path.join(parent, '.iclass-restauracao-d4e5f6');
    for (const prep of [finished, legacy]) {
        fs.mkdirSync(path.join(prep, 'anterior'), { recursive: true });
        fs.writeFileSync(path.join(prep, 'anterior', 'velho.pdf'), 'velho');
    }

    // Restauração a desfazer (marcador presente): a "anterior" é dela, fica.
    fs.mkdirSync(backup.UNDO_DIR, { recursive: true });
    fs.writeFileSync(MARKER, '{}');
    backup.cleanWorkDirs();
    assert.equal(fs.existsSync(finished), true);
    fs.rmSync(backup.UNDO_DIR, { recursive: true, force: true });

    backup.cleanWorkDirs();
    assert.equal(fs.existsSync(finished), false, 'a restauração terminou: a "anterior" sai, como sairia no fim dela');
    assert.equal(fs.existsSync(legacy), true, 'formato antigo (sem saber se terminou) fica guardado');
    assert.deepEqual(fs.readdirSync(runtimePaths.UPLOADS_DIR), ['novo.pdf']);
    fs.rmSync(legacy, { recursive: true, force: true });
});

test('[UC-BACKUP-003] desligamento no meio de uma restauração: ela para antes da próxima mudança e se desfaz com o banco aberto', async () => {
    students('antes@marcador.local');
    await db.save();
    const snapshot = { type: 'iclass-backup-data', version: '3.0', exportedAt: new Date().toISOString(), data: { ...backup.buildDataSnapshot().data, students: [{ name: 'Do backup', email: 'backup@marcador.local', status: 'Ativo', classes: [] }] } };

    // A restauração para no backup de segurança (cópia do banco) até o desligamento chegar.
    const original = db.snapshotTo;
    let release;
    const reached = new Promise(resolve => {
        db.snapshotTo = async (...args) => {
            resolve();
            await new Promise(done => { release = done; });
            return original.apply(db, args);
        };
    });
    const keepAlive = setInterval(() => {}, 1000);
    try {
        const restoring = backup.restoreDataSnapshot(snapshot).then(() => null, error => error);
        await reached;
        const settling = backup.settleForShutdown({ waitMs: 20, abortWaitMs: 20, restoreAbortWaitMs: 5000 });
        await new Promise(resolve => setTimeout(resolve, 40));
        release();
        const settled = await settling;
        assert.deepEqual(settled, { waited: true, aborted: true, finished: true }, 'a restauração terminou (desfeita) antes de o banco fechar');
        const error = await restoring;
        assert.ok(error, 'a restauração foi interrompida');
        assert.equal(error.restoreAborted, true);
        assert.equal(error.status, 503);
        assert.match(error.message, /nada foi alterado/);
    } finally {
        db.snapshotTo = original;
        clearInterval(keepAlive);
    }
    assert.deepEqual(emails(), ['antes@marcador.local'], 'nada mudou');
    assert.equal(fs.existsSync(MARKER), false, 'nenhum marcador sobrou');
    assert.equal(backup.backupInProgress(), null);
});
