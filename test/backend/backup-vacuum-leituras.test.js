// VACUUM INTO do backup com leituras diretas na mesma conexão (decisões §12, sobra do H4b
// na J3). Antes, o backup automático do boot falhava às vezes com "SQLITE_ERROR: cannot
// VACUUM - SQL statements in progress": o SELECT 1 do db.ping (o /api/health que o
// launcher e o Reiniciar consultam na subida) ou uma consulta do store de teclas (a
// digitação ao vivo do Monitor) começava um instante antes do runExclusive do snapshotTo,
// e a guarda writer.status().running do ping não cobria a consulta já em andamento. Agora
// toda leitura direta conta até o sqlite responder, o VACUUM espera o contador zerar e,
// se ainda vier "SQL statements in progress", tenta de novo (até 5 vezes, 200 ms).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-vacuum-test-'));
process.env.ICLASS_DATA_DIR = path.join(tempRoot, 'data');
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'cursos_arquivados');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const backup = require('../../backend/utils/backup.js');

const EMAIL = 'leitura@vacuum.local';

test.before(async () => {
    await db.init();
    db.memory.students = [{ name: 'Leitura', email: EMAIL, status: 'Ativo', classes: [] }];
    const now = Date.now();
    // Teclas o bastante para a consulta do Monitor levar alguns milissegundos.
    const rows = Array.from({ length: 30000 }, (_, index) => ({
        id: `k${index}`, studentEmail: EMAIL, studentClass: '1DES', courseId: 'c1', examKey: 'Prova_Vacuum',
        applicationId: 'app_vacuum', attemptId: 'att_1', seq: index + 1, clientTs: now + index, serverTs: now + index,
        key: 'a', code: 'KeyA', mods: '', kind: 'char', question: null, blocked: false, suspicious: false,
    }));
    for (let start = 0; start < rows.length; start += 5000) db.keystrokes.append(rows.slice(start, start + 5000));
    await db.save();
});

test.after(async () => {
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

// Leituras diretas sem parar: pings que furam o resultado guardado (now no futuro) e a
// consulta do Monitor, como o launcher e a tela fazem durante o backup.
function startReaders() {
    let stop = false;
    let fakeNow = Date.now();
    const loops = [
        (async () => {
            while (!stop) {
                fakeNow += 10000;
                await db.ping({ now: fakeNow });
                await new Promise(resolve => setImmediate(resolve));
            }
        })(),
        (async () => {
            while (!stop) {
                await db.keystrokes.query({ email: EMAIL, examKey: 'Prova_Vacuum', applicationId: 'app_vacuum', limit: 2000 });
            }
        })(),
        (async () => {
            while (!stop) {
                await db.keystrokes.exportRows();
            }
        })(),
    ];
    return async () => { stop = true; await Promise.all(loops); };
}

test('[UC-BACKUP-007] snapshotTo com pings e consultas do Monitor em andamento não falha com "SQL statements in progress"', async () => {
    const stopReaders = startReaders();
    try {
        for (let round = 0; round < 10; round += 1) {
            const file = path.join(tempRoot, `copia-${round}.db`);
            const info = await db.snapshotTo(file);
            assert.equal(info.quickCheck, 'ok', `rodada ${round}`);
            assert.ok(fs.existsSync(file));
        }
    } finally {
        await stopReaders();
    }
});

test('[UC-BACKUP-007] "Fazer backup agora" e Compactar com o cartão Saúde consultando o banco', async () => {
    const stopReaders = startReaders();
    try {
        for (let round = 0; round < 5; round += 1) {
            const saved = await backup.createBackup({ origem: 'manual', variante: 'dados', dir: path.join(tempRoot, 'backups') });
            assert.ok(fs.existsSync(saved.file), `rodada ${round}`);
        }
        const compacted = await db.compactDatabase();
        assert.ok(compacted.after, 'compactar terminou');
    } finally {
        await stopReaders();
    }
});
