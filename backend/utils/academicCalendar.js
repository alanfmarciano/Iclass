// Calendário acadêmico (fundação C0b da fase 3; X4 do plano).
//
// Por enquanto só existe assertClassOpen, e SEM EFEITO: toda turma está aberta. Ela
// nasce antes do resto para as rotas que gravam nota ou presença já a chamarem (teste de
// guarda test/backend/class-open-guard.test.js) e as rotas novas da fase 3 nascerem
// chamando. O B3 (P2-S5) acrescenta aqui lessonsForDate, isNonSchoolDay, termForClass e
// plannedLessons; o B10 (P2-S9) liga o efeito: turma com encerramento responde 409
// { code: 'class_closed' } nas rotas do teste de guarda, inclusive as da tarefa.
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

module.exports = {
    CLASS_CLOSED_CODE,
    CLASS_CLOSED_MESSAGE,
    ClassClosedError,
    classClosedBody,
    isClassClosed,
    assertClassOpen,
    classOfSubmission,
    classesOfSubmissions,
};
