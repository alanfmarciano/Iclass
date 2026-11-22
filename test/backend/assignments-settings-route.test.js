// Limites globais das entregas de tarefa (fase 3, C3 / P1-a, D17) pelo POST
// /api/admin/settings. Antes deste caso, valor inválido (texto, negativo, booleano) era
// cortado ou ignorado em silêncio com 200, a resposta do POST trazia o valor gravado e o GET
// o valor com o teto do upload (números diferentes na tela), e subir só o limite por
// arquivo registrava na Auditoria uma mudança do limite por envio que ninguém pediu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-settings-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');

const ADMIN = 'adm@entregas-config.local';
let app;
let token;

function seed(settings = {}) {
    db.memory.config = { ...(db.memory.config || {}), settings };
    db.memory.admins = [{ email: ADMIN, name: 'Admin', role: 'admin', password: db.hashPassword('senha-adm') }];
    db.memory.students = [];
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    db.memory.auditLogs = [];
    token = createAdminSession(db.memory, ADMIN);
}

const post = body => request(app).post('/api/admin/settings').set('x-admin-session', token).send(body);
const get = () => request(app).get('/api/admin/settings').set('x-admin-session', token);
const audits = () => (db.memory.auditLogs || []).filter(entry => entry.action === 'settings_updated');

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('settings.entregas: valor inválido recebe 400 com field e nada é gravado', async () => {
    seed({ timezone: 'America/Sao_Paulo', entregas: { maxMbPorArquivo: 20, maxMbPorEnvio: 50, discoLivreMinimoMb: 2048 } });
    const cases = [
        [{ maxMbPorArquivo: 'abc' }, 'entregas.maxMbPorArquivo', /formato inválido/],
        [{ maxMbPorEnvio: -3 }, 'entregas.maxMbPorEnvio', /deve estar entre 1 e 4\.096/],
        [{ discoLivreMinimoMb: true }, 'entregas.discoLivreMinimoMb', /formato inválido/],
        [{ maxMbPorArquivo: 2.5 }, 'entregas.maxMbPorArquivo', /formato inválido/],
        [{ maxMbPorArquivo: null }, 'entregas.maxMbPorArquivo', /formato inválido/],
        [{ maxMbPorArquivo: '' }, 'entregas.maxMbPorArquivo', /formato inválido/],
        [{ maxMbPorArquivo: 5000 }, 'entregas.maxMbPorArquivo', /deve estar entre 1 e 1\.024/],
        [[20, 50], 'entregas', /formato inválido/],
        ['20', 'entregas', /formato inválido/],
    ];
    for (const [entregas, field, message] of cases) {
        const res = await post({ timezone: 'America/Manaus', entregas });
        assert.equal(res.status, 400, `${JSON.stringify(entregas)}: ${res.status}`);
        assert.equal(res.body.success, false);
        assert.equal(res.body.field, field, JSON.stringify(entregas));
        assert.match(res.body.error, message);
    }
    assert.deepEqual(db.memory.config.settings, { timezone: 'America/Sao_Paulo', entregas: { maxMbPorArquivo: 20, maxMbPorEnvio: 50, discoLivreMinimoMb: 2048 } }, 'nada gravado (nem o fuso do mesmo pedido)');
    assert.equal(audits().length, 0);
});

test('settings.entregas: número digitado como texto vale, e o POST responde o mesmo que o GET', async () => {
    const res = await post({ entregas: { maxMbPorArquivo: '30', maxMbPorEnvio: '60', discoLivreMinimoMb: '1024' } }).expect(200);
    assert.deepEqual(res.body.settings.entregas, { maxMbPorArquivo: 30, maxMbPorEnvio: 60, discoLivreMinimoMb: 1024 });
    assert.deepEqual((await get().expect(200)).body.entregas, res.body.settings.entregas);
    assert.deepEqual(audits()[0].details.changes, [
        { key: 'entregas.maxMbPorArquivo', before: 20, after: 30 },
        { key: 'entregas.maxMbPorEnvio', before: 50, after: 60 },
        { key: 'entregas.discoLivreMinimoMb', before: 2048, after: 1024 },
    ]);
    // null no bloco inteiro: nada muda (como o campo ausente).
    await post({ entregas: null }).expect(200);
    assert.equal(audits().length, 1);
});

test('settings.entregas: teto do upload e envio nunca menor que um arquivo são recusados, sem auditoria de mudança não pedida', async () => {
    // O caso da verificação: upload de 50 MB, o administrador pede 80 MB por arquivo e 10 MB por envio.
    const over = await post({ entregas: { maxMbPorArquivo: 80, maxMbPorEnvio: 10 } });
    assert.equal(over.status, 400);
    assert.equal(over.body.field, 'entregas.maxMbPorArquivo');
    assert.match(over.body.error, /limite de upload do servidor \(50 MB\)/);
    // Só o limite por arquivo acima do limite por envio gravado (50).
    seed({ upload: { maxSizeMb: 100 } });
    const onlyFile = await post({ entregas: { maxMbPorArquivo: 80 } });
    assert.equal(onlyFile.status, 400);
    assert.equal(onlyFile.body.field, 'entregas.maxMbPorArquivo');
    assert.match(onlyFile.body.error, /por envio \(50 MB\) não pode ser menor que o tamanho máximo por arquivo \(80 MB\)/);
    const lowSend = await post({ entregas: { maxMbPorEnvio: 10 } });
    assert.equal(lowSend.status, 400);
    assert.equal(lowSend.body.field, 'entregas.maxMbPorEnvio');
    assert.equal(audits().length, 0, 'nenhuma mudança gravada nem registrada');
    // Subindo os dois juntos, a Auditoria registra só o que foi pedido.
    const both = await post({ entregas: { maxMbPorArquivo: 80, maxMbPorEnvio: 90 } }).expect(200);
    assert.deepEqual(both.body.settings.entregas, { maxMbPorArquivo: 80, maxMbPorEnvio: 90, discoLivreMinimoMb: 2048 });
    assert.deepEqual(audits()[0].details.changes, [
        { key: 'entregas.maxMbPorArquivo', before: 20, after: 80 },
        { key: 'entregas.maxMbPorEnvio', before: 50, after: 90 },
    ]);
});

test('settings.entregas: a tela que salva o bloco inteiro continua salvando ao baixar o upload', async () => {
    seed({ upload: { maxSizeMb: 100 }, entregas: { maxMbPorArquivo: 40, maxMbPorEnvio: 60, discoLivreMinimoMb: 2048 } });
    // A tela Sistema manda de volta tudo o que leu no GET, com o upload novo.
    const screen = (await get().expect(200)).body;
    const saved = await post({ ...screen, upload: { ...screen.upload, maxSizeMb: 10 } }).expect(200);
    assert.deepEqual(saved.body.settings.entregas, { maxMbPorArquivo: 10, maxMbPorEnvio: 60, discoLivreMinimoMb: 2048 }, 'o teto do upload vale na leitura');
    assert.deepEqual((await get().expect(200)).body.entregas, saved.body.settings.entregas);
    assert.equal(db.memory.config.settings.entregas.maxMbPorArquivo, 40, 'a escolha gravada fica');
});
