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

// Presenca e autenticacao possuem ciclos de vida diferentes. A ausencia de um
// heartbeat deixa o aluno "offline" no monitor, mas nao deve revogar o token:
// navegadores reduzem ou congelam timers de abas em segundo plano. Uma sessao
// autenticada so e removida aqui ao atingir seu prazo absoluto.
function pruneExpiredStudentSessions(sessions, { now = Date.now(), absoluteTtlMs } = {}) {
    const ttl = Number(absoluteTtlMs);
    if (!sessions || typeof sessions !== 'object' || !Number.isFinite(ttl) || ttl <= 0) return 0;

    let removed = 0;
    Object.keys(sessions).forEach(email => {
        const session = sessions[email];
        const lastSeen = sessionLastSeen(session);
        const createdAt = session && typeof session === 'object' ? Number(session.createdAt) : null;
        const reference = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : lastSeen;
        if (!reference || now - reference > ttl) {
            delete sessions[email];
            removed += 1;
        }
    });
    return removed;
}

module.exports = {
    STUDENT_PRESENCE_WINDOW_MS,
    isStudentSessionOnline,
    pruneExpiredStudentSessions,
    sessionLastSeen,
};
