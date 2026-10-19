// Painel do aluno — Etapa 1: cálculo consolidado de indicadores a partir dos dados existentes.
// Frequência: por aula, geral e por disciplina (ver backend/utils/attendance.js).

const attendanceUtil = require('./attendance.js');
const { normalizeScore } = require('./submissionAttempts.js');
const {
    buildStudentReportModules,
    consolidatedStudentAverage,
    createSubmissionContextResolver,
    studentMemberships,
    submissionMatchesContext,
    withResolvedContext,
} = require('./gradebook.js');

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function studentClassNames(student) {
    const raw = student && Array.isArray(student.classes) && student.classes.length
        ? student.classes : (student && student.studentClass ? [student.studentClass] : []);
    return raw.map(c => typeof c === 'string' ? c : (c && c.name)).filter(Boolean);
}

function courseIdOfStudent(memory, student) {
    const names = studentClassNames(student);
    const cls = (memory.classes || []).find(c => names.includes(c.name));
    return cls ? cls.courseId : null;
}

function courseUnitStats(memory, courseId) {
    const course = (memory.courses || []).find(c => c.id === courseId);
    const structure = (course && course.structure) || memory.courseStructure || [];
    let units = 0, exams = 0;
    structure.forEach(mod => (mod.units || []).forEach(u => { units++; if (u.avaliacaoKey) exams++; }));
    return { units, exams };
}

// Média (0–10) das provas. null quando não há prova — "sem avaliação" não é nota zero.
// É a consolidação de Resultados e do boletim (backend/utils/gradebook.js): cada
// aplicação da prova conta uma vez, pela regra escolhida (maior, última, média ou
// escolhida), e nota inválida de registro antigo fica fora. Antes era a média simples
// de todas as tentativas, e a ficha, Alunos e o boletim mostravam médias diferentes.
// As entregas chegam já recortadas e com curso/turma completados (scopeSubmissions).
function mediaOf(subs) {
    const { average } = consolidatedStudentAverage(subs);
    return average === null ? null : average / 10;
}

// Entregas do aluno no curso/turma pedidos, com curso e turma de registros antigos
// completados como em Resultados (o banco não muda). Sem curso nem turma, todas.
function scopeSubmissions(subs, { courseId = '', studentClass = '' } = {}, resolve) {
    return (subs || [])
        .filter(item => submissionMatchesContext(item, { courseId, studentClass }, resolve))
        .map(item => withResolvedContext(item, resolve));
}

// Curso e turma da ficha: a matrícula do aluno no curso (e turma) pedidos; sem pedido
// ou sem matrícula nele, a primeira matrícula (como o boletim).
function studentScope(memory, student, { courseId = '', studentClass = '' } = {}) {
    const memberships = studentMemberships(student);
    const wantedCourse = String(courseId || '').trim();
    const wantedClass = String(studentClass || '').trim();
    const inCourse = item => !wantedCourse || !item.courseId || item.courseId === wantedCourse;
    const membership = ((wantedCourse || wantedClass)
        ? memberships.find(item => inCourse(item) && (!wantedClass || item.name === wantedClass)) || memberships.find(inCourse)
        : null) || memberships[0] || null;
    if (!membership) return { courseId: '', studentClass: '' };
    const classes = memory.classes || [];
    const cls = classes.find(c => c.name === membership.name && (!membership.courseId || String(c.courseId || '') === membership.courseId))
        || classes.find(c => c.name === membership.name);
    return { courseId: String((cls && cls.courseId) || membership.courseId || ''), studentClass: membership.name };
}
// Arredonda para 1 casa preservando null (sem dado continua sem dado).
const round1 = (v) => v == null ? null : Math.round(v * 10) / 10;

// Um dia conta como presença (streak/dias ativos) se tiver ao menos 1 aula presente.
function isPresentAtt(a) {
    if (!a) return false;
    return attendanceUtil.recordHasPresence(a);
}

// Índice por e-mail de presenças e submissões. Sem ele, calcular a visão geral de N
// alunos custa N × (presenças + submissões) — 800 alunos levavam ~17s e bloqueavam o
// event loop. Construir uma vez por requisição torna o custo linear.
function buildOverviewIndex(memory) {
    const att = new Map();
    (memory.attendance || []).forEach(a => {
        const e = String(a.studentEmail || '').trim().toLowerCase();
        if (!e) return;
        if (!att.has(e)) att.set(e, []);
        att.get(e).push(a);
    });
    const subs = new Map();
    (memory.submissions || []).forEach(s => {
        const e = s && s.student && s.student.email ? String(s.student.email).trim().toLowerCase() : '';
        if (!e) return;
        if (!subs.has(e)) subs.set(e, []);
        subs.get(e).push(s);
    });
    // Curso/turma de registros antigos, resolvidos uma vez por requisição.
    const resolve = createSubmissionContextResolver({ students: memory.students || [], classes: memory.classes || [] });
    return { att, subs, resolve };
}

// Registros de presença de um aluno, opcionalmente restritos a um curso.
// Deduplicados por data (chamada > manual > login) para não contar em dobro.
function attendanceRecordsFor(memory, email, courseId = '', index = null) {
    const e = String(email || '').trim().toLowerCase();
    const cid = String(courseId || '').trim();
    const doAluno = index
        ? (index.att.get(e) || [])
        : (memory.attendance || []).filter(a => String(a.studentEmail || '').trim().toLowerCase() === e);
    const filtered = doAluno.filter(a => (!cid || !a.courseId || String(a.courseId) === cid));
    return attendanceUtil.dedupeByDate(filtered);
}

// Limiar de risco de frequência (%) da turma do aluno, com fallback 75.
function riskThreshold(memory, student, courseId) {
    const names = student ? studentClassNames(student) : [];
    const cls = (memory.classes || []).find(c => names.includes(c.name) && (!courseId || String(c.courseId) === String(courseId)))
        || (memory.classes || []).find(c => names.includes(c.name));
    return attendanceUtil.effectiveAttendanceConfig(cls).limiarRiscoPct;
}

// Frequência geral (%) por aula. null quando não há aulas lançadas.
function freqPct(memory, email, courseId = '') {
    return attendanceUtil.computeAttendanceStats(attendanceRecordsFor(memory, email, courseId)).frequenciaGeral;
}

// Total cumulativo de faltas que contam (falta + justificada não abonada), por aula.
function absenceCount(memory, email, courseId = '') {
    return attendanceUtil.computeAttendanceStats(attendanceRecordsFor(memory, email, courseId)).faltasContam;
}

// options: { courseId, studentClass } do curso/turma ativos (a ficha do aluno manda os
// da área de trabalho do professor). As notas são as dessa matrícula.
function computeStudentDashboard(memory, email, options = {}) {
    email = String(email || '').trim().toLowerCase();
    const student = (memory.students || []).find(s => s.email && s.email.toLowerCase() === email) || null;
    const resolve = createSubmissionContextResolver({ students: memory.students || [], classes: memory.classes || [] });
    const scope = student ? studentScope(memory, student, options) : { courseId: '', studentClass: '' };
    const ownSubs = (memory.submissions || []).filter(s => s.student && s.student.email && s.student.email.toLowerCase() === email);
    const subs = scopeSubmissions(ownSubs, scope, resolve);
    const names = student ? studentClassNames(student) : [];
    const courseId = scope.courseId || (student ? courseIdOfStudent(memory, student) : null);
    const unitStats = courseUnitStats(memory, courseId);

    const progressMap = (memory.progress && memory.progress[email]) || {};
    // Uma unidade só conta como concluída se tiver progresso real: array vazio não é "feito".
    const isDone = (v) => Array.isArray(v) ? v.length > 0 : !!v;
    const completed = Object.keys(progressMap).filter(k => isDone(progressMap[k])).length;
    const media = mediaOf(subs);
    const stats = attendanceUtil.computeAttendanceStats(attendanceRecordsFor(memory, email, courseId));
    const limiar = riskThreshold(memory, student, courseId);
    // null = sem chamada lançada (desconhecido), distinto de 0% de presença.
    const frequencia = stats.frequenciaGeral;
    const kpis = {
        frequencia,
        media: round1(media),
        progresso: unitStats.units ? Math.round((completed / unitStats.units) * 100) : 0,
        // Provas diferentes com entrega (várias tentativas da mesma prova contam uma vez).
        provasFeitas: consolidatedStudentAverage(subs).examsDone,
        provasTotais: unitStats.exams,
    };

    // "Desempenho por módulo" da ficha: as mesmas entregas e a mesma consolidação da
    // média geral (grupo por aplicação, regra da prova, notas inválidas fora), agrupadas
    // pelos módulos da estrutura do curso, como no boletim. Antes a tela fazia a média
    // simples de todas as tentativas e mostrava outro número ao lado da média geral.
    const structure = (typeof options.structureFor === 'function' && options.structureFor(courseId, scope.studentClass))
        || ((memory.courses || []).find(c => String(c.id) === String(courseId))?.structure)
        || [];
    const modulos = buildStudentReportModules({
        submissions: subs,
        structure,
        evaluations: memory.evaluations || {},
        applications: memory.examApplications || [],
    }).modules
        .filter(module => module.average !== null)
        .map(module => ({ id: module.id, modulo: module.name, media: module.average }));

    // Frequência por disciplina (nome vindo do curso), marcando em risco.
    const discNome = {};
    ((memory.courses || []).find(c => String(c.id) === String(courseId))?.disciplinas || []).forEach(d => { discNome[d.id] = d.nome; });
    const frequenciaDisciplinas = Object.entries(stats.porDisciplina)
        .filter(([did]) => did) // ignora aulas legadas sem disciplina
        .map(([did, v]) => ({ disciplinaId: did, nome: discNome[did] || did, frequencia: v.frequencia, presentes: v.presentes, faltas: v.faltas, total: v.total, emRisco: v.frequencia != null && v.frequencia < limiar }))
        .sort((a, b) => (a.frequencia ?? 101) - (b.frequencia ?? 101));

    // Comparativo com a turma
    const turma = (memory.students || []).filter(s => s.email && studentClassNames(s).some(n => names.includes(n)));
    const turmaMedias = [], turmaFreqs = [];
    turma.forEach(s => {
        const e = s.email.toLowerCase();
        const ss = scopeSubmissions((memory.submissions || []).filter(x => x.student && x.student.email && x.student.email.toLowerCase() === e), scope, resolve);
        // Colega só com notas inválidas (registro antigo) não tem média: não entra como 0.
        const media = ss.length ? mediaOf(ss) : null;
        if (media !== null) turmaMedias.push(media);
        const f = freqPct(memory, e, courseId);
        if (f != null) turmaFreqs.push(f);
    });
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const comparativo = {
        studentMedia: kpis.media,
        turmaMedia: Math.round(avg(turmaMedias) * 10) / 10,
        studentFreq: frequencia,
        turmaFreq: Math.round(avg(turmaFreqs)),
        turmaSize: turma.length,
    };

    // Risco de evasão (frequência só pesa quando há aulas lançadas; usa limiar da turma)
    const reasons = [];
    const disciplinasEmRisco = frequenciaDisciplinas.filter(d => d.emRisco);
    if (stats.totalAulas > 0 && stats.frequenciaGeral != null && stats.frequenciaGeral < limiar) reasons.push(`Frequência baixa (${frequencia}%)`);
    if (disciplinasEmRisco.length) reasons.push(`Baixa frequência em ${disciplinasEmRisco.map(d => d.nome).join(', ')}`);
    if (media != null && media < 6) reasons.push(`Média abaixo de 6 (${kpis.media})`);
    const lastAccess = student && (student.lastLoginAt || student.lastSeenAt);
    const daysSince = lastAccess ? Math.floor((Date.now() - lastAccess) / 86400000) : null;
    if (daysSince !== null && daysSince > 14) reasons.push(`Sem acesso há ${daysSince} dias`);
    let level = 'baixo';
    if ((stats.totalAulas > 0 && stats.frequenciaGeral != null && stats.frequenciaGeral < Math.max(0, limiar - 25)) || reasons.length >= 2) level = 'alto';
    else if (reasons.length === 1) level = 'medio';
    const risco = { level, reasons };

    // Engajamento — acessos por semana (últimas 6) + dias ativos (30d)
    const weeks = [];
    for (let w = 5; w >= 0; w--) {
        const start = new Date(Date.now() - (w * 7 + 6) * 86400000);
        const end = new Date(Date.now() - w * 7 * 86400000);
        const count = (memory.moduleAccess || []).filter(m => m.studentEmail === email && m.timestamp >= start.getTime() && m.timestamp <= end.getTime()).length;
        weeks.push({ label: `S${6 - w}`, count });
    }
    const activeDays = new Set();
    const cutoff30 = Date.now() - 30 * 86400000;
    (memory.moduleAccess || []).forEach(m => { if (m.studentEmail === email && m.timestamp >= cutoff30) activeDays.add(ymd(new Date(m.timestamp))); });
    (memory.attendance || []).forEach(a => { if (a.studentEmail === email && a.timestamp >= cutoff30 && isPresentAtt(a)) activeDays.add(a.date); });
    const engajamento = { weeks, diasAtivos: activeDays.size };

    // Streak de presença (dias consecutivos até hoje/ontem) + recorde
    const presDays = [...new Set((memory.attendance || []).filter(a => a.studentEmail === email && a.date && isPresentAtt(a)).map(a => a.date))].sort();
    let recorde = 0, run = 0, prev = null, atual = 0;
    presDays.forEach(ds => {
        if (prev && (new Date(ds) - new Date(prev)) === 86400000) run++; else run = 1;
        if (run > recorde) recorde = run;
        prev = ds;
    });
    if (presDays.length) {
        const last = presDays[presDays.length - 1];
        const diff = Math.floor((new Date(ymd(new Date())) - new Date(last)) / 86400000);
        atual = diff <= 1 ? run : 0;
    }
    const streak = { atual, recorde };

    // Comparação temporal: janelas móveis de 30 dias (últimos 30 x 30 anteriores).
    // Meses de calendário enviesam o comparativo — no dia 5, "mês atual" teria 5 dias contra 30.
    const nowMs = Date.now();
    const inWindow = (t, startDaysAgo, endDaysAgo) =>
        t > nowMs - startDaysAgo * 86400000 && t <= nowMs - endDaysAgo * 86400000;
    const subsWindow = (startDaysAgo, endDaysAgo) =>
        subs.filter(s => inWindow(new Date(s.timestamp || 0).getTime(), startDaysAgo, endDaysAgo));
    const attWindow = (startDaysAgo, endDaysAgo) =>
        new Set((memory.attendance || [])
            .filter(a => a.studentEmail === email && isPresentAtt(a) && inWindow(new Date(a.date || 0).getTime(), startDaysAgo, endDaysAgo))
            .map(a => a.date)).size;
    const temporal = {
        mediaAtual: round1(mediaOf(subsWindow(30, 0))),
        mediaAnterior: round1(mediaOf(subsWindow(60, 30))),
        presencaAtual: attWindow(30, 0),
        presencaAnterior: attWindow(60, 30),
    };

    // Notas (cada tentativa, para o gráfico de evolução). A média por módulo está acima.
    const validSubs = subs.filter(s => normalizeScore(s.score) !== null);
    const notas = [...validSubs].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))
        .map(s => ({ label: (s.examKey || '').split('_').slice(1).join(' '), value: normalizeScore(s.score) / 10 }));

    return { kpis, comparativo, risco, engajamento, streak, temporal, notas, modulos, frequenciaDisciplinas, faltas: stats.faltasContam, limiarRisco: limiar };
}

// Resumo leve por aluno (para o Dashboard): frequência, faltas, média, nível de risco.
function studentOverview(memory, student, options = {}) {
    const email = String(student.email || '').toLowerCase();
    const courseId = options.courseId || '';
    // options.index (buildOverviewIndex) evita varrer submissions/attendance por aluno.
    const index = options.index || null;
    const todasSubs = index
        ? (index.subs.get(email) || [])
        : (memory.submissions || []).filter(x => x.student && x.student.email && x.student.email.toLowerCase() === email);
    // A média segue o mesmo recorte da frequência (prova de outro curso não entra) e a
    // consolidação de Resultados: registro antigo sem curso fica no curso da matrícula.
    const resolve = (index && index.resolve) || createSubmissionContextResolver({ students: memory.students || [], classes: memory.classes || [] });
    const subs = scopeSubmissions(todasSubs, { courseId, studentClass: options.studentClass || '' }, resolve);
    const media = round1(mediaOf(subs));
    const stats = attendanceUtil.computeAttendanceStats(attendanceRecordsFor(memory, email, courseId, index));
    const limiar = riskThreshold(memory, student, courseId);
    // null = "sem aula lançada". Nunca 0: isso acusaria o aluno de faltar a tudo.
    const frequencia = stats.frequenciaGeral;
    const faltas = stats.faltasContam;
    const disciplinasEmRisco = Object.values(stats.porDisciplina).filter(v => v.frequencia != null && v.frequencia < limiar).length;
    // Cada motivo só pesa quando existe dado que o sustente — ausência não é sinal ruim.
    const reasons = [];
    if (frequencia != null && frequencia < limiar) reasons.push('freq');
    if (disciplinasEmRisco) reasons.push('disciplina');
    if (media != null && media < 6) reasons.push('media');
    const lastAccess = student.lastLoginAt || student.lastSeenAt;
    const daysSince = lastAccess ? Math.floor((Date.now() - lastAccess) / 86400000) : null;
    if (daysSince !== null && daysSince > 14) reasons.push('acesso');
    let riscoLevel = 'baixo';
    if ((frequencia != null && frequencia < Math.max(0, limiar - 25)) || reasons.length >= 2) riscoLevel = 'alto';
    else if (reasons.length === 1) riscoLevel = 'medio';
    // presentes/totalAulas expõem o denominador: 90% de 10 aulas não é 90% de 100.
    return { frequencia, presentes: stats.presentes, totalAulas: stats.totalAulas, faltas, media, riscoLevel, disciplinasEmRisco };
}

module.exports = { computeStudentDashboard, studentOverview, absenceCount, buildOverviewIndex };
