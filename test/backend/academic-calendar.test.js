// Dias não letivos no servidor (fase 3, B3 / P2-S5, FUN-15): "há aula nesta turma nesta
// data?" num lugar só (backend/utils/academicCalendar.js), a presença do login num
// feriado fora da frequência sem apagar nada, a Chamada e o Dashboard que não cobram
// chamada no feriado, as rotas dos dias não letivos (escopo e auditoria), os feriados
// nacionais calculados sem internet, os calendários do painel e do aluno com os dias e a
// agenda em .ics. Cada teste falha no código de antes (o calendário só olhava o dia da
// semana).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-academic-calendar-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// Módulos antes do servidor (o uncaughtException do server.js engoliria a falha deles).
const calendar = require('../../backend/utils/academicCalendar.js');
const attendanceUtil = require('../../backend/utils/attendance.js');
const { buildIcs, foldLine, escapeText } = require('../../backend/utils/icsCalendar.js');
const { BOOT_NORMALIZATIONS } = require('../../backend/migrations/index.js');
const settingsUtil = require('../../backend/utils/settings.js');
const { computeStudentDashboard } = require('../../backend/utils/studentAnalytics.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const BACKEND = path.join(__dirname, '../../backend');

// Grade de segunda (1) e quarta (3): duas aulas de REDES; quinta (4) uma de BD.
const GRADE = {
    1: [{ ordem: 1, inicio: '08:00', disciplinaId: 'REDES' }, { ordem: 2, inicio: '08:50', disciplinaId: 'REDES' }],
    3: [{ ordem: 1, inicio: '08:00', disciplinaId: 'REDES' }, { ordem: 2, inicio: '08:50', disciplinaId: 'REDES' }],
    4: [{ ordem: 1, inicio: '19:00', disciplinaId: 'BD' }],
};

function memoryBase() {
    return {
        schools: [{ id: 'esc_a', name: 'Escola A' }, { id: 'esc_b', name: 'Escola B' }],
        courses: [
            { id: 'TI', name: 'Informática', schoolId: 'esc_a', disciplinas: [{ id: 'REDES', nome: 'Redes' }, { id: 'BD', nome: 'Banco de Dados' }] },
            { id: 'ADM', name: 'Administração', schoolId: 'esc_b', disciplinas: [] },
        ],
        classes: [
            { name: '1DES', courseId: 'TI', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: GRADE } },
            { name: '2DES', courseId: 'TI', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: GRADE } },
            { name: '1ADM', courseId: 'ADM', attendanceConfig: { toleranciaMin: 10, limiarRiscoPct: 75, grade: GRADE } },
        ],
        nonSchoolDays: [],
        academicTerms: [],
        attendance: [],
    };
}

const day = (fields) => ({ id: `nl_${Math.random().toString(16).slice(2, 10)}`, tipo: 'feriado', nome: 'Feriado', ...fields });

// ---------------------------------------------------------------- unidade

test('[UC-PRESENCA-005] lessonsForDate: [] no feriado da instituição, da escola do curso, do curso e da turma; a grade no feriado de outra turma', () => {
    const memory = memoryBase();
    const [des1, des2, adm] = memory.classes;
    // 2027-11-15 é segunda: há grade.
    assert.equal(calendar.lessonsForDate(memory, des1, '2027-11-15').length, 2, 'sem dia não letivo, a grade da semana');
    memory.nonSchoolDays = [day({ inicio: '2027-11-15', escopo: 'instituicao', nome: 'Proclamação da República' })];
    assert.deepEqual(calendar.lessonsForDate(memory, des1, '2027-11-15'), []);
    assert.deepEqual(calendar.lessonsForDate(memory, adm, '2027-11-15'), []);
    assert.equal(calendar.isNonSchoolDay(memory, des1, '2027-11-15').nome, 'Proclamação da República');

    memory.nonSchoolDays = [day({ inicio: '2027-11-15', escopo: 'escola', schoolId: 'esc_a' })];
    assert.deepEqual(calendar.lessonsForDate(memory, des1, '2027-11-15'), [], 'escola do curso TI');
    assert.equal(calendar.lessonsForDate(memory, adm, '2027-11-15').length, 2, 'ADM é de outra escola');

    memory.nonSchoolDays = [day({ inicio: '2027-11-15', escopo: 'curso', courseId: 'TI' })];
    assert.deepEqual(calendar.lessonsForDate(memory, des2, '2027-11-15'), []);
    assert.equal(calendar.lessonsForDate(memory, adm, '2027-11-15').length, 2);

    memory.nonSchoolDays = [day({ inicio: '2027-11-15', escopo: 'turma', courseId: 'TI', studentClass: '2DES' })];
    assert.deepEqual(calendar.lessonsForDate(memory, des2, '2027-11-15'), []);
    assert.equal(calendar.lessonsForDate(memory, des1, '2027-11-15').length, 2, 'feriado de outra turma não tira a aula desta');
    // Turma de mesmo nome em outro curso não é a mesma turma.
    assert.equal(calendar.isNonSchoolDay(memory, { courseId: 'ADM', studentClass: '2DES' }, '2027-11-15'), null);

    // O mais específico vale quando há mais de um.
    memory.nonSchoolDays.push(day({ inicio: '2027-11-15', escopo: 'instituicao', nome: 'Da instituição' }));
    assert.equal(calendar.isNonSchoolDay(memory, des2, '2027-11-15').escopo, 'turma');
});

test('[UC-PRESENCA-005] lessonsForDate: recesso de vários dias, fora do período letivo e turma sem período', () => {
    const memory = memoryBase();
    const des1 = memory.classes[0];
    memory.nonSchoolDays = [day({ inicio: '2027-07-12', fim: '2027-07-23', tipo: 'recesso', nome: 'Recesso escolar', escopo: 'instituicao' })];
    ['2027-07-12', '2027-07-14', '2027-07-19', '2027-07-21'].forEach(date => assert.deepEqual(calendar.lessonsForDate(memory, des1, date), [], date));
    assert.equal(calendar.lessonsForDate(memory, des1, '2027-07-26').length, 2, 'a segunda depois do recesso tem aula');
    assert.equal(calendar.lessonsForDate(memory, des1, '2027-07-05').length, 2, 'a segunda antes do recesso tem aula');

    // Sem período letivo: todo dia de grade é letivo (como sempre foi).
    assert.equal(calendar.termForClass(memory, des1), null);
    // Com período: fora dele não há aula, e o dayStatus diz por quê.
    memory.academicTerms = [{ id: 'per_1', nome: '2027 · 2º semestre', inicio: '2027-08-02', fim: '2027-12-17', etapas: [] }];
    des1.periodoLetivoId = 'per_1';
    assert.deepEqual(calendar.lessonsForDate(memory, des1, '2027-07-26'), []);
    const status = calendar.dayStatus(memory, des1, '2027-07-26');
    assert.equal(status.foraDoPeriodo, true);
    assert.equal(status.aulasGrade.length, 2, 'a grade da semana continua em aulasGrade');
    assert.equal(calendar.lessonsForDate(memory, des1, '2027-08-02').length, 2);
    // Registro de período inválido (sem datas) não vale: a turma fica como sem período.
    memory.academicTerms = [{ id: 'per_1', nome: 'Quebrado' }];
    assert.equal(calendar.termForClass(memory, des1), null);
});

test('[UC-CURSO-002] plannedLessons: seg/qua com 2 aulas de REDES, 4 semanas com 1 feriado numa quarta = 14 aulas de REDES', () => {
    const memory = memoryBase();
    const des1 = memory.classes[0];
    // 2027-08-02 (segunda) a 2027-08-29 (domingo): 4 segundas, 4 quartas e 4 quintas.
    memory.nonSchoolDays = [day({ inicio: '2027-08-11', escopo: 'instituicao', nome: 'Feriado municipal' })];
    const planned = calendar.plannedLessons(memory, des1, { from: '2027-08-02', to: '2027-08-29' });
    assert.equal(planned.porDisciplina.REDES, 14);
    assert.equal(planned.porDisciplina.BD, 4);
    assert.equal(planned.total, 18);
    assert.equal(calendar.plannedLessons(memory, des1, {}), null, 'sem intervalo e sem período, nada a prever');
});

test('[UC-PRESENCA-005] feriados nacionais de 2027: datas fixas, Carnaval e Corpus Christi pela Páscoa', () => {
    const list = calendar.nationalHolidays(2027);
    const byDate = Object.fromEntries(list.map(item => [item.inicio, item]));
    ['2027-01-01', '2027-03-26', '2027-04-21', '2027-05-01', '2027-09-07', '2027-10-12', '2027-11-02', '2027-11-15', '2027-11-20', '2027-12-25']
        .forEach(date => assert.equal(byDate[date] && byDate[date].tipo, 'feriado', date));
    assert.deepEqual([byDate['2027-02-08'].fim, byDate['2027-02-08'].nome, byDate['2027-02-08'].tipo], ['2027-02-09', 'Carnaval', 'ponto_facultativo']);
    assert.deepEqual([byDate['2027-05-27'].nome, byDate['2027-05-27'].tipo], ['Corpus Christi', 'ponto_facultativo']);
    assert.equal(list.length, 12);
    // Páscoa de anos conhecidos; Consciência Negra só a partir de 2024.
    assert.equal(calendar.easterSunday(2024), '2024-03-31');
    assert.equal(calendar.easterSunday(2026), '2026-04-05');
    assert.equal(calendar.easterSunday(2028), '2028-04-16');
    assert.ok(!calendar.nationalHolidays(2023).some(item => item.chave === 'consciencia-negra'));
});

test('[UC-PRESENCA-005] frequência ignora a presença do login marcada como dia não letivo; a chamada no feriado continua contando', () => {
    const login = { id: 'a1', origin: 'login', date: '2027-11-15', aulas: [{ ordem: 1, status: 'falta' }] };
    const chamada = { id: 'a2', origin: 'chamada', date: '2027-11-16', aulas: [{ ordem: 1, status: 'presente' }] };
    assert.equal(attendanceUtil.computeAttendanceStats([login, chamada]).frequenciaGeral, 50);
    login.naoLetivoId = 'nl_x';
    assert.equal(attendanceUtil.computeAttendanceStats([login, chamada]).frequenciaGeral, 100);
    assert.deepEqual(attendanceUtil.dedupeByDate([login, chamada]).map(r => r.id), ['a2']);
    // Chamada com a marca (não acontece pela rota) conta assim mesmo: foi lançada de propósito.
    const reposicao = { id: 'a3', origin: 'chamada', date: '2027-11-15', naoLetivoId: 'nl_x', aulas: [{ ordem: 1, status: 'falta' }] };
    assert.equal(attendanceUtil.computeAttendanceStats([reposicao, chamada]).frequenciaGeral, 50);
});

test('[UC-PRESENCA-005] syncNonSchoolDayMarks: marca só o login coberto, tira quando o dia sai e é idempotente (normalização de todo boot)', () => {
    const memory = memoryBase();
    memory.attendance = [
        { id: 'l1', origin: 'login', studentEmail: 'a@x', courseId: 'TI', studentClass: '1DES', date: '2027-11-15', aulas: [] },
        { id: 'l2', origin: 'login', studentEmail: 'b@x', courseId: 'ADM', studentClass: '1ADM', date: '2027-11-15', aulas: [] },
        { id: 'c1', origin: 'chamada', studentEmail: 'a@x', courseId: 'TI', studentClass: '1DES', date: '2027-11-15', aulas: [] },
        { id: 'l3', origin: 'login', studentEmail: 'a@x', courseId: 'TI', studentClass: '1DES', date: '2027-11-17', aulas: [] },
    ];
    memory.nonSchoolDays = [day({ id: 'nl_ti', inicio: '2027-11-15', escopo: 'curso', courseId: 'TI' })];
    const normalization = BOOT_NORMALIZATIONS.find(row => row.id === '2026-11-p2-presenca-dia-nao-letivo');
    assert.ok(normalization, 'a normalização de todo boot existe');
    assert.equal(normalization.run(memory), true);
    assert.equal(memory.attendance[0].naoLetivoId, 'nl_ti');
    assert.equal(memory.attendance[1].naoLetivoId, undefined, 'outro curso');
    assert.equal(memory.attendance[2].naoLetivoId, undefined, 'a chamada nunca é marcada');
    assert.equal(memory.attendance[3].naoLetivoId, undefined, 'outro dia');
    assert.equal(normalization.run(memory), false, 'rodar de novo não muda nada');
    // Só as datas pedidas mudam (as rotas passam o intervalo do dia).
    memory.nonSchoolDays = [];
    const other = calendar.syncNonSchoolDayMarks(memory, { ranges: [{ inicio: '2027-11-20', fim: '2027-11-21' }] });
    assert.deepEqual(other.changedIds, []);
    assert.equal(memory.attendance[0].naoLetivoId, 'nl_ti');
    const removed = calendar.syncNonSchoolDayMarks(memory, { ranges: [{ inicio: '2027-11-15', fim: '2027-11-15' }] });
    assert.deepEqual(removed.desmarcados, ['l1']);
    assert.ok(!('naoLetivoId' in memory.attendance[0]), 'a marca sai, o registro fica');
    assert.equal(memory.attendance.length, 4, 'nada é apagado');
    // Sem dia não letivo cadastrado e sem marca, a normalização não muda nada.
    assert.equal(normalization.run(memoryBase()), false);
});

test('[UC-PRESENCA-005] leitura tolerante: registro sem data, de escopo desconhecido ou sem o alvo não vale para ninguém', () => {
    const memory = memoryBase();
    memory.nonSchoolDays = [
        { id: 'x1', inicio: '2027-11-15', escopo: 'planeta' },
        { id: 'x2', escopo: 'instituicao' },
        { id: 'x3', inicio: '2027-11-15', escopo: 'turma', courseId: 'TI' },
        { id: 'x4', inicio: '2027-11-15', fim: '2027-11-10', escopo: 'curso', courseId: 'TI', tipo: 'desconhecido' },
    ];
    assert.equal(calendar.isNonSchoolDay(memory, memory.classes[0], '2027-11-15').id, 'x4');
    assert.equal(calendar.isNonSchoolDay(memory, memory.classes[0], '2027-11-15').tipo, 'outro');
    assert.equal(calendar.isNonSchoolDay(memory, memory.classes[0], '2027-11-14'), null, 'fim antes do início vale só o início');
});

test('[UC-PRESENCA-005] guarda: nenhum arquivo de backend/ chama attendanceUtil.gradeForDate fora de attendance.js e academicCalendar.js', () => {
    const allowed = new Set([path.join(BACKEND, 'utils/attendance.js'), path.join(BACKEND, 'utils/academicCalendar.js')]);
    const offenders = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!entry.name.endsWith('.js') || allowed.has(full)) return;
        const textContent = fs.readFileSync(full, 'utf8');
        if (/\bgradeForDate\s*\(/.test(textContent)) offenders.push(path.relative(BACKEND, full));
    });
    walk(BACKEND);
    assert.deepEqual(offenders, [], 'quem precisa saber se há aula usa academicCalendar.lessonsForDate (ou weeklyLessons para a grade sem calendário)');
});

test('[UC-PRESENCA-005] .ics: CRLF, dia inteiro com DTEND exclusivo, hora em UTC, escape e linhas dobradas em 75 octetos', () => {
    const ics = buildIcs({
        nome: 'Informática · 1DES',
        timezone: 'America/Sao_Paulo',
        now: Date.parse('2027-11-01T12:00:00Z'),
        eventos: [
            { uid: 'nl_1', titulo: 'Recesso, meio do ano; férias', data: '2027-07-12', dataFim: '2027-07-23', descricao: 'Linha 1\nLinha 2 \\ fim' },
            { uid: 'cal_1', titulo: 'Prova de Redes', data: '2027-11-16', inicio: '08:00', fim: '09:40' },
            { uid: 'cal_2', titulo: 'Sem fim', data: '2027-11-17', inicio: '19:00' },
            { uid: 'cal_3', titulo: `Título comprido ${'ação '.repeat(30)}`, data: '2027-11-18' },
        ],
    });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(!/[^\r]\n/.test(ics), 'toda quebra é CRLF');
    assert.match(ics, /DTSTART;VALUE=DATE:20270712\r\nDTEND;VALUE=DATE:20270724\r\n/);
    assert.match(ics, /SUMMARY:Recesso\\, meio do ano\\; férias\r\n/);
    assert.match(ics, /DESCRIPTION:Linha 1\\nLinha 2 \\\\ fim\r\n/);
    assert.match(ics, /DTSTART:20271116T110000Z\r\nDTEND:20271116T124000Z\r\n/, '08:00 em São Paulo é 11:00 UTC');
    assert.match(ics, /DTSTART:20271117T220000Z\r\nDTEND:20271117T230000Z\r\n/, 'sem fim: 1 hora');
    assert.match(ics, /UID:nl_1@iclass\r\n/);
    ics.split('\r\n').forEach(line => assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `linha com mais de 75 octetos: ${line}`));
    // A dobra não parte letra acentuada e volta ao texto original.
    const long = `SUMMARY:${'ação '.repeat(40)}`;
    const folded = foldLine(long);
    assert.equal(folded.split('\r\n ').join(''), long);
    assert.equal(escapeText('a,b;c\\d\r\ne'), 'a\\,b\\;c\\\\d\\ne');
});

// ---------------------------------------------------------------- rotas

let app;
const adminToken = 'admin-token-academic';
const profToken = 'prof-token-academic';
const coordToken = 'coord-token-academic';
const anaToken = 'ana-token-academic';
const admin = (method, url) => request(app)[method](url).set('x-admin-session', adminToken);
const prof = (method, url) => request(app)[method](url).set('x-admin-session', profToken);

function seedApp() {
    const base = memoryBase();
    Object.assign(db.memory, base);
    db.memory.admins = [
        { email: 'admin@calendario.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-admin-ok') },
        { email: 'prof@calendario.local', name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof-ok'), assignedClasses: [{ courseId: 'TI', className: '1DES' }] },
        { email: 'coord@calendario.local', name: 'Coord', role: 'coordenacao', password: db.hashPassword('senha-coord-ok'), assignedSchoolIds: ['esc_a'] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@calendario.local', createdAt: Date.now(), lastSeen: Date.now() },
        [profToken]: { email: 'prof@calendario.local', createdAt: Date.now(), lastSeen: Date.now() },
        [coordToken]: { email: 'coord@calendario.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.students = [
        { name: 'Ana', email: 'ana@calendario.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1DES', courseId: 'TI' }], studentClass: '1DES' },
        { name: 'Bia', email: 'bia@calendario.local', status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: '1ADM', courseId: 'ADM' }], studentClass: '1ADM' },
    ];
    db.memory.sessions = { 'ana@calendario.local': { token: anaToken, lastSeen: Date.now(), createdAt: Date.now(), ip: '127.0.0.1' } };
    db.memory.announcements = [
        { id: 'cal_1', kind: 'calendar', title: 'Prova de Redes', message: 'Trazer calculadora', eventDate: '2027-11-16', startTime: '08:00', endTime: '09:40', eventType: 'prova', target: 'turma', targetValue: '1DES', courseId: 'TI', readBy: [] },
        { id: 'cal_2', kind: 'calendar', title: 'Reunião da 2DES', eventDate: '2027-11-17', eventType: 'reuniao', target: 'turma', targetValue: '2DES', courseId: 'TI', readBy: [] },
    ];
    db.memory.auditLogs = [];
    db.memory.config = { ...(db.memory.config || {}), settings: { attendance: { autoOnLogin: true, windowStart: '', windowEnd: '' } } };
}

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => seedApp());
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const audits = action => db.memory.auditLogs.filter(entry => entry.action === action);

// Frequência da Ana na Chamada (selo de risco), que passa por dedupeByDate.
async function anaFrequency(date = '2027-11-22') {
    const res = await admin('get', `/api/admin/attendance/roster?courseId=TI&studentClass=1DES&date=${date}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.roster.find(row => row.email === 'ana@calendario.local').frequencia;
}

test('[UC-PRESENCA-005] presença do login já gravada no dia que vira feriado deixa de contar e volta a contar ao excluir o feriado', async () => {
    // 19 presenças e 1 falta pela chamada (95%) e a presença do login com falta no dia 15/11.
    for (let i = 0; i < 20; i++) {
        db.memory.attendance.push({ id: `ch_${i}`, origin: 'chamada', concluida: true, studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: `2027-10-${String(i + 1).padStart(2, '0')}`, aulas: [{ ordem: 1, disciplinaId: 'REDES', status: i === 0 ? 'falta' : 'presente' }] });
    }
    db.memory.attendance.push({ id: 'login_15', origin: 'login', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: '2027-11-15', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'falta' }, { ordem: 2, disciplinaId: 'REDES', status: 'falta' }] });
    assert.equal(await anaFrequency(), 86, '19 de 22 aulas');

    const created = await admin('post', '/api/admin/calendar/non-school-days/create')
        .send({ inicio: '2027-11-15', tipo: 'feriado', nome: 'Proclamação da República', escopo: 'instituicao' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.presencasIgnoradas, 1);
    const record = db.memory.attendance.find(item => item.id === 'login_15');
    assert.equal(record.naoLetivoId, created.body.dia.id, 'o registro fica, com a marca');
    assert.equal(await anaFrequency(), 95);
    const entry = audits('non_school_day_created').pop();
    assert.equal(entry.details.presencasIgnoradas, 1);
    assert.equal(entry.after.nome, 'Proclamação da República');
    assert.equal(entry.category, 'academic');

    // A marca foi para o disco (attendance só cresce: a linha antiga vai pela lista changed).
    await db.flush();
    const stored = (await db.readStoredData()).memory.attendance.find(item => item.id === 'login_15');
    assert.equal(stored.naoLetivoId, created.body.dia.id);

    const removed = await admin('post', '/api/admin/calendar/non-school-days/delete').send({ id: created.body.dia.id });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.presencasDevolvidas, 1);
    assert.ok(!('naoLetivoId' in db.memory.attendance.find(item => item.id === 'login_15')));
    assert.equal(await anaFrequency(), 86);
    const deleted = audits('non_school_day_deleted').pop();
    assert.equal(deleted.details.deleted.nome, 'Proclamação da República');
    assert.equal(deleted.details.presencasDevolvidas, 1);
});

test('[UC-PRESENCA-005] Chamada no feriado: naoLetivo e aulas vazias; com mesmoAssim=1 a grade, e a chamada salva conta', async () => {
    db.memory.nonSchoolDays = [day({ id: 'nl_rep', inicio: '2027-11-15', escopo: 'curso', courseId: 'TI', nome: 'Proclamação da República' })];
    const roster = await prof('get', '/api/admin/attendance/roster?courseId=TI&studentClass=1DES&date=2027-11-15');
    assert.equal(roster.status, 200);
    assert.deepEqual(roster.body.aulas, []);
    assert.equal(roster.body.aulasGrade.length, 2);
    assert.equal(roster.body.naoLetivo.nome, 'Proclamação da República');
    assert.equal(roster.body.naoLetivo.tipoRotulo, 'Feriado');
    assert.equal(roster.body.foraDoPeriodo, false);
    assert.deepEqual(roster.body.roster[0].aulas, []);

    const again = await prof('get', '/api/admin/attendance/roster?courseId=TI&studentClass=1DES&date=2027-11-15&mesmoAssim=1');
    assert.equal(again.body.aulas.length, 2);
    assert.equal(again.body.mesmoAssim, true);
    assert.equal(again.body.roster[0].aulas.length, 2);
    const saved = await prof('post', '/api/admin/attendance/bulk').send({
        courseId: 'TI', studentClass: '1DES', date: '2027-11-15', concluida: true,
        entries: [{ email: 'ana@calendario.local', aulas: again.body.aulasGrade.map(a => ({ ...a, status: 'falta' })) }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const rec = db.memory.attendance.find(item => item.date === '2027-11-15' && item.origin === 'chamada');
    assert.ok(rec && !rec.naoLetivoId, 'a chamada de reposição não é marcada');
    assert.equal(await anaFrequency(), 0, 'a chamada feita no feriado conta');
    // Quem volta ao feriado depois da chamada de reposição vê a chamada salva (o roster já
    // entra no "mesmo assim"), não a tela de dia sem aula.
    const back = await prof('get', '/api/admin/attendance/roster?courseId=TI&studentClass=1DES&date=2027-11-15');
    assert.equal(back.body.chamadaNoDia, true);
    assert.equal(back.body.mesmoAssim, true);
    assert.equal(back.body.aulas.length, 2);
    assert.equal(back.body.naoLetivo.nome, 'Proclamação da República', 'a faixa do feriado continua');
    assert.equal(back.body.roster[0].concluida, true);
    assert.deepEqual(back.body.roster[0].aulas.map(a => a.status), ['falta', 'falta']);
    // Só a presença automática do login no feriado não é chamada: continua sem a grade.
    db.memory.attendance = db.memory.attendance.filter(item => item.date !== '2027-11-15');
    db.memory.attendance.push({ id: 'login_rep', origin: 'login', naoLetivoId: 'nl_rep', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: '2027-11-15', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'presente' }] });
    const onlyLogin = await prof('get', '/api/admin/attendance/roster?courseId=TI&studentClass=1DES&date=2027-11-15');
    assert.equal(onlyLogin.body.chamadaNoDia, false);
    assert.equal(onlyLogin.body.mesmoAssim, false);
    assert.deepEqual(onlyLogin.body.aulas, []);
    // A marcação individual no feriado também é lançamento de propósito.
    db.memory.attendance.push({ id: 'manual_rep', origin: 'manual', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: '2027-11-15', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'presente' }] });
    const manual = await prof('get', '/api/admin/attendance/roster?courseId=TI&studentClass=1DES&date=2027-11-15');
    assert.equal(manual.body.chamadaNoDia, true);
    assert.equal(manual.body.aulas.length, 2);
    // Dia letivo: nada muda na resposta de antes.
    const normal = await prof('get', '/api/admin/attendance/roster?courseId=TI&studentClass=1DES&date=2027-11-22');
    assert.equal(normal.body.aulas.length, 2);
    assert.equal(normal.body.naoLetivo, null);
    assert.equal(normal.body.chamadaNoDia, false);
});

test('[UC-PRESENCA-005] portão da turma encerrada (X4): o dia de uma turma passa a turma (a de antes e a de depois); o da instituição passa sem turma; recusado, nada é gravado', async () => {
    const original = calendar.assertClassOpen;
    const seen = [];
    let recusar = false;
    calendar.assertClassOpen = (target, options) => {
        seen.push(target);
        if (!recusar) return true;
        options.res.status(409).json({ success: false, code: 'class_closed', error: calendar.CLASS_CLOSED_MESSAGE });
        return false;
    };
    try {
        const turma1 = db.memory.classes.find(cls => cls.name === '1DES');
        const turma2 = db.memory.classes.find(cls => cls.name === '2DES');
        const own = await admin('post', '/api/admin/calendar/non-school-days/create')
            .send({ inicio: '2027-11-22', tipo: 'evento_escolar', nome: 'Visita técnica', escopo: 'turma', courseId: 'TI', studentClass: '1DES' });
        assert.equal(own.status, 200, JSON.stringify(own.body));
        assert.equal(seen.pop(), turma1);
        const moved = await admin('post', '/api/admin/calendar/non-school-days/update')
            .send({ id: own.body.dia.id, inicio: '2027-11-22', tipo: 'evento_escolar', nome: 'Visita técnica', escopo: 'turma', courseId: 'TI', studentClass: '2DES' });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.deepEqual(seen.pop(), [turma1, turma2]);
        const institution = await admin('post', '/api/admin/calendar/non-school-days/create')
            .send({ inicio: '2027-11-15', tipo: 'feriado', nome: 'Proclamação da República', escopo: 'instituicao' });
        assert.equal(institution.status, 200);
        assert.equal(seen.pop(), null, 'o dia da instituição não depende de uma turma');

        // Com o efeito ligado (B10), a turma encerrada recusa e nada muda.
        recusar = true;
        db.memory.attendance.push({ id: 'login_22', origin: 'login', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: '2027-11-23', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'presente' }] });
        const before = JSON.stringify({ dias: db.memory.nonSchoolDays, attendance: db.memory.attendance });
        const audited = db.memory.auditLogs.length;
        const refused = await admin('post', '/api/admin/calendar/non-school-days/create')
            .send({ inicio: '2027-11-23', tipo: 'evento_escolar', nome: 'Feira', escopo: 'turma', courseId: 'TI', studentClass: '1DES' });
        assert.equal(refused.status, 409);
        assert.equal(refused.body.code, 'class_closed');
        assert.equal((await admin('post', '/api/admin/calendar/non-school-days/delete').send({ id: own.body.dia.id })).status, 409);
        assert.equal((await admin('post', '/api/admin/calendar/non-school-days/update')
            .send({ id: own.body.dia.id, inicio: '2027-11-23', tipo: 'evento_escolar', nome: 'Visita técnica', escopo: 'turma', courseId: 'TI', studentClass: '2DES' })).status, 409);
        assert.equal(JSON.stringify({ dias: db.memory.nonSchoolDays, attendance: db.memory.attendance }), before);
        assert.equal(db.memory.auditLogs.length, audited);
    } finally {
        calendar.assertClassOpen = original;
    }
});

test('[UC-PRESENCA-005] a presença do login marcada como dia não letivo não aparece como presença: calendário da ficha, sequência, dias ativos e CSV', async () => {
    const pad = n => String(n).padStart(2, '0');
    const localDay = offset => { const d = new Date(Date.now() - offset * 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const [hoje, ontem, anteontem] = [localDay(0), localDay(1), localDay(2)];
    db.memory.nonSchoolDays = [day({ id: 'nl_hoje', inicio: hoje, escopo: 'instituicao', nome: 'Feriado municipal' })];
    const presente = [{ ordem: 1, disciplinaId: 'REDES', status: 'presente' }];
    db.memory.attendance.push(
        { id: 'ch_2', origin: 'chamada', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: anteontem, aulas: presente, timestamp: Date.now() - 2 * 86400000 },
        { id: 'ch_1', origin: 'chamada', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: ontem, aulas: presente, timestamp: Date.now() - 86400000 },
        { id: 'login_hoje', origin: 'login', naoLetivoId: 'nl_hoje', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: hoje, aulas: presente, timestamp: Date.now() },
    );

    const dash = computeStudentDashboard(db.memory, 'ana@calendario.local');
    assert.deepEqual(dash.streak, { atual: 2, recorde: 2 }, 'o acesso no feriado não estende a sequência de presença');
    assert.equal(dash.engajamento.diasAtivos, 2);
    assert.equal(dash.temporal.presencaAtual, 2);

    const month = await admin('get', `/api/admin/student/attendance?email=ana@calendario.local&month=${hoje.slice(0, 7)}`);
    assert.equal(month.status, 200);
    assert.equal(month.body.days[hoje], 'nao_letivo', 'antes vinha "login", como presença');
    if (ontem.slice(0, 7) === hoje.slice(0, 7)) assert.equal(month.body.days[ontem], 'chamada');
    // Outro registro que vale no mesmo dia continua aparecendo.
    db.memory.attendance.push({ id: 'manual_hoje', origin: 'manual', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: hoje, aulas: presente, timestamp: Date.now() });
    const withManual = await admin('get', `/api/admin/student/attendance?email=ana@calendario.local&month=${hoje.slice(0, 7)}`);
    assert.equal(withManual.body.days[hoje], 'manual');
    db.memory.attendance = db.memory.attendance.filter(item => item.id !== 'manual_hoje');

    const csv = await admin('get', '/api/admin/attendance/export?courseId=TI&studentClass=1DES');
    assert.equal(csv.status, 200);
    const lines = csv.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    assert.equal(lines[0].split(';').pop(), 'Fora da frequência');
    assert.match(lines.find(line => line.startsWith(hoje)), /;Sim: dia não letivo \(Feriado municipal\)$/);
    assert.match(lines.find(line => line.startsWith(ontem)), /;Chamada;$/, 'a chamada conta: a coluna fica vazia');
});

test('[UC-PRESENCA-005] login no feriado dentro da janela das aulas não cria presença; no dia letivo cria', async () => {
    const today = settingsUtil.today();
    const now = attendanceUtil.hhmmToMin(settingsUtil.nowHHMM(settingsUtil.getSettings().timezone));
    const start = Math.max(0, now - 5);
    const hhmm = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    db.memory.classes[0].attendanceConfig = { toleranciaMin: 10, grade: { [String(weekday)]: [{ ordem: 1, disciplinaId: 'REDES', inicio: hhmm }] } };
    db.memory.nonSchoolDays = [day({ inicio: today, escopo: 'turma', courseId: 'TI', studentClass: '1DES', nome: 'Evento da escola', tipo: 'evento_escolar' })];
    const login = await request(app).post('/api/student/login').send({ email: 'ana@calendario.local', password: '123' });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    await request(app).get('/api/ping?email=ana@calendario.local').set('x-session-token', login.body.sessionToken).expect(200);
    assert.deepEqual(db.memory.attendance, [], 'antes o login no feriado criava a presença do dia');
    // Sem o dia não letivo, o mesmo acesso cria a presença automática.
    db.memory.nonSchoolDays = [];
    await request(app).get('/api/ping?email=ana@calendario.local').set('x-session-token', login.body.sessionToken).expect(200);
    assert.equal(db.memory.attendance.length, 1);
    assert.equal(db.memory.attendance[0].origin, 'login');
});

test('[UC-PRESENCA-005] escopo: o professor cadastra o dia da própria turma; instituição, outro curso e turma alheia são 403; a Coordenação só consulta', async () => {
    const own = await prof('post', '/api/admin/calendar/non-school-days/create')
        .send({ inicio: '2027-11-22', fim: '2027-11-23', tipo: 'evento_escolar', nome: 'Visita técnica', escopo: 'turma', courseId: 'TI', studentClass: '1DES' });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.dia.podeAlterar, true);
    const entry = audits('non_school_day_created').pop();
    assert.equal(entry.courseId, 'TI');
    assert.equal(entry.studentClass, '1DES');
    assert.equal(entry.actor, 'prof@calendario.local');

    const institution = await prof('post', '/api/admin/calendar/non-school-days/create')
        .send({ inicio: '2027-11-24', tipo: 'feriado', nome: 'Feriado', escopo: 'instituicao' });
    assert.equal(institution.status, 403);
    const course = await prof('post', '/api/admin/calendar/non-school-days/create')
        .send({ inicio: '2027-11-24', tipo: 'feriado', nome: 'Feriado', escopo: 'curso', courseId: 'TI' });
    assert.equal(course.status, 403, 'o curso inteiro pede quem gerencia turmas ou o curso');
    const other = await prof('post', '/api/admin/calendar/non-school-days/create')
        .send({ inicio: '2027-11-24', tipo: 'feriado', nome: 'Feriado', escopo: 'turma', courseId: 'TI', studentClass: '2DES' });
    assert.equal(other.status, 403);
    const national = await prof('post', '/api/admin/calendar/non-school-days/national-holidays').send({ ano: 2027 });
    assert.equal(national.status, 403);
    const coord = await request(app).post('/api/admin/calendar/non-school-days/create').set('x-admin-session', coordToken)
        .send({ inicio: '2027-11-24', tipo: 'feriado', nome: 'Feriado', escopo: 'escola', schoolId: 'esc_a' });
    assert.equal(coord.status, 403);
    assert.equal(coord.body.code, 'read_only_account');

    // O professor não altera nem exclui o dia da instituição; o administrador sim.
    const holiday = await admin('post', '/api/admin/calendar/non-school-days/create')
        .send({ inicio: '2027-11-15', tipo: 'feriado', nome: 'Proclamação da República', escopo: 'instituicao' });
    assert.equal(holiday.status, 200);
    const list = await prof('get', '/api/admin/calendar/non-school-days?courseId=TI&studentClass=1DES');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.dias.map(item => [item.nome, item.podeAlterar]), [['Proclamação da República', false], ['Visita técnica', true]]);
    assert.deepEqual(list.body.escopos.map(item => item.value), ['turma']);
    assert.equal(list.body.podeAdicionarFeriadosNacionais, false);
    assert.equal((await prof('post', '/api/admin/calendar/non-school-days/delete').send({ id: holiday.body.dia.id })).status, 403);
    assert.equal((await prof('post', '/api/admin/calendar/non-school-days/update').send({ id: holiday.body.dia.id, inicio: '2027-11-16', tipo: 'feriado', nome: 'X', escopo: 'turma', courseId: 'TI', studentClass: '1DES' })).status, 403);

    // Professor de fora não lista os dias de um curso que não é dele.
    const outside = await prof('get', '/api/admin/calendar/non-school-days?courseId=ADM');
    assert.equal(outside.status, 403);
});

test('[UC-PRESENCA-005] validação: data real, fim depois do início, até 120 dias, nome e alvo do escopo; repetido é 409', async () => {
    const send = body => admin('post', '/api/admin/calendar/non-school-days/create').send({ tipo: 'feriado', nome: 'Dia', escopo: 'instituicao', ...body });
    assert.equal((await send({ inicio: '2027-02-30' })).body.field, 'inicio');
    assert.equal((await send({ inicio: '2027-11-15', fim: '2027-11-10' })).body.field, 'fim');
    assert.equal((await send({ inicio: '2027-01-01', fim: '2027-06-01' })).body.field, 'fim');
    assert.equal((await send({ inicio: '2027-11-15', nome: '' })).body.field, 'nome');
    assert.equal((await send({ inicio: '2027-11-15', nome: 'x'.repeat(81) })).status, 400);
    assert.equal((await send({ inicio: '2027-11-15', tipo: 'festa' })).body.field, 'tipo');
    assert.equal((await send({ inicio: '2027-11-15', escopo: 'escola', schoolId: 'nao-existe' })).body.field, 'schoolId');
    assert.equal((await send({ inicio: '2027-11-15', escopo: 'turma', courseId: 'TI', studentClass: 'ZZZ' })).body.field, 'studentClass');
    assert.equal((await send({ inicio: 20271115 })).status, 400);
    assert.equal((await send({ inicio: '2027-11-15' })).status, 200);
    const again = await send({ inicio: '2027-11-15' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'duplicate');
    assert.equal(db.memory.nonSchoolDays.length, 1);
});

test('[UC-PRESENCA-005] alterar o dia move a marca da presença do login e registra antes e depois; salvar igual não registra', async () => {
    db.memory.attendance = [
        { id: 'l15', origin: 'login', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: '2027-11-15', aulas: [{ ordem: 1, status: 'falta' }] },
        { id: 'l16', origin: 'login', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: '2027-11-16', aulas: [{ ordem: 1, status: 'falta' }] },
    ];
    const created = await admin('post', '/api/admin/calendar/non-school-days/create')
        .send({ inicio: '2027-11-15', tipo: 'feriado', nome: 'Feriado municipal', escopo: 'curso', courseId: 'TI' });
    assert.equal(created.status, 200);
    const id = created.body.dia.id;
    const same = await admin('post', '/api/admin/calendar/non-school-days/update')
        .send({ id, inicio: '2027-11-15', tipo: 'feriado', nome: 'Feriado municipal', escopo: 'curso', courseId: 'TI' });
    assert.equal(same.body.semMudanca, true);
    assert.equal(audits('non_school_day_updated').length, 0);
    const moved = await admin('post', '/api/admin/calendar/non-school-days/update')
        .send({ id, inicio: '2027-11-16', tipo: 'feriado', nome: 'Feriado municipal', escopo: 'curso', courseId: 'TI' });
    assert.equal(moved.status, 200);
    assert.deepEqual([moved.body.marcadas, moved.body.desmarcadas], [1, 1]);
    assert.equal(db.memory.attendance[0].naoLetivoId, undefined);
    assert.equal(db.memory.attendance[1].naoLetivoId, id);
    const entry = audits('non_school_day_updated').pop();
    assert.equal(entry.before.inicio, '2027-11-15');
    assert.equal(entry.after.inicio, '2027-11-16');
    assert.deepEqual([entry.details.marcadas, entry.details.desmarcadas], [1, 1]);
});

test('[UC-PRESENCA-005] feriados nacionais: o botão cria os do ano, a segunda chamada não duplica e dá para deixar Carnaval e Corpus Christi de fora', async () => {
    const preview = await admin('get', '/api/admin/calendar/non-school-days/national-holidays?ano=2027');
    assert.equal(preview.status, 200);
    assert.equal(preview.body.feriados.length, 12);
    assert.ok(preview.body.feriados.every(item => item.jaCadastrado === false));
    const chaves = preview.body.feriados.map(item => item.chave).filter(chave => !['carnaval', 'corpus-christi'].includes(chave));
    const first = await admin('post', '/api/admin/calendar/non-school-days/national-holidays').send({ ano: 2027, incluir: chaves });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.criados.length, 10);
    assert.ok(first.body.criados.every(item => item.escopo === 'instituicao' && item.origem === 'feriados_nacionais'));
    assert.equal(audits('national_holidays_added').pop().details.criados.length, 10);
    const second = await admin('post', '/api/admin/calendar/non-school-days/national-holidays').send({ ano: '2027' });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.criados.map(item => item.inicio), ['2027-02-08', '2027-05-27'], 'só os dois que faltavam');
    const third = await admin('post', '/api/admin/calendar/non-school-days/national-holidays').send({ ano: 2027 });
    assert.equal(third.body.criados.length, 0);
    assert.equal(db.memory.nonSchoolDays.length, 12);
    assert.equal(audits('national_holidays_added').length, 2, 'a chamada que não cria nada não registra');
    assert.equal((await admin('post', '/api/admin/calendar/non-school-days/national-holidays').send({ ano: 2027, incluir: ['natal-de-marte'] })).body.field, 'incluir');
    assert.equal((await admin('post', '/api/admin/calendar/non-school-days/national-holidays').send({ ano: 1999 })).status, 400);
    const after = await admin('get', '/api/admin/calendar/non-school-days/national-holidays?ano=2027');
    assert.ok(after.body.feriados.every(item => item.jaCadastrado === true));
});

test('[UC-PRESENCA-005] calendários do painel e do aluno trazem os dias não letivos da turma, só de leitura', async () => {
    db.memory.nonSchoolDays = [
        day({ id: 'nl_rec', inicio: '2027-07-12', fim: '2027-07-23', tipo: 'recesso', nome: 'Recesso escolar', escopo: 'instituicao' }),
        day({ id: 'nl_2des', inicio: '2027-11-18', nome: 'Só da 2DES', escopo: 'turma', courseId: 'TI', studentClass: '2DES' }),
        day({ id: 'nl_adm', inicio: '2027-11-19', nome: 'Só do ADM', escopo: 'curso', courseId: 'ADM' }),
    ];
    const panel = await prof('get', '/api/admin/announcements/calendar?courseId=TI&studentClass=1DES');
    assert.equal(panel.status, 200);
    const nonSchool = panel.body.filter(item => item.kind === 'nonSchoolDay');
    assert.deepEqual(nonSchool.map(item => [item.title, item.eventDate, item.endDate, item.readOnly, item.eventType]),
        [['Recesso escolar', '2027-07-12', '2027-07-23', true, 'nao_letivo']]);
    assert.ok(panel.body.some(item => item.id === 'cal_1'), 'os eventos de antes continuam');

    const student = await request(app).get('/api/student/calendar-events?courseId=TI&studentClass=1DES').set('x-session-token', anaToken);
    assert.equal(student.status, 200);
    const holiday = student.body.find(item => item.eventType === 'nao_letivo');
    assert.deepEqual([holiday.title, holiday.eventDate, holiday.endDate], ['Recesso escolar', '2027-07-12', '2027-07-23']);
    assert.match(holiday.description, /não há aula de 12\/07 a 23\/07/);
    assert.ok(!student.body.some(item => /2DES|ADM/.test(item.title)), 'nada de outra turma nem de outro curso');
    assert.deepEqual(student.body.map(item => item.eventDate), [...student.body.map(item => item.eventDate)].sort(), 'em ordem de data');
});

test('[UC-PRESENCA-005] .ics do painel e do aluno: eventos e dias não letivos da turma, sem os de outra turma; o do aluno exige sessão e matrícula', async () => {
    db.memory.nonSchoolDays = [
        day({ id: 'nl_rep', inicio: '2027-11-15', nome: 'Proclamação da República', escopo: 'instituicao' }),
        day({ id: 'nl_2des', inicio: '2027-11-18', nome: 'Só da 2DES', escopo: 'turma', courseId: 'TI', studentClass: '2DES' }),
    ];
    const panel = await prof('get', '/api/admin/calendar/ics?courseId=TI&studentClass=1DES');
    assert.equal(panel.status, 200);
    assert.match(panel.headers['content-type'], /^text\/calendar; charset=utf-8/);
    assert.match(panel.headers['content-disposition'], /attachment; filename="agenda-TI-1DES\.ics"/);
    // O mesmo dia tem o mesmo UID nas duas agendas: importar as duas não duplica.
    assert.match(panel.text, /BEGIN:VEVENT\r\nUID:nao-letivo:nl_rep@iclass\r\n/);
    assert.match(panel.text, /DTSTART;VALUE=DATE:20271115\r\nDTEND;VALUE=DATE:20271116\r\n/);
    assert.match(panel.text, /SUMMARY:Prova de Redes\r\n/);
    assert.ok(!/2DES/.test(panel.text.replace('X-WR-CALNAME', '')), 'nada da 2DES');
    assert.equal((await prof('get', '/api/admin/calendar/ics?courseId=ADM&studentClass=1ADM')).status, 403);
    assert.equal((await admin('get', '/api/admin/calendar/ics')).status, 400);

    // Sem turma, a agenda do curso traz só o que está no escopo da conta: o professor da
    // 1DES não recebe o evento da 2DES do mesmo curso (o calendário do painel já filtrava);
    // o administrador, sim.
    const courseOnly = await prof('get', '/api/admin/calendar/ics?courseId=TI');
    assert.equal(courseOnly.status, 200);
    assert.match(courseOnly.text, /SUMMARY:Prova de Redes\r\n/);
    assert.ok(!/Reunião da 2DES/.test(courseOnly.text), 'o evento da outra turma fica fora da agenda do professor');
    const panelCourse = await prof('get', '/api/admin/announcements/calendar?courseId=TI');
    assert.ok(!panelCourse.body.some(item => item.id === 'cal_2'), 'a mesma regra do calendário do painel');
    const adminCourse = await admin('get', '/api/admin/calendar/ics?courseId=TI');
    assert.equal(adminCourse.status, 200);
    assert.match(adminCourse.text, /SUMMARY:Reunião da 2DES\r\n/);

    const student = await request(app).get('/api/student/calendar.ics?courseId=TI&studentClass=1DES').set('x-session-token', anaToken);
    assert.equal(student.status, 200);
    assert.match(student.text, /UID:nao-letivo:nl_rep@iclass\r\n/);
    assert.match(student.text, /UID:cal_1@iclass\r\n/);
    assert.ok(!/Reunião da 2DES|Só da 2DES/.test(student.text));
    assert.equal((await request(app).get('/api/student/calendar.ics?courseId=TI&studentClass=1DES')).status, 400, 'sem sessão');
    assert.equal((await request(app).get('/api/student/calendar.ics?courseId=TI&studentClass=1DES').set('x-session-token', 'token-desconhecido')).status, 401);
    assert.equal((await request(app).get('/api/student/calendar.ics?courseId=ADM&studentClass=1ADM').set('x-session-token', anaToken)).status, 403);
});

test('[UC-PRESENCA-005] lista do Calendário: contexto com a escola do curso; sem escola não oferece "Toda a escola"; a Coordenação recebe escopos vazios e nada alterável (B7)', async () => {
    db.memory.nonSchoolDays = [day({ id: 'nl_esc', inicio: '2027-11-15', nome: 'Aniversário da escola', escopo: 'escola', schoolId: 'esc_a' })];
    const full = await admin('get', '/api/admin/calendar/non-school-days?courseId=TI&studentClass=1DES');
    assert.equal(full.status, 200);
    // Antes não vinha a escola do curso, e a tela não tinha como mandar o schoolId do dia de escola.
    assert.deepEqual(full.body.contexto, { courseId: 'TI', studentClass: '1DES', schoolId: 'esc_a', escolaNome: 'Escola A' });
    assert.deepEqual(full.body.escopos.map(item => item.value), ['instituicao', 'escola', 'curso', 'turma']);
    assert.equal(full.body.dias[0].podeAlterar, true);

    // Curso sem escola: o dia de escola não valeria para ele, então o escopo não aparece.
    db.memory.courses.find(course => course.id === 'TI').schoolId = '';
    const noSchool = await admin('get', '/api/admin/calendar/non-school-days?courseId=TI&studentClass=1DES');
    assert.deepEqual(noSchool.body.escopos.map(item => item.value), ['instituicao', 'curso', 'turma']);
    assert.equal(noSchool.body.contexto.schoolId, null);
    db.memory.courses.find(course => course.id === 'TI').schoolId = 'esc_a';

    // Pedido sem turma: não oferece "Só a turma".
    const courseOnly = await admin('get', '/api/admin/calendar/non-school-days?courseId=TI');
    assert.deepEqual(courseOnly.body.escopos.map(item => item.value), ['instituicao', 'escola', 'curso']);

    // A Coordenação tem a escola no escopo, mas é só de consulta: nada para cadastrar nem alterar.
    const coord = await request(app).get('/api/admin/calendar/non-school-days?courseId=TI&studentClass=1DES').set('x-admin-session', coordToken);
    assert.equal(coord.status, 200, JSON.stringify(coord.body));
    assert.deepEqual(coord.body.escopos, []);
    assert.equal(coord.body.podeAdicionarFeriadosNacionais, false);
    assert.deepEqual(coord.body.dias.map(item => [item.nome, item.podeAlterar]), [['Aniversário da escola', false]]);

    // O dia de escola cadastrado com a escola do contexto vale para a turma.
    const created = await admin('post', '/api/admin/calendar/non-school-days/create')
        .send({ inicio: '2027-11-22', tipo: 'evento_escolar', nome: 'Feira de ciências', escopo: 'escola', schoolId: full.body.contexto.schoolId });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(calendar.isNonSchoolDay(db.memory, db.memory.classes[0], '2027-11-22').nome, 'Feira de ciências');
});

test('[UC-PRESENCA-005] Início do aluno: os dias sem aula que ainda não acabaram entram nos próximos compromissos, com o de hoje marcado (B7)', async () => {
    const today = settingsUtil.today();
    db.memory.nonSchoolDays = [
        day({ id: 'nl_hoje', inicio: calendar.addDays(today, -1), fim: calendar.addDays(today, 1), tipo: 'recesso', nome: 'Recesso em andamento', escopo: 'instituicao' }),
        day({ id: 'nl_passou', inicio: calendar.addDays(today, -5), fim: calendar.addDays(today, -1), nome: 'Já passou', escopo: 'instituicao' }),
        day({ id: 'nl_depois', inicio: calendar.addDays(today, 3), nome: 'Feriado logo ali', escopo: 'curso', courseId: 'TI' }),
        day({ id: 'nl_2des', inicio: calendar.addDays(today, 2), nome: 'Só da 2DES', escopo: 'turma', courseId: 'TI', studentClass: '2DES' }),
    ];
    db.memory.announcements = [
        { id: 'cal_futuro', kind: 'calendar', title: 'Prova de Redes', eventDate: calendar.addDays(today, 2), startTime: '08:00', eventType: 'prova', target: 'turma', targetValue: '1DES', courseId: 'TI', readBy: [] },
    ];
    const res = await request(app).get('/api/student/dashboard?courseId=TI&studentClass=1DES').set('x-session-token', anaToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Antes só vinham os eventos do calendário (o dia sem aula não aparecia no Início).
    assert.deepEqual(res.body.calendar.map(item => [item.title, item.eventType, item.hoje === true]), [
        ['Recesso em andamento', 'nao_letivo', true],
        ['Prova de Redes', 'prova', false],
        ['Feriado logo ali', 'nao_letivo', false],
    ]);
    const recesso = res.body.calendar[0];
    assert.equal(recesso.id, 'nao-letivo:nl_hoje', 'o mesmo id do calendário do aluno');
    assert.equal(recesso.endDate, calendar.addDays(today, 1));
});

// Por último: a restauração troca o banco inteiro (o beforeEach dos testes acima semeia de novo).
test('[UC-BACKUP-008] backup de antes dos dias não letivos mantém os dias de hoje e marca a presença do login dele; backup com os dias os traz', async () => {
    const backup = require('../../backend/utils/backup.js');
    db.memory.nonSchoolDays = [day({ id: 'nl_atual', inicio: '2027-11-15', escopo: 'instituicao', nome: 'Proclamação da República' })];
    await db.save();
    const snapshot = backup.buildDataSnapshot();
    // Como a versão anterior gravava: sem as coleções novas e com a presença do login no feriado.
    delete snapshot.data.nonSchoolDays;
    delete snapshot.data.academicTerms;
    snapshot.data.attendance = [{ id: 'login_antigo', origin: 'login', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: '2027-11-15', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'presente' }] }];
    const restored = await admin('post', '/api/admin/backup/restore').field('confirm', 'RESTAURAR')
        .attach('file', Buffer.from(JSON.stringify(snapshot)), 'backup-antigo.json');
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(db.memory.nonSchoolDays.map(item => item.id), ['nl_atual'], 'coleção ausente no backup fica como está');
    const record = db.memory.attendance.find(item => item.id === 'login_antigo');
    assert.equal(record.naoLetivoId, 'nl_atual', 'a presença do login da versão anterior no feriado sai da frequência');
    await db.flush();
    const stored = (await db.readStoredData()).memory;
    assert.equal(stored.attendance.find(item => item.id === 'login_antigo').naoLetivoId, 'nl_atual');
    assert.deepEqual(stored.nonSchoolDays.map(item => item.id), ['nl_atual']);

    // Backup que já traz os dias: eles substituem os de hoje, e a marca acompanha.
    db.memory.adminSessions = { [adminToken]: { email: 'admin@calendario.local', createdAt: Date.now(), lastSeen: Date.now() } }; // a restauração encerra as sessões
    const withDays = backup.buildDataSnapshot();
    withDays.data.nonSchoolDays = [{ id: 'nl_backup', inicio: '2027-11-16', fim: '2027-11-16', tipo: 'evento_escolar', nome: 'Conselho de classe', escopo: 'curso', courseId: 'TI' }];
    withDays.data.attendance = [
        { id: 'login_15', origin: 'login', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: '2027-11-15', naoLetivoId: 'nl_atual', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'presente' }] },
        { id: 'login_16', origin: 'login', studentEmail: 'ana@calendario.local', courseId: 'TI', studentClass: '1DES', date: '2027-11-16', aulas: [{ ordem: 1, disciplinaId: 'REDES', status: 'falta' }] },
    ];
    const second = await admin('post', '/api/admin/backup/restore').field('confirm', 'RESTAURAR')
        .attach('file', Buffer.from(JSON.stringify(withDays)), 'backup-com-dias.json');
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(db.memory.nonSchoolDays.map(item => item.id), ['nl_backup']);
    assert.ok(!('naoLetivoId' in db.memory.attendance.find(item => item.id === 'login_15')), 'o dia nl_atual não existe mais: a presença volta a contar');
    assert.equal(db.memory.attendance.find(item => item.id === 'login_16').naoLetivoId, 'nl_backup');
});
