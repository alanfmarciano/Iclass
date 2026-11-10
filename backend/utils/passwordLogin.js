// ---------------------------------------------------------------------------
// Login com senha (H2-B, H6b): o único caminho que confere a senha de quem entra,
// aluno (POST /api/student/login) ou instrutor (POST /api/session/admin-login).
//
// - Só texto vale como credencial: e-mail ou senha ausentes, vazios ou de outro tipo
//   respondem 400 sem gastar tentativa nem calcular scrypt.
// - Teto por IP (o rateLimit de 30 por minuto de antes, por perfil). O atraso
//   progressivo por conta (loginGuard) e os tetos novos entram aqui no H5b.
// - A senha é conferida com o scrypt assíncrono (database.verifyPasswordAsync), no pool
//   de threads: uma turma inteira entrando junto não para o servidor (DES-07).
// - Hash antigo (SHA-256 legado, texto puro) é regravado em scrypt$ só se o valor
//   guardado ainda for o mesmo lido antes do await: uma senha trocada pelo professor
//   durante a conferência nunca é sobrescrita pela antiga.
// - Falha do aluno vai para loginLogs, como antes (a rota grava). O registro das
//   tentativas do instrutor entra com o H5b.
//
// Quem chama monta a resposta: { ok: true, account, email, rehashed } ou
// { ok: false, status, body } (400, 401 ou 429), já com a mensagem em português.
// ---------------------------------------------------------------------------
const db = require('../database.js');
const { rateLimit } = require('./rateLimit.js');
const { getClientIp, recordLoginLog } = require('./security.js');

const LOGIN_KINDS = Object.freeze({
    student: {
        accounts: () => db.memory.students,
        rateKey: 'student-login',
        missing: 'E-mail e senha são obrigatórios.',
        invalid: 'E-mail ou senha incorretos.',
        tooMany: 'Muitas tentativas de login. Aguarde um instante e tente novamente.',
    },
    admin: {
        accounts: () => db.memory.admins,
        rateKey: 'admin-login',
        missing: 'Informe e-mail e senha.',
        invalid: 'E-mail ou senha incorretos.',
        tooMany: 'Muitas tentativas de acesso. Aguarde um instante e tente novamente.',
    },
});
const LOGIN_RATE_LIMIT = Object.freeze({ max: 30, windowMs: 60000 });

function credentialText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function refusal(status, error, extra = {}) {
    return { ok: false, status, body: { error, ...extra } };
}

async function attemptPasswordLogin({ kind, email, password, req }) {
    const settings = LOGIN_KINDS[kind];
    if (!settings) throw new TypeError(`Tipo de login desconhecido: ${kind}`);
    const normalizedEmail = credentialText(email).toLowerCase();
    const secret = credentialText(password);
    if (!normalizedEmail || !secret) return refusal(400, settings.missing);

    const limit = rateLimit(`${settings.rateKey}:${getClientIp(req)}`, LOGIN_RATE_LIMIT);
    if (!limit.allowed) {
        return refusal(429, settings.tooMany, { retryAfterSeconds: Math.max(1, Math.ceil(limit.retryAfterMs / 1000)) });
    }

    // Contas com o e-mail, na ordem em que estão guardadas; vale a primeira cuja senha
    // confere (o banco antigo pode ter o mesmo e-mail em mais de um aluno).
    const candidates = (settings.accounts() || []).filter(account => (
        account && typeof account.email === 'string' && account.email.trim().toLowerCase() === normalizedEmail
    ));
    let matched = null;
    for (const account of candidates) {
        const stored = account.password;
        if (await db.verifyPasswordAsync(stored, secret)) { matched = { account, stored }; break; }
    }
    if (!matched) {
        if (kind === 'student') {
            recordLoginLog(db.memory, { email: normalizedEmail, role: 'student', status: 'fail', reason: 'Credenciais inválidas', req });
        }
        return refusal(401, settings.invalid);
    }

    let rehashed = false;
    if (db.needsPasswordRehash(matched.stored)) {
        const upgraded = await db.hashPasswordAsync(secret);
        if (matched.account.password === matched.stored) {
            matched.account.password = upgraded;
            rehashed = true;
        }
    }
    return { ok: true, account: matched.account, email: normalizedEmail, rehashed };
}

module.exports = { attemptPasswordLogin, LOGIN_RATE_LIMIT };
