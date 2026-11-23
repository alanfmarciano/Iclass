// Critérios de avaliação, plano da turma e avaliação manual no servidor (fase 3, B6 /
// P2-S3; FUN-02): as rotas /api/admin/grading/* (permissão, escopo, schema, motivo,
// gravação parcial e auditoria), a nota da avaliação manual pelo submissions/create, o
// quadro e o boletim pela conta única (gradingRules) com etapa, peso e recuperação
// (finalidade da aplicação, contrato C3), o resumo de notas do aluno
// (/api/student/grades-summary, só o publicado), o provedor de itens (contrato C2) e a
// média da ficha, do Dashboard e do Início do portal. Cada teste falha no código de antes
// (não havia rota de critérios nem de plano, examKey 'man_*' era recusado e a média era
// sempre a simples).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-grading-routes-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor (o uncaughtException do server.js engoliria a falha deles).
const gradingRules = require('../../backend/utils/gradingRules.js');
const gradebook = require('../../backend/utils/gradebook.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createStudentSession } = require('../../backend/utils/authSessions.js');

const COURSE = 'TI';
const tokens = { admin: 'tok-grading-admin', prof: 'tok-grading-prof', monitor: 'tok-grading-monitor', coord: 'tok-grading-coord', prof2: 'tok-grading-prof2' };
let app;
const as = (who, method, url) => request(app)[method](url).set('x-admin-session', tokens[who]);
const asStudent = (email, url) => request(app).get(url).set('x-session-token', createStudentSession(db.memory, email));
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);

const CRITERIA = {
    courseId: COURSE,
    ativo: true,
    mediaMinima: 6,
    frequenciaMinima: 75,
    etapas: [{ ordem: 1, nome: '1º bimestre', peso: 1 }, { ordem: 2, nome: '2º bimestre', peso: 2 }],
    recuperacao: { etapa: 'nenhuma', final: 'substitui_se_maior' },
    mencoes: [{ sigla: 'MB', nome: 'Muito bom', min: 9 }, { sigla: 'B', nome: 'Bom', min: 7 }, { sigla: 'R', nome: 'Regular', min: 6 }, { sigla: 'I', nome: 'Insuficiente', min: 0 }],
    unidadeSituacao: 'turma',
};
const PLAN = { Av_P1: { etapa: 1, peso: 1 }, Av_P2: { etapa: 1, peso: 3 }, Av_P3: { etapa: 2 } };

let subSeq = 0;
function sub(email, examKey, score, { published = true, cls = '1DES', applicationId = null, timestamp = '2026-03-10T12:00:00.000Z' } = {}) {
    subSeq += 1;
    return {
        id: `sub_grading_${subSeq}`,
        student: { name: email.split('@')[0], email, studentClass: cls, courseId: COURSE },
        examKey,
        score,
        type: 'impressa',
        entryMode: 'quick',
        attemptNumber: 1,
        resultStatus: 'considered',
        aggregationPolicy: 'highest',
        selectedForResult: false,
        gradePublished: published,
        timestamp,
        ...(applicationId ? { applicationId } : {}),
    };
}

function seed() {
    db.memory.courses = [{
        id: COURSE,
        name: 'Informática',
        schoolId: 'esc_a',
        structure: [
            { id: 'M1', name: 'Redes', units: [
                { key: 'u1', name: 'Prova 1', avaliacaoKey: 'Av_P1' },
                { key: 'u2', name: 'Prova 2', avaliacaoKey: 'Av_P2' },
            ] },
            { id: 'M2', name: 'Banco de Dados', units: [{ key: 'u3', name: 'Prova 3', avaliacaoKey: 'Av_P3' }] },
        ],
        disciplinas: [],
    }];
    db.memory.schools = [{ id: 'esc_a', name: 'Escola A' }];
    db.memory.classes = [
        { name: '1DES', courseId: COURSE, period: 'Manhã' },
        { name: '2DES', courseId: COURSE, period: 'Noite' },
    ];
    db.memory.evaluations = {
        Av_P1: { title: 'Prova 1', questions: [{ originalNumber: 1, text: 'Q1', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }] }] },
        Av_P2: { title: 'Prova 2', questions: [] },
        Av_P3: { title: 'Prova 3', questions: [] },
    };
    db.memory.examApplications = [];
    db.memory.attendance = [];
    db.memory.academicTerms = [];
    db.memory.admins = [
        { email: 'admin@grading.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-admin-ok') },
        { email: 'prof@grading.local', name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof-ok'), assignedClasses: [{ courseId: COURSE, className: '1DES' }] },
        { email: 'prof2@grading.local', name: 'Prof 2', role: 'professor', password: db.hashPassword('senha-prof-ok'), assignedClasses: [{ courseId: COURSE, className: '2DES' }] },
        { email: 'monitor@grading.local', name: 'Monitor', role: 'monitor', password: db.hashPassword('senha-mon-ok'), assignedClasses: [{ courseId: COURSE, className: '1DES' }] },
        { email: 'coord@grading.local', name: 'Coord', role: 'coordenacao', password: db.hashPassword('senha-coord-ok'), assignedSchoolIds: ['esc_a'] },
    ];
    const now = Date.now();
    db.memory.adminSessions = Object.fromEntries(Object.entries({ admin: 'admin', prof: 'prof', prof2: 'prof2', monitor: 'monitor', coord: 'coord' })
        .map(([who, user]) => [tokens[who], { email: `${user}@grading.local`, createdAt: now, lastSeen: now }]));
    db.memory.students = [
        { name: 'Ana', email: 'ana@grading.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }], studentClass: '1DES' },
        { name: 'Bia', email: 'bia@grading.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: COURSE }], studentClass: '1DES' },
        { name: 'Caio', email: 'caio@grading.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '2DES', courseId: COURSE }], studentClass: '2DES' },
    ];
    db.memory.submissions = [
        // Ana: 4,0 e 8,0 no 1º bimestre (pesos 1 e 3) e 7,0 no 2º: média final 7,0
        // (sem critérios, a média simples 6,3).
        sub('ana@grading.local', 'Av_P1', 40),
        sub('ana@grading.local', 'Av_P2', 80),
        sub('ana@grading.local', 'Av_P3', 70),
        // Bia: 10,0 e 4,0 (1º: 5,5) e 5,0 (2º): média final 5,2.
        sub('bia@grading.local', 'Av_P1', 100),
        sub('bia@grading.local', 'Av_P2', 40),
        sub('bia@grading.local', 'Av_P3', 50),
        sub('caio@grading.local', 'Av_P1', 90, { cls: '2DES' }),
    ];
    db.memory.auditLogs = [];
    db.memory.studentSessions = {};
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => seed());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function capturingSaves(fn) {
    const originalSave = db.save;
    const calls = [];
    db.save = (...args) => { calls.push(args[0] || null); return originalSave.apply(db, args); };
    try {
        await fn();
    } finally {
        db.save = originalSave;
    }
    return calls;
}

// O curso já tem nota publicada: ligar ou mudar a regra pede motivo (o padrão daqui).
async function saveCriteria(fields = {}, who = 'admin') {
    return as(who, 'post', '/api/admin/grading/criteria').send({ ...CRITERIA, reason: 'Critérios do curso', ...fields });
}

async function savePlan(itens, fields = {}, who = 'admin') {
    return as(who, 'post', '/api/admin/grading/plan').send({ courseId: COURSE, studentClass: '1DES', itens, ...fields });
}

async function gradebookOf(studentClass = '1DES', who = 'admin', query = '') {
    const res = await as(who, 'get', `/api/admin/gradebook?courseId=${COURSE}&studentClass=${studentClass}${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res;
}

const rowOf = (gb, email) => gb.body.rows.find(row => row.email === email);

// ------------------------------------------------------------------ critérios

test('[UC-NOTAS-006] critérios: o professor lê, só quem tem course.manage grava; escopo, schema e vírgula', async () => {
    const read = await as('prof', 'get', `/api/admin/grading/criteria?courseId=${COURSE}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.ativo, false);
    assert.equal(read.body.regraAntiga, true);
    assert.equal(read.body.criterios.mediaMinima, 6, 'sem critérios gravados, os padrões');
    assert.equal(read.body.podeAlterar, false, 'o professor não altera a média mínima');
    assert.ok(read.body.regrasRecuperacao.some(item => item.value === 'substitui_se_maior' && /maior/i.test(item.label)));

    assert.equal((await as('prof', 'get', '/api/admin/grading/criteria?courseId=OUTRO')).status, 403, 'curso fora do escopo');
    assert.equal((await as('monitor', 'get', `/api/admin/grading/criteria?courseId=${COURSE}`)).status, 403, 'o Monitor não tem page.results');
    assert.equal((await saveCriteria({}, 'prof')).status, 403, 'o professor não grava os critérios');
    assert.equal((await saveCriteria({}, 'coord')).status, 403, 'conta só de consulta');
    assert.equal(db.memory.courses[0].avaliacao, undefined, 'nada gravado');

    const bad = await saveCriteria({ mediaMinima: 11 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'mediaMinima');
    const dup = await saveCriteria({ etapas: [{ ordem: 1, nome: 'A' }, { ordem: 1, nome: 'B' }] });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.field, 'etapas[1].ordem');
    assert.match(dup.body.error, /mais de uma vez/);
    const gap = await saveCriteria({ etapas: [{ ordem: 1 }, { ordem: 3 }] });
    assert.equal(gap.status, 400);
    assert.match(gap.body.error, /sequência/);
    assert.equal((await saveCriteria({ recuperacao: { final: 'dobro' } })).status, 400);
    assert.equal((await saveCriteria({ mencoes: [{ sigla: 'MB', min: 9 }, { sigla: 'mb', min: 8 }] })).body.field, 'mencoes[1].sigla');
    // Sem a faixa que começa em 0,0, a nota abaixo da menor ficava sem menção.
    const noFloor = await saveCriteria({ mencoes: [{ sigla: 'MB', nome: 'Muito bom', min: 9 }, { sigla: 'B', nome: 'Bom', min: 7 }] });
    assert.equal(noFloor.status, 400);
    assert.equal(noFloor.body.field, 'mencoes');
    assert.match(noFloor.body.error, /0,0/);
    const previewNoFloor = await as('admin', 'post', '/api/admin/grading/preview').send({ courseId: COURSE, studentClass: '1DES', criterios: { mencoes: [{ sigla: 'MB', min: 9 }] } });
    assert.equal(previewNoFloor.status, 400);
    assert.equal(previewNoFloor.body.field, 'criterios.mencoes');
    assert.equal(db.memory.courses[0].avaliacao, undefined, 'recusa não grava');

    let res;
    const saves = await capturingSaves(async () => { res = await saveCriteria({ mediaMinima: '6,5' }); });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(saves.map(call => call && call.only), [['courses', 'auditLogs']]);
    const stored = db.memory.courses[0].avaliacao;
    assert.equal(stored.ativo, true);
    assert.equal(stored.mediaMinima, 6.5, '"6,5" com vírgula vale 6,5');
    assert.equal(stored.etapas.length, 2);
    assert.equal(stored.atualizadoPor, 'admin@grading.local');
    const audit = audits('grading_criteria_updated');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].category, 'academic');
    assert.equal(audit[0].courseId, COURSE);
    assert.equal(audit[0].before, null);
    assert.equal(audit[0].after.mediaMinima, 6.5);
    assert.equal(audit[0].reason, 'Critérios do curso');

    // O mesmo de novo não grava nem audita.
    const again = await saveCriteria({ mediaMinima: 6.5 });
    assert.equal(again.body.semMudanca, true);
    assert.equal(audits('grading_criteria_updated').length, 1);

    // Desligar guarda o resto (religar volta igual).
    const off = await as('admin', 'post', '/api/admin/grading/criteria').send({ courseId: COURSE, ativo: false });
    assert.equal(off.status, 400, 'há nota publicada no curso: pede motivo');
    assert.equal(off.body.code, 'reason_required');
    const offOk = await as('admin', 'post', '/api/admin/grading/criteria').send({ courseId: COURSE, ativo: false, reason: 'Voltar à regra antiga' });
    assert.equal(offOk.status, 200, JSON.stringify(offOk.body));
    assert.equal(db.memory.courses[0].avaliacao.ativo, false);
    assert.equal(db.memory.courses[0].avaliacao.mediaMinima, 6.5);
    assert.equal(gradingRules.normalizeCriteria(db.memory.courses[0].avaliacao), null, 'desligado vale a regra antiga');
    assert.equal(audits('grading_criteria_updated').pop().reason, 'Voltar à regra antiga');
    const view = await as('admin', 'get', `/api/admin/grading/criteria?courseId=${COURSE}`);
    assert.equal(view.body.ativo, false);
    assert.equal(view.body.criterios.mediaMinima, 6.5);
    assert.equal(view.body.temNotaPublicada, true);
    assert.equal(view.body.podeAlterar, true);
});

test('[UC-NOTAS-006] critérios: sem nota publicada no curso, mudar a regra não pede motivo', async () => {
    db.memory.submissions.forEach(item => { item.gradePublished = false; });
    assert.equal((await saveCriteria({ reason: undefined })).status, 200);
    const changed = await saveCriteria({ mediaMinima: 7, reason: undefined });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    db.memory.submissions[0].gradePublished = true;
    const needs = await saveCriteria({ mediaMinima: 5, reason: undefined });
    assert.equal(needs.status, 400);
    assert.equal(needs.body.code, 'reason_required');
    assert.equal(db.memory.courses[0].avaliacao.mediaMinima, 7, 'sem motivo, nada muda');
});

// ------------------------------------------------------------------ plano e conta única

test('[UC-NOTAS-005] plano da turma: etapa e peso pelo professor, ids de fora ignorados, motivo com nota publicada, gravação parcial', async () => {
    assert.equal((await saveCriteria()).status, 200);
    const before = await as('prof', 'get', `/api/admin/grading/plan?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.ativo, true);
    assert.deepEqual(before.body.itens.map(item => [item.id, item.origem, item.etapa, item.peso]), [
        ['Av_P1', 'prova', null, 1], ['Av_P2', 'prova', null, 1], ['Av_P3', 'prova', null, 1],
    ]);
    assert.equal(before.body.itens[0].modulo, 'Redes');
    assert.equal(before.body.itens[0].notasLancadas, 2);
    assert.equal(before.body.itens[0].notasPublicadas, 2);
    assert.deepEqual(before.body.avisos, ['3 avaliações sem etapa não entram na média.']);
    assert.deepEqual(before.body.etapas.map(etapa => etapa.nome), ['1º bimestre', '2º bimestre']);
    assert.equal((await as('prof', 'get', `/api/admin/grading/plan?courseId=${COURSE}&studentClass=2DES`)).status, 403, 'turma de outro professor');

    // Etapa que não existe nos critérios e recuperação fora do padrão são recusadas.
    const noStage = await savePlan({ Av_P1: { etapa: 3 } });
    assert.equal(noStage.status, 400);
    assert.equal(noStage.body.field, 'itens.Av_P1.etapa');
    assert.equal((await savePlan({ Av_P1: { recuperacaoDe: 'etapa:9' } })).status, 400);
    assert.equal((await savePlan({ Av_P1: { peso: 11 } })).status, 400);
    assert.equal((await as('admin', 'post', '/api/admin/grading/plan').send({ courseId: COURSE, studentClass: '1DES', itens: JSON.parse('{"__proto__": {"etapa": 1}}') })).status, 400);

    // Com critérios ligados e nota publicada: pede motivo.
    const noReason = await savePlan(PLAN, {}, 'prof');
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'reason_required');
    assert.equal(db.memory.classes[0].avaliacao, undefined);

    let res;
    const saves = await capturingSaves(async () => { res = await savePlan({ ...PLAN, Av_Inexistente: { etapa: 1 } }, { reason: 'Plano do semestre' }, 'prof'); });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(saves.map(call => call && call.only), [['classes', 'auditLogs']]);
    assert.deepEqual(res.body.ignorados, ['Av_Inexistente']);
    assert.deepEqual(res.body.alterados.sort(), ['Av_P1', 'Av_P2', 'Av_P3']);
    assert.deepEqual(db.memory.classes[0].avaliacao.itens.Av_P2, { etapa: 1, peso: 3, recuperacaoDe: null, fora: false });
    await db.flush();
    const disk = await db.readStoredData();
    assert.equal(disk.memory.classes.find(item => item.name === '1DES').avaliacao.itens.Av_P2.peso, 3, 'foi para o disco');
    assert.equal(disk.memory.courses.find(item => item.id === COURSE).avaliacao.etapas.length, 2, 'os critérios foram para o disco');
    assert.equal(db.memory.classes[1].avaliacao, undefined, 'a outra turma não muda');
    const audit = audits('grading_plan_updated');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].studentClass, '1DES');
    assert.equal(audit[0].reason, 'Plano do semestre');
    assert.deepEqual(Object.keys(audit[0].after).sort(), ['Av_P1', 'Av_P2', 'Av_P3']);
    assert.deepEqual(res.body.plano.avisos, []);

    // Só o que mudou entra na auditoria; o que não mudou não grava.
    const one = await savePlan({ Av_P1: { etapa: 1, peso: 2 }, Av_P2: { etapa: 1, peso: 3 } }, { reason: 'Peso da P1' });
    assert.deepEqual(one.body.alterados, ['Av_P1']);
    assert.deepEqual(Object.keys(audits('grading_plan_updated').pop().after), ['Av_P1']);
    assert.equal(db.memory.classes[0].avaliacao.itens.Av_P1.peso, 2);
    const same = await savePlan({ Av_P1: { peso: 2 } });
    assert.equal(same.body.semMudanca, true);
    assert.equal(audits('grading_plan_updated').length, 2);
});

test('[UC-NOTAS-005] quadro, CSV e boletim com critérios: média ponderada por etapa, situação e menção pela conta única', async () => {
    const legacy = await gradebookOf();
    assert.equal(rowOf(legacy, 'ana@grading.local').average, 6.3, 'sem critérios, a média simples');
    assert.equal(rowOf(legacy, 'ana@grading.local').situacao, undefined);

    assert.equal((await saveCriteria()).status, 200);
    assert.equal((await savePlan(PLAN, { reason: 'Plano do semestre' })).status, 200);
    const gb = await gradebookOf();
    const ana = rowOf(gb, 'ana@grading.local');
    assert.equal(ana.mediaFinal, 7);
    assert.equal(ana.average, 7, 'a coluna Média é a média final');
    assert.equal(ana.situacao, 'aprovado');
    assert.equal(ana.situacaoRotulo, 'Aprovado');
    assert.equal(ana.mencao.sigla, 'B');
    assert.deepEqual(ana.etapas.map(etapa => [etapa.ordem, etapa.media]), [[1, 7], [2, 7]]);
    const bia = rowOf(gb, 'bia@grading.local');
    assert.equal(bia.mediaFinal, 5.2);
    assert.equal(bia.situacao, 'em_recuperacao', 'abaixo da mínima, com recuperação final por lançar');
    assert.deepEqual(gb.body.etapas.map(etapa => etapa.nome), ['1º bimestre', '2º bimestre']);
    assert.equal(gb.body.criterio.regraAntiga, false);
    const col = gb.body.columns.find(column => column.examKey === 'Av_P2' || column.id === 'Av_P2');
    assert.equal(col.etapa, 1);
    assert.equal(col.peso, 3);

    const csv = await gradebookOf('1DES', 'admin', '&format=csv');
    const header = csv.text.replace(/^﻿/, '').split(/\r?\n/)[0];
    assert.match(header, /1º bimestre/);
    assert.match(header, /Média final/);
    assert.match(header, /Situação/);
    assert.match(header, /Menção/);
    assert.match(csv.text, /Aprovado/);

    const report = await as('admin', 'get', `/api/admin/student/report?email=ana@grading.local&courseId=${COURSE}&studentClass=1DES`);
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.equal(report.body.mediaFinal, 7);
    assert.equal(report.body.overallAverage, 7);
    assert.equal(report.body.situacao, 'aprovado');
    assert.equal(report.body.mencao.sigla, 'B');
    assert.deepEqual(report.body.etapas.map(etapa => etapa.media), [7, 7]);

    // A ficha, o Dashboard e o Início do portal usam a mesma média final.
    const ficha = await as('admin', 'get', `/api/admin/student/dashboard?email=ana@grading.local&courseId=${COURSE}&studentClass=1DES`);
    assert.equal(ficha.status, 200);
    assert.equal(ficha.body.kpis.media, 7);
    const overview = await as('admin', 'get', `/api/admin/dashboard/students-overview?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(overview.body.find(item => item.email === 'ana@grading.local').media, 7);
    assert.equal(overview.body.find(item => item.email === 'bia@grading.local').media, 5.2);
    const portal = await asStudent('ana@grading.local', `/api/student/dashboard?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(portal.status, 200, JSON.stringify(portal.body));
    assert.equal(portal.body.overallNote, 7);
    assert.equal(portal.body.situacao, 'aprovado');
});

test('[UC-NOTAS-005] finalidade da aplicação (C3): recuperação entra como recuperação e segunda chamada como o mesmo item', async () => {
    assert.equal((await saveCriteria()).status, 200);
    assert.equal((await savePlan(PLAN, { reason: 'Plano do semestre' })).status, 200);
    db.memory.examApplications = [
        { id: 'app_rec', examKey: 'Av_P3', courseId: COURSE, studentClass: '1DES', finalidade: 'recuperacao', title: 'Recuperação' },
        { id: 'app_2ch', examKey: 'Av_P3', courseId: COURSE, studentClass: '1DES', finalidade: 'segunda_chamada', title: 'Segunda chamada' },
    ];
    // Bia faz a recuperação (8,0): a recuperação final substitui a média 5,2.
    db.memory.submissions.push(sub('bia@grading.local', 'Av_P3', 80, { applicationId: 'app_rec' }));
    // Ana perdeu a P3 e fez a segunda chamada (7,0): conta como a P3.
    db.memory.submissions = db.memory.submissions.filter(item => !(item.student.email === 'ana@grading.local' && item.examKey === 'Av_P3'));
    db.memory.submissions.push(sub('ana@grading.local', 'Av_P3', 70, { applicationId: 'app_2ch' }));
    const gb = await gradebookOf();
    const bia = rowOf(gb, 'bia@grading.local');
    assert.equal(bia.mediaFinal, 8, JSON.stringify(bia.etapas));
    assert.equal(bia.situacao, 'aprovado');
    const ana = rowOf(gb, 'ana@grading.local');
    assert.equal(ana.mediaFinal, 7);
    assert.equal(ana.etapas[1].media, 7);
});

test('[UC-NOTAS-005] prévia: mostra quem muda de média e de situação sem gravar nada', async () => {
    let res;
    const saves = await capturingSaves(async () => {
        res = await as('prof', 'post', '/api/admin/grading/preview').send({ courseId: COURSE, studentClass: '1DES', criterios: { ...CRITERIA, courseId: undefined }, plano: { itens: PLAN } });
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(saves, [], 'a prévia não grava');
    assert.equal(db.memory.courses[0].avaliacao, undefined);
    assert.equal(db.memory.classes[0].avaliacao, undefined);
    const ana = res.body.mudancas.find(item => item.email === 'ana@grading.local');
    assert.equal(ana.mediaAntes, 6.3);
    assert.equal(ana.mediaDepois, 7);
    assert.equal(ana.situacaoAntes, null);
    assert.equal(ana.situacaoDepois, 'aprovado');
    assert.equal(res.body.contagemProposta.aprovado, 1);
    assert.equal(res.body.contagemProposta.em_recuperacao, 1);
    assert.match(res.body.resumo, /2 alunos mudam de situação/);
    assert.equal(rowOf({ body: res.body.quadro }, 'ana@grading.local').mediaFinal, 7);

    // Sem turma: as turmas do curso no escopo da conta (o professor só vê a 1DES).
    const course = await as('prof', 'post', '/api/admin/grading/preview').send({ courseId: COURSE, criterios: { mediaMinima: 9 } });
    assert.equal(course.status, 200, JSON.stringify(course.body));
    assert.deepEqual(course.body.turmas, ['1DES']);
    const all = await as('admin', 'post', '/api/admin/grading/preview').send({ courseId: COURSE, criterios: { mediaMinima: 9 } });
    assert.deepEqual(all.body.turmas.sort(), ['1DES', '2DES']);
    assert.ok(all.body.mudancas.some(item => item.studentClass === '2DES'), JSON.stringify(all.body));
    assert.equal((await as('prof', 'post', '/api/admin/grading/preview').send({ courseId: COURSE, studentClass: '2DES' })).status, 403);
});

// ------------------------------------------------------------------ avaliação manual

test('[UC-NOTAS-006] avaliação manual: criar "Seminário", lançar 8,5, recusar acertos, aparecer no quadro e no boletim só depois de publicar', async () => {
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES' })).status, 400, 'sem título');
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES', titulo: 'X', tipo: 'prova' })).status, 400, 'tipo fora da lista');
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES', titulo: 'X', data: '2026-02-30' })).body.field, 'data');
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES', titulo: 'X', moduloId: 'M9' })).body.field, 'moduloId');
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '2DES', titulo: 'X' })).status, 403);
    assert.equal((await as('monitor', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES', titulo: 'X' })).status, 403);

    let created;
    const saves = await capturingSaves(async () => {
        created = await as('prof', 'post', '/api/admin/grading/manual-items/create').send({
            courseId: COURSE, studentClass: '1DES', titulo: '  Seminário   de Redes ', tipo: 'seminario', descricao: 'Apresentação em grupo', data: '2026-04-15', moduloId: 'M1', peso: '2,0',
        });
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual(saves.map(call => call && call.only), [['classes', 'auditLogs']]);
    const item = created.body.item;
    assert.match(item.id, /^man_\d+_[0-9a-f]{6}$/);
    await db.flush();
    assert.equal((await db.readStoredData()).memory.classes.find(entry => entry.name === '1DES').avaliacao.manuais[0].id, item.id, 'a avaliação manual foi para o disco');
    assert.equal(item.titulo, 'Seminário de Redes');
    assert.equal(item.tipoRotulo, 'Seminário');
    assert.equal(item.moduloId, 'M1');
    assert.equal(db.memory.classes[0].avaliacao.itens[item.id].peso, 2);
    assert.equal(audits('manual_assessment_created').length, 1);
    assert.equal(audits('manual_assessment_created')[0].after.titulo, 'Seminário de Redes');
    assert.ok(created.body.plano.itens.some(entry => entry.id === item.id && entry.origem === 'manual' && entry.modulo === 'Redes'));

    // Lançamento: só a nota; acertos ou cartão são recusados.
    const launch = body => as('prof', 'post', '/api/admin/submissions/create').send({ studentEmail: 'ana@grading.local', courseId: COURSE, studentClass: '1DES', examKey: item.id, ...body });
    assert.equal((await launch({ grade: '8,5', correctCount: 3, totalCount: 4 })).status, 400);
    assert.match((await launch({ correctCount: 3 })).body.error, /só a nota/);
    assert.match((await launch({})).body.error, /Informe a nota/);
    const ok = await launch({ grade: '8,5' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const stored = db.memory.submissions.find(entry => entry.examKey === item.id);
    assert.equal(stored.score, 85);
    assert.equal(stored.type, 'manual');
    assert.equal(stored.gradePublished, false);
    assert.match(audits('grade_create').pop().newValue, /Seminário de Redes/);
    // examKey 'man_' de outra turma é recusado.
    const caio = await as('admin', 'post', '/api/admin/submissions/create').send({ studentEmail: 'caio@grading.local', courseId: COURSE, studentClass: '2DES', examKey: item.id, grade: 7 });
    assert.equal(caio.status, 400);
    assert.match(caio.body.error, /não encontrada na turma/);
    assert.equal((await as('admin', 'get', `/api/admin/submissions/manual-context?examKey=${item.id}&studentEmail=ana@grading.local&courseId=${COURSE}&studentClass=1DES`)).status !== 500, true);

    // Quadro: coluna da avaliação manual, a nota entra na média (sem critérios, a simples).
    const gb = await gradebookOf();
    const column = gb.body.columns.find(entry => (entry.examKey || entry.id) === item.id);
    assert.ok(column, JSON.stringify(gb.body.columns));
    assert.equal(column.label, 'Seminário de Redes');
    assert.equal(column.origem, 'manual');
    assert.equal(rowOf(gb, 'ana@grading.local').average, 6.9, '(4 + 8 + 7 + 8,5) / 4 = 6,875');

    // Boletim e resumo do aluno: só depois de publicar.
    const summaryBefore = await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(summaryBefore.status, 200, JSON.stringify(summaryBefore.body));
    const manualBefore = summaryBefore.body.itens.find(entry => entry.id === item.id);
    assert.equal(manualBefore.nota, null);
    assert.equal(manualBefore.publicada, false);
    assert.equal(summaryBefore.body.mediaFinal, 6.3);
    assert.equal(summaryBefore.body.regraAntiga, true);
    assert.equal(summaryBefore.body.mediaMinimaTexto, '6,0');
    assert.ok('faltasPermitidasRestantes' in summaryBefore.body);
    const publish = await as('prof', 'post', '/api/admin/submissions/publish').send({ ids: [stored.id] });
    assert.equal(publish.status, 200, JSON.stringify(publish.body));
    const summary = await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
    const manual = summary.body.itens.find(entry => entry.id === item.id);
    assert.equal(manual.nota, 8.5);
    assert.equal(manual.titulo, 'Seminário de Redes');
    assert.equal(manual.modulo, 'Redes');
    assert.equal(summary.body.mediaFinal, 6.9);
    const report = await as('admin', 'get', `/api/admin/student/report?email=ana@grading.local&courseId=${COURSE}&studentClass=1DES`);
    const redes = report.body.modules.find(module => module.name === 'Redes');
    assert.ok(redes.exams.some(exam => exam.examKey === item.id && exam.grade === 8.5), JSON.stringify(redes.exams));

    // Alterar: título e etapa; a auditoria guarda antes e depois.
    const updated = await as('prof', 'post', '/api/admin/grading/manual-items/update').send({ courseId: COURSE, studentClass: '1DES', id: item.id, titulo: 'Seminário final' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.item.titulo, 'Seminário final');
    assert.equal(audits('manual_assessment_updated')[0].before.titulo, 'Seminário de Redes');
    assert.equal(audits('manual_assessment_updated')[0].after.titulo, 'Seminário final');
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/update').send({ courseId: COURSE, studentClass: '1DES', id: 'man_nao_existe' })).status, 404);

    // Arquivar: com nota publicada pede motivo; a nota fica guardada e sai da média com aviso.
    const archiveNoReason = await as('prof', 'post', '/api/admin/grading/manual-items/archive').send({ courseId: COURSE, studentClass: '1DES', id: item.id });
    assert.equal(archiveNoReason.status, 400);
    assert.equal(archiveNoReason.body.code, 'reason_required');
    const archived = await as('prof', 'post', '/api/admin/grading/manual-items/archive').send({ courseId: COURSE, studentClass: '1DES', id: item.id, reason: 'Seminário cancelado' });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.item.arquivado, true);
    assert.equal(archived.body.item.notasPublicadas, 1);
    const audit = audits('manual_assessment_archived')[0];
    assert.equal(audit.reason, 'Seminário cancelado');
    assert.equal(audit.details.notas, 1);
    assert.ok(db.memory.submissions.some(entry => entry.id === stored.id), 'a nota fica guardada');
    const gbArchived = await gradebookOf();
    assert.equal(rowOf(gbArchived, 'ana@grading.local').average, 6.3, 'a nota arquivada sai da média');
    const afterArchive = await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(afterArchive.body.itens.some(entry => entry.id === item.id), false);
    assert.equal(afterArchive.body.mediaFinal, 6.3);
    const reportArchived = await as('admin', 'get', `/api/admin/student/report?email=ana@grading.local&courseId=${COURSE}&studentClass=1DES`);
    assert.ok(reportArchived.body.avisosNotas.some(text => /arquivada/.test(text)), JSON.stringify(reportArchived.body.avisosNotas));
    // Arquivada não recebe nota nova.
    assert.match((await launch({ grade: 9 })).body.error, /arquivada/);
    // Arquivar de novo não muda nada; reativar devolve a nota à média.
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/archive').send({ courseId: COURSE, studentClass: '1DES', id: item.id })).body.semMudanca, true);
    // Reativar põe a nota publicada de volta na média: também pede motivo.
    const restoreNoReason = await as('prof', 'post', '/api/admin/grading/manual-items/restore').send({ courseId: COURSE, studentClass: '1DES', id: item.id });
    assert.equal(restoreNoReason.status, 400);
    assert.equal(restoreNoReason.body.code, 'reason_required');
    assert.equal(rowOf(await gradebookOf(), 'ana@grading.local').average, 6.3, 'o pedido recusado não reativa');
    const restored = await as('prof', 'post', '/api/admin/grading/manual-items/restore').send({ courseId: COURSE, studentClass: '1DES', id: item.id, reason: 'Seminário remarcado' });
    assert.equal(restored.status, 200);
    assert.equal(audits('manual_assessment_restored')[0].reason, 'Seminário remarcado');
    assert.equal(restored.body.item.arquivado, false);
    assert.equal(audits('manual_assessment_restored').length, 1);
    assert.equal(rowOf(await gradebookOf(), 'ana@grading.local').average, 6.9);
});

test('[UC-NOTAS-006] avaliação manual com critérios: entra na etapa do plano com o peso dela e aparece no resumo do aluno por etapa', async () => {
    assert.equal((await saveCriteria()).status, 200);
    assert.equal((await savePlan(PLAN, { reason: 'Plano do semestre' })).status, 200);
    const created = await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES', titulo: 'Trabalho', tipo: 'trabalho', etapa: 2, peso: 1 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.item.id;
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES', titulo: 'X', etapa: 5 })).body.field, 'etapa');
    const launch = await as('prof', 'post', '/api/admin/submissions/create').send({ studentEmail: 'ana@grading.local', courseId: COURSE, studentClass: '1DES', examKey: id, grade: 10 });
    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    // 2º bimestre: (7 + 10) / 2 = 8,5; média final (7 + 8,5 × 2) / 3 = 8,0.
    const ana = rowOf(await gradebookOf(), 'ana@grading.local');
    assert.equal(ana.etapas[1].media, 8.5);
    assert.equal(ana.mediaFinal, 8);
    // O aluno ainda não vê o trabalho (não publicado): 2º bimestre só com a P3.
    const summary = await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(summary.body.regraAntiga, false);
    assert.equal(summary.body.mediaFinal, 7);
    assert.equal(summary.body.situacao, 'aprovado');
    assert.equal(summary.body.mencao.sigla, 'B');
    assert.deepEqual(summary.body.etapas.map(etapa => [etapa.nome, etapa.media]), [['1º bimestre', 7], ['2º bimestre', 7]]);
    const trabalho = summary.body.itens.find(entry => entry.id === id);
    assert.equal(trabalho.etapa, 2);
    assert.equal(trabalho.etapaNome, '2º bimestre');
    assert.equal(trabalho.nota, null);
    assert.equal(summary.body.criterio.regraAntiga, false);
});

// Rodada de ajuste 1 do B6: o motivo não se contorna pela avaliação manual.
test('[UC-NOTAS-006] avaliação manual com nota publicada: mudar etapa, peso ou módulo e reativar pedem motivo', async () => {
    assert.equal((await saveCriteria()).status, 200);
    assert.equal((await savePlan(PLAN, { reason: 'Plano do semestre' })).status, 200);
    const created = await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES', titulo: 'Trabalho', tipo: 'trabalho', etapa: 2, peso: 1 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.item.id;
    const update = fields => as('prof', 'post', '/api/admin/grading/manual-items/update').send({ courseId: COURSE, studentClass: '1DES', id, ...fields });
    // Sem nota publicada, mudar o peso não pede motivo.
    assert.equal((await update({ peso: 2 })).status, 200);
    assert.equal((await as('prof', 'post', '/api/admin/submissions/create').send({ studentEmail: 'ana@grading.local', courseId: COURSE, studentClass: '1DES', examKey: id, grade: 10 })).status, 200);
    const stored = db.memory.submissions.find(entry => entry.examKey === id);
    assert.equal((await as('prof', 'post', '/api/admin/submissions/publish').send({ ids: [stored.id] })).status, 200);
    const media = async () => (await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`)).body.mediaFinal;
    const before = await media();

    // Etapa e peso pela avaliação manual: a mesma regra do POST /grading/plan.
    const viaPlan = await savePlan({ [id]: { etapa: 1, peso: 5 } });
    assert.equal(viaPlan.status, 400);
    assert.equal(viaPlan.body.code, 'reason_required');
    const noReason = await update({ etapa: 1, peso: 5 });
    assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
    assert.equal(noReason.body.code, 'reason_required');
    assert.equal(noReason.body.field, 'reason');
    assert.equal(await media(), before, 'o pedido recusado não muda a média');
    assert.equal(db.memory.classes[0].avaliacao.itens[id].etapa, 2);
    // Módulo também muda a média (do módulo e da disciplina).
    assert.equal((await update({ moduloId: 'M2' })).body.code, 'reason_required');
    // Só texto (título, descrição) não pede motivo.
    assert.equal((await update({ titulo: 'Trabalho final', descricao: 'Em dupla' })).status, 200);
    const ok = await update({ etapa: 1, peso: 5, reason: 'Trabalho vale pelo 1º bimestre' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const audit = audits('manual_assessment_updated').pop();
    assert.equal(audit.reason, 'Trabalho vale pelo 1º bimestre');
    assert.equal(audit.after.plano.etapa, 1);
    assert.notEqual(await media(), before);

    // Arquivar e reativar: os dois pedem motivo com nota publicada.
    const toggle = (action, fields = {}) => as('prof', 'post', `/api/admin/grading/manual-items/${action}`).send({ courseId: COURSE, studentClass: '1DES', id, ...fields });
    assert.equal((await toggle('archive', { reason: 'Trabalho cancelado' })).status, 200);
    const archivedMedia = await media();
    const restoreNoReason = await toggle('restore');
    assert.equal(restoreNoReason.status, 400);
    assert.equal(restoreNoReason.body.code, 'reason_required');
    assert.equal(await media(), archivedMedia);
    assert.equal((await toggle('restore', { reason: 'Trabalho remarcado' })).status, 200);
    assert.equal(audits('manual_assessment_restored').pop().reason, 'Trabalho remarcado');
});

test('[UC-NOTAS-006] avaliação manual: a tela Provas do aluno, Meus dados, o Início e a auditoria da nota mostram o título, não o id', async () => {
    const created = await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES', titulo: 'Seminário de Redes', tipo: 'seminario' });
    const id = created.body.item.id;
    assert.equal((await as('prof', 'post', '/api/admin/submissions/create').send({ studentEmail: 'ana@grading.local', courseId: COURSE, studentClass: '1DES', examKey: id, grade: 9 })).status, 200);
    const stored = db.memory.submissions.find(entry => entry.examKey === id);
    assert.equal((await as('prof', 'post', '/api/admin/submissions/publish').send({ ids: [stored.id] })).status, 200);
    assert.match(audits('grade_publish').pop().oldValue, /^Seminário de Redes/);
    assert.doesNotMatch(audits('grade_publish').pop().oldValue, /man_/);

    const token = createStudentSession(db.memory, 'ana@grading.local');
    const mine = await request(app).post('/api/student/my-submissions').set('x-session-token', token).send({ courseId: COURSE, studentClass: '1DES' });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const list = Array.isArray(mine.body) ? mine.body : (mine.body.submissions || mine.body.items || []);
    const manual = list.find(entry => entry.examKey === id);
    assert.ok(manual, JSON.stringify(mine.body).slice(0, 500));
    assert.equal(manual.examTitle, 'Seminário de Redes');
    const data = await request(app).get('/api/student/my-data').set('x-session-token', token);
    assert.equal(data.status, 200);
    assert.equal(data.body.examTitles[id], 'Seminário de Redes');
    const home = await request(app).get(`/api/student/dashboard?courseId=${COURSE}&studentClass=1DES`).set('x-session-token', token);
    assert.equal(home.body.performance.find(entry => entry.examKey === id).title, 'Seminário de Redes');
    assert.equal(home.body.performance.find(entry => entry.examKey === 'Av_P1').title, undefined, 'a prova continua sem o campo novo');

    // Painel: a lista de Resultados e a ficha do aluno levam o título (antes só o examKey,
    // e as telas mostravam "man_<ms>_<hex>"); as provas continuam sem o campo.
    const adminList = await as('prof', 'get', `/api/admin/submissions?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.find(entry => entry.examKey === id).examTitle, 'Seminário de Redes');
    assert.equal('examTitle' in adminList.body.find(entry => entry.examKey === 'Av_P1'), false);
    const academic = await as('prof', 'get', '/api/admin/student/academic?email=ana@grading.local');
    assert.equal(academic.status, 200);
    const academicManual = academic.body.submissions.find(entry => entry.examKey === id);
    assert.equal(academicManual.examTitle, 'Seminário de Redes');
    assert.equal(academicManual.manual, true);
    assert.equal('examTitle' in academic.body.submissions.find(entry => entry.examKey === 'Av_P1'), false);

    const deleted = await as('admin', 'post', '/api/admin/submissions/delete').send({ id: stored.id, reason: 'Lançada errada' });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.match(audits('grade_delete').pop().oldValue, /^Seminário de Redes/);
});

test('[UC-NOTAS-006] Início do portal: média geral e média do módulo iguais às do boletim com avaliação manual no módulo ou arquivada', async () => {
    const created = await as('prof', 'post', '/api/admin/grading/manual-items/create').send({ courseId: COURSE, studentClass: '1DES', titulo: 'Seminário de Redes', tipo: 'seminario', moduloId: 'M1' });
    const id = created.body.item.id;
    assert.equal((await as('prof', 'post', '/api/admin/submissions/create').send({ studentEmail: 'ana@grading.local', courseId: COURSE, studentClass: '1DES', examKey: id, grade: 10 })).status, 200);
    const stored = db.memory.submissions.find(entry => entry.examKey === id);
    assert.equal((await as('prof', 'post', '/api/admin/submissions/publish').send({ ids: [stored.id] })).status, 200);
    const token = createStudentSession(db.memory, 'ana@grading.local');
    const check = async (overall, redes) => {
        const home = await request(app).get(`/api/student/dashboard?courseId=${COURSE}&studentClass=1DES`).set('x-session-token', token);
        assert.equal(home.status, 200, JSON.stringify(home.body));
        const report = await as('admin', 'get', `/api/admin/student/report?email=ana@grading.local&courseId=${COURSE}&studentClass=1DES`);
        const summary = await request(app).get(`/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`).set('x-session-token', token);
        assert.equal(home.body.overallNote, overall);
        assert.equal(report.body.overallAverage, overall);
        assert.equal(summary.body.mediaFinal, overall);
        const homeRedes = home.body.modules.find(module => module.name === 'Redes');
        assert.equal(homeRedes.note, redes);
        assert.equal(report.body.modules.find(module => module.name === 'Redes').average, redes);
        assert.equal(summary.body.modulos.find(module => module.nome === 'Redes').media, redes);
        assert.equal(home.body.modules.find(module => module.name === 'Banco de Dados').note, 7);
        return home.body;
    };
    // (4 + 8 + 7 + 10) / 4 = 7,25; Redes (4 + 8 + 10) / 3 = 7,3 (antes o Início dava 6,0).
    const withManual = await check(7.3, 7.3);
    assert.equal(withManual.modules.find(module => module.name === 'Redes').noteStatus, 'published');
    // Arquivada: a nota fica guardada e sai da média (antes o Início continuava com 7,3).
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/archive').send({ courseId: COURSE, studentClass: '1DES', id, reason: 'Seminário cancelado' })).status, 200);
    const archived = await check(6.3, 6);
    assert.equal(archived.performance.some(entry => entry.examKey === id), false);
    assert.equal('situacao' in archived, false, 'sem critérios, o Início não ganha situação');
    // Tela Provas do aluno (my-submissions): a nota arquivada continua na lista, fora da
    // média. Antes vinha com countsTowardResult true e consolidatedScore 100, e a média da
    // tela (uma nota consolidada por prova publicada) dava 7,25 contra 6,3 do Início.
    const mine = await request(app).post('/api/student/my-submissions').set('x-session-token', token).send({ courseId: COURSE, studentClass: '1DES' });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const archivedEntry = mine.body.submissions.find(entry => entry.examKey === id);
    assert.equal(archivedEntry.score, 100, 'a nota fica guardada e visível');
    assert.equal(archivedEntry.gradePublished, true);
    assert.equal(archivedEntry.countsTowardResult, false);
    assert.equal(archivedEntry.consolidatedScore, null);
    assert.equal(archivedEntry.assessmentArchived, true);
    assert.equal(archivedEntry.examTitle, 'Seminário de Redes');
    // Resultados (lista do painel): a entrega da avaliação arquivada vem marcada.
    const adminArchived = await as('prof', 'get', `/api/admin/submissions?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(adminArchived.body.find(entry => entry.examKey === id).assessmentArchived, true);
    assert.ok(adminArchived.body.filter(entry => entry.examKey !== id).every(entry => !('assessmentArchived' in entry)));
    const others = mine.body.submissions.filter(entry => entry.examKey !== id);
    assert.ok(others.every(entry => entry.countsTowardResult === true && entry.assessmentArchived === undefined));
    const screenScores = mine.body.submissions.filter(entry => entry.gradePublished === true && entry.consolidatedScore != null).map(entry => entry.consolidatedScore);
    assert.equal(Math.round(screenScores.reduce((sum, value) => sum + value, 0) / screenScores.length) / 10, 6.3);
    // Reativada, volta a contar na tela também.
    assert.equal((await as('prof', 'post', '/api/admin/grading/manual-items/restore').send({ courseId: COURSE, studentClass: '1DES', id, reason: 'Seminário remarcado' })).status, 200);
    const again = await request(app).post('/api/student/my-submissions').set('x-session-token', token).send({ courseId: COURSE, studentClass: '1DES' });
    const restoredEntry = again.body.submissions.find(entry => entry.examKey === id);
    assert.equal(restoredEntry.countsTowardResult, true);
    assert.equal(restoredEntry.consolidatedScore, 100);
    assert.equal(restoredEntry.assessmentArchived, undefined);
    const adminRestored = await as('prof', 'get', `/api/admin/submissions?courseId=${COURSE}&studentClass=1DES`);
    assert.equal('assessmentArchived' in adminRestored.body.find(entry => entry.examKey === id), false);
});

// ------------------------------------------------------------------ resumo do aluno

test('[UC-NOTAS-006] grades-summary: só o publicado, "Cursando" com etapa sem nota publicada, e só para o aluno da turma', async () => {
    assert.equal((await saveCriteria()).status, 200);
    assert.equal((await savePlan(PLAN, { reason: 'Plano do semestre' })).status, 200);
    db.memory.submissions.find(item => item.student.email === 'ana@grading.local' && item.examKey === 'Av_P3').gradePublished = false;
    const summary = await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.situacao, 'cursando');
    assert.equal(summary.body.situacaoRotulo, 'Cursando');
    assert.equal(summary.body.itens.find(item => item.id === 'Av_P3').nota, null);
    assert.equal(summary.body.itens.find(item => item.id === 'Av_P2').nota, 8);
    assert.equal(summary.body.itens.find(item => item.id === 'Av_P2').peso, 3);
    assert.deepEqual(summary.body.criterio, { mediaMinima: 6, mencoes: CRITERIA.mencoes.map(item => ({ ...item })), regraAntiga: false });
    assert.equal(summary.body.frequenciaMinima, 75);

    assert.equal((await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=2DES`)).status, 403, 'turma de outro aluno');
    assert.equal((await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}`)).status, 403);
    const anonymous = await request(app).get(`/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
    assert.ok([400, 401].includes(anonymous.status), `sem sessão: ${anonymous.status}`);
    assert.equal(anonymous.body.itens, undefined);
});

// ------------------------------------------------------------------ provedor de itens (C2)

test('[UC-NOTAS-005] provedor de itens (C2): os itens entram no plano e no quadro; "fora" é o padrão; provedor que falha não derruba', async () => {
    assert.throws(() => gradebook.registerGradeItemProvider({ origem: 'prova', items: () => [], entries: () => [] }), /inválida/);
    assert.throws(() => gradebook.registerGradeItemProvider({ origem: 'tarefa_teste' }), /items\(\) e entries\(\)/);
    const unregister = gradebook.registerGradeItemProvider({
        origem: 'tarefa_teste',
        items: (course, cls) => (cls && cls.name === '1DES' ? [
            { id: 'tar_1', titulo: 'Tarefa 1', moduloId: 'M2' },
            { id: 'tar_2', titulo: 'Tarefa 2', fora: true },
            { id: 'Av_P1', titulo: 'Tenta tomar o id de uma prova' },
        ] : []),
        entries: (memory, { emails, publishedOnly }) => [
            { itemId: 'tar_1', email: 'ana@grading.local', score: 100, publicada: true },
            { itemId: 'tar_2', email: 'ana@grading.local', score: 0, publicada: true },
            { itemId: 'tar_1', email: 'bia@grading.local', score: 20, publicada: false },
        ].filter(entry => (!emails || emails.includes(entry.email)) && (!publishedOnly || entry.publicada)),
    });
    const broken = gradebook.registerGradeItemProvider({ origem: 'quebrado', items: () => { throw new Error('falhou'); }, entries: () => { throw new Error('falhou'); } });
    const originalError = console.error;
    console.error = () => {};
    try {
        const plan = await as('admin', 'get', `/api/admin/grading/plan?courseId=${COURSE}&studentClass=1DES`);
        assert.equal(plan.status, 200, JSON.stringify(plan.body));
        const tar1 = plan.body.itens.find(item => item.id === 'tar_1');
        assert.equal(tar1.origem, 'tarefa_teste');
        assert.equal(tar1.modulo, 'Banco de Dados');
        assert.equal(tar1.fora, false);
        assert.equal(plan.body.itens.find(item => item.id === 'tar_2').fora, true, 'fora: true é o padrão do item no plano');
        assert.equal(plan.body.itens.filter(item => item.id === 'Av_P1').length, 1);
        assert.equal(plan.body.itens.find(item => item.id === 'Av_P1').origem, 'prova');

        // Sem critérios: a nota do provedor entra na média simples; a "fora" (o padrão do
        // provedor ou "Conta na média" desmarcado) fica na célula e sai da média também na
        // regra antiga (pendência do B6 na J2: antes, tar_2 com 0 entrava e a média caía).
        const gb = await gradebookOf();
        assert.ok(gb.body.columns.some(column => (column.examKey || column.id) === 'tar_1' && column.origem === 'tarefa_teste'));
        assert.equal(rowOf(gb, 'ana@grading.local').cells.tar_1.grade, 10);
        assert.equal(rowOf(gb, 'ana@grading.local').cells.tar_2.grade, 0);
        // (40 + 80 + 70 + 100) / 4 = 72,5 -> 7,3; com a tar_2 seria 5,8.
        assert.equal(rowOf(gb, 'ana@grading.local').average, 7.3);
        const legacySummary = await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
        assert.equal(legacySummary.body.regraAntiga, true);
        assert.equal(legacySummary.body.mediaFinal, 7.3);
        assert.equal(legacySummary.body.itens.find(item => item.id === 'tar_2').foraDaMedia, true);
        assert.equal(legacySummary.body.itens.find(item => item.id === 'tar_1').foraDaMedia, false);
        const legacyReport = await as('admin', 'get', `/api/admin/student/report?email=ana@grading.local&courseId=${COURSE}&studentClass=1DES`);
        assert.equal(legacyReport.body.overallAverage, 7.3);

        // Com critérios: tar_2 fica fora da média; tar_1 entra na etapa do plano.
        assert.equal((await saveCriteria()).status, 200);
        assert.equal((await savePlan({ ...PLAN, tar_1: { etapa: 2 } }, { reason: 'Plano com tarefa' })).status, 200);
        const ana = rowOf(await gradebookOf(), 'ana@grading.local');
        // 2º bimestre: (7 + 10) / 2 = 8,5; final (7 + 17) / 3 = 8,0.
        assert.equal(ana.mediaFinal, 8);
        // O aluno vê só o publicado do provedor.
        const summary = await asStudent('bia@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
        assert.equal(summary.body.itens.find(item => item.id === 'tar_1').nota, null);
        // Trocar o "fora" do item de provedor é mudança do plano.
        const back = await savePlan({ tar_2: { fora: false, etapa: 2 } }, { reason: 'Conta a tarefa 2' });
        assert.deepEqual(back.body.alterados, ['tar_2']);
    } finally {
        console.error = originalError;
        unregister();
        broken();
    }
    assert.equal(gradebook.gradeItemProviderList().length, 0);
});

// ------------------------------------------------------------------ conta (gradingRules)

test('[UC-NOTAS-005] situação por disciplina: nota só em avaliação sem disciplina não deixa a turma "Sem notas"', () => {
    const criterios = gradingRules.normalizeCriteria({ ativo: true, unidadeSituacao: 'disciplina' });
    const result = gradingRules.computeStudentResult({
        criterios,
        plano: gradingRules.normalizePlan({}),
        grupos: [{ itemId: 'man_1_abcdef', score: 80, moduloId: null }],
        disciplinas: [{ id: 'REDES', nome: 'Redes', modulos: ['M1'] }],
    });
    assert.equal(result.mediaFinal, 8);
    assert.notEqual(result.situacao, 'sem_notas');
    assert.equal(result.situacao, 'aprovado');
});

test('[UC-NOTAS-006] auditoria: as ações novas têm rótulo e categoria acadêmica', () => {
    const audit = require('../../backend/utils/audit.js');
    ['grading_criteria_updated', 'grading_plan_updated', 'manual_assessment_created', 'manual_assessment_updated', 'manual_assessment_archived', 'manual_assessment_restored']
        .forEach(action => {
            assert.equal(audit.inferAuditCategory ? audit.inferAuditCategory(action) : 'academic', 'academic', action);
            assert.ok(audit.ACTION_LABELS[action], action);
        });
});

test('[UC-NOTAS-008] as telas recebem o critério do curso: critérios (GET) e ficha acadêmica, com a regra antiga quando desligado', async () => {
    // Desligado: a tela pinta com o padrão da regra antiga (6,0).
    const before = await as('prof', 'get', `/api/admin/grading/criteria?courseId=${COURSE}`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual(before.body.criterio, { mediaMinima: 6, mencoes: null, regraAntiga: true });
    const academicBefore = await as('prof', 'get', '/api/admin/student/academic?email=ana@grading.local');
    assert.equal(academicBefore.status, 200);
    assert.ok(academicBefore.body.submissions.length > 0);
    academicBefore.body.submissions.forEach(entry => assert.deepEqual(entry.criterio, { mediaMinima: 6, mencoes: null, regraAntiga: true }));

    // Ligado com média mínima 5: as duas respostas trazem a mínima e as menções do curso.
    assert.equal((await saveCriteria({ mediaMinima: 5 })).status, 200);
    const after = await as('prof', 'get', `/api/admin/grading/criteria?courseId=${COURSE}`);
    assert.equal(after.body.criterio.mediaMinima, 5);
    assert.equal(after.body.criterio.regraAntiga, false);
    assert.deepEqual(after.body.criterio.mencoes.map(item => item.sigla), ['MB', 'B', 'R', 'I']);
    const academicAfter = await as('prof', 'get', '/api/admin/student/academic?email=ana@grading.local');
    academicAfter.body.submissions.forEach(entry => assert.equal(entry.criterio.mediaMinima, 5));
});

test('[UC-NOTAS-008] resumo do quadro (B9): média e aprovação da turma, por prova, aplicação e módulo, sem conta na tela', async () => {
    // Sem critérios: média das médias dos alunos (Ana 6,3 e Bia 6,3) e aprovação pelos
    // alunos com média >= 6,0.
    const before = await gradebookOf();
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const resumo = before.body.resumo;
    assert.equal(resumo.media, 6.3);
    assert.equal(resumo.comNota, 2);
    assert.equal(resumo.aprovacaoPor, 'media');
    assert.equal(resumo.aprovacao, 100);
    // Por prova: Ana 4,0 e Bia 10,0 na Prova 1 (média 7,0; só a Bia passa).
    assert.deepEqual({ ...resumo.porProva.Av_P1, mediaScore: undefined }, { media: 7, mediaScore: undefined, comNota: 2, acimaDaMinima: 1, aprovacao: 50 });
    // Nota de cada aluno: na prova e a média dele em cada módulo da estrutura.
    assert.equal(resumo.alunos['ana@grading.local'].porProva.Av_P1.grade, 4);
    assert.equal(resumo.alunos['ana@grading.local'].porModulo.M1.grade, 6);
    assert.equal(resumo.alunos['ana@grading.local'].porModulo.M2.grade, 7);
    // Aplicação: a nota daquela aplicação.
    db.memory.submissions.push(sub('ana@grading.local', 'Av_P3', 90, { applicationId: 'app_res' }));
    const withApp = await gradebookOf();
    assert.equal(withApp.body.resumo.porAplicacao.app_res.media, 9);
    assert.equal(withApp.body.resumo.alunos['ana@grading.local'].porAplicacao.app_res.grade, 9);
    db.memory.submissions.pop();

    // Com critérios: a média da turma é a das médias finais do quadro (Ana 7,0 e Bia 5,2)
    // e a aprovação é pela situação (Bia em recuperação: 1 de 2).
    assert.equal((await saveCriteria()).status, 200);
    assert.equal((await savePlan(PLAN, { reason: 'Plano do semestre' })).status, 200);
    const after = await gradebookOf();
    const rows = after.body.rows;
    const mediaDasMedias = rows.reduce((sum, row) => sum + row.averageScore, 0) / rows.length;
    assert.equal(after.body.resumo.media, require('../../backend/utils/submissionAttempts.js').roundGrade(mediaDasMedias));
    assert.equal(after.body.resumo.media, 6.1);
    assert.equal(after.body.resumo.aprovacaoPor, 'situacao');
    assert.equal(after.body.resumo.situacoesFechadas, 2);
    assert.equal(after.body.resumo.aprovados, 1);
    assert.equal(after.body.resumo.aprovacao, 50);
});

test('[UC-NOTAS-008] boletim traz a identidade da escola do curso do boletim e o fuso da escola; grades-summary diz de qual etapa é a recuperação', async () => {
    db.memory.schools = [{ id: 'esc_a', name: 'Escola A', info: { tradeName: 'Escola A', legalName: 'Escola A Ensino Ltda', registrationId: '11.222.333/0001-44' } }];
    const report = await as('admin', 'get', `/api/admin/student/report?email=ana@grading.local&courseId=${COURSE}&studentClass=1DES`);
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.equal(report.body.identidade.schoolName, 'Escola A');
    assert.equal(report.body.identidade.institution.legalName, 'Escola A Ensino Ltda');
    assert.equal(report.body.identidade.institution.registrationId, '11.222.333/0001-44');
    assert.ok(report.body.identidade.displayName);
    // A mesma identidade de GET /api/branding?courseId= (a do curso do boletim).
    const branding = await request(app).get(`/api/branding?courseId=${COURSE}`);
    assert.equal(branding.body.displayName, report.body.identidade.displayName);
    assert.deepEqual(branding.body.institution, report.body.identidade.institution);
    assert.equal(report.body.fuso, require('../../backend/utils/settings.js').getSettings().timezone);

    assert.equal((await saveCriteria()).status, 200);
    assert.equal((await savePlan({ ...PLAN, Av_P3: { recuperacaoDe: 'etapa:1' } }, { reason: 'Plano do semestre' })).status, 200);
    const summary = await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(summary.status, 200);
    const rec = summary.body.itens.find(item => item.id === 'Av_P3');
    assert.equal(rec.recuperacao, true);
    assert.equal(rec.recuperacaoDe, 'etapa:1');
    assert.equal(summary.body.itens.find(item => item.id === 'Av_P1').recuperacaoDe, null);
});

// ------------------------------------------------------------------ pendências da J2 (B10)

test('[UC-NOTAS-005] com critérios, avaliação aguardando correção: quadro, boletim e grades-summary avisam e não dão situação final', async () => {
    assert.equal((await saveCriteria()).status, 200);
    assert.equal((await savePlan(PLAN, { reason: 'Plano do semestre' })).status, 200);
    // A P3 da Ana (única avaliação do 2º bimestre) espera a correção do professor.
    const p3 = db.memory.submissions.find(item => item.student.email === 'ana@grading.local' && item.examKey === 'Av_P3');
    p3.correcao = { situacao: 'pendente', versao: 0 };
    const gb = await gradebookOf();
    const ana = rowOf(gb, 'ana@grading.local');
    assert.equal(ana.situacao, 'aguardando_correcao', JSON.stringify(ana));
    assert.equal(ana.situacaoRotulo, 'Aguardando correção');
    assert.equal(ana.aguardandoCorrecao, 1);
    assert.equal(ana.mencao, null, 'sem menção enquanto espera a correção');
    assert.equal(ana.etapas[1].media, null, 'a etapa que só espera correção não vira zero');
    const p3Column = gb.body.columns.find(item => item.examKey === 'Av_P3');
    assert.equal(ana.cells[p3Column.id].aguardandoCorrecao, true);
    assert.equal(ana.cells[p3Column.id].score, null);
    const csv = await gradebookOf('1DES', 'admin', '&format=csv');
    const anaLine = csv.text.split(/\r?\n/).find(line => line.includes('ana@grading.local'));
    assert.match(anaLine, /aguardando correção/);
    assert.match(anaLine, /Aguardando correção/);

    const report = await as('admin', 'get', `/api/admin/student/report?email=ana@grading.local&courseId=${COURSE}&studentClass=1DES`);
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.equal(report.body.situacao, 'aguardando_correcao');
    assert.equal(report.body.mencao, null);
    assert.ok(report.body.avisosNotas.some(aviso => /aguardando correção/.test(aviso)), JSON.stringify(report.body.avisosNotas));

    // O aluno vê o aviso no resumo (a P3 publicada, esperando a correção).
    const summary = await asStudent('ana@grading.local', `/api/student/grades-summary?courseId=${COURSE}&studentClass=1DES`);
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.situacao, 'aguardando_correcao', JSON.stringify(summary.body));
    assert.equal(summary.body.aguardandoCorrecao, 1);
    assert.deepEqual(summary.body.avisos, ['1 avaliação aguardando correção: a nota dela ainda não entra na média, e a situação final sai depois da correção.']);
    assert.equal(summary.body.mencao, null);

    // Corrigida, a situação final volta.
    p3.correcao = { situacao: 'concluida', versao: 1 };
    const after = rowOf(await gradebookOf(), 'ana@grading.local');
    assert.equal(after.situacao, 'aprovado');
});

test('[UC-NOTAS-005] entrega anulada com "desconsiderar" aparece como "anulada" no quadro e na planilha', async () => {
    const p2 = db.memory.submissions.find(item => item.student.email === 'bia@grading.local' && item.examKey === 'Av_P2');
    p2.integrity = { decisao: 'desconsiderar', motivo: 'cola', em: Date.now(), por: 'admin@grading.local' };
    const gb = await gradebookOf();
    const bia = rowOf(gb, 'bia@grading.local');
    const column = gb.body.columns.find(item => item.examKey === 'Av_P2');
    const cell = bia.cells[column.id] || bia.cells[column.key] || Object.values(bia.cells).find(item => item && item.anulada);
    assert.ok(cell, JSON.stringify(bia.cells));
    assert.equal(cell.anulada, true);
    assert.equal(cell.score, null);
    const csv = await gradebookOf('1DES', 'admin', '&format=csv');
    const biaLine = csv.text.split(/\r?\n/).find(line => line.includes('bia@grading.local'));
    assert.match(biaLine, /;anulada;|;anulada$/);
    const xlsx = await as('admin', 'get', `/api/admin/gradebook?courseId=${COURSE}&studentClass=1DES&format=xlsx`).buffer(true).parse((res, done) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    assert.equal(xlsx.status, 200);
    const sheet = gradebook.gradebookSheet(gb.body);
    assert.ok(JSON.stringify(sheet).includes('anulada'));
});

test('[UC-NOTAS-005] colunas de recuperação e segunda chamada dizem a finalidade no quadro e no CSV', async () => {
    db.memory.examApplications = [
        { id: 'app_reg', examKey: 'Av_P3', courseId: COURSE, studentClass: '1DES', finalidade: 'regular', createdAt: '2026-03-01T10:00:00.000Z' },
        { id: 'app_rec', examKey: 'Av_P3', courseId: COURSE, studentClass: '1DES', finalidade: 'recuperacao', createdAt: '2026-03-20T10:00:00.000Z' },
        { id: 'app_2ch', examKey: 'Av_P3', courseId: COURSE, studentClass: '1DES', finalidade: 'segunda_chamada', createdAt: '2026-03-25T10:00:00.000Z' },
    ];
    db.memory.submissions = db.memory.submissions.filter(item => item.examKey !== 'Av_P3');
    db.memory.submissions.push(sub('ana@grading.local', 'Av_P3', 70, { applicationId: 'app_reg', timestamp: '2026-03-01T12:00:00.000Z' }));
    db.memory.submissions.push(sub('bia@grading.local', 'Av_P3', 80, { applicationId: 'app_rec', timestamp: '2026-03-20T12:00:00.000Z' }));
    db.memory.submissions.push(sub('bia@grading.local', 'Av_P3', 60, { applicationId: 'app_2ch', timestamp: '2026-03-25T12:00:00.000Z' }));
    const gb = await gradebookOf();
    const labels = gb.body.columns.filter(item => item.examKey === 'Av_P3').map(item => item.label || item.title);
    assert.ok(labels.some(label => /recuperação/.test(label)), JSON.stringify(labels));
    assert.ok(labels.some(label => /segunda chamada/.test(label)), JSON.stringify(labels));
    assert.ok(!labels.some(label => /2ª aplicação|3ª aplicação/.test(label)), JSON.stringify(labels));
    const csv = await gradebookOf('1DES', 'admin', '&format=csv');
    const header = csv.text.replace(/^﻿/, '').split(/\r?\n/)[0];
    assert.match(header, /recuperação/);
    assert.match(header, /segunda chamada/);
});
