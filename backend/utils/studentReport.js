// Boletim de um aluno (fase 3, B6 / P2-S3; contrato modulos_unicos do plano e C6 do P4):
// buildStudentReport monta o boletim que GET /api/admin/student/report devolve, para ser
// lido também pelo aviso ao responsável (P5-S8), pelo boletim em lote (P4-S10) e pelo
// autoatendimento do aluno (P4-S13), sem copiar a conta. Extraído de routes/admin.js sem
// mudar a saída (teste de igualdade em test/backend/notas-sem-criterios-igual.test.js); o
// B6 acrescenta as etapas, a média final, a situação e a menção da conta única
// (gradebook.js + gradingRules.js), e buildStudentGradesSummary dá o mesmo resultado ao
// portal do aluno (GET /api/student/grades-summary, só notas publicadas).
//
// Quem chama confere antes quem pode ver o aluno (escopo da conta, sessão do aluno) e se a
// conta lê nota (withGrades: Professor auxiliar não lê, canReadStudentGrades).
const { findClassByNameAndCourse } = require('../middlewares.js');
const { effectiveStructure } = require('./classContent.js');
const attendanceUtil = require('./attendance.js');
const settingsUtil = require('./settings.js');
const studentIdentity = require('./studentIdentity.js');
const { effectiveBrandingFor } = require('./branding.js');
const {
    attendanceAllowanceFor,
    buildStudentReportModules,
    classAttendanceByEmail,
    classGradingContext,
    formatMinimumGrade,
    gradeCriterionFor,
    resultSummary,
    scopeSubmissionsToContext,
} = require('./gradebook.js');

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function gradeScope(memory, courseId, studentClass) {
    return { courseId, studentClass, students: memory.students || [], classes: memory.classes || [] };
}

// Matrículas do aluno como { name, courseId } (formato antigo: turma em texto e curso no
// cadastro).
function memberships(student) {
    return (Array.isArray(student.classes) && student.classes.length ? student.classes : (student.studentClass ? [student.studentClass] : []))
        .map(item => typeof item === 'string'
            ? { name: item, courseId: String(student.courseId || '') }
            : { name: item?.name || item?.className || '', courseId: String(item?.courseId || student.courseId || '') })
        .filter(item => item.name);
}

// A matrícula do boletim: a do curso (e turma) pedidos; sem pedido, a primeira. Devolve
// { ok: true, cls, course, courseId, className, structure } ou { ok: false, status, error }.
function resolveReportContext(memory, student, { courseId = '', studentClass = '' } = {}) {
    const requestedCourseId = text(courseId);
    const requestedClass = text(studentClass);
    const list = memberships(student);
    const inCourse = item => !requestedCourseId || !item.courseId || item.courseId === requestedCourseId;
    let membership;
    if (requestedCourseId || requestedClass) {
        membership = list.find(item => inCourse(item) && (!requestedClass || item.name === requestedClass))
            || list.find(inCourse);
        if (!membership) return { ok: false, status: 400, error: 'O aluno não tem matrícula no curso selecionado.' };
    } else {
        membership = list[0] || { name: student.studentClass || '', courseId: '' };
    }
    const classes = memory.classes || [];
    const cls = findClassByNameAndCourse(classes, membership.name, membership.courseId || requestedCourseId)
        || classes.find(c => c.name === membership.name) || null;
    const resolvedCourseId = String((cls && cls.courseId) || membership.courseId || requestedCourseId || '');
    const course = (memory.courses || []).find(c => String(c.id) === resolvedCourseId) || null;
    const className = cls?.name || membership.name || '';
    const structure = effectiveStructure(resolvedCourseId, cls?.name)?.structure || course?.structure || [];
    return { ok: true, cls, course, courseId: resolvedCourseId, className, structure };
}

// Notas do aluno na turma pela conta única: as entregas dele no curso/turma (registro
// antigo completado) e, com publishedOnly, só as publicadas na conta (o boletim e o aluno
// veem só o publicado). Devolve { grading, contextSubmissions, report, attendanceRows,
// stats }.
function studentGradingData(memory, { email, course, cls, courseId, className, structure, withGrades = true, hoje = null }) {
    const attendanceIndex = classAttendanceByEmail(memory, { courseId, studentClass: cls ? cls.name : '' });
    const attendance = attendanceIndex.get(email) || { records: [], stats: attendanceUtil.computeAttendanceStats([]) };
    const grading = classGradingContext(memory, { course, cls, structure, hoje: hoje || settingsUtil.today(), attendance: attendanceIndex });
    const ownSubmissions = !withGrades ? [] : (memory.submissions || []).filter(s => s.student && String(s.student.email || '').toLowerCase() === email);
    const contextSubmissions = scopeSubmissionsToContext(ownSubmissions, gradeScope(memory, courseId, className));
    const report = !withGrades ? null : buildStudentReportModules({
        submissions: contextSubmissions.filter(s => s.gradePublished === true),
        allSubmissions: contextSubmissions,
        structure,
        evaluations: memory.evaluations || {},
        applications: memory.examApplications || [],
        grading,
        extraGroups: grading.providerGroups({ emails: [email], publishedOnly: true }),
        frequencia: attendance.stats,
    });
    return { grading, contextSubmissions, report, attendanceRows: attendance.records, stats: attendance.stats };
}

// Campos da conta única no boletim (B6): com critérios, as etapas, a média final, a
// situação e a menção; sem critérios (ou sem nota para quem não lê nota), vazios, e a média
// final é a média geral de sempre.
function gradingFields(report) {
    const resultado = report && report.resultado ? report.resultado : resultSummary(null);
    return {
        etapas: resultado.etapas,
        mediaFinal: report ? report.overallAverage : null,
        recuperacaoFinal: resultado.recuperacaoFinal,
        situacao: resultado.situacao,
        situacaoRotulo: resultado.situacaoRotulo,
        mencao: resultado.mencao,
        situacaoPorDisciplina: resultado.disciplinas,
        avisosNotas: resultado.avisos.map(entry => entry.texto),
    };
}

// Boletim consolidado do aluno (provas por módulo + frequência por disciplina), pronto
// para a tela imprimir/salvar em PDF. Só notas publicadas entram na média. As notas usam
// a mesma consolidação da tela Resultados: cada aplicação da prova é um grupo com a regra
// escolhida pelo professor, e a média é a dos grupos (UXI-X1, FUN-X1); com os critérios
// do curso ligados, a média final ponderada por etapa (B6).
// options: { student (o cadastro), courseId, studentClass, withGrades, issuedBy, hoje }.
// Devolve { ok: true, report } ou { ok: false, status, error }.
function buildStudentReport(memory, { student, courseId = '', studentClass = '', withGrades = true, issuedBy = 'Instrutor', hoje = null } = {}) {
    if (!student) return { ok: false, status: 404, error: 'Aluno não encontrado.' };
    const email = String(student.email || '').trim().toLowerCase();
    const context = resolveReportContext(memory, student, { courseId, studentClass });
    if (!context.ok) return context;
    const { cls, course, className, structure } = context;
    const resolvedCourseId = context.courseId;

    // Conta que não lê nota (Professor auxiliar, canReadStudentGrades): o boletim vem sem
    // as provas (modules vazio, overallAverage null, gradesHidden: true); a frequência e o
    // progresso continuam.
    const data = studentGradingData(memory, { email, course, cls, courseId: resolvedCourseId, className, structure, withGrades, hoje });
    const { modules, overallAverage } = data.report || { modules: [], overallAverage: null };
    const { attendanceRows, stats } = data;
    // Aulas previstas no período letivo da turma e faltas que ainda pode ter (B5 / P2-S7,
    // C8 do P2): null sem período letivo; as faltas restantes, só com a frequência mínima
    // dos critérios do curso, e contando só as faltas de dentro das datas do período (a
    // frequência mostrada continua sendo a de todas as aulas lançadas).
    const allowance = attendanceAllowanceFor(memory, { course, cls, records: attendanceRows });
    const discById = {};
    ((course && course.disciplinas) || []).forEach(d => { if (d && d.id) discById[d.id] = d; });
    const disciplineRow = (id, value) => {
        const disciplina = discById[id] || null;
        return {
            id,
            name: (disciplina && disciplina.nome) || id || 'Sem disciplina',
            ...value,
            cargaHoraria: disciplina && Number.isInteger(disciplina.cargaHoraria) ? disciplina.cargaHoraria : null,
            professor: (disciplina && disciplina.professor) || '',
            ...allowance.disciplina(id, value.faltas),
        };
    };
    const disciplines = Object.entries(stats.porDisciplina).map(([id, value]) => disciplineRow(id, value));
    // Disciplina do curso ainda sem chamada lançada (começo do período) também entra, quando
    // tem o que mostrar: carga horária ou aula prevista no período. Sem nenhum dos dois
    // (curso antigo, sem período), o boletim fica como sempre foi.
    const listed = new Set(disciplines.map(item => item.id));
    const previstas = new Set(allowance.disciplinasPrevistas);
    ((course && course.disciplinas) || []).forEach(d => {
        if (!d || !d.id || listed.has(d.id)) return;
        if (!Number.isInteger(d.cargaHoraria) && !previstas.has(d.id)) return;
        listed.add(d.id);
        disciplines.push(disciplineRow(d.id, { presentes: 0, faltas: 0, total: 0, frequencia: null }));
    });
    const progressMap = (memory.progress && memory.progress[email]) || {};
    const unitKeys = structure.flatMap(module => (module.units || module.items || []).map(unit => unit.apostilaKey).filter(Boolean));
    const completedUnits = unitKeys.filter(key => Array.isArray(progressMap[key]) ? progressMap[key].length > 0 : !!progressMap[key]).length;
    const school = (memory.schools || []).find(s => s.id === (course && course.schoolId)) || null;

    const report = {
        ...(withGrades ? {} : { gradesHidden: true }),
        generatedAt: Date.now(),
        institution: (school && (school.name || school.info?.tradeName)) || memory.branding?.displayName || memory.branding?.institutionName || 'IClass',
        // Boletim impresso: o aluno sem e-mail aparece com 'sem e-mail' (C1 / P4-S3).
        student: { name: student.name, nomeSocial: student.nomeSocial || '', email: studentIdentity.publicStudentEmail(student), matricula: student.matricula || '', status: student.status || '' },
        course: { id: resolvedCourseId, name: course?.name || resolvedCourseId || '' },
        className,
        period: cls?.period || student.period || '',
        modules,
        overallAverage,
        // Critério de nota da matrícula (C1 do P2): a nota em vermelho do boletim é a que
        // fica abaixo de criterio.mediaMinima (sem critérios, o padrão 6,0).
        criterio: gradeCriterionFor(memory, { courseId: resolvedCourseId, studentClass: className }),
        ...gradingFields(data.report),
        periodoLetivo: allowance.periodoLetivo,
        attendance: {
            frequency: stats.frequenciaGeral,
            presentes: stats.presentes,
            faltas: stats.faltasContam,
            totalAulas: stats.totalAulas,
            days: attendanceRows.length,
            disciplines,
            riskThreshold: attendanceUtil.effectiveAttendanceConfig(cls).limiarRiscoPct,
            aulasPrevistas: allowance.aulasPrevistas,
            frequenciaMinima: allowance.frequenciaMinima,
            faltasNoPeriodo: allowance.faltasNoPeriodo,
            faltasPermitidasRestantes: allowance.faltasPermitidasRestantes,
        },
        progress: { completedUnits, totalUnits: unitKeys.length },
        issuedBy,
        // Cabeçalho e rodapé do boletim impresso (printDocument, C5 do P4): a identidade da
        // escola do curso DESTE boletim (a mesma de GET /api/branding?courseId=) e o fuso
        // da escola (settings.timezone) para a data do rodapé. A tela não usa a identidade
        // do curso aberto no painel, que pode ser outro (ficha do aluno com outra matrícula).
        identidade: reportIdentity(memory, resolvedCourseId),
        fuso: settingsUtil.getSettings().timezone,
    };
    return { ok: true, report };
}

// Resumo de notas do aluno no portal (GET /api/student/grades-summary, B6; contratos C1 e
// C8 do P2): só o que já foi publicado, pela mesma conta do boletim. O aluno vê a média
// final, a situação ('Cursando' enquanto falta nota de etapa), a menção, as notas por etapa
// (com critérios) ou por módulo (sem eles), a frequência e as faltas que ainda pode ter.
// A tela não recalcula nada (D3 do P2).
// options: { email (o da sessão), course, cls, hoje }.
// Só o que o documento impresso usa da identidade efetiva (schoolFromBranding na tela).
function reportIdentity(memory, courseId) {
    const { effective } = effectiveBrandingFor(memory, { courseId });
    return {
        displayName: effective.displayName || '',
        schoolName: effective.schoolName || '',
        institution: effective.institution || {},
        logoLightUrl: effective.logoLightUrl || '',
        logoUrl: effective.logoUrl || '',
    };
}

function buildStudentGradesSummary(memory, { email, course = null, cls = null, hoje = null } = {}) {
    const mail = String(email || '').trim().toLowerCase();
    const courseId = String((cls && cls.courseId) || (course && course.id) || '');
    const className = cls ? cls.name : '';
    const structure = effectiveStructure(courseId, className)?.structure || course?.structure || [];
    const data = studentGradingData(memory, { email: mail, course, cls, courseId, className, structure, withGrades: true, hoje });
    const report = data.report;
    const resultado = report.resultado || resultSummary(null);
    const allowance = attendanceAllowanceFor(memory, { course, cls, records: data.attendanceRows });
    const ativo = data.grading.ativo;
    const etapaNome = new Map((resultado.etapas || []).map(etapa => [etapa.ordem, etapa.nome]));

    const itens = [];
    report.modules.forEach(module => module.exams.forEach(exam => {
        if (exam.arquivada) return;
        const item = data.grading.itemById.get(exam.examKey) || null;
        itens.push({
            id: exam.examKey,
            titulo: exam.title,
            origem: exam.origem || 'prova',
            tipo: exam.tipo || null,
            moduloId: module.id === '__outras__' ? null : module.id,
            modulo: module.name,
            disciplinaId: item ? item.disciplinaId : null,
            disciplina: item ? item.disciplinaNome : null,
            etapa: ativo ? (exam.etapa === undefined ? null : exam.etapa) : null,
            etapaNome: ativo && exam.etapa ? (etapaNome.get(exam.etapa) || null) : null,
            peso: ativo ? exam.peso : null,
            recuperacao: ativo && !!exam.recuperacaoDe,
            // De qual etapa é a recuperação ('etapa:N' ou 'final'): Minhas notas mostra a
            // avaliação dentro da etapa que ela recupera.
            recuperacaoDe: ativo && exam.recuperacaoDe ? exam.recuperacaoDe : null,
            foraDaMedia: (ativo && exam.fora === true) || exam.foraDaMedia === true,
            nota: exam.grade,
            publicada: exam.grade !== null,
        });
    }));

    return {
        courseId,
        studentClass: className,
        criterio: data.grading.criterio,
        regraAntiga: !ativo,
        etapas: resultado.etapas.map(etapa => ({ ordem: etapa.ordem, nome: etapa.nome, peso: etapa.peso, media: etapa.media, recuperacao: etapa.recuperacao, final: etapa.final, semNota: etapa.semNota })),
        modulos: report.modules.map(module => ({ id: module.id, nome: module.name, media: module.average })),
        itens,
        mediaFinal: report.overallAverage,
        recuperacaoFinal: resultado.recuperacaoFinal,
        situacao: resultado.situacao,
        situacaoRotulo: resultado.situacaoRotulo,
        mencao: resultado.mencao,
        situacaoPorDisciplina: resultado.disciplinas.map(item => ({ id: item.id, nome: item.nome, mediaFinal: item.mediaFinal, situacao: item.situacao, situacaoRotulo: item.situacaoRotulo, mencao: item.mencao })),
        frequencia: data.stats.frequenciaGeral,
        frequenciaMinima: allowance.frequenciaMinima,
        aulasPrevistas: allowance.aulasPrevistas,
        faltasPermitidasRestantes: allowance.faltasPermitidasRestantes,
        periodoLetivo: allowance.periodoLetivo,
        notasPublicadas: report.gradedCount,
        // "Média mínima para aprovação: 6,0" (a tela não formata a regra).
        mediaMinimaTexto: formatMinimumGrade(data.grading.criterio),
    };
}

module.exports = {
    buildStudentGradesSummary,
    buildStudentReport,
    resolveReportContext,
};
