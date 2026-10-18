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
//
// Só a ação explícita de excluir o aluno anonimiza: não há anonimização automática
// no boot (quem foi excluído antes fica como está, para o Alan decidir caso a caso).
// Casamento sempre exato, nunca por pedaço de texto (excluir ana@ não toca joana@):
// - campo igual ao e-mail (studentEmail, actor, e-mail da cópia, item de lista);
// - em texto livre (e nas chaves dos objetos), só o e-mail inteiro: antes e depois
//   dele não pode haver letra (também acentuada), número, ".", "_", "%", "+", "-" ou
//   apóstrofo (um ponto final de frase logo depois, sem letra ou número em seguida,
//   não faz parte do e-mail);
// - e-mail que outro aluno cadastrado também usou (antes de trocar o login) ou que é
//   de professor: o registro da época do outro aluno, ou a autoria do professor, fica
//   (studentEmailOwnership).
const ANONYMIZED_STUDENT_NAME = 'Aluno excluído';
const ANONYMIZED_ACTOR = 'aluno excluído';
const PERSONAL_SUBMISSION_FIELDS = ['studentEmail', 'studentName', 'studentMatricula', 'matricula', 'nomeSocial', 'email', 'name'];
// Rótulo da troca de e-mail na auditoria do cadastro (AUDITABLE_FIELDS em students.js).
const EMAIL_CHANGE_FIELD = 'E-mail/login';

function normalizeEmailValue(value) {
    return String(value || '').trim().toLowerCase();
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// O e-mail inteiro dentro de um texto (sem diferenciar maiúsculas). Além do que a regra
// pede ([A-Za-z0-9._%+-]), letra acentuada, marca de acento e apóstrofo também não
// podem vir colados: "andréana@" e "d'ana@" são outros e-mails, que o cadastro aceita.
const EMAIL_EDGE_BEFORE = "[\\p{L}\\p{M}\\p{N}._%+'-]";
const EMAIL_EDGE_AFTER = "[\\p{L}\\p{M}\\p{N}_%+'-]|\\.[\\p{L}\\p{N}]";
function wholeEmailPattern(email) {
    return new RegExp(`(?<!${EMAIL_EDGE_BEFORE})${escapeRegExp(email)}(?!${EMAIL_EDGE_AFTER})`, 'giu');
}

// Momento de um registro (ms), para saber de quem era o e-mail naquela hora. Data sem
// hora (presença: "2026-03-02") vale o dia inteiro, com folga de fuso. null = sem data.
const RECORD_TIME_FIELDS = ['timestamp', 'createdAt', 'at', 'issuedAt', 'date'];
const DAY_MS = 24 * 60 * 60 * 1000;
function timeValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function recordPeriod(item) {
    if (!item || typeof item !== 'object') return null;
    for (const field of RECORD_TIME_FIELDS) {
        const value = item[field];
        const time = timeValue(value);
        if (time === null) continue;
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return { start: time - DAY_MS, end: time + 2 * DAY_MS };
        return { start: time, end: time };
    }
    return null;
}

// Trocas de e-mail do cadastro registradas na auditoria ("E-mail/login": antigo → novo).
// owner: o studentEmail da entrada (o e-mail novo na hora da troca; a troca seguinte
// do mesmo aluno o renomeia para o e-mail atual).
function emailChanges(memory) {
    return ((memory && memory.auditLogs) || [])
        .filter(entry => entry && typeof entry === 'object' && entry.field === EMAIL_CHANGE_FIELD)
        .map(entry => ({
            from: normalizeEmailValue(entry.oldValue),
            to: normalizeEmailValue(entry.newValue),
            time: timeValue(entry.timestamp),
            owner: normalizeEmailValue(entry.studentEmail),
        }))
        .filter(change => looksLikeEmail(change.from) && looksLikeEmail(change.to) && change.from !== change.to);
}

// Períodos em que cada e-mail foi do aluno: do e-mail atual para trás, pelas trocas
// registradas, cada troca antes da seguinte e depois do cadastro (createdAt). A troca
// entra na cadeia só se for do próprio aluno (owner é um e-mail da cadeia): quem pegou
// depois um e-mail que outro aluno largou não herda o passado dele.
// start/end -Infinity/Infinity = sem data conhecida (vale para sempre).
function studentEmailPeriods(student, changes) {
    const current = normalizeEmailValue(student && student.email);
    if (!current) return [];
    const created = timeValue(student.createdAt);
    const periods = [{ email: current, start: -Infinity, end: Infinity }];
    const chain = [current];
    const used = new Set();
    let bound = Infinity;
    for (;;) {
        const head = periods[periods.length - 1];
        let pick = -1;
        changes.forEach((change, index) => {
            if (used.has(index) || change.to !== head.email) return;
            if (change.time !== null && (change.time >= bound || (created !== null && change.time < created))) return;
            if (change.owner && !chain.includes(change.owner)) return;
            if (pick < 0 || (change.time ?? -Infinity) > (changes[pick].time ?? -Infinity)) pick = index;
        });
        if (pick < 0) break;
        used.add(pick);
        const change = changes[pick];
        head.start = change.time ?? -Infinity;
        periods.push({ email: change.from, start: -Infinity, end: change.time ?? Infinity });
        chain.push(change.from);
        if (change.time !== null) bound = change.time;
    }
    if (created !== null) {
        const first = periods[periods.length - 1];
        if (first.start === -Infinity && created <= first.end) first.start = created;
    }
    return periods;
}

// De quem é cada registro na exclusão do aluno. emails: todos os e-mails conhecidos do
// aluno (o atual e os anteriores, pelas trocas registradas). owns(e-mail, registro,
// tipo) diz se aquele registro com aquele e-mail é dele:
// - e-mail que outro aluno cadastrado usou (antes ou agora): o registro é do outro aluno
//   no período em que o e-mail era dele (ex.: a Ana trocou ana.antiga@ → ana@ e depois a
//   Bia foi cadastrada com ana.antiga@; excluir a Bia não toca o que a Ana gravou com
//   ana.antiga@ antes da troca). Registro sem data com esse e-mail: só conta se for o
//   e-mail atual do aluno (as trocas levam os dados junto); senão fica (na dúvida, não mexe);
// - tipo 'student' (campo que só guarda aluno: studentEmail, contestação, lista de
//   leitura) ou 'anyone' (autor, actorEmail, texto livre, login de professor): e-mail
//   que também é de professor ou administrador não conta no tipo 'anyone' (a conta de
//   aluno com o e-mail do professor não leva a autoria do professor);
// - tipo 'renamed' (campo que a troca de e-mail renomeia, renameStudentEmailEverywhere
//   e a cascata das notas: presença, observações, notas, fórum, auditoria do aluno...):
//   o registro com um e-mail é de quem usa esse e-mail hoje, se essa pessoa chegou a
//   ele por uma troca registrada, qualquer que seja a data do registro: a troca trouxe
//   para o e-mail novo os registros antigos dela, com a data da época em que o e-mail
//   ainda era de outro (a Ana trocou ana@ → aluno05@, que a Joana tinha largado; a
//   presença de janeiro da Ana agora tem aluno05@ e é da Ana, não da Joana). Quem foi
//   cadastrado direto com o e-mail não recebeu nada renomeado: aí, e para o e-mail que
//   ninguém usa hoje, vale o período (o registro da época do outro dono é dele, como a
//   auditoria antiga, de versões que não renomeavam). Nos campos que não são
//   renomeados (logins, autoria, texto livre, contestação), vale sempre o período.
function studentEmailOwnership(memory, email) {
    const current = normalizeEmailValue(email);
    if (!current) return { emails: [], owns: () => false };
    const changes = emailChanges(memory);
    const students = ((memory && memory.students) || []).filter(Boolean);
    const self = students.find(student => normalizeEmailValue(student.email) === current) || { email: current };
    const selfPeriods = studentEmailPeriods(self, changes);
    const emails = [...new Set(selfPeriods.map(period => period.email))];
    const known = new Set(emails);
    const foreign = new Map();
    students.forEach(student => {
        if (student === self || normalizeEmailValue(student.email) === current) return;
        studentEmailPeriods(student, changes).forEach(period => {
            if (!known.has(period.email)) return;
            if (!foreign.has(period.email)) foreign.set(period.email, []);
            foreign.get(period.email).push(period);
        });
    });
    const staff = new Set(((memory && memory.admins) || []).map(account => normalizeEmailValue(account && account.email)).filter(Boolean));
    // Quem usa hoje cada e-mail do aluno e se chegou a ele por uma troca registrada
    // (a cadeia de períodos tem mais de um e-mail).
    const holders = new Map([[current, { isSelf: true, arrived: selfPeriods.length > 1 }]]);
    students.forEach(student => {
        const address = normalizeEmailValue(student.email);
        if (!known.has(address) || holders.has(address)) return;
        holders.set(address, { isSelf: false, arrived: studentEmailPeriods(student, changes).length > 1 });
    });
    const owns = (value, record, kind = 'student') => {
        const candidate = normalizeEmailValue(value);
        if (!known.has(candidate)) return false;
        if (kind === 'anyone' && staff.has(candidate)) return false;
        const holder = kind === 'renamed' ? holders.get(candidate) : null;
        if (holder && holder.arrived) return holder.isSelf;
        const others = foreign.get(candidate) || [];
        if (!others.length) return true;
        const when = recordPeriod(record);
        if (!when) return candidate === current;
        return !others.some(period => when.start <= period.end && when.end >= period.start);
    };
    return { emails, owns };
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

// Troca, nos textos da entrada, o e-mail do aluno (campo igual ao e-mail ou o e-mail
// inteiro no meio do texto), também nas chaves dos objetos (a turma guardada inteira em
// "antes/depois" tem a liberação individual indexada pelo e-mail). Nome e matrícula só
// saem das entradas do próprio aluno (owned): numa entrada que só cita o e-mail, "Ana"
// pode ser o começo de "Ana Paula".
function scrubPersonalKey(key, identity, taken) {
    let next = identity.emails.has(String(key).trim().toLowerCase()) ? ANONYMIZED_ACTOR : String(key);
    identity.emailPatterns.forEach(pattern => { next = next.replace(pattern, ANONYMIZED_ACTOR); });
    if (next === key) return key;
    let unique = next;
    for (let index = 2; taken.has(unique); index += 1) unique = `${next} (${index})`;
    return unique;
}

// Campo de identificador ou de data (id, examKey, applicationId, submissionId,
// attemptId, timestamp, anonymizedAt, date...): nome e matrícula não saem dele. A
// matrícula "2026" não pode virar buraco em "2026-03-01" nem o nome "Ana" mudar o
// examKey "Avaliacao_Ana"; o e-mail inteiro sai em qualquer campo.
const IDENTIFIER_OR_DATE_KEY = /^(id|key|date|time|timestamp|at)$|(Id|Ids|Key|Keys|At|Date|Time|Timestamp)$/;
function isIdentifierOrDateKey(key) {
    return IDENTIFIER_OR_DATE_KEY.test(String(key || ''));
}

function scrubPersonalText(value, identity, key, owned) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (identity.emails.has(trimmed.toLowerCase())) return key === 'actor' ? ANONYMIZED_ACTOR : '';
        const personal = owned && !isIdentifierOrDateKey(key);
        if (personal && identity.matriculas.has(trimmed)) return '';
        let text = value;
        identity.emailPatterns.forEach(pattern => { text = text.replace(pattern, ANONYMIZED_ACTOR); });
        if (!personal) return text;
        identity.names.forEach(name => {
            text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), `$1${ANONYMIZED_STUDENT_NAME}`);
        });
        identity.matriculas.forEach(matricula => {
            text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(matricula)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), '$1');
        });
        return text;
    }
    if (Array.isArray(value)) return value.map(item => scrubPersonalText(item, identity, key, owned));
    if (value && typeof value === 'object') {
        const out = {};
        Object.entries(value).forEach(([childKey, child]) => {
            const nextKey = childKey === 'id' ? childKey : scrubPersonalKey(childKey, identity, new Set(Object.keys(out)));
            out[nextKey] = childKey === 'id' ? child : scrubPersonalText(child, identity, childKey, owned);
        });
        return out;
    }
    return value;
}

// identity: { emails, names, matriculas, owns } do aluno excluído; emails e owns vêm de
// studentEmailOwnership (todos os e-mails conhecidos dele e de quem é cada registro).
// Sem owns, todo registro com um desses e-mails conta como dele.
function anonymizeStudentAuditTrail(memory, identity = {}, { at = new Date().toISOString() } = {}) {
    if (!memory || !Array.isArray(memory.auditLogs)) return 0;
    const emails = [...new Set((identity.emails || []).map(normalizeEmailValue).filter(Boolean))];
    if (!emails.length) return 0;
    const owns = typeof identity.owns === 'function'
        ? identity.owns
        : value => emails.includes(normalizeEmailValue(value));
    const patterns = new Map(emails.map(email => [email, wholeEmailPattern(email)]));
    const names = new Set((identity.names || []).map(name => String(name || '').trim()).filter(name => name.length >= 3));
    const matriculas = new Set((identity.matriculas || []).map(value => String(value || '').trim()).filter(value => value.length >= 3));
    // Entrada sobre o aluno: studentEmail ou a cópia da nota com um e-mail dele (os dois
    // a troca de e-mail renomeia: o e-mail atual é dele em qualquer data).
    const isAboutStudent = entry => {
        const copy = entry.details && entry.details.deletedSubmission;
        return owns(entry.studentEmail, entry, 'renamed') || (!!copy && typeof copy === 'object' && owns(deletedCopyEmail(copy), entry, 'renamed'));
    };
    // Nome e matrícula que as cópias da lixeira guardavam (o cadastro pode ter mudado depois).
    memory.auditLogs.forEach(entry => {
        const copy = entry && entry.details && entry.details.deletedSubmission;
        if (!copy || typeof copy !== 'object' || copy.anonymized === true || !isAboutStudent(entry)) return;
        const student = copy.student && typeof copy.student === 'object' ? copy.student : {};
        [student.name, student.nomeSocial, copy.studentName, copy.nomeSocial].forEach(name => { if (String(name || '').trim().length >= 3) names.add(String(name).trim()); });
        [student.matricula, copy.matricula, copy.studentMatricula].forEach(value => { if (String(value || '').trim().length >= 3) matriculas.add(String(value).trim()); });
    });
    const sortedNames = [...names].sort((a, b) => b.length - a.length);
    // Entrada de outro aluno cadastrado nunca muda (o studentEmail é o login atual dele).
    const living = new Set((memory.students || []).map(student => normalizeEmailValue(student && student.email)).filter(Boolean));
    let changed = 0;
    memory.auditLogs.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const copy = entry.details && entry.details.deletedSubmission;
        const aboutStudent = isAboutStudent(entry);
        if (!aboutStudent && living.has(normalizeEmailValue(entry.studentEmail))) return;
        // E-mails do aluno nesta entrada (na data dela; o de professor fica).
        const entryEmails = emails.filter(email => owns(email, entry, 'anyone'));
        const byStudent = owns(entry.actor, entry, 'anyone');
        if (!aboutStudent && !entryEmails.length) return;
        let next = { ...entry };
        if (copy && typeof copy === 'object' && copy.anonymized !== true && aboutStudent) {
            next.details = { ...next.details, deletedSubmission: anonymizeDeletedCopy(copy, at) };
        }
        // Alteração do cadastro (recordStudentAudit): o valor é o próprio dado pessoal.
        const profileChange = aboutStudent && !next.type && next.category !== 'grade' && !String(next.action || '').startsWith('grade_') && 'field' in next;
        if (profileChange) { next.oldValue = ''; next.newValue = ''; }
        const scrubIdentity = {
            emails: new Set(entryEmails),
            emailPatterns: entryEmails.map(email => patterns.get(email)),
            names: sortedNames,
            matriculas,
        };
        next = scrubPersonalText(next, scrubIdentity, '', aboutStudent || byStudent);
        if (aboutStudent) {
            next.studentEmail = '';
            next.studentAnonymized = true;
            if (!next.anonymizedAt) next.anonymizedAt = at;
        }
        if (JSON.stringify(next) === JSON.stringify(entry)) return;
        memory.auditLogs[index] = next;
        changed += 1;
    });
    return changed;
}

// Aluno excluído (delete-student): nas aplicações de prova (e na configuração da
// prova na turma, formato antigo) as contestações dele perdem e-mail, nome e o texto
// livre (que o aluno escreve e pode ter nome, matrícula, telefone); ficam a questão, o
// motivo e o andamento, para o professor revisar a questão. Tempo extra e versão
// atribuídos pelo e-mail saem (não há mais a quem aplicar). Casamento exato pelo
// e-mail (todos os conhecidos do aluno; owns, de studentEmailOwnership, diz de quem é
// a contestação gravada com um e-mail que outro aluno também usou). Devolve quantos
// itens mudaram.
function anonymizeStudentExamRecords(memory, { emails = [], owns = null } = {}, { at = new Date().toISOString() } = {}) {
    const wanted = new Set(emails.map(normalizeEmailValue).filter(Boolean));
    if (!memory || !wanted.size) return 0;
    const isTheStudent = typeof owns === 'function' ? owns : value => wanted.has(normalizeEmailValue(value));
    let changed = 0;
    // mapKind: tempo extra e versão das aplicações a troca de e-mail renomeia ('renamed');
    // os da configuração antiga na turma, não.
    const clean = (holder, mapKind = 'student') => {
        if (!holder || typeof holder !== 'object') return;
        (Array.isArray(holder.questionReports) ? holder.questionReports : []).forEach(report => {
            if (!report || !isTheStudent(report.studentEmail, report, 'student')) return;
            report.studentEmail = '';
            report.studentName = ANONYMIZED_STUDENT_NAME;
            report.text = '';
            report.studentAnonymized = true;
            if (!report.anonymizedAt) report.anonymizedAt = at;
            changed += 1;
        });
        ['studentAdjustments', 'studentVersions'].forEach(field => {
            const map = holder[field];
            if (!map || typeof map !== 'object') return;
            Object.keys(map).forEach(key => {
                if (isTheStudent(key, null, mapKind)) { delete map[key]; changed += 1; }
            });
        });
    };
    (memory.examApplications || []).forEach(application => clean(application, 'renamed'));
    (memory.classes || []).forEach(cls => {
        Object.values((cls && cls.onlineExamConfigs) || {}).forEach(config => clean(config, 'student'));
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
    anonymizeStudentAuditTrail,
    anonymizeStudentExamRecords,
    studentEmailOwnership,
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
