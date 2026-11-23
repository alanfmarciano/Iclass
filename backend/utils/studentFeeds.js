// Provedores do sino do aluno, do calendário do aluno e da fila "Precisa de você" do
// painel (fundação C0b da fase 3; K13 do plano).
//
// Quatro grupos da fase 3 acrescentariam blocos nos mesmos três pontos (student.js no
// sino e no calendário, dashboardAggregates.computeQueue na fila). Em vez disso, cada
// grupo registra um provedor no próprio módulo, e os três pontos juntam os provedores
// DEPOIS do que já montam. Sem provedor registrado a saída é a de antes (teste de
// igualdade em test/backend/igualdade-c0b.test.js; o resto dos provedores em
// test/backend/student-feeds.test.js).
//
// - registerStudentNotificationProvider({ id, items(ctx) }): itens do sino do aluno.
//   ctx = { memory, student, email, cls, courseId, studentClass, seenAt, today, now }.
//   Cada item: { id, type, title, text?, at (ms), href?, unread }. Ids com prefixo do
//   provedor ('tarefa:<id>', 'mensagem:<conversationId>'), sem repetir os de hoje
//   (aviso:, duvida:, nota:, prova:). O sino ordena tudo pelo at e mostra os 30 mais
//   novos, como antes.
// - registerStudentCalendarProvider({ id, events(ctx) }): eventos do calendário do aluno.
//   ctx = { memory, student, email, cls, courseId, studentClass }. Cada evento:
//   { id, title, eventDate 'AAAA-MM-DD', description?, startTime?, endTime?, eventType?,
//   href?, endDate? (a última data de um evento de vários dias) }. Os eventos entram na mesma ordem por data e hora.
// - registerInstructorQueueProvider({ id, items(ctx) }): pendências da fila e do sino do
//   instrutor. ctx = { memory, cls, course, students, emails (Set dos e-mails do escopo),
//   today, now, canSeeMatriculas, viewer (a conta de quem vê, ou null) }; os alunos já
//   vêm no escopo de quem vê. Cada item:
//   { id, tipo, titulo, detalhe?, count, tone, href, permissao (texto ou lista: qualquer
//   uma basta), at?, adiavel?, somenteQuemAltera? (true: pede uma ação que a conta só de
//   consulta, a Coordenação, não pode fazer; a fila e o sino não o mostram a ela) }; a rota
//   da fila aplica o adiamento de 24 h, e a fila e o sino mostram cada item só a quem
//   tem a permissão dele (permissao).
//
// Um provedor que falha não derruba o sino, o calendário nem a fila: o erro vai para o
// crash.log e os itens dele ficam de fora daquela vez. Item sem id ou sem título é
// descartado. Registrar de novo com o mesmo id troca o provedor (sem duplicar itens).
// O registro devolve a função que o retira (testes).
const { logError } = require('./errorLog.js');

const registries = {
    notifications: new Map(),
    calendar: new Map(),
    queue: new Map(),
};

function register(kind, provider, method) {
    if (!provider || typeof provider !== 'object') throw new TypeError(`studentFeeds: provedor de ${kind} inválido.`);
    const id = String(provider.id || '').trim();
    if (!id) throw new TypeError(`studentFeeds: provedor de ${kind} sem id.`);
    if (typeof provider[method] !== 'function') throw new TypeError(`studentFeeds: provedor '${id}' sem ${method}(ctx).`);
    const registry = registries[kind];
    const entry = { id, run: ctx => provider[method](ctx) };
    registry.set(id, entry);
    return () => { if (registry.get(id) === entry) registry.delete(id); };
}

function registerStudentNotificationProvider(provider) {
    return register('notifications', provider, 'items');
}

function registerStudentCalendarProvider(provider) {
    return register('calendar', provider, 'events');
}

function registerInstructorQueueProvider(provider) {
    return register('queue', provider, 'items');
}

function hasProviders(kind) {
    return registries[kind].size > 0;
}

function providerIds(kind) {
    return [...registries[kind].keys()];
}

// Resultado de todos os provedores de um tipo, na ordem de registro. Falha de um
// provedor não para os outros.
function collect(kind, ctx, normalize) {
    const out = [];
    registries[kind].forEach(entry => {
        let produced;
        try {
            produced = entry.run(ctx);
        } catch (error) {
            logError(`provedor '${entry.id}' (${kind})`, error);
            return;
        }
        (Array.isArray(produced) ? produced : []).forEach(item => {
            const normalized = normalize(item, entry.id);
            if (normalized) out.push(normalized);
        });
    });
    return out;
}

const text = (value, max) => String(value === undefined || value === null ? '' : value).slice(0, max);
const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const timeOf = value => {
    const number = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(number) ? number : 0;
};

function normalizeNotification(item) {
    if (!isPlain(item)) return null;
    const id = text(item.id, 200).trim();
    const title = text(item.title, 200).trim();
    if (!id || !title) return null;
    const out = {
        id,
        type: text(item.type || 'outro', 40),
        title,
        text: text(item.text, 140),
        at: timeOf(item.at),
        href: text(item.href, 500),
        unread: item.unread === true,
    };
    return out;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

function normalizeCalendarEvent(item, providerId) {
    if (!isPlain(item)) return null;
    const id = text(item.id, 200).trim();
    const title = text(item.title, 200).trim();
    const eventDate = text(item.eventDate, 10);
    if (!id || !title || !DATE_PATTERN.test(eventDate)) return null;
    const out = {
        id,
        title,
        description: text(item.description, 2000),
        eventDate,
        startTime: TIME_PATTERN.test(String(item.startTime || '')) ? item.startTime : '',
        endTime: TIME_PATTERN.test(String(item.endTime || '')) ? item.endTime : '',
        eventType: text(item.eventType || 'outro', 40),
        target: text(item.target, 40),
        targetValue: text(item.targetValue, 200),
        courseId: item.courseId === undefined ? null : item.courseId,
        authorName: text(item.authorName, 200),
        source: providerId,
    };
    if (item.href) out.href = text(item.href, 500);
    // Evento de mais de um dia (recesso, B3): a última data, quando vem depois da primeira.
    const endDate = text(item.endDate, 10);
    if (DATE_PATTERN.test(endDate) && endDate > eventDate) out.endDate = endDate;
    return out;
}

const QUEUE_TONES = new Set(['danger', 'warning', 'info', 'early', 'neutral', 'success']);

// Permissão do item da fila: um valor ou uma lista (qualquer uma basta, como em
// ADMIN_API_PERMISSION_RULES; nomes_e_formatos.permissoes_compostas do plano). A lista
// continua lista: virar texto ('page.results,page.monitor') escondia o item de todos.
function queuePermission(value) {
    if (Array.isArray(value)) {
        const list = [...new Set(value.map(entry => text(entry, 80).trim()).filter(Boolean))].slice(0, 10);
        return list.length ? list : 'page.dashboard';
    }
    return text(value, 80).trim() || 'page.dashboard';
}

function normalizeQueueItem(item) {
    if (!isPlain(item)) return null;
    const id = text(item.id, 200).trim();
    const titulo = text(item.titulo, 200).trim();
    if (!id || !titulo) return null;
    const count = Number(item.count);
    const out = {
        id,
        tipo: text(item.tipo || id, 60),
        titulo,
        detalhe: text(item.detalhe, 300),
        count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
        tone: QUEUE_TONES.has(item.tone) ? item.tone : 'info',
        href: text(item.href, 500),
        permissao: queuePermission(item.permissao),
    };
    const at = Number(item.at);
    if (Number.isFinite(at) && at > 0) out.at = at;
    if (item.adiavel === false) out.adiavel = false;
    if (item.somenteQuemAltera === true) out.somenteQuemAltera = true;
    return out;
}

function collectStudentNotifications(ctx) {
    return collect('notifications', ctx, normalizeNotification);
}

function collectStudentCalendarEvents(ctx) {
    return collect('calendar', ctx, normalizeCalendarEvent);
}

function collectInstructorQueue(ctx) {
    return collect('queue', ctx, normalizeQueueItem);
}

// Ordem do calendário do aluno (a mesma de student.js): data e hora de início.
function compareCalendarEvents(a, b) {
    return String(a.eventDate).localeCompare(String(b.eventDate)) || String(a.startTime || '').localeCompare(String(b.startTime || ''));
}

module.exports = {
    registerStudentNotificationProvider,
    registerStudentCalendarProvider,
    registerInstructorQueueProvider,
    collectStudentNotifications,
    collectStudentCalendarEvents,
    collectInstructorQueue,
    compareCalendarEvents,
    hasProviders,
    providerIds,
};
