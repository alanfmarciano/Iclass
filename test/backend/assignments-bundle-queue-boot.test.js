// Regravação pendente do pacote de curso excluído depois de desligar e religar o servidor
// (fase 3, C18, J2: pendência LGPD do C10). Anonimizar o aluno regrava o pacote do curso
// excluído (cursos_arquivados/<pasta>/curso.json) para tirar dele a entrega; quando essa
// regravação falha (arquivo preso pelo antivírus, disco cheio), a mudança fica pendente e
// é tentada de novo depois. Antes, a pendência ficava só na memória: com o servidor
// desligado antes da próxima gravação ela se perdia, o pacote continuava com o texto, o
// nome do arquivo e o e-mail, e restaurar o curso trazia a entrega de volta. Agora a fila
// fica no banco (assignmentBundleRewrites) e o boot (server.js prepareServer) a relê e
// regrava o pacote.
//
// O caso usa dois processos: o primeiro anonimiza com a escrita do pacote falhando e
// desliga; o segundo é o servidor de verdade (fixtures/server-main-child.js) subindo sobre
// o mesmo banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const proc = require('./fixtures/server-process.js');

const REPO = path.resolve(__dirname, '..', '..');
const childScript = path.join(__dirname, 'fixtures', 'server-main-child.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-bundle-queue-boot-'));
const archiveDir = path.join(dataDir, 'archives');
const ADMIN = 'adm@fila-boot.local';
const ALUNA = 'iris@fila-boot.local';
const SENHA = 'Senha-forte-2026';

function childEnv() {
    const env = { ...process.env, ICLASS_DATA_DIR: dataDir, ICLASS_CONTENT_DIR: path.join(dataDir, 'content'), ICLASS_ARCHIVE_DIR: archiveDir, TEST_MODE: '1' };
    delete env.NODE_TEST_CONTEXT;
    return env;
}

// Primeiro processo: curso com uma entrega da Íris (que também é de uma turma de outro
// curso e por isso continua no cadastro), curso excluído (vai para o pacote), a Íris sai da escola e é anonimizada com a escrita do pacote falhando; depois o processo
// fecha o banco e sai, sem nenhuma outra gravação que levasse a regravação.
function firstRun() {
    const requireOf = rel => JSON.stringify(path.join(REPO, rel));
    const code = `
        const fs = require('node:fs');
        const path = require('node:path');
        const request = require(${requireOf('node_modules/supertest')});
        const db = require(${requireOf('backend/database.js')});
        const assignments = require(${requireOf('backend/utils/assignments.js')});
        const { createAdminSession } = require(${requireOf('backend/utils/authSessions.js')});
        const { createApp } = require(${requireOf('backend/server.js')});
        const HOUR = 3600000;
        (async () => {
            await db.init();
            const app = createApp();
            db.memory.courses = [{ id: 'curso-fila', name: 'Curso da fila', structure: [] }, { id: 'curso-fica', name: 'Curso que fica', structure: [] }];
            db.memory.classes = [{ name: '1FIL', courseId: 'curso-fila', period: 'Manhã' }, { name: '2FIC', courseId: 'curso-fica', period: 'Tarde' }];
            db.memory.students = [{ id: 'alu_000000000000f1f1', name: 'Íris Lima', email: ${JSON.stringify(ALUNA)}, matricula: 'MF-1', status: 'Ativo', password: db.hashPassword(${JSON.stringify(SENHA)}), classes: [{ name: '1FIL', courseId: 'curso-fila' }, { name: '2FIC', courseId: 'curso-fica' }] }];
            db.memory.admins = [{ email: ${JSON.stringify(ADMIN)}, name: 'Adm', role: 'admin', password: db.hashPassword(${JSON.stringify(SENHA)}) }];
            const task = assignments.newAssignmentRecord({ courseId: 'curso-fila', studentClass: '1FIL', title: 'Relatório', response: { files: false, text: true, link: false }, dueAt: Date.now() + 72 * HOUR, status: 'publicada' }, { actor: ${JSON.stringify(ADMIN)}, now: Date.now() - 24 * HOUR });
            db.memory.assignments = [task];
            const sub = assignments.newSubmissionRecord(task, db.memory.students[0], { now: Date.now() - 2 * HOUR });
            sub.versions = [{ n: 1, requestAt: Date.now() - HOUR, receivedAt: Date.now() - HOUR, late: false, lateMs: 0, text: 'TXT_IRIS', link: '', files: [], ip: '10.0.0.9', device: 'Celular' }];
            sub.status = 'enviada';
            db.memory.assignmentSubmissions = [sub];
            await db.save();
            const token = createAdminSession(db.memory, ${JSON.stringify(ADMIN)});
            const archived = await request(app).post('/api/admin/courses/curso-fila/purge').set('x-admin-session', token).send({});
            if (archived.status !== 200) throw new Error('purge: ' + archived.status + ' ' + JSON.stringify(archived.body));
            const folder = archived.body.folder;
            const bundleFile = path.join(${JSON.stringify(archiveDir)}, folder, 'curso.json');
            db.memory.students[0].status = 'Transferido';
            db.memory.students[0].statusChangedAt = Date.now() - HOUR;
            await db.save();
            const realWrite = fs.writeFileSync;
            fs.writeFileSync = function (target, ...rest) {
                if (String(target).startsWith(bundleFile)) { const error = new Error('EBUSY simulado'); error.code = 'EBUSY'; throw error; }
                return realWrite.call(this, target, ...rest);
            };
            console.error = () => {};
            const res = await request(app).post('/api/admin/students/anonymize').set('x-admin-session', token).send({ email: ${JSON.stringify(ALUNA)}, confirm: 'ANONIMIZAR', reason: 'Pedido da família' });
            if (res.status !== 200) throw new Error('anonymize: ' + res.status + ' ' + JSON.stringify(res.body));
            await db.close();
            process.stdout.write('@@' + JSON.stringify({ folder, subId: sub.id }) + '\\n');
            process.exit(0);
        })().catch(err => { process.stdout.write('ERRO ' + (err && err.stack || err) + '\\n'); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', code], { env: childEnv(), encoding: 'utf8', cwd: REPO, timeout: 60000 });
    const line = String(result.stdout || '').split('\n').find(item => item.startsWith('@@'));
    assert.ok(line, `primeiro processo: ${result.stdout}\n${result.stderr}`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(line.slice(2));
}

function queueRows() {
    return new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(path.join(dataDir, 'database.db'), sqlite3.OPEN_READONLY);
        connection.all('SELECT * FROM assignment_bundle_rewrites', (err, rows) => {
            connection.close(() => (err ? reject(err) : resolve(rows)));
        });
    });
}

test.after(() => {
    proc.killAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('[UC-ENCERRADOS-002] regravação do pacote do curso excluído falhou e o servidor desligou: a fila fica no banco, o boot seguinte regrava o pacote e restaurar o curso não traz a entrega de volta', async () => {
    const { folder, subId } = firstRun();
    const bundleFile = path.join(archiveDir, folder, 'curso.json');
    // Desligado: o pacote ainda tem o dado, mas a pendência está gravada no banco.
    assert.equal(fs.readFileSync(bundleFile, 'utf8').includes('TXT_IRIS'), true);
    const pending = await queueRows();
    assert.equal(pending.length, 1, 'a regravação pendente foi gravada no banco');
    assert.equal(JSON.stringify(pending).includes(folder), true);
    ['TXT_IRIS', ALUNA].forEach(piece => assert.equal(JSON.stringify(pending).includes(piece), false, `a fila não guarda ${piece}`));

    // Religa: o boot relê a fila e regrava o pacote.
    const server = proc.launch(childScript, { dataDir, port: await proc.freePort() });
    await proc.waitForHealth(server.base, { exited: server.exited });
    await proc.waitFor(() => !fs.readFileSync(bundleFile, 'utf8').includes('TXT_IRIS'), { what: 'pacote regravado no boot' });
    const bundleText = fs.readFileSync(bundleFile, 'utf8');
    ['TXT_IRIS', ALUNA].forEach(piece => assert.equal(bundleText.includes(piece), false, piece));
    assert.match(server.output(), /Pacotes de curso: 1 regravação\(ões\) pendente\(s\) concluída\(s\)/);

    // Restaurar o curso traz a entrega anonimizada.
    const admin = await proc.call(server.base, '/api/session/admin-login', { method: 'POST', body: { email: ADMIN, password: SENHA } });
    assert.equal(admin.status, 200, admin.text);
    const restored = await proc.call(server.base, '/api/admin/archived-courses/restore', { method: 'POST', headers: { 'x-admin-session': admin.body.sessionToken }, body: { folder } });
    assert.equal(restored.status, 200, restored.text);
    server.child.kill('SIGTERM');
    await server.exited;

    assert.equal((await queueRows()).length, 0, 'a fila esvaziou');
    const connection = new sqlite3.Database(path.join(dataDir, 'database.db'), sqlite3.OPEN_READONLY);
    const dump = await new Promise((resolve, reject) => connection.all('SELECT * FROM assignment_submissions', (err, rows) => connection.close(() => (err ? reject(err) : resolve(rows)))));
    const text = JSON.stringify(dump);
    assert.equal(text.includes(subId), true, 'a entrega voltou com o curso');
    ['TXT_IRIS', ALUNA].forEach(piece => assert.equal(text.includes(piece), false, `a entrega restaurada não traz ${piece}`));
});
