// Notas da turma: leitura validada da entrada do professor, consolidação única
// (a mesma regra da tela Resultados) para boletim e planilha, CSV no padrão do
// Excel brasileiro e auditoria das alterações de nota.
//
// Escala: o banco guarda `score` de 0 a 100 (como a correção online); as telas,
// o boletim e as planilhas mostram 0 a 10 com uma casa decimal.
const crypto = require('crypto');
const {
    SCORE_MAX,
    consolidateSubmissions,
    normalizeScore,
} = require('./submissionAttempts.js');
const { getClientIp } = require('./students.js');

const GRADE_MAX = SCORE_MAX / 10;
const MANUAL_TYPES = ['impressa', 'manual', 'online'];
const CSV_BOM = '﻿';
const OTHER_MODULE_ID = '__outras__';

function isEmptyInput(value) {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

// Nota digitada pelo professor (0 a 10). Aceita número ou texto com vírgula ou
// ponto decimal ("8,5", "8.5"). Vazio devolve { empty: true }.
function parseGradeInput(value) {
    if (isEmptyInput(value)) return { empty: true };
    let number = NaN;
    if (typeof value === 'number') number = value;
    else if (typeof value === 'string' && /^\d{1,2}(?:[.,]\d{1,2})?$/.test(value.trim())) number = Number(value.trim().replace(',', '.'));
    if (!Number.isFinite(number) || number < 0 || number > GRADE_MAX) {
        return { error: `A nota deve ser um número de 0 a ${GRADE_MAX} (use vírgula para decimais, ex.: 8,5).` };
    }
    return { value: number };
}

// Contagem inteira não negativa (acertos/total). Aceita número ou texto só com dígitos.
function parseCountInput(value) {
    if (isEmptyInput(value)) return { empty: true };
    let number = NaN;
    if (typeof value === 'number') number = value;
    else if (typeof value === 'string' && /^\d{1,4}$/.test(value.trim())) number = Number(value.trim());
    if (!Number.isInteger(number) || number < 0) return { error: true };
    return { value: number };
}

function scoreFromCounts(correctCount, totalCount) {
    return Math.round((correctCount / totalCount) * SCORE_MAX);
}

// 0-100 -> 0-10 (null quando a nota é inválida ou não existe).
function gradeFromScore(score) {
    const normalized = normalizeScore(score);
    return normalized === null ? null : Math.round(normalized) / 10;
}

// Nota para texto em pt-BR ("8,5"). Vazio quando não há nota válida.
function formatGradeBR(score) {
    const normalized = normalizeScore(score);
    if (normalized === null) return '';
    return (normalized / 10).toFixed(1).replace('.', ',');
}

function average(values) {
    const valid = values.filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)));
    return valid.length ? valid.reduce((sum, value) => sum + Number(value), 0) / valid.length : null;
}

function pad2(value) { return String(value).padStart(2, '0'); }
function formatDateBR(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}
function formatDateTimeBR(value) {
    const day = formatDateBR(value);
    if (!day) return '';
    const date = new Date(value);
    return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// ---------------------------------------------------------------- CSV
// Neutraliza CSV/formula injection (nome e e-mail são controlados pelo aluno)
// e protege separador, aspas e quebras de linha.
function csvSafe(value) {
    let text = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    if (/[";\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
    return text;
}

function csvRow(values) {
    return values.map(csvSafe).join(';');
}

// Excel em pt-BR: separador ";", BOM UTF-8 para acentos e CRLF.
function buildCsv(rows) {
    return CSV_BOM + rows.map(csvRow).join('\r\n') + '\r\n';
}

function safeFilePart(value) {
    return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'turma';
}

// ------------------------------------------------- escopo curso/turma
function submissionCourseId(submission) {
    return String(submission?.courseId || submission?.student?.courseId || '').trim();
}

function submissionClassName(submission) {
    return String(submission?.studentClass || submission?.student?.studentClass || '').trim();
}

// A entrega pertence ao curso/turma do contexto? Registros antigos sem curso ou
// sem turma são aceitos quando o outro campo confere (nunca os dois vazios).
function submissionMatchesContext(submission, { courseId = '', studentClass = '' } = {}) {
    const expectedCourse = String(courseId || '').trim();
    const expectedClass = String(studentClass || '').trim();
    if (!expectedCourse && !expectedClass) return true;
    const rowCourse = submissionCourseId(submission);
    const rowClass = submissionClassName(submission);
    const courseOk = !expectedCourse || !rowCourse || rowCourse === expectedCourse;
    const classOk = !expectedClass || !rowClass || rowClass === expectedClass;
    const anchored = (expectedCourse && rowCourse === expectedCourse) || (expectedClass && rowClass === expectedClass);
    return courseOk && classOk && !!anchored;
}

// Filtra pelo contexto e completa curso/turma ausentes (cópias, o banco não muda),
// para que registros antigos caiam no mesmo grupo de tentativas dos atuais.
function scopeSubmissionsToContext(submissions, context = {}) {
    const courseId = String(context.courseId || '').trim();
    const studentClass = String(context.studentClass || '').trim();
    return (submissions || []).filter(item => submissionMatchesContext(item, { courseId, studentClass })).map(item => {
        const student = item.student || {};
        if ((student.courseId || !courseId) && (student.studentClass || !studentClass)) return item;
        return {
            ...item,
            student: {
                ...student,
                courseId: student.courseId || item.courseId || courseId || null,
                studentClass: student.studentClass || item.studentClass || studentClass || '',
            },
        };
    });
}

// --------------------------------------------------- consolidação
function structureExamIndex(structure) {
    const index = new Map();
    (structure || []).forEach((module, moduleIndex) => {
        const moduleId = String(module.id || module.key || module.name || module.title || `module_${moduleIndex}`);
        const moduleName = module.name || module.title || module.id || `Módulo ${moduleIndex + 1}`;
        (module.units || module.items || []).forEach((unit, unitIndex) => {
            if (!unit || !unit.avaliacaoKey || index.has(unit.avaliacaoKey)) return;
            index.set(unit.avaliacaoKey, { moduleId, moduleName, moduleIndex, unitIndex, unitName: unit.name || unit.title || '' });
        });
    });
    return index;
}

function examTitle(examKey, { evaluations = {}, examIndex = null } = {}) {
    const evaluation = evaluations && evaluations[examKey];
    return (evaluation && (evaluation.title || evaluation.name))
        || (examIndex && examIndex.get(examKey)?.unitName)
        || examKey;
}

function groupScopeId(group) {
    const first = group.attempts[0] || {};
    return first.applicationId ? `application:${first.applicationId}` : 'legacy';
}

// Posição (1, 2, ...) da aplicação entre as aplicações da mesma prova na mesma
// turma, pela ordem de criação. Assim duas aplicações no mesmo dia não ficam com
// rótulos iguais, e o número é o mesmo no boletim, no quadro e nas planilhas.
function applicationOrdinal(application, applicationsById) {
    if (!application || !applicationsById) return null;
    const sameExam = [...applicationsById.values()]
        .filter(item => item && item.examKey === application.examKey
            && String(item.studentClass || '') === String(application.studentClass || '')
            && String(item.courseId || '') === String(application.courseId || ''))
        .sort((a, b) => (Date.parse(a.createdAt || a.startedAt) || 0) - (Date.parse(b.createdAt || b.startedAt) || 0)
            || String(a.id).localeCompare(String(b.id)));
    const index = sameExam.findIndex(item => String(item.id) === String(application.id));
    return index >= 0 ? index + 1 : null;
}

// Rótulo de uma aplicação para quando a mesma prova teve mais de uma.
function scopeLabel(group, applicationsById) {
    const first = group.attempts[0] || {};
    if (first.applicationId) {
        const application = applicationsById && applicationsById.get(String(first.applicationId));
        const when = formatDateBR(application?.startedAt || application?.createdAt || first.timestamp);
        const ordinal = applicationOrdinal(application, applicationsById);
        if (ordinal) return when ? `${ordinal}ª aplicação, ${when}` : `${ordinal}ª aplicação`;
        return when ? `aplicação de ${when}` : 'aplicação sem data';
    }
    const manual = group.attempts.every(item => ['impressa', 'manual'].includes(String(item.type || '')));
    return manual ? 'lançamento manual' : 'registro sem aplicação';
}

// Grupos de tentativas (aluno + curso + turma + aplicação) com a nota consolidada
// pela regra escolhida pelo professor. É exatamente o cálculo da tela Resultados.
function buildGradeGroups(submissions) {
    return consolidateSubmissions(submissions).map(group => {
        const first = group.attempts[0] || {};
        const times = group.attempts.map(item => Date.parse(item.timestamp) || 0).filter(Boolean).sort((a, b) => a - b);
        return {
            ...group,
            examKey: first.examKey || '',
            applicationId: first.applicationId || null,
            email: String(first.student?.email || first.studentEmail || '').trim().toLowerCase(),
            scopeId: groupScopeId(group),
            firstAt: times[0] || null,
            lastAt: times[times.length - 1] || null,
            pendingCount: group.attempts.filter(item => item.gradePublished !== true).length,
        };
    });
}

function compareGroups(examIndex) {
    return (a, b) => {
        const metaA = examIndex.get(a.examKey);
        const metaB = examIndex.get(b.examKey);
        const orderA = metaA ? [metaA.moduleIndex, metaA.unitIndex] : [Infinity, 0];
        const orderB = metaB ? [metaB.moduleIndex, metaB.unitIndex] : [Infinity, 0];
        return orderA[0] - orderB[0] || orderA[1] - orderB[1]
            || String(a.examKey).localeCompare(String(b.examKey), 'pt-BR')
            || (a.firstAt || 0) - (b.firstAt || 0);
    };
}

// Boletim de um aluno: uma linha por prova; quando a mesma prova tem mais de
// uma aplicação, uma linha por aplicação (é assim que entram na média em Resultados).
// Médias = média simples das notas consolidadas de cada aplicação, sem arredondar antes.
function buildStudentReportModules({ submissions, allSubmissions = submissions, structure, evaluations = {}, applications = [] }) {
    const examIndex = structureExamIndex(structure);
    const applicationsById = new Map((applications || []).map(item => [String(item.id), item]));
    const groups = buildGradeGroups(submissions).filter(group => group.score !== null).sort(compareGroups(examIndex));
    const scopesByExam = new Map();
    groups.forEach(group => {
        if (!scopesByExam.has(group.examKey)) scopesByExam.set(group.examKey, new Set());
        scopesByExam.get(group.examKey).add(group.scopeId);
    });

    const modules = (structure || []).map((module, moduleIndex) => ({
        id: String(module.id || module.key || module.name || module.title || `module_${moduleIndex}`),
        name: module.name || module.title || module.id || `Módulo ${moduleIndex + 1}`,
        exams: [],
        scores: [],
    }));
    const moduleById = new Map(modules.map(module => [module.id, module]));
    const otherModule = { id: OTHER_MODULE_ID, name: 'Outras avaliações', exams: [], scores: [] };

    const pendingFor = (examKey, scopeId = null) => (allSubmissions || []).filter(item => item.examKey === examKey
        && item.gradePublished !== true
        && (!scopeId || (item.applicationId ? `application:${item.applicationId}` : 'legacy') === scopeId)).length;

    groups.forEach(group => {
        const meta = examIndex.get(group.examKey);
        const target = (meta && moduleById.get(meta.moduleId)) || otherModule;
        const title = examTitle(group.examKey, { evaluations, examIndex });
        const multiple = (scopesByExam.get(group.examKey)?.size || 0) > 1;
        target.exams.push({
            examKey: group.examKey,
            applicationId: group.applicationId,
            title: multiple ? `${title} (${scopeLabel(group, applicationsById)})` : title,
            attempts: group.attempts.length,
            pendingAttempts: pendingFor(group.examKey, multiple ? group.scopeId : null),
            grade: Math.round(group.score) / 10,
            policy: group.policy,
            lastAt: group.lastAt,
        });
        target.scores.push(group.score);
    });

    // Provas da estrutura ainda sem nota publicada aparecem (com o que falta publicar).
    examIndex.forEach((meta, examKey) => {
        if (scopesByExam.has(examKey)) return;
        const target = moduleById.get(meta.moduleId);
        if (!target) return;
        target.exams.push({
            examKey,
            applicationId: null,
            title: examTitle(examKey, { evaluations, examIndex }),
            attempts: 0,
            pendingAttempts: pendingFor(examKey),
            grade: null,
            policy: null,
            lastAt: null,
        });
    });
    modules.forEach(module => {
        module.exams.sort((a, b) => {
            const metaA = examIndex.get(a.examKey);
            const metaB = examIndex.get(b.examKey);
            return (metaA?.unitIndex ?? 0) - (metaB?.unitIndex ?? 0);
        });
    });

    const all = [...modules, ...(otherModule.exams.length ? [otherModule] : [])];
    const allScores = groups.map(group => group.score);
    const overall = average(allScores);
    return {
        modules: all.map(module => {
            const moduleAverage = average(module.scores);
            return {
                id: module.id,
                name: module.name,
                exams: module.exams,
                average: moduleAverage === null ? null : Math.round(moduleAverage) / 10,
            };
        }),
        overallAverage: overall === null ? null : Math.round(overall) / 10,
        gradedCount: allScores.length,
    };
}

// Planilha da turma: uma linha por aluno, uma coluna por prova (ou por aplicação
// quando a prova foi aplicada mais de uma vez), média igual à de Resultados.
function buildClassGradebook({ students = [], submissions = [], structure = [], evaluations = {}, applications = [] }) {
    const examIndex = structureExamIndex(structure);
    const applicationsById = new Map((applications || []).map(item => [String(item.id), item]));
    const groups = buildGradeGroups(submissions).sort(compareGroups(examIndex));

    const scopesByExam = new Map();
    groups.forEach(group => {
        if (!scopesByExam.has(group.examKey)) scopesByExam.set(group.examKey, new Map());
        const scopes = scopesByExam.get(group.examKey);
        if (!scopes.has(group.scopeId)) scopes.set(group.scopeId, group);
    });

    const columns = [];
    const columnIndex = new Map();
    const addColumn = (examKey, scopeId, sample) => {
        const id = scopeId ? `${examKey}::${scopeId}` : examKey;
        if (columnIndex.has(id)) return;
        const title = examTitle(examKey, { evaluations, examIndex });
        const meta = examIndex.get(examKey);
        columns.push({
            id,
            examKey,
            applicationId: sample?.applicationId || null,
            label: scopeId ? `${title} (${scopeLabel(sample, applicationsById)})` : title,
            moduleName: meta ? meta.moduleName : 'Outras avaliações',
        });
        columnIndex.set(id, columns.length - 1);
    };
    // Ordem: estrutura do curso; provas sem nota também ganham coluna.
    const orderedExamKeys = [...examIndex.keys()];
    [...scopesByExam.keys()].filter(key => !examIndex.has(key)).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(key => orderedExamKeys.push(key));
    orderedExamKeys.forEach(examKey => {
        const scopes = scopesByExam.get(examKey);
        if (!scopes || scopes.size <= 1) return addColumn(examKey, null, scopes ? [...scopes.values()][0] : null);
        [...scopes.entries()]
            .sort((a, b) => (a[1].firstAt || 0) - (b[1].firstAt || 0))
            .forEach(([scopeId, sample]) => addColumn(examKey, scopeId, sample));
    });

    const columnIdFor = (group) => {
        const scopes = scopesByExam.get(group.examKey);
        return scopes && scopes.size > 1 ? `${group.examKey}::${group.scopeId}` : group.examKey;
    };

    const rowsByEmail = new Map();
    const ensureRow = (email, student) => {
        if (!rowsByEmail.has(email)) {
            rowsByEmail.set(email, {
                email,
                name: (student && ((student.nomeSocial && student.nomeSocial.trim()) || student.name)) || email,
                matricula: (student && student.matricula) || '',
                status: (student && student.status) || '',
                cells: {},
                scores: [],
                pendingCount: 0,
            });
        }
        return rowsByEmail.get(email);
    };
    (students || []).forEach(student => {
        const email = String(student.email || '').trim().toLowerCase();
        if (email) ensureRow(email, student);
    });
    const studentByEmail = new Map((students || []).map(student => [String(student.email || '').trim().toLowerCase(), student]));
    groups.forEach(group => {
        if (!group.email) return;
        const sample = group.attempts[0] || {};
        const row = ensureRow(group.email, studentByEmail.get(group.email) || { name: sample.student?.name || sample.studentName, email: group.email });
        row.pendingCount += group.pendingCount;
        if (group.score === null) return;
        const id = columnIdFor(group);
        const existing = row.cells[id];
        // Dois grupos no mesmo campo só acontecem com dados antigos inconsistentes:
        // a célula mostra a média deles e a média geral continua contando os dois.
        row.cells[id] = existing
            ? { score: (existing.score * existing.groups + group.score) / (existing.groups + 1), groups: existing.groups + 1, pending: existing.pending + group.pendingCount }
            : { score: group.score, groups: 1, pending: group.pendingCount };
        row.scores.push(group.score);
    });

    const rows = [...rowsByEmail.values()].map(row => {
        const avg = average(row.scores);
        const cells = {};
        Object.entries(row.cells).forEach(([id, cell]) => {
            cells[id] = { score: cell.score, grade: Math.round(cell.score) / 10, pending: cell.pending };
        });
        return {
            email: row.email,
            name: row.name,
            matricula: row.matricula,
            status: row.status,
            cells,
            average: avg === null ? null : Math.round(avg) / 10,
            averageScore: avg,
            gradedCount: row.scores.length,
            pendingCount: row.pendingCount,
        };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));

    return { columns, rows };
}

function gradebookCsv(gradebook) {
    const header = ['Aluno', 'E-mail', 'Matrícula', ...gradebook.columns.map(column => column.label), 'Média', 'Notas não publicadas'];
    const lines = gradebook.rows.map(row => [
        row.name,
        row.email,
        row.matricula,
        ...gradebook.columns.map(column => {
            const cell = row.cells[column.id];
            return cell ? formatGradeBR(cell.score) : '';
        }),
        row.averageScore === null ? '' : formatGradeBR(row.averageScore),
        row.pendingCount,
    ]);
    return buildCsv([header, ...lines]);
}

// ---------------------------------------------------------- auditoria
// Registro compatível com o painel "Auditoria" da ficha do aluno (field/oldValue/newValue),
// mais os identificadores da entrega para o histórico da nota em Resultados.
function recordGradeAudit(memory, { req, actor, submission, action, field = 'Nota', oldValue = '', newValue = '', details = null }) {
    if (!memory) return null;
    if (!Array.isArray(memory.auditLogs)) memory.auditLogs = [];
    const now = Date.now();
    const entry = {
        id: `audit_grade_${now}_${crypto.randomBytes(4).toString('hex')}`,
        actor: (actor && (actor.email || actor)) || 'desconhecido',
        studentEmail: String(submission?.student?.email || submission?.studentEmail || '').trim().toLowerCase(),
        action,
        field,
        oldValue: String(oldValue ?? ''),
        newValue: String(newValue ?? ''),
        timestamp: now,
        ip: getClientIp(req),
        device: (req && req.headers && req.headers['user-agent']) || '',
        submissionId: submission?.id != null ? String(submission.id) : null,
        examKey: submission?.examKey || null,
        applicationId: submission?.applicationId || null,
        courseId: submission?.student?.courseId || submission?.courseId || null,
        studentClass: submission?.student?.studentClass || submission?.studentClass || null,
        category: 'grade',
    };
    if (details) entry.details = details;
    memory.auditLogs.push(entry);
    return entry;
}

// "Avaliação X: 7,0 (7/10 acertos)" para os textos de auditoria.
function describeSubmissionGrade(submission, title) {
    const grade = formatGradeBR(submission?.score);
    const counts = Number.isInteger(submission?.correctCount) && Number.isInteger(submission?.totalCount)
        ? ` (${submission.correctCount}/${submission.totalCount} acertos)`
        : '';
    return `${title || submission?.examKey || 'Avaliação'}: ${grade || 'sem nota válida'}${counts}`;
}

module.exports = {
    CSV_BOM,
    GRADE_MAX,
    MANUAL_TYPES,
    buildClassGradebook,
    buildCsv,
    buildGradeGroups,
    buildStudentReportModules,
    csvRow,
    csvSafe,
    describeSubmissionGrade,
    examTitle,
    formatDateBR,
    formatDateTimeBR,
    formatGradeBR,
    gradeFromScore,
    gradebookCsv,
    isEmptyInput,
    parseCountInput,
    parseGradeInput,
    recordGradeAudit,
    safeFilePart,
    scopeLabel,
    scopeSubmissionsToContext,
    scoreFromCounts,
    structureExamIndex,
    submissionMatchesContext,
};
