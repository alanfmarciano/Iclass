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
} = require('../middlewares.js');
const { countStudentExamAttempts, normalizeMaxAttempts } = require('../utils/examAttempts.js');
const { normalizeExamToken, verifyExamToken } = require('../utils/examToken.js');
const {
    createAttemptState,
    examStateKey,
    findExamApplication,
    findOpenAttemptState,
} = require('../utils/examApplications.js');
const { attemptOverdueMs } = require('../utils/examDeadline.js');
const { OPEN_APPLICATION_STATUSES } = require('../utils/examFinish.js');
const { stateWithoutSecrets } = require('../utils/examLocalCopy.js');
const { answerIdScope, decodeAttemptAnswers, stateForStudent } = require('../utils/examAnswerIds.js');
const { keepPageExitOnLock, markPageExit } = require('../utils/examFocusRules.js');

// Prova bloqueada por perda de foco: as questões ficam ocultas, então o rascunho só é
// aceito logo depois do bloqueio (o que o aluno marcou antes dele e ainda estava a
// caminho). Depois disso só volta a salvar quando o professor libera.
const FOCUS_LOCK_SAVE_GRACE_MS = 15 * 1000;
// Eventos que travam a tentativa aberta (o professor libera pelo Monitor).
const FOCUS_LOCK_EVENTS = new Set(['tab_blur', 'exam_left', 'fullscreen_exit']);
// Eventos registrados uma vez por tentativa: recarregar a página ou voltar à prova não
// repete "Dispositivo sem tela cheia" no Monitor e nos logs.
const ONCE_PER_ATTEMPT_EVENTS = new Set(['fullscreen_unsupported']);

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

function stateContext({ application, studentEmail, examKey, attemptId, create = false, cls } = {}) {
    if (application) {
        const open = findOpenAttemptState(db.memory.studentExamState, { applicationId: application.id, studentEmail });
        if (open && (!attemptId || open.state.attemptId === attemptId)) return open;
        if (!create) return { key: null, state: null };
        const attemptsUsed = countStudentExamAttempts(db.memory.submissions, {
            studentEmail,
            examKey,
            courseId: application.courseId,
            applicationId: application.id,
        });
        const state = createAttemptState({
            application,
            studentEmail,
            attemptNumber: attemptsUsed + 1,
            studentClass: application.studentClass,
            courseId: application.courseId,
        });
        const key = examStateKey({ applicationId: application.id, studentEmail, attemptNumber: state.attemptNumber });
        db.memory.studentExamState[key] = state;
        return { key, state };
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
            details: details ? details.trim() : ''
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
        db.save();
        
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao salvar log de atividade:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

// 1b. Recebe lotes do histórico de digitação da prova (Modo Prova Rigoroso).
//     Armazenamento dedicado para não poluir os logs de foco. Nunca dispara pausa.
const KEYSTROKE_CAP_PER_ATTEMPT = 20000; // guarda-chuva para não crescer sem limite
router.post('/api/student/log-keystrokes', validateStudentSession, (req, res) => {
    try {
        const { studentClass, courseId, examKey, applicationId, attemptId, events } = req.body;
        if (!examKey || !Array.isArray(events) || events.length === 0) {
            return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
        }
        const normalizedEmail = req.studentEmail;
        const normalizedExamKey = examKey.trim();
        const cls = requireEnrolledExamClass(req, res, studentClass, courseId);
        if (!cls) return;
        const application = applicationForClass(cls, normalizedExamKey, applicationId);
        if (applicationId && !application) return res.status(404).json({ error: 'Aplicação de prova não encontrada.' });

        const store = db.memory.examKeystrokes;
        let inserted = 0;
        for (const ev of events.slice(0, 500)) {
            if (!ev || typeof ev !== 'object') continue;
            store.push({
                id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
                studentEmail: normalizedEmail,
                studentClass: cls.name,
                courseId: cls.courseId || courseId || null,
                examKey: normalizedExamKey,
                applicationId: application?.id || null,
                attemptId: attemptId || null,
                seq: Number(ev.seq) || null,
                clientTs: Number(ev.clientTs) || null,
                serverTs: Date.now(),
                key: typeof ev.key === 'string' ? ev.key.slice(0, 40) : '',
                code: typeof ev.code === 'string' ? ev.code.slice(0, 40) : '',
                mods: typeof ev.mods === 'string' ? ev.mods.slice(0, 16) : '',
                kind: typeof ev.kind === 'string' ? ev.kind.slice(0, 24) : 'key',
                question: ev.question != null ? String(ev.question).slice(0, 12) : null,
                blocked: ev.blocked === true,
                suspicious: ev.suspicious === true,
            });
            inserted++;
        }

        // Poda por tentativa para não crescer indefinidamente.
        const attemptEvents = store.filter(k => k.studentEmail === normalizedEmail
            && (application ? k.applicationId === application.id : k.examKey === normalizedExamKey));
        if (attemptEvents.length > KEYSTROKE_CAP_PER_ATTEMPT) {
            const excess = attemptEvents
                .sort((a, b) => (a.serverTs || 0) - (b.serverTs || 0))
                .slice(0, attemptEvents.length - KEYSTROKE_CAP_PER_ATTEMPT);
            const excessIds = new Set(excess.map(e => e.id));
            db.memory.examKeystrokes = store.filter(k => !excessIds.has(k.id));
        }

        db.save();
        res.json({ success: true, inserted });
    } catch (err) {
        console.error('Erro ao salvar histórico de digitação:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

// 1c. Histórico completo de digitação de um aluno (visualização ao vivo do professor)
router.get('/api/admin/exam-keystrokes/:class/:examKey', (req, res) => {
    validateAdmin(req, res, () => {
        try {
            const studentClass = req.params.class.trim();
            const examKey = req.params.examKey.trim();
            const email = String(req.query.email || '').trim().toLowerCase();
            const applicationId = String(req.query.applicationId || '').trim();
            const sinceSeq = Number(req.query.sinceSeq) || 0;
            const limit = Math.min(Number(req.query.limit) || 2000, 5000);
            if (!email) return res.status(400).json({ error: 'Parâmetro email é obrigatório.' });

            // Identifica pelo aluno + prova + aplicação — exatamente a mesma lógica do
            // contador do monitor (monitor-status). studentClass não entra no filtro para
            // evitar divergência de casing/valor gravado que esconderia o histórico.
            let events = (db.memory.examKeystrokes || []).filter(k =>
                k.studentEmail.toLowerCase() === email
                && k.examKey.toLowerCase() === examKey.toLowerCase()
                && (!applicationId || k.applicationId === applicationId)
                && (!sinceSeq || Number(k.seq || 0) > sinceSeq)
            );
            events.sort((a, b) => (Number(a.seq || 0) - Number(b.seq || 0)) || (a.serverTs - b.serverTs));
            const total = events.length;
            events = events.slice(-limit);
            res.json({ success: true, events, total });
        } catch (err) {
            console.error('Erro ao recuperar histórico de digitação:', err);
            res.status(500).json({ error: 'Erro interno no servidor.' });
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
        const key = context.key || examStateKey({ studentEmail: normalizedEmail, examKey: examKey.trim() });

        // Preserva campos internos já existentes (ex.: tokenValidated) ao salvar o rascunho.
        const existing = context.state || db.memory.studentExamState[key];
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

        await db.save();
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao salvar progresso do aluno:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
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
            console.error('Erro ao recuperar logs de auditoria:', err);
            res.status(500).json({ error: 'Erro interno no servidor.' });
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
                    db.save();
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
        console.error('Erro ao buscar estado da prova do estudante:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
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
        db.save();
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao acusar recebimento de mensagem:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
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
        console.error('Erro ao carregar historico de mensagens:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
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
        db.save();
        res.json({ success: true, deleted: count });
    } catch (err) {
        console.error('Erro ao excluir historico de mensagens:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

// 6. Valida o token de acesso da prova NO SERVIDOR (o token nunca é enviado ao cliente).
//    Em caso de sucesso marca a prova como liberada para este aluno (tokenValidated).
router.post('/api/student/validate-exam-token', validateStudentSession, (req, res) => {
    try {
        const { rateLimit } = require('../utils/rateLimit.js');
        const _rl = rateLimit(`exam-token:${req.ip}`, { max: 30, windowMs: 60000 });
        if (!_rl.allowed) {
            return res.status(429).json({ error: 'Muitas tentativas. Aguarde um instante e tente novamente.' });
        }
        const { email, studentClass, courseId, examKey, applicationId, attemptId, token } = req.body;
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
            return res.json({ success: true, valid: false });
        }

        const context = stateContext({ application, studentEmail: normalizedEmail, examKey: examKey.trim(), attemptId, create: true, cls });
        const stateKey = context.key || examStateKey({ studentEmail: normalizedEmail, examKey: examKey.trim() });
        const existing = context.state || {
            studentEmail: normalizedEmail,
            examKey: examKey.trim(),
            answers: {},
            timerRemaining: null,
            assignedVersion: 'A',
            individualTimeAdjustment: 0
        };
        existing.tokenValidated = true;
        if (application) existing.applicationId = application.id;
        db.memory.studentExamState[stateKey] = existing;
        db.save();

        res.json({ success: true, valid: true, applicationId: application?.id || null, attemptId: existing.attemptId || null });
    } catch (err) {
        console.error('Erro ao validar token de prova:', err);
        res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

module.exports = router;
