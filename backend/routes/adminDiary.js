// ---------------------------------------------------------------------------
// Diário de classe pelo painel (fase 3, B11 / P4-S7, FUN-09; D3 e D4 do P4).
//
// GET  /api/admin/attendance/diary?courseId&studentClass&date   o diário do dia: uma aula
//      por aula da grade da semana (vazia sem conteúdo) e as gravadas fora da grade, com a
//      versão, quem registrou e quem alterou, a turma encerrada e o dia sem aula.
// POST /api/admin/attendance/diary  { courseId, studentClass, date, versao, aulas: [{ ordem,
//      disciplinaId?, conteudo?, atividade?, observacao? }] }  grava (junta) as aulas do dia.
//
// Regras:
// - Permissão 'page.students' no guarda (a regra /attendance(/.*) de adminPermissions.js já
//   cobre as duas rotas, como a chamada). A Coordenação (só consulta) lê pelo GET; o POST
//   dela recebe 403 read_only_account no guarda. Escopo: a turma do corpo ou da query no
//   guarda (validateProfessorRequestScope) e de novo aqui (adminCanAccessClass).
// - As regras e a gravação na memória ficam em utils/classDiary.js; aqui só a entrada, o
//   escopo, o portão da turma encerrada (assertClassOpen, 409 class_closed antes de mudar
//   qualquer coisa), a auditoria e a gravação parcial db.save({ only: ['classDiary',
//   'auditLogs'] }) (sem auditLogs quando a gravação não audita).
// - Versão: o POST manda a versão que leu (null quando o dia ainda não tinha diário);
//   outra do que a gravada responde 409 { code: 'diary_changed', atual } com o diário de
//   agora, e nada muda. Pedido que não muda nada responde changed: false e não grava.
// - Auditoria (categoria 'attendance'): diary_saved na primeira gravação do dia
//   (details { date, aulas: [ordem] }); diary_changed quando outra pessoa altera ou
//   passaram 24 h desde o começo da edição (before e after só das aulas que mudaram,
//   details { date, versao, aulas }). O autosave do mesmo autor não gera entrada.
// - Falha ao gravar no banco desfaz a mudança na memória (a próxima tentativa da tela
//   manda a mesma versão e passa).
// ---------------------------------------------------------------------------
const express = require('express');
const db = require('../database.js');
const { adminCanAccessClass, findClassByNameAndCourse, validateAdmin } = require('../middlewares.js');
const { outOfScopeMessage } = require('../utils/adminRoles.js');
const { recordAudit } = require('../utils/audit.js');
const { isCourseDeleted } = require('../utils/contentAccess.js');
const { assertClassOpen, isValidDate } = require('../utils/academicCalendar.js');
const diary = require('../utils/classDiary.js');
const { body, int, list, query, shape, str } = require('../utils/inputSchema.js');

const { DIARY_LIMITS } = diary;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const CLASS_FIELDS = {
    courseId: str({ max: 100, required: true, label: 'curso' }),
    studentClass: str({ max: 100, required: true, label: 'turma' }),
    date: str({ max: 10, required: true, pattern: DATE_PATTERN, label: 'data' }),
};

const SCHEMAS = Object.freeze({
    day: query(CLASS_FIELDS),
    save: body({
        ...CLASS_FIELDS,
        versao: int({ min: 0, nullable: true, label: 'versão do diário' }),
        aulas: list(shape({
            ordem: int({ min: 1, max: DIARY_LIMITS.maxOrdem, required: true, label: 'aula' }),
            disciplinaId: str({ max: DIARY_LIMITS.disciplinaMax, nullable: true, label: 'disciplina' }),
            conteudo: str({ max: DIARY_LIMITS.conteudoMax, nullable: true, label: 'conteúdo ministrado' }),
            atividade: str({ max: DIARY_LIMITS.atividadeMax, nullable: true, label: 'atividade' }),
            observacao: str({ max: DIARY_LIMITS.observacaoMax, nullable: true, label: 'observação da aula' }),
        }, { label: 'aula' }), { max: DIARY_LIMITS.maxAulas, required: true, label: 'aulas' }),
    }),
});

function sendFailure(res, result) {
    const payload = { success: false, error: result.error };
    if (result.field) payload.field = result.field;
    if (result.code) payload.code = result.code;
    if (result.atual) payload.atual = result.atual;
    return res.status(result.status || 400).json(payload);
}

// Turma do pedido, existente, de curso ativo e no escopo da conta; com o curso dela.
function scopedClass(res, account, courseIdValue, studentClassValue) {
    const courseId = String(courseIdValue || '').trim();
    const studentClass = String(studentClassValue || '').trim();
    const cls = courseId && studentClass ? findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId) : null;
    const course = cls ? (db.memory.courses || []).find(item => item && String(item.id) === String(cls.courseId)) : null;
    if (!cls || !course || isCourseDeleted(course)) {
        sendFailure(res, { status: 404, error: 'Turma não encontrada.', field: 'studentClass' });
        return null;
    }
    if (!adminCanAccessClass(account, cls.name, cls.courseId)) {
        sendFailure(res, { status: 403, error: outOfScopeMessage(account, 'A turma solicitada'), field: 'studentClass' });
        return null;
    }
    return { cls, course };
}

function invalidDate(res) {
    return sendFailure(res, { status: 400, error: 'Data inválida. Informe uma data real no formato AAAA-MM-DD.', field: 'date' });
}

function view(found, date) {
    return diary.diaryDayView(db.memory, { cls: found.cls, course: found.course, date });
}

function createAdminDiaryRouter() {
    const router = express.Router();

    router.get('/api/admin/attendance/diary', (req, res) => validateAdmin(req, res, (config, account) => {
        const params = SCHEMAS.day.check(req, res);
        if (!params) return undefined;
        const found = scopedClass(res, account, params.courseId, params.studentClass);
        if (!found) return undefined;
        if (!isValidDate(params.date)) return invalidDate(res);
        res.set('Cache-Control', 'no-store');
        return res.json({ success: true, diario: view(found, params.date), limites: DIARY_LIMITS });
    }));

    router.post('/api/admin/attendance/diary', SCHEMAS.save, (req, res) => validateAdmin(req, res, async (config, account) => {
        const found = scopedClass(res, account, req.body.courseId, req.body.studentClass);
        if (!found) return undefined;
        if (!isValidDate(req.body.date)) return invalidDate(res);
        // Turma encerrada não recebe diário (o GET continua mostrando o que foi gravado).
        if (!assertClassOpen(found.cls, { res })) return undefined;
        const date = req.body.date;
        const before = diary.findDiary(db.memory, { courseId: found.cls.courseId, studentClass: found.cls.name, date });
        const snapshot = before ? JSON.parse(JSON.stringify(before)) : null;
        const now = Date.now();
        const actor = (account && account.email) || 'admin';
        const result = diary.saveDiaryDay(db.memory, {
            cls: found.cls,
            course: found.course,
            date,
            versao: req.body.versao,
            aulas: req.body.aulas,
        }, { actor, now });
        if (!result.ok) {
            if (result.code === 'diary_changed') result.atual = view(found, date);
            return sendFailure(res, result);
        }
        if (!result.changed) return res.json({ success: true, changed: false, diario: view(found, date) });
        const record = result.record;
        let entry = null;
        if (result.audit) {
            const audit = result.audit;
            entry = recordAudit(db.memory, {
                req,
                actor: account,
                action: audit.action,
                category: 'attendance',
                courseId: record.courseId,
                studentClass: record.studentClass,
                ...(audit.action === 'diary_changed' ? { before: audit.antes, after: audit.depois } : {}),
                details: audit.action === 'diary_changed'
                    ? { date, versao: record.versao, aulas: audit.ordens }
                    : { date, aulas: record.aulas.map(lesson => lesson.ordem) },
            }, { timestamp: now });
        }
        try {
            await db.save({ only: result.audit ? ['classDiary', 'auditLogs'] : ['classDiary'] });
        } catch (error) {
            // Desfaz na memória o que não chegou ao banco: o diário volta ao que era e a
            // entrada da auditoria (que nunca foi gravada) sai, como na importação do
            // pacote de curso. A tela tenta de novo com a mesma versão.
            const list = Array.isArray(db.memory.classDiary) ? db.memory.classDiary : [];
            if (result.created) {
                const at = list.indexOf(record);
                if (at >= 0) list.splice(at, 1);
            } else if (snapshot) {
                Object.keys(record).forEach(key => { delete record[key]; });
                Object.assign(record, snapshot);
            }
            const audits = Array.isArray(db.memory.auditLogs) ? db.memory.auditLogs : [];
            const at = entry ? audits.indexOf(entry) : -1;
            if (at >= 0) audits.splice(at, 1);
            throw error;
        }
        return res.json({ success: true, changed: true, diario: view(found, date) });
    }));

    return router;
}

module.exports = { createAdminDiaryRouter, DIARY_SCHEMAS: SCHEMAS };
