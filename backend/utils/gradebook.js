// Notas da turma: leitura validada da entrada do professor, consolidação única
// (a mesma regra da tela Resultados) para boletim e planilha, CSV no padrão do
// Excel brasileiro e auditoria das alterações de nota.
//
// Escala: o banco guarda `score` de 0 a 100 (como a correção online); as telas,
// o boletim e as planilhas mostram 0 a 10 com uma casa decimal.
const {
    SCORE_MAX,
    attemptGroupKey,
    consolidateSubmissions,
    normalizeScore,
    roundGrade,
} = require('./submissionAttempts.js');
const { recordAudit } = require('./audit.js');
const { buildXlsx } = require('./tabularFile.js');
const crypto = require('crypto');
const gradingRules = require('./gradingRules.js');
const academicCalendar = require('./academicCalendar.js');
const attendanceUtil = require('./attendance.js');

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

// ---- Critério e faixas da nota (ENG-02, contrato C1 do P2) -------------------
// Toda comparação de nota com a média mínima passa por aqui (e, na tela, pela cópia
// em web/src/lib/grades.js, conferida por test/backend/regra-de-nota-unica.test.js).
// Ninguém compara nota com 6, 7, 9 ou 60 escritos no código.
//
// Sem critérios configurados vale o padrão: média mínima 6,0 e a conta de sempre
// (regraAntiga). gradeCriterionFor é o único lugar que diz qual critério vale para um
// curso ou turma; os critérios do curso (P2-S3) entram ali.
const MEDIA_MINIMA_PADRAO = 6;
const DEFAULT_GRADE_CRITERION = Object.freeze({ mediaMinima: MEDIA_MINIMA_PADRAO, mencoes: null, regraAntiga: true });
// Faixas acima da mínima: 9,0 em diante "excelente", 7,0 em diante "bom". Abaixo da
// mínima, até 2 pontos dela é "abaixo"; mais longe, "muito abaixo". Com mínima 6
// são as faixas que as telas sempre usaram (9/7/6, e 4 no "Média" de Resultados).
const FAIXA_EXCELENTE = 9;
const FAIXA_BOM = 7;
const DISTANCIA_DE_ALERTA = 2;
// Análise da prova (Monitor): "alto" a partir de 8,5.
const FAIXA_ALTO_DESEMPENHO = 8.5;
const GRADE_BANDS = ['excelente', 'bom', 'suficiente', 'abaixo', 'muito_abaixo'];

// Uma casa, "metade para cima", como roundGrade (8,99 -> 9,0; 5,96 -> 6,0): a faixa
// é a da nota que aparece na tela.
// Texto vazio ou só com espaços não é nota (Number('  ') daria 0); "5,5" com vírgula
// vale 5,5, como a nota digitada.
function gradeNumber(grade) {
    if (grade === null || grade === undefined || typeof grade === 'boolean') return null;
    if (typeof grade === 'string') {
        const text = grade.trim();
        if (!text) return null;
        return Number(/^-?\d+,\d+$/.test(text) ? text.replace(',', '.') : text);
    }
    return Number(grade);
}

function roundGradeValue(grade) {
    const number = gradeNumber(grade);
    if (number === null) return null;
    if (!Number.isFinite(number) || number < 0 || number > GRADE_MAX) return null;
    return Math.round(Number((number * 10).toFixed(6))) / 10;
}

function normalizeGradeCriterion(criterio) {
    const minima = roundGradeValue(criterio?.mediaMinima);
    return {
        mediaMinima: minima === null ? MEDIA_MINIMA_PADRAO : minima,
        mencoes: Array.isArray(criterio?.mencoes) ? criterio.mencoes : null,
        regraAntiga: criterio?.regraAntiga !== false,
    };
}

// Critério que vale para o curso/turma: gradeCriterionFor(memory, { courseId, studentClass }).
// Os critérios são do curso (course.avaliacao, B6 / P2-S3): sem critérios, ou com eles
// desligados, o padrão (mínima 6,0, regraAntiga). A tela pinta a nota por ele (C1 do P2).
function gradeCriterionFor(memory, context = {}) {
    const course = courseForContext(memory, context);
    if (!course) return { ...DEFAULT_GRADE_CRITERION };
    return gradingRules.criterioForScreen(course.avaliacao);
}

// Curso de { courseId } ou, sem curso, o da turma { studentClass } (a primeira com o nome).
function courseForContext(memory, { courseId = '', studentClass = '' } = {}) {
    const courses = (memory && Array.isArray(memory.courses)) ? memory.courses : [];
    let id = String(courseId || '').trim();
    if (!id && studentClass) {
        const cls = ((memory && memory.classes) || []).find(item => item && item.name === String(studentClass).trim());
        id = cls ? String(cls.courseId || '') : '';
    }
    if (!id) return null;
    return courses.find(item => item && String(item.id) === id) || null;
}

// Nota de 0 a 10 -> faixa (GRADE_BANDS), ou null sem nota válida.
function gradeBand(grade, criterio) {
    const value = roundGradeValue(grade);
    if (value === null) return null;
    const { mediaMinima } = normalizeGradeCriterion(criterio);
    if (value < mediaMinima) {
        const alerta = Math.round((mediaMinima - DISTANCIA_DE_ALERTA) * 10) / 10;
        return value >= alerta ? 'abaixo' : 'muito_abaixo';
    }
    if (value >= FAIXA_EXCELENTE) return 'excelente';
    if (value >= FAIXA_BOM) return 'bom';
    return 'suficiente';
}

// A nota alcança a média mínima? null sem nota válida.
function isPassingGrade(grade, criterio) {
    const band = gradeBand(grade, criterio);
    if (band === null) return null;
    return band !== 'abaixo' && band !== 'muito_abaixo';
}

// "baixo" (abaixo da mínima), "medio" ou "alto" para a análise da prova.
function performanceBucket(grade, criterio) {
    const passing = isPassingGrade(grade, criterio);
    if (passing === null) return null;
    if (!passing) return 'baixo';
    return roundGradeValue(grade) >= FAIXA_ALTO_DESEMPENHO ? 'alto' : 'medio';
}

// Média mínima para texto ("6,0").
function formatMinimumGrade(criterio) {
    return normalizeGradeCriterion(criterio).mediaMinima.toFixed(1).replace('.', ',');
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
// Id do módulo da estrutura do curso, o mesmo no boletim, no quadro e nas disciplinas
// (disciplinas[].modulos, B5 / P2-S7): id, chave, nome ou a posição.
function structureModuleId(module, moduleIndex) {
    const value = module && (module.id || module.key || module.name || module.title);
    return String(value || `module_${moduleIndex}`);
}

// Ids dos módulos das estruturas dadas (a do curso e as das turmas dele, que podem ter
// módulo a mais), sem repetir.
function structureModuleIds(...structures) {
    const ids = new Set();
    structures.forEach(structure => (Array.isArray(structure) ? structure : []).forEach((module, index) => {
        if (module && typeof module === 'object') ids.add(structureModuleId(module, index));
    }));
    return ids;
}

// Aulas previstas e faltas que o aluno ainda pode ter (C8 do P2), na turma inteira e por
// disciplina, para o boletim (e, no B6, o resumo do aluno). Aulas previstas só com período
// letivo na turma (academicCalendar.plannedLessons no período inteiro, sem os dias não
// letivos); a frequência mínima é a dos critérios do curso (course.avaliacao): sem
// critérios (regra antiga) não há mínima, e faltasPermitidasRestantes fica null, como no
// motor de critérios (gradingRules).
// records: as presenças do aluno na turma (dedupeByDate). As faltas que gastam a cota são
// só as de DENTRO das datas do período (inicio..fim): a turma que já existia e foi ligada
// a um período novo (D17) não começa o período com as faltas do semestre anterior. A
// frequência mostrada no boletim continua sendo a de todas as aulas lançadas (D10).
// stats (computeAttendanceStats) só vale quando records não vem (chamada antiga): aí as
// faltas são as que vierem nele.
function attendanceAllowanceFor(memory, { course = null, cls = null, records = null, stats = null } = {}) {
    const term = cls ? academicCalendar.termForClass(memory, cls) : null;
    const planned = term ? academicCalendar.plannedLessons(memory, cls) : null;
    const criterios = gradingRules.normalizeCriteria(course && course.avaliacao);
    const frequenciaMinima = criterios ? criterios.frequenciaMinima : null;
    const aulasPrevistas = planned ? planned.total : null;
    const noPeriodo = Array.isArray(records)
        ? attendanceUtil.computeAttendanceStats(records.filter(row => row && typeof row.date === 'string'
            && (!term || (row.date >= term.inicio && row.date <= term.fim))))
        : stats;
    const faltas = noPeriodo ? noPeriodo.faltasContam : null;
    const disciplina = (id, faltasDaDisciplina) => {
        const key = String(id || '');
        const previstas = planned ? (planned.porDisciplina[key] || 0) : null;
        const usadas = Array.isArray(records)
            ? ((noPeriodo.porDisciplina[key] && noPeriodo.porDisciplina[key].faltas) || 0)
            : faltasDaDisciplina;
        return {
            aulasPrevistas: previstas,
            faltasPermitidasRestantes: gradingRules.faltasPermitidasRestantes({ aulasPrevistas: previstas, frequenciaMinima, faltas: usadas }),
        };
    };
    return {
        periodoLetivo: academicCalendar.termSummary(term),
        aulasPrevistas,
        // Disciplinas com aula prevista no período (para o boletim listar mesmo sem chamada).
        disciplinasPrevistas: planned ? Object.keys(planned.porDisciplina).filter(key => planned.porDisciplina[key] > 0) : [],
        frequenciaMinima,
        faltasNoPeriodo: term ? faltas : null,
        faltasPermitidasRestantes: gradingRules.faltasPermitidasRestantes({ aulasPrevistas, frequenciaMinima, faltas }),
        disciplina,
    };
}

function structureExamIndex(structure) {
    const index = new Map();
    (structure || []).forEach((module, moduleIndex) => {
        const moduleId = structureModuleId(module, moduleIndex);
        const moduleName = module.name || module.title || module.id || `Módulo ${moduleIndex + 1}`;
        (module.units || module.items || []).forEach((unit, unitIndex) => {
            if (!unit || !unit.avaliacaoKey || index.has(unit.avaliacaoKey)) return;
            index.set(unit.avaliacaoKey, { moduleId, moduleName, moduleIndex, unitIndex, unitName: unit.name || unit.title || '' });
        });
    });
    return index;
}

// Nome da avaliação: o título cadastrado, senão o nome da unidade na estrutura, senão (com
// classes) o título da avaliação manual da turma (id 'man_*'), senão a própria chave.
function examTitle(examKey, { evaluations = {}, examIndex = null, classes = null } = {}) {
    const evaluation = evaluations && evaluations[examKey];
    return (evaluation && (evaluation.title || evaluation.name))
        || (examIndex && examIndex.get(examKey)?.unitName)
        || manualAssessmentTitle(classes, examKey)
        || examKey;
}

// Título da avaliação manual (classes[].avaliacao.manuais) pelo id, em qualquer turma (o id
// 'man_<ms>_<6hex>' não se repete); '' quando não é avaliação manual ou não foi achada.
// Assim a tela Provas do aluno, Meus dados e a auditoria da nota mostram "Seminário de
// redes" e não o id técnico.
function manualAssessmentTitle(classes, examKey) {
    if (!isManualItemId(examKey) || !Array.isArray(classes)) return '';
    for (const cls of classes) {
        const raw = cls && cls.avaliacao && Array.isArray(cls.avaliacao.manuais) ? cls.avaliacao.manuais : null;
        const found = raw && raw.find(item => item && typeof item === 'object' && String(item.id || '').trim() === examKey);
        if (!found) continue;
        const normalized = gradingRules.normalizePlan({ manuais: [found] }).manuais[0];
        if (normalized && normalized.titulo) return normalized.titulo;
    }
    return '';
}

// Título da avaliação manual de uma entrega: primeiro na turma da entrega, depois em
// qualquer turma. '' quando a entrega não é de avaliação manual.
function manualAssessmentTitleForSubmission(classes, submission) {
    const key = submission && submission.examKey;
    if (!isManualItemId(key) || !Array.isArray(classes)) return '';
    const name = submissionClassName(submission);
    const courseId = submissionCourseId(submission);
    const own = classes.filter(cls => cls && String(cls.name || '') === name && (!courseId || String(cls.courseId || '') === courseId));
    return manualAssessmentTitle(own, key) || manualAssessmentTitle(classes, key);
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
            // Alguma tentativa do grupo espera a correção do professor (P3-S4a, contrato
            // C1 do P3): a nota dela ainda não entra na conta.
            aguardandoCorrecao: group.aguardandoCorrecao === true,
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

// Média do aluno na visão do professor (ficha do aluno, coluna "Média" de Alunos e
// risco do Dashboard): a mesma consolidação de Resultados, do quadro e do boletim
// (um grupo por aplicação da prova, regra maior/última/média/escolhida, notas
// inválidas fora). Conta também as notas ainda não publicadas, porque é a visão do
// professor; o boletim conta só as publicadas e pode diferir. Média de 0 a 100 (null
// sem nota), quantos grupos têm nota e quantas provas diferentes o aluno fez.
function consolidatedStudentAverage(submissions) {
    const groups = buildGradeGroups(submissions);
    const graded = groups.filter(group => group.score !== null);
    return {
        average: average(graded.map(group => group.score)),
        gradedCount: graded.length,
        examsDone: new Set(groups.map(group => group.examKey).filter(Boolean)).size,
    };
}

// ------------------------------------- critérios, plano e itens (B6 / P2-S3, FUN-02)
// A conta única com critérios (contrato C1 do P2): os construtores abaixo (boletim, quadro,
// ficha, resumo do aluno) recebem o contexto da turma (classGradingContext) e chamam
// gradingRules.computeStudentResult. Sem contexto, ou com o curso sem critérios, a conta
// é a de sempre (D1 do P2).
//
// Itens de avaliação da turma (o que o plano lista e o quadro mostra como coluna):
// - 'prova': as provas da estrutura da turma (avaliacaoKey), cada uma com o módulo;
// - 'manual': as avaliações manuais do plano (classes[].avaliacao.manuais, id 'man_*'):
//   trabalho, prática, seminário... A nota é uma entrega comum em submissions com
//   examKey = id, type 'manual', entryMode 'quick' (D6 do P2), consolidada como as
//   outras. Avaliação manual arquivada some do plano e as notas dela ficam guardadas, mas
//   saem da média (com aviso) até reativar;
// - os itens dos provedores registrados (registerGradeItemProvider), como a tarefa do P1
//   (contrato C2 do P2 e K1 do plano): a nota mora na coleção do provedor (a da tarefa em
//   assignmentSubmissions.grade) e entra aqui como um grupo a mais, sem linha em
//   submissions.
// Etapa, peso, "Recuperação de" e "Não conta" de qualquer item ficam no plano da turma
// (classes[].avaliacao.itens[id]) e só valem com os critérios do curso ligados.

// Origens que não vêm de provedor.
const GRADE_ITEM_BUILTIN_ORIGINS = Object.freeze(['prova', 'manual']);
const MANUAL_ITEM_PREFIX = 'man_';
const MANUAL_MODULE_NAME = 'Avaliações da turma';
const MANUAL_TYPE_LABELS = Object.freeze({
    trabalho: 'Trabalho',
    pratica: 'Prática',
    seminario: 'Seminário',
    participacao: 'Participação',
    outro: 'Outra avaliação',
});
const gradeItemProviders = new Map();

function isManualItemId(id) {
    return typeof id === 'string' && id.startsWith(MANUAL_ITEM_PREFIX);
}

// Id novo de avaliação manual: 'man_<ms>_<6 hex>', único entre as turmas (o título é
// achado pelo id em qualquer turma). Usado na criação e na cópia da turma ao duplicar curso.
function newManualItemId() {
    return `${MANUAL_ITEM_PREFIX}${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

// Provedor de itens de avaliação que não são prova (contrato C2 do P2):
// registerGradeItemProvider({
//   origem: 'tarefa',
//   items(course, cls, memory) => [{ id, titulo, moduloId?, data?, fora? }]
//     os itens da turma (fora: true = "Conta na média" desmarcado, o padrão do item no plano
//     enquanto o professor não mexer nele);
//   entries(memory, { course, cls, courseId, studentClass, emails, publishedOnly })
//     => [{ itemId, email, studentId?, score (0 a 100), publicada }]
//     as notas da turma (emails: lista de e-mails minúsculos para limitar, ou null para
//     todos; publishedOnly: só o que o aluno já vê).
// })
// O id do item não pode ser de prova da estrutura nem começar com 'man_'. Provedor que
// falha não derruba o quadro: os itens dele ficam de fora e o erro vai para o registro.
// Devolve a função que desfaz o registro (testes).
function registerGradeItemProvider(provider) {
    const origem = String((provider && provider.origem) || '').trim();
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(origem) || GRADE_ITEM_BUILTIN_ORIGINS.includes(origem)) {
        throw new Error(`Origem de itens de avaliação inválida: ${origem || '(vazia)'}`);
    }
    if (typeof provider.items !== 'function' || typeof provider.entries !== 'function') {
        throw new Error(`O provedor de itens '${origem}' precisa de items() e entries().`);
    }
    const entry = { origem, items: provider.items, entries: provider.entries };
    gradeItemProviders.set(origem, entry);
    return () => {
        if (gradeItemProviders.get(origem) === entry) gradeItemProviders.delete(origem);
    };
}

function gradeItemProviderList() {
    return [...gradeItemProviders.values()];
}

function callGradeItemProvider(provider, kind, args) {
    try {
        const out = provider[kind](...args);
        return Array.isArray(out) ? out : [];
    } catch (error) {
        console.error(`[notas] o provedor de itens '${provider.origem}' falhou em ${kind}: ${error && error.message}`);
        return [];
    }
}

// Presenças do aluno na turma, como no boletim: registros dele no curso (ou sem curso) e
// na turma (ou sem turma), deduplicados por data. Uma passada para a turma inteira:
// Map email -> { records, stats }.
function classAttendanceByEmail(memory, { courseId = '', studentClass = '' } = {}) {
    const course = String(courseId || '');
    const name = String(studentClass || '');
    const byEmail = new Map();
    ((memory && memory.attendance) || []).forEach(record => {
        if (!record) return;
        const email = String(record.studentEmail || '').trim().toLowerCase();
        if (!email) return;
        if (course && record.courseId && String(record.courseId) !== course) return;
        if (name && record.studentClass && record.studentClass !== name) return;
        if (!byEmail.has(email)) byEmail.set(email, []);
        byEmail.get(email).push(record);
    });
    const out = new Map();
    byEmail.forEach((records, email) => {
        const rows = attendanceUtil.dedupeByDate(records);
        out.set(email, { records: rows, stats: attendanceUtil.computeAttendanceStats(rows) });
    });
    return out;
}

// Contexto de notas da turma, montado uma vez por pedido:
// classGradingContext(memory, { course, cls, structure, hoje })
// - structure: a estrutura efetiva da turma (classContent.effectiveStructure), que pode ter
//   prova a mais que o curso;
// - hoje: 'AAAA-MM-DD' no fuso da escola, para saber se o período letivo terminou.
// Devolve { courseId, studentClass, course, cls, criterios (normalizados ou null = regra
// antiga), criterio (o da tela), ativo, plano (normalizado), planoEfetivo, itens,
// itemById, examIndex, disciplinas, periodo, applicationsById, aulasPrevistas(),
// providerGroups({ emails, publishedOnly }), frequenciaDe(email) }.
function classGradingContext(memory, { course = null, cls = null, structure = null, hoje = null, attendance = null } = {}) {
    const mem = memory || {};
    const courseId = String((course && course.id) || (cls && cls.courseId) || '');
    const studentClass = String((cls && cls.name) || '');
    const effective = Array.isArray(structure) ? structure : ((course && course.structure) || []);
    const examIndex = structureExamIndex(effective);
    const evaluations = mem.evaluations || {};
    const criterios = gradingRules.normalizeCriteria(course && course.avaliacao);
    const plano = gradingRules.normalizePlan(cls && cls.avaliacao);

    const moduleNames = new Map();
    effective.forEach((module, index) => {
        if (module && typeof module === 'object') moduleNames.set(structureModuleId(module, index), module.name || module.title || module.id || `Módulo ${index + 1}`);
    });
    const disciplinas = ((course && Array.isArray(course.disciplinas)) ? course.disciplinas : [])
        .filter(item => item && item.id)
        .map(item => ({ id: String(item.id), nome: item.nome || String(item.id), modulos: Array.isArray(item.modulos) ? item.modulos.map(String) : [] }));
    const disciplinaDoModulo = new Map();
    disciplinas.forEach(item => item.modulos.forEach(modulo => { if (!disciplinaDoModulo.has(modulo)) disciplinaDoModulo.set(modulo, item); }));

    const itens = [];
    const itemById = new Map();
    const push = (item) => {
        if (!item.id || itemById.has(item.id)) return;
        const disciplina = item.moduloId ? disciplinaDoModulo.get(item.moduloId) : null;
        const full = {
            ...item,
            moduloNome: item.moduloId ? (moduleNames.get(item.moduloId) || null) : null,
            disciplinaId: disciplina ? disciplina.id : null,
            disciplinaNome: disciplina ? disciplina.nome : null,
        };
        itens.push(full);
        itemById.set(full.id, full);
    };
    examIndex.forEach((meta, key) => push({ id: key, titulo: examTitle(key, { evaluations, examIndex }), origem: 'prova', moduloId: meta.moduleId }));
    plano.manuais.forEach(manual => push({
        id: manual.id,
        titulo: manual.titulo,
        origem: 'manual',
        tipo: manual.tipo,
        tipoRotulo: MANUAL_TYPE_LABELS[manual.tipo] || MANUAL_TYPE_LABELS.outro,
        descricao: manual.descricao,
        data: manual.data,
        moduloId: manual.moduloId && moduleNames.has(manual.moduloId) ? manual.moduloId : null,
        arquivado: !!manual.arquivadoEm,
    }));
    const foraPadrao = new Set();
    gradeItemProviderList().forEach(provider => {
        callGradeItemProvider(provider, 'items', [course, cls, mem]).forEach(raw => {
            const id = raw && typeof raw.id === 'string' ? raw.id.trim() : '';
            if (!id || id.length > gradingRules.LIMITES.itemIdMax || isManualItemId(id) || examIndex.has(id)) return;
            push({
                id,
                titulo: String(raw.titulo || raw.title || id).slice(0, 200),
                origem: provider.origem,
                moduloId: typeof raw.moduloId === 'string' && moduleNames.has(raw.moduloId) ? raw.moduloId : null,
                data: typeof raw.data === 'string' ? raw.data : null,
            });
            if (raw.fora === true) foraPadrao.add(id);
        });
    });

    // Plano com o padrão "fora da média" dos itens de provedor ainda sem linha no plano.
    const planoEfetivo = { itens: { ...plano.itens }, manuais: plano.manuais };
    foraPadrao.forEach(id => {
        if (!Object.prototype.hasOwnProperty.call(planoEfetivo.itens, id)) planoEfetivo.itens[id] = { etapa: null, peso: 1, recuperacaoDe: null, fora: true };
    });

    // Turma encerrada (B10): situação final. Com período letivo: terminou depois do fim.
    let periodo = null;
    if (cls && academicCalendar.isClassClosed(cls)) periodo = { encerrada: true };
    else {
        const term = cls ? academicCalendar.termForClass(mem, cls) : null;
        if (term) periodo = { fim: term.fim, hoje: hoje || null };
    }

    let planned;
    const aulasPrevistas = () => {
        if (planned === undefined) planned = cls ? academicCalendar.plannedLessons(mem, cls) : null;
        return planned;
    };
    let attendanceIndex = attendance;
    const frequenciaDe = (email) => {
        if (!attendanceIndex) attendanceIndex = classAttendanceByEmail(mem, { courseId, studentClass });
        const entry = attendanceIndex.get(String(email || '').trim().toLowerCase());
        return entry ? entry.stats : null;
    };

    const providerGroups = ({ emails = null, publishedOnly = false } = {}) => {
        const wanted = Array.isArray(emails) ? emails.map(item => String(item || '').trim().toLowerCase()).filter(Boolean) : null;
        const out = [];
        gradeItemProviderList().forEach(provider => {
            callGradeItemProvider(provider, 'entries', [mem, { course, cls, courseId, studentClass, emails: wanted, publishedOnly }]).forEach(raw => {
                const itemId = raw && typeof raw.itemId === 'string' ? raw.itemId : '';
                const item = itemById.get(itemId);
                if (!item || item.origem !== provider.origem) return;
                const email = String((raw && raw.email) || '').trim().toLowerCase();
                if (!email || (wanted && !wanted.includes(email))) return;
                const publicada = raw.publicada === true;
                if (publishedOnly && !publicada) return;
                out.push({
                    examKey: itemId,
                    applicationId: null,
                    email,
                    scopeId: `provider:${provider.origem}`,
                    origem: provider.origem,
                    score: normalizeScore(raw.score),
                    policy: null,
                    attempts: [],
                    firstAt: null,
                    lastAt: null,
                    pendingCount: publicada ? 0 : 1,
                });
            });
        });
        return out;
    };

    return {
        courseId,
        studentClass,
        course,
        cls,
        criterios,
        criterio: gradingRules.criterioForScreen(course && course.avaliacao),
        ativo: !!criterios,
        plano,
        planoEfetivo,
        itens,
        itemById,
        examIndex,
        disciplinas,
        periodo,
        applicationsById: new Map((mem.examApplications || []).map(item => [String(item && item.id), item])),
        aulasPrevistas,
        frequenciaDe,
        providerGroups,
    };
}

// Avaliação manual da turma pelo id (normalizada, com arquivadoEm quando arquivada), ou null.
function manualItemOfClass(cls, id) {
    if (!cls || !isManualItemId(id)) return null;
    return gradingRules.normalizePlan(cls.avaliacao).manuais.find(item => item.id === id) || null;
}

// O item (do contexto) do grupo, ou null.
function gradingItemOf(grading, examKey) {
    return grading && grading.itemById ? (grading.itemById.get(examKey) || null) : null;
}

// O grupo fica fora da média? Só a nota de avaliação manual arquivada (fica guardada).
function isArchivedItemGroup(grading, group) {
    const item = gradingItemOf(grading, group && group.examKey);
    return !!(item && item.arquivado);
}

// Plano efetivo de um item (com os padrões e a etapa única do curso).
function planItemView(grading, id) {
    const raw = grading.planoEfetivo.itens[id];
    const item = raw ? { etapa: raw.etapa, peso: raw.peso, recuperacaoDe: raw.recuperacaoDe || null, fora: raw.fora === true } : { etapa: null, peso: 1, recuperacaoDe: null, fora: false };
    const etapas = grading.criterios ? grading.criterios.etapas : [];
    const ordens = new Set(etapas.map(etapa => etapa.ordem));
    let etapaEfetiva = item.etapa !== null && ordens.has(item.etapa) ? item.etapa : null;
    if (item.etapa === null && etapas.length === 1) etapaEfetiva = etapas[0].ordem;
    return { ...item, etapaEfetiva };
}

// Avisos do plano que valem para a turma inteira (não dependem do aluno): avaliações sem
// etapa com duas etapas ou mais (D7 do P2). Só com critérios ligados.
function planWarnings(grading) {
    if (!grading || !grading.criterios) return [];
    const avisos = [];
    const semEtapa = grading.itens.filter(item => !item.arquivado).filter(item => {
        const plan = planItemView(grading, item.id);
        return !plan.fora && !plan.recuperacaoDe && plan.etapaEfetiva === null;
    });
    if (semEtapa.length) {
        avisos.push({
            codigo: 'itens_sem_etapa',
            texto: `${semEtapa.length === 1 ? '1 avaliação sem etapa não entra' : `${semEtapa.length} avaliações sem etapa não entram`} na média.`,
            itens: semEtapa.map(item => item.id),
        });
    }
    return avisos;
}

// Resultado de um aluno pela conta única (gradingRules): grupos de nota já consolidados
// (buildGradeGroups, mais os dos provedores) -> etapas, média final, situação e menção.
// Sem critérios, a média simples dos grupos (a de sempre). A nota de avaliação manual
// arquivada fica de fora, com aviso.
function studentGradeResult(grading, { groups = [], frequencia = null } = {}) {
    let arquivadas = 0;
    const grupos = [];
    (groups || []).forEach(group => {
        if (!group || group.score === null || group.score === undefined) return;
        if (isArchivedItemGroup(grading, group)) { arquivadas += 1; return; }
        const item = gradingItemOf(grading, group.examKey);
        const meta = grading && grading.examIndex ? grading.examIndex.get(group.examKey) : null;
        const application = group.applicationId && grading ? grading.applicationsById.get(String(group.applicationId)) : null;
        grupos.push({
            itemId: group.examKey,
            score: group.score,
            finalidade: application ? application.finalidade : undefined,
            moduloId: item ? item.moduloId : (meta ? meta.moduleId : null),
        });
    });
    const ativo = !!(grading && grading.criterios);
    const result = gradingRules.computeStudentResult({
        criterios: ativo ? grading.criterios : null,
        plano: ativo ? grading.planoEfetivo : null,
        grupos,
        frequencia,
        aulasPrevistas: ativo ? grading.aulasPrevistas() : null,
        periodo: ativo ? grading.periodo : null,
        disciplinas: ativo ? grading.disciplinas : [],
    });
    if (arquivadas) {
        result.avisos = [...result.avisos, {
            codigo: 'avaliacoes_arquivadas',
            texto: `${arquivadas === 1 ? '1 nota de avaliação arquivada não entra' : `${arquivadas} notas de avaliações arquivadas não entram`} na média.`,
        }];
    }
    return result;
}

// O que vai para a tela e para os documentos do resultado (sem as notas cruas de 0 a 100
// de cada etapa, que só servem à conta).
function resultSummary(result) {
    if (!result || result.regraAntiga) {
        return {
            etapas: [],
            mediaFinal: result ? result.mediaFinal : null,
            mediaFinalScore: result ? result.mediaFinalScore : null,
            recuperacaoFinal: null,
            situacao: null,
            situacaoRotulo: null,
            mencao: null,
            frequenciaMinima: null,
            avisos: result ? result.avisos : [],
            disciplinas: [],
        };
    }
    return {
        etapas: result.etapas.map(etapa => ({
            ordem: etapa.ordem,
            nome: etapa.nome,
            peso: etapa.peso,
            itens: etapa.itens,
            media: etapa.media,
            recuperacao: etapa.recuperacao,
            recuperacaoAplicada: etapa.recuperacaoAplicada,
            final: etapa.final,
            semNota: etapa.semNota,
            contouComoZero: etapa.contouComoZero,
        })),
        mediaFinal: result.mediaFinal,
        mediaFinalScore: result.mediaFinalScore,
        recuperacaoFinal: result.recuperacaoFinal,
        recuperacaoFinalAplicada: result.recuperacaoFinalAplicada,
        situacao: result.situacao,
        situacaoRotulo: result.situacaoRotulo,
        mencao: result.mencao,
        frequenciaMinima: result.frequenciaMinima,
        unidadeSituacao: result.unidadeSituacao,
        avisos: result.avisos,
        disciplinas: (result.disciplinas || []).map(item => ({
            id: item.id,
            nome: item.nome,
            mediaFinal: item.mediaFinal,
            situacao: item.situacao,
            situacaoRotulo: item.situacaoRotulo,
            mencao: item.mencao,
            frequencia: item.frequencia,
            frequenciaTurma: item.frequenciaTurma === true,
        })),
    };
}

// Média do aluno para a ficha, a coluna "Média" de Alunos e o risco do Dashboard
// (studentAnalytics): sem contexto, a consolidação de sempre (consolidatedStudentAverage);
// com o contexto da turma, a média final da conta única (com critérios, a ponderada por
// etapa; sem eles, a mesma média simples, sem a nota de avaliação manual arquivada e com
// os itens dos provedores). 0 a 100 ou null.
function studentAverageFor(submissions, grading, { email = '', frequencia = null } = {}) {
    if (!grading) return consolidatedStudentAverage(submissions).average;
    const groups = buildGradeGroups(submissions);
    const mail = String(email || (groups[0] && groups[0].email) || '').trim().toLowerCase();
    const extra = mail ? grading.providerGroups({ emails: [mail] }) : [];
    return studentGradeResult(grading, { groups: [...groups, ...extra], frequencia }).mediaFinalScore;
}

// Boletim de um aluno: uma linha por prova; quando a mesma prova tem mais de
// uma aplicação, uma linha por aplicação (é assim que entram na média em Resultados).
// Médias = média simples das notas consolidadas de cada aplicação, sem arredondar antes.
// grading (classGradingContext, B6 / P2-S3): as avaliações manuais e os itens dos
// provedores entram com o título deles, no módulo escolhido (ou em "Outras avaliações");
// a nota de avaliação manual arquivada aparece marcada (arquivada) e sai das médias; com
// os critérios do curso ligados, cada linha leva etapa e peso do plano, e a média geral é
// a média final da conta única (resultado: etapas, situação, menção). extraGroups: os
// grupos dos provedores (grading.providerGroups); frequencia: computeAttendanceStats do
// aluno na turma (para a situação).
function buildStudentReportModules({ submissions, allSubmissions = submissions, structure, evaluations = {}, applications = [], grading = null, extraGroups = [], frequencia = null }) {
    const examIndex = structureExamIndex(structure);
    const applicationsById = new Map((applications || []).map(item => [String(item.id), item]));
    const groups = [...buildGradeGroups(submissions), ...(extraGroups || [])].filter(group => group.score !== null).sort(compareGroups(examIndex));
    const scopesByExam = new Map();
    groups.forEach(group => {
        if (!scopesByExam.has(group.examKey)) scopesByExam.set(group.examKey, new Set());
        scopesByExam.get(group.examKey).add(group.scopeId);
    });

    const modules = (structure || []).map((module, moduleIndex) => ({
        id: structureModuleId(module, moduleIndex),
        name: module.name || module.title || module.id || `Módulo ${moduleIndex + 1}`,
        exams: [],
        scores: [],
    }));
    const moduleById = new Map(modules.map(module => [module.id, module]));
    const otherModule = { id: OTHER_MODULE_ID, name: 'Outras avaliações', exams: [], scores: [] };
    const withCriteria = !!(grading && grading.criterios);
    // Campos novos só onde valem: a linha de prova da regra antiga sai como sempre saiu.
    const itemFields = (examKey) => {
        const item = gradingItemOf(grading, examKey);
        const out = {};
        if (item && item.origem !== 'prova') {
            out.origem = item.origem;
            if (item.tipoRotulo) out.tipo = item.tipoRotulo;
        }
        if (withCriteria) {
            const plan = planItemView(grading, examKey);
            out.etapa = plan.etapaEfetiva;
            out.peso = plan.peso;
            if (plan.recuperacaoDe) out.recuperacaoDe = plan.recuperacaoDe;
            if (plan.fora) out.fora = true;
        }
        return out;
    };
    const targetFor = (examKey) => {
        const meta = examIndex.get(examKey);
        if (meta) return moduleById.get(meta.moduleId) || otherModule;
        const item = gradingItemOf(grading, examKey);
        return (item && item.moduloId && moduleById.get(item.moduloId)) || otherModule;
    };
    const titleFor = (examKey) => {
        const item = gradingItemOf(grading, examKey);
        if (item && item.origem !== 'prova') return item.titulo;
        return examTitle(examKey, { evaluations, examIndex });
    };

    // Prova da estrutura sem nota porque a entrega espera a correção do professor.
    const awaitingByExam = new Set(buildGradeGroups(submissions)
        .filter(group => group.score === null && group.aguardandoCorrecao)
        .map(group => group.examKey));
    const pendingFor = (examKey, scopeId = null) => (allSubmissions || []).filter(item => item.examKey === examKey
        && item.gradePublished !== true
        && (!scopeId || (item.applicationId ? `application:${item.applicationId}` : 'legacy') === scopeId)).length;

    const counted = [];
    groups.forEach(group => {
        const target = targetFor(group.examKey);
        const title = titleFor(group.examKey);
        const multiple = (scopesByExam.get(group.examKey)?.size || 0) > 1;
        const entry = {
            examKey: group.examKey,
            applicationId: group.applicationId,
            title: multiple ? `${title} (${scopeLabel(group, applicationsById)})` : title,
            attempts: group.attempts.length,
            pendingAttempts: pendingFor(group.examKey, multiple ? group.scopeId : null),
            grade: roundGrade(group.score),
            policy: group.policy,
            lastAt: group.lastAt,
            aguardandoCorrecao: group.aguardandoCorrecao === true,
            ...itemFields(group.examKey),
        };
        if (isArchivedItemGroup(grading, group)) {
            entry.arquivada = true;
        } else {
            target.scores.push(group.score);
            counted.push(group);
        }
        target.exams.push(entry);
    });

    // Provas da estrutura ainda sem nota publicada aparecem (com o que falta publicar).
    const emptyRow = (examKey) => ({
        examKey,
        applicationId: null,
        title: titleFor(examKey),
        attempts: 0,
        pendingAttempts: pendingFor(examKey),
        grade: null,
        policy: null,
        lastAt: null,
        aguardandoCorrecao: awaitingByExam.has(examKey),
        ...itemFields(examKey),
    });
    examIndex.forEach((meta, examKey) => {
        if (scopesByExam.has(examKey)) return;
        const target = moduleById.get(meta.moduleId);
        if (!target) return;
        target.exams.push(emptyRow(examKey));
    });
    // Avaliações manuais e itens de provedor ainda sem nota também (as arquivadas, não).
    if (grading) {
        grading.itens.filter(item => item.origem !== 'prova' && !item.arquivado && !scopesByExam.has(item.id))
            .forEach(item => targetFor(item.id).exams.push(emptyRow(item.id)));
    }
    modules.forEach(module => {
        module.exams.sort((a, b) => {
            const metaA = examIndex.get(a.examKey);
            const metaB = examIndex.get(b.examKey);
            return (metaA?.unitIndex ?? (metaA ? 0 : Infinity)) - (metaB?.unitIndex ?? (metaB ? 0 : Infinity))
                || (metaA || metaB ? 0 : String(a.title).localeCompare(String(b.title), 'pt-BR'));
        });
    });

    const all = [...modules, ...(otherModule.exams.length ? [otherModule] : [])];
    const allScores = counted.map(group => group.score);
    const result = grading ? studentGradeResult(grading, { groups, frequencia }) : null;
    // Média geral: com critérios, a média final da conta única; sem eles, a média simples
    // de sempre (a mesma que studentGradeResult dá na regra antiga).
    const overall = withCriteria ? result.mediaFinalScore : average(allScores);
    const out = {
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
    if (result) out.resultado = resultSummary(result);
    return out;
}

// Planilha da turma: uma linha por aluno, uma coluna por prova (ou por aplicação
// quando a prova foi aplicada mais de uma vez), média igual à de Resultados.
// grading (classGradingContext, B6 / P2-S3): as avaliações manuais ativas e os itens dos
// provedores ganham coluna (com nota ou não), com o título deles; a nota de avaliação
// manual arquivada aparece na coluna marcada (arquivado) e sai da média. Com os critérios
// do curso ligados, cada coluna leva etapa e peso do plano, cada linha leva etapas, média
// final, frequência, situação e menção (average passa a ser a média final), e o quadro leva
// as etapas do curso e os avisos do plano. Sem critérios, tudo como sempre (D1 do P2).
function buildClassGradebook({ students = [], submissions = [], structure = [], evaluations = {}, applications = [], grading = null }) {
    const examIndex = structureExamIndex(structure);
    const applicationsById = new Map((applications || []).map(item => [String(item.id), item]));
    const emails = (students || []).map(student => String(student.email || '').trim().toLowerCase()).filter(Boolean);
    const extraGroups = grading ? grading.providerGroups({ emails }) : [];
    const groups = [...buildGradeGroups(submissions), ...extraGroups].sort(compareGroups(examIndex));
    const withCriteria = !!(grading && grading.criterios);

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
        const item = gradingItemOf(grading, examKey);
        const itemOfOtherOrigin = item && item.origem !== 'prova' ? item : null;
        const title = itemOfOtherOrigin ? itemOfOtherOrigin.titulo : examTitle(examKey, { evaluations, examIndex });
        const meta = examIndex.get(examKey);
        const column = {
            id,
            examKey,
            applicationId: sample?.applicationId || null,
            label: scopeId ? `${title} (${scopeLabel(sample, applicationsById)})` : title,
            moduleName: meta ? meta.moduleName : (itemOfOtherOrigin ? (itemOfOtherOrigin.moduloNome || (itemOfOtherOrigin.origem === 'manual' ? MANUAL_MODULE_NAME : 'Outras avaliações')) : 'Outras avaliações'),
            // Nome da prova na estrutura do curso (só no JSON): Resultados monta a estrutura
            // por ele para quem não abre o editor de cursos (Coordenação).
            unitName: meta ? meta.unitName || '' : '',
        };
        // Campos novos só onde valem (a coluna de prova da regra antiga sai como sempre).
        if (itemOfOtherOrigin) {
            column.origem = itemOfOtherOrigin.origem;
            if (itemOfOtherOrigin.tipoRotulo) column.tipo = itemOfOtherOrigin.tipoRotulo;
            if (itemOfOtherOrigin.arquivado) column.arquivado = true;
        }
        if (withCriteria) {
            const plan = planItemView(grading, examKey);
            column.origem = item ? item.origem : 'prova';
            column.etapa = plan.etapaEfetiva;
            column.peso = plan.peso;
            column.recuperacaoDe = plan.recuperacaoDe;
            column.fora = plan.fora;
        }
        columns.push(column);
        columnIndex.set(id, columns.length - 1);
    };
    // Ordem: estrutura do curso; provas sem nota também ganham coluna. Depois as avaliações
    // manuais e os itens dos provedores (os ativos, com nota ou não; os arquivados, só com
    // nota) e, por fim, as provas fora da estrutura.
    const orderedExamKeys = [...examIndex.keys()];
    if (grading) {
        grading.itens.filter(item => item.origem !== 'prova' && (!item.arquivado || scopesByExam.has(item.id)))
            .forEach(item => orderedExamKeys.push(item.id));
    }
    const listed = new Set(orderedExamKeys);
    [...scopesByExam.keys()].filter(key => !listed.has(key)).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(key => orderedExamKeys.push(key));
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
                groups: [],
                countedGroups: [],
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
        const id = columnIdFor(group);
        const existing = row.cells[id];
        const awaiting = group.aguardandoCorrecao === true;
        if (group.score === null) {
            // Sem nota porque a entrega espera a correção: a célula diz isso (sem nota e
            // fora da média), em vez de ficar vazia como a da prova não feita.
            if (awaiting) {
                row.cells[id] = existing
                    ? { ...existing, aguardandoCorrecao: true, pending: existing.pending + group.pendingCount }
                    : { score: null, groups: 0, pending: group.pendingCount, aguardandoCorrecao: true };
            }
            return;
        }
        // Dois grupos no mesmo campo só acontecem com dados antigos inconsistentes:
        // a célula mostra a média deles e a média geral continua contando os dois.
        row.cells[id] = existing && existing.score !== null
            ? { score: (existing.score * existing.groups + group.score) / (existing.groups + 1), groups: existing.groups + 1, pending: existing.pending + group.pendingCount, aguardandoCorrecao: existing.aguardandoCorrecao || awaiting }
            : { score: group.score, groups: 1, pending: group.pendingCount + (existing ? existing.pending : 0), aguardandoCorrecao: awaiting || !!(existing && existing.aguardandoCorrecao) };
        row.groups.push(group);
        // A nota de avaliação manual arquivada fica na célula e sai da média.
        if (!isArchivedItemGroup(grading, group)) {
            row.scores.push(group.score);
            row.countedGroups.push(group);
        }
    });

    const rows = [...rowsByEmail.values()].map(row => {
        const avg = average(row.scores);
        const cells = {};
        Object.entries(row.cells).forEach(([id, cell]) => {
            cells[id] = { score: cell.score, grade: roundGrade(cell.score), pending: cell.pending, ...(cell.aguardandoCorrecao ? { aguardandoCorrecao: true } : {}) };
        });
        const out = {
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
        if (withCriteria) {
            const frequencia = grading.frequenciaDe(row.email);
            const summary = resultSummary(studentGradeResult(grading, { groups: row.groups, frequencia }));
            out.average = summary.mediaFinal;
            out.averageScore = summary.mediaFinalScore;
            out.etapas = summary.etapas;
            out.mediaFinal = summary.mediaFinal;
            out.recuperacaoFinal = summary.recuperacaoFinal;
            out.situacao = summary.situacao;
            out.situacaoRotulo = summary.situacaoRotulo;
            out.mencao = summary.mencao;
            out.frequencia = frequencia ? frequencia.frequenciaGeral : null;
            out.disciplinas = summary.disciplinas;
            out.avisos = summary.avisos.filter(entry => entry.codigo !== 'itens_sem_etapa');
        }
        return out;
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));

    const result = { columns, rows };
    if (grading) {
        result.etapas = withCriteria ? grading.criterios.etapas.map(etapa => ({ ordem: etapa.ordem, nome: etapa.nome, peso: etapa.peso })) : [];
        result.mencoes = withCriteria ? grading.criterios.mencoes : null;
        result.avisos = planWarnings(grading);
        result.resumo = gradebookSummary([...rowsByEmail.values()], rows, { criterio: grading.criterio, withCriteria, examIndex });
    }
    return result;
}

// Situações que já dizem se o aluno passou (Cursando e Sem notas ainda não).
const SITUACOES_FECHADAS = ['aprovado', 'em_recuperacao', 'reprovado_nota', 'reprovado_falta'];

// Média e aprovação de uma lista de notas (0 a 100), uma por aluno.
function scoreStats(scores, criterio) {
    const valid = scores.filter(score => score !== null && score !== undefined && Number.isFinite(Number(score))).map(Number);
    const mediaScore = average(valid);
    const acimaDaMinima = valid.filter(score => isPassingGrade(roundGrade(score), criterio) === true).length;
    return {
        media: roundGrade(mediaScore),
        mediaScore,
        // Quantos alunos têm nota na conta.
        comNota: valid.length,
        acimaDaMinima,
        aprovacao: valid.length ? Math.round((acimaDaMinima / valid.length) * 100) : null,
    };
}

// Resumo da turma para Resultados (B9; D3 e C1 do P2: a tela não faz conta de média).
// - média da turma: a média das médias dos alunos (a mesma coluna "Média" ou "Média final"
//   do quadro); aprovação: com os critérios do curso, aprovados entre os que já têm a
//   situação fechada; sem eles, alunos com média >= a média mínima;
// - porProva / porAplicacao: a mesma conta só com as notas daquela prova ou aplicação
//   (filtros de Resultados), com a nota de cada aluno nela;
// - alunos[email].porProva, porAplicacao e porModulo: a nota do aluno em cada prova, em
//   cada aplicação e a média dele em cada módulo da estrutura ('outros' para o que está
//   fora dela), para a lista e a ficha do aluno em Resultados.
// Nota de avaliação da turma arquivada fica fora de tudo, como na média do quadro.
function gradebookSummary(internalRows, rows, { criterio = null, withCriteria = false, examIndex = new Map() } = {}) {
    const geral = scoreStats(rows.map(row => row.averageScore), criterio);
    if (withCriteria) {
        const fechadas = rows.filter(row => SITUACOES_FECHADAS.includes(row.situacao));
        geral.aprovacaoPor = 'situacao';
        geral.situacoesFechadas = fechadas.length;
        geral.aprovados = fechadas.filter(row => row.situacao === 'aprovado').length;
        geral.aprovacao = fechadas.length ? Math.round((geral.aprovados / fechadas.length) * 100) : null;
    } else {
        geral.aprovacaoPor = 'media';
    }
    const alunos = {};
    const porProva = new Map();
    const porAplicacao = new Map();
    const push = (map, key, email, score) => {
        if (!map.has(key)) map.set(key, new Map());
        const byEmail = map.get(key);
        if (!byEmail.has(email)) byEmail.set(email, []);
        byEmail.get(email).push(score);
    };
    internalRows.forEach(row => {
        const prova = new Map();
        const aplicacao = new Map();
        const modulo = new Map();
        row.countedGroups.forEach(group => {
            push(porProva, group.examKey, row.email, group.score);
            if (group.applicationId) push(porAplicacao, String(group.applicationId), row.email, group.score);
            const add = (map, key) => { if (!map.has(key)) map.set(key, []); map.get(key).push(group.score); };
            add(prova, group.examKey);
            if (group.applicationId) add(aplicacao, String(group.applicationId));
            add(modulo, (examIndex.get(group.examKey) || {}).moduleId || 'outros');
        });
        const scoreMap = (map) => Object.fromEntries([...map.entries()].map(([key, scores]) => {
            const value = average(scores);
            return [key, { score: value, grade: roundGrade(value) }];
        }));
        alunos[row.email] = { porProva: scoreMap(prova), porAplicacao: scoreMap(aplicacao), porModulo: scoreMap(modulo) };
    });
    const statsMap = (map) => Object.fromEntries([...map.entries()].map(([key, byEmail]) => [
        key,
        scoreStats([...byEmail.values()].map(average), criterio),
    ]));
    return { ...geral, porProva: statsMap(porProva), porAplicacao: statsMap(porAplicacao), alunos };
}

// Planilha do quadro de notas (UXI-01, FUN-06): o mesmo cabeçalho e as mesmas linhas
// para o CSV e o XLSX. A nota vai crua (0 a 10 com uma casa, null sem nota válida);
// cada formato escreve do seu jeito ("7,5" no CSV, número com formato 0,0 no XLSX, que
// soma e faz média no Excel). Coluna nova do quadro entra aqui e sai nos dois.
// Com os critérios do curso ligados (gradebook.etapas com etapas, B6), no lugar de "Média"
// entram uma coluna por etapa, "Média final", "Frequência (%)", "Situação", "Menção" (só
// com menções no curso) e "Notas não publicadas". Sem critérios, o cabeçalho e as linhas
// de sempre, byte a byte (D1 do P2).
function gradebookSheet(gradebook) {
    if (Array.isArray(gradebook.etapas) && gradebook.etapas.length) return gradebookSheetWithCriteria(gradebook);
    const cabecalho = ['Aluno', 'E-mail', 'Matrícula', ...gradebook.columns.map(column => column.label), 'Média', 'Notas não publicadas'];
    const formatos = ['texto', 'texto', 'texto', ...gradebook.columns.map(() => 'nota'), 'nota', 'inteiro'];
    const linhas = gradebook.rows.map(row => [
        row.name,
        row.email,
        row.matricula,
        ...gradebook.columns.map(column => {
            const cell = row.cells[column.id];
            return cell ? gradeFromScore(cell.score) : null;
        }),
        row.averageScore === null ? null : gradeFromScore(row.averageScore),
        row.pendingCount,
    ]);
    return { cabecalho, formatos, linhas };
}

function gradebookSheetWithCriteria(gradebook) {
    const etapas = gradebook.etapas;
    const comMencao = Array.isArray(gradebook.mencoes) && gradebook.mencoes.length > 0;
    const cabecalho = ['Aluno', 'E-mail', 'Matrícula', ...gradebook.columns.map(column => column.label),
        ...etapas.map(etapa => etapa.nome), 'Média final', 'Frequência (%)', 'Situação', ...(comMencao ? ['Menção'] : []), 'Notas não publicadas'];
    const formatos = ['texto', 'texto', 'texto', ...gradebook.columns.map(() => 'nota'),
        ...etapas.map(() => 'nota'), 'nota', 'inteiro', 'texto', ...(comMencao ? ['texto'] : []), 'inteiro'];
    const linhas = gradebook.rows.map(row => {
        const porOrdem = new Map((row.etapas || []).map(etapa => [etapa.ordem, etapa]));
        return [
            row.name,
            row.email,
            row.matricula,
            ...gradebook.columns.map(column => {
                const cell = row.cells[column.id];
                return cell ? gradeFromScore(cell.score) : null;
            }),
            ...etapas.map(etapa => {
                const value = porOrdem.get(etapa.ordem);
                return value && value.final !== null && value.final !== undefined ? value.final : null;
            }),
            row.mediaFinal === null || row.mediaFinal === undefined ? null : row.mediaFinal,
            row.frequencia === null || row.frequencia === undefined ? null : Math.round(row.frequencia),
            row.situacaoRotulo || '',
            ...(comMencao ? [row.mencao ? row.mencao.sigla : ''] : []),
            row.pendingCount,
        ];
    });
    return { cabecalho, formatos, linhas };
}

function gradebookCsv(gradebook) {
    const { cabecalho, formatos, linhas } = gradebookSheet(gradebook);
    const lines = linhas.map(values => values.map((value, index) => {
        if (formatos[index] !== 'nota') return value;
        return value === null ? '' : value.toFixed(1).replace('.', ',');
    }));
    return buildCsv([cabecalho, ...lines]);
}

// XLSX do quadro (utils/tabularFile.js): aba com o nome da turma.
function gradebookXlsx(gradebook, { studentClass = '' } = {}) {
    const { cabecalho, formatos, linhas } = gradebookSheet(gradebook);
    return buildXlsx(linhas, { nomePlanilha: studentClass ? `Notas ${studentClass}` : 'Notas', cabecalho, formatos });
}

// ---------------------------------------------------------- auditoria
// Registro compatível com o painel "Auditoria" da ficha do aluno (field/oldValue/newValue),
// mais os identificadores da entrega para o histórico da nota em Resultados. Atalho para
// recordAudit (utils/audit.js), na categoria 'grade', com os mesmos campos de antes (a
// lixeira de notas lê details.deletedSubmission e submissionId).
function recordGradeAudit(memory, { req, actor, submission, action, field = 'Nota', oldValue = '', newValue = '', details = null, reason }) {
    if (!memory) return null;
    return recordAudit(memory, {
        req,
        actor: (actor && (actor.email || actor)) || 'desconhecido',
        action,
        category: 'grade',
        studentEmail: String(submission?.student?.email || submission?.studentEmail || '').trim().toLowerCase(),
        field,
        oldValue: String(oldValue ?? ''),
        newValue: String(newValue ?? ''),
        submissionId: submission?.id != null ? String(submission.id) : null,
        examKey: submission?.examKey || null,
        applicationId: submission?.applicationId || null,
        courseId: submission?.student?.courseId || submission?.courseId || null,
        studentClass: submission?.student?.studentClass || submission?.studentClass || null,
        reason: reason || undefined,
        details: details || undefined,
    });
}

// Motivo de uma alteração de nota (CONF-09). Com REQUIRE_REASON_AFTER_PUBLISH ligada
// (padrão da fase 2), mexer numa nota que o aluno já viu pede o motivo: despublicar ou
// excluir uma nota publicada, ou mudar a composição (desconsiderar, reconsiderar,
// escolher tentativa, regra de cálculo) de um grupo com alguma tentativa publicada. Nos
// outros casos ele é opcional. O texto vai para o campo reason da auditoria.
const REQUIRE_REASON_AFTER_PUBLISH = true;
const GRADE_REASON_MIN = 3;
const GRADE_REASON_MAX = 500;
const GRADE_REASON_REQUIRED_MESSAGE = 'Informe o motivo: esta nota já foi publicada para o aluno.';

// Lê body.reason. Devolve { ok: true, reason } (texto aparado e cortado em 500, ou '')
// ou { ok: false, status: 400, body } para a rota responder sem mudar nada.
// required: a ação mexe numa nota já publicada.
function gradeChangeReason(body, { required = false } = {}) {
    const raw = body ? body.reason : undefined;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        return { ok: false, status: 400, body: { success: false, error: 'O motivo precisa ser um texto.', field: 'reason' } };
    }
    const reason = String(raw || '').trim().slice(0, GRADE_REASON_MAX);
    if (required && REQUIRE_REASON_AFTER_PUBLISH && reason.length < GRADE_REASON_MIN) {
        const error = reason
            ? `O motivo precisa ter pelo menos ${GRADE_REASON_MIN} letras: esta nota já foi publicada para o aluno.`
            : GRADE_REASON_REQUIRED_MESSAGE;
        return { ok: false, status: 400, body: { success: false, code: 'reason_required', error, field: 'reason' } };
    }
    return { ok: true, reason };
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

function anonymizeDeletedCopy(copy, at, replacement = {}) {
    const student = copy.student && typeof copy.student === 'object' ? copy.student : {};
    const anonymized = { ...copy };
    PERSONAL_SUBMISSION_FIELDS.forEach(field => { delete anonymized[field]; });
    anonymized.student = {
        name: replacement.name || ANONYMIZED_STUDENT_NAME,
        email: replacement.email || '',
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
    const emailText = identity.replacementEmail || ANONYMIZED_ACTOR;
    let next = identity.emails.has(String(key).trim().toLowerCase()) ? emailText : String(key);
    identity.emailPatterns.forEach(pattern => { next = next.replace(pattern, emailText); });
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

// Texto do qual saiu o nome, o e-mail ou a matrícula (decisões §12, sobra do H7c): sem
// parênteses ou colchetes vazios ("pediu para sair ()"), sem espaço sobrando, e a
// preposição contraída antes do pseudônimo ("da Ana" virou "da Aluno anonimizado") passa a
// "de", "em" ou "por" ("de Aluno anonimizado 1A2B3C"), que serve a qualquer pseudônimo.
const CONTRACTION_TARGET = { da: 'de', do: 'de', das: 'de', dos: 'de', na: 'em', no: 'em', nas: 'em', nos: 'em', pela: 'por', pelo: 'por', pelas: 'por', pelos: 'por' };
function tidyScrubbedText(text, replacements = []) {
    let out = String(text);
    replacements.map(item => String(item || '').trim()).filter(Boolean).forEach(replacement => {
        out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(da|do|das|dos|na|no|nas|nos|pela|pelo|pelas|pelos)\\s+(?=${escapeRegExp(replacement)})`, 'giu'), (match, before, word) => {
            const target = CONTRACTION_TARGET[word.toLowerCase()];
            const cased = word[0] === word[0].toUpperCase() ? target[0].toUpperCase() + target.slice(1) : target;
            return `${before}${cased} `;
        });
    });
    return out
        .replace(/\(\s*\)|\[\s*\]/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,.;:!?)\]])/g, '$1')
        .replace(/([(\[])[ \t]+/g, '$1')
        .trim();
}

function scrubPersonalText(value, identity, key, owned) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        // Anonimizar (H7c): o e-mail vira o pseudônimo; apagar de vez: some (no autor,
        // "aluno excluído").
        if (identity.emails.has(trimmed.toLowerCase())) return identity.replacementEmail || (key === 'actor' ? ANONYMIZED_ACTOR : '');
        const personal = owned && !isIdentifierOrDateKey(key);
        if (personal && identity.matriculas.has(trimmed)) return '';
        let text = value;
        identity.emailPatterns.forEach(pattern => { text = text.replace(pattern, identity.replacementEmail || ANONYMIZED_ACTOR); });
        if (!personal) return text;
        identity.names.forEach(name => {
            text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), `$1${identity.replacementName || ANONYMIZED_STUDENT_NAME}`);
        });
        identity.matriculas.forEach(matricula => {
            text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(matricula)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), '$1');
        });
        return text === value ? text : tidyScrubbedText(text, [identity.replacementName || ANONYMIZED_STUDENT_NAME]);
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
// Anonimizar (H7c, utils/studentLifecycle.js): replacementEmail e replacementName (o
// pseudônimo) entram no lugar do e-mail e do nome, e as entradas do aluno ficam com
// studentEmail = pseudônimo (a ficha do cadastro anonimizado mostra a trilha dele). As
// cópias das notas na lixeira continuam anonimizadas e não restauráveis.
// Campos do cadastro (rótulos de students.js AUDITABLE_FIELDS e das rotas) cujo valor não
// identifica a pessoa. Lista do que fica: campo novo que não estiver aqui tem o valor
// apagado na anonimização. "Matrícula" é o número (dado pessoal) na edição do cadastro e
// o curso e turma na aprovação/recusa da matrícula (enrollment_*).
const NON_PERSONAL_PROFILE_FIELDS = new Set(['Status', 'Turmas', 'Unidade/instituição', 'Cadastro', 'Observação pedagógica', 'Preferências de acessibilidade']);
function keepsProfileValues(entry) {
    const field = String(entry.field || '');
    if (NON_PERSONAL_PROFILE_FIELDS.has(field)) return true;
    return field === 'Matrícula' && /^enrollment_/.test(String(entry.action || ''));
}

function anonymizeStudentAuditTrail(memory, identity = {}, { at = new Date().toISOString() } = {}) {
    if (!memory || !Array.isArray(memory.auditLogs)) return 0;
    const emails = [...new Set((identity.emails || []).map(normalizeEmailValue).filter(Boolean))];
    if (!emails.length) return 0;
    const owns = typeof identity.owns === 'function'
        ? identity.owns
        : value => emails.includes(normalizeEmailValue(value));
    const replacementEmail = normalizeEmailValue(identity.replacementEmail);
    const replacementName = String(identity.replacementName || '').trim();
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
            next.details = { ...next.details, deletedSubmission: anonymizeDeletedCopy(copy, at, { email: replacementEmail, name: replacementName }) };
        }
        // Alteração do cadastro (recordStudentAudit): o valor de nome, e-mail, telefone,
        // matrícula (o número), nascimento e afins é o próprio dado pessoal e sai. Os de
        // situação, turma, curso e matrícula em curso ficam (decisões §12, sobra do H7c);
        // o nome ou e-mail citado dentro deles sai no scrub abaixo.
        const profileChange = aboutStudent && !next.type && next.category !== 'grade' && !String(next.action || '').startsWith('grade_') && 'field' in next;
        if (profileChange && !keepsProfileValues(next)) { next.oldValue = ''; next.newValue = ''; }
        const scrubIdentity = {
            emails: new Set(entryEmails),
            emailPatterns: entryEmails.map(email => patterns.get(email)),
            names: sortedNames,
            matriculas,
            replacementEmail,
            replacementName,
        };
        next = scrubPersonalText(next, scrubIdentity, '', aboutStudent || byStudent);
        // Entrada gravada pelo próprio aluno (aceite dos documentos e data/responsável no
        // primeiro acesso, H8a-2; troca de senha...): o IP e o aparelho são dele, como na
        // presença (studentLifecycle.anonymizedAttendance). Os do professor ficam.
        if (byStudent) { delete next.ip; delete next.device; }
        if (aboutStudent) {
            next.studentEmail = replacementEmail;
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

// Duração em português, para o registro da aplicação: "36 s", "3 min 5 s", "22 min",
// "1 h 5 min".
function durationLabel(ms) {
    const seconds = Math.max(0, Math.round(Number(ms) / 1000) || 0);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        const rest = seconds % 60;
        return rest && minutes < 10 ? `${minutes} min ${rest} s` : `${minutes} min`;
    }
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`;
}

// Por que o servidor ficou fora do ar (utils/serverLifecycle.js).
const OUTAGE_REASON_LABELS = {
    restart: 'reinício',
    crash: 'queda do servidor',
    suspended: 'computador suspenso ou travado',
};

function describeExamAudit(entry) {
    const details = entry.details || {};
    const join = (...parts) => parts.filter(Boolean).join(' · ');
    switch (entry.type) {
        case 'exam_application_server_outage': {
            const reason = OUTAGE_REASON_LABELS[details.reason];
            const limit = Number(details.maxMinutes) > 0 ? Number(details.maxMinutes) : 15;
            return {
                title: 'Servidor fora do ar durante a prova',
                detail: `Fora do ar por ${durationLabel(details.durationMs)}${reason ? ` (${reason})` : ''}. `
                    + (details.compensated === false
                        ? `Tempo não devolvido (mais de ${limit} min).`
                        : 'Tempo devolvido a todos.'),
            };
        }
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
    tidyScrubbedText,
    ANONYMIZED_STUDENT_NAME,
    CSV_BOM,
    DEFAULT_GRADE_CRITERION,
    GRADE_BANDS,
    GRADE_MAX,
    GRADE_REASON_MAX,
    GRADE_REASON_MIN,
    GRADE_REASON_REQUIRED_MESSAGE,
    MANUAL_TYPES,
    REQUIRE_REASON_AFTER_PUBLISH,
    MANUAL_ITEM_PREFIX,
    MANUAL_MODULE_NAME,
    MANUAL_TYPE_LABELS,
    buildClassGradebook,
    buildCsv,
    classAttendanceByEmail,
    classGradingContext,
    courseForContext,
    gradeItemProviderList,
    isManualItemId,
    newManualItemId,
    manualAssessmentTitle,
    manualAssessmentTitleForSubmission,
    manualItemOfClass,
    planItemView,
    planWarnings,
    registerGradeItemProvider,
    resultSummary,
    studentAverageFor,
    studentGradeResult,
    buildGradeGroups,
    anonymizeStudentAuditTrail,
    anonymizeStudentExamRecords,
    studentEmailOwnership,
    buildApplicationAuditTrail,
    buildStudentReportModules,
    consolidatedStudentAverage,
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
    formatMinimumGrade,
    gradeBand,
    gradeCountsMismatch,
    gradeCriterionFor,
    gradeChangeReason,
    gradeFromScore,
    gradebookCsv,
    gradebookSheet,
    gradebookXlsx,
    isEmptyInput,
    isPassingGrade,
    normalizeGradeCriterion,
    parseCountInput,
    performanceBucket,
    parseGradeInput,
    recordGradeAudit,
    safeFilePart,
    scopeLabel,
    scopeSubmissionsToContext,
    scoreFromCounts,
    scoreFromGrade,
    structureExamIndex,
    structureModuleId,
    structureModuleIds,
    attendanceAllowanceFor,
    studentMemberships,
    submissionMatchesContext,
    withResolvedContext,
};
