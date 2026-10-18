// Notas da turma: leitura validada da entrada do professor, consolidação única
// (a mesma regra da tela Resultados) para boletim e planilha, CSV no padrão do
// Excel brasileiro e auditoria das alterações de nota.
//
// Escala: o banco guarda `score` de 0 a 100 (como a correção online); as telas,
// o boletim e as planilhas mostram 0 a 10 com uma casa decimal.
const crypto = require('crypto');
const {
    SCORE_MAX,
    attemptGroupKey,
    consolidateSubmissions,
    normalizeScore,
    roundGrade,
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

// Nota digitada (0 a 10, até duas casas) -> score gravado (0 a 100, inteiro, uma
// casa na tela). O toFixed(6) tira o ruído de ponto flutuante (8,15 * 10 =
// 81,50000000000001). É a mesma conta da prévia da tela (web/src/lib/grades.js).
function scoreFromGrade(grade) {
    return Math.round(Number((grade * GRADE_MAX).toFixed(6)));
}

// Nota digitada e acertos informados juntos precisam conferir: a nota GRAVADA pode
// diferir da conta acertos/total só pelo arredondamento (menos de 0,1). Compara o
// que vai ser gravado, não o que foi digitado: 7,41 com 3 de 4 vira 7,4 e é
// recusada como 7,4. Devolve a mensagem de erro, ou null quando confere (ou
// quando falta um dos dois).
function gradeCountsMismatch(grade, correctCount, totalCount) {
    if (grade === null || grade === undefined || correctCount === null || correctCount === undefined || !totalCount) return null;
    const exact = (correctCount / totalCount) * SCORE_MAX;
    const stored = scoreFromGrade(grade);
    if (Math.abs(stored - exact) < 1 - 1e-9) return null;
    // Nota com duas casas é gravada com uma: diz qual nota foi comparada.
    const typed = String(grade).replace('.', ',');
    const gradeText = Math.abs(stored - grade * GRADE_MAX) < 1e-6 ? typed : `${typed} (gravada como ${formatGradeBR(stored)})`;
    return `A nota ${gradeText} não confere com ${correctCount} de ${totalCount} acertos (${formatGradeBR(exact)}). Deixe a nota em branco para calcular pelos acertos, ou apague os acertos para lançar só a nota.`;
}

// 0-100 -> 0-10 com uma casa (null quando a nota é inválida ou não existe).
function gradeFromScore(score) {
    return roundGrade(score);
}

// Nota para texto em pt-BR ("8,5"). Vazio quando não há nota válida.
function formatGradeBR(score) {
    const grade = roundGrade(score);
    return grade === null ? '' : grade.toFixed(1).replace('.', ',');
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

// Matrículas do aluno como { name, courseId } (formato antigo: turma em texto e
// curso no cadastro do aluno).
function studentMemberships(student) {
    const raw = student && Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student && student.studentClass ? [student.studentClass] : []);
    const fallbackCourse = String((student && (student.courseId || student.currentCourseId)) || '').trim();
    return raw
        .map(entry => (typeof entry === 'string'
            ? { name: entry.trim(), courseId: fallbackCourse }
            : { name: String((entry && (entry.name || entry.className)) || '').trim(), courseId: String((entry && entry.courseId) || fallbackCourse).trim() }))
        .filter(entry => entry.name);
}

// Curso e turma de cada entrega. Registro antigo sem curso (ou sem turma) recebe o
// da matrícula do aluno naquela turma; sem matrícula com curso, o da primeira turma
// cadastrada com esse nome (a original: o clone de curso cria turmas homônimas
// depois). Assim o registro antigo pertence a UM curso só e não aparece no curso
// vizinho que tem turma com o mesmo nome, nem cria linha para quem não é da turma.
function createSubmissionContextResolver({ students = [], classes = [] } = {}) {
    const studentsByEmail = new Map();
    (students || []).forEach(student => {
        const email = String((student && student.email) || '').trim().toLowerCase();
        if (email && !studentsByEmail.has(email)) studentsByEmail.set(email, student);
    });
    return (submission) => {
        let courseId = submissionCourseId(submission);
        let studentClass = submissionClassName(submission);
        if (courseId && studentClass) return { courseId, studentClass };
        const email = String(submission?.student?.email || submission?.studentEmail || '').trim().toLowerCase();
        const candidates = studentMemberships(studentsByEmail.get(email))
            .filter(entry => (!studentClass || entry.name === studentClass) && (!courseId || !entry.courseId || entry.courseId === courseId));
        if (!courseId) {
            const enrolled = candidates.find(entry => entry.courseId);
            const className = studentClass || (candidates[0] && candidates[0].name) || '';
            const original = !enrolled && className ? (classes || []).find(cls => cls && cls.name === className && cls.courseId) : null;
            courseId = enrolled ? enrolled.courseId : (original ? String(original.courseId) : '');
        }
        if (!studentClass) {
            const entry = candidates.find(item => !courseId || !item.courseId || item.courseId === courseId);
            if (entry) studentClass = entry.name;
        }
        return { courseId, studentClass };
    };
}

// A entrega pertence ao curso/turma do contexto? Comparação exata depois de
// completar curso/turma de registros antigos (sem `resolve`, o registro sem curso
// fica fora de um filtro por curso, como antes).
function submissionMatchesContext(submission, { courseId = '', studentClass = '' } = {}, resolve = null) {
    const expectedCourse = String(courseId || '').trim();
    const expectedClass = String(studentClass || '').trim();
    if (!expectedCourse && !expectedClass) return true;
    const row = resolve ? resolve(submission) : { courseId: submissionCourseId(submission), studentClass: submissionClassName(submission) };
    return (!expectedCourse || row.courseId === expectedCourse) && (!expectedClass || row.studentClass === expectedClass);
}

// Cópia da entrega com curso/turma ausentes completados pelo resolvedor (o banco
// não muda). Entrega já completa volta como está.
function withResolvedContext(submission, resolve) {
    const student = (submission && submission.student) || {};
    if (student.courseId && student.studentClass) return submission;
    const row = resolve(submission);
    if (!row.courseId && !row.studentClass) return submission;
    return {
        ...submission,
        student: {
            ...student,
            courseId: student.courseId || row.courseId || null,
            studentClass: student.studentClass || row.studentClass || '',
        },
    };
}

// Filtra pelo contexto e completa curso/turma ausentes (cópias, o banco não muda),
// para que registros antigos caiam no mesmo grupo de tentativas dos atuais.
// context: { courseId, studentClass, students, classes } — alunos e turmas servem
// para descobrir a qual curso um registro antigo pertence.
function scopeSubmissionsToContext(submissions, context = {}) {
    const courseId = String(context.courseId || '').trim();
    const studentClass = String(context.studentClass || '').trim();
    const resolve = createSubmissionContextResolver({ students: context.students, classes: context.classes });
    return (submissions || [])
        .filter(item => submissionMatchesContext(item, { courseId, studentClass }, resolve))
        .map(item => withResolvedContext(item, resolve));
}

// Chave do grupo de tentativas depois de completar curso/turma, igual à usada por
// Resultados, boletim e quadro: o registro antigo sem curso e o lançamento novo da
// mesma prova formam UM grupo também nas ações sobre o grupo (regra, "Usar esta
// nota", lixeira). context: { students, classes }.
function createResolvedGroupKey(context = {}) {
    const resolve = createSubmissionContextResolver(context);
    const resolved = submission => withResolvedContext(submission, resolve);
    const key = submission => attemptGroupKey(resolved(submission));
    return { key, resolved };
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
            grade: roundGrade(group.score),
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
                average: roundGrade(moduleAverage),
            };
        }),
        overallAverage: roundGrade(overall),
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
            cells[id] = { score: cell.score, grade: roundGrade(cell.score), pending: cell.pending };
        });
        return {
            email: row.email,
            name: row.name,
            matricula: row.matricula,
            status: row.status,
            cells,
            average: roundGrade(avg),
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

// Aluno excluído (delete-student): o registro de auditoria fica como histórico,
// mas sem ligação com a pessoa. As cópias das notas dele na lixeira
// (auditLogs[].details.deletedSubmission) perdem nome, e-mail, matrícula e o
// resto do cadastro que a entrega online copiava; ficam a prova, a nota, os
// acertos, as respostas e o curso/turma, para a estatística. As entradas do aluno
// perdem o studentEmail (senão a busca da ficha pelo e-mail religava a cópia ao
// aluno) e qualquer citação do e-mail, do nome ou da matrícula; nas alterações do
// cadastro, o valor antigo/novo é o próprio dado pessoal e sai. A cópia anonimizada
// não volta para Resultados (não há a quem devolver). Devolve quantas entradas mudaram.
const ANONYMIZED_STUDENT_NAME = 'Aluno excluído';
const ANONYMIZED_ACTOR = 'aluno excluído';
const PERSONAL_SUBMISSION_FIELDS = ['studentEmail', 'studentName', 'studentMatricula', 'matricula', 'nomeSocial', 'email', 'name'];

function normalizeEmailValue(value) {
    return String(value || '').trim().toLowerCase();
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deletedCopyEmail(copy) {
    if (!copy || typeof copy !== 'object') return '';
    const student = copy.student && typeof copy.student === 'object' ? copy.student : {};
    return normalizeEmailValue(student.email || copy.studentEmail);
}

function anonymizeDeletedCopy(copy, at) {
    const student = copy.student && typeof copy.student === 'object' ? copy.student : {};
    const anonymized = { ...copy };
    PERSONAL_SUBMISSION_FIELDS.forEach(field => { delete anonymized[field]; });
    anonymized.student = {
        name: ANONYMIZED_STUDENT_NAME,
        email: '',
        courseId: student.courseId || copy.courseId || null,
        studentClass: student.studentClass || copy.studentClass || '',
    };
    anonymized.anonymized = true;
    anonymized.anonymizedAt = at;
    return anonymized;
}

// Troca, em qualquer texto da entrada, o e-mail, o nome e a matrícula do aluno.
function scrubPersonalText(value, identity, key) {
    if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (identity.emails.has(lowered)) return key === 'actor' ? ANONYMIZED_ACTOR : '';
        if (identity.matriculas.has(value.trim())) return '';
        let text = value;
        identity.emails.forEach(email => { text = text.replace(new RegExp(escapeRegExp(email), 'gi'), ANONYMIZED_ACTOR); });
        identity.names.forEach(name => {
            text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), `$1${ANONYMIZED_STUDENT_NAME}`);
        });
        identity.matriculas.forEach(matricula => {
            text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(matricula)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), '$1');
        });
        return text;
    }
    if (Array.isArray(value)) return value.map(item => scrubPersonalText(item, identity, key));
    if (value && typeof value === 'object') {
        const out = {};
        Object.entries(value).forEach(([childKey, child]) => {
            out[childKey] = childKey === 'id' ? child : scrubPersonalText(child, identity, childKey);
        });
        return out;
    }
    return value;
}

// identity: { emails, names, matriculas } do aluno excluído (o e-mail atual e,
// se houve troca na versão antiga, o e-mail que ficou nas cópias).
function anonymizeStudentAuditTrail(memory, identity = {}, { at = new Date().toISOString() } = {}) {
    if (!memory || !Array.isArray(memory.auditLogs)) return 0;
    const emails = new Set((identity.emails || []).map(normalizeEmailValue).filter(Boolean));
    if (!emails.size) return 0;
    const names = new Set((identity.names || []).map(name => String(name || '').trim()).filter(name => name.length >= 3));
    const matriculas = new Set((identity.matriculas || []).map(value => String(value || '').trim()).filter(value => value.length >= 3));
    // Nome e matrícula que as cópias da lixeira guardavam (o cadastro pode ter mudado depois).
    memory.auditLogs.forEach(entry => {
        const copy = entry && entry.details && entry.details.deletedSubmission;
        if (!copy || typeof copy !== 'object' || copy.anonymized === true) return;
        if (!emails.has(deletedCopyEmail(copy)) && !emails.has(normalizeEmailValue(entry.studentEmail))) return;
        const student = copy.student && typeof copy.student === 'object' ? copy.student : {};
        [student.name, student.nomeSocial, copy.studentName, copy.nomeSocial].forEach(name => { if (String(name || '').trim().length >= 3) names.add(String(name).trim()); });
        [student.matricula, copy.matricula, copy.studentMatricula].forEach(value => { if (String(value || '').trim().length >= 3) matriculas.add(String(value).trim()); });
    });
    const scrubIdentity = { emails, names: [...names].sort((a, b) => b.length - a.length), matriculas };
    let changed = 0;
    memory.auditLogs.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const copy = entry.details && entry.details.deletedSubmission;
        const auditEmail = normalizeEmailValue(entry.studentEmail);
        const ownsEntry = emails.has(auditEmail) || (copy && emails.has(deletedCopyEmail(copy)));
        const serialized = JSON.stringify(entry).toLowerCase();
        const mentions = [...emails].some(email => serialized.includes(email));
        if (!ownsEntry && !mentions) return;
        let next = { ...entry };
        if (copy && typeof copy === 'object' && copy.anonymized !== true && ownsEntry) {
            next.details = { ...next.details, deletedSubmission: anonymizeDeletedCopy(copy, at) };
        }
        // Alteração do cadastro (recordStudentAudit): o valor é o próprio dado pessoal.
        const profileChange = ownsEntry && !next.type && next.category !== 'grade' && !String(next.action || '').startsWith('grade_') && 'field' in next;
        if (profileChange) { next.oldValue = ''; next.newValue = ''; }
        next = scrubPersonalText(next, scrubIdentity, '');
        if (ownsEntry) {
            next.studentEmail = '';
            next.studentAnonymized = true;
            if (!next.anonymizedAt) next.anonymizedAt = at;
        }
        memory.auditLogs[index] = next;
        changed += 1;
    });
    return changed;
}

// Migração (boot, idempotente): alunos excluídos antes desta correção deixaram as
// cópias completas na lixeira e o histórico ligado ao e-mail. Um e-mail conta como
// de aluno excluído quando sumiu do cadastro, não tem nenhuma entrega e não está num
// curso arquivado (o arquivamento tira o aluno do cadastro, mas ele pode voltar).
// archivedEmails: função chamada só se houver candidatos (lê os cursos arquivados).
function anonymizeAuditOfRemovedStudents(memory, { archivedEmails = () => new Set(), at = new Date().toISOString() } = {}) {
    if (!memory || !Array.isArray(memory.auditLogs) || !memory.auditLogs.length) return 0;
    const registered = new Set((memory.students || []).map(student => normalizeEmailValue(student && student.email)).filter(Boolean));
    // Cadastro vazio (banco novo ou tabela que não carregou): sem base para comparar, não mexe.
    if (!registered.size) return 0;
    const withSubmissions = new Set((memory.submissions || []).map(item => normalizeEmailValue(item && ((item.student && item.student.email) || item.studentEmail))).filter(Boolean));
    const alive = email => registered.has(email) || withSubmissions.has(email);
    // Grupos de e-mails do mesmo aluno: a cópia da lixeira pode ter o e-mail antigo
    // e a auditoria o novo (troca de e-mail na versão antiga).
    const groups = [];
    memory.auditLogs.forEach(entry => {
        if (!entry || typeof entry !== 'object' || entry.studentAnonymized === true) return;
        const copy = entry.details && entry.details.deletedSubmission;
        const emails = [normalizeEmailValue(entry.studentEmail), copy && copy.anonymized !== true ? deletedCopyEmail(copy) : '']
            .filter(email => email && email.includes('@'));
        if (emails.length) groups.push([...new Set(emails)]);
    });
    const candidates = groups.filter(emails => !emails.some(alive));
    if (!candidates.length) return 0;
    let archived;
    try { archived = archivedEmails() || new Set(); } catch (error) { return 0; }
    const done = new Set();
    let changed = 0;
    candidates.forEach(emails => {
        if (emails.some(email => archived.has(email))) return;
        const key = emails.slice().sort().join('|');
        if (done.has(key)) return;
        done.add(key);
        changed += anonymizeStudentAuditTrail(memory, { emails }, { at });
    });
    return changed;
}

// "Avaliação X: 7,0 (7/10 acertos)" para os textos de auditoria.
function describeSubmissionGrade(submission, title) {
    const grade = formatGradeBR(submission?.score);
    const counts = Number.isInteger(submission?.correctCount) && Number.isInteger(submission?.totalCount)
        ? ` (${submission.correctCount}/${submission.totalCount} acertos)`
        : '';
    return `${title || submission?.examKey || 'Avaliação'}: ${grade || 'sem nota válida'}${counts}`;
}

// ------------------------------------------- registro da aplicação
// Registro de uma aplicação de prova (AVA-08): o ciclo da aplicação, os eventos da
// prova gravados por recordExamAudit (encerramento, anulação, troca e correção de
// questão, contestações) e as alterações de nota das entregas dessa aplicação.
const ANNUL_MODE_LABELS = { ponto_para_todos: 'ponto para todos', remover_do_total: 'removida do total' };
// Mesmos rótulos do Monitor (MonitorPage.jsx).
const REPORT_REASON_LABELS = {
    sem_resposta_correta: 'Nenhuma resposta correta',
    duas_corretas: 'Mais de uma resposta correta',
    enunciado_confuso: 'Enunciado confuso',
    erro_digitacao: 'Erro de digitação',
    outro: 'Outro',
};

function countLabel(count, one, many) {
    const n = Number(count) || 0;
    return `${n} ${n === 1 ? one : many}`;
}

function regradedLabel(count) {
    return Number(count) > 0 ? countLabel(count, 'entrega recorrigida', 'entregas recorrigidas') : '';
}

function describeExamAudit(entry) {
    const details = entry.details || {};
    const join = (...parts) => parts.filter(Boolean).join(' · ');
    switch (entry.type) {
        case 'exam_application_finished':
            // Sem prova em andamento no encerramento, não há o que dizer (antes saía
            // "0 tentativas em andamento descartadas").
            return {
                title: 'Aplicação encerrada',
                detail: details.policy === 'submit' && Number(details.submitted) > 0
                    ? `${countLabel(details.submitted, 'prova em andamento enviada', 'provas em andamento enviadas')} pelo professor`
                    : (details.policy === 'discard' && Number(details.discarded) > 0 ? countLabel(details.discarded, 'tentativa em andamento descartada', 'tentativas em andamento descartadas') : ''),
            };
        case 'exam_question_annulled':
            return {
                title: `Questão ${details.questionNumber} anulada (${ANNUL_MODE_LABELS[details.mode] || 'anulada'})`,
                detail: join(details.reason ? `motivo: ${details.reason}` : '', regradedLabel(details.regraded)),
            };
        case 'exam_question_replaced':
            return {
                title: `Questão ${details.questionNumber} trocada pela questão ${details.replacementNumber}`,
                detail: join(details.extraMinutes ? `+${details.extraMinutes} min para a turma` : '', regradedLabel(details.regraded)),
            };
        case 'exam_question_corrected_live':
            return { title: `Questão ${details.questionNumber} corrigida durante a aplicação`, detail: regradedLabel(details.regraded) };
        case 'exam_question_reported':
            // Antes caía no padrão e mostrava a chave técnica "exam_question_reported".
            return {
                title: Number.isFinite(Number(details.questionNumber)) && details.questionNumber !== null
                    ? `Questão ${details.questionNumber} contestada pelo aluno`
                    : 'Questão contestada pelo aluno',
                detail: REPORT_REASON_LABELS[details.reason] || '',
            };
        case 'exam_question_reports_reviewed':
            return {
                title: Number.isFinite(Number(details.questionNumber)) && details.questionNumber !== null
                    ? `Contestações da questão ${details.questionNumber} revisadas`
                    : 'Contestações revisadas',
                detail: details.updated != null ? countLabel(details.updated, 'contestação', 'contestações') : '',
            };
        default:
            return { title: 'Evento da prova', detail: String(entry.type || '') };
    }
}

function auditTime(value) {
    if (value === null || value === undefined || value === '') return 0;
    const number = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(number) ? number : 0;
}

function buildApplicationAuditTrail(application, auditLogs = [], { students = [] } = {}) {
    if (!application) return [];
    const nameByEmail = new Map((students || []).map(student => [String(student.email || '').trim().toLowerCase(), (student.nomeSocial && student.nomeSocial.trim()) || student.name || student.email]));
    const own = (auditLogs || []).filter(entry => entry && String(entry.applicationId || '') === String(application.id));
    const rows = [];
    const lifecycle = (id, at, actor, title) => { if (at) rows.push({ id, at: auditTime(at), actor: actor || '', kind: 'application', title, detail: '' }); };
    lifecycle('application_created', application.createdAt, application.createdBy, 'Aplicação criada');
    lifecycle('application_started', application.startedAt, '', 'Prova iniciada');
    lifecycle('application_cancelled', application.cancelledAt, application.updatedBy, 'Aplicação cancelada');
    if (application.finishedAt && !own.some(entry => entry.type === 'exam_application_finished')) {
        lifecycle('application_finished', application.finishedAt, application.updatedBy, 'Aplicação encerrada');
    }
    own.forEach(entry => {
        if (entry.type) {
            rows.push({ id: entry.id, at: auditTime(entry.timestamp), actor: entry.actor || '', kind: 'exam', ...describeExamAudit(entry) });
            return;
        }
        if (entry.category !== 'grade' && !String(entry.action || '').startsWith('grade_')) return;
        const email = String(entry.studentEmail || '').trim().toLowerCase();
        rows.push({
            id: entry.id,
            at: auditTime(entry.timestamp),
            actor: entry.actor || '',
            kind: 'grade',
            title: `${entry.field || 'Nota'} · ${nameByEmail.get(email) || email || (entry.studentAnonymized ? ANONYMIZED_STUDENT_NAME : 'aluno')}`,
            detail: entry.oldValue ? `${entry.oldValue} → ${entry.newValue}` : String(entry.newValue || ''),
            studentEmail: email || null,
            submissionId: entry.submissionId || null,
        });
    });
    // Ordem cronológica por segundo; no mesmo segundo, a causa antes do efeito
    // (aplicação, depois o evento da prova, depois as notas recorrigidas por ele).
    const rank = { application: 0, exam: 1, grade: 2 };
    return rows.sort((a, b) => Math.floor(a.at / 1000) - Math.floor(b.at / 1000)
        || rank[a.kind] - rank[b.kind]
        || a.at - b.at);
}

module.exports = {
    ANONYMIZED_STUDENT_NAME,
    CSV_BOM,
    GRADE_MAX,
    MANUAL_TYPES,
    buildClassGradebook,
    buildCsv,
    buildGradeGroups,
    anonymizeAuditOfRemovedStudents,
    anonymizeStudentAuditTrail,
    buildApplicationAuditTrail,
    buildStudentReportModules,
    createResolvedGroupKey,
    createSubmissionContextResolver,
    csvRow,
    csvSafe,
    describeExamAudit,
    describeSubmissionGrade,
    examTitle,
    formatDateBR,
    formatDateTimeBR,
    formatGradeBR,
    gradeCountsMismatch,
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
    scoreFromGrade,
    structureExamIndex,
    studentMemberships,
    submissionMatchesContext,
    withResolvedContext,
};
