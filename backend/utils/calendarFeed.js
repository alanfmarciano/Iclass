// Eventos dos calendários (fase 3, B3 / P2-S5, FUN-15): o que o calendário do aluno, o
// do painel e a agenda .ics mostram, montado num lugar só.
//
// - studentCalendarEvents(memory, ctx): os eventos do calendário do aluno, os mesmos de
//   GET /api/student/calendar-events (antes montados ali) e de GET
//   /api/student/calendar.ics: eventos do curso e da turma (announcements com kind
//   'calendar') e, depois, os dos provedores da fase 3 (utils/studentFeeds.js), na mesma
//   ordem por data e hora. ctx = { student, email, cls, courseId, studentClass }.
// - Provedor 'dias-nao-letivos' do calendário do aluno (registrado ao carregar este
//   arquivo): os dias não letivos que valem para a turma (academicCalendar.
//   nonSchoolDaysFor), um evento por dia cadastrado, com eventType 'nao_letivo' e endDate
//   quando o dia cobre mais de uma data (recesso).
// - nonSchoolDayCalendarItems(memory, { courseId, studentClass }): os mesmos dias para o
//   calendário do painel (GET /api/admin/announcements/calendar), como itens
//   { kind: 'nonSchoolDay', readOnly: true, ... } ao lado dos eventos: quem altera um dia
//   não letivo é a rota dele (/api/admin/calendar/non-school-days/*), nunca a do evento.
// - upcomingNonSchoolDayEvents(memory, cls, today): os que ainda não acabaram, para o
//   Início do aluno (B7 / P2-S6).
const academicCalendar = require('./academicCalendar.js');
const studentFeeds = require('./studentFeeds.js');
const { groupLabel, groupTargetReaches } = require('./classGroups.js');

function groupNameOf(memory, groupId) {
    const label = groupLabel(memory, groupId);
    return label ? label.nome : '';
}

const NON_SCHOOL_EVENT_TYPE = 'nao_letivo';

function formatDateBR(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    return match ? `${match[3]}/${match[2]}` : String(date || '');
}

// "Feriado: não há aula." / "Recesso: não há aula de 13/07 a 24/07."
function nonSchoolDayDescription(day) {
    const label = academicCalendar.NON_SCHOOL_DAY_TYPE_LABELS[day.tipo] || academicCalendar.NON_SCHOOL_DAY_TYPE_LABELS.outro;
    const range = day.fim && day.fim !== day.inicio ? ` de ${formatDateBR(day.inicio)} a ${formatDateBR(day.fim)}` : '';
    return `${label}: não há aula${range}.`;
}

function nonSchoolDayEvent(day) {
    const event = {
        id: `nao-letivo:${day.id}`,
        title: day.nome,
        description: nonSchoolDayDescription(day),
        eventDate: day.inicio,
        eventType: NON_SCHOOL_EVENT_TYPE,
    };
    if (day.fim && day.fim !== day.inicio) event.endDate = day.fim;
    return event;
}

studentFeeds.registerStudentCalendarProvider({
    id: 'dias-nao-letivos',
    events: ({ memory, cls, courseId, studentClass }) => academicCalendar
        .nonSchoolDaysFor(memory, cls || { courseId, studentClass })
        .map(nonSchoolDayEvent),
});

// Eventos do calendário do aluno (ver o começo do arquivo). Quem chama já conferiu que o
// aluno é da turma.
function studentCalendarEvents(memory, { student, email, cls, courseId, studentClass }) {
    const requestedCourse = String(courseId || '').trim();
    const requestedClass = String(studentClass || '').trim();
    let list = ((memory && memory.announcements) || [])
        .filter(item => {
            if (item.kind !== 'calendar') return false;
            if (requestedCourse && item.courseId !== requestedCourse) return false;
            if (item.target === 'curso') return String(item.targetValue || '') === requestedCourse;
            if (item.target === 'turma') return String(item.targetValue || '') === requestedClass && (!item.courseId || String(item.courseId) === requestedCourse);
            // Evento para um grupo da turma (P5-S5): só os membros atuais de um grupo ativo.
            if (item.target === 'grupo') return groupTargetReaches(memory, item, { courseId: requestedCourse, studentClass: requestedClass, email });
            return false;
        })
        .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)) || String(a.startTime || '').localeCompare(String(b.startTime || '')))
        .map(item => ({
            id: item.id,
            title: item.title,
            description: item.message || '',
            eventDate: item.eventDate,
            startTime: item.startTime || '',
            endTime: item.endTime || '',
            eventType: item.eventType || 'outro',
            target: item.target,
            targetValue: item.targetValue,
            courseId: item.courseId,
            authorName: item.authorName || '',
            // Evento de um grupo (P5-S5): o nome do grupo, para o selo no calendário.
            ...(item.target === 'grupo' ? { grupo: groupNameOf(memory, item.targetValue) } : {}),
        }));
    // Eventos dos provedores da fase 3 (tarefas, dias não letivos, provas agendadas),
    // juntados depois dos de hoje e na mesma ordem (utils/studentFeeds.js).
    if (studentFeeds.hasProviders('calendar')) {
        const extra = studentFeeds.collectStudentCalendarEvents({
            memory, student, email, cls, courseId: requestedCourse, studentClass: requestedClass,
        });
        if (extra.length) list = [...list, ...extra].sort(studentFeeds.compareCalendarEvents);
    }
    return list;
}

// Dias não letivos do contexto para o calendário do painel (ver o começo do arquivo).
function nonSchoolDayCalendarItems(memory, { courseId, studentClass } = {}) {
    const target = { courseId: String(courseId || '').trim(), studentClass: String(studentClass || '').trim() };
    return academicCalendar.nonSchoolDaysFor(memory, target).map(day => ({
        kind: 'nonSchoolDay',
        id: day.id,
        title: day.nome,
        message: nonSchoolDayDescription(day),
        eventDate: day.inicio,
        endDate: day.fim,
        startTime: '',
        endTime: '',
        eventType: NON_SCHOOL_EVENT_TYPE,
        tipo: day.tipo,
        escopo: day.escopo,
        courseId: day.courseId || target.courseId,
        readOnly: true,
    }));
}

// Os dias não letivos da turma que ainda não acabaram (fim em hoje ou depois), para os
// "Próximos compromissos" do Início do aluno (GET /api/student/dashboard; B7 / P2-S6):
// { id: 'nao-letivo:<id>', title, eventDate, endDate?, startTime: '', eventType:
// 'nao_letivo', hoje: true quando o dia cobre hoje }.
function upcomingNonSchoolDayEvents(memory, cls, today) {
    if (!cls) return [];
    return academicCalendar.nonSchoolDaysFor(memory, cls, { from: today }).map(day => {
        const event = nonSchoolDayEvent(day);
        const out = { id: event.id, title: event.title, eventDate: event.eventDate, startTime: '', eventType: event.eventType };
        if (event.endDate) out.endDate = event.endDate;
        if (today && day.inicio <= today && day.fim >= today) out.hoje = true;
        return out;
    });
}

module.exports = {
    NON_SCHOOL_EVENT_TYPE,
    upcomingNonSchoolDayEvents,
    nonSchoolDayDescription,
    nonSchoolDayEvent,
    studentCalendarEvents,
    nonSchoolDayCalendarItems,
};
