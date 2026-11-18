const test = require('node:test');
const assert = require('node:assert/strict');

const { absenceCount, studentOverview, computeStudentDashboard } = require('../../backend/utils/studentAnalytics.js');
const { computeAttendanceStats, dedupeByDate } = require('../../backend/utils/attendance.js');

// Registros no formato POR AULA. Uma aula justificada abonada não conta como falta.
function memoryWithAttendance() {
    const rec = (id, courseId, studentClass, date, origin, aulas, justificativa = null) => ({
        id, studentEmail: 'aluno@teste.local', courseId, studentClass, date, origin, aulas, justificativa,
    });
    return {
        courses: [{ id: 'CURSO-A', disciplinas: [{ id: 'MAT', nome: 'Matemática' }, { id: 'HIS', nome: 'História' }], structure: [] }],
        classes: [{ name: 'Turma 1', courseId: 'CURSO-A', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: {} } }],
        students: [{ email: 'aluno@teste.local', name: 'Aluno', classes: [{ name: 'Turma 1', courseId: 'CURSO-A' }], studentClass: 'Turma 1' }],
        submissions: [],
        attendance: [
            rec('d1', 'CURSO-A', 'Turma 1', '2026-07-01', 'chamada', [{ ordem: 1, disciplinaId: 'MAT', status: 'presente' }, { ordem: 2, disciplinaId: 'MAT', status: 'presente' }]),
            rec('d2', 'CURSO-A', 'Turma 1', '2026-07-02', 'chamada', [{ ordem: 1, disciplinaId: 'MAT', status: 'presente' }, { ordem: 2, disciplinaId: 'HIS', status: 'falta' }]),
            // Mesmo dia: chamada (2 faltas) + login (presente). O dedupe mantém a chamada.
            rec('d3c', 'CURSO-A', 'Turma 1', '2026-07-03', 'chamada', [{ ordem: 1, disciplinaId: 'MAT', status: 'falta' }, { ordem: 2, disciplinaId: 'HIS', status: 'falta' }]),
            rec('d3l', 'CURSO-A', 'Turma 1', '2026-07-03', 'login', [{ ordem: 1, disciplinaId: 'MAT', status: 'presente' }, { ordem: 2, disciplinaId: 'HIS', status: 'presente' }]),
            // Justificada abonada não conta como falta.
            rec('d4', 'CURSO-A', 'Turma 1', '2026-07-04', 'chamada', [{ ordem: 1, disciplinaId: 'MAT', status: 'justificada' }, { ordem: 2, disciplinaId: 'MAT', status: 'presente' }], { tipo: 'atestado', abonado: true }),
            // Outro curso do mesmo aluno.
            rec('d5', 'CURSO-B', 'Turma 3', '2026-07-05', 'chamada', [{ ordem: 1, disciplinaId: 'INF', status: 'falta' }]),
        ],
    };
}

test('[UC-PRESENCA-002] dedupeByDate mantém a chamada do professor sobre o login', () => {
    const memory = memoryWithAttendance();
    const rows = dedupeByDate(memory.attendance.filter(a => a.date === '2026-07-03'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, 'chamada');
});

test('[UC-PRESENCA-002] absenceCount conta faltas por aula (abonadas não contam) e respeita o curso', () => {
    const memory = memoryWithAttendance();
    // CURSO-A: 07-02 (1) + 07-03 (2) + 07-04 (0, abonada) = 3
    assert.equal(absenceCount(memory, 'aluno@teste.local', 'CURSO-A'), 3);
    assert.equal(absenceCount(memory, 'aluno@teste.local', 'CURSO-B'), 1);
    assert.equal(absenceCount(memory, 'aluno@teste.local'), 4);
});

test('[UC-PRESENCA-002] frequência geral e por disciplina', () => {
    const memory = memoryWithAttendance();
    const recs = memory.attendance.filter(a => a.courseId === 'CURSO-A');
    const stats = computeAttendanceStats(dedupeByDate(recs));
    // MAT: presentes 4 (2+1+1), falta 1 → 80%. HIS: 0 presente, 2 faltas → 0%.
    assert.equal(stats.porDisciplina.MAT.frequencia, 80);
    assert.equal(stats.porDisciplina.HIS.frequencia, 0);
    // Geral: presentes 4, faltas 3 → 4/7 = 57%.
    assert.equal(stats.frequenciaGeral, 57);
    assert.equal(stats.faltasContam, 3);
});

test('abono desligado faz a falta justificada voltar a contar', () => {
    const memory = memoryWithAttendance();
    memory.attendance.find(a => a.id === 'd4').justificativa.abonado = false;
    const stats = computeAttendanceStats(dedupeByDate(memory.attendance.filter(a => a.courseId === 'CURSO-A')));
    assert.equal(stats.faltasContam, 4); // agora a justificada conta
});

test('computeStudentDashboard expõe frequência por disciplina e risco', () => {
    const memory = memoryWithAttendance();
    const dash = computeStudentDashboard(memory, 'aluno@teste.local');
    assert.equal(dash.kpis.frequencia, 57);
    assert.equal(dash.faltas, 3);
    const his = dash.frequenciaDisciplinas.find(d => d.disciplinaId === 'HIS');
    const mat = dash.frequenciaDisciplinas.find(d => d.disciplinaId === 'MAT');
    assert.equal(his.emRisco, true);   // 0% < 75%
    assert.equal(mat.emRisco, false);  // 80% ≥ 75%
});

test('studentOverview: frequência, faltas e risco por disciplina', () => {
    const memory = memoryWithAttendance();
    const student = memory.students[0];
    const ov = studentOverview(memory, student, { courseId: 'CURSO-A' });
    assert.equal(ov.frequencia, 57);
    assert.equal(ov.faltas, 3);
    assert.equal(ov.disciplinasEmRisco, 1); // HIS
    assert.equal(studentOverview({ attendance: [], submissions: [], classes: [], courses: [] }, student).faltas, 0);
});

// ---------------------------------------------------------------------------
// "Sem dado" não é zero — um aluno que nunca fez prova não tem média 0,0, e um
// aluno sem chamada lançada não tem 0% de frequência. Distinguir os dois casos
// é o que permite ao Dashboard somar e comparar sem mentir.
// ---------------------------------------------------------------------------

// Cada registro é de uma prova diferente: várias tentativas da MESMA prova se
// consolidam pela regra da prova (como em Resultados), não entram uma a uma na média.
const sub = (id, email, courseId, score, timestamp, examKey = `Avaliacao_X_${id}`) => ({
    id, examKey, score, timestamp,
    student: { name: 'Aluno', email, studentClass: courseId === 'CURSO-B' ? 'Turma 3' : 'Turma 1', courseId },
});

test('media é null para aluno sem prova — nunca 0', () => {
    const memory = memoryWithAttendance();
    const ov = studentOverview(memory, memory.students[0], { courseId: 'CURSO-A' });
    assert.equal(ov.media, null, 'aluno sem submissão deve ter media null, não 0');
});

test('studentOverview restringe a média ao curso pedido', () => {
    const memory = memoryWithAttendance();
    const email = 'aluno@teste.local';
    memory.submissions = [
        sub('s1', email, 'CURSO-A', 80, '2026-07-01T10:00:00.000Z'),
        sub('s2', email, 'CURSO-A', 60, '2026-07-02T10:00:00.000Z'),
        sub('s3', email, 'CURSO-B', 10, '2026-07-03T10:00:00.000Z'), // outro curso: não entra
    ];
    const a = studentOverview(memory, memory.students[0], { courseId: 'CURSO-A' });
    assert.equal(a.media, 7, 'média de CURSO-A é (80+60)/2/10 = 7,0');
    const b = studentOverview(memory, memory.students[0], { courseId: 'CURSO-B' });
    assert.equal(b.media, 1, 'média de CURSO-B é 10/10 = 1,0');
    const todos = studentOverview(memory, memory.students[0], {});
    assert.equal(todos.media, 5, 'sem curso informado, considera tudo: (80+60+10)/3/10 = 5,0');
});

test('frequencia é null quando não há aula lançada — nunca 0', () => {
    const memory = memoryWithAttendance();
    memory.attendance = [];
    const ov = studentOverview(memory, memory.students[0], { courseId: 'CURSO-A' });
    assert.equal(ov.frequencia, null, 'sem aula lançada, frequência é desconhecida, não zero');
    assert.equal(ov.faltas, 0);
    assert.equal(ov.totalAulas, 0);
});

test('studentOverview expõe o denominador da frequência', () => {
    const memory = memoryWithAttendance();
    const ov = studentOverview(memory, memory.students[0], { courseId: 'CURSO-A' });
    // 4 presenças e 3 faltas que contam → 4/7 = 57%
    assert.equal(ov.presentes, 4);
    assert.equal(ov.totalAulas, 7);
    assert.equal(ov.frequencia, 57);
});

test('computeStudentDashboard mantém frequencia null sem chamada lançada', () => {
    const memory = memoryWithAttendance();
    memory.attendance = [];
    const dash = computeStudentDashboard(memory, 'aluno@teste.local');
    assert.equal(dash.kpis.frequencia, null);
    assert.equal(dash.kpis.media, null);
});

test('temporal compara janelas móveis de 30 dias, não meses de calendário', () => {
    const memory = memoryWithAttendance();
    const email = 'aluno@teste.local';
    const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();
    memory.submissions = [
        sub('r1', email, 'CURSO-A', 90, dias(5)),   // janela atual (0-30d)
        sub('r2', email, 'CURSO-A', 70, dias(20)),  // janela atual
        sub('r3', email, 'CURSO-A', 50, dias(40)),  // janela anterior (30-60d)
        sub('r4', email, 'CURSO-A', 30, dias(55)),  // janela anterior
    ];
    const dash = computeStudentDashboard(memory, email);
    assert.equal(dash.temporal.mediaAtual, 8, 'últimos 30 dias: (90+70)/2/10 = 8,0');
    assert.equal(dash.temporal.mediaAnterior, 4, '30 dias anteriores: (50+30)/2/10 = 4,0');
});

test('[UC-NOTAS-003] média do painel consolida as tentativas da mesma prova pela regra (maior, última, média) e ignora nota inválida', () => {
    const memory = memoryWithAttendance();
    const email = 'aluno@teste.local';
    const attempt = (id, score, timestamp, extra = {}) => ({
        ...sub(id, email, 'CURSO-A', score, timestamp, 'Avaliacao_REDES_1'), applicationId: 'app_r1', ...extra,
    });
    memory.submissions = [
        attempt('t1', 40, '2026-07-01T10:00:00.000Z'),
        attempt('t2', 80, '2026-07-01T11:00:00.000Z'),
        sub('p2', email, 'CURSO-A', 60, '2026-07-02T10:00:00.000Z'),
        sub('bad', email, 'CURSO-A', 150, '2026-07-03T10:00:00.000Z'),
    ];
    // Regra "maior" (padrão): (80 + 60) / 2 = 7,0. Antes: (40 + 80 + 60) / 3 = 6,0.
    assert.equal(studentOverview(memory, memory.students[0], { courseId: 'CURSO-A' }).media, 7);
    const dash = computeStudentDashboard(memory, email);
    assert.equal(dash.kpis.media, 7);
    assert.equal(dash.kpis.provasFeitas, 3, 'tentativas da mesma prova contam uma vez');
    // Regra "média" na Prova 1: (40 + 80) / 2 = 60, e a média do aluno fica (60 + 60) / 2 = 6,0.
    memory.submissions.slice(0, 2).forEach(item => { item.aggregationPolicy = 'average'; });
    assert.equal(studentOverview(memory, memory.students[0], { courseId: 'CURSO-A' }).media, 6);
    // Nota só inválida: sem média (nunca 0).
    memory.submissions = [sub('bad2', email, 'CURSO-A', 150, '2026-07-03T10:00:00.000Z')];
    assert.equal(studentOverview(memory, memory.students[0], { courseId: 'CURSO-A' }).media, null);
});
