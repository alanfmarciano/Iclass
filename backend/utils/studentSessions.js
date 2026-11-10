// Presença do aluno ("online" no painel e no Monitor) a partir da sessão gravada
// (utils/authSessions.js): { lastSeen } ou, no formato antigo, o número cru. A limpeza
// das sessões vencidas fica em authSessions.pruneExpiredSessions (H3a-2), o único
// módulo que grava ou apaga sessão.
const STUDENT_PRESENCE_WINDOW_MS = 90 * 1000;

function sessionLastSeen(session) {
    const value = session && typeof session === 'object' ? session.lastSeen : session;
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function isStudentSessionOnline(session, now = Date.now(), windowMs = STUDENT_PRESENCE_WINDOW_MS) {
    const lastSeen = sessionLastSeen(session);
    return !!(lastSeen && now - lastSeen < windowMs);
}

module.exports = {
    STUDENT_PRESENCE_WINDOW_MS,
    isStudentSessionOnline,
    sessionLastSeen,
};
