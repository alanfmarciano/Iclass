// Diário de classe na Chamada (fase 3, B11 / P4-S7, FUN-09; D3 e D4 do P4).
// [UC-DIARIO-001] gravar e ler o conteúdo de 2 aulas; juntar (upsert) no mesmo dia; versão
//   velha dá 409 diary_changed; professor de outra turma 403; schema recusa a 13ª aula e
//   o texto de 2001 caracteres com 400 em português; diary_saved na primeira gravação e
//   diary_changed só quando outra pessoa altera ou passaram 24 h.
// [UC-DIARIO-003] regressão do FUN-09: a exportação da presença com from, to e courseId
//   não inclui a turma homônima de outro curso nem as datas fora do período.
// [UC-DIARIO-004] backup: o diário vai e volta; backup de antes do diário (sem a coleção,
//   como o do 281029f) mantém o diário atual.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { ticketUrl } = require('./fixtures/backupDownload.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-diario-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const diary = require('../../backend/utils/classDiary.js');
const { missingCollectionOutcome } = require('../../backend/utils/backupSchema.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const COURSE = 'curso-diario';
const OTHER_COURSE = 'curso-outro';
const DATE = '2026-11-10'; // terça-feira
const ADMIN = 'admin@diario.local';
const PROF = 'prof@diario.local';
const PROF2 = 'prof2@diario.local';
const COORD = 'coord@diario.local';
const tokens = { admin: 'tok-admin-diario', prof: 'tok-prof-diario', prof2: 'tok-prof2-diario', coord: 'tok-coord-diario' };
let app;

const as = (who, req) => req.set('x-admin-session', tokens[who]);
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const Q = `courseId=${COURSE}&studentClass=1DES&date=${DATE}`;

function sessions() {
    const now = Date.now();
    return {
        [tokens.admin]: { email: ADMIN, createdAt: now, lastSeen: now },
        [tokens.prof]: { email: PROF, createdAt: now, lastSeen: now },
        [tokens.prof2]: { email: PROF2, createdAt: now, lastSeen: now },
        [tokens.coord]: { email: COORD, createdAt: now, lastSeen: now },
    };
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: { timezone: 'America/Sao_Paulo' } };
    db.memory.admins = [
        { email: ADMIN, name: 'Administração', role: 'admin', password: db.hashPassword('x') },
        { email: PROF, name: 'Professora', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE, className: '1DES' }] },
        { email: PROF2, name: 'Outro professor', role: 'professor', password: db.hashPassword('x'), assignedClasses: [{ courseId: COURSE, className: '2DES' }] },
        { email: COORD, name: 'Coordenação', role: 'coordenacao', password: db.hashPassword('x'), assignedSchoolIds: ['escola_d'] },
    ];
    db.memory.adminSessions = sessions();
    db.memory.schools = [{ id: 'escola_d', name: 'Escola D', info: {}, branding: {} }];
    db.memory.courses = [
        { id: COURSE, name: 'Desenvolvimento', schoolId: 'escola_d', structure: [], disciplinas: [{ id: 'RED', nome: 'Redes' }, { id: 'PROG', nome: 'Programação' }] },
        { id: OTHER_COURSE, name: 'Administração', schoolId: 'escola_d', structure: [] },
    ];
    const grade = { 2: [{ ordem: 1, disciplinaId: 'RED', inicio: '07:30' }, { ordem: 2, disciplinaId: 'PROG', inicio: '08:20' }] };
    db.memory.classes = [
        { name: '1DES', courseId: COURSE, period: 'Manhã', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade } },
        { name: '2DES', courseId: COURSE, period: 'Tarde', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade } },
        // Turma com o mesmo nome em outro curso (o bug da exportação).
        { name: '1DES', courseId: OTHER_COURSE, period: 'Noite', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade } },
    ];
    db.memory.students = [
        { id: 'alu_00000000000000a1', name: 'Ana Souza', email: 'ana@diario.local', status: 'Ativo', password: db.hashPassword('x'), classes: [{ name: '1DES', courseId: COURSE }] },
        { id: 'alu_00000000000000b2', name: 'Bruno Lima', email: 'bruno@diario.local', status: 'Ativo', password: db.hashPassword('x'), classes: [{ name: '1DES', courseId: OTHER_COURSE }] },
        // Matrícula antiga gravada só pelo nome da turma (sem curso).
        { id: 'alu_00000000000000c3', name: 'Carla Dias', email: 'carla@diario.local', status: 'Ativo', password: db.hashPassword('x'), classes: ['1DES'], courseId: COURSE },
    ];
    db.memory.attendance = [];
    db.memory.classDiary = [];
    db.memory.auditLogs = [];
}

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const save = (who, payload) => as(who, request(app).post('/api/admin/attendance/diary')).send({ courseId: COURSE, studentClass: '1DES', date: DATE, ...payload });
const read = (who, q = Q) => as(who, request(app).get(`/api/admin/attendance/diary?${q}`));

test('[UC-DIARIO-001] o diário do dia vazio traz uma aula por aula da grade, sem versão', async () => {
    const res = await read('prof');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    const day = res.body.diario;
    assert.equal(day.versao, null);
    assert.equal(day.encerrada, false);
    assert.deepEqual(day.aulas.map(aula => [aula.ordem, aula.inicio, aula.disciplinaId, aula.disciplinaNome, aula.naGrade, aula.conteudo]),
        [[1, '07:30', 'RED', 'Redes', true, ''], [2, '08:20', 'PROG', 'Programação', true, '']]);
    assert.equal(res.body.limites.conteudoMax, 2000);
    // Dia sem documento e sem conteúdo: nada é gravado.
    const empty = await save('prof', { versao: null, aulas: [{ ordem: 1, conteudo: '   ' }] });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.changed, false);
    assert.equal(db.memory.classDiary.length, 0);
    assert.equal(audits('diary_saved').length, 0);
});

test('[UC-DIARIO-001] gravar e ler 2 aulas; juntar no mesmo dia; versão velha 409; autosave do mesmo autor sem entrada', async () => {
    const first = await save('prof', { versao: null, aulas: [
        { ordem: 1, conteudo: 'Endereçamento IPv4', atividade: 'Exercícios 1 a 5' },
        { ordem: 2, conteudo: 'Laços de repetição' },
    ] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.changed, true);
    assert.equal(first.body.diario.versao, 1);
    assert.equal(db.memory.classDiary.length, 1);
    const record = db.memory.classDiary[0];
    assert.match(record.id, diary.DIARY_ID_PATTERN);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.registradoPor, PROF);
    assert.equal(typeof record.registradoEm, 'number');
    assert.deepEqual(record.aulas, [
        { ordem: 1, disciplinaId: 'RED', conteudo: 'Endereçamento IPv4', atividade: 'Exercícios 1 a 5', observacao: '' },
        { ordem: 2, disciplinaId: 'PROG', conteudo: 'Laços de repetição', atividade: '', observacao: '' },
    ]);
    const saved = audits('diary_saved');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].category, 'attendance');
    assert.equal(saved[0].courseId, COURSE);
    assert.equal(saved[0].studentClass, '1DES');
    assert.deepEqual(saved[0].details, { date: DATE, aulas: [1, 2] });

    const read1 = await read('prof');
    assert.deepEqual(read1.body.diario.aulas.map(aula => [aula.ordem, aula.conteudo, aula.atividade]),
        [[1, 'Endereçamento IPv4', 'Exercícios 1 a 5'], [2, 'Laços de repetição', '']]);
    assert.equal(read1.body.diario.registradoPor, PROF);

    // O mesmo texto de novo (autosave): não grava nem sobe a versão.
    const same = await save('prof', { versao: 1, aulas: [{ ordem: 1, conteudo: 'Endereçamento IPv4 ' }] });
    assert.equal(same.body.changed, false);
    assert.equal(db.memory.classDiary[0].versao, 1);

    // Só a 1ª aula: a 2ª continua (juntar, não substituir); a disciplina vem da grade.
    const second = await save('prof', { versao: 1, aulas: [{ ordem: 1, conteudo: 'Endereçamento IPv4 e máscara', disciplinaId: 'OUTRA' }] });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.diario.versao, 2);
    assert.deepEqual(db.memory.classDiary[0].aulas.map(aula => [aula.ordem, aula.disciplinaId, aula.conteudo, aula.atividade]),
        [[1, 'RED', 'Endereçamento IPv4 e máscara', 'Exercícios 1 a 5'], [2, 'PROG', 'Laços de repetição', '']]);
    assert.equal(audits('diary_saved').length, 1);
    assert.equal(audits('diary_changed').length, 0, 'autosave do mesmo autor não vira entrada');

    // Outra aba com a versão 1: 409 com o diário de agora, nada muda.
    const stale = await save('prof', { versao: 1, aulas: [{ ordem: 2, conteudo: 'texto da outra aba' }] });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'diary_changed');
    assert.match(stale.body.error, /alterado em outra aba ou por outra pessoa/);
    assert.equal(stale.body.atual.versao, 2);
    assert.equal(db.memory.classDiary[0].aulas[1].conteudo, 'Laços de repetição');
    // Sem versão, com o diário já gravado: também 409 (não sobrescreve às cegas).
    assert.equal((await save('prof', { aulas: [{ ordem: 2, conteudo: 'x' }] })).status, 409);

    // Limpar a 1ª aula inteira: ela sai; o documento fica.
    const cleared = await save('prof', { versao: 2, aulas: [{ ordem: 1, conteudo: '', atividade: '' }] });
    assert.equal(cleared.body.diario.versao, 3);
    assert.deepEqual(db.memory.classDiary[0].aulas.map(aula => aula.ordem), [2]);
    const all = await save('prof', { versao: 3, aulas: [{ ordem: 2, conteudo: '' }] });
    assert.equal(all.status, 200);
    assert.equal(db.memory.classDiary.length, 1, 'o diário do dia nunca é apagado');
    assert.deepEqual(db.memory.classDiary[0].aulas, []);
    assert.equal((await read('prof')).body.diario.versao, 4);
});

test('[UC-DIARIO-001] diary_changed só quando outra pessoa altera ou passaram 24 h, com antes e depois das aulas que mudaram', async () => {
    await save('prof', { versao: null, aulas: [{ ordem: 1, conteudo: 'Aula A' }, { ordem: 2, conteudo: 'Aula B' }] });
    assert.equal((await save('prof', { versao: 1, aulas: [{ ordem: 2, conteudo: 'Aula B revista' }] })).status, 200);
    assert.equal(audits('diary_changed').length, 0);

    // Outra pessoa (o administrador) altera a 2ª aula.
    const other = await save('admin', { versao: 2, aulas: [{ ordem: 2, conteudo: 'Aula B corrigida' }] });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    let changed = audits('diary_changed');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].category, 'attendance');
    assert.equal(changed[0].actor, ADMIN);
    assert.deepEqual(changed[0].details, { date: DATE, versao: 3, aulas: [2] });
    assert.deepEqual(changed[0].before, [{ ordem: 2, disciplinaId: 'PROG', conteudo: 'Aula B revista', atividade: '', observacao: '' }]);
    assert.deepEqual(changed[0].after, [{ ordem: 2, disciplinaId: 'PROG', conteudo: 'Aula B corrigida', atividade: '', observacao: '' }]);
    assert.equal(db.memory.classDiary[0].atualizadoPor, ADMIN);
    // O administrador continua escrevendo: é a edição dele, sem entrada nova.
    await save('admin', { versao: 3, aulas: [{ ordem: 2, conteudo: 'Aula B corrigida de novo' }] });
    assert.equal(audits('diary_changed').length, 1);
    // A professora volta: outra pessoa de novo.
    await save('prof', { versao: 4, aulas: [{ ordem: 1, conteudo: 'Aula A (acréscimo)' }] });
    changed = audits('diary_changed');
    assert.equal(changed.length, 2);
    assert.deepEqual(changed[1].details.aulas, [1]);

    // Mais de 24 h depois do começo da edição, o mesmo autor: vira entrada.
    db.memory.classDiary[0].referenciaAuditoria.em = Date.now() - diary.DIARY_EDIT_SESSION_MS - 60000;
    await save('prof', { versao: 5, aulas: [{ ordem: 1, conteudo: 'Aula A (dia seguinte)' }] });
    assert.equal(audits('diary_changed').length, 3);
    // ... e passa a ser a referência nova: o autosave logo depois não vira entrada.
    await save('prof', { versao: 6, aulas: [{ ordem: 1, conteudo: 'Aula A (dia seguinte, revisto)' }] });
    assert.equal(audits('diary_changed').length, 3);
    assert.equal(audits('diary_saved').length, 1);
});

test('[UC-DIARIO-001] escopo, papéis, schema e grade: 403, 400 e 404 em português, sem gravar', async () => {
    // Professor de outra turma do mesmo curso.
    const outOfScope = await save('prof2', { versao: null, aulas: [{ ordem: 1, conteudo: 'invadir' }] });
    assert.equal(outOfScope.status, 403, JSON.stringify(outOfScope.body));
    assert.equal((await read('prof2')).status, 403);
    // A Coordenação lê, não grava.
    assert.equal((await read('coord')).status, 200);
    const coord = await save('coord', { versao: null, aulas: [{ ordem: 1, conteudo: 'x' }] });
    assert.equal(coord.status, 403);
    assert.equal(coord.body.code, 'read_only_account');
    // 13ª aula e texto grande demais.
    const ordem13 = await save('prof', { versao: null, aulas: [{ ordem: 13, conteudo: 'x' }] });
    assert.equal(ordem13.status, 400);
    assert.equal(ordem13.body.field, 'aulas[0].ordem');
    assert.match(ordem13.body.error, /"aula" deve estar entre 1 e 12/);
    const big = await save('prof', { versao: null, aulas: [{ ordem: 1, conteudo: 'a'.repeat(2001) }] });
    assert.equal(big.status, 400);
    assert.equal(big.body.field, 'aulas[0].conteudo');
    assert.match(big.body.error, /"conteúdo ministrado" aceita no máximo 2\.000 caracteres/);
    const atividade = await save('prof', { versao: null, aulas: [{ ordem: 1, atividade: 'a'.repeat(1001) }] });
    assert.equal(atividade.status, 400);
    assert.match(atividade.body.error, /"atividade" aceita no máximo 1\.000 caracteres/);
    const tooMany = await save('prof', { versao: null, aulas: Array.from({ length: 13 }, (_, i) => ({ ordem: (i % 12) + 1 })) });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /no máximo 12 itens/);
    const noList = await save('prof', { versao: null });
    assert.equal(noList.status, 400);
    assert.equal(noList.body.field, 'aulas');
    // Aula fora da grade do dia, aula repetida, data que não existe, turma de outro curso.
    const notInGrade = await save('prof', { versao: null, aulas: [{ ordem: 5, conteudo: 'x' }] });
    assert.equal(notInGrade.status, 400);
    assert.equal(notInGrade.body.code, 'lesson_not_in_grade');
    assert.match(notInGrade.body.error, /5ª aula não está na grade da turma neste dia/);
    const repeated = await save('prof', { versao: null, aulas: [{ ordem: 1, conteudo: 'a' }, { ordem: 1, conteudo: 'b' }] });
    assert.equal(repeated.status, 400);
    assert.match(repeated.body.error, /aparece duas vezes/);
    const badDate = await save('prof', { versao: null, date: '2026-02-30', aulas: [{ ordem: 1, conteudo: 'x' }] });
    assert.equal(badDate.status, 400);
    assert.equal(badDate.body.field, 'date');
    assert.equal((await read('prof', `courseId=${COURSE}&studentClass=1DES&date=10/11/2026`)).status, 400);
    const missingClass = await save('admin', { versao: null, studentClass: '9ZZ', aulas: [{ ordem: 1, conteudo: 'x' }] });
    assert.equal(missingClass.status, 404);
    // Texto de 2000 caracteres passa.
    assert.equal((await save('prof', { versao: null, aulas: [{ ordem: 1, conteudo: 'a'.repeat(2000) }] })).status, 200);
    assert.equal(db.memory.classDiary.length, 1);
    assert.equal(audits('diary_saved').length, 1);
});

test('[UC-DIARIO-001] turma homônima de outro curso tem diário próprio; turma encerrada mostra o diário e recusa gravar', async () => {
    await save('admin', { versao: null, aulas: [{ ordem: 1, conteudo: 'Do curso de Desenvolvimento' }] });
    const other = await read('admin', `courseId=${OTHER_COURSE}&studentClass=1DES&date=${DATE}`);
    assert.equal(other.status, 200);
    assert.equal(other.body.diario.versao, null);
    assert.equal(other.body.diario.aulas[0].conteudo, '');
    db.memory.classes[0].encerramento = { schemaVersion: 1, situacao: 'encerrada', em: Date.now(), por: ADMIN, criterios: {} };
    const closed = await read('prof');
    assert.equal(closed.body.diario.encerrada, true);
    assert.equal(closed.body.diario.aulas[0].conteudo, 'Do curso de Desenvolvimento');
    const refused = await save('prof', { versao: 1, aulas: [{ ordem: 1, conteudo: 'mudar' }] });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'class_closed');
});

test('[UC-DIARIO-001] aula gravada que saiu da grade continua no diário (naGrade false) e pode ser alterada', async () => {
    await save('prof', { versao: null, aulas: [{ ordem: 2, conteudo: 'Laços' }] });
    // A grade da terça muda: a 2ª aula sai.
    db.memory.classes[0].attendanceConfig.grade = { 2: [{ ordem: 1, disciplinaId: 'RED', inicio: '07:30' }] };
    const res = await read('prof');
    assert.deepEqual(res.body.diario.aulas.map(aula => [aula.ordem, aula.naGrade, aula.disciplinaNome, aula.conteudo]),
        [[1, true, 'Redes', ''], [2, false, 'Programação', 'Laços']]);
    const edit = await save('prof', { versao: 1, aulas: [{ ordem: 2, conteudo: 'Laços e vetores' }] });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(db.memory.classDiary[0].aulas[0].disciplinaId, 'PROG');
});

test('[UC-DIARIO-001] falha ao gravar no banco desfaz a mudança na memória; a tela tenta de novo com a mesma versão', async () => {
    await save('prof', { versao: null, aulas: [{ ordem: 1, conteudo: 'Aula 1' }] });
    const auditCount = db.memory.auditLogs.length;
    const original = db.save;
    db.save = async () => { throw Object.assign(new Error('disco cheio'), { code: 'SQLITE_FULL' }); };
    let failed;
    try {
        failed = await save('admin', { versao: 1, aulas: [{ ordem: 1, conteudo: 'Aula 1 alterada' }] });
    } finally {
        db.save = original;
    }
    assert.ok(failed.status >= 500, `${failed.status} ${JSON.stringify(failed.body)}`);
    assert.equal(db.memory.classDiary[0].versao, 1);
    assert.equal(db.memory.classDiary[0].aulas[0].conteudo, 'Aula 1');
    assert.equal(db.memory.auditLogs.length, auditCount, 'a auditoria da tentativa saiu junto');
    const retry = await save('admin', { versao: 1, aulas: [{ ordem: 1, conteudo: 'Aula 1 alterada' }] });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.diario.versao, 2);
    // Falha ao criar o dia: o documento novo sai.
    db.save = async () => { throw new Error('falhou'); };
    try {
        await save('prof', { versao: null, date: '2026-11-17', aulas: [{ ordem: 1, conteudo: 'outro dia' }] });
    } finally {
        db.save = original;
    }
    assert.equal(db.memory.classDiary.length, 1);
});

test('[UC-DIARIO-001] leitura tolerante: linha sem versão, com aula inválida ou repetida, sem reescrever', () => {
    const memory = {
        classes: [{ name: '1DES', courseId: COURSE, attendanceConfig: { grade: { 2: [{ ordem: 1, disciplinaId: 'RED', inicio: '07:30' }] } } }],
        classDiary: [{ id: 'dia_velho', courseId: COURSE, studentClass: '1DES', date: DATE, aulas: [
            { ordem: 1, conteudo: 'Primeira' }, { ordem: 1, conteudo: 'Repetida' }, { ordem: 99, conteudo: 'inválida' }, 'lixo', { ordem: 3, conteudo: 5 },
        ] }],
    };
    const before = JSON.stringify(memory.classDiary);
    const view = diary.diaryDayView(memory, { cls: memory.classes[0], course: null, date: DATE });
    assert.equal(view.versao, 0);
    assert.deepEqual(view.aulas.map(aula => [aula.ordem, aula.conteudo]), [[1, 'Primeira']]);
    assert.equal(JSON.stringify(memory.classDiary), before);
    // Duas linhas do mesmo dia (backup com a chave composta repetida): vale a de versão maior.
    memory.classDiary.push({ id: 'dia_novo', courseId: COURSE, studentClass: '1DES', date: DATE, versao: 3, aulas: [{ ordem: 1, conteudo: 'Mais nova' }] });
    assert.equal(diary.findDiary(memory, { courseId: COURSE, studentClass: '1DES', date: DATE }).id, 'dia_novo');
});

test('[UC-DIARIO-003] exportação da presença com from, to e courseId: sem a turma homônima de outro curso e sem datas fora do período', async () => {
    const record = (email, courseId, date, status) => ({
        id: `att_${email}_${date}_${courseId}`, studentEmail: email, studentClass: '1DES', courseId, date, origin: 'chamada', concluida: true,
        aulas: [{ ordem: 1, disciplinaId: 'RED', inicio: '07:30', status, hora: '' }], markedBy: PROF, timestamp: Date.now(),
    });
    db.memory.attendance = [
        record('ana@diario.local', COURSE, '2026-11-03', 'presente'),
        record('ana@diario.local', COURSE, '2026-11-10', 'falta'),
        record('ana@diario.local', COURSE, '2026-10-27', 'presente'), // fora do período
        record('bruno@diario.local', OTHER_COURSE, '2026-11-10', 'presente'), // outro curso
        { ...record('carla@diario.local', '', '2026-11-05', 'presente'), courseId: '' }, // registro antigo sem curso
    ];
    const exportCsv = async (who, q) => {
        const res = await as(who, request(app).get(`/api/admin/attendance/export?${q}`)).buffer(true).parse((r, done) => {
            const chunks = [];
            r.on('data', chunk => chunks.push(chunk));
            r.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
        });
        return res;
    };
    const res = await exportCsv('prof', `studentClass=1DES&courseId=${COURSE}&from=2026-11-01&to=2026-11-30`);
    assert.equal(res.status, 200, res.body);
    const lines = res.body.replace(/^﻿/, '').trim().split(/\r?\n/);
    assert.equal(lines.length, 4, res.body);
    assert.ok(lines.slice(1).every(line => !line.includes('Bruno')), 'a turma homônima de outro curso não entra');
    assert.ok(lines.slice(1).every(line => !line.includes('2026-10-27')), 'data fora do período não entra');
    assert.deepEqual(lines.slice(1).map(line => line.split(';')[0]), ['2026-11-03', '2026-11-05', '2026-11-10']);
    assert.ok(lines.some(line => line.includes('Carla Dias')), 'registro antigo sem curso continua');

    // O administrador, que vê os dois cursos, também só recebe o curso pedido.
    const adminRes = await exportCsv('admin', `studentClass=1DES&courseId=${OTHER_COURSE}`);
    const adminLines = adminRes.body.replace(/^﻿/, '').trim().split(/\r?\n/);
    assert.equal(adminLines.length, 2);
    assert.match(adminLines[1], /Bruno Lima/);

    // Tela antiga, sem curso, com a turma em dois cursos: 400 (antes misturava os dois).
    const ambiguous = await exportCsv('admin', 'studentClass=1DES');
    assert.equal(ambiguous.status, 400);
    assert.equal(JSON.parse(ambiguous.body).code, 'course_required');
    // Turma de nome único continua exportando sem curso.
    db.memory.attendance.push({ ...record('ana@diario.local', COURSE, '2026-11-11', 'presente'), studentClass: '2DES', id: 'att_2des' });
    db.memory.students[0].classes.push({ name: '2DES', courseId: COURSE });
    const unique = await exportCsv('admin', 'studentClass=2DES');
    assert.equal(unique.status, 200);
    assert.match(unique.body, /2026-11-11/);
    // Período ao contrário e curso sem a turma.
    assert.equal((await exportCsv('admin', `studentClass=1DES&courseId=${COURSE}&from=2026-11-30&to=2026-11-01`)).status, 400);
    assert.equal((await exportCsv('admin', 'studentClass=1DES&courseId=curso-que-nao-existe')).status, 404);
});

async function downloadBackup() {
    const response = await as('admin', request(app).get(await ticketUrl(app, tokens.admin, 'x', '/api/admin/backup/data'))).buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    assert.equal(response.status, 200);
    return JSON.parse(response.body.toString('utf8'));
}

// Restaurar desconecta todos (as sessões não vão no backup): as sessões do teste voltam.
async function restoreBackup(backup, name = 'backup-diario.json') {
    const response = await as('admin', request(app).post('/api/admin/backup/restore'))
        .field('confirm', 'RESTAURAR')
        .attach('file', Buffer.from(JSON.stringify(backup)), name);
    db.memory.adminSessions = sessions();
    return response;
}

test('[UC-DIARIO-004] backup: o diário vai e volta; backup de antes do diário mantém o diário atual', async () => {
    const entry = db.COLLECTION_TABLES.find(item => item.collection === 'classDiary');
    assert.ok(entry, 'classDiary está no registro');
    assert.equal(missingCollectionOutcome(entry), 'keep');

    await save('prof', { versao: null, aulas: [{ ordem: 1, conteudo: 'Conteúdo do backup' }] });
    await db.save();
    const backup = await downloadBackup();
    assert.equal(backup.data.classDiary.length, 1);
    assert.equal(backup.data.classDiary[0].aulas[0].conteudo, 'Conteúdo do backup');

    // Depois do backup, o diário muda; restaurar traz o do backup.
    await save('prof', { versao: 1, aulas: [{ ordem: 1, conteudo: 'Depois do backup' }] });
    const restored = await restoreBackup(backup);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(db.memory.classDiary.length, 1);
    assert.equal(db.memory.classDiary[0].aulas[0].conteudo, 'Conteúdo do backup');
    assert.equal(db.memory.classDiary[0].versao, 1);

    // Backup de antes desta função (sem classDiary, como o do 281029f): o diário de agora fica.
    await save('prof', { versao: 1, aulas: [{ ordem: 2, conteudo: 'Escrito depois' }] });
    const old = JSON.parse(JSON.stringify(backup));
    delete old.data.classDiary;
    const keep = await restoreBackup(old, 'backup-antigo.json');
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.deepEqual(db.memory.classDiary[0].aulas.map(aula => [aula.ordem, aula.conteudo]), [[1, 'Conteúdo do backup'], [2, 'Escrito depois']]);
    assert.equal(db.memory.classDiary[0].versao, 2);
});
