const test = require('node:test');
const assert = require('node:assert/strict');

const {
    STUDENT_PRESENCE_WINDOW_MS,
    isStudentSessionOnline,
    pruneExpiredStudentSessions,
} = require('../../backend/utils/studentSessions.js');

test('heartbeat atrasado deixa aluno offline sem revogar a sessao autenticada', () => {
    const now = 10 * 60 * 1000;
    const sessions = {
        'aluno@teste.local': {
            token: 'token-valido',
            createdAt: now - 30 * 60 * 1000,
            lastSeen: now - 5 * 60 * 1000,
        },
    };

    assert.equal(isStudentSessionOnline(sessions['aluno@teste.local'], now), false);
    assert.equal(pruneExpiredStudentSessions(sessions, { now, absoluteTtlMs: 8 * 60 * 60 * 1000 }), 0);
    assert.equal(sessions['aluno@teste.local'].token, 'token-valido');
});

test('presenca tolera o intervalo de timers de abas em segundo plano', () => {
    const now = 200000;
    assert.equal(STUDENT_PRESENCE_WINDOW_MS, 90000);
    assert.equal(isStudentSessionOnline({ lastSeen: now - 65000 }, now), true);
    assert.equal(isStudentSessionOnline({ lastSeen: now - 95000 }, now), false);
});

test('sessao e removida somente depois do prazo absoluto', () => {
    const now = 10 * 60 * 60 * 1000;
    const sessions = {
        'expirado@teste.local': { token: 'antigo', createdAt: now - 9 * 60 * 60 * 1000, lastSeen: now - 1000 },
        'ativo@teste.local': { token: 'novo', createdAt: now - 60 * 60 * 1000, lastSeen: now - 1000 },
    };

    assert.equal(pruneExpiredStudentSessions(sessions, { now, absoluteTtlMs: 8 * 60 * 60 * 1000 }), 1);
    assert.equal(sessions['expirado@teste.local'], undefined);
    assert.equal(sessions['ativo@teste.local'].token, 'novo');
});
