// Calendário acadêmico (fase 3): "há aula nesta turma nesta data?" num lugar só (D12 do
// P2; contrato C4) e o portão das gravações de nota e presença (X4 do plano).
//
// - lessonsForDate(memory, cls, date): as aulas da turma naquela data: [] fora do período
//   letivo da turma (quando ela tem um) e em dia não letivo; senão a grade da semana
//   (attendanceUtil.gradeForDate). dayStatus devolve o mesmo com o porquê (naoLetivo,
//   foraDoPeriodo) e a grade da semana (aulasGrade), para a Chamada e o Dashboard.
//   Chamar attendanceUtil.gradeForDate fora daqui e de attendance.js quebra o teste de
//   guarda (test/backend/academic-calendar.test.js); quem precisa da grade sem o
//   calendário (a chamada feita "mesmo assim", a marcação individual) usa weeklyLessons.
// - isNonSchoolDay(memory, alvo, date): o dia não letivo (registro de memory.nonSchoolDays)
//   que vale para o alvo naquela data, ou null. Alvo: a turma (registro de
//   memory.classes), { cls }, { courseId, studentClass }, { courseId } ou { schoolId }.
//   Vale o dia de toda a instituição, o da escola do curso, o do curso e o da turma; com
//   mais de um, o mais específico (turma, curso, escola, instituição).
//   nonSchoolDaysFor(memory, alvo, { from, to }) lista os do alvo que cruzam o intervalo.
// - termForClass(memory, cls): o período letivo da turma (memory.academicTerms pelo
//   classes[].periodoLetivoId), ou null (turma sem período funciona como sempre: todo dia
//   de grade é letivo). plannedLessons(memory, cls, { from, to }): as aulas previstas no
//   intervalo (dentro do período da turma), no total e por disciplina.
// - nationalHolidays(ano): os feriados nacionais do ano, calculados aqui (datas fixas e,
//   pela Páscoa, Carnaval, Sexta-feira Santa e Corpus Christi), sem internet.
// - Presença do login em dia não letivo (D13 do P2): o registro não é apagado; ganha
//   naoLetivoId e a frequência o ignora (attendance.js: isIgnoredNonSchoolRecord, usado
//   por dedupeByDate e computeAttendanceStats). syncNonSchoolDayMarks põe e tira a marca
//   conforme os dias cadastrados agora: nas rotas que cadastram, alteram e excluem um dia
//   (só nas datas que elas mexem) e em todo boot e depois de toda restauração
//   (BOOT_NORMALIZATIONS em backend/migrations/index.js), porque a versão anterior pode
//   ter aberto o banco e criado presença do login num feriado, e um backup antigo
//   restaurado volta a presença sem a marca (os dias não letivos ficam: missing 'keep').
//   A chamada e a marcação individual nunca são marcadas (quem lançou num feriado lançou
//   de propósito), e turma encerrada não muda.
//
// Este arquivo não carrega database.js nem settings.js (o registro de migrações o lê com
// o servidor parado): a data de hoje vem sempre de quem chama.
//
// Portão (assertClassOpen), ainda SEM EFEITO: toda turma está aberta. Ele nasceu antes
// do resto para as rotas que gravam nota ou presença já o chamarem (teste de guarda
// test/backend/class-open-guard.test.js) e as rotas novas da fase 3 nascerem chamando. O
// B10 (P2-S9) liga o efeito: turma com encerramento responde 409 { code: 'class_closed' }
// nas rotas do teste de guarda, inclusive as da tarefa.
//
// Uso nas rotas, antes de mudar qualquer coisa:
//     if (!assertClassOpen(cls, { res })) return;
// - cls: a turma (registro de memory.classes), uma lista delas (pedido que mexe em
//   entregas de turmas diferentes) ou null/undefined (registro sem turma conhecida:
//   passa, como hoje);
// - com res: devolve true quando pode gravar; quando não pode, já respondeu o 409 e
//   devolve false;
// - sem res: devolve true ou lança ClassClosedError (status 409, code 'class_closed'),
//   para quem está fora de uma rota (utilitário, teste).
const { normalizeEmail, studentClassEntries } = require('./students.js');
const attendanceUtil = require('./attendance.js');

const CLASS_CLOSED_CODE = 'class_closed';
const CLASS_CLOSED_MESSAGE = 'Esta turma foi encerrada. Para mudar notas ou presença, reabra a turma em Turmas.';

class ClassClosedError extends Error {
    constructor(cls, message = CLASS_CLOSED_MESSAGE) {
        super(message);
        this.name = 'ClassClosedError';
        this.status = 409;
        this.code = CLASS_CLOSED_CODE;
        this.studentClass = cls && typeof cls === 'object' ? String(cls.name || '') : '';
        this.courseId = cls && typeof cls === 'object' ? String(cls.courseId || '') : '';
    }
}

function classClosedBody(error) {
    return { success: false, error: (error && error.message) || CLASS_CLOSED_MESSAGE, code: CLASS_CLOSED_CODE };
}

// A turma está encerrada? Sem efeito até o B10: nenhuma turma está.
function isClassClosed(cls) { // eslint-disable-line no-unused-vars
    return false;
}

// Recusa a gravação em turma encerrada (ver o começo do arquivo).
function assertClassOpen(target, { res } = {}) {
    const list = Array.isArray(target) ? target : [target];
    const closed = list.find(cls => cls && typeof cls === 'object' && isClassClosed(cls));
    if (!closed) return true;
    const error = new ClassClosedError(closed);
    if (res && typeof res.status === 'function') {
        res.status(error.status).json(classClosedBody(error));
        return false;
    }
    throw error;
}

// Turma de uma entrega de prova (curso e turma da entrega ou do cadastro copiado nela).
// Entrega antiga sem curso: o curso da matrícula do aluno naquela turma (cadastro de
// hoje, pelo e-mail) e, sem matrícula que resolva, a turma com aquele nome. null quando
// não há turma conhecida.
function classOfSubmission(memory, submission) {
    if (!submission || typeof submission !== 'object') return null;
    const student = submission.student && typeof submission.student === 'object' ? submission.student : {};
    const name = String(submission.studentClass || student.studentClass || '').trim();
    if (!name) return null;
    const classes = (memory && Array.isArray(memory.classes)) ? memory.classes : [];
    const byCourse = courseId => classes.find(cls => cls && cls.name === name && String(cls.courseId || '') === courseId) || null;
    const courseId = String(submission.courseId || student.courseId || '').trim();
    if (courseId) return byCourse(courseId);
    const sameName = classes.filter(cls => cls && cls.name === name);
    if (sameName.length > 1) {
        const email = normalizeEmail(student.email || submission.studentEmail);
        const current = email ? ((memory && memory.students) || []).find(item => item && normalizeEmail(item.email) === email) : null;
        const enrolled = [...new Set(studentClassEntries(current).filter(entry => entry.name === name && entry.courseId).map(entry => entry.courseId))];
        if (enrolled.length === 1 && byCourse(enrolled[0])) return byCourse(enrolled[0]);
    }
    return sameName[0] || null;
}

// Turmas (sem repetir) das entregas de um pedido.
function classesOfSubmissions(memory, submissions) {
    const out = [];
    (Array.isArray(submissions) ? submissions : []).forEach(item => {
        const cls = classOfSubmission(memory, item);
        if (cls && !out.includes(cls)) out.push(cls);
    });
    return out;
}

// ============================================================================
// Datas, dias não letivos e período letivo (B3 / P2-S5, FUN-15)
// ============================================================================

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Tipos e escopos do dia não letivo (memory.nonSchoolDays), com os rótulos da tela.
const NON_SCHOOL_DAY_TYPES = Object.freeze(['feriado', 'recesso', 'ponto_facultativo', 'evento_escolar', 'outro']);
const NON_SCHOOL_DAY_TYPE_LABELS = Object.freeze({
    feriado: 'Feriado',
    recesso: 'Recesso',
    ponto_facultativo: 'Ponto facultativo',
    evento_escolar: 'Evento escolar',
    outro: 'Outro',
});
const NON_SCHOOL_DAY_SCOPES = Object.freeze(['instituicao', 'escola', 'curso', 'turma']);
const NON_SCHOOL_DAY_SCOPE_LABELS = Object.freeze({
    instituicao: 'Toda a instituição',
    escola: 'Toda a escola',
    curso: 'Todo o curso',
    turma: 'Só a turma',
});
// Mais específico primeiro (o dia da turma vence o do curso, que vence o da escola...).
const SCOPE_RANK = Object.freeze({ turma: 4, curso: 3, escola: 2, instituicao: 1 });
// Um dia não letivo cobre no máximo 120 dias (recesso de meio de ano, férias).
const MAX_NON_SCHOOL_DAY_SPAN = 120;
// Intervalo máximo de plannedLessons (um período letivo tem até 400 dias).
const MAX_PLANNED_SPAN = 400;

// Data real 'AAAA-MM-DD' (recusa 2027-02-30).
function isValidDate(value) {
    const match = YMD_RE.exec(String(value === undefined || value === null ? '' : value));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function addDays(date, days) {
    const match = YMD_RE.exec(String(date || ''));
    if (!match) return null;
    const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(days || 0)));
    return value.toISOString().slice(0, 10);
}

// Dias de 'from' até 'to' contando os dois (0 se 'to' vem antes).
function spanDays(from, to) {
    if (!isValidDate(from) || !isValidDate(to)) return 0;
    const diff = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
    return diff < 0 ? 0 : diff + 1;
}

const text = value => String(value === undefined || value === null ? '' : value).trim();

// Dia não letivo gravado, lido com tolerância (registro de versão futura ou editado à
// mão): datas reais, fim ausente = o próprio início, tipo desconhecido = 'outro'. Sem
// início válido, com escopo desconhecido ou sem o alvo do escopo, o registro não vale
// para ninguém (null), em vez de valer para todos.
function normalizeNonSchoolDay(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = text(raw.id);
    const inicio = text(raw.inicio);
    if (!id || !isValidDate(inicio)) return null;
    let fim = text(raw.fim);
    if (!isValidDate(fim) || fim < inicio) fim = inicio;
    const escopo = text(raw.escopo);
    if (!NON_SCHOOL_DAY_SCOPES.includes(escopo)) return null;
    const schoolId = text(raw.schoolId);
    const courseId = text(raw.courseId);
    const studentClass = text(raw.studentClass);
    if (escopo === 'escola' && !schoolId) return null;
    if (escopo === 'curso' && !courseId) return null;
    if (escopo === 'turma' && !studentClass) return null;
    const tipo = NON_SCHOOL_DAY_TYPES.includes(text(raw.tipo)) ? text(raw.tipo) : 'outro';
    return {
        id,
        inicio,
        fim,
        tipo,
        nome: text(raw.nome) || NON_SCHOOL_DAY_TYPE_LABELS[tipo],
        escopo,
        schoolId: escopo === 'escola' ? schoolId : '',
        courseId: escopo === 'curso' || escopo === 'turma' ? courseId : '',
        studentClass: escopo === 'turma' ? studentClass : '',
    };
}

// Resumo do dia não letivo para as respostas (Chamada, Dashboard, calendários).
function nonSchoolDaySummary(day) {
    if (!day) return null;
    return {
        id: day.id,
        nome: day.nome,
        tipo: day.tipo,
        tipoRotulo: NON_SCHOOL_DAY_TYPE_LABELS[day.tipo] || NON_SCHOOL_DAY_TYPE_LABELS.outro,
        inicio: day.inicio,
        fim: day.fim,
        escopo: day.escopo,
    };
}

function courseById(memory, courseId) {
    const id = text(courseId);
    if (!id) return null;
    return ((memory && memory.courses) || []).find(course => course && String(course.id) === id) || null;
}

// Contexto do alvo: { schoolId, courseId, studentClass }. A escola é a do curso.
function targetContext(memory, target) {
    let cls = null;
    let source = {};
    if (target && typeof target === 'object' && !Array.isArray(target)) {
        if (target.cls && typeof target.cls === 'object') cls = target.cls;
        else if (typeof target.name === 'string' && !('studentClass' in target)) cls = target;
        else source = target;
    }
    const courseId = text(cls ? cls.courseId : source.courseId);
    const studentClass = text(cls ? cls.name : source.studentClass);
    const course = courseById(memory, courseId);
    const schoolId = text(source.schoolId) || text(course && course.schoolId);
    return { schoolId, courseId, studentClass };
}

function dayAppliesTo(day, context) {
    if (!day) return false;
    if (day.escopo === 'instituicao') return true;
    if (day.escopo === 'escola') return !!context.schoolId && day.schoolId === context.schoolId;
    if (day.escopo === 'curso') return !!context.courseId && day.courseId === context.courseId;
    if (day.escopo === 'turma') {
        return !!context.studentClass && day.studentClass === context.studentClass && day.courseId === context.courseId;
    }
    return false;
}

function compareDays(a, b) {
    return a.inicio.localeCompare(b.inicio)
        || (SCOPE_RANK[b.escopo] - SCOPE_RANK[a.escopo])
        || a.fim.localeCompare(b.fim)
        || a.id.localeCompare(b.id);
}

function storedNonSchoolDays(memory) {
    return ((memory && memory.nonSchoolDays) || []).map(normalizeNonSchoolDay).filter(Boolean);
}

// Dias não letivos do alvo que cruzam o intervalo [from, to] (os dois opcionais), em
// ordem de início.
function nonSchoolDaysFor(memory, target, { from, to } = {}) {
    const context = targetContext(memory, target);
    return storedNonSchoolDays(memory)
        .filter(day => dayAppliesTo(day, context)
            && (!isValidDate(from) || day.fim >= from)
            && (!isValidDate(to) || day.inicio <= to))
        .sort(compareDays);
}

// O dia não letivo do alvo naquela data (o mais específico), ou null.
function isNonSchoolDay(memory, target, date) {
    if (!isValidDate(date)) return null;
    const covering = nonSchoolDaysFor(memory, target, { from: date, to: date });
    if (!covering.length) return null;
    return covering.sort((a, b) => (SCOPE_RANK[b.escopo] - SCOPE_RANK[a.escopo]) || a.inicio.localeCompare(b.inicio) || a.id.localeCompare(b.id))[0];
}

// Período letivo da turma (classes[].periodoLetivoId em memory.academicTerms), ou null.
// O período sem datas reais não vale (a turma fica como sem período).
function termForClass(memory, cls) {
    const id = text(cls && cls.periodoLetivoId);
    if (!id) return null;
    const term = ((memory && memory.academicTerms) || []).find(item => item && String(item.id) === id);
    if (!term || !isValidDate(term.inicio) || !isValidDate(term.fim) || term.fim < term.inicio) return null;
    return term;
}

function termSummary(term) {
    if (!term) return null;
    return { id: String(term.id), nome: text(term.nome), inicio: term.inicio, fim: term.fim };
}

// A grade da semana da turma naquela data, sem olhar o calendário: só para quem lança de
// propósito num dia sem aula (a chamada feita "mesmo assim", a marcação individual) e
// para os dados de demonstração. Todo o resto usa lessonsForDate.
function weeklyLessons(cls, date) {
    return cls ? attendanceUtil.gradeForDate(cls, date) : [];
}

// A situação da turma naquela data:
// { date, aulasGrade, aulas, naoLetivo, foraDoPeriodo, periodo } (aulas é [] fora do
// período letivo e em dia não letivo; aulasGrade é a grade da semana).
function dayStatus(memory, cls, date) {
    const aulasGrade = weeklyLessons(cls, date);
    const term = cls ? termForClass(memory, cls) : null;
    const foraDoPeriodo = !!term && isValidDate(date) && (date < term.inicio || date > term.fim);
    const day = cls ? isNonSchoolDay(memory, cls, date) : null;
    return {
        date,
        aulasGrade,
        aulas: foraDoPeriodo || day ? [] : aulasGrade,
        naoLetivo: nonSchoolDaySummary(day),
        foraDoPeriodo,
        periodo: termSummary(term),
    };
}

// Há aula nesta turma nesta data? As aulas (vazio quando não há; ver dayStatus).
function lessonsForDate(memory, cls, date) {
    return dayStatus(memory, cls, date).aulas;
}

// Aulas previstas no intervalo (dentro do período letivo da turma, quando ela tem um):
// { de, ate, total, porDisciplina: { [disciplinaId]: n } }. Sem intervalo e sem período,
// ou com intervalo inválido, null.
function plannedLessons(memory, cls, { from, to } = {}) {
    if (!cls) return null;
    const term = termForClass(memory, cls);
    let de = isValidDate(from) ? from : (term ? term.inicio : null);
    let ate = isValidDate(to) ? to : (term ? term.fim : null);
    if (!de || !ate) return null;
    if (term) {
        if (de < term.inicio) de = term.inicio;
        if (ate > term.fim) ate = term.fim;
    }
    if (ate < de || spanDays(de, ate) > MAX_PLANNED_SPAN) return null;
    const porDisciplina = {};
    let total = 0;
    for (let date = de; date <= ate; date = addDays(date, 1)) {
        lessonsForDate(memory, cls, date).forEach(aula => {
            const id = text(aula && aula.disciplinaId);
            porDisciplina[id] = (porDisciplina[id] || 0) + 1;
            total += 1;
        });
    }
    return { de, ate, total, porDisciplina };
}

// --- feriados nacionais (D15 do P2) ----------------------------------------------------

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano).
function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Feriados nacionais do ano: [{ chave, inicio, fim, nome, tipo }], em ordem de data.
// Carnaval (segunda e terça) e Corpus Christi entram como ponto facultativo (a tela os
// deixa desmarcar). O Dia Nacional de Zumbi e da Consciência Negra é feriado nacional
// desde 2024 (Lei 14.759/2023). Estaduais e municipais são cadastrados à mão.
function nationalHolidays(year) {
    const ano = Number(year);
    if (!Number.isInteger(ano) || ano < 1900 || ano > 2999) return [];
    const y = String(ano).padStart(4, '0');
    const fixed = (mmdd, chave, nome) => ({ chave, inicio: `${y}-${mmdd}`, fim: `${y}-${mmdd}`, nome, tipo: 'feriado' });
    const easter = easterSunday(ano);
    const list = [
        fixed('01-01', 'confraternizacao', 'Confraternização Universal'),
        { chave: 'carnaval', inicio: addDays(easter, -48), fim: addDays(easter, -47), nome: 'Carnaval', tipo: 'ponto_facultativo' },
        { chave: 'sexta-feira-santa', inicio: addDays(easter, -2), fim: addDays(easter, -2), nome: 'Sexta-feira Santa', tipo: 'feriado' },
        fixed('04-21', 'tiradentes', 'Tiradentes'),
        fixed('05-01', 'dia-do-trabalho', 'Dia do Trabalho'),
        { chave: 'corpus-christi', inicio: addDays(easter, 60), fim: addDays(easter, 60), nome: 'Corpus Christi', tipo: 'ponto_facultativo' },
        fixed('09-07', 'independencia', 'Independência do Brasil'),
        fixed('10-12', 'nossa-senhora-aparecida', 'Nossa Senhora Aparecida'),
        fixed('11-02', 'finados', 'Finados'),
        fixed('11-15', 'proclamacao-da-republica', 'Proclamação da República'),
        fixed('12-25', 'natal', 'Natal'),
    ];
    if (ano >= 2024) list.push(fixed('11-20', 'consciencia-negra', 'Dia Nacional de Zumbi e da Consciência Negra'));
    return list.sort((a, b) => a.inicio.localeCompare(b.inicio));
}

// --- presença do login em dia não letivo (D13 do P2) -----------------------------------

function classForRecord(memory, record) {
    const name = text(record && record.studentClass);
    if (!name) return null;
    const courseId = text(record && record.courseId);
    const classes = (memory && memory.classes) || [];
    if (courseId) return classes.find(cls => cls && cls.name === name && String(cls.courseId || '') === courseId) || null;
    const same = classes.filter(cls => cls && cls.name === name);
    return same.length === 1 ? same[0] : null;
}

// Põe e tira a marca naoLetivoId dos registros de presença do login conforme os dias não
// letivos cadastrados agora. ranges (opcional): [{ inicio, fim }], só as datas que mudaram
// (cadastrar, alterar ou excluir um dia); sem ranges, a presença inteira (boot e
// restauração). Registro de turma encerrada não muda. Devolve
// { marcados, desmarcados, trocados } (ids dos registros) e changedIds (todos).
function syncNonSchoolDayMarks(memory, { ranges } = {}) {
    const result = { marcados: [], desmarcados: [], trocados: [], changedIds: [] };
    const records = memory && Array.isArray(memory.attendance) ? memory.attendance : [];
    if (!records.length) return result;
    const days = storedNonSchoolDays(memory);
    const windows = Array.isArray(ranges)
        ? ranges.filter(range => range && isValidDate(range.inicio)).map(range => ({
            inicio: range.inicio,
            fim: isValidDate(range.fim) && range.fim >= range.inicio ? range.fim : range.inicio,
        }))
        : null;
    if (windows && !windows.length) return result;
    const inWindow = date => !windows || windows.some(range => date >= range.inicio && date <= range.fim);
    const cache = new Map();
    records.forEach(record => {
        if (!record || typeof record !== 'object') return;
        const date = text(record.date);
        if (!isValidDate(date) || !inWindow(date)) return;
        const isLogin = record.origin === 'login';
        const had = text(record.naoLetivoId);
        if (!isLogin && !had) return;
        const cls = classForRecord(memory, record);
        if (cls && isClassClosed(cls)) return;
        let want = '';
        if (isLogin && days.length) {
            const key = `${text(record.courseId)}::${text(record.studentClass)}::${date}`;
            if (!cache.has(key)) {
                const target = cls || { courseId: text(record.courseId), studentClass: text(record.studentClass) };
                const day = isNonSchoolDay(memory, target, date);
                cache.set(key, day ? day.id : '');
            }
            want = cache.get(key);
        }
        if (had === want) return;
        if (want) record.naoLetivoId = want;
        else delete record.naoLetivoId;
        const id = record.id;
        if (!had) result.marcados.push(id);
        else if (!want) result.desmarcados.push(id);
        else result.trocados.push(id);
        result.changedIds.push(id);
    });
    return result;
}

module.exports = {
    NON_SCHOOL_DAY_TYPES,
    NON_SCHOOL_DAY_TYPE_LABELS,
    NON_SCHOOL_DAY_SCOPES,
    NON_SCHOOL_DAY_SCOPE_LABELS,
    MAX_NON_SCHOOL_DAY_SPAN,
    isValidDate,
    addDays,
    spanDays,
    normalizeNonSchoolDay,
    nonSchoolDaySummary,
    targetContext,
    dayAppliesTo,
    nonSchoolDaysFor,
    isNonSchoolDay,
    termForClass,
    weeklyLessons,
    dayStatus,
    lessonsForDate,
    plannedLessons,
    easterSunday,
    nationalHolidays,
    syncNonSchoolDayMarks,
    CLASS_CLOSED_CODE,
    CLASS_CLOSED_MESSAGE,
    ClassClosedError,
    classClosedBody,
    isClassClosed,
    assertClassOpen,
    classOfSubmission,
    classesOfSubmissions,
};
