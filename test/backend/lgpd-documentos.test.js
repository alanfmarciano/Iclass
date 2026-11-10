// Termos de Uso, Política de Privacidade e encarregado (H8a-1; SEG-08, OPS-12).
// 1) GET /api/legal/documents responde sem login, com o modelo preenchido pelos dados da
//    escola ('[não informado]' no que falta) enquanto nada é publicado; antes era 404.
// 2) O administrador grava o rascunho e publica; a versão publicada não muda mais
//    (escrita responde 409), o rascunho nunca aparece na rota pública e cada publicação
//    é uma versão nova, com auditoria legal_publish.
// 3) O encarregado fica em school.info, gravado só pela rota de LGPD, com dpo_changed.
// 4) Só o administrador: professor recebe 403 em /api/admin/lgpd/*.
// 5) Restaurar um backup (inclusive o de versão anterior, sem a coleção) não apaga os
//    documentos publicados: a coleção junta por id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-lgpd-documentos-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor: server.js registra o process.on('uncaughtException'), que
// engoliria a falha destes require e o arquivo passaria sem rodar nenhum teste.
const legal = require('../../backend/utils/legalDocuments.js');
const { MODEL_ID, MODELS } = require('../../backend/utils/legalTemplates.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const tokens = { admin: 'admin-token-lgpd-docs', prof: 'prof-token-lgpd-docs' };
const emails = { admin: 'admin@lgpd.local', prof: 'prof@lgpd.local' };
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backup-versao-anterior.json'), 'utf8'));
let app;

const as = who => req => req.set('x-admin-session', tokens[who]);
const auditOf = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);

function seed() {
    db.memory.admins = [
        { email: emails.admin, name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: emails.prof, name: 'Professora', role: 'professor', password: db.hashPassword('x'), assignedSchoolIds: ['escola_a'] },
    ];
    db.memory.adminSessions = Object.fromEntries(Object.keys(tokens).map(who => [tokens[who], { email: emails[who], createdAt: Date.now(), lastSeen: Date.now() }]));
    db.memory.schools = [
        { id: 'escola_a', name: 'Escola *Alfa*', info: { legalName: 'Instituto Alfa Ltda.', registrationId: '12.345.678/0001-90', address: 'Rua A, 10', cityState: 'Recife/PE', email: 'contato@alfa.local' }, branding: {} },
        { id: 'escola_b', name: 'Escola Beta', info: {}, branding: {} },
    ];
    db.memory.courses = [{ id: 'curso_b', name: 'Curso B', schoolId: 'escola_b', structure: [] }];
    db.memory.students = [
        { name: 'Ana', email: 'ana@lgpd.local', status: 'Ativo' },
        { name: 'Bruno', email: 'bruno@lgpd.local', status: 'Bloqueado' },
        { name: 'Carla', email: 'carla@lgpd.local', status: 'Transferido' },
    ];
    db.memory.legalDocuments = [];
    db.memory.auditLogs = [];
    db.memory.sessions = {};
    if (db.memory.config) delete db.memory.config.privacy;
}

async function publish(kind, extra = {}) {
    return as('admin')(request(app).post('/api/admin/lgpd/documents/publish')).send({ kind, confirm: 'PUBLICAR', ...extra });
}

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-LGPD-001] /api/legal/documents responde sem login com o modelo preenchido pelos dados da escola', async () => {
    const res = await request(app).get('/api/legal/documents');
    assert.equal(res.status, 200);
    assert.equal(res.body.published, false);
    assert.deepEqual(res.body.school, { id: 'escola_a', name: 'Escola *Alfa*' });
    for (const [key, kind] of [['terms', 'termos'], ['privacy', 'privacidade']]) {
        const doc = res.body[key];
        assert.equal(doc.isModel, true);
        assert.equal(doc.documentId, `${MODEL_ID}:${kind}`);
        assert.equal(doc.version, null);
        assert.equal(doc.publishedAt, null);
        assert.match(doc.markdown, /Modelo de referência; não substitui orientação jurídica/);
        // Nenhum marcador da lista fica sem trocar.
        assert.doesNotMatch(doc.markdown, /\{\{/);
        assert.match(doc.markdown, /12\.345\.678\/0001-90/);
    }
    const privacy = res.body.privacy.markdown;
    assert.match(privacy, /Instituto Alfa Ltda\./);
    assert.match(privacy, /Rua A, 10, Recife\/PE/);
    // Encarregado não informado ainda.
    assert.match(privacy, /\*\*Encarregado pelo tratamento de dados pessoais:\*\* \[não informado\]\. Contato: \[não informado\]\./);
    assert.match(privacy, /nada|não envia seus dados para a internet/);
    assert.match(privacy, /guardados até a escola apagá-los \(nenhum prazo automático definido\)/);
    assert.match(privacy, /Versão: modelo padrão do IClass\. Publicação: ainda não publicado pela instituição\./);
    // O nome da escola com '*' não vira formatação.
    assert.match(res.body.terms.markdown, /\*\*Escola \\\*Alfa\\\*\*\*/);

    // ?escola= e ?courseId= trocam só os dados; id desconhecido usa a primeira escola.
    const beta = await request(app).get('/api/legal/documents?escola=escola_b');
    assert.deepEqual(beta.body.school, { id: 'escola_b', name: 'Escola Beta' });
    assert.match(beta.body.privacy.markdown, /\*\*Controlador:\*\* Escola Beta, CNPJ \[não informado\], \[não informado\]\./);
    const byCourse = await request(app).get('/api/legal/documents?courseId=curso_b');
    assert.equal(byCourse.body.school.id, 'escola_b');
    const unknown = await request(app).get('/api/legal/documents?escola=nao-existe');
    assert.equal(unknown.body.school.id, 'escola_a');
    // Parâmetro de tipo errado não derruba a rota.
    const repeated = await request(app).get('/api/legal/documents?escola[]=x&courseId[a]=1');
    assert.equal(repeated.status, 200);
});

test('[UC-LGPD-001] marcadores: vazio vira [não informado], desconhecido fica e é avisado', () => {
    const { markdown, unknownPlaceholders } = legal.renderLegalMarkdown('A {{instituicao}} B {{ cnpj }} C {{inexistente}} D {{outro_x}} {{inexistente}}', { instituicao: 'Escola <b>X</b>', cnpj: '   ' });
    assert.equal(markdown, 'A Escola \\<b\\>X\\</b\\> B [não informado] C {{inexistente}} D {{outro_x}} {{inexistente}}');
    assert.deepEqual(unknownPlaceholders, ['inexistente', 'outro_x']);
    // Os dois modelos só usam marcadores da lista fechada.
    Object.values(MODELS).forEach(model => {
        assert.deepEqual(legal.renderLegalMarkdown(model.markdown, {}).unknownPlaceholders, []);
    });
    // Prazos da retenção (H8b) entram no texto quando existem.
    const values = legal.placeholderValues({ schools: [] }, null, { version: 3, publishedAt: '2026-03-10T15:00:00.000Z' }, {
        settings: { timezone: 'America/Sao_Paulo', retention: { proctoringDays: 180, loginLogsDays: 365 }, trash: { retentionDays: 30 } },
    });
    assert.equal(values.prazo_monitoramento, 'apagados 180 dias depois do encerramento da prova');
    assert.equal(values.prazo_acessos, 'apagados 365 dias depois do acesso');
    assert.equal(values.prazo_lixeira, 'apagados de vez 30 dias depois de irem para a lixeira');
    assert.equal(values.versao, '3');
    assert.equal(values.data_publicacao, '10/03/2026');
});

test('[UC-LGPD-002] rascunho não aparece na rota pública; publicar cria versão nova com auditoria', async () => {
    const before = await as('admin')(request(app).get('/api/admin/lgpd/documents?escola=escola_b'));
    assert.equal(before.status, 200);
    assert.equal(before.body.activeStudents, 2, 'Ana e Bruno (o transferido não volta ao portal)');
    assert.equal(before.body.documents.termos.current.isModel, true);
    assert.equal(before.body.documents.termos.draft.saved, false);
    assert.equal(before.body.documents.termos.draft.markdown, MODELS.termos.markdown);
    assert.equal(before.body.school.id, 'escola_b');
    assert.match(before.body.documents.termos.preview.markdown, /\*\*Escola Beta\*\*/);
    assert.deepEqual(before.body.documents.termos.history, []);

    const draftText = `${MODELS.termos.markdown}\n\nRegra extra da escola.`;
    const saved = await as('admin')(request(app).post('/api/admin/lgpd/documents/draft')).send({ kind: 'termos', title: 'Termos de Uso da Escola', markdown: draftText, changeSummary: 'Regra extra.' });
    assert.equal(saved.status, 200, saved.body.error);
    assert.equal(saved.body.draft.saved, true);
    assert.equal(saved.body.draft.updatedBy, emails.admin);

    // O rascunho nunca vai para a rota pública: ela continua no modelo.
    const pub = await request(app).get('/api/legal/documents');
    assert.equal(pub.body.terms.isModel, true);
    assert.doesNotMatch(pub.body.terms.markdown, /Regra extra da escola/);

    // Sem a palavra de confirmação, nada é publicado.
    const unconfirmed = await as('admin')(request(app).post('/api/admin/lgpd/documents/publish')).send({ kind: 'termos' });
    assert.equal(unconfirmed.status, 400);
    assert.equal(unconfirmed.body.field, 'confirm');
    assert.equal(legal.publishedVersions(db.memory, 'termos').length, 0);

    // Rascunho que mudou depois de a tela abrir: 409 em vez de publicar texto não lido.
    const stale = await publish('termos', { draftUpdatedAt: null });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'draft_changed');

    const first = await publish('termos', { draftUpdatedAt: saved.body.draft.updatedAt });
    assert.equal(first.status, 200, first.body.error);
    assert.equal(first.body.document.id, 'termos_v1');
    assert.equal(first.body.document.version, 1);
    assert.equal(first.body.activeStudents, 2);
    const row = db.memory.legalDocuments.find(item => item.id === 'termos_v1');
    assert.equal(row.status, 'publicado');
    assert.equal(row.markdown, draftText);
    assert.equal(row.title, 'Termos de Uso da Escola');
    assert.equal(row.publishedBy, emails.admin);
    assert.equal(db.memory.legalDocuments.some(item => item.id === 'rascunho_termos'), false, 'o rascunho publicado sai');
    const audit = auditOf('legal_publish');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].category, 'privacy');
    assert.equal(audit[0].actor, emails.admin);
    assert.equal(audit[0].details.documentId, 'termos_v1');
    assert.equal(audit[0].details.version, 1);

    const after = await request(app).get('/api/legal/documents');
    assert.equal(after.body.published, true);
    assert.equal(after.body.terms.isModel, false);
    assert.equal(after.body.terms.documentId, 'termos_v1');
    assert.equal(after.body.terms.version, 1);
    assert.equal(after.body.terms.title, 'Termos de Uso da Escola');
    assert.match(after.body.terms.markdown, /Regra extra da escola/);
    assert.match(after.body.terms.markdown, /Versão: 1\. Publicação: \d{2}\/\d{2}\/\d{4}\./);
    // A privacidade continua no modelo até ser publicada também.
    assert.equal(after.body.privacy.isModel, true);

    // Publicar de novo sem mudar nada: recusado (cada versão nova pede novo aceite).
    const same = await publish('termos');
    assert.equal(same.status, 400);
    assert.equal(same.body.code, 'no_changes');

    const edited = await as('admin')(request(app).post('/api/admin/lgpd/documents/draft')).send({ kind: 'termos', markdown: `${draftText}\nMais uma regra.` });
    assert.equal(edited.status, 200);
    const second = await publish('termos', { changeSummary: 'Segunda regra.' });
    assert.equal(second.status, 200, second.body.error);
    assert.equal(second.body.document.id, 'termos_v2');
    assert.equal((await request(app).get('/api/legal/documents')).body.terms.documentId, 'termos_v2');
    // A versão 1 continua igual, no histórico.
    assert.equal(db.memory.legalDocuments.find(item => item.id === 'termos_v1').markdown, draftText);
    const listing = await as('admin')(request(app).get('/api/admin/lgpd/documents'));
    assert.deepEqual(listing.body.documents.termos.history.map(item => [item.id, item.version, item.changeSummary]), [
        ['termos_v2', 2, 'Segunda regra.'],
        ['termos_v1', 1, 'Regra extra.'],
    ]);
    const version = await as('admin')(request(app).get('/api/admin/lgpd/documents/version?id=termos_v1'));
    assert.equal(version.status, 200);
    assert.equal(version.body.document.markdown, draftText);
    assert.equal((await as('admin')(request(app).get('/api/admin/lgpd/documents/version?id=rascunho_termos'))).status, 404);
});

test('[UC-LGPD-002] publicar o modelo sem editar e restaurar o modelo no rascunho', async () => {
    const res = await publish('privacidade');
    assert.equal(res.status, 200, res.body.error);
    const row = db.memory.legalDocuments.find(item => item.id === 'privacidade_v1');
    assert.equal(row.markdown, MODELS.privacidade.markdown);
    assert.equal(row.modelId, MODEL_ID);
    const pub = await request(app).get('/api/legal/documents');
    assert.equal(pub.body.privacy.documentId, 'privacidade_v1');
    assert.equal(pub.body.privacy.isModel, false);
    // Vai para a tabela própria (legal_documents), fora de config e branding.
    await db.save();
    const reader = new sqlite3.Database(path.join(tempRoot, 'database.db'), sqlite3.OPEN_READONLY);
    try {
        const rows = await new Promise((resolve, reject) => reader.all('SELECT key, value FROM legal_documents', (err, found) => (err ? reject(err) : resolve(found))));
        assert.deepEqual(rows.map(item => item.key), ['privacidade_v1']);
        assert.equal(JSON.parse(rows[0].value).markdown, MODELS.privacidade.markdown);
        const config = await new Promise((resolve, reject) => reader.get("SELECT value FROM config WHERE key = 'app_config'", (err, found) => (err ? reject(err) : resolve(found))));
        assert.doesNotMatch(String(config && config.value), /Política de Privacidade do IClass/);
    } finally {
        await new Promise(resolve => reader.close(resolve));
    }

    await as('admin')(request(app).post('/api/admin/lgpd/documents/draft')).send({ kind: 'privacidade', markdown: 'Texto curto' });
    const restored = await as('admin')(request(app).post('/api/admin/lgpd/documents/restore-model')).send({ kind: 'privacidade' });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.draft.markdown, MODELS.privacidade.markdown);
    assert.equal(restored.body.draft.sameAsCurrent, true, 'igual à versão publicada, que era o modelo');
    assert.equal(db.memory.legalDocuments.find(item => item.id === 'privacidade_v1').markdown, MODELS.privacidade.markdown);
});

test('[UC-LGPD-002] versão publicada não muda: escrita nela responde 409', async () => {
    assert.equal((await publish('termos')).status, 200);
    const original = JSON.stringify(db.memory.legalDocuments.find(item => item.id === 'termos_v1'));
    const write = await as('admin')(request(app).post('/api/admin/lgpd/documents/draft')).send({ id: 'termos_v1', markdown: 'Trocado' });
    assert.equal(write.status, 409);
    assert.equal(write.body.code, 'published_immutable');
    const restore = await as('admin')(request(app).post('/api/admin/lgpd/documents/restore-model')).send({ id: 'termos_v1' });
    assert.equal(restore.status, 409);
    assert.equal(JSON.stringify(db.memory.legalDocuments.find(item => item.id === 'termos_v1')), original);
    // id que não existe e tipo inválido.
    assert.equal((await as('admin')(request(app).post('/api/admin/lgpd/documents/draft')).send({ id: 'termos_v9', markdown: 'x' })).status, 404);
    assert.equal((await as('admin')(request(app).post('/api/admin/lgpd/documents/draft')).send({ kind: 'contrato', markdown: 'x' })).status, 400);
});

test('[UC-LGPD-002] validação do rascunho e prévia com aviso de marcador desconhecido', async () => {
    const tooLong = await as('admin')(request(app).post('/api/admin/lgpd/documents/draft')).send({ kind: 'termos', markdown: 'a'.repeat(100001) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.field, 'markdown');
    const empty = await as('admin')(request(app).post('/api/admin/lgpd/documents/draft')).send({ kind: 'termos', markdown: '   ' });
    assert.equal(empty.status, 400);
    const wrongType = await as('admin')(request(app).post('/api/admin/lgpd/documents/draft')).send({ kind: 'termos', markdown: ['x'] });
    assert.equal(wrongType.status, 400);
    assert.equal(db.memory.legalDocuments.length, 0);

    const preview = await as('admin')(request(app).post('/api/admin/lgpd/documents/preview')).send({ markdown: 'Olá {{nome_fantasia}} e {{escola}}', escola: 'escola_b' });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.markdown, 'Olá Escola Beta e {{escola}}');
    assert.deepEqual(preview.body.unknownPlaceholders, ['escola']);
});

test('[UC-LGPD-003] encarregado gravado só pela rota de LGPD, com auditoria, e usado nos documentos', async () => {
    const invalid = await as('admin')(request(app).post('/api/admin/lgpd/dpo')).send({ schoolId: 'escola_a', dpoName: 'Maria Souza', dpoEmail: 'nao-e-email' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.field, 'dpoEmail');
    const noContact = await as('admin')(request(app).post('/api/admin/lgpd/dpo')).send({ schoolId: 'escola_a', dpoName: 'Maria Souza' });
    assert.equal(noContact.status, 400);
    const missing = await as('admin')(request(app).post('/api/admin/lgpd/dpo')).send({ schoolId: 'escola_x', dpoName: 'Maria Souza', dpoEmail: 'dpo@alfa.local' });
    assert.equal(missing.status, 404);

    const ok = await as('admin')(request(app).post('/api/admin/lgpd/dpo')).send({ schoolId: 'escola_a', dpoName: ' Maria  Souza ', dpoEmail: 'DPO@alfa.local', dpoPhone: '(81) 3333-0000' });
    assert.equal(ok.status, 200, ok.body.error);
    assert.equal(ok.body.changed, 1);
    const school = db.memory.schools.find(item => item.id === 'escola_a');
    assert.deepEqual([school.info.dpoName, school.info.dpoEmail, school.info.dpoPhone], ['Maria Souza', 'dpo@alfa.local', '(81) 3333-0000']);
    assert.equal(school.info.legalName, 'Instituto Alfa Ltda.', 'os outros dados da escola ficam');
    const audit = auditOf('dpo_changed');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].category, 'privacy');
    assert.deepEqual(audit[0].before, { dpoName: '', dpoEmail: '', dpoPhone: '' });
    assert.equal(audit[0].after.dpoName, 'Maria Souza');
    // Gravar o mesmo de novo não repete a auditoria.
    await as('admin')(request(app).post('/api/admin/lgpd/dpo')).send({ schoolId: 'escola_a', dpoName: 'Maria Souza', dpoEmail: 'dpo@alfa.local', dpoPhone: '(81) 3333-0000' });
    assert.equal(auditOf('dpo_changed').length, 1);

    const pub = await request(app).get('/api/legal/documents');
    assert.match(pub.body.privacy.markdown, /\*\*Encarregado pelo tratamento de dados pessoais:\*\* Maria Souza\. Contato: dpo@alfa\.local, \(81\) 3333-0000\./);

    // Editar a escola (o professor tem schools.scope) não troca nem apaga o encarregado.
    const edit = await as('prof')(request(app).post('/api/admin/schools/update')).send({ id: 'escola_a', info: { phone: '81 9999-0000', dpoName: 'Outra Pessoa', dpoEmail: 'x@x.local' } });
    assert.equal(edit.status, 200, edit.body.error);
    assert.equal(school.info.phone, '81 9999-0000');
    assert.equal(school.info.dpoName, 'Maria Souza');
    assert.equal(school.info.dpoEmail, 'dpo@alfa.local');

    // Aplicar a todas as escolas.
    const all = await as('admin')(request(app).post('/api/admin/lgpd/dpo')).send({ applyToAll: true, dpoName: 'Maria Souza', dpoEmail: 'dpo@alfa.local', dpoPhone: '(81) 3333-0000' });
    assert.equal(all.status, 200);
    assert.equal(all.body.changed, 1, 'só a Escola Beta mudou');
    assert.equal(db.memory.schools.find(item => item.id === 'escola_b').info.dpoName, 'Maria Souza');
    const listing = await as('admin')(request(app).get('/api/admin/lgpd/dpo'));
    assert.equal(listing.body.schools.length, 2);
    assert.equal(listing.body.schools[0].institution.legalName, 'Instituto Alfa Ltda.');
    assert.equal(listing.body.schools[0].dpo.dpoEmail, 'dpo@alfa.local');
});

test('[UC-LGPD-004] só o administrador: professor recebe 403 e sem sessão 401 em /api/admin/lgpd', async () => {
    const routes = [
        ['get', '/api/admin/lgpd/documents'],
        ['get', '/api/admin/lgpd/documents/version?id=termos_v1'],
        ['post', '/api/admin/lgpd/documents/preview'],
        ['post', '/api/admin/lgpd/documents/draft'],
        ['post', '/api/admin/lgpd/documents/restore-model'],
        ['post', '/api/admin/lgpd/documents/publish'],
        ['get', '/api/admin/lgpd/dpo'],
        ['post', '/api/admin/lgpd/dpo'],
    ];
    for (const [method, url] of routes) {
        const body = { kind: 'termos', markdown: 'x', confirm: 'PUBLICAR', schoolId: 'escola_a', dpoName: 'Pessoa', dpoEmail: 'p@p.local' };
        const asProf = await as('prof')(request(app)[method](url)).send(method === 'post' ? body : undefined);
        assert.equal(asProf.status, 403, `${method} ${url} (professor)`);
        const anonymous = await request(app)[method](url).send(method === 'post' ? body : undefined);
        assert.equal(anonymous.status, 401, `${method} ${url} (sem sessão)`);
    }
    assert.equal(db.memory.legalDocuments.length, 0);
    assert.equal(db.memory.schools[0].info.dpoName, undefined);
});

test('[UC-LGPD-005] restaurar backup junta os documentos por id; o de versão anterior não os apaga', async () => {
    assert.equal(db.COLLECTION_TABLES.find(entry => entry.collection === 'legalDocuments').restore, 'merge');
    assert.equal((await publish('termos')).status, 200);
    const published = JSON.stringify(db.memory.legalDocuments.find(item => item.id === 'termos_v1'));

    // Backup novo traz a coleção: vai no JSON do backup.
    const backup = await as('admin')(request(app).get('/api/admin/backup/data'));
    assert.equal(backup.status, 200);
    const snapshot = JSON.parse(backup.text);
    assert.deepEqual(snapshot.data.legalDocuments.map(item => item.id), ['termos_v1']);

    // Depois do backup, publica a privacidade; restaurar o backup não a apaga.
    assert.equal((await publish('privacidade')).status, 200);
    const restored = await as('admin')(request(app).post('/api/admin/backup/restore'))
        .field('confirm', 'RESTAURAR')
        .attach('file', Buffer.from(JSON.stringify(snapshot)), 'backup-novo.json');
    assert.equal(restored.status, 200, restored.body.error);
    assert.deepEqual(db.memory.legalDocuments.map(item => item.id).sort(), ['privacidade_v1', 'termos_v1']);
    assert.equal(JSON.stringify(db.memory.legalDocuments.find(item => item.id === 'termos_v1')), published);

    // Backup da versão anterior do IClass, sem a coleção: os documentos atuais ficam.
    seed();
    db.memory.adminSessions = { [tokens.admin]: { email: emails.admin, createdAt: Date.now(), lastSeen: Date.now() } };
    db.memory.admins.push({ email: 'admin@antigo.local', name: 'Admin antigo', role: 'admin', password: db.hashPassword('x') });
    assert.equal((await publish('termos')).status, 200);
    assert.equal(fixture.backup.data.legalDocuments, undefined);
    const legacy = await as('admin')(request(app).post('/api/admin/backup/restore'))
        .field('confirm', 'RESTAURAR')
        .field('acceptLegacy', '1')
        .attach('file', Buffer.from(JSON.stringify(fixture.backup)), 'backup-versao-anterior.json');
    assert.equal(legacy.status, 200, legacy.body.error);
    assert.deepEqual(db.memory.legalDocuments.map(item => item.id), ['termos_v1']);
    db.memory.adminSessions = Object.fromEntries(Object.keys(tokens).map(who => [tokens[who], { email: emails[who], createdAt: Date.now(), lastSeen: Date.now() }]));
    const pub = await request(app).get('/api/legal/documents');
    assert.equal(pub.body.terms.documentId, 'termos_v1');
});
