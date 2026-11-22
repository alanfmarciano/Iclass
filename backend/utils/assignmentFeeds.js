// ---------------------------------------------------------------------------
// Tarefas no sino e no calendário do aluno (fase 3, C5 / P1-c; FUN-01, D16 do P1).
// Provedores de utils/studentFeeds.js (K13 do plano): o sino e o calendário juntam estes
// itens depois dos de hoje, sem gravar nada (o calendário é calculado, nenhum aviso é
// criado). Leem a tarefa e a entrega só pelas regras de utils/assignments.js (situação,
// prazo efetivo com prorrogação), como a lista /api/student/assignments.
//
// Sino ('tarefa'):
// - 'tarefa:<id>:nova'  Nova tarefa: cada tarefa publicada e já aberta da turma, na hora
//   em que apareceu para o aluno (a publicação ou a abertura, a mais tarde);
// - 'tarefa:<id>:prazo' Prazo termina em breve: tarefa que o aluno ainda precisa enviar
//   ('A fazer' ou 'Refazer') e que aceita envio, com o prazo efetivo dele nas próximas
//   24 h; no sino desde 24 h antes do prazo (ou desde que a tarefa apareceu, se for depois),
//   some quando ele envia, quando o prazo passa ou quando a turma é encerrada.
// - 'tarefa:<id>:devolvida' Tarefa devolvida (C6 / P1-d): a correção chegou ao aluno, na
//   hora da devolução; se o professor muda a nota depois (com motivo), o mesmo item volta
//   como não lido com o título "Nota da tarefa alterada", na hora da mudança ("Comentário
//   da tarefa alterado" quando só o comentário mudou);
// - 'tarefa:<id>:refazer' Refazer a tarefa (C6 / P1-d): o professor pediu para refazer, com
//   o prazo novo, na hora do pedido; some quando o aluno manda a versão nova ou quando a
//   entrega não aceita mais envio.
// Não lido: depois do último "Marcar como lidas" (seenAt), como as notas e as dúvidas.
//
// Fila do instrutor ('Precisa de você' e sino do painel, D16): 'entregas_para_corrigir',
// uma linha por turma com o total de entregas que esperam correção nas tarefas publicadas
// (versão nova sem nota, entrega em mãos sem nota, versão nova depois da correção), só dos
// alunos do escopo de quem vê e só para quem tem 'page.assignments' e pode corrigir (a
// Coordenação, só de consulta, não recebe: somenteQuemAltera).
//
// Calendário ('entrega'): um evento 'tarefa:<id>' por tarefa publicada e aberta da turma,
// na data e na hora do prazo efetivo do aluno (no relógio da escola), com a situação dele.
//
// A pré-visualização (aluno virtual da turma) vê as tarefas como um aluno sem entrega.
// ---------------------------------------------------------------------------
const assignments = require('./assignments.js');
const schoolTime = require('./schoolTime.js');
const settingsUtil = require('./settings.js');
const studentFeeds = require('./studentFeeds.js');

const PROVIDER_ID = 'tarefas';
const DAY_MS = 24 * 60 * 60 * 1000;
const NEEDS_SENDING = new Set(['a_fazer', 'refazer']);

function timezone() {
    return settingsUtil.getSettings().timezone;
}

function detailHref(task) {
    return `/aluno/atividades/${encodeURIComponent(task.id)}`;
}

// Tarefas publicadas e abertas da turma do contexto, cada uma com a entrega do aluno
// (crua ou null) e a situação dele no instante now.
function visibleTasks(ctx, now) {
    const cls = ctx && ctx.cls;
    const courseId = String((cls && cls.courseId) || (ctx && ctx.courseId) || '');
    const studentClass = String((cls && cls.name) || (ctx && ctx.studentClass) || '');
    const tz = timezone();
    // Turma encerrada (quando o B10 ligar): a tarefa continua no sino e no calendário, mas
    // sem pedir envio (situationForClass), como a lista e o detalhe.
    const classOpen = assignments.classAcceptsSubmissions(cls);
    return assignments.assignmentsForClass(ctx.memory, { courseId, studentClass, statuses: ['publicada'] })
        .map(raw => assignments.normalizeAssignment(raw))
        .filter(task => assignments.isVisibleToStudent(task, { now }))
        .map(task => {
            const sub = assignments.findSubmission(ctx.memory, task.id, ctx.email);
            const situation = assignments.situationForClass(assignments.studentSituation(task, sub, { now, timezone: tz }), classOpen);
            return { task, sub, situation };
        });
}

function notificationItems(ctx) {
    const now = Number(ctx && ctx.now) || Date.now();
    const seenAt = Number(ctx && ctx.seenAt) || 0;
    const tz = timezone();
    const items = [];
    visibleTasks(ctx, now).forEach(({ task, sub, situation }) => {
        const shownAt = Math.max(task.publishedAt || 0, task.opensAt || 0) || task.updatedAt || task.createdAt || 0;
        const due = situation.dueAt !== null ? assignments.formatSchoolDateTime(situation.dueAt, tz) : '';
        items.push({
            id: `tarefa:${task.id}:nova`,
            type: 'tarefa',
            title: 'Nova tarefa',
            text: due ? `${task.title} · prazo ${due}` : task.title,
            at: shownAt,
            href: detailHref(task),
            unread: shownAt > seenAt,
        });
        if (NEEDS_SENDING.has(situation.code) && situation.aceitaEnvio && situation.dueAt !== null
            && situation.dueAt > now && situation.dueAt - now <= DAY_MS) {
            // Desde 24 h antes do prazo, mas nunca antes de a tarefa aparecer: publicada já
            // com menos de 24 h, o lembrete nasce com a "Nova tarefa" e não sai como lido
            // por um "Marcar como lidas" anterior à publicação.
            const at = Math.max(situation.dueAt - DAY_MS, shownAt);
            items.push({
                id: `tarefa:${task.id}:prazo`,
                type: 'tarefa',
                title: 'Prazo da tarefa termina em breve',
                text: `${task.title} · até ${due}`,
                at,
                href: detailHref(task),
                unread: at > seenAt,
            });
        }
        // Devolução e pedido para refazer (C6): a entrega do próprio aluno, como a lista.
        if (sub) {
            const entry = assignments.normalizeSubmission(sub);
            if (situation.code === 'devolvida' && entry.returnedAt !== null) {
                const changedAt = entry.grade && entry.grade.gradedAt !== null && entry.grade.gradedAt > entry.returnedAt ? entry.grade.gradedAt : null;
                // Só o comentário mudou (scoreChangedAt de antes da devolução): o título diz isso.
                const scoreAt = entry.grade && entry.grade.scoreChangedAt !== null ? entry.grade.scoreChangedAt : changedAt;
                const at = changedAt || entry.returnedAt;
                let title = 'Tarefa devolvida';
                if (changedAt) title = scoreAt !== null && scoreAt > entry.returnedAt ? 'Nota da tarefa alterada' : 'Comentário da tarefa alterado';
                items.push({
                    id: `tarefa:${task.id}:devolvida`,
                    type: 'tarefa',
                    title,
                    text: task.title,
                    at,
                    href: detailHref(task),
                    unread: at > seenAt,
                });
            }
            if (situation.code === 'refazer' && situation.aceitaEnvio) {
                const at = (entry.extension && entry.extension.at) || (entry.grade && entry.grade.gradedAt) || entry.updatedAt || 0;
                items.push({
                    id: `tarefa:${task.id}:refazer`,
                    type: 'tarefa',
                    title: 'Refazer a tarefa',
                    text: due ? `${task.title} · até ${due}` : task.title,
                    at,
                    href: detailHref(task),
                    unread: at > seenAt,
                });
            }
        }
    });
    return items;
}

function calendarEvents(ctx) {
    const now = Date.now();
    const tz = timezone();
    const events = [];
    visibleTasks(ctx, now).forEach(({ task, situation }) => {
        if (situation.dueAt === null) return;
        const parts = schoolTime.localParts(situation.dueAt, tz);
        if (!parts) return;
        events.push({
            id: `tarefa:${task.id}`,
            title: task.title,
            description: `Prazo de entrega da tarefa às ${parts.time}. Situação: ${situation.label}.`,
            eventDate: parts.date,
            startTime: parts.time,
            eventType: 'entrega',
            target: 'turma',
            targetValue: task.studentClass,
            courseId: task.courseId,
            href: detailHref(task),
        });
    });
    return events;
}

function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}

// Pendência da fila do instrutor (ctx de studentFeeds.registerInstructorQueueProvider):
// só dentro de uma turma (o sino percorre as turmas do escopo; sem turma, a fila do
// Dashboard fica sem o item, como a chamada de hoje).
function queueItems(ctx) {
    const cls = ctx && ctx.cls;
    if (!cls || !cls.name) return [];
    const summary = assignments.gradingQueueSummary(ctx.memory, {
        courseId: String(cls.courseId || ''),
        studentClass: String(cls.name),
        emails: ctx.emails instanceof Set ? ctx.emails : null,
    });
    if (!summary.count) return [];
    const first = summary.tasks[0];
    const detalhe = summary.tasks.length === 1
        ? `em "${first.title}" · Tarefas`
        : `em ${plural(summary.tasks.length, 'tarefa', 'tarefas')}, a maior "${first.title}" (${first.count}) · Tarefas`;
    const item = {
        id: 'entregas_para_corrigir',
        tipo: 'entregas_para_corrigir',
        titulo: summary.count === 1 ? 'Entrega de tarefa para corrigir' : 'Entregas de tarefas para corrigir',
        detalhe,
        count: summary.count,
        tone: 'warning',
        href: '/tarefas?filtro=para-corrigir',
        permissao: 'page.assignments',
        // Corrigir é ação: a Coordenação (page.assignments só para ver) não recebe o item.
        somenteQuemAltera: true,
    };
    if (summary.oldestAt) item.at = summary.oldestAt;
    return [item];
}

// Registra os três provedores (o mesmo id troca o provedor: chamar de novo não duplica).
// Chamado pelos dois routers das tarefas (aluno e painel).
function registerAssignmentFeeds() {
    studentFeeds.registerStudentNotificationProvider({ id: PROVIDER_ID, items: notificationItems });
    studentFeeds.registerStudentCalendarProvider({ id: PROVIDER_ID, events: calendarEvents });
    studentFeeds.registerInstructorQueueProvider({ id: PROVIDER_ID, items: queueItems });
}

module.exports = {
    PROVIDER_ID,
    notificationItems,
    calendarEvents,
    queueItems,
    registerAssignmentFeeds,
};
