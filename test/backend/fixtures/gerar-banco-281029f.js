// Gera test/backend/fixtures/banco-281029f.db: o banco de um IClass na versão 281029f (o
// main da fase 2, a versão que o Alan tem hoje) semeado com os dados de demonstração e
// usado um pouco pela API. É a base dos testes de migração do A0 (P6-S1): o primeiro boot
// do código novo sobre este banco faz o backup 'pre-atualizacao' e aplica as migrações;
// dois boots seguidos dão o mesmo banco. Não é teste (não roda na suíte). Para gerar de novo:
//   mkdir /tmp/v281029f && git archive 281029f backend content package.json | tar -x -C /tmp/v281029f
//   ln -s "$PWD/node_modules" /tmp/v281029f/node_modules
//   node test/backend/fixtures/gerar-banco-281029f.js /tmp/v281029f test/backend/fixtures/banco-281029f.db
// O arquivo sai compacto (VACUUM INTO), em modo WAL como o de uma instalação, sem -wal e
// sem as sessões (auth_sessions vazia): o teste copia para uma pasta temporária antes de
// subir.
const fs = require('fs');
const os = require('os');
const path = require('path');

const [oldRootArg, outputArg] = process.argv.slice(2);
if (!oldRootArg || !outputArg) {
    console.error('Uso: node gerar-banco-281029f.js <pasta com o código 281029f> <arquivo de saída .db>');
    process.exit(2);
}
const oldRoot = path.resolve(oldRootArg);
const output = path.resolve(outputArg);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-banco-281029f-'));
const contentDir = path.join(tempRoot, 'content');
fs.cpSync(path.join(oldRoot, 'content'), contentDir, { recursive: true });
process.env.ICLASS_DATA_DIR = path.join(tempRoot, 'data');
process.env.ICLASS_CONTENT_DIR = contentDir;
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';
delete process.env.ICLASS_VERIFY_SAVES;

const request = require(path.join(oldRoot, 'node_modules/supertest'));
const sqlite3 = require(path.join(oldRoot, 'node_modules/sqlite3'));
const db = require(path.join(oldRoot, 'backend/database.js'));
const { createApp } = require(path.join(oldRoot, 'backend/server.js'));

function run(connection, sql, params = []) {
    return new Promise((resolve, reject) => connection.run(sql, params, err => (err ? reject(err) : resolve())));
}

(async () => {
    await db.init();
    const app = createApp();
    await request(app).post('/api/test/seed').send({}).expect(200);
    // Uso pela API, como a tela faz: login do professor e do aluno (sessões, registro de
    // login e presença automática) e uma dúvida no fórum.
    const admin = await request(app).post('/api/session/admin-login').send({ email: 'admin@teste.local', password: 'teste' });
    const adminToken = admin.body && (admin.body.sessionToken || admin.body.token);
    const student = await request(app).post('/api/student/login').send({ email: 'aluno@teste.local', password: 'teste' });
    const studentToken = student.body && (student.body.sessionToken || student.body.token);
    if (studentToken) {
        await request(app).post('/api/forum/comment').set('x-session-token', studentToken)
            .send({ key: 'geral', text: 'Dúvida da base 281029f', courseId: 'curso_legacy_01', studentClass: '1DES' }).expect(200);
    }
    if (adminToken) {
        await request(app).get('/api/admin/whoami').set('x-admin-session', adminToken);
    }
    await db.save();
    await db.close();
    const source = path.join(process.env.ICLASS_DATA_DIR, 'database.db');
    fs.rmSync(output, { force: true });
    const connection = new sqlite3.Database(source);
    await run(connection, 'VACUUM INTO ?', [output]);
    await new Promise(resolve => connection.close(() => resolve()));
    const copy = new sqlite3.Database(output);
    await run(copy, 'DELETE FROM auth_sessions');
    await run(copy, 'VACUUM');
    // Modo WAL gravado no cabeçalho, como o banco de uma instalação 281029f.
    await run(copy, 'PRAGMA journal_mode = WAL');
    await new Promise(resolve => copy.close(() => resolve()));
    fs.rmSync(tempRoot, { recursive: true, force: true });
    console.log(`Banco 281029f gerado em ${output} (${fs.statSync(output).size} bytes).`);
    process.exit(0);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
