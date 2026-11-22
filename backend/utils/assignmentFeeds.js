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
//   24 h; no sino desde 24 h antes do prazo, some quando ele envia ou quando o prazo passa.
// Os itens de devolução e de "refazer" entram no C6 (P1-d), neste mesmo provedor.
// Não lido: depois do último "Marcar como lidas" (seenAt), como as notas e as dúvidas.
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
    return assignments.assignmentsForClass(ctx.memory, { courseId, studentClass, statuses: ['publicada'] })
        .map(raw => assignments.normalizeAssignment(raw))
        .filter(task => assignments.isVisibleToStudent(task, { now }))
        .map(task => {
            const sub = assignments.findSubmission(ctx.memory, task.id, ctx.email);
            return { task, sub, situation: assignments.studentSituation(task, sub, { now, timezone: tz }) };
        });
}

function notificationItems(ctx) {
    const now = Number(ctx && ctx.now) || Date.now();
    const seenAt = Number(ctx && ctx.seenAt) || 0;
    const tz = timezone();
    const items = [];
    visibleTasks(ctx, now).forEach(({ task, situation }) => {
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
            const at = situation.dueAt - DAY_MS;
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

// Registra os dois provedores (o mesmo id troca o provedor: chamar de novo não duplica).
function registerAssignmentFeeds() {
    studentFeeds.registerStudentNotificationProvider({ id: PROVIDER_ID, items: notificationItems });
    studentFeeds.registerStudentCalendarProvider({ id: PROVIDER_ID, events: calendarEvents });
}

module.exports = {
    PROVIDER_ID,
    notificationItems,
    calendarEvents,
    registerAssignmentFeeds,
};
