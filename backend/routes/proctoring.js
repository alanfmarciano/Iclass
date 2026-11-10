const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database.js');
const {
    validateStudentSession,
    validateAdmin,
    findClassByNameAndCourse,
    initializeExamState,
    studentBelongsToClass,
    studentCanSeeBroadcastMessage,
    sanitizeBroadcastMessageForStudent,
    sendInternalError,
} = require('../middlewares.js');
const { countStudentExamAttempts, normalizeMaxAttempts } = require('../utils/examAttempts.js');
const { normalizeExamToken, verifyExamToken } = require('../utils/examToken.js');
const {
    examStateKey,
    findExamApplication,
    findOpenAttemptState,
} = require('../utils/examApplications.js');
const { attemptContextForStudent, newAttemptGate } = require('../utils/studentAttemptContext.js');
const { SERVER_FINALIZE_DELAY_MS, attemptOverdueMs, settleExpiredAttempts } = require('../utils/examDeadline.js');
const { OPEN_APPLICATION_STATUSES } = require('../utils/examFinish.js');
const { stateWithoutSecrets } = require('../utils/examLocalCopy.js');
const { answerIdScope, decodeAttemptAnswers, stateForStudent } = require('../utils/examAnswerIds.js');
const { keepPageExitOnLock, markPageExit } = require('../utils/examFocusRules.js');
const { FIELD_LIMITS: KEYSTROKE_FIELD_LIMITS } = require('../utils/keystrokeStore.js');

// Prova bloqueada por perda de foco: as questões ficam ocultas, então o rascunho só é
// aceito logo depois do bloqueio (o que o aluno marcou antes dele e ainda estava a
// caminho). Depois disso só volta a salvar quando o professor libera.
const FOCUS_LOCK_SAVE_GRACE_MS = 15 * 1000;
// Eventos que travam a tentativa aberta (o professor libera pelo Monitor).
const FOCUS_LOCK_EVENTS = new Set(['tab_blur', 'exam_left', 'fullscreen_exit']);
// Eventos registrados uma vez por tentativa: recarregar a página ou voltar à prova não
// repete "Dispositivo sem tela cheia" no Monitor e nos logs.
const ONCE_PER_ATTEMPT_EVENTS = new Set(['fullscreen_unsupported']);
// Eventos que o navegador do aluno pode registrar (os que a prova envia, mais os de
// versões anteriores da tela que o Monitor ainda sabe mostrar). Os gerados pelo próprio
// servidor (page_return, focus_unlocked) e qualquer outro texto são recusados com 400:
// antes qualquer tipo era gravado (o aluno podia forjar "Liberado pelo professor" no
// Monitor) e um tipo ou detalhe que não fosse texto derrubava a rota com 500.
const STUDENT_ACTIVITY_EVENTS = new Set([
    'tab_blur', 'tab_focus', 'exam_left', 'exam_return',
    'fullscreen_exit', 'fullscreen_unsupported',
    'exam_render_error', 'exam_error_reload', 'exam_update_reload',
]);
const ACTIVITY_DETAILS_MAX = 500;

function applicationForClass(cls, examKey, applicationId) {
    const id = applicationId || cls?.onlineExamConfigs?.[examKey]?.applicationId;
    const application = findExamApplication(db.memory.examApplications, id);
    if (!application || !cls || application.examKey !== examKey || application.studentClass !== cls.name) return null;
    if (application.courseId && cls.courseId && application.courseId !== cls.courseId) return null;
    return application;
}

// O aluno só registra eventos, rascunhos e token em turma onde tem matrícula aprovada
// (sem isso, qualquer conta criava tentativas e travas em provas de outras turmas).
function rejectForeignClass(req, res, cls) {
    if (cls && !studentBelongsToClass(req.studentAccount, cls)) {
        res.status(403).json({ error: 'Turma não autorizada para este estudante.' });
        return true;
    }
    return false;
}

// Turma da prova pelo nome (sem diferenciar maiúsculas) e curso. Nos registros da
// prova (eventos de foco, digitação e rascunho) a turma é obrigatória: sem turma
// resolvida ou sem matrícula aprovada nela, 403. Antes, '1des' ou uma turma inexistente
// passavam e uma conta pendente gravava log que aparecia na auditoria da 1DES.
function resolveExamClass(studentClass, courseId) {
    const name = String(studentClass || '').trim();
    if (!name) return null;
    const classes = db.memory.classes || [];
    const course = String(courseId || '').trim();
    return findClassByNameAndCourse(classes, name, course)
        || classes.find(c => c && c.name && String(c.name).trim().toLowerCase() === name.toLowerCase()
            && (!course || String(c.courseId || '') === course))
        || null;
}

function requireEnrolledExamClass(req, res, studentClass, courseId) {
    const cls = resolveExamClass(studentClass, courseId);
    if (!cls || !studentBelongsToClass(req.studentAccount, cls)) {
        res.status(403).json({ error: 'Turma não autorizada para este estudante.' });
        return null;
    }
    return cls;
}

// Mensagens do professor que este aluno pode ver (turma com matrícula aprovada e, se
// individual, endereçada a ele). Base de exam-state, histórico, confirmação e exclusão.
function visibleMessagesForStudent(req) {
    const classes = db.memory.classes || [];
    return (db.memory.broadcastMessages || [])
        .filter(m => studentCanSeeBroadcastMessage(req.studentAccount, req.studentEmail, m, classes));
}

// Turma informada pelo aluno nas rotas de mensagem: se existe e ele não é aluno dela, 403.
function rejectForeignMessageClass(req, res, studentClass, courseId) {
    const name = String(studentClass || '').trim();
    if (!name) return false;
    const classes = db.memory.classes || [];
    const cls = findClassByNameAndCourse(classes, name, courseId)
        || classes.find(c => c.name && c.name.toLowerCase() === name.toLowerCase());
    return rejectForeignClass(req, res, cls);
}

// Tentativa a que um evento ou rascunho se refere: a aberta do aluno, desde que seja a
// mesma que o navegador informou. Daqui nunca nasce tentativa (a validação do token usa
// utils/studentAttemptContext.js, como o sync e o início da tentativa).
function stateContext({ application, studentEmail, examKey, attemptId } = {}) {
    if (application) {
        const open = findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail });
        if (open && (!attemptId || open.state.attemptId === attemptId)) return open;
        return { key: null, state: null };
    }
    const key = examStateKey({ studentEmail, examKey });
    return { key, state: db.memory.studentExamState[key] || null };
}

// 1. Recebe e grava logs de perda de foco do navegador do aluno (Proctoring)
router.post('/api/student/log-activity', validateStudentSession, (req, res) => {
    try {
        const { email, studentClass, courseId, examKey, applicationId, attemptId, eventType, details } = req.body;
        if (!email || !examKey || !eventType) {
            return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
        }
        if (typeof examKey !== 'string' || typeof eventType !== 'string' || !STUDENT_ACTIVITY_EVENTS.has(eventType.trim())) {
            return res.status(400).json({ error: 'Tipo de evento inválido.' });
        }
        if (details != null && typeof details !== 'string') {
            return res.status(400).json({ error: 'Detalhes do evento inválidos.' });
        }
        const normalizedEmail = req.studentEmail;
        const normalizedExamKey = examKey.trim();
        const normalizedEventType = eventType.trim();
        const cls = requireEnrolledExamClass(req, res, studentClass, courseId);
        if (!cls) return;
        const application = applicationForClass(cls, normalizedExamKey, applicationId);
        if (applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });

        // Tentativa a que o evento se refere: a aberta do aluno (a mesma que o navegador
        // informou, quando informou). Sem ela o evento vira só registro.
        const context = stateContext({ application, studentEmail: normalizedEmail, examKey: normalizedExamKey, attemptId, cls });
        const eventAttemptId = String(attemptId || context.state?.attemptId || '').trim() || null;

        const sameScope = log => log.studentEmail === normalizedEmail
            && log.eventType === normalizedEventType
            && (application ? log.applicationId === application.id : log.examKey === normalizedExamKey);
        const duplicated = (db.memory.proctoringLogs || []).some(log => sameScope(log)
            && Date.now() - Number(log.timestamp || 0) < 1000);
        // "Dispositivo sem tela cheia" vale uma vez por tentativa (o navegador perde a
        // marca ao recarregar a página e mandava de novo a cada volta à prova).
        const alreadyLoggedForAttempt = ONCE_PER_ATTEMPT_EVENTS.has(normalizedEventType)
            && (db.memory.proctoringLogs || []).some(log => sameScope(log)
                && (eventAttemptId ? log.attemptId === eventAttemptId : !log.attemptId));
        if (duplicated || alreadyLoggedForAttempt) return res.json({ success: true, deduplicated: true });

        const logEntry = {
            id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
            studentEmail: normalizedEmail,
            studentClass: cls.name,
            courseId: cls.courseId || courseId || null,
            examKey: normalizedExamKey,
            applicationId: application?.id || null,
            attemptId: eventAttemptId,
            timestamp: Date.now(),
            eventType: normalizedEventType,
            details: details ? details.trim().slice(0, ACTIVITY_DETAILS_MAX) : ''
        };
        
        db.memory.proctoringLogs.push(logEntry);
        // Perda de foco trava só a tentativa ABERTA do aluno. Sem tentativa aberta (o
        // evento chegou depois da entrega, ou antes de existir tentativa) fica só o log:
        // antes era gravado um estado avulso travado, que o sync seguinte adotava como
        // tentativa nova ("Bloqueado" no Monitor para quem já entregou, mesmo com o
        // limite de tentativas esgotado).
        if (FOCUS_LOCK_EVENTS.has(normalizedEventType) && context.key && context.state) {
            const stateKey = context.key;
            const existing = context.state;
            // Saída da PÁGINA (recarregar, fechar): a mesma sessão que volta logo à
            // tentativa destrava sozinha (regra única em utils/examFocusRules.js).
            if (normalizedEventType === 'exam_left' && req.body.pageExit === true) {
                markPageExit(existing, { sessionToken: req.studentSessionToken, now: logEntry.timestamp });
            } else {
                keepPageExitOnLock(existing, logEntry.timestamp);
            }
            existing.focusLocked = true;
            existing.focusLockedAt = logEntry.timestamp;
            existing.focusLockReason = logEntry.details || normalizedEventType;
            existing.focusLockEventId = logEntry.id;
            existing.focusUnlockedAt = null;
            db.memory.studentExamState[stateKey] = existing;
        }
        // Rota quente (H1-c, DES-01): grava só o log novo e o estado da tentativa. As
        // rotas do aluno anotadas levam também 'authSessions': a validação da sessão
        // registra o IP novo do aparelho, que vai para a tabela auth_sessions.
        db.save({ only: ['proctoringLogs', 'studentExamState', 'authSessions'] });
        
        res.json({ success: true });
    } catch (err) {
        return sendInternalError(err, req, res);
    }
});

// 1b. Recebe lotes do histórico de digitação da prova (Modo Prova Rigoroso).
//     Armazenamento dedicado (tabela própria, db.keystrokes) para não poluir os logs de
//     foco. Nunca dispara pausa. Ordem: sessão → campos (texto curto) → cortes de campo
//     de cada evento → append; lote sem evento válido não grava nada.
//     O teto por aluno e aplicação (ICLASS_KEYSTROKE_CAP, padrão 20 mil) é aplicado pelo
//     store no mesmo ciclo da gravação, pelos contadores, sem percorrer as teclas.
const KEYSTROKE_BATCH_MAX = 500;
// Identificação da prova, da aplicação e da tentativa: texto curto. Antes o attemptId ia
// como viesse (qualquer tipo e tamanho) para cada um dos até 500 eventos do lote, e uma
// prova que não fosse texto derrubava a rota com 500.
const KEYSTROKE_ID_MAX = 200;

function shortTextField(value, { required = false } = {}) {
    if (value === undefined || value === null || value === '') return required ? { error: true } : { value: null };
    if (typeof value !== 'string') return { error: true };
    const text = value.trim();
    if (!text) return required ? { error: true } : { value: null };
    if (text.length > KEYSTROKE_ID_MAX) return { error: true };
    return { value: text };
}

function safeInteger(value) {
    const number = Math.trunc(Number(value));
    return Number.isSafeInteger(number) && number !== 0 ? number : null;
}

router.post('/api/student/log-keystrokes', validateStudentSession, (req, res) => {
    try {
        const { studentClass, courseId, examKey, applicationId, attemptId, events } = req.body;
        if (!examKey || !Array.isArray(events) || events.length === 0) {
            return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
        }
        const exam = shortTextField(examKey, { required: true });
        if (exam.error) return res.status(400).json({ success: false, error: 'Prova inválida no registro de digitação.', field: 'examKey' });
        const requestedApplication = shortTextField(applicationId);
        if (requestedApplication.error) return res.status(400).json({ success: false, error: 'Aplicação de prova inválida no registro de digitação.', field: 'applicationId' });
        const attempt = shortTextField(attemptId);
        if (attempt.error) return res.status(400).json({ success: false, error: 'Tentativa inválida no registro de digitação.', field: 'attemptId' });
        const normalizedEmail = req.studentEmail;
        const normalizedExamKey = exam.value;
        const cls = requireEnrolledExamClass(req, res, studentClass, courseId);
        if (!cls) return;
        const application = applicationForClass(cls, normalizedExamKey, requestedApplication.value);
        if (requestedApplication.value && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });

        // Cortes de campo de cada evento (os de antes) e números como inteiros seguros:
        // um campo grande não se multiplica pelos 500 eventos do lote.
        const serverTs = Date.now();
        const courseText = typeof courseId === 'string' ? courseId.trim().slice(0, KEYSTROKE_FIELD_LIMITS.courseId) : '';
        const rows = [];
        for (const ev of events.slice(0, KEYSTROKE_BATCH_MAX)) {
            if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
            rows.push({
                id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
                studentEmail: normalizedEmail,
                studentClass: cls.name,
                courseId: cls.courseId || courseText || null,
                examKey: normalizedExamKey,
                applicationId: application?.id || null,
                attemptId: attempt.value,
                seq: safeInteger(ev.seq),
                clientTs: safeInteger(ev.clientTs),
                serverTs,
                key: typeof ev.key === 'string' ? ev.key.slice(0, KEYSTROKE_FIELD_LIMITS.key) : '',
                code: typeof ev.code === 'string' ? ev.code.slice(0, KEYSTROKE_FIELD_LIMITS.code) : '',
                mods: typeof ev.mods === 'string' ? ev.mods.slice(0, KEYSTROKE_FIELD_LIMITS.mods) : '',
                kind: typeof ev.kind === 'string' ? ev.kind.slice(0, KEYSTROKE_FIELD_LIMITS.kind) : 'key',
                question: ev.question != null && typeof ev.question !== 'object' ? String(ev.question).slice(0, KEYSTROKE_FIELD_LIMITS.question) : null,
                blocked: ev.blocked === true,
                suspicious: ev.suspicious === true,
            });
        }

        // Sem evento válido, nada é gravado. Com eventos, a resposta sai depois do COMMIT
        // (503 retryable se a gravação falhar).
        if (rows.length) db.keystrokes.append(rows);
        res.json({ success: true, inserted: rows.length });
    } catch (err) {
        return sendInternalError(err, req, res);
    }
});

// 1c. Histórico de digitação de um aluno (visualização ao vivo do professor).
//     Cursor = row_id da tabela (ordem de chegada; o seq do navegador recomeça quando a
//     página recarrega). Com ?after=<cursor>: as primeiras `limit` depois dele, com
//     hasMore. Sem after: as últimas `limit` (sinceSeq, o filtro antigo pelo seq, só
//     nesse caso). Resposta: { success, events, total, cursor, hasMore, logs }; logs são
//     os eventos de foco do mesmo aluno, prova e aplicação (os últimos 500).
const KEYSTROKE_VIEW_LOGS = 500;
router.get('/api/admin/exam-keystrokes/:class/:examKey', (req, res) => {
    validateAdmin(req, res, async () => {
        try {
            const examKey = req.params.examKey.trim();
            const email = String(req.query.email || '').trim().toLowerCase();
            const applicationId = String(req.query.applicationId || '').trim();
            const rawAfter = req.query.after === undefined ? '' : String(req.query.after).trim();
            if (rawAfter && !/^\d{1,15}$/.test(rawAfter)) {
                return res.status(400).json({ success: false, error: 'Parâmetro after inválido: use o cursor devolvido pela consulta anterior.', field: 'after' });
            }
            const sinceSeq = Number(req.query.sinceSeq) || 0;
            const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit)) || 2000, 5000));
            if (!email) return res.status(400).json({ error: 'Parâmetro email é obrigatório.' });

            // Identifica pelo aluno + prova + aplicação — exatamente a mesma lógica do
            // contador do monitor (monitor-status). studentClass não entra no filtro para
            // evitar divergência de casing/valor gravado que esconderia o histórico.
            const page = await db.keystrokes.query({
                email,
                examKey,
                applicationId: applicationId || undefined,
                after: rawAfter ? Number(rawAfter) : undefined,
                sinceSeq,
                limit,
            });
            const lowerExam = examKey.toLowerCase();
            const logs = (db.memory.proctoringLogs || [])
                .filter(log => log
                    && String(log.studentEmail || '').toLowerCase() === email
                    && String(log.examKey || '').toLowerCase() === lowerExam
                    && (!applicationId || log.applicationId === applicationId))
                .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0))
                .slice(-KEYSTROKE_VIEW_LOGS);
            res.json({ success: true, events: page.events, total: page.total, cursor: page.cursor, hasMore: page.hasMore, logs });
        } catch (err) {
            return sendInternalError(err, req, res);
        }
    });
});

// 2. Salva periodicamente as respostas intermediárias e o tempo restante do aluno
router.post('/api/student/autosave-progress', validateStudentSession, async (req, res) => {
    try {
        const { examKey, applicationId, attemptId, studentClass, courseId, answers } = req.body;
        if (!examKey) {
            return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
        }
        
        const normalizedEmail = req.studentEmail;
        const cls = requireEnrolledExamClass(req, res, studentClass, courseId);
        if (!cls) return;
        const application = applicationForClass(cls, examKey.trim(), applicationId);
        if (applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
        const context = stateContext({ application, studentEmail: normalizedEmail, examKey: examKey.trim(), attemptId, cls });
        // Com aplicação, o rascunho vai só para a tentativa aberta que o navegador conhece
        // (uma aba antiga com outra tentativa recebe 409, sem cair no estado avulso).
        const key = context.key || (application ? null : examStateKey({ studentEmail: normalizedEmail, examKey: examKey.trim() }));

        // Preserva campos internos já existentes (ex.: tokenValidated) ao salvar o rascunho.
        const existing = context.state || (key ? db.memory.studentExamState[key] : null);
        if (!existing || !existing.startedAt) {
            return res.status(409).json({ error: 'A prova ainda não foi iniciada no servidor.' });
        }
        // Prazo efetivo (com as pausas da aplicação): durante a pausa o relógio está
        // congelado e o rascunho continua sendo aceito.
        const overdueMs = application
            ? attemptOverdueMs(existing, application).overdueMs
            : (existing.deadlineAt ? Date.now() - Number(existing.deadlineAt) : null);
        if (overdueMs !== null && overdueMs > 0) {
            return res.status(408).json({ error: 'O prazo da prova terminou.', deadlineExceeded: true });
        }
        if (existing.focusLocked === true && Date.now() - Number(existing.focusLockedAt || 0) > FOCUS_LOCK_SAVE_GRACE_MS) {
            return res.status(423).json({
                error: 'Sua prova está bloqueada por perda de foco. Aguarde o professor desbloquear pelo monitor.',
                focusLocked: true,
            });
        }
        // O navegador manda o identificador opaco de cada alternativa (AVA-05); o estado
        // guarda a letra original, como sempre.
        const decodedAnswers = decodeAttemptAnswers(answers || {}, {
            application,
            onlineConfig: cls?.onlineExamConfigs?.[examKey.trim()] || null,
            state: existing,
            evaluation: db.memory.evaluations?.[examKey.trim()],
            examKey: examKey.trim(),
        });
        db.memory.studentExamState[key] = {
            ...existing,
            studentEmail: normalizedEmail,
            examKey: examKey.trim(),
            applicationId: application?.id || existing.applicationId || null,
            attemptId: existing.attemptId || attemptId || null,
            status: 'active',
            answers: decodedAnswers,
            timerRemaining: existing.deadlineAt
                ? Math.max(0, Math.ceil((Number(existing.deadlineAt) - Date.now()) / 1000))
                : null,
            savedAt: new Date().toISOString()
        };

        // Rota quente (H1-c, DES-01): o rascunho mexe só no estado da tentativa.
        await db.save({ only: ['studentExamState', 'authSessions'] });
        res.json({ success: true });
    } catch (err) {
        return sendInternalError(err, req, res);
    }
});

// 3. Retorna o histórico de atividades da turma para auditoria do professor
router.get('/api/admin/proctoring-logs/:class/:examKey', (req, res) => {
    validateAdmin(req, res, (config, matchedAdmin) => {
        try {
            const studentClass = req.params.class.trim();
            const examKey = req.params.examKey.trim();
            const courseId = req.query.courseId;
            const applicationId = req.query.applicationId;
            
            const logs = db.memory.proctoringLogs.filter(l => 
                l.studentClass.toLowerCase() === studentClass.toLowerCase() && 
                l.examKey.toLowerCase() === examKey.toLowerCase() &&
                (!applicationId || l.applicationId === applicationId) &&
                (!courseId || !l.courseId || l.courseId === courseId)
            );
            
            res.json(logs);
        } catch (err) {
            return sendInternalError(err, req, res);
        }
    });
});

// 4. Retorna o estado da prova online para o aluno (e mensagens pendentes)
router.get('/api/student/exam-state', validateStudentSession, (req, res) => {
    try {
        const { email, studentClass, courseId, examKey } = req.query;
        if (!email || !examKey) {
            return res.status(400).json({ error: 'Campos email e examKey são obrigatórios.' });
        }
        
        const normalizedEmail = req.studentEmail;
        const stateKey = `${normalizedEmail}_${examKey.trim()}`;
        
        const state = db.memory.studentExamState[stateKey] || {
            studentEmail: normalizedEmail,
            examKey: examKey.trim(),
            answers: {},
            timerRemaining: null,
            assignedVersion: 'A',
            individualTimeAdjustment: 0
        };
        
        // Buscar mensagens pendentes de broadcast para esta turma/aluno
        const messages = visibleMessagesForStudent(req).filter(m => 
            m.studentClass && studentClass &&
            m.studentClass.toLowerCase() === studentClass.trim().toLowerCase() &&
            (!m.courseId || String(m.courseId) === String(courseId || '')) &&
            (!m.examKey || String(m.examKey) === String(examKey || '')) &&
            (m.targetEmail === null || m.targetEmail.toLowerCase() === normalizedEmail) &&
            !(m.acknowledgedBy || []).includes(normalizedEmail) &&
            !(m.deletedFor || []).includes(normalizedEmail) &&
            m.status !== 'read'
        ).map(m => sanitizeBroadcastMessageForStudent(m, normalizedEmail));

        // Obter a versão atual da configuração da prova (necessária para validação no submit)
        let examConfigVersion = null;
        let attemptsUsed = 0;
        let maxAttempts = null;
        let scopeConfig = null;
        if (studentClass && examKey) {
            const classes = db.memory.classes || [];
            const cls = findClassByNameAndCourse(classes, studentClass, courseId)
                || classes.find(c => c.name && c.name.toLowerCase() === studentClass.trim().toLowerCase());
            if (rejectForeignClass(req, res, cls)) return;
            const onlineCfg = cls && cls.onlineExamConfigs && cls.onlineExamConfigs[examKey.trim()];
            scopeConfig = onlineCfg || null;
            if (onlineCfg) {
                examConfigVersion = onlineCfg.updatedAt || null;
                maxAttempts = normalizeMaxAttempts(onlineCfg.maxAttempts);
                attemptsUsed = countStudentExamAttempts(db.memory.submissions, {
                    studentEmail: normalizedEmail,
                    examKey: examKey.trim(),
                    courseId: cls.courseId || courseId,
                });
                // Sorteia a versão da prova (uma vez) se ela está ativa e tem múltiplas versões.
                // Prova com aplicação: a tentativa de verdade nasce no sync, com a versão
                // escolhida no Monitor. Um estado avulso gravado aqui era adotado depois como
                // tentativa antiga, zerado e sorteado de novo: a escolha do professor se perdia.
                const withApplication = !!findExamApplication(db.memory.examApplications, onlineCfg.applicationId);
                if (!withApplication && (maxAttempts === null || attemptsUsed < maxAttempts) && initializeExamState(state, onlineCfg)) {
                    state.studentEmail = normalizedEmail;
                    state.examKey = examKey.trim();
                    state.studentClass = cls.name;
                    state.courseId = cls.courseId || null;
                    db.memory.studentExamState[stateKey] = state;
                    db.save({ only: ['studentExamState', 'authSessions'] });
                }
            }
        }
        
        res.json({
            success: true,
            state: stateForStudent(stateWithoutSecrets(state), answerIdScope({ onlineConfig: scopeConfig, examKey: examKey.trim() })),
            messages,
            examConfigVersion,
            attemptsUsed,
            maxAttempts
        });
    } catch (err) {
        return sendInternalError(err, req, res);
    }
});


// 5. Confirma o recebimento de uma mensagem (marca como lida)
router.post('/api/student/acknowledge-message', validateStudentSession, (req, res) => {
    try {
        const { messageId } = req.body;
        if (!messageId) {
            return res.status(400).json({ error: 'ID da mensagem é obrigatório.' });
        }
        // Só confirma mensagem que o aluno pode ver: antes qualquer conta marcava como
        // lida a mensagem individual de outro aluno, que deixava de aparecer para ele.
        const msg = visibleMessagesForStudent(req).find(m => m.id === messageId);
        if (!msg) {
            return res.status(404).json({ error: 'Mensagem não encontrada.' });
        }
        msg.acknowledgedBy = Array.isArray(msg.acknowledgedBy) ? msg.acknowledgedBy : [];
        if (!msg.acknowledgedBy.includes(req.studentEmail)) {
            msg.acknowledgedBy.push(req.studentEmail);
        }
        if (msg.targetEmail) msg.status = 'read';
        db.save({ only: ['broadcastMessages', 'authSessions'] });
        res.json({ success: true });
    } catch (err) {
        return sendInternalError(err, req, res);
    }
});

router.get('/api/student/message-history', validateStudentSession, (req, res) => {
    try {
        const email = req.studentEmail;
        const studentClass = String(req.query.studentClass || '').trim();
        const courseId = String(req.query.courseId || '').trim();
        const examKey = String(req.query.examKey || '').trim();
        const applicationId = String(req.query.applicationId || '').trim();
        if (rejectForeignMessageClass(req, res, studentClass, courseId)) return;
        // Só mensagens das turmas em que o aluno tem matrícula aprovada (conta pendente
        // não vê nada), sem a lista de quem já confirmou a leitura.
        const messages = visibleMessagesForStudent(req)
            .filter(m => !studentClass || m.studentClass.toLowerCase() === studentClass.toLowerCase())
            .filter(m => !courseId || !m.courseId || String(m.courseId) === courseId)
            .filter(m => !examKey || !m.examKey || String(m.examKey) === examKey)
            .filter(m => !applicationId || m.applicationId === applicationId)
            .filter(m => !(m.deletedFor || []).includes(email))
            .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
            .map(m => sanitizeBroadcastMessageForStudent(m, email));
        res.json({ success: true, messages });
    } catch (err) {
        return sendInternalError(err, req, res);
    }
});

router.post('/api/student/message-history/delete', validateStudentSession, (req, res) => {
    try {
        const email = req.studentEmail;
        const { messageId, studentClass, courseId, examKey, applicationId } = req.body || {};
        if (rejectForeignMessageClass(req, res, studentClass, courseId)) return;
        let count = 0;
        visibleMessagesForStudent(req).forEach(m => {
            const match = messageId
                ? m.id === messageId
                : (!studentClass || String(m.studentClass || '').toLowerCase() === String(studentClass).trim().toLowerCase())
                    && (!courseId || !m.courseId || String(m.courseId) === String(courseId))
                    && (!examKey || !m.examKey || String(m.examKey) === String(examKey))
                    && (!applicationId || m.applicationId === applicationId);
            if (match) {
                m.deletedFor = Array.isArray(m.deletedFor) ? m.deletedFor : [];
                if (!m.deletedFor.includes(email)) {
                    m.deletedFor.push(email);
                    count++;
                }
            }
        });
        db.save({ only: ['broadcastMessages', 'authSessions'] });
        res.json({ success: true, deleted: count });
    } catch (err) {
        return sendInternalError(err, req, res);
    }
});

// 6. Valida o token de acesso da prova NO SERVIDOR (o token nunca é enviado ao cliente).
//    Em caso de sucesso marca a prova como liberada para este aluno (tokenValidated).
//    Limite por aluno (H5b, DES-X2): contam só os códigos errados, pela conta da sessão
//    (10 em 5 min → 429 só para esse aluno; o código certo zera). Antes o teto era de 30
//    validações por minuto por IP, contando as certas: a turma inteira atrás do mesmo
//    roteador (NAT) digitando o código ao mesmo tempo recebia "Muitas tentativas".
const EXAM_TOKEN_FAILURE_LIMIT = Object.freeze({ max: 10, windowMs: 5 * 60 * 1000 });
const EXAM_TOKEN_TOO_MANY = 'Muitas tentativas com o código da prova. Aguarde alguns minutos ou chame o professor.';

router.post('/api/student/validate-exam-token', validateStudentSession, (req, res) => {
    try {
        const rateLimiter = require('../utils/rateLimit.js');
        const tokenFailureKey = `exam-token-fail:${req.studentEmail}`;
        const tokenFailures = rateLimiter.peek(tokenFailureKey, EXAM_TOKEN_FAILURE_LIMIT);
        if (!tokenFailures.allowed) {
            return res.status(429).json({ error: EXAM_TOKEN_TOO_MANY, retryAfterSeconds: Math.max(1, Math.ceil(tokenFailures.retryAfterMs / 1000)) });
        }
        const { email, studentClass, courseId, examKey, applicationId, token } = req.body;
        if (!email || !examKey) {
            return res.status(400).json({ error: 'Campos email e examKey são obrigatórios.' });
        }

        const normalizedEmail = req.studentEmail;
        // Turma resolvida e matrícula aprovada nela: antes, uma conta pendente com turma
        // inexistente (ou sem turma) recebia valid:true.
        const cls = requireEnrolledExamClass(req, res, studentClass, courseId);
        if (!cls) return;
        const cfg = cls.onlineExamConfigs ? cls.onlineExamConfigs[examKey.trim()] : null;
        const application = applicationForClass(cls, examKey.trim(), applicationId);
        if (applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });
        // Aplicação encerrada ou cancelada não abre tentativa nova: validar o token ali
        // criava uma tentativa sem início que bagunçava o encerramento já decidido.
        if (application && !OPEN_APPLICATION_STATUSES.has(application.status)) {
            return res.status(409).json({ error: 'Esta aplicação da prova já foi encerrada.', applicationClosed: true });
        }
        const requiredToken = normalizeExamToken(cfg && cfg.accessToken);
        const requiredTokenHash = application?.accessTokenHash || cfg?.accessTokenHash || null;

        if (!requiredToken && !requiredTokenHash) {
            return res.json({ success: true, valid: true });
        }

        const provided = normalizeExamToken(token);
        const validToken = requiredTokenHash ? verifyExamToken(provided, requiredTokenHash) : provided === requiredToken;
        if (!validToken) {
            rateLimiter.hit(tokenFailureKey, EXAM_TOKEN_FAILURE_LIMIT);
            return res.json({ success: true, valid: false });
        }
        rateLimiter.reset(tokenFailureKey);

        if (application) {
            // A tentativa aberta é sempre a que continua, qualquer que seja o identificador
            // que o navegador mandou (aba antiga, outro aparelho, tentativa anterior): o
            // token só é marcado nela, sem mexer em respostas nem no prazo. Antes, um
            // identificador diferente gravava uma tentativa nova na mesma chave, as
            // respostas sumiam e o cronômetro por aluno recomeçava do zero. A tentativa
            // vencida que ainda espera a entrega automática também continua sendo a aberta.
            const { changed } = settleExpiredAttempts(db.memory, { applicationId: application.id, studentEmail: normalizedEmail, graceMs: SERVER_FINALIZE_DELAY_MS });
            if (changed) db.save();
            const scope = {
                application,
                studentEmail: normalizedEmail,
                examKey: examKey.trim(),
                studentClass: cls.name,
                courseId: cls.courseId,
            };
            let context = attemptContextForStudent(scope);
            if (!context.state) {
                // Sem tentativa aberta, a nova só nasce quando o aluno pode começar (as
                // mesmas regras do sync); senão nada é gravado.
                const gate = newAttemptGate(application, { studentEmail: normalizedEmail, onlineConfig: cfg, courseId: cls.courseId });
                if (!gate.applicationActive) {
                    return res.status(409).json({ error: 'A prova ainda não começou. Aguarde o professor iniciar a aplicação.', notStarted: true });
                }
                if (gate.attemptsExhausted) {
                    return res.status(403).json({
                        error: 'Limite de tentativas atingido.',
                        attemptsExhausted: true,
                        attemptsUsed: gate.attemptsUsed,
                        maxAttempts: gate.maxAttempts,
                    });
                }
                if (gate.timeOver) {
                    return res.status(409).json({ error: 'O tempo desta aplicação já terminou.', timeOver: true });
                }
                context = attemptContextForStudent({ ...scope, create: true });
            }
            context.state.tokenValidated = true;
            db.memory.studentExamState[context.key] = context.state;
            // A tentativa nova pode consumir o "+N min" guardado na aplicação para o aluno
            // (attemptContextForStudent), por isso examApplications vai junto.
            db.save({ only: ['studentExamState', 'examApplications', 'authSessions'] });
            return res.json({ success: true, valid: true, applicationId: application.id, attemptId: context.state.attemptId || null });
        }

        // Prova sem aplicação (interface antiga): estado avulso por aluno e prova.
        const stateKey = examStateKey({ studentEmail: normalizedEmail, examKey: examKey.trim() });
        const existing = db.memory.studentExamState[stateKey] || {
            studentEmail: normalizedEmail,
            examKey: examKey.trim(),
            answers: {},
            timerRemaining: null,
            assignedVersion: 'A',
            individualTimeAdjustment: 0
        };
        existing.tokenValidated = true;
        db.memory.studentExamState[stateKey] = existing;
        db.save({ only: ['studentExamState', 'authSessions'] });

        res.json({ success: true, valid: true, applicationId: null, attemptId: existing.attemptId || null });
    } catch (err) {
        return sendInternalError(err, req, res);
    }
});

module.exports = router;
