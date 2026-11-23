// Histórico de matrícula (fase 3, B10 / P2-S9, FUN-05; D19 do P2).
//
// A matrícula continua sendo students[].classes (lida em dezenas de lugares por
// studentBelongsToClass); este módulo só acrescenta as datas:
// - students[].classes[].desde: 'AAAA-MM-DD' (fuso da escola) em que o aluno entrou na
//   turma. Entrada antiga sem o campo é "desde sempre" e nada é reescrito no boot;
// - students[].historicoMatriculas[]: as matrículas que terminaram, { schemaVersion: 1,
//   courseId, name, period?, periodoLetivoId?, desde?, ate, motivo, paraTurma? }. Só o que
//   não identifica a pessoa (curso, turma e datas): fica na anonimização e sai com o
//   cadastro no "apagar de vez". Quem fez a mudança fica na auditoria (enrollment_*,
//   update, bulk_*), que continua sendo o registro completo.
//
// Motivos: 'removido' (tirado da turma), 'mudou_de_turma' (saiu de uma turma e entrou em
// outra do mesmo curso na mesma alteração; paraTurma diz qual), 'turma_encerrada' (tirado
// de uma turma já encerrada: a matrícula acabou com o encerramento) e, pelo desligamento
// (situação que encerra o vínculo, students.CLOSED_STUDENT_STATUSES), 'concluido',
// 'transferido', 'evadido' e 'desligado' (Inativo). O desligamento não tira o aluno da
// turma (a chamada de datas antigas e as notas continuam com ele, H7b): a matrícula entra
// no histórico com a data e a turma continua na lista; reativar começa uma matrícula nova
// (desde = hoje) nas turmas que ele tem.
//
// Uma função só para todos os caminhos que mudam turmas (applyClassMembershipChange):
// ficha do aluno (student/update), cadastro (student/create), matrícula em lote
// (student/bulk-enroll) e aprovação de matrícula; e applyEnrollmentStatusChange para o
// desligamento e a reativação (student/update e student/bulk-status).
//
// Ciclo de vida do dado (studentDataHandlers, contrato do plano): o histórico mora no
// cadastro, então a troca de e-mail não tem o que fazer; anonimizar devolve o histórico ao
// cadastro anonimizado (o bloco de hoje guarda só turmas e datas, KEPT_STUDENT_FIELDS);
// apagar de vez leva o cadastro inteiro; mesclar junta o histórico do 'sai' no do 'fica';
// contar e Meus dados ('Histórico de matrículas', versões aluno e administrador).
const { registerStudentDataHandler } = require('./studentDataHandlers.js');
const { classEntryName, classEntryCourseId, isClosedStudentStatus, isAnonymizedStudent } = require('./students.js');

const HISTORY_FIELD = 'historicoMatriculas';
const MOTIVOS = Object.freeze(['removido', 'mudou_de_turma', 'turma_encerrada', 'concluido', 'transferido', 'evadido', 'desligado']);
const MOTIVO_ROTULOS = Object.freeze({
    removido: 'Saiu da turma',
    mudou_de_turma: 'Mudou de turma',
    turma_encerrada: 'Turma encerrada',
    concluido: 'Concluiu o curso',
    transferido: 'Transferido',
    evadido: 'Evadido',
    desligado: 'Desligado',
});
// Situação do desligamento -> motivo (comparada sem acento e sem diferenciar maiúscula).
const STATUS_MOTIVOS = Object.freeze({ concluido: 'concluido', transferido: 'transferido', evadido: 'evadido', inativo: 'desligado' });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_MAX = 500;

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function foldStatus(value) {
    return text(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function validDate(value) {
    return DATE_RE.test(text(value)) ? text(value) : null;
}

// Entrada de turma do cadastro como { name, courseId, desde } (string antiga: sem curso
// e sem data).
function entryView(entry, fallbackCourseId = '') {
    return {
        name: classEntryName(entry),
        courseId: classEntryCourseId(entry) || text(fallbackCourseId),
        desde: entry && typeof entry === 'object' ? validDate(entry.desde) : null,
        period: entry && typeof entry === 'object' && entry.period !== undefined ? text(entry.period) : null,
    };
}

function rawEntries(student) {
    if (!student) return [];
    if (Array.isArray(student.classes) && student.classes.length) return student.classes;
    return student.studentClass ? [student.studentClass] : [];
}

// A entrada `a` (de antes) é a mesma matrícula que `b` (de depois)? Mesmo nome; o curso
// só desempata quando os dois têm curso (entrada antiga em texto vale para qualquer curso).
function sameEntry(a, b) {
    if (!a.name || a.name !== b.name) return false;
    return !a.courseId || !b.courseId || a.courseId === b.courseId;
}

function findClass(memory, entry) {
    const classes = (memory && Array.isArray(memory.classes)) ? memory.classes : [];
    return classes.find(cls => cls && cls.name === entry.name && (!entry.courseId || String(cls.courseId || '') === entry.courseId))
        || null;
}

// Histórico gravado, lido com tolerância: só as entradas com turma e data de fim.
function readHistory(student) {
    const list = student && Array.isArray(student[HISTORY_FIELD]) ? student[HISTORY_FIELD] : [];
    return list.filter(item => item && typeof item === 'object' && text(item.name) && validDate(item.ate));
}

function historyEntry(memory, entry, { ate, motivo, paraTurma = null }) {
    const cls = findClass(memory, entry);
    const out = {
        schemaVersion: 1,
        courseId: entry.courseId || (cls ? text(cls.courseId) : ''),
        name: entry.name,
        ate,
        motivo: MOTIVOS.includes(motivo) ? motivo : 'removido',
    };
    const period = entry.period !== null && entry.period !== undefined ? entry.period : (cls ? text(cls.period) : '');
    if (period) out.period = period;
    if (cls && text(cls.periodoLetivoId)) out.periodoLetivoId = text(cls.periodoLetivoId);
    if (entry.desde) out.desde = entry.desde;
    if (paraTurma) out.paraTurma = paraTurma;
    return out;
}

function withHistory(history, added) {
    const list = [...history, ...added];
    return list.length > HISTORY_MAX ? list.slice(list.length - HISTORY_MAX) : list;
}

// Turmas do cadastro depois de uma mudança (nextEntries: a lista já normalizada para
// gravar, strings ou { name, courseId, period }), com as datas: a matrícula que continua
// guarda o 'desde' que tinha; a nova ganha desde = hoje; a que saiu vai para o histórico
// com ate = hoje e o motivo ('removido', 'mudou_de_turma' quando outra turma do mesmo curso
// entrou na mesma alteração, 'turma_encerrada' quando a turma já estava encerrada).
// isClosed(cls): a turma está encerrada (academicCalendar.isClassClosed; recebido para este
// módulo não depender do calendário).
// Devolve { classes, historicoMatriculas, added: [{ name, courseId }], removed: [...] };
// historicoMatriculas é undefined quando o cadastro não tinha e nada saiu (o registro não
// ganha campo vazio).
function applyClassMembershipChange(memory, student, nextEntries, { today, isClosed = () => false } = {}) {
    const date = validDate(today);
    const fallback = student ? text(student.courseId) : '';
    const before = rawEntries(student).map(entry => entryView(entry, fallback)).filter(entry => entry.name);
    const used = new Set();
    const added = [];
    const classes = (Array.isArray(nextEntries) ? nextEntries : []).map(entry => {
        const view = entryView(entry);
        if (!view.name) return entry;
        const index = before.findIndex((old, position) => !used.has(position) && sameEntry(old, view));
        if (index >= 0) {
            used.add(index);
            const desde = before[index].desde;
            if (!desde) return entry;
            return typeof entry === 'object' && entry ? { ...entry, desde } : { name: view.name, courseId: before[index].courseId || '', desde };
        }
        added.push({ name: view.name, courseId: view.courseId });
        if (!date) return entry;
        return typeof entry === 'object' && entry ? { ...entry, desde: date } : { name: view.name, courseId: '', desde: date };
    });
    const removedEntries = before.filter((entry, position) => !used.has(position));
    const removed = removedEntries.map(entry => ({ name: entry.name, courseId: entry.courseId }));
    const history = readHistory(student);
    if (!removedEntries.length || !date) {
        return { classes, historicoMatriculas: student && Array.isArray(student[HISTORY_FIELD]) ? student[HISTORY_FIELD] : undefined, added, removed };
    }
    const fresh = removedEntries.map(entry => {
        const cls = findClass(memory, entry);
        if (cls && isClosed(cls)) return historyEntry(memory, entry, { ate: date, motivo: 'turma_encerrada' });
        const courseId = entry.courseId || (cls ? text(cls.courseId) : '');
        const destino = added.find(item => item.name !== entry.name && (!courseId || !item.courseId || item.courseId === courseId));
        if (destino && courseId) return historyEntry(memory, entry, { ate: date, motivo: 'mudou_de_turma', paraTurma: destino.name });
        return historyEntry(memory, entry, { ate: date, motivo: 'removido' });
    });
    return { classes, historicoMatriculas: withHistory(student && Array.isArray(student[HISTORY_FIELD]) ? student[HISTORY_FIELD] : history, fresh), added, removed };
}

// Desligamento e reativação (mudança de situação, students.applyStudentStatus): da
// situação aberta para uma que encerra o vínculo, cada turma do cadastro entra no
// histórico (o aluno continua na lista de turmas, como sempre); de volta para uma situação
// aberta, as turmas começam matrícula nova (desde = hoje). Anonimizar não passa por aqui.
// Devolve o cadastro novo (cópia) ou o mesmo objeto quando não há o que mudar.
function applyEnrollmentStatusChange(memory, before, after, { today } = {}) {
    const date = validDate(today);
    if (!date || !before || !after || before === after) return after;
    if (isAnonymizedStudent(after)) return after;
    const wasClosed = isClosedStudentStatus(before.status || 'Ativo');
    const isClosedNow = isClosedStudentStatus(after.status || 'Ativo');
    if (wasClosed === isClosedNow) return after;
    const entries = rawEntries(after);
    if (!entries.length) return after;
    if (isClosedNow) {
        const motivo = STATUS_MOTIVOS[foldStatus(after.status)] || 'desligado';
        const fallback = text(after.courseId);
        const fresh = entries.map(entry => entryView(entry, fallback)).filter(entry => entry.name)
            .map(entry => historyEntry(memory, entry, { ate: date, motivo }));
        if (!fresh.length) return after;
        return { ...after, [HISTORY_FIELD]: withHistory(Array.isArray(after[HISTORY_FIELD]) ? after[HISTORY_FIELD] : [], fresh) };
    }
    // Reativado: matrícula nova nas mesmas turmas.
    const classes = entries.map(entry => {
        if (entry && typeof entry === 'object') return { ...entry, desde: date };
        const name = classEntryName(entry);
        return name ? { name, courseId: '', desde: date } : entry;
    });
    return { ...after, classes };
}

// --- leitura: Meus dados e a ficha ------------------------------------------------------

function courseName(memory, courseId) {
    const course = ((memory && memory.courses) || []).find(item => item && String(item.id) === String(courseId));
    return course ? text(course.name) || text(course.id) : text(courseId);
}

function termName(memory, id) {
    if (!id) return null;
    const term = ((memory && memory.academicTerms) || []).find(item => item && String(item.id) === String(id));
    return term ? text(term.nome) || null : null;
}

// Linhas do histórico para a tela e o arquivo: as matrículas atuais (com 'desde') e as
// que terminaram, da mais nova para a mais antiga.
function enrollmentHistoryView(memory, student) {
    if (!student) return { atuais: [], encerradas: [] };
    const fallback = text(student.courseId);
    const atuais = rawEntries(student).map(entry => entryView(entry, fallback)).filter(entry => entry.name).map(entry => ({
        curso: courseName(memory, entry.courseId),
        courseId: entry.courseId,
        turma: entry.name,
        desde: entry.desde,
    }));
    const encerradas = readHistory(student).map(item => ({
        curso: courseName(memory, item.courseId),
        courseId: text(item.courseId),
        turma: text(item.name),
        periodoLetivo: termName(memory, text(item.periodoLetivoId)),
        desde: validDate(item.desde),
        ate: validDate(item.ate),
        motivo: MOTIVOS.includes(item.motivo) ? item.motivo : 'removido',
        motivoRotulo: MOTIVO_ROTULOS[item.motivo] || MOTIVO_ROTULOS.removido,
        paraTurma: text(item.paraTurma) || null,
    })).reverse();
    return { atuais, encerradas };
}

// Histórico como o cadastro anonimizado guarda: só os campos do formato.
function storedHistory(list) {
    return (Array.isArray(list) ? list : []).filter(item => item && typeof item === 'object' && text(item.name) && validDate(item.ate)).map(item => {
        const out = { schemaVersion: 1, courseId: text(item.courseId), name: text(item.name), ate: validDate(item.ate), motivo: MOTIVOS.includes(item.motivo) ? item.motivo : 'removido' };
        if (text(item.period)) out.period = text(item.period);
        if (text(item.periodoLetivoId)) out.periodoLetivoId = text(item.periodoLetivoId);
        if (validDate(item.desde)) out.desde = validDate(item.desde);
        if (text(item.paraTurma)) out.paraTurma = text(item.paraTurma);
        return out;
    });
}

function findStudentRecord(memory, aluno) {
    const students = (memory && Array.isArray(memory.students)) ? memory.students : [];
    if (aluno && aluno.id) {
        const byId = students.find(item => item && item.id === aluno.id);
        if (byId) return byId;
    }
    return null;
}

registerStudentDataHandler({
    collection: HISTORY_FIELD,
    label: 'Histórico de matrículas',
    // O histórico fica no cadastro anonimizado (curso, turma e datas não identificam a
    // pessoa): o bloco de hoje refaz o cadastro só com as turmas, e aqui o histórico volta.
    anonymize(memory, aluno, pseudonimo) {
        const history = storedHistory(aluno && aluno.student && aluno.student[HISTORY_FIELD]);
        if (!history.length) return undefined;
        const students = (memory && Array.isArray(memory.students)) ? memory.students : [];
        const record = findStudentRecord(memory, aluno)
            || students.find(item => item && pseudonimo && item.email === pseudonimo.email)
            || null;
        if (record) record[HISTORY_FIELD] = history;
        return undefined;
    },
    // Mesclar (P4-S4): as matrículas encerradas do 'sai' entram no histórico do 'fica'.
    merge(memory, fica, sai) {
        const target = findStudentRecord(memory, fica);
        const extra = storedHistory(sai && sai.student && sai.student[HISTORY_FIELD]);
        if (!target || !extra.length) return;
        target[HISTORY_FIELD] = withHistory(storedHistory(target[HISTORY_FIELD]), extra);
    },
    count(memory, aluno) {
        return readHistory(aluno && aluno.student).length;
    },
    exportKey: 'enrollmentHistory',
    exportSection(memory, aluno) {
        const history = readHistory(aluno && aluno.student);
        if (!history.length) return undefined;
        return enrollmentHistoryView(memory, aluno.student).encerradas.map(item => ({
            curso: item.curso,
            turma: item.turma,
            periodoLetivo: item.periodoLetivo,
            desde: item.desde,
            ate: item.ate,
            motivo: item.motivoRotulo,
            paraTurma: item.paraTurma,
        }));
    },
    printColumns: [
        { field: 'curso', label: 'Curso' },
        { field: 'turma', label: 'Turma' },
        { field: 'desde', label: 'Desde', format: 'date' },
        { field: 'ate', label: 'Até', format: 'date' },
        { field: 'motivo', label: 'Motivo' },
    ],
});

module.exports = {
    HISTORY_FIELD,
    MOTIVOS,
    MOTIVO_ROTULOS,
    applyClassMembershipChange,
    applyEnrollmentStatusChange,
    enrollmentHistoryView,
    storedHistory,
};
