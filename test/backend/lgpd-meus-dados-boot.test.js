// "Meus dados" e a exportação do administrador sobre um banco com resposta antiga do
// fórum sem e-mail (decisões §12, sobra do H8c). O caso sobe o servidor de verdade num
// processo próprio (fixtures/server-main-child.js), para a migração do boot (server.js
// prepareServer) preencher o e-mail e marcar authorEmailInferred como faz na máquina do
// Alan, e confere as duas cópias pela API. Antes, a resposta antiga sem e-mail e sem
// papel de aluno (authorRole ausente, de versão muito antiga, ou com outro texto)
// aparecia como "Equipe", com o texto de quem escreveu, na cópia do dono da dúvida.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proc = require('./fixtures/server-process.js');

const REPO = path.resolve(__dirname, '..', '..');
const childScript = path.join(__dirname, 'fixtures', 'server-main-child.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-meus-dados-boot-'));

const ADMIN = 'adm@meusdados-boot.local';
const ANA = 'ana@meusdados-boot.local';
const SENHA = 'Caderno-Azul-7';

// Banco do jeito que uma versão antiga deixava: respostas de aluno sem authorEmail, uma
// sem authorRole e outra com um papel que não é 'Aluno' nem 'Instrutor'.
function seedDatabase() {
    const code = `
        const db = require(${JSON.stringify(path.join(REPO, 'backend', 'database.js'))});
        (async () => {
            await db.init();
            db.memory.admins = [{ email: ${JSON.stringify(ADMIN)}, name: 'Administração', role: 'admin', password: db.hashPassword(${JSON.stringify(SENHA)}) }];
            db.memory.courses = [{ id: 'DES', name: 'Desenvolvimento' }];
            db.memory.classes = [{ name: '1DES', courseId: 'DES', status: 'active', releasedItems: {} }];
            db.memory.students = [{ name: 'Ana Souza', email: ${JSON.stringify(ANA)}, status: 'Ativo', password: db.hashPassword(${JSON.stringify(SENHA)}), classes: [{ name: '1DES', courseId: 'DES' }], studentClass: '1DES' }];
            db.memory.forum = [{
                id: 'f_ana', key: 'Apostila_1', studentName: 'Ana Souza', studentEmail: ${JSON.stringify(ANA)}, text: 'Minha dúvida', timestamp: '2025-03-01T10:00:00.000Z',
                replies: [
                    { id: 'r_prof', authorName: 'Professora Paula', authorRole: 'Instrutor', text: 'Resposta da professora', timestamp: '2025-03-01T11:00:00.000Z' },
                    { id: 'r_sem_papel', authorName: 'Carla Antiga', text: 'Texto antigo da Carla', timestamp: '2025-03-01T12:00:00.000Z' },
                    { id: 'r_outro_papel', authorName: 'Diego Antigo', authorRole: 'aluno', text: 'Texto antigo do Diego', timestamp: '2025-03-01T13:00:00.000Z' },
                ],
            }];
            await db.save();
            await db.close();
        })().catch(err => { console.error(err); process.exit(1); });
    `;
    const env = { ...process.env, ICLASS_DATA_DIR: dataDir, ICLASS_CONTENT_DIR: path.join(dataDir, 'content'), ICLASS_ARCHIVE_DIR: path.join(dataDir, 'archives'), TEST_MODE: '1' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', cwd: REPO });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

test.after(() => {
    proc.killAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('[UC-LGPD-010] servidor de verdade: resposta antiga sem e-mail, sem papel de aluno, é "Outro aluno" nas duas cópias', async () => {
    seedDatabase();
    const server = proc.launch(childScript, { dataDir, port: await proc.freePort() });
    await proc.waitForHealth(server.base, { exited: server.exited });

    const student = await proc.call(server.base, '/api/student/login', { method: 'POST', body: { email: ANA, password: SENHA } });
    assert.equal(student.status, 200, student.text);
    const mine = await proc.call(server.base, '/api/student/my-data', { headers: { 'x-session-token': student.body.sessionToken } });
    assert.equal(mine.status, 200, mine.text);

    const admin = await proc.call(server.base, '/api/session/admin-login', { method: 'POST', body: { email: ADMIN, password: SENHA } });
    assert.equal(admin.status, 200, admin.text);
    const full = await proc.call(server.base, `/api/admin/lgpd/students/export?email=${encodeURIComponent(ANA)}`, { headers: { 'x-admin-session': admin.body.sessionToken } });
    assert.equal(full.status, 200, full.text);

    for (const [audience, data] of [['aluno', mine.body], ['admin', full.body]]) {
        const replies = data.forum.questions[0].replies;
        assert.deepEqual(replies.map(reply => (reply.mine ? 'eu' : reply.from)), ['Equipe', 'Outro aluno', 'Outro aluno'], audience);
        const text = JSON.stringify(data);
        ['Texto antigo da Carla', 'Carla Antiga', 'Texto antigo do Diego', 'Diego Antigo'].forEach(piece => assert.equal(text.includes(piece), false, `${audience}: ${piece}`));
        assert.equal(data.forum.replies.length, 0, `${audience}: nenhuma resposta antiga conta como dela`);
    }

    server.child.kill('SIGTERM');
    await server.exited;
});
