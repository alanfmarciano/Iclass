// Retenção dos registros técnicos (H8b, SEG-13; decisão 4 do Alan).
// 1) settings.retention começa desligado (0 = nunca apagar); banco de antes desta versão
//    (sem o bloco) também. O POST genérico de configurações nunca muda o bloco, e o
//    professor não muda mais o prazo da lixeira por ele.
// 2) GET/POST /api/admin/lgpd/retention e a prévia: só o administrador (professor 403);
//    valores fora do limite são recusados com o campo; 1 a 29 dias sobem para 30 (180
//    para os acessos); salvar preenche reviewedAt/reviewedBy e grava a auditoria.
// 3) A limpeza apaga só teclas, saídas de tela, registros de acesso e lixeira vencidos:
//    aplicação aberta nunca perde nada, a encerrada conta do fim, o registro sem
//    aplicação (ou de aplicação apagada) conta da própria hora; nunca toca em notas,
//    entregas, frequência, auditoria ou cadastro; no máximo N por coleção, das mais
//    antigas, e o que sobra fica para a próxima.
// 4) Com prova em andamento a limpeza pedida responde 409 e a automática espera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-lgpd-retencao-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor (ver lgpd-documentos.test.js).
const retention = require('../../backend/utils/retention.js');
const settingsUtil = require('../../backend/utils/settings.js');
const storage = require('../../backend/utils/storage.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const DAY = 86400000;
const tokens = { admin: 'admin-token-retencao', prof: 'prof-token-retencao' };
const emails = { admin: 'admin@retencao.local', prof: 'prof@retencao.local' };
const ACTIVE_MESSAGE = 'Há prova em andamento; a limpeza roda quando ela terminar.';
let app;

const as = who => req => req.set('x-admin-session', tokens[who]);
const get = (who, url) => as(who)(request(app).get(url));
const post = (who, url, body) => as(who)(request(app).post(url)).send(body || {});
const auditOf = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const iso = ms => new Date(ms).toISOString();

async function clearKeystrokes() {
    await db.keystrokes.deleteWhere({ before: Date.now() + 365 * DAY });
}

function keyRow(applicationId, serverTs, extra = {}) {
    return {
        id: `k_${applicationId || 'sem'}_${serverTs}_${Math.random().toString(36).slice(2, 8)}`,
        studentEmail: 'ana@retencao.local',
        studentClass: 'T1',
        courseId: 'curso_r',
        examKey: 'Prova_1',
        applicationId,
        attemptId: null,
        seq: 1,
        clientTs: serverTs,
        serverTs,
        key: 'c',
        code: 'KeyC',
        mods: 'Ctrl',
        kind: 'shortcut',
        question: null,
        blocked: false,
        suspicious: true,
        ...extra,
    };
}

// Cenário: hoje é `now`; prazo do monitoramento de 180 dias.
// - app-velha: encerrada há 400 dias (vence);
// - app-recente: encerrada há 10 dias (fica), embora as teclas sejam antigas;
// - app-cancelada: cancelada há 300 dias, sem finishedAt (vence pelo cancelledAt);
// - app-preparada: preparada há 400 dias, nunca aplicada (aberta: fica);
// - teclas sem aplicação: uma de 400 dias (vence) e uma de 5 dias (fica);
// - teclas de aplicação apagada ('app-apagada'): de 400 dias (vence) e de 5 dias (fica).
async function seedScenario(now = Date.now()) {
    db.memory.examApplications = [
        { id: 'app-velha', examKey: 'Prova_1', studentClass: 'T1', courseId: 'curso_r', status: 'finished', createdAt: iso(now - 401 * DAY), finishedAt: iso(now - 400 * DAY) },
        { id: 'app-recente', examKey: 'Prova_2', studentClass: 'T1', courseId: 'curso_r', status: 'finished', createdAt: iso(now - 500 * DAY), finishedAt: iso(now - 10 * DAY) },
        { id: 'app-cancelada', examKey: 'Prova_3', studentClass: 'T1', courseId: 'curso_r', status: 'cancelled', createdAt: iso(now - 301 * DAY), cancelledAt: iso(now - 300 * DAY) },
        { id: 'app-preparada', examKey: 'Prova_4', studentClass: 'T1', courseId: 'curso_r', status: 'prepared', createdAt: iso(now - 400 * DAY) },
    ];
    await clearKeystrokes();
    await db.keystrokes.append([
        keyRow('app-velha', now - 401 * DAY),
        keyRow('app-velha', now - 400 * DAY),
        keyRow('app-recente', now - 499 * DAY),
        keyRow('app-cancelada', now - 301 * DAY),
        keyRow('app-preparada', now - 400 * DAY),
        keyRow(null, now - 400 * DAY),
        keyRow(null, now - 5 * DAY),
        keyRow('app-apagada', now - 400 * DAY),
        keyRow('app-apagada', now - 5 * DAY),
    ]);
    db.memory.proctoringLogs = [
        { id: 'p1', applicationId: 'app-velha', timestamp: now - 400 * DAY, eventType: 'tab_blur' },
        { id: 'p2', applicationId: 'app-recente', timestamp: now - 499 * DAY, eventType: 'tab_blur' },
        { id: 'p3', applicationId: 'app-preparada', timestamp: now - 400 * DAY, eventType: 'tab_blur' },
        { id: 'p4', applicationId: null, timestamp: now - 400 * DAY, eventType: 'tab_blur' },
        { id: 'p5', applicationId: null, timestamp: now - 5 * DAY, eventType: 'tab_blur' },
        { id: 'p6', applicationId: 'app-apagada', timestamp: now - 400 * DAY, eventType: 'tab_blur' },
    ];
    db.memory.loginLogs = [
        { id: 'l1', email: 'ana@retencao.local', timestamp: now - 400 * DAY },
        // Agrupado: o último acesso (lastAt) é recente, então fica.
        { id: 'l2', email: 'ana@retencao.local', timestamp: now - 400 * DAY, lastAt: now - 20 * DAY, count: 3 },
        { id: 'l3', email: 'ana@retencao.local', timestamp: now - 10 * DAY },
    ];
}

function seedAccounts() {
    db.memory.admins = [
        { email: emails.admin, name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: emails.prof, name: 'Professora', role: 'professor', password: db.hashPassword('x'), additionalPermissions: ['page.system', 'system.manage'] },
    ];
    db.memory.adminSessions = Object.fromEntries(Object.keys(tokens).map(who => [tokens[who], { email: emails[who], createdAt: Date.now(), lastSeen: Date.now() }]));
    db.memory.auditLogs = [];
    if (!db.memory.config) db.memory.config = {};
    db.memory.config.settings = {};
    delete db.memory.config.retentionLastRun;
}

// O que está gravado de fato (outra conexão, só leitura): ids das saídas de tela e dos
// acessos e o config.
async function storedData() {
    const reader = new sqlite3.Database(path.join(tempRoot, 'database.db'), sqlite3.OPEN_READONLY);
    const all = sql => new Promise((resolve, reject) => reader.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
    try {
        const config = await all("SELECT value FROM config WHERE key = 'app_config'");
        return {
            proctoringLogs: (await all('SELECT key FROM proctoring_logs')).map(row => row.key).sort(),
            loginLogs: (await all('SELECT key FROM login_logs')).map(row => row.key).sort(),
            config: config.length ? JSON.parse(config[0].value) : {},
        };
    } finally {
        await new Promise(resolve => reader.close(resolve));
    }
}

function keystrokeIds() {
    return db.keystrokes.statsEntries().filter(entry => entry.total > 0).map(entry => `${entry.applicationId || 'sem'}:${entry.total}`).sort();
}

// Item na lixeira apagado há `daysAgo` dias.
function trashItem(name, daysAgo) {
    const file = path.join(storage.DATA, `${name}.txt`);
    fs.writeFileSync(file, 'x');
    const id = storage.moveToTrash(file);
    assert.ok(id, 'item foi para a lixeira');
    const indexFile = path.join(storage.LIXEIRA_DIR, '_index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index.forEach(entry => { if (entry.id === id) entry.deletedAt = Date.now() - daysAgo * DAY; });
    fs.writeFileSync(indexFile, JSON.stringify(index));
    return { id };
}

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => {
    seedAccounts();
    storage.emptyTrash();
});
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-LGPD-008] retenção começa desligada; banco antigo sem o bloco vale 0 e o POST genérico não muda o bloco', async () => {
    // Banco de antes desta versão: sem settings.retention.
    db.memory.config.settings = { timezone: 'America/Recife', trash: { retentionDays: 0 } };
    const defaults = settingsUtil.retentionSettings();
    assert.deepEqual(defaults, { proctoringDays: 0, loginLogsDays: 0, trashDays: 0, reviewedAt: null, reviewedBy: null });
    assert.deepEqual(settingsUtil.getSettings().retention, { proctoringDays: 0, loginLogsDays: 0, reviewedAt: null, reviewedBy: null });
    assert.equal(retention.hasAnyDeadline(defaults), false);

    // Sem prazo, nada é apagado, nem pela limpeza automática.
    await seedScenario();
    const before = { keys: db.keystrokes.total(), logs: db.memory.proctoringLogs.length, logins: db.memory.loginLogs.length };
    const result = await retention.runRetention({ memory: db.memory, keystrokes: db.keystrokes, settings: settingsUtil.retentionSettings(), trigger: 'automatic' });
    assert.deepEqual(result, { ran: false, reason: 'no_deadline' });
    assert.deepEqual({ keys: db.keystrokes.total(), logs: db.memory.proctoringLogs.length, logins: db.memory.loginLogs.length }, before);

    // O administrador liga os prazos; o POST genérico (com retention no corpo) não muda.
    await post('admin', '/api/admin/lgpd/retention', { proctoringDays: 180, loginLogsDays: 365, trashDays: 30 }).expect(200);
    await post('admin', '/api/admin/settings', { timezone: 'America/Sao_Paulo', retention: { proctoringDays: 0, loginLogsDays: 0 } }).expect(200);
    const after = settingsUtil.retentionSettings();
    assert.equal(after.proctoringDays, 180);
    assert.equal(after.loginLogsDays, 365);
    assert.equal(after.trashDays, 30);
    assert.equal(settingsUtil.getSettings().timezone, 'America/Sao_Paulo', 'o resto das configurações vale');

    // Professor (com system.manage) não muda o prazo da lixeira pelo POST genérico; o
    // administrador ainda muda (compatibilidade com a tela antiga).
    await post('prof', '/api/admin/settings', { trash: { retentionDays: 0 }, session: { idleMinutes: 45 } }).expect(200);
    assert.equal(settingsUtil.retentionSettings().trashDays, 30);
    assert.equal(settingsUtil.getSettings().session.idleMinutes, 45);
    await post('admin', '/api/admin/settings', { trash: { retentionDays: 60 } }).expect(200);
    assert.equal(settingsUtil.retentionSettings().trashDays, 60);
    assert.equal(settingsUtil.retentionSettings().proctoringDays, 180);
});

test('[UC-LGPD-008] prazos: só o administrador grava; limites, mínimos, reviewedAt e auditoria', async () => {
    // Professor: 403 em todas as rotas de retenção (a regra /lgpd pede students.security).
    await get('prof', '/api/admin/lgpd/retention').expect(403);
    await get('prof', '/api/admin/lgpd/retention/preview?proctoringDays=30').expect(403);
    await post('prof', '/api/admin/lgpd/retention', { proctoringDays: 30, loginLogsDays: 180, trashDays: 0 }).expect(403);
    await post('prof', '/api/admin/lgpd/retention/run', { confirm: 'APAGAR' }).expect(403);
    await request(app).get('/api/admin/lgpd/retention').expect(401);

    const initial = await get('admin', '/api/admin/lgpd/retention').expect(200);
    assert.equal(initial.body.reviewed, false, 'aviso "Prazos de retenção ainda não definidos"');
    assert.deepEqual(initial.body.recommended, { proctoringDays: 180, loginLogsDays: 365, trashDays: 30 });
    assert.equal(initial.body.limits.proctoringDays.min, 30);
    assert.equal(initial.body.limits.loginLogsDays.min, 180);
    assert.equal(initial.body.lastRun, null);

    // Fora do limite, negativo, fração, texto: 400 com o campo; nada gravado.
    for (const [body, field] of [
        [{ proctoringDays: 3651, loginLogsDays: 0, trashDays: 0 }, 'proctoringDays'],
        [{ proctoringDays: 0, loginLogsDays: -1, trashDays: 0 }, 'loginLogsDays'],
        [{ proctoringDays: 0, loginLogsDays: 0, trashDays: 1.5 }, 'trashDays'],
        [{ proctoringDays: 'muito', loginLogsDays: 0, trashDays: 0 }, 'proctoringDays'],
        [{ proctoringDays: 30, trashDays: 0 }, 'loginLogsDays'],
        [{ proctoringDays: [30], loginLogsDays: 0, trashDays: 0 }, 'proctoringDays'],
    ]) {
        const refused = await post('admin', '/api/admin/lgpd/retention', body).expect(400);
        assert.equal(refused.body.success, false);
        assert.equal(refused.body.field, field, JSON.stringify(body));
        assert.match(refused.body.error, /dias inteiros, de 0 a 3\.650 \(0 = não apagar\)/);
    }
    assert.equal(settingsUtil.retentionSettings().reviewedAt, null);
    assert.equal(auditOf('retention_settings_changed').length, 0);

    // 1 a 29 dias sobe para 30; 1 a 179 nos acessos sobe para 180.
    const saved = await post('admin', '/api/admin/lgpd/retention', { proctoringDays: 7, loginLogsDays: '90', trashDays: 15 }).expect(200);
    assert.deepEqual(saved.body.adjusted.map(item => [item.field, item.value]), [['proctoringDays', 30], ['loginLogsDays', 180]]);
    assert.match(saved.body.adjusted[0].message, /monitoramento da prova subiu para 30 dias/);
    const stored = settingsUtil.retentionSettings();
    assert.equal(stored.proctoringDays, 30);
    assert.equal(stored.loginLogsDays, 180);
    assert.equal(stored.trashDays, 15);
    assert.equal(stored.reviewedBy, emails.admin);
    assert.ok(Date.parse(stored.reviewedAt) > Date.now() - 60000);
    assert.equal(saved.body.reviewed, true);
    assert.equal(db.memory.config.settings.trash.retentionDays, 15, 'a lixeira continua em trash.retentionDays (sweepTrash)');
    const [entry] = auditOf('retention_settings_changed');
    assert.equal(entry.category, 'privacy');
    assert.deepEqual(entry.before, { proctoringDays: 0, loginLogsDays: 0, trashDays: 0 });
    assert.deepEqual(entry.after, { proctoringDays: 30, loginLogsDays: 180, trashDays: 15 });

    // Desligar de novo (0) vale.
    await post('admin', '/api/admin/lgpd/retention', { proctoringDays: 0, loginLogsDays: 0, trashDays: 0 }).expect(200);
    assert.equal(retention.hasAnyDeadline(settingsUtil.retentionSettings()), false);
    assert.ok(settingsUtil.retentionSettings().reviewedAt, 'revisado continua revisado');
    const onDisk = await storedData();
    assert.equal(onDisk.config.settings.retention.proctoringDays, 0);
    assert.ok(onDisk.config.settings.retention.reviewedAt, 'o bloco gravado chega ao arquivo');
});

test('[UC-LGPD-008] prévia conta o que a limpeza apagaria, com os prazos pedidos e sem apagar nada', async () => {
    const now = Date.now();
    await seedScenario(now);
    trashItem('velho', 40);
    trashItem('novo', 2);
    const preview = await get('admin', '/api/admin/lgpd/retention/preview?proctoringDays=180&loginLogsDays=365&trashDays=30').expect(200);
    // Teclas: app-velha (2), app-cancelada (1), sem aplicação de 400 dias (1), app-apagada
    // de 400 dias (1). Ficam: app-recente, app-preparada e as de 5 dias.
    assert.deepEqual(preview.body.counts, { keystrokes: 5, proctoringLogs: 3, loginLogs: 1, trash: 1 });
    assert.equal(db.keystrokes.total(), 9, 'a prévia não apaga');
    assert.equal(db.memory.proctoringLogs.length, 6);

    // Campo ausente usa o prazo gravado (0 = desligado); valor inválido é recusado.
    const partial = await get('admin', '/api/admin/lgpd/retention/preview?loginLogsDays=365').expect(200);
    assert.deepEqual(partial.body.counts, { keystrokes: 0, proctoringLogs: 0, loginLogs: 1, trash: 0 });
    const minimum = await get('admin', '/api/admin/lgpd/retention/preview?proctoringDays=5').expect(200);
    assert.equal(minimum.body.values.proctoringDays, 30);
    assert.equal(minimum.body.adjusted[0].field, 'proctoringDays');
    const invalid = await get('admin', '/api/admin/lgpd/retention/preview?proctoringDays=abc').expect(400);
    assert.equal(invalid.body.field, 'proctoringDays');

    // O GET mostra o volume e a prévia com os prazos gravados.
    await post('admin', '/api/admin/lgpd/retention', { proctoringDays: 180, loginLogsDays: 365, trashDays: 30 }).expect(200);
    const payload = await get('admin', '/api/admin/lgpd/retention').expect(200);
    assert.equal(payload.body.volume.keystrokes, 9);
    assert.equal(payload.body.volume.proctoringLogs, 6);
    assert.equal(payload.body.volume.loginLogs, 3);
    assert.ok(payload.body.volume.trash >= 2);
    assert.deepEqual(payload.body.preview.counts, { keystrokes: 5, proctoringLogs: 3, loginLogs: 1, trash: 1 });
});

test('[UC-LGPD-008] limpar agora apaga só os registros técnicos vencidos e grava a última limpeza e a auditoria', async () => {
    const now = Date.now();
    await seedScenario(now);
    const oldTrash = trashItem('antigo', 45);
    const newTrash = trashItem('recente', 1);
    db.memory.submissions = [{ id: 's1', studentEmail: 'ana@retencao.local', examKey: 'Prova_1', applicationId: 'app-velha', submittedAt: iso(now - 400 * DAY) }];
    db.memory.attendance = [{ email: 'ana@retencao.local', date: '2020-01-01', status: 'Presente' }];
    db.memory.students = [{ email: 'ana@retencao.local', name: 'Ana', status: 'Ativo', createdAt: iso(now - 900 * DAY) }];
    const oldAudit = { id: 'a-old', action: 'login', category: 'access', timestamp: iso(now - 900 * DAY) };
    db.memory.auditLogs.push(oldAudit);

    // Sem APAGAR: 400.
    const unconfirmed = await post('admin', '/api/admin/lgpd/retention/run', {}).expect(400);
    assert.equal(unconfirmed.body.field, 'confirm');
    // Antes da primeira revisão, nem com o prazo da lixeira de antes (30 dias, o padrão do
    // banco do Alan) a limpeza à mão roda: 409 not_reviewed e nada é apagado.
    db.memory.config.settings = { trash: { retentionDays: 30 } };
    const keysBefore = db.keystrokes.total();
    const notReviewed = await post('admin', '/api/admin/lgpd/retention/run', { confirm: 'APAGAR' }).expect(409);
    assert.equal(notReviewed.body.code, 'not_reviewed');
    assert.match(notReviewed.body.error, /Revise e salve os prazos/);
    assert.equal(db.keystrokes.total(), keysBefore);
    assert.equal(db.memory.config.retentionLastRun, undefined);
    // Revisados com tudo em 0: sem prazo, 409.
    await post('admin', '/api/admin/lgpd/retention', { proctoringDays: 0, loginLogsDays: 0, trashDays: 0 }).expect(200);
    const noDeadline = await post('admin', '/api/admin/lgpd/retention/run', { confirm: 'APAGAR' }).expect(409);
    assert.equal(noDeadline.body.code, 'no_deadline');

    await post('admin', '/api/admin/lgpd/retention', { proctoringDays: 180, loginLogsDays: 365, trashDays: 30 }).expect(200);
    const run = await post('admin', '/api/admin/lgpd/retention/run', { confirm: 'apagar' }).expect(200);
    assert.deepEqual(run.body.counts, { keystrokes: 5, proctoringLogs: 3, loginLogs: 1, trash: 1 });
    assert.deepEqual(run.body.remaining, { keystrokes: 0, proctoringLogs: 0, loginLogs: 0 });

    assert.deepEqual(keystrokeIds(), ['app-apagada:1', 'app-preparada:1', 'app-recente:1', 'sem:1']);
    assert.deepEqual(db.memory.proctoringLogs.map(log => log.id).sort(), ['p2', 'p3', 'p5']);
    assert.deepEqual(db.memory.loginLogs.map(log => log.id).sort(), ['l2', 'l3']);
    const trashIds = storage.listTrash().map(entry => entry.id);
    assert.ok(!trashIds.includes(oldTrash.id), 'item vencido saiu da lixeira');
    assert.ok(trashIds.includes(newTrash.id));

    // Registro escolar nunca é apagado por prazo.
    assert.equal(db.memory.submissions.length, 1);
    assert.equal(db.memory.attendance.length, 1);
    assert.equal(db.memory.students.length, 1);
    assert.ok(db.memory.auditLogs.some(entry => entry.id === 'a-old'));
    assert.equal(db.memory.examApplications.length, 4, 'as aplicações ficam');

    // Última limpeza e auditoria.
    const lastRun = db.memory.config.retentionLastRun;
    assert.equal(lastRun.trigger, 'manual');
    assert.equal(lastRun.by, emails.admin);
    assert.deepEqual(lastRun.counts, run.body.counts);
    assert.deepEqual(run.body.lastRun, lastRun);
    const [purge] = auditOf('retention_purge');
    assert.equal(purge.category, 'privacy');
    assert.equal(purge.details.trigger, 'manual');
    assert.deepEqual(purge.details.counts, run.body.counts);

    // Gravado: o arquivo tem as saídas de tela e os acessos sem os apagados.
    const stored = await storedData();
    assert.deepEqual(stored.proctoringLogs, ['p2', 'p3', 'p5']);
    assert.deepEqual(stored.loginLogs, ['l2', 'l3']);
    assert.equal(stored.config.retentionLastRun.at, lastRun.at);

    // Repetir sem nada vencido: roda, apaga 0 e ainda registra (pedido do administrador).
    const again = await post('admin', '/api/admin/lgpd/retention/run', { confirm: 'APAGAR' }).expect(200);
    assert.deepEqual(again.body.counts, { keystrokes: 0, proctoringLogs: 0, loginLogs: 0, trash: 0 });
    assert.equal(auditOf('retention_purge').length, 2);
});

test('[UC-LGPD-008] com prova em andamento a limpeza pedida responde 409 e a automática espera', async () => {
    const now = Date.now();
    await seedScenario(now);
    db.memory.examApplications.push({ id: 'app-agora', examKey: 'Prova_9', studentClass: 'T1', courseId: 'curso_r', status: 'running', createdAt: iso(now) });
    await post('admin', '/api/admin/lgpd/retention', { proctoringDays: 180, loginLogsDays: 365, trashDays: 0 }).expect(200);

    const refused = await post('admin', '/api/admin/lgpd/retention/run', { confirm: 'APAGAR' }).expect(409);
    assert.equal(refused.body.error, ACTIVE_MESSAGE);
    assert.equal(refused.body.activeApplications, 1);
    for (const status of ['waiting', 'paused']) {
        db.memory.examApplications[4].status = status;
        await post('admin', '/api/admin/lgpd/retention/run', { confirm: 'APAGAR' }).expect(409);
    }
    const auto = await retention.runRetention({ memory: db.memory, keystrokes: db.keystrokes, settings: settingsUtil.retentionSettings(), now, trigger: 'automatic' });
    assert.equal(auto.ran, false);
    assert.equal(auto.reason, 'active_application');
    assert.equal(db.keystrokes.total(), 9, 'nada apagado');
    assert.equal(db.memory.proctoringLogs.length, 6);
    assert.equal(auditOf('retention_purge').length, 0);
    assert.equal(db.memory.config.retentionLastRun, undefined);

    // Encerrada a prova, a automática roda (e a sala de agora, encerrada há 0 dia, fica).
    db.memory.examApplications[4].status = 'finished';
    db.memory.examApplications[4].finishedAt = iso(now);
    let saves = 0;
    const ran = await retention.runRetention({ memory: db.memory, keystrokes: db.keystrokes, settings: settingsUtil.retentionSettings(), now, trigger: 'automatic', save: async () => { saves += 1; await db.save(); } });
    assert.equal(ran.ran, true);
    assert.equal(saves, 1);
    assert.deepEqual(ran.counts, { keystrokes: 5, proctoringLogs: 3, loginLogs: 1, trash: 0 });
    const [purge] = auditOf('retention_purge');
    assert.equal(purge.details.trigger, 'automatic');
    assert.equal(purge.actor, 'sistema');

    // Rodou há menos de 23 h sem sobra: a próxima hora não roda; depois de 23 h, roda.
    assert.deepEqual(retention.retentionDue(db.memory, settingsUtil.retentionSettings(), now + 3600000), { due: false, reason: 'not_due' });
    assert.equal(retention.retentionDue(db.memory, settingsUtil.retentionSettings(), now + 23 * 3600000 + 1).due, true);
    // A automática sem nada para apagar não grava auditoria.
    const empty = await retention.runRetention({ memory: db.memory, keystrokes: db.keystrokes, settings: settingsUtil.retentionSettings(), now: now + 24 * 3600000, trigger: 'automatic' });
    assert.equal(empty.ran, true);
    assert.equal(auditOf('retention_purge').length, 1);
});

test('[UC-LGPD-008] teto por vez: das mais antigas para as mais novas, e a sobra fica para a hora seguinte', async () => {
    assert.equal(retention.RETENTION_MAX_PER_RUN, 20000);
    const now = Date.now();
    db.memory.examApplications = [
        { id: 'app-a', examKey: 'P', studentClass: 'T1', courseId: 'curso_r', status: 'finished', finishedAt: iso(now - 400 * DAY) },
    ];
    await clearKeystrokes();
    await db.keystrokes.append([1, 2, 3, 4, 5].map(index => keyRow('app-a', now - (410 - index) * DAY, { seq: index })));
    db.memory.proctoringLogs = [5, 3, 1, 4, 2].map(index => ({ id: `p${index}`, applicationId: null, timestamp: now - (410 - index) * DAY }));
    db.memory.loginLogs = [4, 1, 2, 5, 3].map(index => ({ id: `l${index}`, timestamp: now - (410 - index) * DAY }));
    const settings = { proctoringDays: 180, loginLogsDays: 365, trashDays: 0 };

    const first = await retention.applyRetention(db.memory, settings, now, { max: 2, keystrokes: db.keystrokes });
    assert.deepEqual(first.counts, { keystrokes: 2, proctoringLogs: 2, loginLogs: 2, trash: 0 });
    assert.deepEqual(first.remaining, { keystrokes: 3, proctoringLogs: 3, loginLogs: 3 });
    const left = await db.keystrokes.query({ email: 'ana@retencao.local', examKey: 'Prova_1', applicationId: 'app-a', limit: 50 });
    assert.deepEqual(left.events.map(event => event.seq), [3, 4, 5], 'as mais antigas saíram primeiro');
    assert.deepEqual(db.memory.proctoringLogs.map(log => log.id), ['p5', 'p3', 'p4'], 'ordem da coleção preservada');
    assert.deepEqual(db.memory.loginLogs.map(log => log.id), ['l4', 'l5', 'l3']);

    // Sobra: a automática roda de novo na hora seguinte, mesmo antes de 23 h.
    db.memory.config.retentionLastRun = { at: iso(now), remaining: first.remaining, counts: first.counts };
    assert.equal(retention.retentionDue(db.memory, settings, now + 3600000).due, true);
});

test('[UC-LGPD-008] regras de prazo: entrada, fim da aplicação e cancelada sem data', () => {
    assert.deepEqual(retention.parseRetentionInput({ proctoringDays: 0, loginLogsDays: 365, trashDays: '0' }), {
        values: { proctoringDays: 0, loginLogsDays: 365, trashDays: 0 },
        adjusted: [],
    });
    assert.deepEqual(retention.parseRetentionInput({ proctoringDays: 29, loginLogsDays: 179, trashDays: 1 }).values, { proctoringDays: 30, loginLogsDays: 180, trashDays: 1 });
    assert.throws(() => retention.parseRetentionInput({ proctoringDays: 30, loginLogsDays: 180, trashDays: 3651 }), error => error.field === 'trashDays');
    assert.throws(() => retention.parseRetentionInput(null), error => error.field === 'proctoringDays');

    const now = Date.parse('2026-06-01T12:00:00Z');
    assert.equal(retention.applicationEndTime({ status: 'running', finishedAt: '2020-01-01' }), null, 'aberta nunca vence');
    assert.equal(retention.applicationEndTime({ status: 'prepared' }), null);
    assert.equal(retention.applicationEndTime({ status: 'finished', finishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' }), Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(retention.applicationEndTime({ status: 'cancelled', updatedAt: now }), now, 'cancelada sem cancelledAt conta do updatedAt');
    assert.equal(retention.activeApplicationCount({ examApplications: [{ status: 'waiting' }, { status: 'paused' }, { status: 'prepared' }, null] }), 2);
});
