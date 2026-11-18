const test = require('node:test');
const assert = require('node:assert/strict');

const {
    STUDENT_PRESENCE_WINDOW_MS,
    isStudentSessionOnline,
} = require('../../backend/utils/studentSessions.js');
// A limpeza das sessões vencidas passou para utils/authSessions.js (H3a-2), o único
// módulo que grava ou apaga sessão; ela recebe a memória (sessions e adminSessions).
const { pruneExpiredSessions } = require('../../backend/utils/authSessions.js');

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
    assert.equal(pruneExpiredSessions({ sessions }, { now, absoluteTtlMs: 8 * 60 * 60 * 1000 }), 0);
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

    assert.equal(pruneExpiredSessions({ sessions }, { now, absoluteTtlMs: 8 * 60 * 60 * 1000 }), 1);
    assert.equal(sessions['expirado@teste.local'], undefined);
    assert.equal(sessions['ativo@teste.local'].token, 'novo');
});
