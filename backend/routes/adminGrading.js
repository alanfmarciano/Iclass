// Critérios de avaliação do curso, plano de avaliação da turma e avaliações manuais no
// painel (fase 3, grupo P2; B6 / P2-S3, FUN-02). As rotas entram no router do
// adminAcademic.js (registerGradingRoutes); ficam num arquivo próprio para não crescer
// aquele, que recebe também o período letivo e o encerramento da turma.
//
// A conta é uma só (contrato C1 do P2): gradebook.js monta os dados e gradingRules.js
// calcula; aqui só se lê, confere e grava. A guarda de /api/admin pede page.results
// (critérios: GET page.results, POST course.manage; regras em adminPermissions.js) e
// confere o curso e a turma do corpo ou da consulta (validateProfessorRequestScope); cada
// rota confere de novo o escopo do curso ou da turma.
//
// Rotas:
// - GET  /api/admin/grading/criteria?courseId=
//   { courseId, ativo, regraAntiga, criterios (normalizados, com os padrões), padrao,
//     regrasRecuperacao, unidades, limites, temNotaPublicada, podeAlterar }.
// - POST /api/admin/grading/criteria { courseId, ativo, mediaMinima, frequenciaMinima,
//   etapas, recuperacao, mencoes, unidadeSituacao, reason? }: grava course.avaliacao
//   (desligar guarda o resto, para religar igual). Com nota publicada em alguma turma do
//   curso, pede motivo (reason_required). Auditoria grading_criteria_updated.
// - POST /api/admin/grading/preview { courseId, studentClass?, criterios?, plano? }: o
//   quadro com a regra proposta, sem gravar, e quem muda de situação ou de média (com
//   turma, a da turma; sem turma, as turmas do curso no escopo da conta).
// - GET  /api/admin/grading/plan?courseId=&studentClass=
//   { itens (prova, avaliação manual e itens dos provedores, com etapa, peso, recuperação,
//     "fora da média" e quantas notas lançadas e publicadas), manuais, modulos, etapas,
//     tipos, avisos, ativo, criterio, encerrada, podeAlterar }.
// - POST /api/admin/grading/plan { courseId, studentClass, itens: { id: { etapa, peso,
//   recuperacaoDe, fora } }, reason? }: junta no plano só os ids que existem na turma
//   (os outros voltam em ignorados); com critérios ligados e nota publicada num item que
//   mudou, pede motivo. Auditoria grading_plan_updated (só os itens que mudaram).
// - POST /api/admin/grading/manual-items/create, /update, /archive e /restore: avaliação
//   manual da turma (classes[].avaliacao.manuais, id 'man_<ms>_<6hex>'). A nota é lançada
//   pelo submissions/create (lançamento rápido, examKey = id). Arquivar só esconde: as
//   notas ficam guardadas e saem da média com aviso. Com nota publicada, arquivar, reativar
//   e mudar etapa, peso (critérios ligados) ou módulo pedem motivo.
//   Auditoria manual_assessment_created/updated/archived/restored.
//
// O plano e as avaliações manuais passam pelo portão da turma encerrada (assertClassOpen,
// 409 class_closed, sem efeito até o B10). Gravação parcial: courses ou classes, e
// auditLogs. Nada é apagado: id do plano que saiu da estrutura fica guardado.
const crypto = require('crypto');
const db = require('../database.js');
const {
    validateAdmin,
    adminCanAccessClass,
    adminCanAccessCourse,
    findClassByNameAndCourse,
    filterStudentsForAdmin,
    filterSubmissionsForAdmin,
} = require('../middlewares.js');
const { isFullAdmin, isReadOnlyAccount, outOfScopeMessage } = require('../utils/adminRoles.js');
const { canAccessAdminPermission } = require('../utils/adminPermissions.js');
const { recordAudit } = require('../utils/audit.js');
const { body, str, int, num, bool, list, oneOf, shape, dict } = require('../utils/inputSchema.js');
const settingsUtil = require('../utils/settings.js');
const academicCalendar = require('../utils/academicCalendar.js');
const gradingRules = require('../utils/gradingRules.js');
const { effectiveStructure } = require('../utils/classContent.js');
const {
    MANUAL_TYPE_LABELS,
    buildClassGradebook,
    buildGradeGroups,
    classGradingContext,
    gradeItemProviderList,
    planItemView,
    planWarnings,
    scopeSubmissionsToContext,
    structureModuleId,
} = require('../utils/gradebook.js');

const { LIMITES, RECUPERACAO_REGRAS, RECUPERACAO_ROTULOS, UNIDADES_SITUACAO, MANUAL_TIPOS, CRITERIOS_PADRAO } = gradingRules;

const ID_FIELD = { max: 120, label: 'identificador' };
const REASON_FIELD = str({ max: 500, nullable: true, label: 'motivo' });
const REASON_MIN = 3;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RECOVERY_TARGET_PATTERN = /^(etapa:[1-6]|final)$/;
const UNIDADE_ROTULOS = Object.freeze({ disciplina: 'Por disciplina', turma: 'Uma situação para a turma' });

const CRITERIA_FIELDS = {
    ativo: bool({ label: 'critérios ligados' }),
    mediaMinima: num({ min: LIMITES.mediaMin, max: LIMITES.mediaMax, coerce: true, label: 'média mínima' }),
    frequenciaMinima: int({ min: LIMITES.frequenciaMin, max: LIMITES.frequenciaMax, coerce: true, label: 'frequência mínima' }),
    etapas: list(shape({
        ordem: int({ min: 1, max: LIMITES.etapasMax, coerce: true, required: true, label: 'número da etapa' }),
        nome: str({ max: LIMITES.nomeEtapaMax, label: 'nome da etapa' }),
        peso: num({ min: LIMITES.pesoMin, max: LIMITES.pesoMax, coerce: true, label: 'peso da etapa' }),
    }, { label: 'etapa' }), { max: LIMITES.etapasMax, label: 'etapas' }),
    recuperacao: shape({
        etapa: oneOf(RECUPERACAO_REGRAS, { label: 'recuperação da etapa' }),
        final: oneOf(RECUPERACAO_REGRAS, { label: 'recuperação final' }),
    }, { label: 'recuperação' }),
    mencoes: list(shape({
        sigla: str({ max: LIMITES.siglaMax, required: true, label: 'sigla da menção' }),
        nome: str({ max: LIMITES.nomeMencaoMax, label: 'nome da menção' }),
        min: num({ min: LIMITES.mediaMin, max: LIMITES.mediaMax, coerce: true, required: true, label: 'nota mínima da menção' }),
    }, { label: 'menção' }), { max: LIMITES.mencoesMax, nullable: true, label: 'menções' }),
    unidadeSituacao: oneOf(UNIDADES_SITUACAO, { label: 'unidade da situação' }),
};

const PLAN_ITEM = shape({
    etapa: int({ min: 1, max: LIMITES.etapasMax, coerce: true, nullable: true, emptyAsNull: true, label: 'etapa' }),
    peso: num({ min: LIMITES.pesoMin, max: LIMITES.pesoMax, coerce: true, label: 'peso' }),
    recuperacaoDe: str({ max: 20, nullable: true, pattern: RECOVERY_TARGET_PATTERN, label: 'recuperação de' }),
    fora: bool({ label: 'fora da média' }),
}, { label: 'item do plano' });

const CONTEXT_FIELDS = {
    courseId: str({ ...ID_FIELD, required: true, label: 'curso' }),
    studentClass: str({ max: 120, required: true, label: 'turma' }),
};

const MANUAL_FIELDS = {
    titulo: str({ max: 120, label: 'título' }),
    tipo: oneOf(MANUAL_TIPOS, { label: 'tipo' }),
    descricao: str({ max: 500, nullable: true, label: 'descrição' }),
    data: str({ max: 10, nullable: true, pattern: DATE_PATTERN, label: 'data' }),
    moduloId: str({ max: 120, nullable: true, label: 'módulo' }),
    etapa: int({ min: 1, max: LIMITES.etapasMax, coerce: true, nullable: true, emptyAsNull: true, label: 'etapa' }),
    peso: num({ min: LIMITES.pesoMin, max: LIMITES.pesoMax, coerce: true, label: 'peso' }),
};

const SCHEMAS = {
    criteria: body({ courseId: str({ ...ID_FIELD, required: true, label: 'curso' }), ...CRITERIA_FIELDS, reason: REASON_FIELD }),
    preview: body({
        courseId: str({ ...ID_FIELD, required: true, label: 'curso' }),
        studentClass: str({ max: 120, nullable: true, label: 'turma' }),
        criterios: shape(CRITERIA_FIELDS, { nullable: true, label: 'critérios' }),
        plano: shape({ itens: dict(PLAN_ITEM, { maxKeys: LIMITES.itensMax, keyMax: LIMITES.itemIdMax, label: 'itens do plano' }) }, { nullable: true, label: 'plano' }),
    }),
    plan: body({
        ...CONTEXT_FIELDS,
        itens: dict(PLAN_ITEM, { maxKeys: LIMITES.itensMax, keyMax: LIMITES.itemIdMax, required: true, label: 'itens do plano' }),
        reason: REASON_FIELD,
    }),
    manualCreate: body({ ...CONTEXT_FIELDS, ...MANUAL_FIELDS, titulo: str({ max: 120, required: true, label: 'título' }) }),
    manualUpdate: body({ ...CONTEXT_FIELDS, id: str({ ...ID_FIELD, required: true }), ...MANUAL_FIELDS, reason: REASON_FIELD }),
    manualArchive: body({ ...CONTEXT_FIELDS, id: str({ ...ID_FIELD, required: true }), reason: REASON_FIELD }),
};

const randomHex = () => crypto.randomBytes(3).toString('hex');
const newManualId = () => `man_${Date.now()}_${randomHex()}`;
const text = value => String(value === undefined || value === null ? '' : value).trim();
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (target, key) => Object.prototype.hasOwnProperty.call(target, key);

function actorEmail(account) {
    return String((account && account.email) || 'admin').trim().toLowerCase();
}

function canWrite(account, permission) {
    return !isReadOnlyAccount(account) && (isFullAdmin(account) || canAccessAdminPermission(account, permission));
}

function fieldError(res, error, field, status = 400) {
    return res.status(status).json({ success: false, error, ...(field ? { field } : {}) });
}

function reasonRequired(res, error) {
    return res.status(400).json({ success: false, code: 'reason_required', error, field: 'reason' });
}

// Número digitado com vírgula ("6,5"): vira "6.5" antes do schema (coerce aceita o ponto).
function commaToDot(value) {
    return typeof value === 'string' && /^\s*-?\d+,\d+\s*$/.test(value) ? value.trim().replace(',', '.') : value;
}

function fixCommaNumbers(criterios) {
    if (!isPlainObject(criterios)) return;
    if (hasOwn(criterios, 'mediaMinima')) criterios.mediaMinima = commaToDot(criterios.mediaMinima);
    if (Array.isArray(criterios.etapas)) criterios.etapas.forEach(etapa => { if (isPlainObject(etapa) && hasOwn(etapa, 'peso')) etapa.peso = commaToDot(etapa.peso); });
    if (Array.isArray(criterios.mencoes)) criterios.mencoes.forEach(item => { if (isPlainObject(item) && hasOwn(item, 'min')) item.min = commaToDot(item.min); });
}

function fixPlanCommaNumbers(itens) {
    if (!isPlainObject(itens)) return;
    Object.values(itens).forEach(item => { if (isPlainObject(item) && hasOwn(item, 'peso')) item.peso = commaToDot(item.peso); });
}

// --- contexto -----------------------------------------------------------------------------

function findCourse(courseId) {
    return (db.memory.courses || []).find(item => item && String(item.id) === String(courseId)) || null;
}

function structureFor(course, cls) {
    const courseId = String((course && course.id) || '');
    return effectiveStructure(courseId, cls ? cls.name : '')?.structure || (course && course.structure) || [];
}

// Curso e turma do pedido, com o escopo da conta. Devolve { course, cls, structure } ou
// { status, error }.
function resolveClass(account, courseId, studentClass) {
    const id = text(courseId);
    const name = text(studentClass);
    if (!id || !name) return { status: 400, error: 'Curso e turma são obrigatórios.' };
    const course = findCourse(id);
    if (!course) return { status: 404, error: 'Curso não encontrado.' };
    const cls = findClassByNameAndCourse(db.memory.classes || [], name, id);
    if (!cls || String(cls.courseId || id) !== id) return { status: 404, error: 'Turma não encontrada neste curso.' };
    if (!adminCanAccessClass(account, cls.name, id)) return { status: 403, error: 'Turma não autorizada para esta conta.' };
    return { course, cls, structure: structureFor(course, cls) };
}

function resolveCourse(account, courseId) {
    const id = text(courseId);
    if (!id) return { status: 400, error: 'Informe o curso.' };
    const course = findCourse(id);
    if (!course) return { status: 404, error: 'Curso não encontrado.' };
    if (!adminCanAccessCourse(account, id)) return { status: 403, error: outOfScopeMessage(account, 'O curso solicitado') };
    return { course };
}

function gradingFor(course, cls, structure) {
    return classGradingContext(db.memory, { course, cls, structure, hoje: settingsUtil.today() });
}

function courseClasses(courseId) {
    return (db.memory.classes || []).filter(cls => cls && cls.name && String(cls.courseId || '') === String(courseId));
}

function contextScope(courseId, studentClass) {
    return { courseId, studentClass, students: db.memory.students || [], classes: db.memory.classes || [] };
}

// Entregas com nota da turma (registro antigo sem curso completado pelo cadastro).
function classSubmissions(courseId, studentClass) {
    return scopeSubmissionsToContext(db.memory.submissions || [], contextScope(courseId, studentClass));
}

// Notas por item na turma: Map itemId -> { lancadas, publicadas } (grupos consolidados,
// um por aluno e aplicação; mais as notas dos provedores).
function gradeCountsByItem(grading, submissions) {
    const counts = new Map();
    const add = (id, publicada) => {
        if (!counts.has(id)) counts.set(id, { lancadas: 0, publicadas: 0 });
        const entry = counts.get(id);
        entry.lancadas += 1;
        if (publicada) entry.publicadas += 1;
    };
    buildGradeGroups(submissions).forEach(group => {
        if (group.score === null || group.score === undefined) return;
        const publicada = group.attempts.some(attempt => attempt && attempt.gradePublished === true);
        add(group.examKey, publicada);
    });
    grading.providerGroups({}).forEach(group => { if (group.score !== null) add(group.examKey, group.pendingCount === 0); });
    return counts;
}

function coursePublishedGrades(course) {
    const courseId = String(course.id);
    const published = (db.memory.submissions || []).filter(s => s && s.gradePublished === true);
    if (scopeSubmissionsToContext(published, contextScope(courseId, '')).length) return true;
    if (!gradeItemProviderList().length) return false;
    return courseClasses(courseId).some(cls => gradingFor(course, cls, structureFor(course, cls)).providerGroups({ publishedOnly: true }).length > 0);
}

// --- critérios -----------------------------------------------------------------------------

// Critérios para a tela: os gravados (mesmo desligados) com os padrões; sem nada gravado,
// os padrões, desligados.
function criteriaView(raw) {
    const stored = isPlainObject(raw) ? gradingRules.normalizeCriteria({ ...raw, ativo: true }) : gradingRules.normalizeCriteria({ ...CRITERIOS_PADRAO });
    const ativo = isPlainObject(raw) && raw.ativo !== false;
    return { ...stored, ativo };
}

function comparableCriteria(raw) {
    if (!isPlainObject(raw)) return null;
    const view = criteriaView(raw);
    delete view.atualizadoEm;
    delete view.atualizadoPor;
    return view;
}

// Critérios do corpo sobre os de antes (o que não vier fica como está). Devolve
// { criterios } (normalizados, com ativo) ou { error, field }.
function readCriteriaInput(input, base) {
    const current = criteriaView(base);
    const merged = {
        ativo: hasOwn(input, 'ativo') && input.ativo !== undefined ? input.ativo : current.ativo,
        mediaMinima: input.mediaMinima !== undefined ? input.mediaMinima : current.mediaMinima,
        frequenciaMinima: input.frequenciaMinima !== undefined ? input.frequenciaMinima : current.frequenciaMinima,
        etapas: input.etapas !== undefined ? input.etapas : current.etapas,
        recuperacao: { ...current.recuperacao, ...(isPlainObject(input.recuperacao) ? stripEmpty(input.recuperacao) : {}) },
        mencoes: input.mencoes !== undefined ? input.mencoes : current.mencoes,
        unidadeSituacao: input.unidadeSituacao ? input.unidadeSituacao : current.unidadeSituacao,
    };
    if (!Array.isArray(merged.etapas) || !merged.etapas.length) return { error: 'Informe ao menos uma etapa.', field: 'etapas' };
    const ordens = new Set();
    for (let index = 0; index < merged.etapas.length; index++) {
        const etapa = merged.etapas[index];
        if (ordens.has(etapa.ordem)) return { error: `A etapa ${etapa.ordem} aparece mais de uma vez.`, field: `etapas[${index}].ordem` };
        ordens.add(etapa.ordem);
    }
    const ordered = [...ordens].sort((a, b) => a - b);
    if (ordered.some((ordem, index) => ordem !== index + 1)) return { error: 'Numere as etapas em sequência, a partir de 1.', field: 'etapas' };
    if (Array.isArray(merged.mencoes)) {
        const siglas = new Set();
        const mins = new Set();
        for (let index = 0; index < merged.mencoes.length; index++) {
            const item = merged.mencoes[index];
            const sigla = text(item.sigla).toLocaleUpperCase('pt-BR');
            if (siglas.has(sigla)) return { error: `A menção ${item.sigla} aparece mais de uma vez.`, field: `mencoes[${index}].sigla` };
            const min = Math.round(Number(item.min) * 10) / 10;
            if (mins.has(min)) return { error: 'Duas menções com a mesma nota mínima.', field: `mencoes[${index}].min` };
            siglas.add(sigla);
            mins.add(min);
        }
    }
    const normalized = gradingRules.normalizeCriteria({ ...merged, ativo: true });
    return { criterios: { ...normalized, ativo: merged.ativo !== false } };
}

function stripUndefined(value) {
    const out = {};
    Object.entries(value || {}).forEach(([key, item]) => { if (item !== undefined) out[key] = item; });
    return out;
}

function stripEmpty(value) {
    const out = {};
    Object.entries(value).forEach(([key, item]) => { if (item !== '' && item !== undefined && item !== null) out[key] = item; });
    return out;
}

// --- plano ---------------------------------------------------------------------------------

function rawPlan(cls) {
    return isPlainObject(cls.avaliacao) ? cls.avaliacao : null;
}

// Grava o plano da turma (itens e avaliações manuais) e a auditoria, numa gravação parcial.
function saveClassPlan(cls, nextPlan) {
    cls.avaliacao = nextPlan;
    return db.save({ only: ['classes', 'auditLogs'] });
}

// Cópia gravável do plano da turma: o que está gravado (campos desconhecidos ficam), com
// itens e manuais sempre presentes.
function writablePlan(cls) {
    const raw = rawPlan(cls) || {};
    return {
        ...raw,
        itens: isPlainObject(raw.itens) ? { ...raw.itens } : {},
        manuais: Array.isArray(raw.manuais) ? raw.manuais.slice() : [],
    };
}

function etapaOrdens(course) {
    const raw = course && course.avaliacao;
    if (!isPlainObject(raw)) return new Set(CRITERIOS_PADRAO.etapas.map(etapa => etapa.ordem));
    return new Set(criteriaView(raw).etapas.map(etapa => etapa.ordem));
}

// Item do plano depois da mudança pedida (campos que não vieram ficam como estavam).
function mergedPlanItem(current, change) {
    const base = gradingRules.normalizePlan({ itens: { x: current || {} } }).itens.x;
    const next = { ...base };
    if (change.etapa !== undefined) next.etapa = change.etapa === null ? null : change.etapa;
    if (change.peso !== undefined) next.peso = change.peso;
    if (change.recuperacaoDe !== undefined) next.recuperacaoDe = change.recuperacaoDe || null;
    if (change.fora !== undefined) next.fora = change.fora === true;
    return gradingRules.normalizePlan({ itens: { x: next } }).itens.x;
}

function samePlanItem(a, b) {
    return a.etapa === b.etapa && a.peso === b.peso && (a.recuperacaoDe || null) === (b.recuperacaoDe || null) && a.fora === b.fora;
}

function validatePlanItem(id, item, ordens, { hasCriteria }) {
    if (!hasCriteria) return null;
    if (item.etapa !== null && item.etapa !== undefined && !ordens.has(item.etapa)) {
        return { error: `A etapa ${item.etapa} não existe nos critérios do curso.`, field: `itens.${id}.etapa` };
    }
    const match = /^etapa:(\d)$/.exec(item.recuperacaoDe || '');
    if (match && !ordens.has(Number(match[1]))) {
        return { error: `A etapa ${match[1]} não existe nos critérios do curso.`, field: `itens.${id}.recuperacaoDe` };
    }
    return null;
}

function moduleList(structure) {
    return (Array.isArray(structure) ? structure : [])
        .map((module, index) => (module && typeof module === 'object'
            ? { id: structureModuleId(module, index), nome: module.name || module.title || module.id || `Módulo ${index + 1}` }
            : null))
        .filter(Boolean);
}

function manualView(manual, counts) {
    const count = counts.get(manual.id) || { lancadas: 0, publicadas: 0 };
    return {
        id: manual.id,
        titulo: manual.titulo,
        tipo: manual.tipo,
        tipoRotulo: MANUAL_TYPE_LABELS[manual.tipo] || MANUAL_TYPE_LABELS.outro,
        descricao: manual.descricao,
        data: manual.data,
        moduloId: manual.moduloId,
        arquivado: !!manual.arquivadoEm,
        arquivadoEm: manual.arquivadoEm || null,
        criadoEm: manual.criadoEm || null,
        criadoPor: manual.criadoPor || null,
        notasLancadas: count.lancadas,
        notasPublicadas: count.publicadas,
    };
}

function planView(account, { course, cls, structure }) {
    const grading = gradingFor(course, cls, structure);
    const counts = gradeCountsByItem(grading, classSubmissions(grading.courseId, grading.studentClass));
    const criterios = grading.criterios;
    const etapaNome = new Map(((criterios && criterios.etapas) || []).map(etapa => [etapa.ordem, etapa.nome]));
    const itens = grading.itens.map(item => {
        const plan = planItemView(grading, item.id);
        const count = counts.get(item.id) || { lancadas: 0, publicadas: 0 };
        return {
            id: item.id,
            titulo: item.titulo,
            origem: item.origem,
            tipo: item.tipo || null,
            tipoRotulo: item.tipoRotulo || null,
            moduloId: item.moduloId || null,
            modulo: item.moduloNome || null,
            disciplinaId: item.disciplinaId,
            disciplina: item.disciplinaNome,
            arquivado: item.arquivado === true,
            etapa: plan.etapa,
            etapaEfetiva: plan.etapaEfetiva,
            etapaNome: plan.etapaEfetiva ? (etapaNome.get(plan.etapaEfetiva) || null) : null,
            peso: plan.peso,
            recuperacaoDe: plan.recuperacaoDe,
            fora: plan.fora,
            notasLancadas: count.lancadas,
            notasPublicadas: count.publicadas,
        };
    });
    const etapas = criteriaView(course.avaliacao).etapas;
    return {
        courseId: grading.courseId,
        studentClass: grading.studentClass,
        ativo: grading.ativo,
        criterio: grading.criterio,
        etapas: etapas.map(etapa => ({ ordem: etapa.ordem, nome: etapa.nome, peso: etapa.peso })),
        itens,
        manuais: grading.plano.manuais.map(manual => manualView(manual, counts)),
        modulos: moduleList(structure),
        tipos: MANUAL_TIPOS.map(value => ({ value, label: MANUAL_TYPE_LABELS[value] })),
        avisos: planWarnings(grading).map(entry => entry.texto),
        encerrada: academicCalendar.isClassClosed(cls),
        podeAlterar: canWrite(account, 'page.results') && !academicCalendar.isClassClosed(cls),
    };
}

// --- prévia --------------------------------------------------------------------------------

function classGradebookFor(account, course, cls, structure) {
    const courseId = String(course.id);
    const submissions = scopeSubmissionsToContext(filterSubmissionsForAdmin(db.memory.submissions || [], account), contextScope(courseId, cls.name));
    const students = filterStudentsForAdmin(db.memory.students || [], account).filter(student => studentInClass(student, cls));
    const grading = gradingFor(course, cls, structure);
    return buildClassGradebook({
        students,
        submissions,
        structure,
        evaluations: db.memory.evaluations || {},
        applications: db.memory.examApplications || [],
        grading,
    });
}

function studentInClass(student, cls) {
    const raw = student && Array.isArray(student.classes) && student.classes.length ? student.classes : (student && student.studentClass ? [student.studentClass] : []);
    const fallback = String((student && (student.courseId || student.currentCourseId)) || '').trim();
    return raw.some(entry => {
        const name = String(typeof entry === 'string' ? entry : (entry && (entry.name || entry.className)) || '').trim();
        if (name !== cls.name) return false;
        const entryCourse = String((typeof entry === 'object' && entry ? entry.courseId : '') || fallback).trim();
        return !cls.courseId || !entryCourse || entryCourse === String(cls.courseId);
    });
}

function rowSituation(row) {
    return { media: row.mediaFinal !== undefined ? row.mediaFinal : row.average, situacao: row.situacao || null, situacaoRotulo: row.situacaoRotulo || null };
}

// Quadro da turma com a regra de agora e com a proposta (critérios e plano trocados só na
// memória deste pedido), e quem muda.
function previewClass(account, course, cls, { criterios, plano }) {
    const structure = structureFor(course, cls);
    const atual = classGradebookFor(account, course, cls, structure);
    const proposedCourse = criterios ? { ...course, avaliacao: criterios } : course;
    let proposedClass = cls;
    if (plano && isPlainObject(plano.itens)) {
        const plan = writablePlan(cls);
        Object.entries(plano.itens).forEach(([id, change]) => { plan.itens[id] = mergedPlanItem(plan.itens[id], change || {}); });
        proposedClass = { ...cls, avaliacao: plan };
    }
    const proposto = classGradebookFor(account, proposedCourse, proposedClass, structure);
    const before = new Map(atual.rows.map(row => [row.email, rowSituation(row)]));
    const mudancas = [];
    proposto.rows.forEach(row => {
        const antes = before.get(row.email) || { media: null, situacao: null, situacaoRotulo: null };
        const depois = rowSituation(row);
        if (antes.media === depois.media && antes.situacao === depois.situacao) return;
        mudancas.push({
            studentClass: cls.name,
            email: row.email,
            nome: row.name,
            mediaAntes: antes.media,
            mediaDepois: depois.media,
            situacaoAntes: antes.situacao,
            situacaoAntesRotulo: antes.situacaoRotulo,
            situacaoDepois: depois.situacao,
            situacaoDepoisRotulo: depois.situacaoRotulo,
        });
    });
    return { atual, proposto, mudancas };
}

function countSituations(rows, out) {
    rows.forEach(row => {
        const key = row.situacao || 'regra_antiga';
        out[key] = (out[key] || 0) + 1;
    });
    return out;
}

function previewSentence(mudancas) {
    const bySituation = mudancas.filter(item => item.situacaoAntes !== item.situacaoDepois).length;
    const byAverage = mudancas.filter(item => item.mediaAntes !== item.mediaDepois).length;
    if (!mudancas.length) return 'Com esta regra, nenhum aluno muda de média ou de situação.';
    const parts = [];
    const alunos = count => (count === 1 ? '1 aluno muda' : `${count} alunos mudam`);
    if (bySituation) parts.push(`${alunos(bySituation)} de situação`);
    if (byAverage) parts.push(`${alunos(byAverage)} de média`);
    return `Com esta regra, ${parts.join(' e ')}.`;
}

// Lê e confere os campos da avaliação manual (criar e alterar). Devolve { fields } ou
// { error, field }.
function readManualFields(input, { structure, course }) {
    const fields = {};
    if (input.titulo !== undefined) {
        if (!text(input.titulo)) return { error: 'Informe o título da avaliação.', field: 'titulo' };
        fields.titulo = text(input.titulo).replace(/\s+/g, ' ');
    }
    if (input.tipo !== undefined && input.tipo !== '') fields.tipo = input.tipo;
    if (input.descricao !== undefined) fields.descricao = text(input.descricao).replace(/\s+/g, ' ');
    if (input.data !== undefined) {
        if (input.data && !academicCalendar.isValidDate(input.data)) return { error: 'Data inválida.', field: 'data' };
        fields.data = input.data || null;
    }
    if (input.moduloId !== undefined) {
        const moduloId = text(input.moduloId);
        if (moduloId && !moduleList(structure).some(module => module.id === moduloId)) {
            return { error: 'Módulo não encontrado no curso.', field: 'moduloId' };
        }
        fields.moduloId = moduloId || null;
    }
    const planChange = {};
    if (input.etapa !== undefined) planChange.etapa = input.etapa;
    if (input.peso !== undefined) planChange.peso = input.peso;
    if (planChange.etapa !== undefined && planChange.etapa !== null && isPlainObject(course.avaliacao) && !etapaOrdens(course).has(planChange.etapa)) {
        return { error: `A etapa ${planChange.etapa} não existe nos critérios do curso.`, field: 'etapa' };
    }
    return { fields, planChange };
}

function findRawManual(plan, id) {
    return plan.manuais.findIndex(item => isPlainObject(item) && String(item.id || '').trim() === id);
}

// Arquivar e reativar a avaliação manual: confere o pedido (escopo, item, motivo) antes do
// portão da turma encerrada. Devolve o contexto, ou null depois de responder.
function prepareManualToggle(req, res, account, archive) {
    if (!SCHEMAS.manualArchive.check(req, res)) return null;
    const found = resolveClass(account, req.body.courseId, req.body.studentClass);
    if (found.error) { res.status(found.status).json({ success: false, error: found.error }); return null; }
    const { course, cls, structure } = found;
    const id = text(req.body.id);
    const plan = writablePlan(cls);
    const index = findRawManual(plan, id);
    if (index === -1) { res.status(404).json({ success: false, error: 'Avaliação manual não encontrada nesta turma.' }); return null; }
    const current = plan.manuais[index];
    if (!!current.arquivadoEm === archive) {
        const view = planView(account, found);
        res.json({ success: true, semMudanca: true, item: view.manuais.find(item => item.id === id), plano: view });
        return null;
    }
    const grading = gradingFor(course, cls, structure);
    const count = gradeCountsByItem(grading, classSubmissions(grading.courseId, grading.studentClass)).get(id) || { lancadas: 0, publicadas: 0 };
    const reason = text(req.body.reason);
    // Arquivar tira a nota publicada da média e reativar a põe de volta: as duas pedem motivo.
    if (count.publicadas > 0 && reason.length < REASON_MIN) {
        reasonRequired(res, archive
            ? 'Informe o motivo (de 3 a 500 caracteres): a avaliação tem nota publicada, que sai da média do aluno.'
            : 'Informe o motivo (de 3 a 500 caracteres): a avaliação tem nota publicada, que volta para a média do aluno.');
        return null;
    }
    return { found, course, cls, structure, id, plan, index, current, count, reason, archive };
}

function applyManualToggle(req, res, account, prep) {
    const { found, course, cls, id, plan, index, current, count, reason, archive } = prep;
    const now = Date.now();
    const next = { ...current };
    if (archive) {
        next.arquivadoEm = now;
        next.arquivadoPor = actorEmail(account);
    } else {
        delete next.arquivadoEm;
        delete next.arquivadoPor;
        next.reativadoEm = now;
        next.reativadoPor = actorEmail(account);
    }
    plan.manuais[index] = next;
    const titulo = (gradingRules.normalizePlan({ manuais: [current] }).manuais[0] || {}).titulo || id;
    recordAudit(db.memory, {
        req,
        actor: account,
        action: archive ? 'manual_assessment_archived' : 'manual_assessment_restored',
        category: 'academic',
        courseId: String(course.id),
        studentClass: cls.name,
        details: { id, titulo, notas: count.lancadas, notasPublicadas: count.publicadas },
        ...(reason ? { reason } : {}),
    });
    saveClassPlan(cls, plan);
    const view = planView(account, found);
    res.json({ success: true, item: view.manuais.find(item => item.id === id), plano: view });
}

// --- rotas ---------------------------------------------------------------------------------

function registerGradingRoutes(router) {
    router.get('/api/admin/grading/criteria', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const found = resolveCourse(account, req.query.courseId);
            if (found.error) return res.status(found.status).json({ error: found.error });
            const { course } = found;
            const raw = course.avaliacao;
            const criterios = criteriaView(raw);
            res.json({
                courseId: String(course.id),
                courseName: course.name || String(course.id),
                ativo: criterios.ativo,
                regraAntiga: !criterios.ativo,
                criterios,
                padrao: criteriaView(null),
                regrasRecuperacao: RECUPERACAO_REGRAS.map(value => ({ value, label: RECUPERACAO_ROTULOS[value] })),
                unidades: UNIDADES_SITUACAO.map(value => ({ value, label: UNIDADE_ROTULOS[value] })),
                limites: { etapasMax: LIMITES.etapasMax, mencoesMax: LIMITES.mencoesMax, pesoMin: LIMITES.pesoMin, pesoMax: LIMITES.pesoMax },
                temNotaPublicada: coursePublishedGrades(course),
                podeAlterar: canWrite(account, 'course.manage') && adminCanAccessCourse(account, String(course.id)),
            });
        });
    });

    router.post('/api/admin/grading/criteria', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            if (isPlainObject(req.body)) fixCommaNumbers(req.body);
            if (!SCHEMAS.criteria.check(req, res)) return;
            const found = resolveCourse(account, req.body.courseId);
            if (found.error) return res.status(found.status).json({ success: false, error: found.error });
            const { course } = found;
            const parsed = readCriteriaInput(req.body, course.avaliacao);
            if (parsed.error) return fieldError(res, parsed.error, parsed.field);
            const before = comparableCriteria(course.avaliacao);
            const nextView = { ...parsed.criterios };
            const unchanged = before ? JSON.stringify(before) === JSON.stringify(nextView) : nextView.ativo === false;
            if (unchanged) return res.json({ success: true, semMudanca: true, criterios: criteriaView(course.avaliacao) });
            const mudaNota = (before && before.ativo) || nextView.ativo;
            const reason = text(req.body.reason);
            if (mudaNota && coursePublishedGrades(course) && reason.length < REASON_MIN) {
                return reasonRequired(res, 'Informe o motivo (de 3 a 500 caracteres): o curso já tem nota publicada e a regra muda a média dos alunos.');
            }
            const now = Date.now();
            const record = { ...nextView, atualizadoEm: now, atualizadoPor: actorEmail(account) };
            course.avaliacao = record;
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'grading_criteria_updated',
                category: 'academic',
                courseId: String(course.id),
                before,
                after: nextView,
                ...(reason ? { reason } : {}),
            });
            db.save({ only: ['courses', 'auditLogs'] });
            res.json({ success: true, criterios: criteriaView(record) });
        });
    });

    router.post('/api/admin/grading/preview', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            if (isPlainObject(req.body)) {
                fixCommaNumbers(req.body.criterios);
                if (isPlainObject(req.body.plano)) fixPlanCommaNumbers(req.body.plano.itens);
            }
            if (!SCHEMAS.preview.check(req, res)) return;
            const found = resolveCourse(account, req.body.courseId);
            if (found.error) return res.status(found.status).json({ success: false, error: found.error });
            const { course } = found;
            let criterios = null;
            if (req.body.criterios) {
                // A prévia é de critérios ligados, a não ser que o pedido diga ativo: false.
                const parsed = readCriteriaInput({ ativo: true, ...stripUndefined(req.body.criterios) }, course.avaliacao);
                if (parsed.error) return fieldError(res, parsed.error, `criterios.${parsed.field}`);
                criterios = parsed.criterios;
            }
            const plano = req.body.plano || null;
            const studentClass = text(req.body.studentClass);
            let classes;
            if (studentClass) {
                const resolved = resolveClass(account, course.id, studentClass);
                if (resolved.error) return res.status(resolved.status).json({ success: false, error: resolved.error });
                classes = [resolved.cls];
            } else {
                if (plano) return fieldError(res, 'Escolha a turma para ver a prévia do plano.', 'studentClass');
                classes = courseClasses(course.id).filter(cls => adminCanAccessClass(account, cls.name, String(course.id)));
            }
            const mudancas = [];
            const contagemAtual = {};
            const contagemProposta = {};
            let quadro = null;
            classes.forEach(cls => {
                const result = previewClass(account, course, cls, { criterios, plano });
                mudancas.push(...result.mudancas);
                countSituations(result.atual.rows, contagemAtual);
                countSituations(result.proposto.rows, contagemProposta);
                if (studentClass) quadro = result.proposto;
            });
            res.json({
                success: true,
                courseId: String(course.id),
                studentClass: studentClass || null,
                turmas: classes.map(cls => cls.name),
                criterio: gradingRules.criterioForScreen(criterios || course.avaliacao),
                mudancas,
                contagemAtual,
                contagemProposta,
                resumo: previewSentence(mudancas),
                quadro,
            });
        });
    });

    router.get('/api/admin/grading/plan', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const found = resolveClass(account, req.query.courseId, req.query.studentClass);
            if (found.error) return res.status(found.status).json({ error: found.error });
            res.json(planView(account, found));
        });
    });

    router.post('/api/admin/grading/plan', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            if (isPlainObject(req.body)) fixPlanCommaNumbers(req.body.itens);
            if (!SCHEMAS.plan.check(req, res)) return;
            const found = resolveClass(account, req.body.courseId, req.body.studentClass);
            if (found.error) return res.status(found.status).json({ success: false, error: found.error });
            const { course, cls, structure } = found;
            const grading = gradingFor(course, cls, structure);
            const ordens = etapaOrdens(course);
            const hasCriteria = isPlainObject(course.avaliacao);
            const plan = writablePlan(cls);
            const before = {};
            const after = {};
            const ignorados = [];
            for (const [id, change] of Object.entries(req.body.itens)) {
                if (!grading.itemById.has(id)) { ignorados.push(id); continue; }
                // O de agora é o plano efetivo (item de provedor sem linha nasce "fora da média").
                const stored = hasOwn(plan.itens, id) ? plan.itens[id] : grading.planoEfetivo.itens[id];
                const current = gradingRules.normalizePlan({ itens: { x: stored || {} } }).itens.x;
                const next = mergedPlanItem(stored, change);
                const problem = validatePlanItem(id, next, ordens, { hasCriteria });
                if (problem) return fieldError(res, problem.error, problem.field);
                if (samePlanItem(current, next)) continue;
                before[id] = current;
                after[id] = next;
                plan.itens[id] = next;
            }
            const changed = Object.keys(after);
            if (!changed.length) return res.json({ success: true, semMudanca: true, ignorados, plano: planView(account, found) });
            if (!academicCalendar.assertClassOpen(cls, { res })) return;
            const reason = text(req.body.reason);
            if (grading.ativo && reason.length < REASON_MIN) {
                const counts = gradeCountsByItem(grading, classSubmissions(grading.courseId, grading.studentClass));
                if (changed.some(id => (counts.get(id) || {}).publicadas > 0)) {
                    return reasonRequired(res, 'Informe o motivo (de 3 a 500 caracteres): a mudança altera a média de nota já publicada.');
                }
            }
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'grading_plan_updated',
                category: 'academic',
                courseId: grading.courseId,
                studentClass: grading.studentClass,
                before,
                after,
                ...(reason ? { reason } : {}),
            });
            saveClassPlan(cls, plan);
            res.json({ success: true, alterados: changed, ignorados, plano: planView(account, found) });
        });
    });

    router.post('/api/admin/grading/manual-items/create', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            if (isPlainObject(req.body)) req.body.peso = commaToDot(req.body.peso);
            if (!SCHEMAS.manualCreate.check(req, res)) return;
            const found = resolveClass(account, req.body.courseId, req.body.studentClass);
            if (found.error) return res.status(found.status).json({ success: false, error: found.error });
            const { course, cls, structure } = found;
            const parsed = readManualFields(req.body, found);
            if (parsed.error) return fieldError(res, parsed.error, parsed.field);
            const plan = writablePlan(cls);
            if (gradingRules.normalizePlan(plan).manuais.length >= LIMITES.manuaisMax) {
                return fieldError(res, `A turma já tem ${LIMITES.manuaisMax} avaliações manuais. Arquive ou reaproveite uma delas.`, null);
            }
            if (!academicCalendar.assertClassOpen(cls, { res })) return;
            const now = Date.now();
            const record = {
                id: newManualId(),
                titulo: parsed.fields.titulo,
                tipo: parsed.fields.tipo || 'outro',
                descricao: parsed.fields.descricao || '',
                data: parsed.fields.data || null,
                moduloId: parsed.fields.moduloId || null,
                criadoEm: now,
                criadoPor: actorEmail(account),
            };
            plan.manuais.push(record);
            if (Object.keys(parsed.planChange).length) plan.itens[record.id] = mergedPlanItem(null, parsed.planChange);
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'manual_assessment_created',
                category: 'academic',
                courseId: String(course.id),
                studentClass: cls.name,
                after: { ...record, ...(plan.itens[record.id] ? { plano: plan.itens[record.id] } : {}) },
            });
            saveClassPlan(cls, plan);
            const view = planView(account, { course, cls, structure });
            res.json({ success: true, item: view.manuais.find(item => item.id === record.id), plano: view });
        });
    });

    router.post('/api/admin/grading/manual-items/update', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            if (isPlainObject(req.body)) req.body.peso = commaToDot(req.body.peso);
            if (!SCHEMAS.manualUpdate.check(req, res)) return;
            const found = resolveClass(account, req.body.courseId, req.body.studentClass);
            if (found.error) return res.status(found.status).json({ success: false, error: found.error });
            const { course, cls, structure } = found;
            const id = text(req.body.id);
            const plan = writablePlan(cls);
            const index = findRawManual(plan, id);
            if (index === -1) return res.status(404).json({ success: false, error: 'Avaliação manual não encontrada nesta turma.' });
            const parsed = readManualFields(req.body, found);
            if (parsed.error) return fieldError(res, parsed.error, parsed.field);
            const beforeItem = gradingRules.normalizePlan({ manuais: [plan.manuais[index]] }).manuais[0];
            const nextRaw = { ...plan.manuais[index], ...parsed.fields };
            const afterItem = gradingRules.normalizePlan({ manuais: [nextRaw] }).manuais[0];
            const currentPlanItem = gradingRules.normalizePlan({ itens: { x: plan.itens[id] || {} } }).itens.x;
            const nextPlanItem = Object.keys(parsed.planChange).length ? mergedPlanItem(plan.itens[id], parsed.planChange) : currentPlanItem;
            const sameText = ['titulo', 'tipo', 'descricao', 'data', 'moduloId'].every(field => beforeItem[field] === afterItem[field]);
            const samePlan = samePlanItem(currentPlanItem, nextPlanItem);
            if (sameText && samePlan) return res.json({ success: true, semMudanca: true, item: manualView(beforeItem, new Map()) });
            if (!academicCalendar.assertClassOpen(cls, { res })) return;
            // Mesma regra do POST /grading/plan: com nota publicada, mudar etapa ou peso (com
            // critérios ligados) ou o módulo (média do módulo e situação da disciplina) muda a
            // média que o aluno já viu, e pede motivo.
            const reason = text(req.body.reason);
            const grading = gradingFor(course, cls, structure);
            const mudaMedia = (!samePlan && grading.ativo) || beforeItem.moduloId !== afterItem.moduloId;
            if (mudaMedia && reason.length < REASON_MIN) {
                const count = gradeCountsByItem(grading, classSubmissions(grading.courseId, grading.studentClass)).get(id) || { publicadas: 0 };
                if (count.publicadas > 0) {
                    return reasonRequired(res, 'Informe o motivo (de 3 a 500 caracteres): a mudança altera a média de nota já publicada.');
                }
            }
            const now = Date.now();
            plan.manuais[index] = { ...nextRaw, atualizadoEm: now, atualizadoPor: actorEmail(account) };
            if (!samePlan) plan.itens[id] = nextPlanItem;
            const pick = item => ({ titulo: item.titulo, tipo: item.tipo, descricao: item.descricao, data: item.data, moduloId: item.moduloId });
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'manual_assessment_updated',
                category: 'academic',
                courseId: String(course.id),
                studentClass: cls.name,
                before: { id, ...pick(beforeItem), ...(samePlan ? {} : { plano: currentPlanItem }) },
                after: { id, ...pick(afterItem), ...(samePlan ? {} : { plano: nextPlanItem }) },
                ...(reason ? { reason } : {}),
            });
            saveClassPlan(cls, plan);
            const view = planView(account, { course, cls, structure });
            res.json({ success: true, item: view.manuais.find(item => item.id === id), plano: view });
        });
    });

    router.post('/api/admin/grading/manual-items/archive', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const prep = prepareManualToggle(req, res, account, true);
            if (!prep) return;
            if (!academicCalendar.assertClassOpen(prep.cls, { res })) return;
            applyManualToggle(req, res, account, prep);
        });
    });

    router.post('/api/admin/grading/manual-items/restore', (req, res) => {
        validateAdmin(req, res, (config, account) => {
            const prep = prepareManualToggle(req, res, account, false);
            if (!prep) return;
            if (!academicCalendar.assertClassOpen(prep.cls, { res })) return;
            applyManualToggle(req, res, account, prep);
        });
    });

    return router;
}

module.exports = { registerGradingRoutes, criteriaView };
