// Fila de regravação do pacote de curso excluído na restauração pela tela Sistema (fase 3,
// C18, rodada 1; pendência LGPD do C10). A fila (assignmentBundleRewrites, restore 'merge'
// e missing 'keep') guarda a mudança do anonimizar/apagar de vez que ainda não chegou ao
// curso.json do pacote em cursos_arquivados. A restauração não mexe em cursos_arquivados,
// então a pendência de agora continua valendo: restaurar um backup de antes da fila (sem a
// coleção) a mantém e restaurar um backup com a fila junta as duas pelo id. Se a pendência
// sumisse, restaurar o curso depois traria de volta a entrega do aluno anonimizado.
// (A restauração pela backup-cli está em backup-cli-restore.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-fila-pacote-restauracao-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const backup = require('../../backend/utils/backup.js');
const { createApp } = require('../../backend/server.js');

const ADMIN = 'admin@fila-restauracao.local';
const TOKEN = 'tok-fila-restauracao';
let app;

function login() {
    const now = Date.now();
    db.memory.adminSessions = { [TOKEN]: { email: ADMIN, createdAt: now, lastSeen: now } };
}

const admin = (method, url) => request(app)[method](url).set('x-admin-session', TOKEN);

function queueRow(id, folder, ids) {
    return { id, schemaVersion: 1, folder, mode: 'anonymize', ids, pseudonimoEmail: 'anonimizado-1a2b3c@sem-email.invalid', at: Date.now() - 1000, criadaEm: Date.now() - 1000 };
}

function restore(snapshot, name) {
    return admin('post', '/api/admin/backup/restore').field('confirm', 'RESTAURAR')
        .attach('file', Buffer.from(JSON.stringify(snapshot)), name);
}

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.admins = [{ email: ADMIN, name: 'Admin', role: 'admin', password: db.hashPassword('senha-admin-fila-ok') }];
    db.memory.assignmentBundleRewrites = [];
    login();
    await db.save();
});

test.after(async () => {
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-ENCERRADOS-002] restaurar pela tela: backup de antes da fila mantém a pendência de agora; backup com a fila junta as duas pelo id', async () => {
    // Pendência de agora (o pacote "curso_a" ainda não foi regravado).
    db.memory.assignmentBundleRewrites = [queueRow('pbr_1_aaaaaa', 'curso_a', ['asub_1_aaaaaa'])];
    await db.save();

    // Backup de antes desta função: o snapshot não traz a coleção.
    const old = backup.buildDataSnapshot();
    delete old.data.assignmentBundleRewrites;
    const restoredOld = await restore(old, 'backup-antes-da-fila.json');
    assert.equal(restoredOld.status, 200, JSON.stringify(restoredOld.body));
    assert.deepEqual(db.memory.assignmentBundleRewrites.map(row => row.id), ['pbr_1_aaaaaa'], 'a pendência de agora continua');
    await db.flush();
    assert.deepEqual((await db.readStoredData()).memory.assignmentBundleRewrites.map(row => row.id), ['pbr_1_aaaaaa'], 'e está gravada');

    // Backup com a fila (outra pendência, de quando ele foi feito): junta pelo id.
    login();
    const withQueue = backup.buildDataSnapshot();
    withQueue.data.assignmentBundleRewrites = [queueRow('pbr_0_bbbbbb', 'curso_b', ['asub_0_bbbbbb']), queueRow('pbr_1_aaaaaa', 'curso_a', ['asub_1_aaaaaa'])];
    db.memory.assignmentBundleRewrites.push(queueRow('pbr_2_cccccc', 'curso_c', ['asub_2_cccccc']));
    await db.save();
    const restoredNew = await restore(withQueue, 'backup-com-a-fila.json');
    assert.equal(restoredNew.status, 200, JSON.stringify(restoredNew.body));
    assert.deepEqual(db.memory.assignmentBundleRewrites.map(row => row.id).sort(), ['pbr_0_bbbbbb', 'pbr_1_aaaaaa', 'pbr_2_cccccc'], 'a do backup e as de agora, sem repetir');
    await db.flush();
    assert.deepEqual((await db.readStoredData()).memory.assignmentBundleRewrites.map(row => row.id).sort(), ['pbr_0_bbbbbb', 'pbr_1_aaaaaa', 'pbr_2_cccccc']);
    // Nada de dado pessoal na fila: só ids, a pasta e o pseudônimo.
    db.memory.assignmentBundleRewrites.forEach(row => assert.deepEqual(Object.keys(row).sort(), ['at', 'criadaEm', 'folder', 'id', 'ids', 'mode', 'pseudonimoEmail', 'schemaVersion']));
});
