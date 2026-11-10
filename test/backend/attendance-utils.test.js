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
    ATTENDANCE_EDIT_SESSION_MS,
    attendanceSnapshot,
    statusKey,
    describe,
    effectiveDayRecord,
    shouldAuditAttendanceChange,
    attendanceCarryOver,
    formatDateBR,
    closedStudentListedOn,
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

// ------------------------------------------------------------ versões da presença (H7b)
const aulasDe = (...statuses) => statuses.map((status, i) => ({ ordem: i + 1, disciplinaId: 'MAT', inicio: '08:00', status, hora: i ? '' : '08:20' }));

test('[UC-PRESENCA-004] resumo em português e chave de situação da presença', () => {
    assert.equal(describe(null), 'Sem registro');
    assert.equal(describe({ aulas: aulasDe('presente') }), 'Presente');
    assert.equal(describe({ aulas: aulasDe('presente', 'presente') }), 'Presente (2 aulas)');
    assert.equal(describe({ aulas: aulasDe('falta', 'falta', 'falta') }), 'Falta (3 aulas)');
    assert.equal(describe({ aulas: aulasDe('presente', 'falta', 'falta') }), '1 presença e 2 faltas (3 aulas)');
    assert.equal(describe({ aulas: aulasDe('presente', 'falta', 'justificada'), justificativa: { tipo: 'responsavel', abonado: false } }),
        '1 presença, 1 falta e 1 falta justificada (3 aulas, responsável, não abonada)');
    assert.equal(describe({ aulas: aulasDe('justificada'), justificativa: { tipo: 'atestado', abonado: true } }), 'Falta justificada (atestado, abonada)');
    // Registro antigo sem aulas[]: 1 aula pelo status de antes.
    assert.equal(describe({ status: 'ausente' }), 'Falta');
    assert.equal(describe({ status: 'atrasado' }), 'Presente');

    // A chave muda com a situação de uma aula e com o abono; não muda com texto, hora,
    // observação, disciplina nem com a conclusão da chamada.
    const base = { aulas: aulasDe('presente', 'justificada'), justificativa: { tipo: 'atestado', abonado: false, texto: 'a' }, observacao: 'x', concluida: false };
    assert.equal(statusKey(base), statusKey({ ...base, justificativa: { ...base.justificativa, texto: 'outro texto' }, observacao: '', concluida: true, aulas: base.aulas.map(a => ({ ...a, hora: '', disciplinaId: 'HIS' })) }));
    assert.notEqual(statusKey(base), statusKey({ ...base, justificativa: { ...base.justificativa, abonado: true } }));
    assert.notEqual(statusKey(base), statusKey({ ...base, aulas: aulasDe('falta', 'justificada') }));
    assert.equal(statusKey({ aulas: [{ ordem: 2, status: 'falta' }, { ordem: 1, status: 'presente' }] }), statusKey({ aulas: [{ ordem: 1, status: 'presente' }, { ordem: 2, status: 'falta' }] }), 'a ordem do array não importa');
    assert.equal(formatDateBR('2026-03-02'), '02/03/2026');
});

test('[UC-PRESENCA-004] fotografia do registro sem texto da justificativa, observação nem IP', () => {
    const snap = attendanceSnapshot({
        id: 'att_1', origin: 'chamada', concluida: true, concludedAt: 1700000000000, markedBy: 'prof@x.local', timestamp: 1700000005000,
        aulas: aulasDe('justificada', 'presente'), observacao: 'Avisou a coordenação', ip: '10.0.0.9', userAgent: 'Navegador',
        loginAccess: { horaAcesso: '07:55', ip: '10.0.0.9', source: 'login' },
        justificativa: { tipo: 'atestado', abonado: true, texto: 'Consulta médica', arquivo: '/uploads/a.pdf', arquivoNome: 'a.pdf' },
    });
    assert.deepEqual(snap, {
        id: 'att_1', origin: 'chamada', concluida: true, markedBy: 'prof@x.local', timestamp: 1700000005000,
        aulas: [{ ordem: 1, status: 'justificada' }, { ordem: 2, status: 'presente' }],
        justificativa: { tipo: 'atestado', abonado: true, temTexto: true, temArquivo: true },
        temObservacao: true, concludedAt: 1700000000000,
    });
    assert.equal(attendanceSnapshot(null), null);
});

test('[UC-PRESENCA-004] quando a regravação da chamada vira entrada da auditoria', () => {
    const now = 1_800_000_000_000;
    const draft = { origin: 'chamada', concluida: false, markedBy: 'Prof@X.local', timestamp: now - 60 * 1000, aulas: aulasDe('presente', 'presente') };
    const next = { origin: 'chamada', aulas: aulasDe('falta', 'presente') };
    assert.equal(shouldAuditAttendanceChange(null, next, 'prof@x.local', now), false, 'primeira chamada do dia');
    assert.equal(shouldAuditAttendanceChange(draft, { ...next, aulas: draft.aulas }, 'outro@x.local', now), false, 'situação igual nunca grava');
    assert.equal(shouldAuditAttendanceChange(draft, next, 'prof@x.local', now), false, 'rascunho do mesmo professor (e-mail sem diferenciar maiúscula)');
    assert.equal(shouldAuditAttendanceChange(draft, next, { email: 'prof@x.local', role: 'professor' }, now), false, 'conta como quem salva');
    assert.equal(shouldAuditAttendanceChange(draft, next, 'outro@x.local', now), true, 'outra pessoa');
    assert.equal(shouldAuditAttendanceChange({ ...draft, concluida: true }, next, 'prof@x.local', now), true, 'chamada concluída');
    assert.equal(shouldAuditAttendanceChange({ ...draft, concludedAt: now - 1000 }, next, 'prof@x.local', now), true, 'já concluída antes (rascunho depois)');
    assert.equal(shouldAuditAttendanceChange({ ...draft, origin: 'login', markedBy: null }, next, 'prof@x.local', now), true, 'presença automática do login');
    assert.equal(shouldAuditAttendanceChange({ ...draft, origin: 'manual' }, next, 'prof@x.local', now), true, 'marcação individual');
    assert.equal(shouldAuditAttendanceChange({ ...draft, timestamp: now - ATTENDANCE_EDIT_SESSION_MS }, next, 'prof@x.local', now), false, 'exatamente 15 min ainda é a mesma edição');
    assert.equal(shouldAuditAttendanceChange({ ...draft, timestamp: now - ATTENDANCE_EDIT_SESSION_MS - 1 }, next, 'prof@x.local', now), true, 'mais de 15 min');
    assert.equal(shouldAuditAttendanceChange({ ...draft, timestamp: undefined }, next, 'prof@x.local', now), true, 'sem hora gravada: grava');
});

test('[UC-PRESENCA-004] concludedAt e loginAccess passam de versão em versão', () => {
    const now = 1_800_000_000_000;
    assert.deepEqual(attendanceCarryOver([], { concluida: false, now }), {});
    assert.deepEqual(attendanceCarryOver([], { concluida: true, now }), { concludedAt: now });
    assert.deepEqual(attendanceCarryOver([{ origin: 'chamada', concludedAt: now - 500, concluida: false }], { concluida: true, now }), { concludedAt: now - 500 }, 'a primeira conclusão fica');
    assert.deepEqual(attendanceCarryOver([{ origin: 'chamada', concluida: true, timestamp: now - 900 }], { concluida: false, now }), { concludedAt: now - 900 }, 'concluída antes do campo: a hora da gravação');
    assert.deepEqual(attendanceCarryOver([
        { origin: 'chamada', concludedAt: now - 100 },
        { origin: 'manual', concludedAt: now - 300 },
    ], { now }), { concludedAt: now - 300 }, 'a mais antiga');
    const login = { origin: 'login', horaAcesso: '07:58', ip: '10.0.0.7', source: 'heartbeat', userAgent: 'x' };
    assert.deepEqual(attendanceCarryOver([login], { now }), { loginAccess: { horaAcesso: '07:58', ip: '10.0.0.7', source: 'heartbeat' } });
    assert.deepEqual(attendanceCarryOver([{ origin: 'chamada', loginAccess: { horaAcesso: '07:40', ip: '10.0.0.8', source: 'login' } }], { now }),
        { loginAccess: { horaAcesso: '07:40', ip: '10.0.0.8', source: 'login' } });

    // O registro que vale no dia é o mesmo do dedupeByDate.
    const manual = { origin: 'manual', id: 'm' };
    const chamada = { origin: 'chamada', id: 'c' };
    assert.equal(effectiveDayRecord([login, chamada, manual]).id, 'c');
    assert.equal(effectiveDayRecord([login, manual]).id, 'm');
    assert.equal(effectiveDayRecord([]), null);
});

test('[UC-PRESENCA-004] aluno encerrado na chamada: com registro, ou em data anterior ao dia do desligamento', () => {
    const tz = 'America/Sao_Paulo';
    // 05/03 às 01:30 em Brasília (04:30 UTC): o dia local é 05/03.
    const changedAt = Date.parse('2026-03-05T04:30:00Z');
    assert.equal(closedStudentListedOn({ hasRecord: true, date: '2026-04-01', timezone: tz }), true);
    assert.equal(closedStudentListedOn({ hasRecord: false, date: '2026-04-01', timezone: tz }), false, 'sem a hora do desligamento, só com registro');
    assert.equal(closedStudentListedOn({ date: '2026-03-04', statusChangedAt: changedAt, timezone: tz }), true);
    assert.equal(closedStudentListedOn({ date: '2026-03-05', statusChangedAt: changedAt, timezone: tz }), false);
    assert.equal(closedStudentListedOn({ date: '2026-03-04', statusChangedAt: new Date(changedAt).toISOString(), timezone: tz }), true, 'hora em texto ISO');
    assert.equal(closedStudentListedOn({ date: '2026-03-04', statusChangedAt: 'não é data', timezone: tz }), false);
    // Em UTC-3, 04/03 23:30 local é 05/03 02:30 UTC: vale o dia local.
    assert.equal(closedStudentListedOn({ date: '2026-03-04', statusChangedAt: Date.parse('2026-03-05T02:30:00Z'), timezone: tz }), false);
});
