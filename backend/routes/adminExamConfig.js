const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtimePaths.js');
const { parseEvaluationMarkdown } = require('../utils/parser.js');
const db = require('../database.js');
const { ensureExamToken, hashExamToken, normalizeExamToken, sealExamToken, unsealExamToken, withoutSealedToken } = require('../utils/examToken.js');
const { normalizeMaxAttempts, parseMaxAttempts } = require('../utils/examAttempts.js');
const { keystrokeModeOf, normalizeKeystrokeMode, parseKeystrokeModeOption, withKeystrokeMode } = require('../utils/keystrokePolicy.js');
const { SESSION_POLICIES, normalizeSessionPolicy, withSessionTrail } = require('../utils/examSessionIntegrity.js');
const {
    attemptQuestion,
    questionNumber,
    regradeSubmission,
    snapshotForAttempt,
} = require('../utils/examGrading.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    CLOSED_ATTEMPT_STATUSES,
    applicationToOnlineConfig,
    applicationParticipant,
    createExamApplication,
    effectiveMaxAttempts,
    findExamApplication,
    findOpenAttemptState,
    listExamApplications,
    transitionExamApplication,
} = require('../utils/examApplications.js');
const {
    INSTRUCTOR_COLLECT_SOURCE,
    attemptOverdueMs,
    deliveredWithoutAttemptsLeft,
    dropReopenSnapshots,
    finalizeAttemptState,
    reopenDeadlineDeliveries,
    reopenDeliveryByInstructor,
    settleExpiredAttempts,
} = require('../utils/examDeadline.js');
const { examFamilyKeys } = require('../utils/examFamily.js');
const { questionType } = require('../utils/examScoring.js');
const { assertClassOpen } = require('../utils/academicCalendar.js');
const { normalizeAnswerKey, normalizeQuestion, questionInputSchema } = require('../utils/questionModel.js');
const {
    CORRECTABLE_STATUSES,
    annulmentOf,
    answerKeyOf,
    applyAnswerKey,
    applyAnswerKeyToPreparation,
    describeAnswerKey,
    preparationHasAnswerKey,
    previewAnswerKeyRegrade,
    questionPositionInSubmission,
    questionWasReplaced,
    sameAnswerKey,
} = require('../utils/examAnswerKeyCorrection.js');
const { markGradeChangeNotice } = require('../utils/gradeChangeNotices.js');
const { compareText } = require('../utils/textSearch.js');
const { bankItemQuestion } = require('../utils/questionBank.js');
const { body, bool, either, int, list, num, oneOf, query, shape, str } = require('../utils/inputSchema.js');
const {
    AUDIENCE_INPUT_FIELDS,
    MAX_EXTRA_ATTEMPTS,
    activeStudent,
    applicationFinalidade,
    applicationParticipantList,
    changedOverrides,
    describeAudienceAudit,
    emailField,
    formatSchoolDateTime,
    parseApplicationAudience,
    participantCandidates,
} = require('../utils/examParticipants.js');
const { isInheritedKey } = require('../utils/ownEntry.js');
// Versões montadas e conferidas no servidor e sorteio por aluno (P3-S11: AVA-16; D23 e
// D24 do desenho do P3).
const examVersions = require('../utils/examVersions.js');
const examDraw = require('../utils/examDraw.js');
// Agendamento de prova e de material (P3-S12: AVA-20, UXI-17; D25 a D27). A varredura que
// abre, fecha e libera roda no timer do servidor (server.js); aqui ficam as rotas.
const examSchedule = require('../utils/examSchedule.js');
const { recordAudit } = require('../utils/audit.js');
const { displayName, normalizeEmail, studentInClass } = require('../utils/students.js');
const { answerIdSecret } = require('../utils/examAnswerIds.js');
const {
    OPEN_APPLICATION_STATUSES,
    activeApplicationConflict,
    activeExamApplication,
    applicationStateEntries: sharedApplicationStateEntries,
    classExamApplications,
    finishSummary: sharedFinishSummary,
    planControlAction,
    recordExamAudit: sharedRecordExamAudit,
    resolveInProgressAttempts,
} = require('../utils/examFinish.js');
const { buildApplicationAuditTrail, createResolvedGroupKey, describeSubmissionGrade, examTitle, formatGradeBR, recordGradeAudit } = require('../utils/gradebook.js');
const { INTEGRITY_DECISIONS, calculateAttemptResult, integrityDecision } = require('../utils/submissionAttempts.js');
const {
    validateAdmin,
    adminCanAccessClass,
    findClassByNameAndCourse,
    getReleasedItemsForClass,
    isCourseItemKey,
    isCourseExamKey,
    sendRouteError,
} = require('../middlewares.js');
const { accountScopeKind } = require('../utils/adminRoles.js');
const {
    canReadExamVersions,
    canReadQuestionAnswerKey,
    onlineExamConfigWithoutAnswerKeys,
    questionWithoutAnswerKey,
} = require('../utils/examAnswerKeyView.js');

const VERSION_LABELS = examVersions.ONLINE_VERSION_LABELS;
const DEFAULT_ONLINE_DURATION_MINUTES = 60;
const DEFAULT_WAITING_ROOM_MINUTES = 10;
const DEFAULT_MAX_ATTEMPTS = 1;

function getHistoryVersionSnapshots(historyEntry) {
    const snapshots = Array.isArray(historyEntry.versionSnapshots) && historyEntry.versionSnapshots.length > 0
        ? historyEntry.versionSnapshots
        : historyEntry.printSnapshot;
    return Array.isArray(snapshots)
        ? snapshots.slice(0, VERSION_LABELS.length).map((snapshot, index) => ({ version: VERSION_LABELS[index], ...snapshot }))
        : [];
}

function findOnlineHistoryEntry(cls, examKey, historyId) {
    const history = cls.examHistory && Array.isArray(cls.examHistory[examKey]) ? cls.examHistory[examKey] : [];
    const isReusableEntry = entry => getHistoryVersionSnapshots(entry).length > 0;
    if (historyId) return history.find(entry => entry.id === historyId && isReusableEntry(entry)) || null;
    return [...history].reverse().find(isReusableEntry) || null;
}

function buildPreparedOnlineExamConfig(historyEntry, previousConfig = {}, applicationOptions = {}) {
    const availableSnapshots = getHistoryVersionSnapshots(historyEntry);
    const requestedVersions = parseInt(applicationOptions.onlineVersions, 10);
    const versionCount = Number.isFinite(requestedVersions)
        ? Math.max(1, Math.min(requestedVersions, availableSnapshots.length))
        : availableSnapshots.length;
    const versionSnapshots = availableSnapshots.slice(0, versionCount);
    const fallbackQuestionCount = Array.isArray(historyEntry.questionNumbers)
        ? historyEntry.questionNumbers.length
        : (versionSnapshots[0] && Array.isArray(versionSnapshots[0].questions) ? versionSnapshots[0].questions.length : 20);
    const updatedAt = new Date().toISOString();
    const now = Date.now();
    const parsedWaitingRoom = parseInt(applicationOptions.waitingRoomMinutes ?? historyEntry.waitingRoomMinutes, 10);
    const waitingRoomMinutes = Number.isFinite(parsedWaitingRoom) ? Math.max(0, parsedWaitingRoom) : DEFAULT_WAITING_ROOM_MINUTES;
    const waitingRoomDuration = waitingRoomMinutes * 60;
    const hasWaitingRoom = waitingRoomDuration > 0;
    const hasTokenChoice = Object.prototype.hasOwnProperty.call(applicationOptions, 'tokenEnabled');
    // A configuração salva guarda só se pede token (tokenEnabled, P3-S8); a antiga, que
    // ainda tenha o token em texto puro (antes da migração '2026-11-p3-token-historico'),
    // vale como "pede token".
    const tokenEnabled = hasTokenChoice
        ? applicationOptions.tokenEnabled === true
        : (historyEntry.tokenEnabled === true || !!normalizeExamToken(historyEntry.accessToken));
    const hasMaxAttemptsChoice = Object.prototype.hasOwnProperty.call(applicationOptions, 'maxAttempts');
    const historyHasMaxAttempts = Object.prototype.hasOwnProperty.call(historyEntry, 'maxAttempts');
    const maxAttempts = normalizeMaxAttempts(hasMaxAttemptsChoice
        ? applicationOptions.maxAttempts
        : (historyHasMaxAttempts ? historyEntry.maxAttempts : DEFAULT_MAX_ATTEMPTS));
    return {
        questionCount: parseInt(historyEntry.questionCount, 10) || fallbackQuestionCount,
        excludedQuestions: Array.isArray(historyEntry.excludedQuestions) ? historyEntry.excludedQuestions.map(Number) : [],
        shuffleQuestions: historyEntry.shuffleQuestions !== false,
        shuffleAnswers: historyEntry.shuffleAnswers !== false,
        durationMinutes: parseInt(applicationOptions.durationMinutes ?? historyEntry.durationMinutes, 10) || DEFAULT_ONLINE_DURATION_MINUTES,
        timerEnabled: typeof applicationOptions.timerEnabled === 'boolean' ? applicationOptions.timerEnabled : historyEntry.timerEnabled !== false,
        waitingRoomDuration,
        onlineActive: true,
        status: hasWaitingRoom ? 'waiting' : 'running',
        startTime: hasWaitingRoom ? now + waitingRoomDuration * 1000 : now,
        waitingRoomStartTimestamp: hasWaitingRoom ? now : null,
        globalTimeAdjustment: 0,
        activeHistoryId: historyEntry.id,
        accessToken: tokenEnabled ? ensureExamToken(applicationOptions.accessToken || historyEntry.accessToken) : null,
        maxAttempts,
        // Registro do teclado (H8b): a rota confere a escolha antes (parseKeystrokeModeOption).
        keystrokeMode: normalizeKeystrokeMode(parseKeystrokeModeOption(applicationOptions).value),
        // Outro aparelho no meio da prova (P3-S13, D28): 'travar' (padrão) ou 'avisar'.
        sessionPolicy: normalizeSessionPolicy(applicationOptions.sessionPolicy),
        versionSnapshots,
        preparedAt: updatedAt,
        updatedAt,
    };
}

// A avaliação da prova (sem herdar de Object.prototype): a gravada ou, na prova antiga só
// em .md (content/<prova>.md, sem entrada em evaluations), a lida do arquivo, como na
// entrega do aluno (student.js). Só lê; null quando não há nenhuma.
function evaluationFor(examKey) {
    const evaluations = db.memory.evaluations || {};
    if (Object.prototype.hasOwnProperty.call(evaluations, examKey)) return evaluations[examKey];
    if (!/^[A-Za-z0-9_-]+$/.test(String(examKey || ''))) return null;
    try {
        const parsed = parseEvaluationMarkdown(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, `${examKey}.md`), 'utf8'), examKey);
        return parsed && Array.isArray(parsed.questions) && parsed.questions.length ? parsed : null;
    } catch (_) {
        return null;
    }
}

async function persistClasses(classes) {
    db.memory.classes = classes;
    await db.save();
}

// Ações do professor numa aplicação em andamento (Monitor: iniciar, pausar, retomar, +N
// min, token novo): gravação parcial (rota quente, H1-c, DES-01). Entregas e logs só
// ganham linhas novas aqui; quando a ação mexe numa entrega que já existia (encerrar com
// as respostas em andamento, devolver a entrega do fim do tempo no "+N min", entregar
// tentativa vencida), a rota usa a gravação completa.
const APPLICATION_ACTION_COLLECTIONS = Object.freeze([
    'examApplications',
    'classes',
    'studentExamState',
    'submissions',
    'auditLogs',
    'proctoringLogs',
    'broadcastMessages',
]);

function saveApplicationAction({ full = false } = {}) {
    return full ? db.save() : db.save({ only: [...APPLICATION_ACTION_COLLECTIONS] });
}

function adminActor(req) {
    return (req.adminAccount && (req.adminAccount.email || req.adminAccount.name)) || 'Administrador';
}

// Uma aplicação preparada que ainda não começou (nenhum aluno entrou) é substituída
// pela nova preparação: fica cancelada e registrada na auditoria. Aplicação em
// andamento nunca chega aqui: as rotas recusam antes (AVA-04).
function replacePreparedApplications({ studentClass, courseId, examKey, actor }) {
    const replaced = [];
    listExamApplications(db.memory.examApplications, { studentClass, courseId, examKey, statuses: ['draft', 'prepared'] })
        .forEach(application => {
            try {
                transitionExamApplication(application, 'cancelled', { actor });
                recordExamAudit('exam_application_replaced', application, actor, { reason: 'nova_preparacao' });
                replaced.push(application.id);
            } catch (_) {}
        });
    return replaced;
}

// Chaves de liberação do gabarito da família da prova: a prova do curso e as variantes
// "só desta turma" (editar com escopo turma copia o Gabarito_X para Gabarito_X').
function answerKeyFamily(examKey) {
    return [...examFamilyKeys(db.memory, examKey)].map(key => `Gabarito_${key}`);
}

// Nova rodada da prova na turma: o gabarito liberado na rodada anterior volta a ficar
// bloqueado (turma e liberações individuais) até o professor liberar de novo. Vale
// para a família inteira: aplicar a variante editada também trava o Gabarito_X.
function lockAnswerKeyForNewApplication(cls, examKey, actor) {
    const changedKeys = new Set();
    answerKeyFamily(examKey).forEach(answerKey => {
        if (cls.releasedItems && cls.releasedItems[answerKey] === true) {
            cls.releasedItems[answerKey] = false;
            changedKeys.add(answerKey);
        }
        Object.values(cls.studentReleasedItems || {}).forEach(items => {
            if (items && items[answerKey] === true) {
                items[answerKey] = false;
                changedKeys.add(answerKey);
            }
        });
    });
    if (changedKeys.size) {
        if (!cls.releaseMeta) cls.releaseMeta = {};
        const at = new Date().toISOString();
        changedKeys.forEach(answerKey => {
            cls.releaseMeta[answerKey] = { by: actor, at, released: false, reason: 'nova_aplicacao' };
        });
    }
    return changedKeys.size > 0;
}

// Aplicação preparada ou em andamento de qualquer prova da família na turma.
function openExamFamilyApplication(cls, examKey) {
    const family = examFamilyKeys(db.memory, examKey);
    return classExamApplications(db.memory, {
        studentClass: cls.name,
        courseId: cls.courseId,
        statuses: OPEN_APPLICATION_STATUSES,
    }).find(application => family.has(String(application.examKey || ''))) || null;
}

function prepareApplicationFromHistory(cls, examKey, historyEntry, applicationOptions, req, audience = null, draw = null) {
    const options = applicationOptions || {};
    const preparedConfig = buildPreparedOnlineExamConfig(historyEntry, cls.onlineExamConfigs?.[examKey] || {}, options);
    // Para quem (P3-S7): já conferido pela rota (parseApplicationAudience).
    if (audience) Object.assign(preparedConfig, audience);
    // Sorteio por aluno (P3-S11, D24): já conferido pela rota (examDraw.parseDrawInput). Cada
    // aluno recebe draw.total questões (o Monitor conta "respondidas de N" por ele).
    if (draw) {
        preparedConfig.sorteio = draw;
        preparedConfig.questionCount = draw.total;
    }
    const rawToken = preparedConfig.accessToken;
    preparedConfig.accessTokenHash = hashExamToken(rawToken);
    preparedConfig.tokenEnabled = !!preparedConfig.accessTokenHash;
    preparedConfig.accessToken = null;
    preparedConfig.status = 'prepared';
    preparedConfig.onlineActive = false;
    preparedConfig.startTime = null;
    preparedConfig.waitingRoomStartTimestamp = null;
    preparedConfig.timerMode = options.timerMode === 'per_attempt' ? 'per_attempt' : 'collective';

    const actor = adminActor(req);
    const replacedApplicationIds = replacePreparedApplications({ studentClass: cls.name, courseId: cls.courseId, examKey, actor });
    const answerKeyLocked = lockAnswerKeyForNewApplication(cls, examKey, actor);
    const application = createExamApplication({
        examKey,
        courseId: cls.courseId,
        studentClass: cls.name,
        historyId: historyEntry.id,
        config: preparedConfig,
        actor,
        status: 'prepared',
    });
    // Token reexibível (P3-S8, D19): o selo fica só na aplicação (nunca na turma).
    sealApplicationToken(application, rawToken);
    db.memory.examApplications.push(application);
    recordAudienceAudit(application, actor, { participantsChanged: true, before: { finalidade: 'regular', participants: null, studentOverrides: {} }, onlyWhenRestricted: true });
    cls.onlineExamConfigs[examKey] = applicationToOnlineConfig(application, cls.onlineExamConfigs?.[examKey] || {});
    cls.releasedItems[examKey] = false;
    if (cls.activeExamKey === examKey) cls.activeExamKey = null;
    if (cls.activeApplicationId === application.id) cls.activeApplicationId = null;
    return { application, accessToken: rawToken || null, replacedApplicationIds, answerKeyLocked };
}

// Tentativas ainda sem entrega (inclui as vencidas: elas nunca ficam de fora).
function applicationStateEntries(applicationId) {
    return sharedApplicationStateEntries(db.memory, applicationId);
}

function finishSummary(application) {
    return sharedFinishSummary(db.memory, application);
}

function recordExamAudit(type, application, actor, details = {}, extra = {}) {
    sharedRecordExamAudit(db.memory, type, application, actor, details, extra);
}

// Auditoria do "Para quem" (P3-S7): exam_application_participants_set com a finalidade e a
// quantidade de alunos (sem a lista de e-mails) e uma exam_attempt_extra_granted por aluno
// cuja exceção mudou, com o e-mail dele no registro (a anonimização acha a linha). Na
// preparação (onlyWhenRestricted) só grava quando a aplicação não é a de sempre.
function recordAudienceAudit(application, actor, { participantsChanged = false, before = {}, onlyWhenRestricted = false } = {}) {
    const finalidade = applicationFinalidade(application);
    const list = applicationParticipantList(application);
    const restricted = finalidade !== 'regular' || list !== null;
    if (participantsChanged && (!onlyWhenRestricted || restricted)) {
        const previousList = Array.isArray(before.participants) ? before.participants : null;
        recordExamAudit('exam_application_participants_set', application, actor, {
            finalidade,
            finalidadeAntes: before.finalidade || 'regular',
            quantidade: list === null ? null : list.length,
            quantidadeAntes: previousList === null ? null : previousList.length,
            status: application.status,
        });
    }
    changedOverrides(before.studentOverrides || {}, application.studentOverrides || {}).forEach(change => {
        recordExamAudit('exam_attempt_extra_granted', application, actor, {
            extraAttempts: change.depois ? change.depois.extraAttempts : 0,
            prazoAte: change.depois ? change.depois.prazoAte : null,
            motivo: change.depois ? change.depois.motivo : '',
            antes: change.antes,
        }, { studentEmail: change.email });
    });
}

// Tipo e tamanho do "Para quem" dentro das opções da preparação e no corpo da rota de
// participantes (utils/inputSchema.js); as regras vêm em parseApplicationAudience.
// Data e hora no relógio da escola ('AAAA-MM-DDTHH:MM'); a conta de fuso é a do
// schoolTime.deadlineFromLocal (examSchedule.parseScheduleInput).
const SCHEDULE_INPUT_FIELDS = Object.freeze({
    abreEmLocal: str({ max: 20, nullable: true, label: 'abre em' }),
    fechaEmLocal: str({ max: 20, nullable: true, label: 'fecha em' }),
});
// Agendar, mudar ou cancelar (P3-S12): { abreEmLocal, fechaEmLocal } ou { cancelar: true }.
const SCHEDULE_SCHEMA = body({
    ...SCHEDULE_INPUT_FIELDS,
    cancelar: bool({ nullable: true, label: 'cancelar o agendamento' }),
});
// Liberação agendada de material (P3-S12, D27): releaseAtLocal agenda em vez de liberar
// agora; cancelSchedule tira a agenda do item.
const RELEASE_ITEM_SCHEMA = body({
    releaseAtLocal: str({ max: 20, nullable: true, label: 'liberar em' }),
    cancelSchedule: bool({ nullable: true, label: 'cancelar a liberação agendada' }),
});

const PREPARE_AUDIENCE_SCHEMA = body({
    applicationOptions: shape({
        ...AUDIENCE_INPUT_FIELDS,
        // "Outro aparelho no meio da prova" (P3-S13, D28): travar até o professor liberar
        // (padrão) ou só avisar no Monitor.
        sessionPolicy: oneOf(SESSION_POLICIES, { nullable: true, label: 'outro aparelho no meio da prova' }),
        // "Quando" (P3-S12, D25): sem agenda (ausente ou null) a aplicação fica preparada
        // esperando o "Iniciar" do Monitor, como sempre.
        agenda: shape(SCHEDULE_INPUT_FIELDS, { nullable: true, label: 'agendamento' }),
        // "Como montar" (P3-S11, D24): versões (padrão) ou sorteio por aluno. O tipo e o
        // tamanho de cada campo aqui; os grupos contra a montagem em examDraw.parseDrawInput.
        sorteio: shape({
            modo: oneOf(examDraw.DRAW_MODES, { nullable: true, label: 'como montar' }),
            grupos: list(shape({
                filtro: shape({
                    origem: str({ max: 20, nullable: true, label: 'origem' }),
                    categoria: str({ max: 80, nullable: true, label: 'categoria' }),
                    dificuldade: str({ max: 20, nullable: true, label: 'dificuldade' }),
                    tag: str({ max: 40, nullable: true, label: 'etiqueta' }),
                }, { nullable: true, label: 'filtro do grupo' }),
                quantidade: int({ coerce: true, label: 'quantidade do grupo' }),
            }, { label: 'grupo do sorteio' }), { max: examDraw.MAX_DRAW_GROUPS, nullable: true, label: 'grupos do sorteio' }),
        }, { nullable: true, label: 'como montar' }),
    }, { nullable: true, label: 'opções da aplicação' }),
});
const PARTICIPANTS_SCHEMA = body(AUDIENCE_INPUT_FIELDS);

// Montagem online no servidor (P3-S11, D23): quantas versões montar. O tipo aqui (inteiro,
// também em texto); de 1 a 4 em examVersions.buildOnlineVersions, com a mesma frase.
const EXAM_HISTORY_ADD_SCHEMA = body({
    versionCount: int({ coerce: true, nullable: true, label: 'versões online', typeMessage: examVersions.ONLINE_VERSION_COUNT_ERROR }),
    onlineVersions: int({ coerce: true, nullable: true, label: 'versões online', typeMessage: examVersions.ONLINE_VERSION_COUNT_ERROR }),
});

// Questões que o sorteio pode usar (P3-S11, D24): numbers é a lista da montagem, '1,2,3'.
const DRAW_POOL_QUERY = query({
    studentClass: str({ max: 200, label: 'turma' }),
    courseId: str({ max: 200, label: 'curso' }),
    examKey: str({ max: 200, label: 'avaliação' }),
    historyId: str({ max: 200, label: 'configuração salva' }),
    numbers: str({ max: 4000, pattern: /^\d{1,6}(?:\s*,\s*\d{1,6})*$/, label: 'questões' }),
});

// Ações por aluno no Monitor (fase 3, P3-S8: AVA-14; D18 do desenho do P3), numa rota só:
// recolher a prova em andamento, reabrir a entrega, dar uma tentativa extra, anular a
// tentativa por integridade (cola) e desfazer a anulação. Anular e desfazer chegaram no
// P3-S4a (A9), junto com a regra do calculador da nota (X10 do plano: a entrega anulada
// nunca conta com a nota original). O guarda do painel pede page.monitor e, para anular e
// desfazer, também page.results (adminPermissions.js).
const ATTEMPT_ACTIONS = Object.freeze(['recolher', 'reabrir', 'tentativa_extra', 'anular', 'desfazer_anulacao']);
const ATTEMPT_ACTION_REASON_MAX = 500;
const ATTEMPT_ACTION_REASON_MIN = 3;
const ATTEMPT_ACTION_SCHEMA = body({
    action: str({ max: 40, required: true, label: 'ação' }),
    // O emailField do "Para quem" (sem espaço, vírgula, ponto e vírgula nem <>): e-mail
    // fora disso é 400 de validação, antes de procurar o aluno.
    studentEmail: emailField('aluno', { required: true }),
    motivo: str({ max: ATTEMPT_ACTION_REASON_MAX, nullable: true, label: 'motivo' }),
    extraAttempts: int({ min: 1, max: MAX_EXTRA_ATTEMPTS, coerce: true, nullable: true, label: 'tentativas extras' }),
    // Anular (P-B1): 'zero' (padrão: a tentativa vale 0) ou 'desconsiderar' (não conta,
    // como se o aluno não tivesse feito). submissionId escolhe a entrega; sem ele, vale a
    // tentativa em andamento (recolhida antes) ou a entrega mais recente do aluno.
    decisao: oneOf(INTEGRITY_DECISIONS, { nullable: true, label: 'decisão' }),
    submissionId: str({ max: 200, nullable: true, label: 'entrega' }),
});

const INTEGRITY_DECISION_LABELS = Object.freeze({ zero: 'nota zero', desconsiderar: 'não conta (como se não tivesse feito)' });

// Entregas do aluno nesta aplicação, da mais recente para a mais antiga.
function applicationSubmissionsOf(application, email) {
    return (db.memory.submissions || [])
        .filter(item => item && String(item.applicationId || '') === String(application.id)
            && normalizeEmail(item.student?.email || item.studentEmail) === email)
        .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
}

// Nota consolidada do grupo da entrega (aluno + curso + turma + aplicação), a mesma de
// Resultados (submissionAttempts.calculateAttemptResult).
function consolidatedResultFor(submission) {
    const groups = createResolvedGroupKey({ students: db.memory.students || [], classes: db.memory.classes || [] });
    const key = groups.key(submission);
    const group = (db.memory.submissions || []).filter(item => item && groups.key(item) === key).map(groups.resolved);
    return calculateAttemptResult(group);
}

function consolidatedLabel(result) {
    if (!result) return 'sem nota';
    if (result.score === null) return result.aguardandoCorrecao ? 'aguardando correção' : 'sem nota';
    return `${formatGradeBR(result.score)}${result.aguardandoCorrecao ? ' (outra tentativa aguardando correção)' : ''}`;
}

// Anular a tentativa por integridade e desfazer a anulação (attempt-action, P3-S4a; D18 e
// P-B1 do P3). submission.integrity = { decisao, motivo, por, em } (em em ms); desfazer
// grava desfeitaEm, desfeitaPor e motivoDesfeita e a entrega volta a contar como era.
// A nota gravada (score) nunca muda: quem aplica a decisão é calculateAttemptResult
// ('zero' entra com 0, 'desconsiderar' fica fora). Anular a prova que o aluno está fazendo
// recolhe a tentativa antes (com as respostas salvas, como o "Recolher prova").
// Auditoria grade_invalidated / grade_invalidation_undone (nota consolidada antes e
// depois, motivo) e attempt_invalidated no registro do monitoramento, na mesma gravação.
async function invalidationAction({ req, res, action, application, cls, email, student, motivo, actor, now, matchedAdmin, applicationForAccount }) {
    // Aplicação cancelada: o Monitor não oferece anular (canInvalidate) e o servidor recusa
    // igual. Desfazer uma anulação de antes do cancelamento continua valendo.
    if (action === 'anular' && application.status === 'cancelled') {
        return attemptActionRefusal(res, 409, 'application_cancelled', 'Esta aplicação foi cancelada: não há tentativa para anular nela.');
    }
    const requestedId = String(req.body.submissionId || '').trim();
    const own = applicationSubmissionsOf(application, email);
    let collected = null;
    let target = null;
    if (requestedId) {
        target = own.find(item => String(item.id) === requestedId) || null;
        if (!target) return attemptActionRefusal(res, 404, 'submission_not_found', 'Entrega não encontrada para este aluno nesta aplicação.');
    } else if (action === 'desfazer_anulacao') {
        target = own.find(item => integrityDecision(item) !== null) || null;
        if (!target) return attemptActionRefusal(res, 409, 'not_invalidated', 'Este aluno não tem tentativa anulada nesta aplicação.');
    } else {
        // A prova em andamento é recolhida antes (a tentativa vencida é entregue pelo fim
        // do tempo, como sempre): é ela que fica anulada.
        let settledChanged = false;
        if (ACTIVE_APPLICATION_STATUSES.has(application.status)) {
            settledChanged = !!settleExpiredAttempts(db.memory, { applicationId: application.id, studentEmail: email, graceMs: 0 }).changed;
            const open = findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail: email });
            if (open && Number(open.state.startedAt) > 0) {
                const { deadlineAt } = attemptOverdueMs(open.state, application, now);
                collected = finalizeAttemptState(db.memory, {
                    key: open.key,
                    state: open.state,
                    application,
                    now,
                    deadlineAt,
                    source: INSTRUCTOR_COLLECT_SOURCE,
                });
                if (collected) {
                    collected.collectedBy = actor;
                    collected.collectedAt = new Date(now).toISOString();
                    recordExamAudit('exam_attempt_collected', application, actor, {
                        attemptId: collected.attemptId || null,
                        attemptNumber: collected.attemptNumber || null,
                        submissionId: collected.id,
                        answeredCount: collected.answeredCount,
                        motivo: 'Recolhida para anular a tentativa',
                    }, { studentEmail: email });
                    pushAttemptLog(application, email, collected.attemptId, 'attempt_collected', 'Prova recolhida pelo professor com as respostas salvas');
                }
            }
        }
        target = collected || applicationSubmissionsOf(application, email)[0] || null;
        if (!target) {
            if (settledChanged) await db.save();
            return attemptActionRefusal(res, 409, 'no_submission', 'Este aluno ainda não entregou esta prova: não há tentativa para anular.');
        }
    }

    const title = examTitle(target.examKey, { evaluations: db.memory.evaluations || {} });
    const before = consolidatedResultFor(target);
    const current = integrityDecision(target);
    const attemptLabel = `tentativa ${target.attemptNumber || 1}`;
    if (action === 'anular') {
        if (current) {
            if (collected) await db.save();
            return attemptActionRefusal(res, 409, 'already_invalidated', `Esta tentativa já está anulada (${INTEGRITY_DECISION_LABELS[current]}). Para mudar a decisão, desfaça a anulação antes.`);
        }
        const decisao = INTEGRITY_DECISIONS.includes(req.body.decisao) ? req.body.decisao : 'zero';
        const previous = target.integrity && typeof target.integrity === 'object' && !Array.isArray(target.integrity) ? target.integrity : null;
        target.integrity = {
            decisao,
            motivo: motivo.slice(0, ATTEMPT_ACTION_REASON_MAX),
            por: actor,
            em: now,
            // Anulação desfeita antes: fica a anterior, para o histórico da entrega.
            ...(previous ? { anteriores: [...(Array.isArray(previous.anteriores) ? previous.anteriores : []), { ...previous, anteriores: undefined }].slice(-5) } : {}),
        };
    } else {
        if (!current) return attemptActionRefusal(res, 409, 'not_invalidated', 'Esta tentativa não está anulada.');
        target.integrity = {
            ...target.integrity,
            desfeitaEm: now,
            desfeitaPor: actor,
            motivoDesfeita: motivo.slice(0, ATTEMPT_ACTION_REASON_MAX),
        };
    }
    const after = consolidatedResultFor(target);
    const decisionLabel = INTEGRITY_DECISION_LABELS[action === 'anular' ? target.integrity.decisao : current];
    recordGradeAudit(db.memory, {
        req,
        actor: matchedAdmin,
        submission: target,
        action: action === 'anular' ? 'grade_invalidated' : 'grade_invalidation_undone',
        field: 'Integridade da prova',
        oldValue: `${title}: ${consolidatedLabel(before)}`,
        newValue: action === 'anular'
            ? `${consolidatedLabel(after)} · ${attemptLabel} anulada (${decisionLabel})`
            : `${consolidatedLabel(after)} · anulação da ${attemptLabel} desfeita (era ${decisionLabel})`,
        reason: motivo,
        details: {
            decisao: action === 'anular' ? target.integrity.decisao : current,
            attemptNumber: target.attemptNumber || 1,
            scoreAntes: before.score,
            scoreDepois: after.score,
            ...(collected ? { recolhida: true } : {}),
        },
    });
    pushAttemptLog(application, email, target.attemptId, action === 'anular' ? 'attempt_invalidated' : 'attempt_invalidation_undone',
        action === 'anular' ? `Tentativa anulada pelo professor (${decisionLabel})` : 'Anulação da tentativa desfeita pelo professor');
    application.updatedAt = new Date(now).toISOString();
    application.updatedBy = actor;
    // A entrega já existia (coleção que só cresce, linha antiga alterada): gravação completa.
    await db.save();
    return res.json({
        success: true,
        action,
        application: applicationForAccount(application),
        submission: {
            id: target.id,
            attemptId: target.attemptId || null,
            attemptNumber: target.attemptNumber || 1,
            integrity: integrityDecision(target),
            recolhida: !!collected,
        },
        consolidated: { before: before.score, after: after.score, aguardandoCorrecao: after.aguardandoCorrecao === true },
        studentName: displayName(student) || email,
        studentClass: cls.name,
    });
}

// Registro do monitoramento da prova (evidência, com a retenção dela; aparece no Monitor
// e na digitação ao vivo): attempt_collected, attempt_reopened, attempt_invalidated e
// attempt_invalidation_undone. O texto não leva o motivo (o motivo fica na auditoria, que
// só o professor lê).
function pushAttemptLog(application, email, attemptId, eventType, details) {
    if (!Array.isArray(db.memory.proctoringLogs)) db.memory.proctoringLogs = [];
    db.memory.proctoringLogs.push({
        id: `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        studentEmail: email,
        studentClass: application.studentClass,
        courseId: application.courseId || null,
        examKey: application.examKey,
        applicationId: application.id,
        attemptId: attemptId || null,
        timestamp: Date.now(),
        eventType,
        details,
    });
}

function attemptActionRefusal(res, status, code, error, extra = {}) {
    return res.status(status).json({ success: false, error, code, ...extra });
}

function pushExamMessage(application, actor, messageText) {
    if (!Array.isArray(db.memory.broadcastMessages)) db.memory.broadcastMessages = [];
    db.memory.broadcastMessages.push({
        id: `exam_message_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        studentClass: application.studentClass,
        courseId: application.courseId || null,
        examKey: application.examKey,
        applicationId: application.id,
        targetEmail: null,
        messageText,
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
        senderEmail: actor,
        acknowledgedBy: [],
        deletedFor: [],
        adminDeleted: false,
        status: 'pending',
    });
}

function markQuestionReports(application, question, action, actor, reportIds = null) {
    const ids = reportIds ? new Set(reportIds.map(String)) : null;
    const now = new Date().toISOString();
    let updated = 0;
    (application.questionReports || []).forEach(report => {
        if (report.status !== 'open') return;
        if (ids ? !ids.has(String(report.id)) : Number(report.questionNumber) !== Number(question)) return;
        report.status = action === 'annulled' ? 'annulled' : 'reviewed';
        report.resolutionAction = action;
        report.resolvedBy = actor;
        report.resolvedAt = now;
        updated += 1;
    });
    return updated;
}

// Configuração da turma para a prova quando ela é a DESTA aplicação; senão (aplicação
// encerrada e outra preparada ou aplicada depois), a montada da própria aplicação. Antes a
// recorreção de uma aplicação antiga lia a configuração da aplicação mais nova (e as
// anulações dela, quando a antiga não tinha nenhuma).
function onlineConfigForApplication(cls, application) {
    const current = cls.onlineExamConfigs?.[application.examKey];
    if (current && (!current.applicationId || current.applicationId === application.id)) return current;
    return applicationToOnlineConfig(application, {});
}

// Recorrige as entregas da aplicação. Nota que mudou vai para o scoreHistory da
// entrega e para a auditoria do aluno, com o motivo (AVA-08). changed (opcional): lista
// que recebe as entregas cuja nota mudou.
function regradeApplicationSubmissions(application, cls, { req = null, reason = '', changed = null } = {}) {
    const onlineConfig = onlineConfigForApplication(cls, application);
    const evaluation = db.memory.evaluations?.[application.examKey] || null;
    const by = req ? adminActor(req) : 'sistema';
    let updated = 0;
    (db.memory.submissions || []).forEach(submission => {
        if (submission?.applicationId !== application.id) return;
        const before = { score: submission.score, correctCount: submission.correctCount, totalCount: submission.totalCount };
        regradeSubmission({ submission, application, onlineConfig, evaluation, reason, by });
        updated += 1;
        if (before.score !== submission.score || before.correctCount !== submission.correctCount || before.totalCount !== submission.totalCount) {
            const title = examTitle(submission.examKey, { evaluations: db.memory.evaluations, classes: db.memory.classes });
            const audit = recordGradeAudit(db.memory, {
                req,
                actor: by,
                submission,
                action: 'grade_regrade',
                field: 'Nota',
                oldValue: describeSubmissionGrade({ ...submission, ...before }, title),
                newValue: `${describeSubmissionGrade(submission, title)} · ${reason || 'recorreção da prova'}`,
            });
            const last = Array.isArray(submission.scoreHistory) ? submission.scoreHistory[submission.scoreHistory.length - 1] : null;
            if (last && audit) last.auditId = audit.id;
            if (Array.isArray(changed)) changed.push(submission);
        }
    });
    return updated;
}

function syncApplicationConfig(cls, application) {
    if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
    cls.onlineExamConfigs[application.examKey] = applicationToOnlineConfig(
        application,
        cls.onlineExamConfigs[application.examKey] || {}
    );
    return cls.onlineExamConfigs[application.examKey];
}

function liveQuestion(application, number, version = 'A') {
    const snapshot = snapshotForAttempt(application, null, version);
    return (snapshot?.questions || []).find((question, index) => questionNumber(question, index) === Number(number)) || null;
}

// Questão corrigida ao vivo pelo modelo único (utils/questionModel.js, D3 do P3): as
// letras são as do pedido (as originais) e o que o formulário do Monitor não manda
// (pontos, gabarito da numérica e da resposta curta, explicação...) vem da questão de
// antes (previous). O tipo não muda ao vivo (o modelo recusa com 400).
function normalizeLiveQuestion(payload = {}, previous = null) {
    const question = normalizeQuestion(payload, { context: 'ao_vivo', previous });
    return { ...question, questionText: question.text };
}

// Pedido da correção ao vivo: tipo e tamanho de cada campo (utils/inputSchema.js); a
// questão passa pelo mesmo schema da avaliação.
const LIVE_QUESTION_SCHEMA = body({
    applicationId: str({ max: 100, nullable: true, label: 'aplicação' }),
    questionNumber: either([int({ min: 1, max: 100000, label: 'número da questão' }), str({ max: 10, label: 'número da questão' })], { nullable: true, label: 'número da questão' }),
    question: questionInputSchema({ nullable: true }),
});

// Pedido da correção do gabarito depois da prova (P3-S6: AVA-X2, D14 do P3). Só a
// resposta certa do tipo da questão (utils/questionModel.js normalizeAnswerKey) e o motivo;
// dryRun devolve a prévia do impacto sem gravar; tirarAnulacao corrige uma questão que
// tinha sido anulada (a anulação vale por cima do gabarito).
const ANSWER_KEY_MOTIVO_MIN = 5;
const ANSWER_KEY_MOTIVO_MAX = 500;
const ANSWER_KEY_PREVIEW_LIMIT = 300;
// Recusa da aplicação preparada (ainda não começou): o caminho que monta a prova de novo
// a partir da avaliação é o "Preparar e abrir monitor" do editor, não o "Aplicar online"
// da preparação (que reaplica o gabarito guardado nela).
const APPLICATION_NOT_STARTED_MESSAGE = 'A aplicação ainda não começou, e ela guarda o gabarito de quando foi preparada. Corrija a questão no editor da prova e prepare de novo por "Preparar e abrir monitor": a nova preparação substitui esta. O "Aplicar online" desta preparação traria a resposta antiga de volta.';
const APPLICATION_NOT_STARTED_SIBLING_HINT = 'Outra aplicação desta preparação já começou: corrigir o gabarito por ela ("Corrigir gabarito") leva a resposta certa também a esta.';
const ANSWER_KEY_CORRECTION_SCHEMA = body({
    questionNumber: int({ min: 1, max: 100000, coerce: true, label: 'número da questão' }),
    correctAnswer: str({ max: 20, nullable: true, label: 'resposta certa' }),
    correctAnswers: list(str({ max: 5, label: 'respostas certas' }), { max: 26, nullable: true, label: 'respostas certas' }),
    numeric: shape({
        value: either([num({ label: 'valor da resposta numérica' }), str({ max: 40, label: 'valor da resposta numérica' })], { nullable: true, label: 'valor da resposta numérica' }),
        tolerance: either([num({ label: 'tolerância' }), str({ max: 40, label: 'tolerância' })], { nullable: true, label: 'tolerância' }),
    }, { nullable: true, label: 'resposta numérica' }),
    acceptedAnswers: list(str({ max: 300, nullable: true, label: 'respostas aceitas' }), { max: 50, nullable: true, label: 'respostas aceitas' }),
    motivo: str({ max: ANSWER_KEY_MOTIVO_MAX, label: 'motivo' }),
    dryRun: bool({ nullable: true, label: 'prévia' }),
    tirarAnulacao: bool({ nullable: true, label: 'tirar a anulação' }),
});

function annulmentModeLabel(annulment) {
    return annulment && annulment.mode === 'ponto_para_todos' ? 'ponto para todos' : 'removida do total';
}

// Questão da aplicação como a correção a vê: a do snapshot por cima da avaliação, com o
// tipo, os pontos e o gabarito do snapshot (attemptQuestion, como em questionsForAttempt).
function resolvedLiveQuestion(application, number) {
    const fromSnapshot = liveQuestion(application, number);
    if (!fromSnapshot) return null;
    const evaluation = db.memory.evaluations?.[application.examKey];
    const fromEvaluation = (Array.isArray(evaluation?.questions) ? evaluation.questions : [])
        .find((question, index) => questionNumber(question, index) === Number(number)) || null;
    return attemptQuestion(fromSnapshot, fromEvaluation, Number(number));
}

// Correção ao vivo de uma questão numa versão da prova: enunciado, textos e gabarito
// novos, mas cada versão mantém a ordem das alternativas que os alunos dela estão
// vendo. A alternativa corrigida é achada pela letra original (a do gabarito e dos
// identificadores das respostas salvas); a que o professor acrescentou vai para o fim e a
// que ele tirou sai. A letra impressa (displayLetter) é a da posição, como na montagem
// das versões. Antes todas as versões recebiam as alternativas na ordem do formulário
// (A, B, C, D) e o embaralhamento sumia no meio da prova.
function correctedVersionQuestion(question, normalized, number) {
    const byLetter = new Map(normalized.alternatives.map(alternative => [alternative.letter, alternative]));
    const ordered = [];
    (Array.isArray(question?.alternatives) ? question.alternatives : []).forEach((alternative, index) => {
        const letter = String((alternative && alternative.letter) || String.fromCharCode(65 + index)).toUpperCase();
        if (!byLetter.has(letter)) return;
        ordered.push(byLetter.get(letter));
        byLetter.delete(letter);
    });
    byLetter.forEach(alternative => ordered.push(alternative));
    return {
        ...question,
        ...normalized,
        originalNumber: number,
        alternatives: ordered.map((alternative, index) => ({ ...alternative, displayLetter: String.fromCharCode(65 + index) })),
    };
}

function applicationForAdminRequest(applicationId) {
    const application = findExamApplication(db.memory.examApplications, applicationId);
    if (!application) throw Object.assign(new Error('Aplicação de prova não encontrada.'), { status: 404 });
    const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
    if (!cls) throw Object.assign(new Error('Turma da aplicação não encontrada.'), { status: 404 });
    return { application, cls };
}

// Token selado da aplicação (P3-S8, D19 do P3; utils/examToken.js). Sem token (prova sem
// token, ou token desligado) não há selo. O segredo é o dos identificadores das
// alternativas (config.examAnswerSecret, que fica o deste computador ao restaurar).
function sealApplicationToken(application, token) {
    const sealed = token ? sealExamToken(token, { applicationId: application.id, secret: answerIdSecret() }) : null;
    if (sealed) application.accessTokenSealed = sealed;
    else delete application.accessTokenSealed;
}

function revealApplicationToken(application) {
    const secret = db.memory.config && typeof db.memory.config.examAnswerSecret === 'string' ? db.memory.config.examAnswerSecret : null;
    const token = unsealExamToken(application && application.accessTokenSealed, { applicationId: application && application.id, secret });
    // O selo só vale se for o token que o servidor confere agora (o hash da aplicação).
    return token && hashExamToken(token) === application.accessTokenHash ? token : null;
}

// A aplicação para o painel: sem o token selado e, com agenda, agendaView (a situação e
// os horários no relógio da escola: "Abre sozinha às 08:00", "Fecha sozinha às 09:30").
// No sorteio por aluno (P3-S11), sorteioView: os grupos em palavras.
function withAgendaView(view, application) {
    if (!view) return view;
    const agendaView = examSchedule.scheduleView(application);
    const withAgenda = agendaView ? { ...view, agendaView } : view;
    return examDraw.isPerStudentDraw(application) ? { ...withAgenda, sorteioView: examDraw.drawSummary(application) } : withAgenda;
}

function adminApplicationView(application) {
    return withAgendaView(withoutSealedToken(withKeystrokeMode(application)), application);
}

// Letras das versões da aplicação (A, B...), para o Monitor oferecer só as que existem.
function applicationVersionLabels(application) {
    const snapshots = Array.isArray(application && application.versionSnapshots) ? application.versionSnapshots : [];
    const labels = snapshots
        .map((snapshot, index) => String((snapshot && snapshot.version) || VERSION_LABELS[index] || '').trim().toUpperCase())
        .filter(Boolean);
    return [...new Set(labels)];
}

// Aplicação sem versionSnapshots e questionReports, com openReportCount (view=summary) e
// versionLabels (as versões que existem, para o Monitor).
function applicationSummary(application) {
    const { versionSnapshots, questionReports, accessTokenSealed, ...summary } = application || {};
    summary.openReportCount = (Array.isArray(questionReports) ? questionReports : [])
        .filter(report => report && report.status === 'open').length;
    summary.versionLabels = applicationVersionLabels(application);
    return summary;
}

// Linhas do "Para quem" e das ações por aluno do Monitor no registro da aplicação (o texto
// do "Para quem" vem de examParticipants.js; gradebook.js é da trilha B até a J2 e
// devolveria só 'Evento da prova').
const DESCRIBED_HERE = new Set([
    'exam_application_participants_set',
    'exam_attempt_extra_granted',
    'exam_attempt_collected',
    'exam_attempt_reopened_by_instructor',
    'exam_access_token_revealed',
    'exam_application_token_regenerated',
    'exam_answer_key_corrected',
    'exam_application_scheduled',
    'exam_application_schedule_changed',
    'exam_application_auto_opened',
    'exam_application_auto_finished',
    'exam_application_schedule_missed',
    // Só o encerramento feito pela agenda (reason 'agendamento', ator 'sistema'); o do
    // professor continua com o texto de utils/gradebook.js.
    'exam_application_finished',
]);

function describeMonitorActionAudit(entry, nameByEmail) {
    const details = (entry && entry.details) || {};
    const email = normalizeEmail(entry.studentEmail || details.studentEmail);
    const name = nameByEmail.get(email) || (entry.studentAnonymized ? 'Aluno anonimizado' : email || 'aluno');
    const join = (...parts) => parts.filter(Boolean).join(' · ');
    if (entry.type === 'exam_attempt_collected') {
        const answered = Number(details.answeredCount) || 0;
        return {
            title: `Prova de ${name} recolhida pelo professor`,
            detail: join(`${answered} ${answered === 1 ? 'resposta salva' : 'respostas salvas'}`, details.motivo ? `motivo: ${details.motivo}` : ''),
        };
    }
    if (entry.type === 'exam_attempt_reopened_by_instructor') {
        const minutes = details.minutosRestantes;
        return {
            title: `Prova de ${name} reaberta pelo professor`,
            detail: join(minutes === null || minutes === undefined ? '' : `${minutes} min para terminar`, details.motivo ? `motivo: ${details.motivo}` : ''),
        };
    }
    if (entry.type === 'exam_access_token_revealed') return { title: 'Token da prova mostrado de novo', detail: '' };
    if (entry.type === 'exam_answer_key_corrected') {
        const changed = Number(details.changed) || 0;
        return {
            title: `Gabarito da questão ${details.questionNumber} corrigido: ${details.antes || '—'} → ${details.depois || '—'}`,
            detail: join(
                changed === 0 ? 'nenhuma nota mudou' : `${changed} ${changed === 1 ? 'nota mudou' : 'notas mudaram'}`,
                details.notifiedStudents ? `${details.notifiedStudents} ${details.notifiedStudents === 1 ? 'aluno avisado' : 'alunos avisados'}` : '',
                details.tirouAnulacao ? 'anulação retirada' : '',
                details.motivo ? `motivo: ${details.motivo}` : '',
            ),
        };
    }
    if (entry.type === 'exam_application_token_regenerated') return { title: 'Token da prova trocado', detail: '' };
    // Agendamento (P3-S12).
    const when = ms => examSchedule.formatWhen(ms) || '—';
    if (entry.type === 'exam_application_scheduled') {
        return { title: 'Prova agendada', detail: examSchedule.describeWindow(details.abreEm, details.fechaEm) };
    }
    if (entry.type === 'exam_application_schedule_changed') {
        if (details.fechamentoCancelado) return { title: 'Fechamento automático retirado', detail: 'a prova não encerra mais sozinha' };
        if (!details.depois) return { title: 'Agendamento cancelado', detail: details.antes ? `era: ${examSchedule.describeWindow(details.antes.abreEm, details.antes.fechaEm)}` : '' };
        return {
            title: 'Agendamento alterado',
            detail: join(details.antes ? `antes: ${examSchedule.describeWindow(details.antes.abreEm, details.antes.fechaEm)}` : '', `agora: ${examSchedule.describeWindow(details.depois.abreEm, details.depois.fechaEm)}`),
        };
    }
    if (entry.type === 'exam_application_auto_opened') {
        const late = Number(details.atrasoSegundos) || 0;
        return {
            title: 'Prova aberta pelo agendamento',
            // formatWhen já diz "20/11 às 08:00" (antes saía "às 20/11 às 08:00").
            detail: late > 60 ? `${Math.round(late / 60)} min depois de ${when(details.abreEm)} (o computador estava desligado)` : `em ${when(details.abreEm)}, no horário marcado`,
        };
    }
    if (entry.type === 'exam_application_auto_finished') {
        const delivered = Number(details.entregues) || 0;
        const deliveredText = `${delivered} ${delivered === 1 ? 'prova em andamento entregue' : 'provas em andamento entregues'} com o que estava salvo`;
        // Encerrada depois do horário de fechar (o computador estava desligado): a hora real (A18).
        const late = Number(details.atrasoSegundos) || 0;
        if (late > 60) {
            return { title: 'Prova encerrada pelo agendamento', detail: `${Math.round(late / 60)} min depois de ${when(details.fechaEfetivaEm || details.fechaEm)} (o computador estava desligado) · ${deliveredText}` };
        }
        return { title: 'Prova encerrada pelo agendamento', detail: deliveredText };
    }
    // O encerramento da agenda (finishApplication com o ator 'sistema'): antes o registro
    // dizia "provas em andamento enviadas pelo professor".
    if (entry.type === 'exam_application_finished') {
        if (details.reason !== 'agendamento') return null;
        const submitted = Number(details.submitted) || 0;
        return {
            title: 'Aplicação encerrada no horário marcado',
            detail: submitted > 0
                ? `${submitted} ${submitted === 1 ? 'prova em andamento enviada' : 'provas em andamento enviadas'} pelo agendamento, com o que estava salvo`
                : '',
        };
    }
    if (entry.type === 'exam_application_schedule_missed') {
        return { title: 'Agendamento perdido: a prova não abriu', detail: `o computador estava desligado entre ${when(details.abreEm)} e ${when(details.fechaEm)}` };
    }
    return null;
}

function describeAudienceEntries(rows) {
    const byId = new Map((db.memory.auditLogs || [])
        .filter(entry => entry && DESCRIBED_HERE.has(entry.type))
        .map(entry => [entry.id, entry]));
    if (!byId.size) return rows;
    const nameByEmail = new Map((db.memory.students || []).map(student => [String(student.email || '').trim().toLowerCase(), (student.nomeSocial && student.nomeSocial.trim()) || student.name || student.email]));
    return rows.map(row => {
        const entry = byId.get(row.id);
        const described = entry ? (describeAudienceAudit(entry, nameByEmail) || describeMonitorActionAudit(entry, nameByEmail)) : null;
        return described ? { ...row, ...described } : row;
    });
}

// Avisos do agendamento (nunca bloqueiam): o dia de abrir é não letivo para a turma e a
// janela é menor que a duração da prova (quem ainda estiver fazendo a prova no fechamento
// tem a prova entregue com o que salvou).
function scheduleWarnings(cls, application) {
    const agenda = application && application.agenda;
    const avisos = [];
    if (!agenda || !(Number(agenda.abreEm) > 0)) return avisos;
    const day = examSchedule.nonSchoolDayWarning(db.memory, cls, Number(agenda.abreEm));
    if (day) avisos.push({ code: 'nao_letivo', texto: day.texto, nome: day.nome, date: day.date });
    const windowMinutes = (Number(agenda.fechaEm) - Number(agenda.abreEm)) / 60000;
    const duration = Number(application.durationMinutes);
    if (application.timerEnabled !== false && duration > 0 && windowMinutes > 0 && Number(agenda.fechaEm) > Number(agenda.abreEm) + 1 && windowMinutes < duration) {
        avisos.push({ code: 'janela_curta', texto: `A prova fica aberta ${Math.round(windowMinutes)} min e dura ${duration} min: quem ainda estiver fazendo a prova no horário de fechar tem a prova entregue com o que salvou.` });
    }
    return avisos;
}

// Escopo do professor na turma da aplicação (o guarda já conferiu a permissão).
function canManageApplication(matchedAdmin, application) {
    return adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId);
}

// Tira a liberação agendada do item (sem auditoria: quem chama já registra o que fez).
function dropItemSchedule(cls, itemKey) {
    if (!cls.releaseSchedule || typeof cls.releaseSchedule !== 'object' || !Object.prototype.hasOwnProperty.call(cls.releaseSchedule, itemKey)) return false;
    delete cls.releaseSchedule[itemKey];
    return true;
}

// Agendar ({ releaseAtLocal }) ou cancelar ({ cancelSchedule: true }) a liberação de um
// item da turma (P3-S12, D27). Só a turma inteira (a liberação para um aluno continua na
// hora); a prova online nunca (abre por aplicação); item já liberado não precisa de agenda.
async function scheduleItemRelease(req, res, cls, itemKey, studentEmail) {
    if (studentEmail) return res.status(400).json({ error: 'A liberação agendada vale para a turma inteira, não para um aluno só.' });
    if (!examSchedule.releaseScheduleAllowed(itemKey)) {
        return res.status(400).json({ error: 'A prova online não é liberada por agenda: prepare a aplicação em Provas e use o "Quando" para agendar.', code: 'schedule_not_allowed' });
    }
    const actor = adminActor(req);
    const actorName = (req.adminAccount && (req.adminAccount.name || req.adminAccount.email)) || 'Administrador';
    const previous = cls.releaseSchedule && Object.prototype.hasOwnProperty.call(cls.releaseSchedule, itemKey) ? cls.releaseSchedule[itemKey] : null;
    const describe = entry => (entry && Number(entry.at) > 0 ? examSchedule.formatWhen(Number(entry.at)) : '');
    if (req.body.cancelSchedule === true) {
        if (!previous) return res.json({ success: true, unchanged: true, releaseSchedule: examSchedule.releaseScheduleView(cls, { memory: db.memory }) });
        dropItemSchedule(cls, itemKey);
        recordAudit(db.memory, {
            action: 'content_release_scheduled',
            req,
            courseId: cls.courseId || null,
            studentClass: cls.name,
            field: itemKey,
            oldValue: describe(previous),
            newValue: 'cancelada',
            details: { itemKey, at: null, antes: Number(previous.at) || null, cancelado: true },
        });
        await persistClasses(db.memory.classes || []);
        return res.json({ success: true, releaseSchedule: examSchedule.releaseScheduleView(cls, { memory: db.memory }) });
    }
    if (req.body.released === false) return res.status(400).json({ error: 'A agenda só libera o item. Para bloquear, use o interruptor.' });
    const parsed = examSchedule.parseReleaseAt(req.body.releaseAtLocal);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.error, field: 'releaseAtLocal' });
    if (cls.releasedItems && cls.releasedItems[itemKey] === true) {
        return res.status(409).json({ error: 'Este item já está liberado para a turma.', code: 'already_released' });
    }
    if (!cls.releaseSchedule || typeof cls.releaseSchedule !== 'object' || Array.isArray(cls.releaseSchedule)) cls.releaseSchedule = {};
    cls.releaseSchedule[itemKey] = { at: parsed.value, released: true, por: actor, porNome: actorName, criadoEm: Date.now() };
    recordAudit(db.memory, {
        action: 'content_release_scheduled',
        req,
        courseId: cls.courseId || null,
        studentClass: cls.name,
        field: itemKey,
        oldValue: previous ? describe(previous) : null,
        newValue: describe(cls.releaseSchedule[itemKey]),
        details: { itemKey, at: parsed.value, ...(previous ? { antes: Number(previous.at) || null } : {}) },
    });
    await persistClasses(db.memory.classes || []);
    const avisos = [];
    const day = examSchedule.nonSchoolDayWarning(db.memory, cls, parsed.value);
    if (day) avisos.push({ code: 'nao_letivo', texto: day.texto.replace('A prova abre do mesmo jeito.', 'O item é liberado do mesmo jeito.'), nome: day.nome, date: day.date });
    // Gabarito com aplicação aberta: a hora chega e a liberação espera o encerramento.
    if (itemKey.startsWith('Gabarito_') && openExamFamilyApplication(cls, itemKey.slice('Gabarito_'.length))) {
        avisos.push({ code: 'gabarito_espera', texto: 'A prova ainda tem uma aplicação preparada ou em andamento: se ela não estiver encerrada no horário, o gabarito sai assim que for encerrada.' });
    }
    res.json({ success: true, releaseSchedule: examSchedule.releaseScheduleView(cls, { memory: db.memory }), ...(avisos.length ? { avisos } : {}) });
}

function createAdminExamConfigRouter() {
    const router = express.Router();

    // Alunos da turma para o "Para quem" da preparação (P3-S7): cada um com fezRegular
    // (já tem entrega que conta numa aplicação regular da prova) e, com applicationId, se
    // está na lista dela e a exceção dele. segundaChamada é a lista pré-marcada: quem não
    // fez. Declarada antes de /exam-applications/:applicationId.
    // Avisos do "Quando" antes de agendar (P3-S12, contrato C5): o dia de abrir é não
    // letivo para a turma (isNonSchoolDay) ou a janela é menor que a duração da prova. Só
    // avisa, nunca bloqueia. Declarada antes de /exam-applications/:applicationId.
    router.get('/api/admin/exam-applications/schedule-check', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const cls = findClassByNameAndCourse(db.memory.classes || [], String(req.query.studentClass || '').trim(), req.query.courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!adminCanAccessClass(matchedAdmin, cls.name, cls.courseId)) {
                return res.status(403).json({ error: 'A turma não está atribuída a esta conta.' });
            }
            const abreEm = examSchedule.parseLocalDateTime(req.query.abreEmLocal);
            const fechaEm = examSchedule.parseLocalDateTime(req.query.fechaEmLocal);
            const duration = Number(req.query.durationMinutes);
            const avisos = scheduleWarnings(cls, {
                agenda: abreEm && fechaEm ? { abreEm, fechaEm } : (abreEm ? { abreEm, fechaEm: abreEm + 1 } : null),
                durationMinutes: Number.isFinite(duration) && duration > 0 ? duration : null,
                timerEnabled: req.query.timerEnabled !== 'false',
            });
            res.json({ success: true, avisos, janela: abreEm && fechaEm && fechaEm > abreEm ? examSchedule.describeWindow(abreEm, fechaEm) : '' });
        });
    });

    // Questões que o sorteio por aluno pode usar (P3-S11, D24): as da configuração salva
    // (historyId) ou as escolhidas na montagem (numbers=1,2,3), com o que o filtro dos grupos
    // olha (origem, categoria do banco, dificuldade e etiquetas). A tela conta quantas cabem
    // em cada grupo; quem confere de verdade é a preparação (parseDrawInput). Só leitura.
    router.get('/api/admin/exam-applications/draw-pool', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const params = DRAW_POOL_QUERY.check(req, res);
            if (!params) return;
            const cls = findClassByNameAndCourse(db.memory.classes || [], params.studentClass || '', params.courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!adminCanAccessClass(matchedAdmin, cls.name, cls.courseId)) {
                return res.status(403).json({ error: 'A turma não está atribuída a esta conta.' });
            }
            const examKey = params.examKey || '';
            if (!examKey || !isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            const evaluation = evaluationFor(examKey);
            const historyId = params.historyId || '';
            let snapshots;
            if (historyId) {
                const entry = findOnlineHistoryEntry(cls, examKey, historyId);
                if (!entry) return res.status(404).json({ error: 'Configuração salva não encontrada ou sem questões.' });
                snapshots = getHistoryVersionSnapshots(entry);
            } else {
                const wanted = (params.numbers ? params.numbers.split(',') : []).map(item => Number(item.trim()));
                const evaluationQuestions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
                const chosen = wanted.length ? new Set(wanted) : null;
                snapshots = [{ questions: evaluationQuestions.filter((question, index) => !chosen || chosen.has(questionNumber(question, index))) }];
            }
            const pool = examDraw.drawPool(snapshots, evaluation, db.memory);
            const distinct = values => {
                const seen = new Map();
                values.forEach(value => {
                    const key = String(value || '').trim();
                    if (key && !seen.has(key.toLowerCase())) seen.set(key.toLowerCase(), key);
                });
                return [...seen.values()].sort(compareText);
            };
            res.set('Cache-Control', 'no-store');
            res.json({
                success: true,
                questions: pool,
                categorias: distinct(pool.map(item => item.categoria)),
                etiquetas: distinct(pool.flatMap(item => item.tags)),
            });
        });
    });

    router.get('/api/admin/exam-applications/participant-candidates', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const studentClass = String(req.query.studentClass || '').trim();
            const examKey = String(req.query.examKey || '').trim();
            const applicationId = String(req.query.applicationId || '').trim();
            const application = applicationId ? findExamApplication(db.memory.examApplications, applicationId) : null;
            if (applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            const cls = application
                ? findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId)
                : findClassByNameAndCourse(db.memory.classes || [], studentClass, req.query.courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            const key = application ? application.examKey : examKey;
            if (!key) return res.status(400).json({ error: 'Informe a prova.' });
            if (!adminCanAccessClass(matchedAdmin, cls.name, cls.courseId)) {
                return res.status(403).json({ error: 'A turma desta aplicação não está atribuída a esta conta.' });
            }
            const scope = { studentClass: cls.name, courseId: cls.courseId, examKey: key, excludeApplicationId: application ? application.id : null };
            const list = application ? applicationParticipantList(application) : null;
            const overrides = (application && application.studentOverrides) || {};
            const students = participantCandidates(db.memory, scope).map(student => {
                const override = overrides[student.email] || null;
                return {
                    ...student,
                    naLista: application ? (list === null || list.includes(student.email)) : null,
                    override: override ? {
                        extraAttempts: Number(override.extraAttempts) || 0,
                        prazoAte: Number(override.prazoAte) > 0 ? Number(override.prazoAte) : null,
                        // O prazo no relógio da escola ("01/12 às 08:00"): a tela não usa o
                        // fuso do aparelho de quem abre.
                        prazoAteLabel: Number(override.prazoAte) > 0 ? formatSchoolDateTime(Number(override.prazoAte)) || null : null,
                        motivo: String(override.motivo || ''),
                    } : null,
                };
            });
            res.set('Cache-Control', 'no-store');
            res.json({
                success: true,
                students,
                segundaChamada: students.filter(student => !student.fezRegular).map(student => student.email),
                application: application ? {
                    id: application.id,
                    status: application.status,
                    timerMode: application.timerMode || 'collective',
                    finalidade: applicationFinalidade(application),
                    participants: list,
                } : null,
            });
        });
    });

    router.get('/api/admin/exam-applications', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const applications = listExamApplications(db.memory.examApplications, {
                studentClass: req.query.studentClass,
                courseId: req.query.courseId,
                examKey: req.query.examKey,
            }).filter(application => accountScopeKind(matchedAdmin) === 'tudo'
                || (accountScopeKind(matchedAdmin) === 'turmas'
                    ? (matchedAdmin.assignedClasses || []).some(item =>
                        item && item.courseId === application.courseId && item.className === application.studentClass)
                    : adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)))
                // Aplicação de antes do H8b, sem o campo, aparece como 'eventos' (cópia; o banco não
                // muda), com keystrokeModeLegacy: o que ela já guardou é a digitação completa.
                .map(adminApplicationView);
            // view=summary (Monitor, consultado a cada 5 s): sem as versões da prova
            // (versionSnapshots, com o gabarito) e sem as contestações (questionReports),
            // que nenhuma tela de polling lê e eram o grosso da resposta (DES-04, DES-13);
            // openReportCount diz quantas contestações estão em aberto. Sem view, nada muda.
            // O modo do teclado (H8b) continua no resumo: o Monitor rotula a coluna por ele.
            // Quem chega aqui só pelo Monitor (page.monitor sem page.exams, como o Professor
            // auxiliar) recebe sempre o resumo: as versões levam o gabarito.
            if (String(req.query.view || '') === 'summary' || !canReadExamVersions(matchedAdmin)) {
                return res.json({ success: true, applications: applications.map(applicationSummary) });
            }
            res.json({ success: true, applications });
        });
    });

    router.get('/api/admin/exam-applications/:applicationId', (req, res) => {
        validateAdmin(req, res, () => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            res.json({ success: true, application: adminApplicationView(application) });
        });
    });

    // Registro da aplicação (AVA-08): ciclo, eventos da prova e alterações de nota
    // das entregas desta aplicação, para o professor conferir o que mudou e quando.
    router.get('/api/admin/exam-applications/:applicationId/audit', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                return res.status(403).json({ error: 'Aplicação fora do escopo desta conta.' });
            }
            res.json({
                success: true,
                application: {
                    id: application.id,
                    examKey: application.examKey,
                    examTitle: examTitle(application.examKey, { evaluations: db.memory.evaluations, classes: db.memory.classes }),
                    studentClass: application.studentClass,
                    courseId: application.courseId || null,
                    status: application.status,
                    createdAt: application.createdAt || null,
                },
                // O outro login e a troca de IP (P3-S13) ficam em proctoringLogs, fora da
                // auditoria, e entram aqui junto com o resto do registro.
                entries: describeAudienceEntries(withSessionTrail(
                    buildApplicationAuditTrail(application, db.memory.auditLogs || [], { students: db.memory.students || [] }),
                    application,
                    db.memory.proctoringLogs || [],
                    { students: db.memory.students || [] },
                )),
            });
        });
    });

    router.get('/api/admin/exam-applications/:applicationId/finish-summary', (req, res) => {
        validateAdmin(req, res, () => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            res.json({ success: true, summary: finishSummary(application) });
        });
    });

    // Token da aplicação de novo na tela (P3-S8: AVA-14; D19 do P3): o Monitor de outro
    // computador, o projetor ou a aba fechada mostram o token sem trocá-lo. Só com
    // page.monitor (o guarda) e a turma da conta; cada leitura fica na auditoria
    // (exam_access_token_revealed, nunca o token). Aplicação de antes desta versão (sem
    // selo) ou restaurada de outro computador (o segredo de lá é outro): 404
    // token_unavailable, e a tela oferece "Gerar outro".
    router.get('/api/admin/exam-applications/:applicationId/access-token', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            if (!canManageApplication(matchedAdmin, application)) {
                return res.status(403).json({ error: 'A turma desta aplicação não está atribuída a esta conta.' });
            }
            res.set('Cache-Control', 'no-store');
            if (application.tokenEnabled !== true) {
                return res.status(400).json({ error: 'Esta aplicação não exige token de acesso.', code: 'token_disabled' });
            }
            if (!OPEN_APPLICATION_STATUSES.has(application.status)) {
                return res.status(409).json({ error: 'Esta aplicação já foi encerrada; nenhum aluno entra mais com o token.', code: 'application_closed', applicationClosed: true });
            }
            const accessToken = revealApplicationToken(application);
            if (!accessToken) {
                return res.status(404).json({
                    error: 'Não dá para mostrar o token desta aplicação de novo (ela é de antes desta versão ou veio de um backup de outro computador). Gere outro token: quem já entrou continua na prova.',
                    code: 'token_unavailable',
                });
            }
            recordExamAudit('exam_access_token_revealed', application, adminActor(req), { status: application.status });
            await db.save({ only: ['auditLogs'] });
            res.json({ success: true, accessToken, accessTokenIssuedAt: application.accessTokenIssuedAt || null, applicationId: application.id });
        });
    });

    // Novo token para uma aplicação preparada ou em andamento, sem preparar de novo nem
    // encerrar a prova (o token perdido, ou trocar o que vazou). Quem já validou o token
    // continua na prova; o anterior deixa de valer para quem ainda vai entrar. O novo
    // também fica selado (o Monitor de outro computador o mostra).
    router.post('/api/admin/exam-applications/:applicationId/access-token', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                return res.status(403).json({ error: 'A turma desta aplicação não está atribuída a esta conta.' });
            }
            if (!OPEN_APPLICATION_STATUSES.has(application.status)) {
                return res.status(409).json({ error: 'Esta aplicação já foi encerrada; não há token para gerar.' });
            }
            if (application.tokenEnabled !== true) {
                return res.status(400).json({ error: 'Esta aplicação não exige token de acesso.' });
            }
            const requested = req.body && req.body.accessToken;
            if (requested && !normalizeExamToken(requested)) {
                return res.status(400).json({ error: 'O token deve conter exatamente 5 letras maiúsculas.' });
            }
            const accessToken = ensureExamToken(requested);
            const actor = adminActor(req);
            application.accessTokenHash = hashExamToken(accessToken);
            sealApplicationToken(application, accessToken);
            application.updatedAt = new Date().toISOString();
            application.accessTokenIssuedAt = application.updatedAt;
            application.updatedBy = actor;
            const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
            const classConfig = cls?.onlineExamConfigs?.[application.examKey];
            if (classConfig && classConfig.applicationId === application.id) {
                classConfig.accessTokenHash = application.accessTokenHash;
                classConfig.tokenEnabled = true;
            }
            // O token nunca vai para a auditoria: só o registro de que foi trocado.
            recordExamAudit('exam_application_token_regenerated', application, actor, { status: application.status });
            await saveApplicationAction();
            res.json({ success: true, accessToken, accessTokenIssuedAt: application.accessTokenIssuedAt, applicationId: application.id });
        });
    });

    router.post('/api/admin/exam-applications', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!PREPARE_AUDIENCE_SCHEMA.check(req, res)) return;
            const { studentClass, courseId, examKey, historyId } = req.body || {};
            if (!studentClass || !examKey || !historyId) {
                return res.status(400).json({ error: 'Turma, prova e configuração salva são obrigatórias.' });
            }
            const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            const historyEntry = findOnlineHistoryEntry(cls, examKey, historyId);
            if (!historyEntry) return res.status(400).json({ error: 'Configuração salva não encontrada ou sem questões.' });
            const options = req.body.applicationOptions || {};
            // Versões online: no máximo 4 (A a D); antes o servidor cortava sem avisar (AVA-16).
            if (Number(options.onlineVersions) > examVersions.ONLINE_VERSIONS_MAX) {
                return res.status(400).json({ success: false, error: examVersions.ONLINE_VERSIONS_ERROR, field: 'applicationOptions.onlineVersions', code: 'too_many_versions' });
            }
            // Configuração salva antes da conferência do gabarito (D23): a resposta certa de
            // cada questão precisa ser a da prova de hoje.
            const answerKeyProblem = examVersions.preparationAnswerKeyProblem(historyEntry, evaluationFor(examKey));
            if (answerKeyProblem) return res.status(409).json({ success: false, ...answerKeyProblem });
            // Como montar (D24): versões (padrão) ou sorteio por aluno sobre as questões da
            // configuração salva.
            const draw = examDraw.parseDrawInput(options.sorteio, {
                pool: examDraw.drawPool(getHistoryVersionSnapshots(historyEntry), evaluationFor(examKey), db.memory),
            });
            if (!draw.ok) return res.status(400).json({ success: false, error: draw.error, field: `applicationOptions.${draw.field}` });
            if (options.tokenEnabled === true && !normalizeExamToken(options.accessToken)) {
                return res.status(400).json({ error: 'O token deve conter exatamente 5 letras maiúsculas.' });
            }
            const parsedMaxAttempts = parseMaxAttempts(Object.prototype.hasOwnProperty.call(options, 'maxAttempts')
                ? options.maxAttempts
                : (Object.prototype.hasOwnProperty.call(historyEntry, 'maxAttempts') ? historyEntry.maxAttempts : DEFAULT_MAX_ATTEMPTS));
            if (!parsedMaxAttempts.valid) return res.status(400).json({ error: 'Tentativas deve ser um número entre 1 e 10.' });
            const keystrokeChoice = parseKeystrokeModeOption(options);
            if (!keystrokeChoice.valid) return res.status(400).json({ success: false, error: keystrokeChoice.error, field: 'keystrokeMode' });
            // Uma aplicação em andamento nunca é encerrada por outra preparação: o
            // professor decide no Monitor o que fazer com as respostas (AVA-04).
            const running = activeExamApplication(db.memory, { studentClass: cls.name, courseId: cls.courseId, examKey });
            if (running) return res.status(409).json(activeApplicationConflict(running));
            // Para quem (P3-S7, D15 e D16): turma inteira (padrão), segunda chamada ou alunos
            // escolhidos, e as exceções por aluno. Sem os campos, tudo como antes.
            const audience = parseApplicationAudience(db.memory, {
                finalidade: options.finalidade,
                participants: options.participants,
                studentOverrides: options.studentOverrides,
            }, {
                cls,
                examKey,
                timerMode: options.timerMode === 'per_attempt' ? 'per_attempt' : 'collective',
                actor: adminActor(req),
            });
            if (!audience.ok) return res.status(400).json({ success: false, error: audience.error, field: audience.field ? `applicationOptions.${audience.field}` : undefined });
            // "Quando" (P3-S12, D25): agendada, a aplicação abre e fecha sozinha. Conferida
            // antes de preparar: a agenda inválida não substitui a preparação de antes.
            let schedule = null;
            if (options.agenda) {
                const parsed = examSchedule.parseScheduleInput(options.agenda);
                if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.error, field: `applicationOptions.agenda.${parsed.field}` });
                schedule = parsed.value;
            }
            if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
            if (!cls.releasedItems) cls.releasedItems = {};
            const prepared = prepareApplicationFromHistory(cls, examKey, historyEntry, options, req, audience.value, draw.value);
            // Sorteio por aluno (D24): os grupos em palavras e quantas questões cada um tinha.
            if (draw.value) {
                const summary = examDraw.drawSummary(prepared.application);
                recordExamAudit('exam_application_draw_set', prepared.application, adminActor(req), {
                    total: summary.total,
                    grupos: summary.grupos.map(group => ({ descricao: group.descricao, quantidade: group.quantidade, disponiveis: group.disponiveis })),
                });
            }
            let avisos = [];
            if (schedule) {
                prepared.application.agenda = examSchedule.createAgenda(schedule, { actor: adminActor(req) });
                recordExamAudit('exam_application_scheduled', prepared.application, adminActor(req), { abreEm: schedule.abreEm, fechaEm: schedule.fechaEm });
                avisos = scheduleWarnings(cls, prepared.application);
            }
            await persistClasses(db.memory.classes || []);
            res.status(201).json({ success: true, ...prepared, application: withAgendaView(withoutSealedToken(prepared.application), prepared.application), onlineExamConfig: cls.onlineExamConfigs[examKey], ...(avisos.length ? { avisos } : {}) });
        });
    });

    // Para quem da aplicação já preparada (P3-S7): a lista de alunos (null = turma inteira),
    // a finalidade (só antes de a prova começar) e as exceções por aluno (tentativas extras
    // e prazo para começar). Com a prova em andamento a lista só cresce. Não mexe em nota:
    // grava só a aplicação e a auditoria.
    router.post('/api/admin/exam-applications/:applicationId/participants', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!PARTICIPANTS_SCHEMA.check(req, res)) return;
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            if (!canManageApplication(matchedAdmin, application)) {
                return res.status(403).json({ error: 'A turma desta aplicação não está atribuída a esta conta.' });
            }
            if (['finished', 'cancelled'].includes(application.status)) {
                return res.status(409).json({ error: 'Esta aplicação já foi encerrada; a lista de alunos não muda mais.', code: 'application_closed', applicationClosed: true });
            }
            const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
            if (!cls) return res.status(404).json({ error: 'Turma da aplicação não encontrada.' });
            const input = req.body || {};
            const actor = adminActor(req);
            const parsed = parseApplicationAudience(db.memory, {
                finalidade: input.finalidade,
                participants: input.participants,
                studentOverrides: input.studentOverrides,
            }, { cls, examKey: application.examKey, application, actor });
            if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.error, field: parsed.field });
            const before = {
                finalidade: applicationFinalidade(application),
                participants: applicationParticipantList(application),
                studentOverrides: JSON.parse(JSON.stringify(application.studentOverrides || {})),
            };
            const next = parsed.value;
            const participantsChanged = before.finalidade !== next.finalidade
                || JSON.stringify(before.participants) !== JSON.stringify(next.participants);
            const overridesChanged = changedOverrides(before.studentOverrides, next.studentOverrides).length > 0;
            if (!participantsChanged && !overridesChanged) {
                return res.json({ success: true, unchanged: true, application: adminApplicationView(application) });
            }
            application.finalidade = next.finalidade;
            application.participants = next.participants;
            application.studentOverrides = next.studentOverrides;
            application.updatedAt = new Date().toISOString();
            application.updatedBy = actor;
            recordAudienceAudit(application, actor, { participantsChanged, before });
            await db.save({ only: ['examApplications', 'auditLogs'] });
            res.json({ success: true, application: adminApplicationView(application) });
        });
    });

    // Agendar, mudar ou cancelar a abertura e o fechamento automáticos (P3-S12, D25).
    // Preparada: { abreEmLocal, fechaEmLocal } agenda (ou muda, e a agenda perdida volta a
    // valer com o horário novo) e { cancelar: true } tira a agenda (a aplicação continua
    // preparada, esperando o "Iniciar" do Monitor). Em andamento: só { cancelar: true },
    // que tira o fechamento automático ("Não encerrar sozinha"). Não mexe em nota: grava só
    // a aplicação e a auditoria.
    router.post('/api/admin/exam-applications/:applicationId/schedule', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!SCHEDULE_SCHEMA.check(req, res)) return;
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            if (!canManageApplication(matchedAdmin, application)) {
                return res.status(403).json({ error: 'A turma desta aplicação não está atribuída a esta conta.' });
            }
            const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
            if (!cls) return res.status(404).json({ error: 'Turma da aplicação não encontrada.' });
            const input = req.body || {};
            const actor = adminActor(req);
            const current = examSchedule.applicationAgenda(application);
            const snapshot = agenda => (agenda ? { abreEm: Number(agenda.abreEm), fechaEm: Number(agenda.fechaEm), ...(agenda.perdida === true ? { perdida: true } : {}) } : null);
            const now = Date.now();
            if (ACTIVE_APPLICATION_STATUSES.has(application.status)) {
                if (input.cancelar !== true) {
                    return res.status(409).json({ error: 'A prova já abriu: o horário não muda mais. Dá para tirar o fechamento automático ("Não encerrar sozinha") ou encerrar pelo Monitor.', code: 'schedule_started' });
                }
                if (!examSchedule.closesAutomatically(application, current)) {
                    return res.json({ success: true, unchanged: true, application: adminApplicationView(application) });
                }
                current.fechamentoCanceladoEm = now;
                current.fechamentoCanceladoPor = actor;
                application.updatedAt = new Date(now).toISOString();
                application.updatedBy = actor;
                recordExamAudit('exam_application_schedule_changed', application, actor, { antes: snapshot(current), depois: snapshot(current), fechamentoCancelado: true });
                await db.save({ only: ['examApplications', 'auditLogs'] });
                return res.json({ success: true, application: adminApplicationView(application) });
            }
            if (application.status !== 'prepared') {
                return res.status(409).json({ error: 'Esta aplicação já foi encerrada ou cancelada; o agendamento não muda mais.', code: 'application_closed', applicationClosed: true });
            }
            if (input.cancelar === true) {
                if (!current) return res.json({ success: true, unchanged: true, application: adminApplicationView(application) });
                delete application.agenda;
                application.updatedAt = new Date(now).toISOString();
                application.updatedBy = actor;
                recordExamAudit('exam_application_schedule_changed', application, actor, { antes: snapshot(current), depois: null });
                await db.save({ only: ['examApplications', 'auditLogs'] });
                return res.json({ success: true, application: adminApplicationView(application) });
            }
            const parsed = examSchedule.parseScheduleInput(input, { now });
            if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.error, field: parsed.field });
            if (current && current.perdida !== true && Number(current.abreEm) === parsed.value.abreEm && Number(current.fechaEm) === parsed.value.fechaEm) {
                return res.json({ success: true, unchanged: true, application: adminApplicationView(application), avisos: scheduleWarnings(cls, application) });
            }
            application.agenda = examSchedule.createAgenda(parsed.value, { actor, now });
            application.updatedAt = new Date(now).toISOString();
            application.updatedBy = actor;
            if (current) recordExamAudit('exam_application_schedule_changed', application, actor, { antes: snapshot(current), depois: snapshot(application.agenda) });
            else recordExamAudit('exam_application_scheduled', application, actor, { abreEm: parsed.value.abreEm, fechaEm: parsed.value.fechaEm });
            await db.save({ only: ['examApplications', 'auditLogs'] });
            const avisos = scheduleWarnings(cls, application);
            res.json({ success: true, application: adminApplicationView(application), ...(avisos.length ? { avisos } : {}) });
        });
    });

    router.post('/api/admin/exam-applications/:applicationId/control', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            // Quem controla a prova só pelo Monitor (page.monitor sem page.exams, como o
            // Professor auxiliar) recebe a aplicação e a configuração sem as versões (gabarito).
            const withAnswerKeys = canReadExamVersions(matchedAdmin);
            const forAccount = (application, onlineConfig) => {
                if (withAnswerKeys) return { application: withoutSealedToken(application), config: onlineConfig };
                return { application: applicationSummary(application), config: onlineConfig ? onlineExamConfigWithoutAnswerKeys(onlineConfig) : null };
            };
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
            if (!cls) return res.status(404).json({ error: 'Turma da aplicação não encontrada.' });
            let processedFinish = null;
            // A transição é conferida antes de mexer nas tentativas. Encerrar ou cancelar
            // (com qualquer nome de ação) uma aplicação em andamento passa sempre pela
            // decisão sobre as respostas de quem está fazendo a prova; repetir o
            // encerramento de uma aplicação já encerrada não muda nada.
            let plan;
            try {
                plan = planControlAction(db.memory, application, req.body.action);
            } catch (error) {
                return sendRouteError(error, req, res);
            }
            if (plan.unchanged) {
                if (plan.droppedLeftovers) await db.save();
                return res.json({ success: true, unchanged: true, ...forAccount(application, cls.onlineExamConfigs?.[application.examKey] || null), finish: null });
            }
            if (plan.resolve) {
                try {
                    processedFinish = resolveInProgressAttempts(db.memory, {
                        application,
                        onlineConfig: cls.onlineExamConfigs?.[application.examKey],
                        policy: req.body.inProgressPolicy,
                        actor: adminActor(req),
                    });
                } catch (error) {
                    if (!error.requiresInProgressPolicy) throw error;
                    return res.status(409).json({ error: error.message, requiresInProgressPolicy: true, summary: error.summary });
                }
            }
            try {
                transitionExamApplication(application, req.body.action, {
                    actor: adminActor(req),
                    waitingRoomDuration: req.body.waitingRoomDuration,
                    adjustmentSeconds: req.body.adjustmentSeconds,
                });
            } catch (error) {
                return sendRouteError(error, req, res);
            }
            if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
            if (!cls.releasedItems) cls.releasedItems = {};
            cls.onlineExamConfigs[application.examKey] = applicationToOnlineConfig(application, cls.onlineExamConfigs[application.examKey] || {});
            const active = ACTIVE_APPLICATION_STATUSES.has(application.status);
            cls.releasedItems[application.examKey] = active;
            cls.activeExamKey = active ? application.examKey : (cls.activeExamKey === application.examKey ? null : cls.activeExamKey);
            cls.activeApplicationId = active ? application.id : (cls.activeApplicationId === application.id ? null : cls.activeApplicationId);
            // Encerrada, a aplicação não reabre mais entrega: as cópias das tentativas saem.
            const droppedSnapshots = active ? 0 : dropReopenSnapshots(db.memory, application.id);
            // Encerrar com tentativas em andamento resolve entregas (algumas já existiam), e
            // tirar as cópias muda entregas antigas: gravação completa. As outras
            // transições, parcial.
            await saveApplicationAction({ full: !!plan.resolve || droppedSnapshots > 0 });
            res.json({ success: true, ...forAccount(application, cls.onlineExamConfigs[application.examKey]), finish: processedFinish });
        });
    });

    router.post('/api/admin/exam-applications/:applicationId/time-adjustment', (req, res) => {
        validateAdmin(req, res, async () => {
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            const adjustmentMinutes = Number(req.body.adjustmentMinutes);
            if (!Number.isFinite(adjustmentMinutes)) return res.status(400).json({ error: 'Ajuste de tempo inválido.' });
            const targetEmail = String(req.body.targetEmail || '').trim().toLowerCase();
            // Tempo extra para um aluno nunca ressuscita tentativa vencida: ela é entregue
            // antes do ajuste. No ajuste da turma, as entregas automáticas do fim do tempo de
            // até 2 min atrás voltam para a prova com o tempo extra (reopenDeadlineDeliveries).
            const settled = settleExpiredAttempts(db.memory, { applicationId: application.id, studentEmail: targetEmail || null, graceMs: 0 });
            if (targetEmail && settled.finalized.length) {
                await db.save();
                return res.status(409).json({
                    error: 'O tempo deste aluno já tinha terminado. A tentativa foi entregue automaticamente com as respostas salvas.',
                    attemptFinalized: true,
                });
            }
            if (targetEmail && deliveredWithoutAttemptsLeft(db.memory, application, targetEmail)) {
                return res.status(409).json({
                    error: 'Este aluno já entregou a prova. O tempo extra não tem efeito.',
                    alreadyDelivered: true,
                });
            }
            if (targetEmail) {
                Object.values(db.memory.studentExamState || {}).forEach(state => {
                    if (state && state.applicationId === application.id && state.studentEmail === targetEmail && !CLOSED_ATTEMPT_STATUSES.has(state.status)) {
                        state.individualTimeAdjustment = Number(state.individualTimeAdjustment || 0) + adjustmentMinutes;
                        if (state.deadlineAt) state.deadlineAt = Number(state.deadlineAt) + adjustmentMinutes * 60000;
                    }
                });
            } else {
                application.globalTimeAdjustment = Number(application.globalTimeAdjustment || 0) + adjustmentMinutes;
                const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
                if (cls?.onlineExamConfigs?.[application.examKey]) {
                    cls.onlineExamConfigs[application.examKey] = applicationToOnlineConfig(application, cls.onlineExamConfigs[application.examKey]);
                }
            }
            const reopened = !targetEmail && adjustmentMinutes > 0
                ? reopenDeadlineDeliveries(db.memory, application, { actor: adminActor(req), extraMinutes: adjustmentMinutes })
                : null;
            application.updatedAt = new Date().toISOString();
            application.updatedBy = adminActor(req);
            // Tentativa vencida entregue agora ou entrega do fim do tempo devolvida à prova
            // mexem em entregas: gravação completa. O "+N min" sozinho, parcial.
            await saveApplicationAction({ full: !!settled.changed || !!(reopened && reopened.reopened.length) });
            // Ajuste da turma: quem voltou para a prova com o tempo extra e quem já tinha
            // entregue e ficou sem ele.
            if (targetEmail) return res.json({ success: true, application: withoutSealedToken(application), deliveredAtDeadline: 0 });
            res.json({
                success: true,
                application: withoutSealedToken(application),
                reopenedAtDeadline: reopened ? reopened.reopened.length : 0,
                reopenedLocked: reopened ? reopened.reopenedLocked : 0,
                deliveredAtDeadline: reopened ? reopened.deadlineKept : settled.finalized.length,
                deliveredAtDeadlineTooShort: reopened ? reopened.extraTooShort : 0,
                deliveredByStudent: reopened ? reopened.manualKept : 0,
                nextAttemptStarted: reopened ? reopened.nextAttemptStarted : 0,
            });
        });
    });

    // Ações por aluno no Monitor (P3-S8: AVA-14; D18 do P3). { action, studentEmail, motivo,
    // extraAttempts }:
    // - recolher: entrega a tentativa em andamento com as respostas salvas no servidor
    //   (source 'instructor_collect'); a tentativa vencida é entregue pelo fim do tempo (409
    //   attemptFinalized, como no ajuste de tempo);
    // - reabrir (motivo obrigatório): a entrega mais recente volta para a mesma tentativa,
    //   com as respostas e o tempo que faltava (reopenDeliveryByInstructor, examDeadline.js);
    //   não conta de novo no limite; só com a aplicação em andamento;
    // - tentativa_extra: soma extraAttempts (1 por padrão) às tentativas extras do aluno
    //   (studentOverrides, D16; até 5 no total), com o mesmo registro do "Para quem".
    // Todas: aplicação da turma da conta (403), aluno da turma (404), turma aberta
    // (assertClassOpen: recolher e reabrir mexem em nota) e auditoria na mesma gravação;
    // recolher e reabrir vão também para o registro do monitoramento (proctoringLogs).
    router.post('/api/admin/exam-applications/:applicationId/attempt-action', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!ATTEMPT_ACTION_SCHEMA.check(req, res)) return;
            // Quem só acompanha pelo Monitor (page.monitor sem page.exams, como o Professor
            // auxiliar) recebe a aplicação sem as versões (gabarito), como na lista e no
            // /control (B1 + A4, junção J1).
            const withAnswerKeys = canReadExamVersions(matchedAdmin);
            const applicationForAccount = application => (withAnswerKeys ? withoutSealedToken(application) : applicationSummary(application));
            const action = String(req.body.action || '').trim().toLowerCase();
            if (!ATTEMPT_ACTIONS.includes(action)) {
                return res.status(400).json({ success: false, error: 'Ação inválida. Use recolher, reabrir, tentativa_extra, anular ou desfazer_anulacao.', field: 'action' });
            }
            const application = findExamApplication(db.memory.examApplications, req.params.applicationId);
            if (!application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
            if (!canManageApplication(matchedAdmin, application)) {
                return res.status(403).json({ error: 'A turma desta aplicação não está atribuída a esta conta.' });
            }
            const cls = findClassByNameAndCourse(db.memory.classes || [], application.studentClass, application.courseId);
            if (!cls) return res.status(404).json({ error: 'Turma da aplicação não encontrada.' });
            const email = normalizeEmail(req.body.studentEmail);
            const student = (db.memory.students || []).find(item => item && normalizeEmail(item.email) === email) || null;
            if (!student || !studentInClass(student, cls.name, cls.courseId)) {
                return res.status(404).json({ error: 'Aluno não encontrado nesta turma.', field: 'studentEmail' });
            }
            const motivo = String(req.body.motivo || '').trim();
            if (action === 'reabrir' && !motivo) {
                return res.status(400).json({ success: false, error: 'Informe o motivo para reabrir a prova do aluno.', field: 'motivo' });
            }
            // Anular e desfazer mexem na nota: o motivo vai para a Auditoria (o aluno não o vê).
            if ((action === 'anular' || action === 'desfazer_anulacao') && motivo.length < ATTEMPT_ACTION_REASON_MIN) {
                return res.status(400).json({
                    success: false,
                    error: action === 'anular'
                        ? 'Informe o motivo da anulação (pelo menos 3 letras). Ele fica na Auditoria.'
                        : 'Informe o motivo para desfazer a anulação (pelo menos 3 letras). Ele fica na Auditoria.',
                    field: 'motivo',
                });
            }
            if (!assertClassOpen(cls, { res })) return;
            const actor = adminActor(req);
            const now = Date.now();

            if (action === 'recolher') {
                if (!ACTIVE_APPLICATION_STATUSES.has(application.status)) {
                    return attemptActionRefusal(res, 409, 'application_not_running', 'A prova não está em andamento: não há tentativa para recolher.');
                }
                // A tentativa vencida é entregue pelo fim do tempo, como sempre.
                const settled = settleExpiredAttempts(db.memory, { applicationId: application.id, studentEmail: email, graceMs: 0 });
                if (settled.finalized.length) {
                    await db.save();
                    return attemptActionRefusal(res, 409, 'attempt_finalized', 'O tempo deste aluno já tinha terminado. A tentativa foi entregue automaticamente com as respostas salvas.', { attemptFinalized: true });
                }
                const open = findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail: email });
                if (!open || !(Number(open.state.startedAt) > 0)) {
                    return attemptActionRefusal(res, 409, 'no_open_attempt', 'Este aluno não está fazendo a prova agora: não há tentativa para recolher.');
                }
                const { deadlineAt } = attemptOverdueMs(open.state, application, now);
                const submission = finalizeAttemptState(db.memory, {
                    key: open.key,
                    state: open.state,
                    application,
                    now,
                    deadlineAt,
                    source: INSTRUCTOR_COLLECT_SOURCE,
                });
                if (!submission) {
                    await saveApplicationAction();
                    return attemptActionRefusal(res, 409, 'already_delivered', 'Esta tentativa já tinha sido entregue.');
                }
                submission.collectedBy = actor;
                submission.collectedAt = new Date(now).toISOString();
                recordExamAudit('exam_attempt_collected', application, actor, {
                    attemptId: submission.attemptId || null,
                    attemptNumber: submission.attemptNumber || null,
                    submissionId: submission.id,
                    answeredCount: submission.answeredCount,
                    ...(motivo ? { motivo } : {}),
                }, { studentEmail: email });
                pushAttemptLog(application, email, submission.attemptId, 'attempt_collected', 'Prova recolhida pelo professor com as respostas salvas');
                application.updatedAt = new Date(now).toISOString();
                application.updatedBy = actor;
                await saveApplicationAction();
                return res.json({
                    success: true,
                    action,
                    application: applicationForAccount(application),
                    submission: { id: submission.id, attemptId: submission.attemptId, attemptNumber: submission.attemptNumber, answeredCount: submission.answeredCount },
                });
            }

            if (action === 'reabrir') {
                // Tentativa vencida que ainda não virou entrega vira entrega antes (é ela que
                // reabre, se o tempo que faltava permitir).
                const settled = settleExpiredAttempts(db.memory, { applicationId: application.id, studentEmail: email, graceMs: 0 });
                const reopened = reopenDeliveryByInstructor(db.memory, application, email, { now, actor });
                if (!reopened.ok) {
                    if (settled.changed) await db.save();
                    return attemptActionRefusal(res, 409, reopened.code, reopened.error);
                }
                const minutes = reopened.remainingMs === null ? null : Math.round(reopened.remainingMs / 60000);
                recordExamAudit('exam_attempt_reopened_by_instructor', application, actor, {
                    attemptId: reopened.state.attemptId || null,
                    attemptNumber: reopened.state.attemptNumber || null,
                    submissionId: reopened.submission.id,
                    submissionSource: reopened.submission.submissionSource || null,
                    motivo,
                    minutosRestantes: minutes,
                    minutosAcrescentados: reopened.addedMinutes,
                    newDeadlineAt: reopened.state.deadlineAt || null,
                    answeredCount: Number(reopened.submission.answeredCount || 0),
                    score: reopened.submission.score ?? null,
                    ...(reopened.discardedNext.length ? { discardedNextAttempts: reopened.discardedNext } : {}),
                }, { studentEmail: email });
                pushAttemptLog(application, email, reopened.state.attemptId, 'attempt_reopened',
                    minutes === null ? 'Tentativa reaberta pelo professor' : `Tentativa reaberta pelo professor com ${minutes} min`);
                application.updatedAt = new Date(now).toISOString();
                application.updatedBy = actor;
                // A entrega saiu da lista (linha que já existia): gravação completa.
                await saveApplicationAction({ full: true });
                return res.json({
                    success: true,
                    action,
                    application: applicationForAccount(application),
                    state: {
                        attemptId: reopened.state.attemptId,
                        attemptNumber: reopened.state.attemptNumber,
                        deadlineAt: reopened.state.deadlineAt || null,
                        focusLocked: reopened.state.focusLocked === true,
                        remainingMinutes: minutes,
                        addedMinutes: reopened.addedMinutes,
                    },
                });
            }

            if (action === 'anular' || action === 'desfazer_anulacao') {
                return invalidationAction({ req, res, action, application, cls, email, student, motivo, actor, now, matchedAdmin, applicationForAccount });
            }

            // tentativa_extra
            if (['finished', 'cancelled'].includes(application.status)) {
                return attemptActionRefusal(res, 409, 'application_closed', 'Esta aplicação já foi encerrada: a tentativa extra não teria efeito. Prepare uma nova aplicação (por exemplo, a segunda chamada).', { applicationClosed: true });
            }
            const configMaxAttempts = cls.onlineExamConfigs?.[application.examKey]?.maxAttempts;
            if (effectiveMaxAttempts(application, email, configMaxAttempts) === null) {
                return attemptActionRefusal(res, 409, 'unlimited_attempts', 'Esta aplicação não tem limite de tentativas: não é preciso dar tentativa extra.');
            }
            // Aluno desligado (ou bloqueado) não ganha tentativa: é a mesma regra do "Para quem".
            if (!activeStudent(student)) {
                return attemptActionRefusal(res, 409, 'student_inactive', `${displayName(student) || email} está com o cadastro ${String(student.status || '').trim() || 'encerrado'}: a tentativa extra é só para aluno ativo da turma.`);
            }
            if (!applicationParticipant(application, email)) {
                return attemptActionRefusal(res, 409, 'not_participant', 'Este aluno não está na lista desta aplicação. Inclua-o em "Alunos desta aplicação" antes.');
            }
            const add = req.body.extraAttempts === undefined || req.body.extraAttempts === null ? 1 : Number(req.body.extraAttempts);
            const overrides = application.studentOverrides && typeof application.studentOverrides === 'object' && !Array.isArray(application.studentOverrides)
                ? application.studentOverrides
                : {};
            const before = JSON.parse(JSON.stringify(overrides));
            const ownKey = Object.keys(overrides).find(key => normalizeEmail(key) === email);
            const previous = ownKey !== undefined && overrides[ownKey] && typeof overrides[ownKey] === 'object' ? overrides[ownKey] : null;
            const currentExtra = previous && Number.isInteger(Number(previous.extraAttempts)) ? Math.max(0, Number(previous.extraAttempts)) : 0;
            if (currentExtra + add > MAX_EXTRA_ATTEMPTS) {
                return attemptActionRefusal(res, 409, 'extra_limit', `Este aluno já tem ${currentExtra} ${currentExtra === 1 ? 'tentativa extra' : 'tentativas extras'}; o máximo é ${MAX_EXTRA_ATTEMPTS}.`);
            }
            const next = {
                ...(previous || {}),
                extraAttempts: currentExtra + add,
                prazoAte: previous && Number(previous.prazoAte) > 0 ? Number(previous.prazoAte) : null,
                motivo: (motivo || (previous && previous.motivo) || '').slice(0, 300),
                por: actor,
                em: now,
            };
            const nextOverrides = { ...overrides };
            if (ownKey !== undefined && ownKey !== email) delete nextOverrides[ownKey];
            nextOverrides[email] = next;
            application.studentOverrides = nextOverrides;
            application.updatedAt = new Date(now).toISOString();
            application.updatedBy = actor;
            recordAudienceAudit(application, actor, { before: { studentOverrides: before } });
            await db.save({ only: ['examApplications', 'auditLogs'] });
            return res.json({
                success: true,
                action,
                application: applicationForAccount(application),
                extraAttempts: next.extraAttempts,
                maxAttempts: effectiveMaxAttempts(application, email, configMaxAttempts),
            });
        });
    });

    router.get('/api/admin/question-reports/:class/:examKey', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            try {
                // O gabarito da questão contestada vai para quem corrige a questão
                // (page.results) ou prepara a prova (page.exams). Quem só acompanha a prova
                // (Professor auxiliar, page.monitor) vê o enunciado e as alternativas, sem a
                // correta (B1, papel "sem notas").
                const withAnswerKey = canReadQuestionAnswerKey(matchedAdmin);
                const { application } = applicationForAdminRequest(req.query.applicationId);
                if (application.studentClass.toLowerCase() !== String(req.params.class || '').trim().toLowerCase()
                    || application.examKey !== String(req.params.examKey || '').trim()) {
                    return res.status(404).json({ error: 'Aplicação não encontrada para a turma e prova informadas.' });
                }
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicação fora do escopo desta conta.' });
                }
                const openReports = (application.questionReports || []).filter(report => report.status === 'open');
                const byQuestion = new Map();
                openReports.forEach(report => {
                    const number = Number(report.questionNumber);
                    if (!byQuestion.has(number)) byQuestion.set(number, []);
                    byQuestion.get(number).push(report);
                });
                const groups = [...byQuestion.entries()].map(([number, reports]) => {
                    const reasons = {};
                    reports.forEach(report => { reasons[report.reason] = Number(reasons[report.reason] || 0) + 1; });
                    const version = reports[0]?.assignedVersion || 'A';
                    const fullQuestion = liveQuestion(application, number, version);
                    const question = withAnswerKey ? fullQuestion : questionWithoutAnswerKey(fullQuestion);
                    return {
                        questionNumber: number,
                        questionPosition: reports[0]?.questionPosition || null,
                        count: reports.length,
                        reasons,
                        reports,
                        question,
                        annulled: (application.annulledQuestions || []).some(item => Number(item.questionNumber) === number),
                    };
                }).sort((a, b) => a.questionNumber - b.questionNumber);
                res.json({
                    success: true,
                    applicationId: application.id,
                    totalOpen: openReports.length,
                    groups,
                    status: application.status,
                    finishSummary: finishSummary(application),
                    // Sem `config` (DES-04): levava as versões e o gabarito a cada 3 s e
                    // nenhuma tela o lia.
                });
            } catch (error) {
                return sendRouteError(error, req, res);
            }
        });
    });

    router.post('/api/admin/question-reports/resolve', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                const { application } = applicationForAdminRequest(req.body.applicationId);
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicação fora do escopo desta conta.' });
                }
                const reportIds = Array.isArray(req.body.reportIds) ? req.body.reportIds : null;
                const number = Number(req.body.questionNumber);
                if (!reportIds && !Number.isFinite(number)) return res.status(400).json({ error: 'Informe a questão ou as contestações.' });
                const updated = markQuestionReports(application, number, 'reviewed', adminActor(req), reportIds);
                recordExamAudit('exam_question_reports_reviewed', application, adminActor(req), { questionNumber: number, reportIds, updated });
                await db.save();
                res.json({ success: true, updated });
            } catch (error) {
                return sendRouteError(error, req, res);
            }
        });
    });

    router.post('/api/admin/correct-live-question', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                if (!LIVE_QUESTION_SCHEMA.check(req, res)) return;
                const { application, cls } = applicationForAdminRequest(req.body.applicationId);
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicação fora do escopo desta conta.' });
                }
                // Turma encerrada não tem gabarito corrigido nem nota recorrigida (sem efeito
                // até o B10).
                if (!assertClassOpen(cls, { res })) return;
                if (!['waiting', 'running', 'paused'].includes(application.status)) {
                    return res.status(409).json({ error: 'A aplicação precisa estar ativa para corrigir a questão ao vivo.' });
                }
                const number = Number(req.body.questionNumber);
                const normalized = normalizeLiveQuestion(req.body.question || {}, resolvedLiveQuestion(application, number));
                let updatedSnapshots = 0;
                (application.versionSnapshots || []).forEach(snapshot => {
                    snapshot.questions = (snapshot.questions || []).map((question, index) => {
                        if (questionNumber(question, index) !== number) return question;
                        updatedSnapshots += 1;
                        const corrected = correctedVersionQuestion(question, normalized, number);
                        // Gabarito impresso da versão (letra da posição) acompanha a correção.
                        // Várias corretas: as letras impressas das certas, juntas ('AC').
                        if (snapshot.answerKey && typeof snapshot.answerKey === 'object') {
                            const position = Number(question.examNumber) > 0 ? Number(question.examNumber) : index + 1;
                            const correct = corrected.alternatives.filter(alternative => alternative.isCorrect);
                            if (correct.length) snapshot.answerKey[position] = correct.map(alternative => alternative.displayLetter).join('');
                        }
                        return corrected;
                    });
                });
                if (updatedSnapshots === 0) return res.status(404).json({ error: 'Questão não encontrada nesta aplicação.' });
                application.updatedAt = new Date().toISOString();
                markQuestionReports(application, number, 'corrected', adminActor(req));
                const onlineConfig = syncApplicationConfig(cls, application);
                const regraded = regradeApplicationSubmissions(application, cls, { req, reason: `correção da questão ${number} durante a aplicação` });
                pushExamMessage(application, adminActor(req), `A questão ${number} foi corrigida pelo professor. Revise o enunciado e as alternativas antes de enviar.`);
                recordExamAudit('exam_question_corrected_live', application, adminActor(req), { questionNumber: number, regraded });
                await db.save();
                res.json({ success: true, question: liveQuestion(application, number), regraded, config: onlineConfig });
            } catch (error) {
                return sendRouteError(error, req, res);
            }
        });
    });

    router.post('/api/admin/annul-question', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                const { application, cls } = applicationForAdminRequest(req.body.applicationId);
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicação fora do escopo desta conta.' });
                }
                // Turma encerrada não tem questão anulada nem nota recorrigida (sem efeito até
                // o B10).
                if (!assertClassOpen(cls, { res })) return;
                const number = Number(req.body.questionNumber);
                const mode = req.body.mode === 'ponto_para_todos' ? 'ponto_para_todos' : 'remover_do_total';
                if (!liveQuestion(application, number)) return res.status(404).json({ error: 'Questão não encontrada nesta aplicação.' });
                if (!Array.isArray(application.annulledQuestions)) application.annulledQuestions = [];
                const existing = application.annulledQuestions.find(item => Number(item.questionNumber) === number);
                const entry = {
                    questionNumber: number,
                    mode,
                    reason: String(req.body.reason || '').trim(),
                    by: adminActor(req),
                    at: new Date().toISOString(),
                };
                if (existing) Object.assign(existing, entry);
                else application.annulledQuestions.push(entry);
                application.updatedAt = entry.at;
                markQuestionReports(application, number, 'annulled', adminActor(req));
                const onlineConfig = syncApplicationConfig(cls, application);
                // O motivo digitado pelo professor vai junto para o histórico da nota (AVA-08).
                const modeLabel = mode === 'ponto_para_todos' ? 'ponto para todos' : 'removida do total';
                const regraded = regradeApplicationSubmissions(application, cls, {
                    req,
                    reason: `anulação da questão ${number} (${modeLabel})${entry.reason ? ` · motivo: ${entry.reason}` : ''}`,
                });
                pushExamMessage(application, adminActor(req), `A questão ${number} foi anulada pelo professor e não prejudicará sua nota.`);
                recordExamAudit('exam_question_annulled', application, adminActor(req), { ...entry, regraded });
                await db.save();
                res.json({ success: true, annulment: entry, regraded, config: onlineConfig });
            } catch (error) {
                return sendRouteError(error, req, res);
            }
        });
    });

    router.post('/api/admin/replace-question', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                const { application, cls } = applicationForAdminRequest(req.body.applicationId);
                if (!adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId)) {
                    return res.status(403).json({ error: 'Aplicação fora do escopo desta conta.' });
                }
                // Turma encerrada não tem questão trocada nem nota recorrigida (sem efeito até
                // o B10).
                if (!assertClassOpen(cls, { res })) return;
                if (application.status !== 'running') {
                    return res.status(409).json({ error: 'A prova precisa estar em andamento para substituir uma questão.' });
                }
                // Tentativas já vencidas são entregues antes: o tempo extra não as reabre.
                settleExpiredAttempts(db.memory, { applicationId: application.id, graceMs: 0 });
                const activeStates = applicationStateEntries(application.id).map(([, state]) => state).filter(state => state.startedAt);
                const remainingValues = activeStates
                    .filter(state => Number(state.deadlineAt) > 0)
                    .map(state => Math.max(0, Math.ceil((Number(state.deadlineAt) - Date.now()) / 1000)));
                if (remainingValues.length && Math.min(...remainingValues) < 300) {
                    return res.status(409).json({ error: 'Não é possível substituir: um ou mais alunos têm menos de 5 minutos restantes.' });
                }
                const originalNumber = Number(req.body.questionNumber);
                if (!liveQuestion(application, originalNumber)) return res.status(404).json({ error: 'Questão original não encontrada.' });
                const bank = (db.memory.questionBank || []).find(question => question && question.key === req.body.bankQuestionKey);
                if (!bank) return res.status(404).json({ error: 'Questão do banco não encontrada.' });
                const extraMinutes = Math.max(0, Math.min(30, Number(req.body.extraMinutes) || 0));
                const allNumbers = (application.versionSnapshots || []).flatMap(snapshot =>
                    (snapshot.questions || []).map((question, index) => questionNumber(question, index)).filter(Number.isFinite));
                const replacementNumber = Math.max(0, ...allNumbers) + 1;
                // A questão do banco inteira, pelo modelo (P3-S9a): tipo, pontos, gabarito do
                // tipo e explicação; antes ia só o enunciado, as alternativas e a letra.
                const replacement = normalizeLiveQuestion(bankItemQuestion(bank));
                (application.versionSnapshots || []).forEach(snapshot => {
                    if (!Array.isArray(snapshot.questions)) snapshot.questions = [];
                    snapshot.questions.push({
                        ...replacement,
                        originalNumber: replacementNumber,
                        examNumber: snapshot.questions.length + 1,
                        alternatives: replacement.alternatives.map(alternative => ({ ...alternative, displayLetter: alternative.letter })),
                        isAdditional: true,
                        replacedQuestionNumber: originalNumber,
                        sourceBankKey: bank.key,
                    });
                });
                if (!Array.isArray(application.annulledQuestions)) application.annulledQuestions = [];
                if (!application.annulledQuestions.some(item => Number(item.questionNumber) === originalNumber)) {
                    application.annulledQuestions.push({
                        questionNumber: originalNumber,
                        mode: 'remover_do_total',
                        reason: 'Questão substituída durante a aplicação.',
                        by: adminActor(req),
                        at: new Date().toISOString(),
                    });
                }
                const perStudentDraw = examDraw.isPerStudentDraw(application);
                applicationStateEntries(application.id).forEach(([, state]) => {
                    // Sorteio por aluno (P3-S11): a questão nova vai só para quem tirou a trocada;
                    // a tentativa ainda sem sorteio recebe a nova quando sortear.
                    if (perStudentDraw) {
                        if (Array.isArray(state.assignedQuestionNumbers)
                            && state.assignedQuestionNumbers.map(Number).includes(originalNumber)
                            && !state.assignedQuestionNumbers.map(Number).includes(replacementNumber)) {
                            state.assignedQuestionNumbers.push(replacementNumber);
                        }
                    } else {
                        if (!Array.isArray(state.assignedQuestionNumbers)) state.assignedQuestionNumbers = [];
                        if (!state.assignedQuestionNumbers.includes(replacementNumber)) state.assignedQuestionNumbers.push(replacementNumber);
                    }
                    if (extraMinutes > 0 && Number(state.deadlineAt) > 0) state.deadlineAt += extraMinutes * 60000;
                });
                // No sorteio por aluno o total é por tentativa (quem tirou a trocada ganha uma).
                if (!perStudentDraw) application.questionCount = Number(application.questionCount || 0) + 1;
                application.globalTimeAdjustment = Number(application.globalTimeAdjustment || 0) + extraMinutes;
                application.updatedAt = new Date().toISOString();
                markQuestionReports(application, originalNumber, 'replaced', adminActor(req));
                const onlineConfig = syncApplicationConfig(cls, application);
                const regraded = regradeApplicationSubmissions(application, cls, { req, reason: `troca da questão ${originalNumber}` });
                pushExamMessage(application, adminActor(req), `A questão ${originalNumber} foi anulada e uma questão adicional foi inserida no final da prova.${extraMinutes ? ` Foram acrescentados ${extraMinutes} minutos.` : ''}`);
                recordExamAudit('exam_question_replaced', application, adminActor(req), {
                    questionNumber: originalNumber,
                    replacementNumber,
                    bankQuestionKey: bank.key,
                    extraMinutes,
                    regraded,
                });
                await db.save();
                res.json({ success: true, replacementNumber, extraMinutes, regraded, config: onlineConfig });
            } catch (error) {
                return sendRouteError(error, req, res);
            }
        });
    });

    // A preparação de onde a aplicação saiu e o que mais saiu dela (P3-S6). entry: a
    // entrada de classes[].examHistory[prova][] (a segunda chamada e "Imprimir" saem dela);
    // pending: as aplicações dela que ainda não começaram (guardam o gabarito de quando
    // foram preparadas); started: as outras que já começaram (cada uma tem as notas dela e
    // é corrigida pelo botão dela).
    function preparationOf(cls, application) {
        const historyId = application.historyId || null;
        const history = historyId && Array.isArray(cls.examHistory?.[application.examKey]) ? cls.examHistory[application.examKey] : [];
        const entry = history.find(item => item && item.id === historyId) || null;
        const siblings = historyId
            ? (db.memory.examApplications || []).filter(other => other && other.id !== application.id
                && other.historyId === historyId
                && other.examKey === application.examKey
                && other.studentClass === application.studentClass
                && String(other.courseId || '') === String(application.courseId || ''))
            : [];
        return {
            entry,
            pending: siblings.filter(other => other.status === 'draft' || other.status === 'prepared'),
            started: siblings.filter(other => CORRECTABLE_STATUSES.has(other.status)),
        };
    }

    // O que a correção muda além da aplicação: a preparação (se ainda não tem o gabarito
    // novo), as aplicações dela não começadas e quantas outras já começadas continuam com
    // o gabarito antigo (a tela avisa).
    function preparationImpact(cls, application, number, key) {
        const { entry, pending, started } = preparationOf(cls, application);
        const stale = other => {
            const question = resolvedLiveQuestion(other, number);
            return !!question && questionType(question) === key.type && !sameAnswerKey(answerKeyOf(question), key);
        };
        return {
            entry: entry && !preparationHasAnswerKey(entry, number, key) ? entry : null,
            pending: pending.filter(stale),
            otherStarted: started.filter(stale).length,
        };
    }

    // Grava o gabarito novo na preparação e nas aplicações dela ainda não começadas (a
    // configuração da turma acompanha a que é dela). Muda no lugar.
    function applyPreparationImpact(cls, impact, number, key, at) {
        if (impact.entry) applyAnswerKeyToPreparation(impact.entry, number, key);
        impact.pending.forEach(other => {
            applyAnswerKey(other, number, key);
            other.updatedAt = at;
            if (cls.onlineExamConfigs?.[other.examKey]?.applicationId === other.id) syncApplicationConfig(cls, other);
        });
    }

    function preparationSummary(impact) {
        return {
            atualizada: !!impact.entry,
            preparadas: impact.pending.length,
            outrasAplicacoes: impact.otherStarted,
        };
    }

    // Corrigir o gabarito depois da prova (P3-S6: AVA-X2; D14 do P3). O caso típico: um
    // aluno reclama depois do encerramento e a letra certa era outra. Vale com a prova em
    // andamento ou encerrada (cancelada: 409; antes de começar, a questão se corrige no
    // editor), muda só o gabarito da questão nas versões da aplicação (o texto e a ordem
    // ficam), recorrige todas as entregas (nota anterior no scoreHistory com o motivo e
    // grade_regrade por aluno), registra exam_answer_key_corrected e avisa no sino quem
    // tinha a nota publicada e teve a nota mudada. A preparação de onde a aplicação saiu e
    // as aplicações dela ainda não começadas recebem o mesmo gabarito (reaplicar a
    // preparação, como na segunda chamada, não traz a letra errada de volta). dryRun: a
    // prévia do impacto, sem gravar.
    // Repetir a mesma correção não muda nada. assertClassOpen antes de gravar (sem efeito
    // até o B10). page.results pelo guarda (o professor auxiliar não muda nota).
    router.post('/api/admin/exam-applications/:applicationId/answer-key-correction', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                if (!ANSWER_KEY_CORRECTION_SCHEMA.check(req, res)) return;
                const { application, cls } = applicationForAdminRequest(req.params.applicationId);
                if (!canManageApplication(matchedAdmin, application)) {
                    return res.status(403).json({ error: 'Aplicação fora do escopo desta conta.' });
                }
                // Turma encerrada não tem gabarito corrigido nem nota recorrigida (sem efeito
                // até o B10).
                if (!assertClassOpen(cls, { res })) return;
                if (application.status === 'cancelled') {
                    return res.status(409).json({ error: 'Esta aplicação foi cancelada: não há nota para corrigir.', code: 'application_cancelled' });
                }
                if (!CORRECTABLE_STATUSES.has(application.status)) {
                    // A aplicação preparada guarda o gabarito de quando foi preparada: editar a
                    // avaliação não a muda. É preciso preparar de novo pelo editor ("Preparar e
                    // abrir monitor", que monta a prova da avaliação corrigida e substitui esta).
                    // "Aplicar online" da preparação não serve: copia os versionSnapshots
                    // guardados nela, com a letra errada. Se outra aplicação da mesma
                    // preparação já começou, corrigir por ela leva a resposta certa também a
                    // esta (applyAnswerKeyToPreparation e as preparadas).
                    const startedSibling = preparationOf(cls, application).started.length > 0;
                    return res.status(409).json({
                        error: startedSibling ? `${APPLICATION_NOT_STARTED_MESSAGE} ${APPLICATION_NOT_STARTED_SIBLING_HINT}` : APPLICATION_NOT_STARTED_MESSAGE,
                        code: 'application_not_started',
                    });
                }
                const number = Number(req.body.questionNumber);
                if (!Number.isInteger(number) || number < 1) return res.status(400).json({ error: 'Escolha a questão.', field: 'questionNumber' });
                const motivo = String(req.body.motivo || '').trim();
                if (motivo.length < ANSWER_KEY_MOTIVO_MIN) {
                    return res.status(400).json({ error: `Escreva o motivo da correção (pelo menos ${ANSWER_KEY_MOTIVO_MIN} caracteres).`, field: 'motivo' });
                }
                const previous = resolvedLiveQuestion(application, number);
                if (!previous) return res.status(404).json({ error: 'Questão não encontrada nesta aplicação.' });
                if (questionWasReplaced(application, number)) {
                    return res.status(409).json({
                        error: `A questão ${number} foi trocada durante a aplicação: corrija a questão que entrou no lugar dela.`,
                        code: 'question_replaced',
                    });
                }
                const key = normalizeAnswerKey(previous, req.body);
                const annulment = annulmentOf(application, number);
                const removeAnnulment = !!annulment && req.body.tirarAnulacao === true;
                if (annulment && !removeAnnulment) {
                    return res.status(409).json({
                        error: `A questão ${number} está anulada nesta aplicação (${annulmentModeLabel(annulment)}), e a anulação vale por cima do gabarito. Para corrigir pelo gabarito novo, tire a anulação.`,
                        code: 'question_annulled',
                        annulment: { mode: annulment.mode, reason: annulment.reason || '' },
                    });
                }
                const before = answerKeyOf(previous);
                const question = {
                    number,
                    type: key.type,
                    antes: describeAnswerKey(before, previous),
                    depois: describeAnswerKey(key, previous),
                };
                const impact = preparationImpact(cls, application, number, key);
                if (sameAnswerKey(before, key) && !removeAnnulment) {
                    // A aplicação já tem o gabarito (por exemplo, corrigido ao vivo no
                    // Monitor), mas a preparação ou uma aplicação dela não começada ainda não:
                    // grava só nelas, sem recorrigir ninguém.
                    const syncPreparation = !!impact.entry || impact.pending.length > 0;
                    if (syncPreparation && req.body.dryRun !== true) {
                        const at = new Date().toISOString();
                        applyPreparationImpact(cls, impact, number, key, at);
                        recordExamAudit('exam_answer_key_corrected', application, adminActor(req), {
                            questionNumber: number,
                            tipo: key.type,
                            antes: question.antes,
                            depois: question.depois,
                            motivo,
                            regraded: 0,
                            changed: 0,
                            notifiedStudents: 0,
                            somentePreparacao: true,
                            preparacaoAtualizada: !!impact.entry,
                            preparadasAtualizadas: impact.pending.length,
                        });
                        await db.save();
                    }
                    return res.json({
                        success: true,
                        unchanged: true,
                        dryRun: req.body.dryRun === true,
                        question,
                        regraded: 0,
                        changed: 0,
                        notifiedStudents: 0,
                        preparacao: preparationSummary(impact),
                        message: syncPreparation
                            ? `O gabarito da questão ${number} já é este nesta aplicação: nenhuma nota muda. ${req.body.dryRun === true ? 'A preparação vai passar' : 'A preparação passou'} a usar este gabarito também.`
                            : `O gabarito da questão ${number} já é este: nenhuma nota muda.`,
                    });
                }
                const evaluation = db.memory.evaluations?.[application.examKey] || null;
                const withoutAnnulment = target => {
                    target.annulledQuestions = (Array.isArray(target.annulledQuestions) ? target.annulledQuestions : [])
                        .filter(entry => Number(entry?.questionNumber) !== number);
                    return target;
                };

                if (req.body.dryRun === true) {
                    const draft = removeAnnulment ? withoutAnnulment({ ...application }) : application;
                    const preview = previewAnswerKeyRegrade({
                        application: draft,
                        submissions: db.memory.submissions || [],
                        onlineConfig: onlineConfigForApplication(cls, application),
                        evaluation,
                        number,
                        key,
                    });
                    const students = preview.changes
                        .map(change => ({
                            submissionId: change.submission.id,
                            name: displayName(change.submission.student || {}) || change.submission.student?.email || 'Aluno',
                            from: change.from,
                            to: change.to,
                            published: change.submission.gradePublished === true,
                        }))
                        .sort((a, b) => compareText(a.name, b.name));
                    return res.json({
                        success: true,
                        dryRun: true,
                        question,
                        tirarAnulacao: removeAnnulment,
                        regraded: preview.regraded,
                        changed: students.length,
                        published: students.filter(student => student.published).length,
                        students: students.slice(0, ANSWER_KEY_PREVIEW_LIMIT),
                        preparacao: preparationSummary(impact),
                    });
                }

                const actor = adminActor(req);
                const at = new Date().toISOString();
                applyAnswerKey(application, number, key);
                if (removeAnnulment) withoutAnnulment(application);
                application.updatedAt = at;
                // A preparação e as aplicações dela não começadas também (a segunda chamada,
                // a tela de detalhe e "Imprimir" saem dela). As já começadas, não: cada uma
                // tem as notas dela.
                applyPreparationImpact(cls, impact, number, key, at);
                markQuestionReports(application, number, 'corrected', actor);
                // A configuração da turma acompanha só quando é a desta aplicação (outra pode
                // ter sido preparada depois do encerramento).
                const current = cls.onlineExamConfigs?.[application.examKey];
                if (current && current.applicationId === application.id) syncApplicationConfig(cls, application);
                const changedSubmissions = [];
                const reason = `gabarito da questão ${number} corrigido (${question.antes || '—'} → ${question.depois || '—'})`
                    + `${removeAnnulment ? ' e anulação retirada' : ''} · motivo: ${motivo}`;
                const regraded = regradeApplicationSubmissions(application, cls, { req, reason, changed: changedSubmissions });
                let notifiedStudents = 0;
                changedSubmissions.forEach(submission => {
                    if (markGradeChangeNotice(submission, { tipo: 'gabarito_corrigido', numeroNaProva: questionPositionInSubmission(submission, number) })) {
                        notifiedStudents += 1;
                    }
                });
                const correction = {
                    questionNumber: number,
                    tipo: key.type,
                    antes: question.antes,
                    depois: question.depois,
                    motivo,
                    por: actor,
                    em: at,
                    regraded,
                    changed: changedSubmissions.length,
                    notifiedStudents,
                    preparacaoAtualizada: !!impact.entry,
                    preparadasAtualizadas: impact.pending.length,
                    ...(removeAnnulment ? { tirouAnulacao: annulment.mode } : {}),
                };
                if (!Array.isArray(application.answerKeyCorrections)) application.answerKeyCorrections = [];
                application.answerKeyCorrections.push(correction);
                recordExamAudit('exam_answer_key_corrected', application, actor, {
                    questionNumber: number,
                    tipo: key.type,
                    antes: question.antes,
                    depois: question.depois,
                    motivo,
                    regraded,
                    changed: changedSubmissions.length,
                    notifiedStudents,
                    preparacaoAtualizada: !!impact.entry,
                    preparadasAtualizadas: impact.pending.length,
                    ...(removeAnnulment ? { tirouAnulacao: annulment.mode } : {}),
                });
                // Entrega antiga mudada: gravação completa (submissions é append; regra do
                // registro em database.js).
                await db.save();
                res.json({ success: true, question, regraded, changed: changedSubmissions.length, notifiedStudents, correction, preparacao: preparationSummary(impact) });
            } catch (error) {
                return sendRouteError(error, req, res);
            }
        });
    });

    router.post('/api/admin/exam-config', (req, res) => {
        validateAdmin(req, res, async () => {
            const { studentClass, courseId, examKey, questionCount, excludedQuestions, shuffleQuestions, shuffleAnswers } = req.body;
            if (!studentClass || !examKey) return res.status(400).json({ error: 'Turma ou chave da prova não informada.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            if (!cls.examConfigs) cls.examConfigs = {};
            cls.examConfigs[examKey] = {
                questionCount: parseInt(questionCount, 10) || 20,
                excludedQuestions: Array.isArray(excludedQuestions) ? excludedQuestions.map(Number) : [],
                shuffleQuestions: shuffleQuestions !== false,
                shuffleAnswers: shuffleAnswers !== false,
                updatedAt: new Date().toISOString(),
            };
            await persistClasses(classes);
            res.json({ success: true, examConfigs: cls.examConfigs, examConfig: cls.examConfigs[examKey] });
        });
    });

    router.post('/api/admin/online-exam-config', (req, res) => {
        validateAdmin(req, res, async () => {
            const { studentClass, courseId, examKey, questionCount, excludedQuestions, shuffleQuestions, shuffleAnswers, durationMinutes, timerEnabled, maxAttempts } = req.body;
            if (!studentClass || !examKey) return res.status(400).json({ error: 'Turma ou chave da prova não informada.' });
            const parsedMaxAttempts = parseMaxAttempts(Object.prototype.hasOwnProperty.call(req.body || {}, 'maxAttempts')
                ? maxAttempts
                : DEFAULT_MAX_ATTEMPTS);
            if (!parsedMaxAttempts.valid) return res.status(400).json({ error: 'Tentativas deve ser um número entre 1 e 10.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            // Reconfigurar a prova trocaria a versão da configuração e zeraria as
            // tentativas de quem está fazendo a prova: só depois de encerrada (AVA-04).
            const running = activeExamApplication(db.memory, { studentClass: cls.name, courseId: cls.courseId, examKey });
            if (running) {
                return res.status(409).json(activeApplicationConflict(running, 'Há uma aplicação em andamento desta prova nesta turma; encerre-a pelo Monitor antes de mudar a configuração.'));
            }
            if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
            const previousConfig = cls.onlineExamConfigs[examKey] || {};
            const updatedAt = new Date().toISOString();
            cls.onlineExamConfigs[examKey] = {
                ...previousConfig,
                questionCount: parseInt(questionCount, 10) || 20,
                excludedQuestions: Array.isArray(excludedQuestions) ? excludedQuestions.map(Number) : [],
                shuffleQuestions: shuffleQuestions !== false,
                shuffleAnswers: shuffleAnswers !== false,
                durationMinutes: parseInt(durationMinutes, 10) || DEFAULT_ONLINE_DURATION_MINUTES,
                timerEnabled: timerEnabled !== false,
                onlineActive: false,
                status: 'prepared',
                startTime: null,
                waitingRoomStartTimestamp: null,
                activeHistoryId: null,
                versionSnapshots: [],
                accessToken: normalizeExamToken(previousConfig.accessToken),
                maxAttempts: parsedMaxAttempts.value,
                preparedAt: updatedAt,
                updatedAt,
            };
            if (cls.activeExamKey === examKey) cls.activeExamKey = null;
            await persistClasses(classes);
            res.json({ success: true, onlineExamConfigs: cls.onlineExamConfigs, onlineExamConfig: cls.onlineExamConfigs[examKey] });
        });
    });

    router.post('/api/admin/release-item', (req, res) => {
        validateAdmin(req, res, async () => {
            if (!RELEASE_ITEM_SCHEMA.check(req, res)) return;
            const { studentClass, courseId, itemKey, released, studentEmail, historyId, applicationOptions } = req.body;
            if (!studentClass) return res.status(400).json({ error: 'Turma não informada.' });
            if (!itemKey) return res.status(400).json({ error: 'Chave do item não informada.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseItemKey(cls, itemKey)) return res.status(400).json({ error: 'Item não pertence ao curso da turma.' });

            const normalizedStudentEmail = (studentEmail || '').trim().toLowerCase();
            // '__proto__' como aluno gravava a liberação em Object.prototype: o gabarito
            // ficava liberado em todas as turmas, inclusive fora do escopo do professor.
            if (normalizedStudentEmail && isInheritedKey(normalizedStudentEmail)) {
                return res.status(400).json({ error: 'Aluno inválido.' });
            }
            const actor = adminActor(req);
            // Liberação agendada (P3-S12, D27): agendar ou cancelar não liga nem desliga
            // nada agora; a varredura do servidor libera na hora (utils/examSchedule.js).
            if (req.body.cancelSchedule === true || (req.body.releaseAtLocal !== undefined && req.body.releaseAtLocal !== null && req.body.releaseAtLocal !== '')) {
                return scheduleItemRelease(req, res, cls, String(itemKey), normalizedStudentEmail);
            }
            // Gabarito só é liberado pela chave própria e nunca enquanto a prova tem
            // aplicação preparada ou em andamento na turma (G2: gabarito na reaplicação).
            if (released && itemKey.startsWith('Gabarito_')) {
                const examApplication = openExamFamilyApplication(cls, itemKey.slice('Gabarito_'.length));
                if (examApplication) {
                    return res.status(409).json({
                        ...activeApplicationConflict(examApplication, 'Esta prova tem uma aplicação preparada ou em andamento nesta turma. Libere o gabarito depois de encerrá-la.'),
                        activeApplication: ACTIVE_APPLICATION_STATUSES.has(examApplication.status),
                    });
                }
            }
            let affectedApplication = null;
            if (normalizedStudentEmail) {
                if (!cls.studentReleasedItems) cls.studentReleasedItems = {};
                if (!cls.studentReleasedItems[normalizedStudentEmail]) cls.studentReleasedItems[normalizedStudentEmail] = {};
                cls.studentReleasedItems[normalizedStudentEmail][itemKey] = !!released;
            } else {
                if (!cls.releasedItems) cls.releasedItems = {};
                if (itemKey.startsWith('Avaliacao_')) {
                    if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
                    const previousConfig = cls.onlineExamConfigs[itemKey] || {};
                    const running = activeExamApplication(db.memory, { studentClass: cls.name, courseId: cls.courseId, examKey: itemKey });
                    if (released) {
                        if (running) {
                            // Liberar de novo (por exemplo, "Liberar tudo" em Materiais) não mexe
                            // na aplicação em andamento: nada é recriado nem zerado (AVA-X1).
                            if (historyId) return res.status(409).json(activeApplicationConflict(running));
                            return res.json({
                                success: true,
                                scope: 'class',
                                unchanged: true,
                                releasedItems: getReleasedItemsForClass(cls, ''),
                                application: running,
                            });
                        }
                        // A prova online só nasce de uma preparação explícita (Provas >
                        // Preparar, ou esta rota com a configuração salva escolhida). Liberar
                        // em lote nunca cria aplicação nem reabre prova encerrada (AVA-X1).
                        if (!historyId) {
                            return res.status(409).json({
                                error: 'A prova online não é liberada por aqui: prepare a aplicação em Provas e inicie-a pelo Monitor.',
                                requiresApplication: true,
                            });
                        }
                        const historyEntry = findOnlineHistoryEntry(cls, itemKey, historyId);
                        if (!historyEntry) {
                            return res.status(400).json({ error: 'Nenhuma aplicação salva com questões foi encontrada para preparar esta prova.' });
                        }
                        const answerKeyProblem = examVersions.preparationAnswerKeyProblem(historyEntry, evaluationFor(itemKey));
                        if (answerKeyProblem) return res.status(409).json({ success: false, ...answerKeyProblem });
                        if (applicationOptions?.tokenEnabled === true && !normalizeExamToken(applicationOptions.accessToken)) {
                            return res.status(400).json({ error: 'O token deve conter exatamente 5 letras maiúsculas.' });
                        }
                        const parsedMaxAttempts = parseMaxAttempts(Object.prototype.hasOwnProperty.call(applicationOptions || {}, 'maxAttempts')
                            ? applicationOptions.maxAttempts
                            : (Object.prototype.hasOwnProperty.call(historyEntry, 'maxAttempts') ? historyEntry.maxAttempts : DEFAULT_MAX_ATTEMPTS));
                        if (!parsedMaxAttempts.valid) {
                            return res.status(400).json({ error: 'Tentativas deve ser um número entre 1 e 10.' });
                        }
                        const keystrokeChoice = parseKeystrokeModeOption(applicationOptions);
                        if (!keystrokeChoice.valid) {
                            return res.status(400).json({ success: false, error: keystrokeChoice.error, field: 'keystrokeMode' });
                        }
                        const prepared = prepareApplicationFromHistory(cls, itemKey, historyEntry, applicationOptions || {}, req);
                        affectedApplication = prepared.application;
                        const targetStatus = Number(affectedApplication.waitingRoomDuration || 0) > 0 ? 'waiting' : 'running';
                        transitionExamApplication(affectedApplication, targetStatus, {
                            actor,
                            waitingRoomDuration: affectedApplication.waitingRoomDuration,
                        });
                        cls.onlineExamConfigs[itemKey] = applicationToOnlineConfig(affectedApplication, previousConfig);
                        cls.releasedItems[itemKey] = true;
                        cls.activeExamKey = itemKey;
                        cls.activeApplicationId = affectedApplication.id;
                    } else {
                        // Bloquear não encerra prova em andamento: quem decide o que fazer
                        // com as respostas é o professor, no Monitor (AVA-04).
                        if (running) {
                            return res.status(409).json(activeApplicationConflict(running, 'Há uma aplicação em andamento desta prova nesta turma; encerre-a pelo Monitor (salvando ou desconsiderando as respostas) antes de bloquear.'));
                        }
                        // Aplicação só preparada (nenhum aluno entrou): é cancelada.
                        affectedApplication = findExamApplication(db.memory.examApplications, previousConfig.applicationId);
                        if (affectedApplication && !['finished', 'cancelled'].includes(affectedApplication.status)) {
                            try {
                                transitionExamApplication(affectedApplication, 'cancelled', { actor });
                                recordExamAudit('exam_application_cancelled', affectedApplication, actor, { reason: 'bloqueio_materiais' });
                            } catch (_) {}
                        }
                        cls.onlineExamConfigs[itemKey] = {
                            ...previousConfig,
                            onlineActive: false,
                            status: 'not_applied',
                            startTime: null,
                            waitingRoomStartTimestamp: null,
                            activeHistoryId: null,
                            applicationId: null,
                            accessToken: null,
                            versionSnapshots: [],
                            preparedAt: null,
                            updatedAt: new Date().toISOString(),
                        };
                        cls.releasedItems[itemKey] = false;
                        if (cls.activeExamKey === itemKey) cls.activeExamKey = null;
                        if (cls.activeApplicationId === previousConfig.applicationId) cls.activeApplicationId = null;
                    }
                } else {
                    cls.releasedItems[itemKey] = !!released;
                }
            }

            // O gabarito é um só para a família da prova nesta turma: liberar ou bloquear o
            // da variante "só desta turma" vale também para o da prova de origem (as
            // entregas da rodada anterior), que a tela de Materiais não mostra mais.
            // Só mexe nas chaves que a turma (ou o aluno) já tem gravadas.
            const familyAnswerKeys = [];
            if (itemKey.startsWith('Gabarito_')) {
                const target = normalizedStudentEmail ? cls.studentReleasedItems[normalizedStudentEmail] : cls.releasedItems;
                answerKeyFamily(itemKey.slice('Gabarito_'.length)).forEach(answerKey => {
                    if (answerKey === itemKey) return;
                    const recorded = target[answerKey] !== undefined
                        || (normalizedStudentEmail && cls.releasedItems && cls.releasedItems[answerKey] !== undefined);
                    if (!recorded) return;
                    target[answerKey] = !!released;
                    familyAnswerKeys.push(answerKey);
                });
            }

            // Liberado agora pelo interruptor: a liberação agendada do item não tem mais o
            // que fazer e sai da agenda (bloquear mantém a agenda: o selo continua na tela).
            const droppedSchedule = !normalizedStudentEmail && released
                ? [itemKey, ...familyAnswerKeys].filter(key => dropItemSchedule(cls, key)).length > 0
                : false;
            if (!normalizedStudentEmail) {
                if (!cls.releaseMeta) cls.releaseMeta = {};
                const releaseActor = (req.adminAccount && (req.adminAccount.name || req.adminAccount.email)) || 'Administrador';
                const at = new Date().toISOString();
                [itemKey, ...familyAnswerKeys].forEach(key => {
                    cls.releaseMeta[key] = { by: releaseActor, at, released: !!released };
                });
            }
            await persistClasses(classes);
            res.json({
                success: true,
                scope: normalizedStudentEmail ? 'student' : 'class',
                releasedItems: getReleasedItemsForClass(cls, normalizedStudentEmail),
                application: withoutSealedToken(affectedApplication),
                ...(droppedSchedule ? { releaseSchedule: examSchedule.releaseScheduleView(cls, { memory: db.memory }), scheduleDropped: true } : {}),
            });
        });
    });

    router.post('/api/admin/exam-history/add', (req, res) => {
        validateAdmin(req, res, async () => {
            if (!EXAM_HISTORY_ADD_SCHEMA.check(req, res)) return;
            const { studentClass, courseId, examKey, type, label, questionNumbers, examCode, printSnapshot, questionCount, excludedQuestions, shuffleQuestions, shuffleAnswers, durationMinutes, timerEnabled, waitingRoomMinutes, maxAttempts, tokenEnabled } = req.body;
            if (!studentClass || !examKey || !Array.isArray(questionNumbers) || questionNumbers.length === 0) {
                return res.status(400).json({ error: 'Dados incompletos para registrar histórico.' });
            }
            const parsedMaxAttempts = parseMaxAttempts(Object.prototype.hasOwnProperty.call(req.body || {}, 'maxAttempts')
                ? maxAttempts
                : DEFAULT_MAX_ATTEMPTS);
            if (!parsedMaxAttempts.valid) return res.status(400).json({ error: 'Tentativas deve ser um número entre 1 e 10.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            if (!cls.examHistory) cls.examHistory = {};
            if (!cls.examHistory[examKey]) cls.examHistory[examKey] = [];
            const parsedWaitingRoom = parseInt(waitingRoomMinutes, 10);
            const entryType = type || 'online';
            const evaluation = evaluationFor(examKey);
            // Versões montadas e conferidas no servidor (P3-S11, D23). Online sem as versões no
            // pedido: o servidor monta, pela avaliação, as questões escolhidas na montagem
            // (versionCount de 1 a 4). Com as versões no pedido (a prova impressa, montada no
            // navegador para imprimir na hora, ou um cliente de antes): cada questão é
            // conferida com a avaliação e a resposta certa e o gabarito impresso passam a ser
            // os calculados aqui; diferença é recusada (400 snapshot_mismatch).
            let snapshots = null;
            let builtOnServer = false;
            const versionLimit = entryType === 'online' ? examVersions.ONLINE_VERSIONS_MAX : examVersions.PRINT_VERSIONS_MAX;
            if (Array.isArray(printSnapshot) && printSnapshot.length > versionLimit) {
                return res.status(400).json({
                    success: false,
                    error: entryType === 'online' ? examVersions.ONLINE_VERSIONS_ERROR : `No máximo ${versionLimit} versões impressas.`,
                    code: 'too_many_versions',
                    field: 'printSnapshot',
                });
            }
            if (entryType === 'online' && !Array.isArray(printSnapshot)) {
                const built = examVersions.buildOnlineVersions(evaluation, {
                    questionNumbers,
                    versionCount: req.body.versionCount ?? req.body.onlineVersions ?? 1,
                    shuffleQuestions: shuffleQuestions !== false,
                    shuffleAnswers: shuffleAnswers !== false,
                });
                if (!built.ok) return res.status(400).json({ success: false, error: built.error, field: built.field, ...(built.code ? { code: built.code } : {}) });
                snapshots = built.versions;
                builtOnServer = true;
            } else if (Array.isArray(printSnapshot) && evaluation) {
                const checked = examVersions.conferVersionSnapshots(printSnapshot, evaluation, { maxVersions: versionLimit });
                if (!checked.ok) return res.status(400).json({ success: false, error: checked.error, code: checked.code, field: checked.field || 'printSnapshot', ...(checked.problems ? { problems: checked.problems } : {}) });
                snapshots = checked.snapshots;
            }
            const entry = {
                id: 'eh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                type: entryType,
                label: label || null,
                questionNumbers: snapshots
                    ? [...new Set(snapshots.flatMap(snapshot => snapshot.questions.map((question, index) => questionNumber(question, index))))]
                    : questionNumbers.map(Number),
                examCode: (builtOnServer ? snapshots[0]?.examCode : examCode) || null,
                printSnapshot: snapshots || printSnapshot || null,
                // Tipo, pontos e gabarito de cada questão como estão na avaliação agora: a
                // aplicação corrige por eles daqui em diante, mesmo que a avaliação mude.
                // Sem avaliação nenhuma (nem gravada nem em .md) não há o que conferir: as
                // versões ficam como vieram, como antes (e sem gabaritoConferidoEm).
                versionSnapshots: snapshots
                    ? examVersions.frozenVersionSnapshots(snapshots, evaluation)
                    : (Array.isArray(printSnapshot) ? examVersions.frozenVersionSnapshots(printSnapshot, null) : []),
                // O gabarito desta configuração foi calculado (online) ou conferido (impressa)
                // pelo servidor: preparar por ela não confere de novo (D23).
                ...(snapshots ? { gabaritoConferidoEm: new Date().toISOString() } : {}),
                ...(builtOnServer ? { montadaNoServidor: true, versionCount: snapshots.length } : {}),
                questionCount: builtOnServer ? snapshots[0].questions.length : (parseInt(questionCount, 10) || questionNumbers.length),
                excludedQuestions: Array.isArray(excludedQuestions) ? excludedQuestions.map(Number) : [],
                shuffleQuestions: shuffleQuestions !== false,
                shuffleAnswers: shuffleAnswers !== false,
                durationMinutes: parseInt(durationMinutes, 10) || DEFAULT_ONLINE_DURATION_MINUTES,
                timerEnabled: timerEnabled !== false,
                waitingRoomMinutes: Number.isFinite(parsedWaitingRoom) ? Math.max(0, parsedWaitingRoom) : DEFAULT_WAITING_ROOM_MINUTES,
                // Só se a configuração pede token (P3-S8, D19): o token em texto puro não fica
                // mais no histórico (a tela de antes mandava accessToken; vale como "pede").
                tokenEnabled: tokenEnabled === true || !!normalizeExamToken(req.body.accessToken),
                maxAttempts: parsedMaxAttempts.value,
                createdAt: new Date().toISOString(),
            };
            cls.examHistory[examKey].push(entry);
            await persistClasses(classes);
            res.json({ success: true, entry });
        });
    });

    router.get('/api/admin/exam-history', (req, res) => {
        validateAdmin(req, res, () => {
            const { studentClass, courseId, examKey } = req.query;
            if (!studentClass || !examKey) return res.status(400).json({ error: 'Turma ou avaliação não informada.' });
            const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            // O token em texto puro não sai mais (P3-S8, D19): a migração do boot tira o de
            // antes, e o que a versão anterior gravar depois dela também não vai para a tela.
            const history = ((cls.examHistory && cls.examHistory[examKey]) || []).map(entry => {
                if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, 'accessToken')) return entry;
                const { accessToken, ...rest } = entry;
                return { ...rest, tokenEnabled: rest.tokenEnabled === true || !!normalizeExamToken(accessToken) };
            });
            res.json({ success: true, history });
        });
    });

    router.post('/api/admin/exam-history/delete', (req, res) => {
        validateAdmin(req, res, async () => {
            const { studentClass, courseId, examKey, entryId } = req.body;
            if (!studentClass || !examKey || !entryId) return res.status(400).json({ error: 'Dados insuficientes para exclusão.' });
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId);
            if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
            if (!isCourseExamKey(cls, examKey)) return res.status(400).json({ error: 'Avaliação não pertence ao curso da turma.' });
            if (!cls.examHistory || !cls.examHistory[examKey]) return res.status(404).json({ error: 'Histórico não encontrado.' });
            const before = cls.examHistory[examKey].length;
            cls.examHistory[examKey] = cls.examHistory[examKey].filter(entry => entry.id !== entryId);
            if (cls.examHistory[examKey].length === before) return res.status(404).json({ error: 'Entrada não encontrada no histórico.' });
            await persistClasses(classes);
            res.json({ success: true });
        });
    });

    return router;
}

module.exports = { createAdminExamConfigRouter };
