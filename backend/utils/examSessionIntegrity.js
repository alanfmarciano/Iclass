// Outro login e troca de IP durante a prova (fase 3, P3-S13: AVA-17; D28 e D29 do desenho
// do P3).
//
// - Outro login (session_replaced): o login com a mesma conta enquanto ela tem uma
//   tentativa em andamento grava em proctoringLogs o IP e o navegador de antes e de agora
//   e, pela política da aplicação (sessionPolicy: 'travar', o padrão da P-B4, ou
//   'avisar'), trava a tentativa (focusLocked, focusLockReason 'session_replaced') até o
//   professor liberar pelo Monitor. Só conta o login que substitui uma sessão de verdade:
//   depois de um reinício longo (todas as sessões caíram) ou de "Sair", a turma inteira
//   entraria de novo e travaria.
// - Troca de IP (ip_changed): nunca trava (celular que troca de Wi-Fi para 4G muda de IP
//   sem fraude). A tentativa guarda os IPs que já viu (sessionIps, até 5): cada IP novo é
//   registrado uma vez por tentativa. Quem grava são as rotas quentes da prova que já
//   gravam proctoringLogs (sync, autosave-progress, log-activity); a validação da sessão só
//   anota req.sessionIpChange (o verificador de gravação parcial não acusa nada).
// - IP repetido no Monitor (sharedIpSummary): "mesmo IP de Fulano" só quando 2 ou 3 alunos
//   da aplicação estão no mesmo IP e a aplicação tem pelo menos 5 IPs diferentes; com quase
//   todos num IP só (rede com NAT ou proxy), nada é destacado e o Monitor avisa que a rede
//   da sala mostra o mesmo endereço para todos (DES-X2).
//
// Os eventos são evidência da prova: ficam em proctoringLogs, com a retenção e a
// anonimização dos registros de monitoramento (utils/retention.js, studentLifecycle.js),
// e não na auditoria (contrato auditoria.fora_da_auditoria do plano). O navegador vai
// cortado em 120 caracteres.
const crypto = require('crypto');
const { ACTIVE_APPLICATION_STATUSES, CLOSED_ATTEMPT_STATUSES, findExamApplication } = require('./examApplications.js');

const SESSION_POLICIES = Object.freeze(['travar', 'avisar']);
// Padrão sem resposta do Alan (P-B4, defaults_without_alan do plano): trava.
const DEFAULT_SESSION_POLICY = 'travar';
const SESSION_REPLACED_EVENT = 'session_replaced';
const IP_CHANGED_EVENT = 'ip_changed';
const SESSION_REPLACED_LOCK_REASON = 'session_replaced';
const USER_AGENT_MAX = 120;
const SESSION_IPS_MAX = 5;
const IP_MAX = 64;
// IP repetido (D29).
const SHARED_IP_MIN_DISTINCT = 5;
const SHARED_IP_GROUP_MIN = 2;
const SHARED_IP_GROUP_MAX = 3;
// "Quase todos no mesmo IP": o maior grupo tem pelo menos 4 alunos e metade da turma.
const SINGLE_NETWORK_GROUP_MIN = 4;

function normalizeSessionPolicy(value, fallback = DEFAULT_SESSION_POLICY) {
    return SESSION_POLICIES.includes(value) ? value : fallback;
}

// Aplicação antiga (sem sessionPolicy) vale o padrão.
function applicationSessionPolicy(application) {
    return normalizeSessionPolicy(application && application.sessionPolicy);
}

function shortUserAgent(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, USER_AGENT_MAX).trim();
}

function shortIp(value) {
    return String(value || '').trim().slice(0, IP_MAX);
}

function requestUserAgent(req) {
    return shortUserAgent(req && typeof req.get === 'function' ? req.get('user-agent') : '');
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function attemptStarted(state) {
    return !!state && Number(state.startedAt) > 0;
}

// Tentativas em andamento do aluno: começadas (startedAt), sem entrega, numa aplicação
// aguardando, em andamento ou pausada, dentro da janela dela (a mesma regra da "prova em
// andamento" da troca de senha, utils/passwordChange.js). [{ key, state, application }].
function attemptsInProgress(memory, email, now = Date.now()) {
    const target = normalizeEmail(email);
    if (!target || !memory) return [];
    const { openAttemptWindowEnd } = require('./passwordChange.js');
    const states = memory.studentExamState && typeof memory.studentExamState === 'object' ? memory.studentExamState : {};
    const found = [];
    Object.keys(states).forEach(key => {
        const state = states[key];
        if (!state || typeof state !== 'object' || !state.applicationId || !attemptStarted(state)) return;
        if (normalizeEmail(state.studentEmail) !== target || CLOSED_ATTEMPT_STATUSES.has(state.status)) return;
        const application = findExamApplication(memory.examApplications, state.applicationId);
        if (!application || !ACTIVE_APPLICATION_STATUSES.has(application.status)) return;
        const windowEnd = openAttemptWindowEnd(state, application, now);
        if (windowEnd && now > windowEnd) return;
        found.push({ key, state, application });
    });
    return found;
}

// Guarda o IP na lista da tentativa (sem repetir; os 5 mais recentes). Devolve se mudou.
function rememberAttemptIp(state, ip) {
    const value = shortIp(ip);
    if (!state || !value) return false;
    const list = Array.isArray(state.sessionIps) ? state.sessionIps.filter(item => typeof item === 'string' && item) : [];
    if (list.includes(value)) return false;
    list.push(value);
    state.sessionIps = list.slice(-SESSION_IPS_MAX);
    return true;
}

function newLogId(now) {
    return crypto.randomUUID ? crypto.randomUUID() : `${now}_${Math.random().toString(36).slice(2, 11)}`;
}

function ipText(value) {
    return value || 'desconhecido';
}

function sessionReplacedDetails({ ipAntes, ipDepois, travou, policy }) {
    const ips = ipAntes && ipAntes === ipDepois ? `mesmo IP ${ipDepois}` : `IP ${ipText(ipAntes)} → ${ipText(ipDepois)}`;
    const effect = travou
        ? 'Prova travada até o professor liberar.'
        : (policy === 'avisar' ? 'Só aviso: esta aplicação não trava no outro login.' : 'A prova já estava travada.');
    return `Entrou de outro aparelho com a mesma conta (${ips}). ${effect}`;
}

function ipChangedDetails({ ipAntes, ipDepois }) {
    return `Mudou de endereço de rede: ${ipText(ipAntes)} → ${ipText(ipDepois)}. A prova continua.`;
}

function pushLog(memory, entry) {
    if (!Array.isArray(memory.proctoringLogs)) memory.proctoringLogs = [];
    memory.proctoringLogs.push(entry);
    return entry;
}

function logBase(state, application, now) {
    return {
        id: newLogId(now),
        studentEmail: normalizeEmail(state.studentEmail),
        studentClass: application.studentClass || state.studentClass || '',
        courseId: application.courseId || state.courseId || null,
        examKey: application.examKey || state.examKey || '',
        applicationId: application.id,
        attemptId: state.attemptId || null,
        timestamp: now,
    };
}

// Login com a mesma conta enquanto ela tem tentativa em andamento (D28). previous: a sessão
// que o login substituiu ({ ip, userAgent }, ou null sem sessão de verdade antes); current:
// a do login novo. Grava session_replaced em cada tentativa em andamento e, com a política
// 'travar', trava a que ainda não estava travada. Devolve { logs, locked } (quantas).
function recordSessionReplaced(memory, { email, previous, current = {}, now = Date.now() } = {}) {
    const result = { logs: 0, locked: 0 };
    if (!memory || !previous) return result;
    const attempts = attemptsInProgress(memory, email, now);
    const ipAntes = shortIp(previous.ip);
    const ipDepois = shortIp(current.ip);
    const navegadorAntes = shortUserAgent(previous.userAgent);
    const navegadorDepois = shortUserAgent(current.userAgent);
    attempts.forEach(({ state, application }) => {
        const policy = applicationSessionPolicy(application);
        const travou = policy === 'travar' && state.focusLocked !== true;
        const entry = pushLog(memory, {
            ...logBase(state, application, now),
            eventType: SESSION_REPLACED_EVENT,
            details: sessionReplacedDetails({ ipAntes, ipDepois, travou, policy }),
            sessionChange: { ipAntes, ipDepois, navegadorAntes, navegadorDepois, travou, politica: policy },
        });
        result.logs += 1;
        if (travou) {
            state.focusLocked = true;
            state.focusLockedAt = now;
            state.focusLockReason = SESSION_REPLACED_LOCK_REASON;
            state.focusLockEventId = entry.id;
            state.focusUnlockedAt = null;
            // A volta à página da prova (regra dos 60 s) não destrava este bloqueio.
            delete state.pageExit;
            result.locked += 1;
        }
        rememberAttemptIp(state, ipAntes);
        rememberAttemptIp(state, ipDepois);
    });
    return result;
}

// IP do pedido numa rota quente da prova (sync, autosave, log-activity), para a tentativa
// aberta: o primeiro IP só fica guardado; um IP que a tentativa ainda não viu, com a
// tentativa já começada, grava ip_changed (nunca trava). sessionIpChange: o que a validação
// da sessão anotou neste pedido ({ ipAntes, ipDepois }), para a tentativa que ainda não
// guardava IP nenhum (de antes desta versão). Devolve se mudou o estado ou os registros.
function noteAttemptIp(memory, { state, application, clientIp, sessionIpChange = null, userAgent = '', now = Date.now() } = {}) {
    const ip = shortIp(clientIp);
    if (!memory || !state || !application || !ip) return false;
    const known = Array.isArray(state.sessionIps) ? state.sessionIps : [];
    if (known.includes(ip)) return false;
    const previousIp = known.length
        ? known[known.length - 1]
        : (sessionIpChange && sessionIpChange.ipAntes && sessionIpChange.ipAntes !== ip ? shortIp(sessionIpChange.ipAntes) : '');
    if (!previousIp || !attemptStarted(state)) {
        // Primeiro IP da tentativa (ou ainda nas instruções): só fica guardado.
        if (previousIp) rememberAttemptIp(state, previousIp);
        return rememberAttemptIp(state, ip);
    }
    const navegador = shortUserAgent(userAgent);
    pushLog(memory, {
        ...logBase(state, application, now),
        eventType: IP_CHANGED_EVENT,
        details: ipChangedDetails({ ipAntes: previousIp, ipDepois: ip }),
        sessionChange: { ipAntes: previousIp, ipDepois: ip, navegadorAntes: navegador, navegadorDepois: navegador, travou: false },
    });
    rememberAttemptIp(state, previousIp);
    rememberAttemptIp(state, ip);
    return true;
}

// O que o Monitor mostra de um aluno a partir dos registros da tentativa (D28):
// { sessionReplacedAt, sessionReplacedCount, ipChangedAt, ipChangeCount }.
function sessionEventsSummary(logs) {
    const summary = { sessionReplacedAt: null, sessionReplacedCount: 0, ipChangedAt: null, ipChangeCount: 0 };
    (Array.isArray(logs) ? logs : []).forEach(log => {
        if (!log) return;
        const at = Number(log.timestamp) || null;
        if (log.eventType === SESSION_REPLACED_EVENT) {
            summary.sessionReplacedCount += 1;
            if (at && (!summary.sessionReplacedAt || at > summary.sessionReplacedAt)) summary.sessionReplacedAt = at;
        } else if (log.eventType === IP_CHANGED_EVENT) {
            summary.ipChangeCount += 1;
            if (at && (!summary.ipChangedAt || at > summary.ipChangedAt)) summary.ipChangedAt = at;
        }
    });
    return summary;
}

// IP repetido (D29). entries: [{ email, name, ip }] dos alunos que estão fazendo a prova
// agora (ou com ela aberta). Devolve { networkSharedIp, sameIpAs: Map(e-mail -> [{ email,
// name }] dos outros alunos no mesmo IP) }.
function sharedIpSummary(entries) {
    const groups = new Map();
    (Array.isArray(entries) ? entries : []).forEach(entry => {
        const ip = shortIp(entry && entry.ip);
        const email = normalizeEmail(entry && entry.email);
        if (!ip || !email) return;
        if (!groups.has(ip)) groups.set(ip, []);
        const group = groups.get(ip);
        if (!group.some(item => item.email === email)) group.push({ email, name: entry.name ? String(entry.name).trim() : '' });
    });
    const total = [...groups.values()].reduce((sum, group) => sum + group.length, 0);
    const largest = [...groups.values()].reduce((max, group) => Math.max(max, group.length), 0);
    const networkSharedIp = largest >= SINGLE_NETWORK_GROUP_MIN && largest * 2 >= total;
    const sameIpAs = new Map();
    if (!networkSharedIp && groups.size >= SHARED_IP_MIN_DISTINCT) {
        groups.forEach(group => {
            if (group.length < SHARED_IP_GROUP_MIN || group.length > SHARED_IP_GROUP_MAX) return;
            group.forEach(item => sameIpAs.set(item.email, group.filter(other => other.email !== item.email)));
        });
    }
    return { networkSharedIp, sameIpAs };
}

module.exports = {
    DEFAULT_SESSION_POLICY,
    IP_CHANGED_EVENT,
    SESSION_IPS_MAX,
    SESSION_POLICIES,
    SESSION_REPLACED_EVENT,
    SESSION_REPLACED_LOCK_REASON,
    USER_AGENT_MAX,
    applicationSessionPolicy,
    attemptsInProgress,
    noteAttemptIp,
    normalizeSessionPolicy,
    recordSessionReplaced,
    rememberAttemptIp,
    requestUserAgent,
    sessionEventsSummary,
    sharedIpSummary,
    shortUserAgent,
};
