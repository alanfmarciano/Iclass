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
