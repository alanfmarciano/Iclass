// Agendamento de prova e de material (fase 3, P3-S12: AVA-20 e UXI-17; D25, D26 e D27 do
// desenho do P3, contrato C10).
//
// Prova (application.agenda = { abreEm, fechaEm (ms), criadoPor, criadoEm, abertaEm?,
// atrasoSegundos?, encerradaEm?, perdida?, perdidaEm?, fechamentoCanceladoEm?,
// fechamentoCanceladoPor? }):
// - uma aplicação PREPARADA com agenda passa sozinha a 'running' (ou a 'waiting', com a
//   sala de espera configurada) em abreEm, e a 'finished' em fechaEm com a política
//   "entregar o que foi salvo" (finishApplication com 'submit', a mesma do Monitor);
// - o fechamento efetivo é fechaEm empurrado pelas pausas da aplicação depois de ela abrir
//   (o tempo fora do ar devolvido às provas vira pausa, H3b; a pausa do professor também
//   congela) e pelo "+N min" da turma (globalTimeAdjustment). O tempo fora do ar acima de
//   15 min, que não vira pausa, não empurra (ninguém ganhou esse tempo de volta);
// - servidor desligado em abreEm (D26): ligou antes de fechaEm, a prova abre na hora do
//   boot (atrasoSegundos e o aviso no "Precisa de você"); ligou depois de fechaEm, a
//   aplicação fica preparada com agenda.perdida = true (aviso e auditoria
//   exam_application_schedule_missed) e nunca abre sozinha. A marca (abertaEm, perdida)
//   impede repetir;
// - aberta pelo professor antes da hora ("Abrir agora"), fecha sozinha em fechaEm do
//   mesmo jeito; o professor tira o fechamento automático com "Não encerrar sozinha"
//   (fechamentoCanceladoEm). A aplicação perdida aberta à mão nunca fecha sozinha.
// Data e hora digitadas no relógio da escola ('AAAA-MM-DDTHH:MM', settings.timezone) por
// schoolTime.deadlineFromLocal (contrato C6 do P3 sobre a fundação C0b). abreEm até 60 dias
// à frente; janela de 5 min a 12 h. Dia não letivo (academicCalendar.isNonSchoolDay) só
// avisa, nunca bloqueia (contrato C5).
//
// Material (cls.releaseSchedule = { [itemKey]: { at, released: true, por, porNome,
// criadoEm, adiadoEm? } }, D27): apostila, unidade e gabarito liberados sozinhos em at.
// Avaliacao_ não entra (a prova só abre por aplicação). O gabarito respeita a trava da
// aplicação preparada ou em andamento da família da prova: com uma aberta, a liberação
// espera (adiadoEm, com aviso no "Precisa de você" e em Materiais) e sai na primeira volta
// depois de ela ser encerrada. Liberar grava releasedItems e releaseMeta como o
// interruptor de Materiais e a auditoria content_release_auto; a entrada sai da agenda.
//
// A varredura (sweepSchedules) roda no timer 'exam-deadline-sweep' de 10 s (server.js), e
// a primeira volta é a do boot. Pura quanto ao relógio: o instante vem de quem chama
// (teste injeta a hora). Só muda a memória e devolve changed; quem chama grava completo
// (o encerramento resolve entregas, coleção que só cresce com linha antiga alterada).
//
// Também aqui: o que o aluno vê da prova agendada (lista "Abre em ...", calendário e sino)
// e as pendências do professor ("Precisa de você"), pelos provedores de studentFeeds.js.
const schoolTime = require('./schoolTime.js');
const academicCalendar = require('./academicCalendar.js');
const studentFeeds = require('./studentFeeds.js');
const { examFamilyKeys } = require('./examFamily.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    applicationParticipant,
    extendDeadlineByPauses,
    listExamApplications,
    transitionExamApplication,
} = require('./examApplications.js');
const { OPEN_APPLICATION_STATUSES, finishApplication, recordExamAudit, syncClassWithApplication } = require('./examFinish.js');
const { recordAudit } = require('./audit.js');
const { studentInClass } = require('./students.js');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MIN_WINDOW_MS = 5 * MINUTE_MS;
const MAX_WINDOW_MS = 12 * HOUR_MS;
const MAX_AHEAD_MS = 60 * DAY_MS;
// Abriu mais de 1 min depois do horário (a volta é de 10 s): o computador estava
// desligado ou suspenso, e o professor é avisado.
const LATE_OPEN_WARN_MS = MINUTE_MS;
const SYSTEM_ACTOR = 'sistema';
const LOCAL_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/;

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function positive(value) {
    const number = finite(value);
    return number !== null && number > 0 ? number : null;
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function lower(value) {
    return String(value || '').trim().toLowerCase();
}

// 'AAAA-MM-DDTHH:MM' no relógio da escola -> ms, ou null.
function parseLocalDateTime(raw, timezone) {
    const match = LOCAL_DATETIME_PATTERN.exec(text(raw));
    if (!match) return null;
    return schoolTime.deadlineFromLocal(match[1], match[2], timezone);
}

// O mesmo instante de volta para o campo do formulário ('AAAA-MM-DDTHH:MM').
function localDateTimeOf(ms, timezone) {
    const parts = schoolTime.localParts(ms, timezone);
    return parts ? `${parts.date}T${parts.time}` : '';
}

const pad2 = value => String(value).padStart(2, '0');

// "20/11 às 08:00" no relógio da escola.
function formatWhen(ms, timezone) {
    const parts = positive(ms) ? schoolTime.localParts(ms, timezone) : null;
    return parts ? `${pad2(parts.day)}/${pad2(parts.month)} às ${parts.time}` : '';
}

// "abre em 20/11 às 08:00 e fecha às 09:30" (fecha em outro dia: "e fecha em 21/11 às 00:30").
function describeWindow(abreEm, fechaEm, timezone) {
    const open = schoolTime.localParts(abreEm, timezone);
    const close = schoolTime.localParts(fechaEm, timezone);
    if (!open || !close) return '';
    const closeText = open.date === close.date ? `às ${close.time}` : `em ${formatWhen(fechaEm, timezone)}`;
    return `abre em ${formatWhen(abreEm, timezone)} e fecha ${closeText}`;
}

function minutesText(ms) {
    const minutes = Math.round(ms / MINUTE_MS);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// Agenda da aplicação lida com padrão (aplicação antiga não tem): null sem abreEm e
// fechaEm válidos.
function applicationAgenda(application) {
    const agenda = application && application.agenda;
    if (!agenda || typeof agenda !== 'object' || Array.isArray(agenda)) return null;
    const abreEm = positive(agenda.abreEm);
    const fechaEm = positive(agenda.fechaEm);
    if (!abreEm || !fechaEm || fechaEm <= abreEm) return null;
    return agenda;
}

// Confere o que o professor digitou: { ok, value: { abreEm, fechaEm } } ou { ok: false,
// error, field }. now: o instante do pedido.
function parseScheduleInput(input, { now = Date.now(), timezone } = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const abreEm = parseLocalDateTime(source.abreEmLocal, timezone);
    if (abreEm === null) return { ok: false, field: 'abreEmLocal', error: 'Informe a data e a hora de abrir a prova (dia e horário válidos).' };
    const fechaEm = parseLocalDateTime(source.fechaEmLocal, timezone);
    if (fechaEm === null) return { ok: false, field: 'fechaEmLocal', error: 'Informe a hora de fechar a prova (horário válido).' };
    if (abreEm <= now) return { ok: false, field: 'abreEmLocal', error: 'O horário de abrir já passou. Escolha um horário mais tarde.' };
    if (abreEm - now > MAX_AHEAD_MS) return { ok: false, field: 'abreEmLocal', error: 'Agende para no máximo 60 dias à frente.' };
    if (fechaEm <= abreEm) return { ok: false, field: 'fechaEmLocal', error: 'O horário de fechar precisa ser depois do de abrir.' };
    if (fechaEm - abreEm < MIN_WINDOW_MS) return { ok: false, field: 'fechaEmLocal', error: 'A prova precisa ficar aberta pelo menos 5 minutos.' };
    if (fechaEm - abreEm > MAX_WINDOW_MS) return { ok: false, field: 'fechaEmLocal', error: 'A prova pode ficar aberta no máximo 12 horas: o servidor roda no computador da sala.' };
    return { ok: true, value: { abreEm, fechaEm } };
}

function createAgenda({ abreEm, fechaEm }, { actor, now = Date.now() } = {}) {
    return { abreEm, fechaEm, criadoPor: actor || null, criadoEm: now };
}

// Dia não letivo do dia de abrir (só aviso): { date, nome, tipo, escopo } ou null.
function nonSchoolDayWarning(memory, cls, at, timezone) {
    if (!cls || !positive(at)) return null;
    const date = schoolTime.schoolDateOf(at, timezone);
    const day = date ? academicCalendar.isNonSchoolDay(memory, cls, date) : null;
    if (!day) return null;
    const label = (academicCalendar.NON_SCHOOL_DAY_TYPE_LABELS || {})[day.tipo] || 'Dia não letivo';
    return { date, nome: day.nome, tipo: day.tipo, escopo: day.escopo, texto: `${date.split('-').reverse().slice(0, 2).join('/')} é dia sem aula (${label}: ${day.nome}). A prova abre do mesmo jeito.` };
}

// Quando a aplicação abriu (para o fechamento automático): a marca do agendamento, o
// início da prova ou o começo da sala de espera.
function applicationOpenedAt(application, agenda) {
    if (positive(agenda && agenda.abertaEm)) return Number(agenda.abertaEm);
    const started = Date.parse(application && application.startedAt);
    if (Number.isFinite(started) && started > 0) return started;
    const startsAt = positive(application && application.startsAt);
    if (startsAt) return startsAt - Math.max(0, finite(application.waitingRoomDuration) || 0) * 1000;
    return null;
}

// O fechamento automático vale para esta aplicação agora?
function closesAutomatically(application, agenda = applicationAgenda(application)) {
    if (!agenda || agenda.perdida === true || positive(agenda.encerradaEm) || positive(agenda.fechamentoCanceladoEm)) return false;
    if (!ACTIVE_APPLICATION_STATUSES.has(application.status)) return false;
    const openedAt = applicationOpenedAt(application, agenda);
    return openedAt === null || openedAt < Number(agenda.fechaEm);
}

// Fechamento efetivo (ver o começo do arquivo), ou null sem fechamento automático.
function effectiveCloseAt(application, now = Date.now()) {
    const agenda = applicationAgenda(application);
    if (!agenda || !closesAutomatically(application, agenda)) return null;
    const extra = Math.max(0, finite(application.globalTimeAdjustment) || 0) * MINUTE_MS;
    const base = Number(agenda.fechaEm) + extra;
    const openedAt = applicationOpenedAt(application, agenda) || Number(agenda.abreEm);
    return extendDeadlineByPauses(application, openedAt, base, now);
}

// Situação da agenda para as telas do painel: 'agendada' | 'perdida' | 'aberta' |
// 'encerrada' | 'fechamento_cancelado' | null, com os horários no relógio da escola.
function scheduleView(application, { now = Date.now(), timezone } = {}) {
    const agenda = applicationAgenda(application);
    if (!agenda) return null;
    const status = application.status;
    let estado = null;
    if (status === 'prepared') estado = agenda.perdida === true ? 'perdida' : 'agendada';
    else if (ACTIVE_APPLICATION_STATUSES.has(status)) {
        if (positive(agenda.fechamentoCanceladoEm)) estado = 'fechamento_cancelado';
        else if (closesAutomatically(application, agenda)) estado = 'aberta';
        else estado = 'sem_fechamento';
    } else if (status === 'finished') estado = positive(agenda.encerradaEm) ? 'encerrada' : 'encerrada_manual';
    else estado = 'cancelada';
    const closeAt = effectiveCloseAt(application, now);
    const view = {
        estado,
        abreEm: Number(agenda.abreEm),
        fechaEm: Number(agenda.fechaEm),
        abreEmLabel: formatWhen(agenda.abreEm, timezone),
        fechaEmLabel: formatWhen(agenda.fechaEm, timezone),
        janela: describeWindow(agenda.abreEm, agenda.fechaEm, timezone),
        abreEmLocal: localDateTimeOf(agenda.abreEm, timezone),
        fechaEmLocal: localDateTimeOf(agenda.fechaEm, timezone),
        fechaEfetivaEm: closeAt,
        fechaEfetivaLabel: closeAt ? formatWhen(closeAt, timezone) : '',
        criadoPor: agenda.criadoPor || null,
    };
    if (positive(agenda.abertaEm)) {
        view.abertaEm = Number(agenda.abertaEm);
        view.abertaEmLabel = formatWhen(agenda.abertaEm, timezone);
        view.atrasoSegundos = Math.max(0, finite(agenda.atrasoSegundos) || 0);
        view.abertaAtrasada = view.atrasoSegundos * 1000 > LATE_OPEN_WARN_MS;
    }
    if (agenda.perdida === true) view.perdidaEm = positive(agenda.perdidaEm);
    return view;
}

function classOf(memory, application) {
    const name = lower(application && application.studentClass);
    const courseId = String((application && application.courseId) || '');
    return ((memory && memory.classes) || []).find(cls => cls
        && lower(cls.name) === name
        && (!courseId || !cls.courseId || String(cls.courseId) === courseId)) || null;
}

// ------------------------------------------------------------ varredura
function openScheduledApplication(memory, application, agenda, cls, now) {
    const target = Math.max(0, finite(application.waitingRoomDuration) || 0) > 0 ? 'waiting' : 'running';
    transitionExamApplication(application, target, {
        actor: SYSTEM_ACTOR,
        now,
        waitingRoomDuration: application.waitingRoomDuration,
    });
    const atrasoSegundos = Math.max(0, Math.round((now - Number(agenda.abreEm)) / 1000));
    agenda.abertaEm = now;
    agenda.atrasoSegundos = atrasoSegundos;
    syncClassWithApplication(cls, application);
    recordExamAudit(memory, 'exam_application_auto_opened', application, SYSTEM_ACTOR, {
        abreEm: Number(agenda.abreEm),
        fechaEm: Number(agenda.fechaEm),
        atrasoSegundos,
        status: application.status,
    });
    return { applicationId: application.id, examKey: application.examKey, studentClass: application.studentClass, atrasoSegundos, status: application.status };
}

function markMissed(memory, application, agenda, now) {
    agenda.perdida = true;
    agenda.perdidaEm = now;
    application.updatedAt = new Date(now).toISOString();
    recordExamAudit(memory, 'exam_application_schedule_missed', application, SYSTEM_ACTOR, {
        abreEm: Number(agenda.abreEm),
        fechaEm: Number(agenda.fechaEm),
    });
    return { applicationId: application.id, examKey: application.examKey, studentClass: application.studentClass };
}

function finishScheduledApplication(memory, application, agenda, cls, now) {
    const processed = finishApplication(memory, {
        application,
        cls,
        policy: 'submit',
        actor: SYSTEM_ACTOR,
        reason: 'agendamento',
        now,
    });
    agenda.encerradaEm = now;
    const entregues = processed ? (Number(processed.submitted) || 0) + (Number(processed.deliveredAtDeadline) || 0) : 0;
    recordExamAudit(memory, 'exam_application_auto_finished', application, SYSTEM_ACTOR, {
        fechaEm: Number(agenda.fechaEm),
        encerradaEm: now,
        entregues,
    });
    return { applicationId: application.id, examKey: application.examKey, studentClass: application.studentClass, entregues };
}

// Aplicação preparada ou em andamento de qualquer prova da família na turma (a mesma
// trava do interruptor do gabarito, routes/adminExamConfig.js).
function openFamilyApplication(memory, cls, examKey) {
    const family = examFamilyKeys(memory, examKey);
    return listExamApplications(memory.examApplications, {
        studentClass: cls.name,
        courseId: cls.courseId,
        statuses: [...OPEN_APPLICATION_STATUSES],
    }).find(application => family.has(String(application.examKey || ''))) || null;
}

function answerKeyFamily(memory, examKey) {
    return [...examFamilyKeys(memory, examKey)].map(key => `Gabarito_${key}`);
}

// Liga o item na turma como o interruptor de Materiais (releasedItems + releaseMeta), com
// a família do gabarito (só as chaves que a turma já tem gravadas). Devolve as chaves.
function releaseClassItem(memory, cls, itemKey, { by, at }) {
    if (!cls.releasedItems || typeof cls.releasedItems !== 'object') cls.releasedItems = {};
    if (!cls.releaseMeta || typeof cls.releaseMeta !== 'object') cls.releaseMeta = {};
    const keys = [itemKey];
    if (itemKey.startsWith('Gabarito_')) {
        answerKeyFamily(memory, itemKey.slice('Gabarito_'.length)).forEach(answerKey => {
            if (answerKey !== itemKey && cls.releasedItems[answerKey] !== undefined) keys.push(answerKey);
        });
    }
    const iso = new Date(at).toISOString();
    keys.forEach(key => {
        cls.releasedItems[key] = true;
        cls.releaseMeta[key] = { by, at: iso, released: true, agendado: true };
    });
    return keys;
}

function releaseEntries(cls) {
    const schedule = cls && cls.releaseSchedule;
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return [];
    return Object.keys(schedule)
        .filter(key => Object.prototype.hasOwnProperty.call(schedule, key))
        .map(key => [key, schedule[key]])
        .filter(([, entry]) => entry && typeof entry === 'object' && positive(entry.at));
}

function sweepReleases(memory, cls, now, result) {
    releaseEntries(cls).forEach(([itemKey, entry]) => {
        if (Number(entry.at) > now) return;
        if (itemKey.startsWith('Gabarito_')) {
            const blocking = openFamilyApplication(memory, cls, itemKey.slice('Gabarito_'.length));
            if (blocking) {
                if (!positive(entry.adiadoEm)) {
                    entry.adiadoEm = now;
                    result.changed = true;
                    result.postponed.push({ studentClass: cls.name, courseId: cls.courseId || null, itemKey, applicationId: blocking.id });
                }
                return;
            }
        }
        const by = `Agendamento${entry.porNome || entry.por ? ` de ${entry.porNome || entry.por}` : ''}`;
        const keys = releaseClassItem(memory, cls, itemKey, { by, at: now });
        delete cls.releaseSchedule[itemKey];
        recordAudit(memory, {
            action: 'content_release_auto',
            actor: SYSTEM_ACTOR,
            courseId: cls.courseId || null,
            studentClass: cls.name,
            field: itemKey,
            oldValue: 'Bloqueado',
            newValue: 'Liberado',
            details: {
                itemKey,
                at: Number(entry.at),
                liberadoEm: now,
                adiado: positive(entry.adiadoEm) ? true : false,
                agendadoPor: entry.por || null,
                ...(keys.length > 1 ? { chaves: keys } : {}),
            },
        }, { timestamp: now });
        result.changed = true;
        result.released.push({ studentClass: cls.name, courseId: cls.courseId || null, itemKey, adiado: positive(entry.adiadoEm) ? true : false });
    });
}

// Uma volta da agenda (ver o começo do arquivo). Devolve { changed, opened, missed,
// finished, released, postponed }.
function sweepSchedules(memory, { now = Date.now() } = {}) {
    const result = { changed: false, opened: [], missed: [], finished: [], released: [], postponed: [] };
    if (!memory) return result;
    const applications = Array.isArray(memory.examApplications) ? memory.examApplications : [];
    // 1) Abrir (ou marcar perdida) as preparadas com agenda vencida, na ordem de abertura.
    applications
        .filter(application => application && application.status === 'prepared')
        .map(application => ({ application, agenda: applicationAgenda(application) }))
        .filter(({ agenda }) => agenda && agenda.perdida !== true && !positive(agenda.abertaEm) && Number(agenda.abreEm) <= now)
        .sort((a, b) => Number(a.agenda.abreEm) - Number(b.agenda.abreEm))
        .forEach(({ application, agenda }) => {
            const cls = classOf(memory, application);
            if (!cls) return;
            try {
                if (now >= Number(agenda.fechaEm)) result.missed.push(markMissed(memory, application, agenda, now));
                else result.opened.push(openScheduledApplication(memory, application, agenda, cls, now));
                result.changed = true;
            } catch (error) {
                result.errors = [...(result.errors || []), { applicationId: application.id, error: error && error.message }];
            }
        });
    // 2) Fechar as abertas que passaram do fechamento efetivo.
    applications
        .filter(application => application && ACTIVE_APPLICATION_STATUSES.has(application.status))
        .forEach(application => {
            const closeAt = effectiveCloseAt(application, now);
            if (closeAt === null || now < closeAt) return;
            const cls = classOf(memory, application);
            if (!cls) return;
            try {
                result.finished.push(finishScheduledApplication(memory, application, applicationAgenda(application), cls, now));
                result.changed = true;
            } catch (error) {
                result.errors = [...(result.errors || []), { applicationId: application.id, error: error && error.message }];
            }
        });
    // 3) Liberações de material (depois do fechamento: o gabarito marcado para a hora de
    // fechar sai na mesma volta).
    ((memory.classes) || []).forEach(cls => { if (cls) sweepReleases(memory, cls, now, result); });
    return result;
}

// ------------------------------------------------------------ material: rota e telas
// Itens que aceitam agenda (D27): apostila, unidade e gabarito; nunca a prova online.
function releaseScheduleAllowed(itemKey) {
    return !!text(itemKey) && !String(itemKey).startsWith('Avaliacao_');
}

// Confere o horário da liberação: { ok, value: at } ou { ok: false, error }.
function parseReleaseAt(raw, { now = Date.now(), timezone } = {}) {
    const at = parseLocalDateTime(raw, timezone);
    if (at === null) return { ok: false, error: 'Informe a data e a hora da liberação (dia e horário válidos).' };
    if (at <= now) return { ok: false, error: 'Esse horário já passou. Escolha um horário mais tarde ou libere agora.' };
    if (at - now > MAX_AHEAD_MS) return { ok: false, error: 'Agende a liberação para no máximo 60 dias à frente.' };
    return { ok: true, value: at };
}

// O que segura o gabarito adiado: 'andamento' (a aplicação está aberta e encerra pelo
// Monitor ou pela agenda), 'preparada' (preparada que ainda não abriu) ou 'perdida' (a
// agenda dela não abriu por causa do computador desligado: nunca encerra sozinha). As
// duas últimas só saem da frente aplicando e encerrando, ou bloqueando a prova em
// Materiais (a preparação é cancelada). null: nada segura mais (sai na próxima volta).
function releaseBlockKind(memory, cls, itemKey) {
    if (!memory || !itemKey.startsWith('Gabarito_')) return null;
    const blocking = openFamilyApplication(memory, cls, itemKey.slice('Gabarito_'.length));
    if (!blocking) return null;
    if (blocking.status !== 'prepared') return 'andamento';
    return applicationAgenda(blocking)?.perdida === true ? 'perdida' : 'preparada';
}

// Agenda de liberação da turma para a tela de Materiais: { [itemKey]: { at, atLabel,
// atLocal, por, adiado, espera? } }. Com memory, o gabarito adiado diz o que o segura
// (releaseBlockKind).
function releaseScheduleView(cls, { timezone, memory } = {}) {
    const view = {};
    releaseEntries(cls).forEach(([itemKey, entry]) => {
        const adiado = positive(entry.adiadoEm) ? true : false;
        const espera = adiado ? releaseBlockKind(memory, cls, itemKey) : null;
        view[itemKey] = {
            at: Number(entry.at),
            atLabel: formatWhen(entry.at, timezone),
            atLocal: localDateTimeOf(entry.at, timezone),
            por: entry.porNome || entry.por || null,
            adiado,
            ...(espera ? { espera } : {}),
        };
    });
    return view;
}

// ------------------------------------------------------------ aluno
function courseOf(memory, cls) {
    const id = String((cls && cls.courseId) || '');
    return ((memory && memory.courses) || []).find(course => course && String(course.id) === id) || null;
}

function examTitleOf(memory, examKey) {
    const evaluation = memory && memory.evaluations && memory.evaluations[examKey];
    const title = evaluation && (evaluation.title || evaluation.name);
    return title ? String(title) : String(examKey || 'Prova').replace(/^Avaliacao_/, '').replace(/_/g, ' ');
}

// Aplicações agendadas (preparadas com agenda, não perdidas) que o aluno vê: só as da
// turma dele e as que ele pode fazer (applicationParticipant). Sem questões nem token.
function studentScheduledApplications(memory, { cls, email, timezone } = {}) {
    if (!cls) return [];
    const student = ((memory && memory.students) || []).find(item => lower(item && item.email) === lower(email)) || null;
    if (student && !studentInClass(student, cls.name, cls.courseId)) return [];
    return listExamApplications(memory && memory.examApplications, { studentClass: cls.name, courseId: cls.courseId, statuses: ['prepared'] })
        .map(application => ({ application, agenda: applicationAgenda(application) }))
        .filter(({ application, agenda }) => agenda && agenda.perdida !== true && !positive(agenda.abertaEm)
            && applicationParticipant(application, email))
        .sort((a, b) => Number(a.agenda.abreEm) - Number(b.agenda.abreEm))
        .map(({ application, agenda }) => ({
            id: application.id,
            examKey: application.examKey,
            studentClass: application.studentClass,
            courseId: application.courseId || null,
            status: 'scheduled',
            examTitle: examTitleOf(memory, application.examKey),
            durationMinutes: application.durationMinutes || null,
            timerEnabled: application.timerEnabled !== false,
            tokenEnabled: application.tokenEnabled === true,
            abreEm: Number(agenda.abreEm),
            fechaEm: Number(agenda.fechaEm),
            abreEmLabel: formatWhen(agenda.abreEm, timezone),
            janela: describeWindow(agenda.abreEm, agenda.fechaEm, timezone),
            criadoEm: positive(agenda.criadoEm) || null,
        }));
}

// Nome do item liberável para o calendário do aluno ("Apostila · Unidade 3").
function releaseItemTitle(memory, cls, itemKey) {
    const course = courseOf(memory, cls);
    const isAnswerKey = itemKey.startsWith('Gabarito_');
    const lookup = isAnswerKey ? itemKey.slice('Gabarito_'.length) : itemKey;
    let unitName = '';
    ((course && course.structure) || []).forEach(mod => ((mod && (mod.units || mod.items)) || []).forEach(unit => {
        if (unitName || !unit) return;
        if (unit.apostilaKey === lookup || unit.avaliacaoKey === lookup || unit.key === lookup) unitName = unit.name || unit.title || '';
    }));
    const kind = isAnswerKey ? 'Gabarito' : 'Apostila';
    return unitName ? `${kind} · ${unitName}` : `${kind} liberado`;
}

function calendarEvents(ctx) {
    const { memory, cls, email } = ctx || {};
    if (!memory || !cls) return [];
    const tz = schoolTime.schoolTimezone();
    const events = studentScheduledApplications(memory, { cls, email, timezone: tz }).map(item => {
        const open = schoolTime.localParts(item.abreEm, tz);
        const close = schoolTime.localParts(item.fechaEm, tz);
        const event = {
            id: `prova-agendada:${item.id}`,
            title: item.examTitle,
            description: `Prova agendada: ${item.janela}.`,
            eventDate: open.date,
            startTime: open.time,
            endTime: close.date === open.date ? close.time : '',
            eventType: 'prova',
            target: 'turma',
            targetValue: cls.name,
            courseId: cls.courseId || null,
            href: '/aluno/provas',
        };
        if (close.date !== open.date) event.endDate = close.date;
        return event;
    });
    releaseEntries(cls).forEach(([itemKey, entry]) => {
        const parts = schoolTime.localParts(entry.at, tz);
        if (!parts) return;
        events.push({
            id: `liberacao:${cls.name}:${itemKey}`,
            title: releaseItemTitle(memory, cls, itemKey),
            description: positive(entry.adiadoEm)
                ? 'Liberação agendada: sai assim que a prova desta unidade for encerrada.'
                : `Liberação agendada para ${formatWhen(entry.at, tz)}.`,
            eventDate: parts.date,
            startTime: parts.time,
            eventType: 'aviso',
            target: 'turma',
            targetValue: cls.name,
            courseId: cls.courseId || null,
        });
    });
    return events;
}

function notificationItems(ctx) {
    const { memory, cls, email } = ctx || {};
    if (!memory || !cls) return [];
    const seenAt = Number(ctx.seenAt) || 0;
    const tz = schoolTime.schoolTimezone();
    return studentScheduledApplications(memory, { cls, email, timezone: tz }).map(item => {
        const at = item.criadoEm || item.abreEm;
        return {
            id: `prova-agendada:${item.id}`,
            type: 'prova',
            title: 'Prova agendada',
            text: `${item.examTitle} · ${item.janela}`,
            at,
            href: '/aluno/provas',
            unread: at > seenAt,
        };
    });
}

// ------------------------------------------------------------ professor
function queueItems(ctx) {
    const { memory, cls } = ctx || {};
    if (!memory || !cls || !cls.name) return [];
    const tz = schoolTime.schoolTimezone();
    const now = Number(ctx.now) || Date.now();
    const own = listExamApplications(memory.examApplications, { studentClass: cls.name, courseId: cls.courseId });
    const items = [];
    const missed = own.filter(application => application.status === 'prepared' && applicationAgenda(application)?.perdida === true);
    if (missed.length) {
        const first = missed[0];
        const agenda = applicationAgenda(first);
        items.push({
            id: 'agendamento_perdido',
            tipo: 'agendamento_perdido',
            titulo: missed.length === 1 ? 'Prova agendada não abriu' : 'Provas agendadas não abriram',
            detalhe: missed.length === 1
                ? `"${examTitleOf(memory, first.examKey)}" (${describeWindow(agenda.abreEm, agenda.fechaEm, tz)}): o computador estava desligado no horário · Monitor`
                : `o computador estava desligado no horário · Monitor`,
            count: missed.length,
            tone: 'danger',
            href: `/monitor?${new URLSearchParams({ courseId: String(cls.courseId || ''), className: cls.name, examKey: first.examKey, applicationId: first.id }).toString()}`,
            permissao: 'page.exams',
            somenteQuemAltera: true,
            at: positive(agenda.perdidaEm) || Number(agenda.fechaEm),
        });
    }
    const late = own.filter(application => ACTIVE_APPLICATION_STATUSES.has(application.status)
        && (Math.max(0, finite(applicationAgenda(application)?.atrasoSegundos) || 0) * 1000) > LATE_OPEN_WARN_MS);
    if (late.length) {
        const first = late[0];
        const agenda = applicationAgenda(first);
        items.push({
            id: 'agendamento_atrasado',
            tipo: 'agendamento_atrasado',
            titulo: 'Prova agendada abriu atrasada',
            detalhe: `"${examTitleOf(memory, first.examKey)}" abriu ${minutesText(Number(agenda.atrasoSegundos) * 1000)} depois de ${formatWhen(agenda.abreEm, tz)}: o computador estava desligado · Monitor`,
            count: late.length,
            tone: 'warning',
            href: `/monitor?${new URLSearchParams({ courseId: String(cls.courseId || ''), className: cls.name, examKey: first.examKey, applicationId: first.id }).toString()}`,
            permissao: ['page.exams', 'page.monitor'],
            at: positive(agenda.abertaEm) || now,
        });
    }
    const postponed = releaseEntries(cls).filter(([, entry]) => positive(entry.adiadoEm));
    if (postponed.length) {
        // A preparada (ou a perdida) não encerra sozinha: o texto diz como destravar.
        const preparedOnly = postponed.every(([itemKey]) => ['preparada', 'perdida'].includes(releaseBlockKind(memory, cls, itemKey)));
        items.push({
            id: 'liberacao_adiada',
            tipo: 'liberacao_adiada',
            titulo: postponed.length === 1 ? 'Gabarito agendado esperando a prova encerrar' : 'Gabaritos agendados esperando a prova encerrar',
            detalhe: preparedOnly
                ? 'a prova tem uma aplicação preparada que não abriu; o gabarito sai quando ela for aplicada e encerrada, ou quando a prova for bloqueada em Materiais · Materiais'
                : 'a aplicação da prova ainda está aberta; o gabarito sai quando ela for encerrada · Materiais',
            count: postponed.length,
            tone: 'info',
            href: '/materiais',
            permissao: 'page.materials',
            at: Math.min(...postponed.map(([, entry]) => Number(entry.adiadoEm))),
        });
    }
    return items;
}

// Registra os três provedores (o mesmo id troca o provedor: chamar de novo não duplica).
function registerScheduleFeeds() {
    studentFeeds.registerStudentCalendarProvider({ id: 'agendamentos', events: calendarEvents });
    studentFeeds.registerStudentNotificationProvider({ id: 'agendamentos', items: notificationItems });
    studentFeeds.registerInstructorQueueProvider({ id: 'agendamentos', items: queueItems });
}
registerScheduleFeeds();

module.exports = {
    LATE_OPEN_WARN_MS,
    MAX_AHEAD_MS,
    MAX_WINDOW_MS,
    MIN_WINDOW_MS,
    applicationAgenda,
    calendarEvents,
    closesAutomatically,
    createAgenda,
    describeWindow,
    effectiveCloseAt,
    formatWhen,
    localDateTimeOf,
    nonSchoolDayWarning,
    notificationItems,
    parseLocalDateTime,
    parseReleaseAt,
    parseScheduleInput,
    queueItems,
    registerScheduleFeeds,
    releaseClassItem,
    releaseScheduleAllowed,
    releaseScheduleView,
    scheduleView,
    studentScheduledApplications,
    sweepSchedules,
};
