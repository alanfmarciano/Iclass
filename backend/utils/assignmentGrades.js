// ---------------------------------------------------------------------------
// Nota da tarefa no quadro de notas e na média (fase 3, C18 / P1-j; FUN-01, D15 do P1,
// K1 do plano e P-ALAN-3: "sim, como item do plano com peso 1; 'Conta na média'
// desmarcável por tarefa").
//
// Uma fonte só (K1): a nota mora em assignmentSubmissions.grade e é lida só por
// assignments.assignmentGradeEntries (contrato C1 do P1). Este módulo registra o provedor
// 'tarefa' do gradebook (registerGradeItemProvider, contrato C2 do P2): o quadro, o
// boletim, a ficha, Alunos, o risco do Dashboard e Minhas notas do aluno juntam as notas
// das tarefas pela mesma conta de sempre (gradebook.js + gradingRules.js). Nenhuma linha
// vai para submissions (que é de prova) e nenhuma tela calcula média.
//
// Itens (um por tarefa da turma, id = id da tarefa 'asg_*'):
// - tarefa publicada; a arquivada que já foi publicada entra como item arquivado (como a
//   avaliação manual arquivada: a nota fica guardada e na célula do quadro, e sai da média
//   com aviso até reativar; o aluno não a vê, como não vê a tarefa). Rascunho não entra;
// - título da tarefa, rótulo 'Tarefa' (a coluna sai 'Tarefa: <título>'), módulo da tarefa
//   (a coluna vem logo depois das provas do módulo) e a data do prazo;
// - "Conta na média": no plano da turma a tarefa é classes[].avaliacao.itens['asg_*'] como
//   qualquer item (etapa, peso 1 e "Não conta"). Enquanto o plano não tem a linha dela, vale
//   o "Conta na média" da tarefa (fora = !countsInAverage). Quando tem (o professor mexeu
//   no plano em Resultados), a linha manda; mudar "Conta na média" no formulário da tarefa
//   muda também a linha (syncPlanLine), e a tela da tarefa mostra o que vale
//   (effectiveCountsInAverage).
//
// Notas (entries): o professor vê também a correção salva e ainda não devolvida (como a
// nota de prova ainda não publicada: célula com o ponto de "não publicada"); o aluno, o
// boletim e Minhas notas só a devolvida (publishedOnly). A nota já vem com o desconto de
// atraso (finalScore).
// ---------------------------------------------------------------------------
const assignments = require('./assignments.js');
const schoolTime = require('./schoolTime.js');
const settingsUtil = require('./settings.js');
const { registerGradeItemProvider } = require('./gradebook.js');

const ORIGEM = 'tarefa';
const TIPO_ROTULO = 'Tarefa';

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function timezone() {
    try { return settingsUtil.getSettings().timezone; } catch (e) { return undefined; }
}

// Tarefas da turma que viram item do quadro (normalizadas), na ordem do prazo.
function gradedTasksOfClass(memory, cls, course = null) {
    if (!cls || !cls.name) return [];
    const courseId = String(cls.courseId || (course && course.id) || '');
    return assignments.assignmentsForClass(memory, { courseId, studentClass: cls.name, statuses: ['publicada', 'arquivada'] })
        .map(assignments.normalizeAssignment)
        .filter(task => task && task.id && (task.status === 'publicada' || task.publishedAt !== null))
        .sort((a, b) => (a.dueAt === null ? Infinity : a.dueAt) - (b.dueAt === null ? Infinity : b.dueAt)
            || String(a.title).localeCompare(String(b.title), 'pt-BR')
            || String(a.id).localeCompare(String(b.id)));
}

function classOfTask(memory, task) {
    return ((memory && memory.classes) || []).find(cls => cls && cls.name === task.studentClass && String(cls.courseId || '') === String(task.courseId || '')) || null;
}

// A linha do plano da turma para a tarefa (crua), ou null quando o plano não a tem.
function planLineFor(memory, task) {
    const cls = task ? classOfTask(memory, task) : null;
    const itens = cls && isPlainObject(cls.avaliacao) && isPlainObject(cls.avaliacao.itens) ? cls.avaliacao.itens : null;
    if (!itens || !Object.prototype.hasOwnProperty.call(itens, task.id)) return null;
    return isPlainObject(itens[task.id]) ? itens[task.id] : {};
}

// O "Conta na média" que vale para a tarefa (a regra fica em assignments.js, que a usa
// também em assignmentGradeEntries).
const { effectiveCountsInAverage } = assignments;

// Mudou o "Conta na média" no formulário da tarefa: a linha do plano da turma, se existir,
// acompanha (fora = !conta). Devolve true quando mudou a turma (quem chama grava 'classes').
function syncPlanLine(memory, task, countsInAverage) {
    const cls = task ? classOfTask(memory, task) : null;
    if (!cls) return false;
    const line = planLineFor(memory, task);
    if (!line) return false;
    const fora = countsInAverage !== true;
    if ((line.fora === true) === fora) return false;
    cls.avaliacao = { ...cls.avaliacao, itens: { ...cls.avaliacao.itens, [task.id]: { ...line, fora } } };
    return true;
}

// Provedor 'tarefa' (contrato C2 do P2).
function gradeItems(course, cls, memory) {
    const tz = timezone();
    return gradedTasksOfClass(memory, cls, course).map(task => ({
        id: task.id,
        titulo: task.title || 'Tarefa',
        tipoRotulo: TIPO_ROTULO,
        moduloId: task.moduleId || null,
        data: task.dueAt !== null ? schoolTime.schoolDateOf(task.dueAt, tz) : null,
        // Padrão do item enquanto o plano não tem a linha dele.
        fora: task.countsInAverage === false,
        arquivado: task.status === 'arquivada',
    }));
}

function gradeEntries(memory, { cls, courseId, studentClass, emails = null, publishedOnly = false } = {}) {
    const course = String(courseId || (cls && cls.courseId) || '');
    const name = String(studentClass || (cls && cls.name) || '');
    if (!course || !name) return [];
    const wanted = Array.isArray(emails) ? emails : null;
    const out = [];
    const seen = new Set();
    const add = (entry, publicada) => {
        const key = `${entry.assignmentId}\u0000${entry.email}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ itemId: entry.assignmentId, email: entry.email, studentId: entry.studentId || null, score: entry.score, publicada });
    };
    // Devolvidas primeiro (publicadas); depois, para o professor, as salvas sem devolver.
    assignments.assignmentGradeEntries(memory, { courseId: course, studentClass: name, students: wanted, published: true, includeArchived: true })
        .forEach(entry => add(entry, true));
    if (!publishedOnly) {
        assignments.assignmentGradeEntries(memory, { courseId: course, studentClass: name, students: wanted, published: false, includeArchived: true })
            .forEach(entry => add(entry, false));
    }
    return out;
}

let unregister = null;

// Registra (ou registra de novo) o provedor 'tarefa' do gradebook. Idempotente.
function registerAssignmentGradeProvider() {
    unregister = registerGradeItemProvider({ origem: ORIGEM, items: gradeItems, entries: gradeEntries });
    return unregister;
}

registerAssignmentGradeProvider();

module.exports = {
    ORIGEM,
    TIPO_ROTULO,
    gradeItems,
    gradeEntries,
    effectiveCountsInAverage,
    planLineFor,
    syncPlanLine,
    registerAssignmentGradeProvider,
};
