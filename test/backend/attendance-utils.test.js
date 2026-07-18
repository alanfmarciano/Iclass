const test = require('node:test');
const assert = require('node:assert/strict');

const {
    sanitizeDisciplinas,
    sanitizeGradeTemplates,
    sanitizeAttendanceConfig,
    weekdayOf,
    gradeForDate,
    deriveAulasFromArrival,
    sanitizeAulas,
    sanitizeJustificativa,
    dedupeByDate,
    computeAttendanceStats,
} = require('../../backend/utils/attendance.js');

test('[UC-PRESENCA-001] normaliza disciplinas e limita a grade às disciplinas do curso', () => {
    const disciplinas = sanitizeDisciplinas([
        { id: 'mat', nome: 'Matemática', cor: '#112233' },
        { id: 'MAT', nome: 'Duplicada' },
        { id: 'his', nome: 'História', cor: 'vermelho' },
        { id: '', nome: 'Sem código' },
    ]);

    assert.deepEqual(disciplinas, [
        { id: 'MAT', nome: 'Matemática', cor: '#112233' },
        { id: 'HIS', nome: 'História', cor: '' },
    ]);

    const config = sanitizeAttendanceConfig({
        toleranciaMin: 15.4,
        limiarRiscoPct: 72.6,
        grade: {
            1: [
                { ordem: 2, inicio: '09:00', disciplinaId: 'his' },
                { ordem: 1, inicio: '08:00', disciplinaId: 'mat' },
                { ordem: 1, inicio: '99:00', disciplinaId: 'fora' },
                { ordem: 3, inicio: 'inválido', disciplinaId: 'fora' },
            ],
        },
    }, new Set(['MAT', 'HIS']));

    assert.equal(config.toleranciaMin, 15);
    assert.equal(config.limiarRiscoPct, 73);
    assert.deepEqual(config.grade['1'], [
        { ordem: 1, inicio: '08:00', disciplinaId: 'MAT' },
        { ordem: 2, inicio: '09:00', disciplinaId: 'HIS' },
        { ordem: 3, inicio: '', disciplinaId: '' },
    ]);
});

test('[UC-PRESENCA-001] normaliza modelos de grade reutilizáveis com limites e dias completos', () => {
    const templates = sanitizeGradeTemplates([
        {
            id: 'manha', nome: '  Manhã 5 aulas  ',
            rhythm: { start: '07:00', duration: 50, count: 3, defaultGap: 10, gaps: [10, 20, 999, 5] },
            days: { '1': true, '2': true, '9': true },
            grid: { '1': ['mat', 'his', 'geo', 'extra'], '2': ['por'] },
            subjectIds: ['mat', 'mat', 'his', ''],
        },
        { id: 'manha', nome: 'Duplicado — descartado' },
        { id: 'sem-nome', nome: '' },
    ]);

    assert.equal(templates.length, 1);
    const tpl = templates[0];
    assert.equal(tpl.id, 'manha');
    assert.equal(tpl.nome, 'Manhã 5 aulas');
    // gaps recortado para count-1 (2) e limitado.
    assert.deepEqual(tpl.rhythm.gaps, [10, 20]);
    assert.equal(tpl.rhythm.count, 3);
    // grid tem exatamente `count` colunas por dia, em maiúsculas.
    assert.deepEqual(tpl.grid['1'], ['MAT', 'HIS', 'GEO']);
    assert.deepEqual(tpl.grid['2'], ['POR', '', '']);
    // dias inválidos ('9') não entram; só as chaves 0-6.
    assert.deepEqual(Object.keys(tpl.days).sort(), ['0', '1', '2', '3', '4', '5', '6']);
    assert.equal(tpl.days['9'], undefined);
    assert.deepEqual(tpl.subjectIds, ['MAT', 'HIS']);

    assert.equal(sanitizeGradeTemplates('nope'), null);
    assert.deepEqual(sanitizeGradeTemplates([]), []);
});

test('[UC-PRESENCA-001] encontra a grade pelo dia sem sofrer deslocamento de fuso', () => {
    const cls = { attendanceConfig: { grade: { 1: [{ ordem: 1, inicio: '08:00', disciplinaId: 'MAT' }] } } };
    assert.equal(weekdayOf('2026-07-13'), 1);
    assert.deepEqual(gradeForDate(cls, '2026-07-13'), [{ ordem: 1, inicio: '08:00', disciplinaId: 'MAT' }]);
    assert.deepEqual(gradeForDate(cls, '2026-07-12'), []);
    assert.deepEqual(gradeForDate(cls, '13/07/2026'), []);
});

test('[UC-PRESENCA-002] deriva faltas por atraso e mantém aula sem horário como presente', () => {
    const aulas = deriveAulasFromArrival([
        { ordem: 1, inicio: '08:00', disciplinaId: 'MAT' },
        { ordem: 2, inicio: '08:50', disciplinaId: 'HIS' },
        { ordem: 3, inicio: '', disciplinaId: 'LAB' },
    ], '08:16', 15);

    assert.deepEqual(aulas.map(aula => aula.status), ['falta', 'presente', 'presente']);
    assert.equal(aulas[0].hora, '08:16');
    assert.equal(aulas[1].hora, '');
});

test('[UC-PRESENCA-002] prioriza chamada, valida justificativa e calcula abono por aula', () => {
    const login = { courseId: 'C1', studentClass: 'T1', date: '2026-07-13', origin: 'login', aulas: [{ ordem: 1, status: 'presente' }] };
    const chamada = {
        courseId: 'C1', studentClass: 'T1', date: '2026-07-13', origin: 'chamada',
        aulas: sanitizeAulas([
            { ordem: 2, disciplinaId: 'his', inicio: '09:00', status: 'justificada' },
            { ordem: 1, disciplinaId: 'mat', inicio: '08:00', status: 'falta' },
            { ordem: 1, status: 'presente' },
        ]),
        justificativa: sanitizeJustificativa({ tipo: 'atestado', de: '2026-07-13', ate: '2026-07-13', abonado: true, texto: 'Atestado' }),
    };

    const records = dedupeByDate([login, chamada]);
    assert.equal(records.length, 1);
    assert.equal(records[0].origin, 'chamada');
    assert.deepEqual(records[0].aulas.map(aula => aula.ordem), [1, 2]);

    const stats = computeAttendanceStats(records);
    assert.equal(stats.presentes, 0);
    assert.equal(stats.faltasContam, 1);
    assert.equal(stats.porDisciplina.MAT.frequencia, 0);
    assert.equal(stats.porDisciplina.HIS.frequencia, null);
});
