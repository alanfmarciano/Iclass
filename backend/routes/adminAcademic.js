// Calendário acadêmico no painel (fase 3, grupo P2; B3 / P2-S5, FUN-15): dias não
// letivos (feriado, recesso, ponto facultativo, evento escolar) e a agenda da turma em
// .ics. As próximas subetapas da trilha B acrescentam aqui critérios de avaliação, plano
// da turma, avaliações manuais, período letivo e encerrar turma (D20 do P2: rotas novas
// fora de admin.js).
//
// Rotas (a guarda de /api/admin pede page.forum, a mesma do Calendário; o escopo do dia
// é decidido aqui):
// - GET  /api/admin/calendar/non-school-days?from=&to=&courseId=&studentClass=
//   { dias: [...com podeAlterar], tipos, escopos, podeCriar }. Com curso (e turma), os
//   dias que valem para aquele contexto (instituição, escola do curso, curso e turma);
//   sem curso, os do escopo da conta.
// - GET  /api/admin/calendar/non-school-days/national-holidays?ano=
//   os feriados nacionais do ano (academicCalendar.nationalHolidays) com jaCadastrado.
// - POST /api/admin/calendar/non-school-days/create, /update e /delete.
// - POST /api/admin/calendar/non-school-days/national-holidays { ano, incluir? }: cria os
//   que ainda não existem (idempotente pela data, pelo nome e pelo escopo instituição).
// - GET  /api/admin/calendar/ics?courseId=&studentClass=: a agenda da turma (eventos do
//   calendário e dias não letivos) em text/calendar.
//
// Quem cadastra cada escopo: 'instituicao' o administrador ou quem tem "Gerenciar
// turmas" (classes.manage); 'escola' o administrador, quem tem classes.manage e a
// Secretaria, para as escolas do escopo dela; 'curso' o administrador e quem tem o curso
// no escopo com classes.manage, course.manage ou escopo de escola; 'turma' quem tem a
// turma no escopo (o professor dela). Alterar e excluir pedem o mesmo do escopo de antes e
// do de depois.
//
// Presença do login nos dias cobertos (D13 do P2): cadastrar, alterar ou excluir o dia põe
// ou tira a marca naoLetivoId desses registros (academicCalendar.syncNonSchoolDayMarks,
// só nas datas do dia), e a frequência passa a ignorá-los ou a contá-los de novo. Nenhum
// registro é apagado; a chamada e a marcação individual nunca são marcadas; turma
// encerrada não muda. O dia de uma turma passa pelo portão da turma encerrada
// (assertClassOpen em create, update e delete; sem efeito até o B10); o de curso, escola
// ou instituição e os feriados nacionais não (valem para muitas turmas, e a encerrada só
// fica de fora da marca). A gravação é parcial: nonSchoolDays, auditLogs e, em attendance
// (coleção que só cresce), as linhas que mudaram (changed).
const express = require('express');
const crypto = require('crypto');
const db = require('../database.js');
const {
    validateAdmin,
    adminCanAccessClass,
    adminCanAccessCourse,
    adminCanAccessSchool,
    adminAllowedCourseIds,
    adminAllowedSchoolIds,
    findClassByNameAndCourse,
} = require('../middlewares.js');
const { isFullAdmin, accountScopeKind, outOfScopeMessage } = require('../utils/adminRoles.js');
const { canAccessAdminPermission } = require('../utils/adminPermissions.js');
const { recordAudit } = require('../utils/audit.js');
const { body, str, int, list, oneOf } = require('../utils/inputSchema.js');
const settingsUtil = require('../utils/settings.js');
const academicCalendar = require('../utils/academicCalendar.js');
const { nonSchoolDayCalendarItems } = require('../utils/calendarFeed.js');
const { buildIcs, icsFileName, calendarEventToIcs } = require('../utils/icsCalendar.js');

const {
    NON_SCHOOL_DAY_TYPES,
    NON_SCHOOL_DAY_TYPE_LABELS,
    NON_SCHOOL_DAY_SCOPES,
    NON_SCHOOL_DAY_SCOPE_LABELS,
    MAX_NON_SCHOOL_DAY_SPAN,
} = academicCalendar;

const NAME_MAX = 80;
const ID_FIELD = { max: 120, label: 'identificador' };

const DAY_FIELDS = {
    inicio: str({ max: 10, label: 'data de início' }),
    fim: str({ max: 10, nullable: true, label: 'data de fim' }),
    tipo: oneOf(NON_SCHOOL_DAY_TYPES, { label: 'tipo' }),
    nome: str({ max: NAME_MAX, label: 'nome' }),
    escopo: oneOf(NON_SCHOOL_DAY_SCOPES, { label: 'para quem vale' }),
    schoolId: str({ max: 120, nullable: true, label: 'escola' }),
    courseId: str({ max: 120, nullable: true, label: 'curso' }),
    studentClass: str({ max: 120, nullable: true, label: 'turma' }),
};

const SCHEMAS = {
    create: body(DAY_FIELDS),
    update: body({ id: str({ ...ID_FIELD, required: true }), ...DAY_FIELDS }),
    remove: body({ id: str({ ...ID_FIELD, required: true }) }),
    nationalHolidays: body({
        ano: int({ min: 2020, max: 2100, coerce: true, required: true, label: 'ano' }),
        incluir: list(str({ max: 40, label: 'feriado' }), { max: 20, nullable: true, label: 'feriados escolhidos' }),
    }),
};

const randomHex = () => crypto.randomBytes(3).toString('hex');
const newDayId = () => `nl_${Date.now()}_${randomHex()}`;
const text = value => String(value === undefined || value === null ? '' : value).trim();
const lowerName = value => text(value).normalize('NFC').toLocaleLowerCase('pt-BR');

function actorEmail(account) {
    return String((account && account.email) || 'admin').trim().toLowerCase();
}

// --- quem pode o quê --------------------------------------------------------------------

function canManageInstitution(account) {
    return isFullAdmin(account) || canAccessAdminPermission(account, 'classes.manage');
}

// A conta pode cadastrar, alterar ou excluir um dia com este escopo e este alvo?
function canManageDay(account, day) {
    if (!day) return false;
    if (isFullAdmin(account)) return true;
    switch (day.escopo) {
        case 'instituicao':
            return canManageInstitution(account);
        case 'escola':
            return !!day.schoolId && adminCanAccessSchool(account, day.schoolId)
                && (canAccessAdminPermission(account, 'classes.manage') || accountScopeKind(account) === 'escolas');
        case 'curso':
            return !!day.courseId && adminCanAccessCourse(account, day.courseId)
                && (canAccessAdminPermission(account, 'classes.manage')
                    || canAccessAdminPermission(account, 'course.manage')
                    || accountScopeKind(account) === 'escolas');
        case 'turma':
            return !!day.studentClass && adminCanAccessClass(account, day.studentClass, day.courseId);
        default:
            return false;
    }
}

// A conta vê o dia (lista sem contexto)?
function canSeeDay(account, day) {
    if (!day) return false;
    if (accountScopeKind(account) === 'tudo' || day.escopo === 'instituicao') return true;
    if (day.escopo === 'escola') return adminAllowedSchoolIds(account).has(day.schoolId);
    if (day.escopo === 'curso') return adminAllowedCourseIds(account).has(day.courseId);
    if (day.escopo === 'turma') return adminCanAccessClass(account, day.studentClass, day.courseId);
    return false;
}

// Os escopos que a conta pode usar no formulário, para a tela oferecer só esses.
function scopesFor(account, { courseId, studentClass, schoolId } = {}) {
    return NON_SCHOOL_DAY_SCOPES.filter(escopo => canManageDay(account, {
        escopo,
        schoolId: schoolId || '',
        courseId: courseId || '',
        studentClass: studentClass || '',
    }));
}

// --- validação do formulário -------------------------------------------------------------

function fieldError(res, error, field, status = 400) {
    return res.status(status).json({ success: false, error, field });
}

// Lê o dia do corpo (já conferido pelo schema). Devolve { day } ou { error, field }.
function readDayInput(input) {
    const inicio = text(input.inicio);
    if (!inicio) return { error: 'Informe a data do dia não letivo.', field: 'inicio' };
    if (!academicCalendar.isValidDate(inicio)) return { error: 'Data inválida. Informe uma data real no formato AAAA-MM-DD.', field: 'inicio' };
    const fim = text(input.fim) || inicio;
    if (!academicCalendar.isValidDate(fim)) return { error: 'Data de fim inválida. Informe uma data real no formato AAAA-MM-DD.', field: 'fim' };
    if (fim < inicio) return { error: 'A data de fim não pode ser antes da data de início.', field: 'fim' };
    if (academicCalendar.spanDays(inicio, fim) > MAX_NON_SCHOOL_DAY_SPAN) {
        return { error: `Um dia não letivo cobre no máximo ${MAX_NON_SCHOOL_DAY_SPAN} dias. Para um período maior, cadastre mais de um.`, field: 'fim' };
    }
    const nome = text(input.nome);
    if (!nome) return { error: 'Informe o nome (por exemplo: Proclamação da República).', field: 'nome' };
    const tipo = text(input.tipo) || 'feriado';
    const escopo = text(input.escopo);
    if (!escopo) return { error: 'Escolha para quem o dia vale (turma, curso, escola ou instituição).', field: 'escopo' };
    const day = { inicio, fim, tipo, nome, escopo };
    if (escopo === 'escola') {
        const schoolId = text(input.schoolId);
        if (!schoolId) return { error: 'Escolha a escola.', field: 'schoolId' };
        if (!(db.memory.schools || []).some(school => school && String(school.id) === schoolId)) return { error: 'Escola não encontrada.', field: 'schoolId' };
        day.schoolId = schoolId;
    }
    if (escopo === 'curso' || escopo === 'turma') {
        const courseId = text(input.courseId);
        if (!courseId) return { error: 'Escolha o curso.', field: 'courseId' };
        if (!(db.memory.courses || []).some(course => course && String(course.id) === courseId)) return { error: 'Curso não encontrado.', field: 'courseId' };
        day.courseId = courseId;
    }
    if (escopo === 'turma') {
        const studentClass = text(input.studentClass);
        if (!studentClass) return { error: 'Escolha a turma.', field: 'studentClass' };
        if (!findClassByNameAndCourse(db.memory.classes || [], studentClass, day.courseId)) return { error: 'Turma não encontrada neste curso.', field: 'studentClass' };
        day.studentClass = studentClass;
    }
    return { day };
}

function sameTarget(a, b) {
    return a.escopo === b.escopo
        && text(a.schoolId) === text(b.schoolId)
        && text(a.courseId) === text(b.courseId)
        && text(a.studentClass) === text(b.studentClass);
}

function findDuplicate(day, ignoreId) {
    return (db.memory.nonSchoolDays || []).find(item => item && item.id !== ignoreId
        && text(item.inicio) === day.inicio
        && (text(item.fim) || text(item.inicio)) === day.fim
        && lowerName(item.nome) === lowerName(day.nome)
        && sameTarget(item, day));
}

// Registro gravado: só os campos do escopo (nada de schoolId num dia de turma).
function storedDay(day, base) {
    const out = {
        id: base.id,
        schemaVersion: 1,
        inicio: day.inicio,
        fim: day.fim,
        tipo: day.tipo,
        nome: day.nome,
        escopo: day.escopo,
    };
    if (day.escopo === 'escola') out.schoolId = day.schoolId;
    if (day.escopo === 'curso' || day.escopo === 'turma') out.courseId = day.courseId;
    if (day.escopo === 'turma') out.studentClass = day.studentClass;
    out.origem = base.origem || 'manual';
    out.criadoEm = base.criadoEm;
    out.criadoPor = base.criadoPor;
    out.atualizadoEm = base.atualizadoEm;
    if (base.atualizadoPor) out.atualizadoPor = base.atualizadoPor;
    return out;
}

// Dia para a resposta: o normalizado (leitura tolerante), com os rótulos e podeAlterar.
function dayView(account, raw) {
    const day = academicCalendar.normalizeNonSchoolDay(raw);
    if (!day) return null;
    return {
        ...day,
        tipoRotulo: NON_SCHOOL_DAY_TYPE_LABELS[day.tipo] || NON_SCHOOL_DAY_TYPE_LABELS.outro,
        escopoRotulo: NON_SCHOOL_DAY_SCOPE_LABELS[day.escopo],
        origem: raw.origem === 'feriados_nacionais' ? 'feriados_nacionais' : 'manual',
        criadoEm: raw.criadoEm || null,
        criadoPor: raw.criadoPor || null,
        atualizadoEm: raw.atualizadoEm || null,
        podeAlterar: canManageDay(account, day),
    };
}

// Escopo e alvo do dia para a auditoria (curso e turma ficam na entrada, para a ficha da
// turma e o filtro da Auditoria acharem).
function auditTarget(day) {
    const out = {};
    if (day && day.courseId) out.courseId = day.courseId;
    if (day && day.studentClass) out.studentClass = day.studentClass;
    return out;
}

// Turma do dia de escopo 'turma', para o portão da turma encerrada (X4 do plano:
// assertClassOpen, sem efeito até o B10), ou null. O dia de curso, escola ou instituição
// vale para muitas turmas e não passa pelo portão (um feriado não pode ser recusado por
// uma turma encerrada): a turma encerrada só fica de fora da marca
// (syncNonSchoolDayMarks olha isClassClosed).
function dayClass(day) {
    if (!day || day.escopo !== 'turma') return null;
    return findClassByNameAndCourse(db.memory.classes || [], day.studentClass, day.courseId);
}

function saveWithMarks(marks) {
    const options = { only: ['nonSchoolDays', 'auditLogs'] };
    if (marks && marks.changedIds.length) options.changed = { attendance: marks.changedIds };
    return db.save(options);
}

// Os campos que definem o dia (sem datas de gravação nem autor).
function dayKey(day) {
    return JSON.stringify(['inicio', 'fim', 'tipo', 'nome', 'escopo', 'schoolId', 'courseId', 'studentClass'].map(field => text(day && day[field])));
}

function createAdminAcademicRouter() {
    const router = express.Router();

    router.get('/api/admin/calendar/non-school-days', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const from = academicCalendar.isValidDate(req.query.from) ? req.query.from : undefined;
            const to = academicCalendar.isValidDate(req.query.to) ? req.query.to : undefined;
            const courseId = text(req.query.courseId);
            const studentClass = text(req.query.studentClass);
            const course = courseId ? (db.memory.courses || []).find(item => item && String(item.id) === courseId) : null;
            if (courseId && !course) return res.status(404).json({ error: 'Curso não encontrado.' });
            const source = db.memory.nonSchoolDays || [];
            let raws;
            if (courseId) {
                const ids = new Set(academicCalendar.nonSchoolDaysFor(db.memory, { courseId, studentClass }, { from, to }).map(day => day.id));
                raws = source.filter(item => item && ids.has(item.id));
            } else {
                raws = source.filter(item => {
                    const day = academicCalendar.normalizeNonSchoolDay(item);
                    return day && canSeeDay(account, day) && (!from || day.fim >= from) && (!to || day.inicio <= to);
                });
            }
            const dias = raws.map(raw => dayView(account, raw)).filter(Boolean)
                .sort((a, b) => a.inicio.localeCompare(b.inicio) || a.id.localeCompare(b.id));
            res.json({
                dias,
                tipos: NON_SCHOOL_DAY_TYPES.map(value => ({ value, label: NON_SCHOOL_DAY_TYPE_LABELS[value] })),
                escopos: scopesFor(account, { courseId, studentClass, schoolId: course && course.schoolId })
                    .map(value => ({ value, label: NON_SCHOOL_DAY_SCOPE_LABELS[value] })),
                podeAdicionarFeriadosNacionais: canManageInstitution(account),
            });
        });
    });

    router.get('/api/admin/calendar/non-school-days/national-holidays', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const ano = Number(req.query.ano);
            if (!Number.isInteger(ano) || ano < 2020 || ano > 2100) return fieldError(res, 'Informe um ano entre 2020 e 2100.', 'ano');
            const existing = db.memory.nonSchoolDays || [];
            res.json({
                ano,
                feriados: academicCalendar.nationalHolidays(ano).map(holiday => ({
                    ...holiday,
                    tipoRotulo: NON_SCHOOL_DAY_TYPE_LABELS[holiday.tipo],
                    jaCadastrado: existing.some(item => item && item.escopo === 'instituicao'
                        && text(item.inicio) === holiday.inicio && lowerName(item.nome) === lowerName(holiday.nome)),
                })),
                podeAdicionar: canManageInstitution(account),
            });
        });
    });

    router.post('/api/admin/calendar/non-school-days/create', SCHEMAS.create, (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const parsed = readDayInput(req.body);
            if (parsed.error) return fieldError(res, parsed.error, parsed.field);
            const { day } = parsed;
            if (!canManageDay(account, day)) {
                return fieldError(res, day.escopo === 'turma'
                    ? 'A turma escolhida não está atribuída a esta conta.'
                    : 'Sua conta não pode cadastrar dia não letivo com este alcance. Escolha a sua turma ou peça ao administrador.', 'escopo', 403);
            }
            if (findDuplicate(day)) return res.status(409).json({ success: false, code: 'duplicate', error: 'Este dia não letivo já está cadastrado.' });
            // Turma encerrada não ganha dia não letivo (muda a presença dela).
            if (!academicCalendar.assertClassOpen(dayClass(day), { res })) return;
            const now = Date.now();
            const record = storedDay(day, { id: newDayId(), criadoEm: now, criadoPor: actorEmail(account), atualizadoEm: now });
            if (!Array.isArray(db.memory.nonSchoolDays)) db.memory.nonSchoolDays = [];
            db.memory.nonSchoolDays.push(record);
            const marks = academicCalendar.syncNonSchoolDayMarks(db.memory, { ranges: [{ inicio: record.inicio, fim: record.fim }] });
            const presencasIgnoradas = marks.marcados.length + marks.trocados.length;
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'non_school_day_created',
                category: 'academic',
                ...auditTarget(record),
                after: record,
                details: { presencasIgnoradas },
            });
            saveWithMarks(marks);
            res.json({ success: true, dia: dayView(account, record), presencasIgnoradas });
        });
    });

    router.post('/api/admin/calendar/non-school-days/update', SCHEMAS.update, (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const list = Array.isArray(db.memory.nonSchoolDays) ? db.memory.nonSchoolDays : [];
            const index = list.findIndex(item => item && item.id === req.body.id);
            if (index === -1) return res.status(404).json({ error: 'Dia não letivo não encontrado.' });
            const current = list[index];
            const currentDay = academicCalendar.normalizeNonSchoolDay(current);
            // Registro que não se lê (escopo desconhecido, sem data) só o administrador muda.
            if (currentDay ? !canManageDay(account, currentDay) : !isFullAdmin(account)) {
                return res.status(403).json({ error: outOfScopeMessage(account, 'O dia não letivo') });
            }
            const parsed = readDayInput(req.body);
            if (parsed.error) return fieldError(res, parsed.error, parsed.field);
            const { day } = parsed;
            if (!canManageDay(account, day)) return fieldError(res, 'Sua conta não pode dar este alcance ao dia não letivo.', 'escopo', 403);
            if (findDuplicate(day, current.id)) return res.status(409).json({ success: false, code: 'duplicate', error: 'Já existe um dia não letivo igual a este.' });
            // A turma de antes e a de depois (dia de turma) precisam estar abertas.
            if (!academicCalendar.assertClassOpen([dayClass(currentDay), dayClass(day)].filter(Boolean), { res })) return;
            // Salvar sem mudar nada não grava nem registra.
            if (dayKey(day) === dayKey(currentDay)) {
                return res.json({ success: true, dia: dayView(account, current), semMudanca: true, marcadas: 0, desmarcadas: 0 });
            }
            const now = Date.now();
            const record = storedDay(day, {
                id: current.id,
                origem: current.origem,
                criadoEm: current.criadoEm || now,
                criadoPor: current.criadoPor || actorEmail(account),
                atualizadoEm: now,
                atualizadoPor: actorEmail(account),
            });
            list[index] = record;
            const ranges = [{ inicio: record.inicio, fim: record.fim }];
            if (currentDay) ranges.push({ inicio: currentDay.inicio, fim: currentDay.fim });
            const marks = academicCalendar.syncNonSchoolDayMarks(db.memory, { ranges });
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'non_school_day_updated',
                category: 'academic',
                ...auditTarget(record),
                before: current,
                after: record,
                details: { marcadas: marks.marcados.length, desmarcadas: marks.desmarcados.length, trocadas: marks.trocados.length },
            });
            saveWithMarks(marks);
            res.json({ success: true, dia: dayView(account, record), marcadas: marks.marcados.length, desmarcadas: marks.desmarcados.length });
        });
    });

    router.post('/api/admin/calendar/non-school-days/delete', SCHEMAS.remove, (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const list = Array.isArray(db.memory.nonSchoolDays) ? db.memory.nonSchoolDays : [];
            const current = list.find(item => item && item.id === req.body.id);
            if (!current) return res.status(404).json({ error: 'Dia não letivo não encontrado.' });
            const currentDay = academicCalendar.normalizeNonSchoolDay(current);
            if (currentDay ? !canManageDay(account, currentDay) : !isFullAdmin(account)) {
                return res.status(403).json({ error: outOfScopeMessage(account, 'O dia não letivo') });
            }
            if (!academicCalendar.assertClassOpen(dayClass(currentDay), { res })) return;
            db.memory.nonSchoolDays = list.filter(item => item !== current);
            // As presenças do login nessas datas voltam a contar (a marca sai).
            const marks = academicCalendar.syncNonSchoolDayMarks(db.memory, {
                ranges: currentDay ? [{ inicio: currentDay.inicio, fim: currentDay.fim }] : [],
            });
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'non_school_day_deleted',
                category: 'academic',
                ...auditTarget(currentDay || current),
                details: { deleted: { ...current }, presencasDevolvidas: marks.desmarcados.length },
            });
            saveWithMarks(marks);
            res.json({ success: true, presencasDevolvidas: marks.desmarcados.length });
        });
    });

    router.post('/api/admin/calendar/non-school-days/national-holidays', SCHEMAS.nationalHolidays, (req, res) => {
        validateAdmin(req, res, (config, account) => {
            if (!canManageInstitution(account)) {
                return res.status(403).json({ error: 'Os feriados nacionais valem para toda a instituição: só o administrador ou quem gerencia as turmas os adiciona.' });
            }
            const ano = req.body.ano;
            const holidays = academicCalendar.nationalHolidays(ano);
            const chosen = Array.isArray(req.body.incluir) ? new Set(req.body.incluir.map(text)) : null;
            if (chosen) {
                const unknown = [...chosen].find(chave => !holidays.some(holiday => holiday.chave === chave));
                if (unknown) return fieldError(res, `Feriado desconhecido: ${unknown}.`, 'incluir');
            }
            if (!Array.isArray(db.memory.nonSchoolDays)) db.memory.nonSchoolDays = [];
            const existing = db.memory.nonSchoolDays;
            const now = Date.now();
            const criados = [];
            const jaExistiam = [];
            holidays.filter(holiday => !chosen || chosen.has(holiday.chave)).forEach(holiday => {
                const exists = existing.some(item => item && item.escopo === 'instituicao'
                    && text(item.inicio) === holiday.inicio && lowerName(item.nome) === lowerName(holiday.nome));
                if (exists) { jaExistiam.push(holiday.inicio); return; }
                const record = storedDay({ ...holiday, escopo: 'instituicao' }, {
                    id: newDayId(), origem: 'feriados_nacionais', criadoEm: now, criadoPor: actorEmail(account), atualizadoEm: now,
                });
                existing.push(record);
                criados.push(record);
            });
            // Segunda chamada no mesmo ano: nada novo, nada gravado nem registrado.
            if (!criados.length) return res.json({ success: true, ano, criados: [], jaExistiam, presencasIgnoradas: 0 });
            const marks = academicCalendar.syncNonSchoolDayMarks(db.memory, { ranges: criados.map(item => ({ inicio: item.inicio, fim: item.fim })) });
            const presencasIgnoradas = marks.marcados.length + marks.trocados.length;
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'national_holidays_added',
                category: 'academic',
                details: { ano, criados: criados.map(item => item.inicio), presencasIgnoradas },
            });
            saveWithMarks(marks);
            res.json({ success: true, ano, criados: criados.map(item => dayView(account, item)), jaExistiam, presencasIgnoradas });
        });
    });

    // Agenda da turma em .ics: os eventos do calendário do curso e da turma e os dias não
    // letivos que valem para ela (a guarda já conferiu o curso e a turma no escopo).
    router.get('/api/admin/calendar/ics', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const courseId = text(req.query.courseId);
            const studentClass = text(req.query.studentClass);
            if (!courseId) return res.status(400).json({ error: 'Curso é obrigatório.' });
            const course = (db.memory.courses || []).find(item => item && String(item.id) === courseId);
            if (!course) return res.status(404).json({ error: 'Curso não encontrado.' });
            if (studentClass ? !adminCanAccessClass(account, studentClass, courseId) : !adminCanAccessCourse(account, courseId)) {
                return res.status(403).json({ error: outOfScopeMessage(account, studentClass ? 'A turma solicitada' : 'O curso solicitado') });
            }
            const eventos = (db.memory.announcements || [])
                .filter(item => item && item.kind === 'calendar' && item.courseId === courseId
                    && (item.target === 'curso' || !studentClass || item.targetValue === studentClass))
                .map(item => ({ ...item, description: item.message || '' }))
                // Mesmo UID da agenda do aluno (nao-letivo:<id>): importar as duas não duplica.
                .concat(nonSchoolDayCalendarItems(db.memory, { courseId, studentClass })
                    .map(item => ({ ...item, id: `nao-letivo:${item.id}` })))
                .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)) || String(a.startTime || '').localeCompare(String(b.startTime || '')))
                .map(calendarEventToIcs)
                .filter(Boolean);
            const nome = [course.name || courseId, studentClass].filter(Boolean).join(' · ');
            const ics = buildIcs({ nome, eventos, timezone: settingsUtil.getSettings().timezone });
            res.set('Content-Type', 'text/calendar; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="${icsFileName(courseId, studentClass)}"`);
            res.send(ics);
        });
    });

    return router;
}

module.exports = {
    createAdminAcademicRouter,
    canManageDay,
    canSeeDay,
};
