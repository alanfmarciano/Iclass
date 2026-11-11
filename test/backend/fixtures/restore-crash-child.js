// Processo filho de test/backend/backup-restauracao-queda.test.js: a restauração de um
// backup formato 2 interrompida no meio por uma queda de verdade (SIGKILL no ponto
// ICLASS_TEST_RESTORE_CRASH_AT, só com TEST_MODE=1) e o boot seguinte, que desfaz tudo.
//   node restore-crash-child.js preparar   banco e pastas "do backup", o ZIP, e depois o
//                                          estado "atual" (diferente do backup)
//   node restore-crash-child.js restaurar <zip>   prévia + restauração (cai no ponto)
//   node restore-crash-child.js boot       prepareServer (o boot do servidor) e o estado
// Cada modo escreve o resultado em JSON depois de @@.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../backend/database.js');
const runtimePaths = require('../../../backend/runtimePaths.js');
const backup = require('../../../backend/utils/backup.js');

const mode = process.argv[2];

function keystroke(id) {
    return { id, studentEmail: 'ana@queda.local', studentClass: 'Turma Q', courseId: 'curso-q', examKey: 'Prova_Q', seq: 1, key: 'a', serverTs: Date.now() };
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function read(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function listDir(dir) {
    try { return fs.readdirSync(dir).sort(); } catch (e) { return null; }
}

function setState(label, keystrokeIds) {
    db.memory.students = [{ name: `Aluno ${label}`, email: `${label}@queda.local`, status: 'Ativo', classes: [] }];
    write(path.join(runtimePaths.CONTENT_DIR, 'Apostila_Q.md'), `# ${label}`);
    fs.rmSync(runtimePaths.UPLOADS_DIR, { recursive: true, force: true });
    write(path.join(runtimePaths.UPLOADS_DIR, `${label}.pdf`), `%PDF-${label}`);
    fs.rmSync(runtimePaths.STUDENTS_DIR, { recursive: true, force: true });
    write(path.join(runtimePaths.STUDENTS_DIR, 'ana', `${label}.pdf`), `%PDF-${label}`);
    return db.keystrokes.importRows(keystrokeIds.map(keystroke), { replace: true });
}

async function snapshotState() {
    const parents = [runtimePaths.CONTENT_DIR, runtimePaths.UPLOADS_DIR, runtimePaths.STUDENTS_DIR, runtimePaths.ARCHIVE_DIR].map(dir => path.dirname(dir));
    const swapLeftovers = [...new Set(parents)].flatMap(dir => (listDir(dir) || []).filter(name => name.startsWith('.iclass-restauracao-')));
    return {
        students: db.memory.students.map(student => student.email).filter(email => /@queda\.local$/.test(email)),
        content: read(path.join(runtimePaths.CONTENT_DIR, 'Apostila_Q.md')),
        uploads: listDir(runtimePaths.UPLOADS_DIR),
        alunos: listDir(path.join(runtimePaths.STUDENTS_DIR, 'ana')),
        arquivados: listDir(runtimePaths.ARCHIVE_DIR),
        teclas: db.keystrokes.total(),
        marcador: fs.existsSync(backup.UNDO_DIR),
        sobrasDeTroca: swapLeftovers,
        auditoria: (db.memory.auditLogs || []).filter(entry => entry.action === 'backup_restore_interrupted').map(entry => ({ actor: entry.actor, details: entry.details })),
        network: ((db.memory.config.settings || {}).network || {}).adminAccess || null,
    };
}

(async () => {
    if (mode === 'preparar') {
        await db.init();
        db.memory.config.settings = { ...(db.memory.config.settings || {}), network: { adminAccess: 'local' } };
        const first = setState('do-backup', ['b1', 'b2', 'b3']);
        write(path.join(runtimePaths.ARCHIVE_DIR, 'curso_2024', 'manifesto.json'), '{"folder":"curso_2024"}');
        await db.save();
        await first;
        const saved = await backup.createBackup({ origem: 'manual', variante: 'completo' });
        const zip = path.join(runtimePaths.DATA_DIR, '..', `backup-${process.pid}.zip`);
        fs.renameSync(saved.file, zip);
        // O estado de hoje: outro aluno, outra apostila, outra biblioteca, mais teclas e sem
        // o curso arquivado (a restauração o acrescentaria).
        const second = setState('atual', ['a1', 'a2', 'a3', 'a4', 'a5']);
        fs.rmSync(path.join(runtimePaths.ARCHIVE_DIR, 'curso_2024'), { recursive: true, force: true });
        await db.save();
        await second;
        const state = await snapshotState();
        await db.close();
        process.stdout.write(`@@${JSON.stringify({ zip, state })}`);
        process.exit(0);
    }
    if (mode === 'restaurar') {
        await db.init();
        const { prepared } = await backup.prepareRestore(process.argv[3], { originalName: path.basename(process.argv[3]), keepSource: true });
        await backup.applyPreparedRestore(prepared, {});
        const state = await snapshotState();
        await db.close();
        process.stdout.write(`@@${JSON.stringify({ restored: true, state })}`);
        process.exit(0);
    }
    if (mode === 'boot') {
        const { prepareServer } = require('../../../backend/server.js');
        await prepareServer();
        const state = await snapshotState();
        await db.close();
        process.stdout.write(`@@${JSON.stringify({ state })}`);
        process.exit(0);
    }
    throw new Error(`modo desconhecido: ${mode}`);
})().catch(err => {
    process.stdout.write(`@@${JSON.stringify({ failed: true, message: err && err.message, stack: err && err.stack })}`);
    process.exit(1);
});
