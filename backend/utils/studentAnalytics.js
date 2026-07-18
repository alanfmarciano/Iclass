// Painel do aluno — Etapa 1: cálculo consolidado de indicadores a partir dos dados existentes.
// Frequência: por aula, geral e por disciplina (ver backend/utils/attendance.js).

const attendanceUtil = require('./attendance.js');

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

function mediaOf(subs) {
    if (!subs.length) return 0;
    return subs.reduce((a, s) => a + (Number(s.score) || 0), 0) / subs.length / 10;
}

// Um dia conta como presença (streak/dias ativos) se tiver ao menos 1 aula presente.
function isPresentAtt(a) {
    if (!a) return false;
    return attendanceUtil.recordHasPresence(a);
}

// Registros de presença de um aluno, opcionalmente restritos a um curso.
// Deduplicados por data (chamada > manual > login) para não contar em dobro.
function attendanceRecordsFor(memory, email, courseId = '') {
    const e = String(email || '').trim().toLowerCase();
    const cid = String(courseId || '').trim();
    const filtered = (memory.attendance || []).filter(a =>
        String(a.studentEmail || '').trim().toLowerCase() === e
        && (!cid || !a.courseId || String(a.courseId) === cid));
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

function computeStudentDashboard(memory, email) {
    email = String(email || '').trim().toLowerCase();
    const student = (memory.students || []).find(s => s.email && s.email.toLowerCase() === email) || null;
    const subs = (memory.submissions || []).filter(s => s.student && s.student.email && s.student.email.toLowerCase() === email);
    const names = student ? studentClassNames(student) : [];
    const courseId = student ? courseIdOfStudent(memory, student) : null;
    const unitStats = courseUnitStats(memory, courseId);

    const progressMap = (memory.progress && memory.progress[email]) || {};
    const completed = Object.keys(progressMap).filter(k => progressMap[k]).length;
    const media = mediaOf(subs);
    const stats = attendanceUtil.computeAttendanceStats(attendanceRecordsFor(memory, email, courseId));
    const limiar = riskThreshold(memory, student, courseId);
    const frequencia = stats.frequenciaGeral == null ? 0 : stats.frequenciaGeral;
    const kpis = {
        frequencia,
        media: Math.round(media * 10) / 10,
        progresso: unitStats.units ? Math.round((completed / unitStats.units) * 100) : 0,
        provasFeitas: subs.length,
        provasTotais: unitStats.exams,
    };

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
        const ss = (memory.submissions || []).filter(x => x.student && x.student.email && x.student.email.toLowerCase() === e);
        if (ss.length) turmaMedias.push(mediaOf(ss));
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
    if (subs.length && media < 6) reasons.push(`Média abaixo de 6 (${kpis.media})`);
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

    // Comparação temporal (mês atual vs anterior)
    const now = new Date();
    const curKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const prevD = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevKey = `${prevD.getFullYear()}-${pad(prevD.getMonth() + 1)}`;
    const subsMonth = (k) => subs.filter(s => (s.timestamp || '').slice(0, 7) === k);
    const attMonth = (k) => new Set((memory.attendance || []).filter(a => a.studentEmail === email && (a.date || '').slice(0, 7) === k && isPresentAtt(a)).map(a => a.date)).size;
    const temporal = {
        mediaAtual: Math.round(mediaOf(subsMonth(curKey)) * 10) / 10,
        mediaAnterior: Math.round(mediaOf(subsMonth(prevKey)) * 10) / 10,
        presencaAtual: attMonth(curKey),
        presencaAnterior: attMonth(prevKey),
    };

    // Notas e módulos
    const notas = [...subs].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0))
        .map(s => ({ label: (s.examKey || '').split('_').slice(1).join(' '), value: (Number(s.score) || 0) / 10 }));
    const modGroups = {};
    subs.forEach(s => { const m = (s.examKey || '').split('_')[1] || '—'; (modGroups[m] = modGroups[m] || []).push(Number(s.score) || 0); });
    const modulos = Object.entries(modGroups).map(([m, arr]) => ({ modulo: m, media: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length / 10 * 10) / 10 }));

    return { kpis, comparativo, risco, engajamento, streak, temporal, notas, modulos, frequenciaDisciplinas, faltas: stats.faltasContam, limiarRisco: limiar };
}

// Resumo leve por aluno (para o Dashboard): frequência, faltas, média, nível de risco.
function studentOverview(memory, student, options = {}) {
    const email = String(student.email || '').toLowerCase();
    const courseId = options.courseId || '';
    const subs = (memory.submissions || []).filter(x => x.student && x.student.email && x.student.email.toLowerCase() === email);
    const media = Math.round(mediaOf(subs) * 10) / 10;
    const stats = attendanceUtil.computeAttendanceStats(attendanceRecordsFor(memory, email, courseId));
    const limiar = riskThreshold(memory, student, courseId);
    const frequencia = stats.frequenciaGeral == null ? 0 : stats.frequenciaGeral;
    const faltas = stats.faltasContam;
    const temFreq = stats.totalAulas > 0 && stats.frequenciaGeral != null;
    const disciplinasEmRisco = Object.values(stats.porDisciplina).filter(v => v.frequencia != null && v.frequencia < limiar).length;
    const reasons = [];
    if (temFreq && stats.frequenciaGeral < limiar) reasons.push('freq');
    if (disciplinasEmRisco) reasons.push('disciplina');
    if (subs.length && media < 6) reasons.push('media');
    const lastAccess = student.lastLoginAt || student.lastSeenAt;
    const daysSince = lastAccess ? Math.floor((Date.now() - lastAccess) / 86400000) : null;
    if (daysSince !== null && daysSince > 14) reasons.push('acesso');
    let riscoLevel = 'baixo';
    if ((temFreq && stats.frequenciaGeral < Math.max(0, limiar - 25)) || reasons.length >= 2) riscoLevel = 'alto';
    else if (reasons.length === 1) riscoLevel = 'medio';
    return { frequencia, faltas, media, riscoLevel, disciplinasEmRisco };
}

module.exports = { computeStudentDashboard, studentOverview, absenceCount };
