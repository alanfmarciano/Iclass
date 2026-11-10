// ---------------------------------------------------------------------------
// Login com senha (H2-B, H6b): o único caminho que confere senha, a de quem entra,
// aluno (POST /api/student/login) ou instrutor (POST /api/session/admin-login), e a senha
// atual pedida na troca de senha do instrutor (POST /api/admin/change-password), que
// assim também fica sob o teto por IP: uma sessão roubada não testa senhas à vontade.
//
// - Só texto vale como credencial: e-mail ou senha ausentes, vazios ou de outro tipo
//   respondem 400 sem gastar tentativa nem calcular scrypt.
// - Teto por IP (o rateLimit de 30 por minuto de antes, por perfil). O atraso
//   progressivo por conta (loginGuard) e os tetos novos entram aqui no H5b.
// - A senha é conferida com o scrypt assíncrono (database.verifyPasswordAsync), no pool
//   de threads: uma turma inteira entrando junto não para o servidor (DES-07).
// - A senha guardada pode mudar durante o await (o professor redefine, a conta é
//   apagada, um backup é restaurado). Depois de cada espera, a conta só vale se ainda
//   guardar o mesmo valor conferido; senão a senha digitada é conferida de novo contra
//   o valor de agora. Assim a senha antiga nunca abre sessão depois de trocada, e o
//   hash antigo (SHA-256 legado, texto puro) só é regravado em scrypt$ sobre o valor
//   que foi conferido: a troca feita no meio nunca é sobrescrita pela senha antiga.
// - Falha do aluno vai para loginLogs, como antes (a rota grava). O registro das
//   tentativas do instrutor entra com o H5b.
//
// Quem chama monta a resposta: { ok: true, account, email, rehashed, password } ou
// { ok: false, status, body } (400, 401 ou 429), já com a mensagem em português; o 401
// leva passwordChanged: true (fora do body) quando a senha da conta mudou durante a
// conferência e a digitada não vale para a nova. O 429
// segue o formato combinado entre os grupos: { error, loginDelayed: true,
// retryAfterSeconds }. `password` é o valor guardado na conta logo depois da conferência
// (o hash novo, se foi regravado): quem ainda vai mudar a senha compara com ele para não
// sobrescrever uma troca feita por outro pedido durante a espera.
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

// Quantas vezes a senha digitada é conferida de novo quando a guardada muda durante a
// espera. Três trocas seguidas no meio de um login é ataque ou defeito: recusa.
const MAX_CHECK_ROUNDS = 3;

function accountEmail(account) {
    return account && typeof account.email === 'string' ? account.email.trim().toLowerCase() : '';
}

function accountsWithEmail(settings, normalizedEmail) {
    return (settings.accounts() || []).filter(account => accountEmail(account) === normalizedEmail);
}

// A conta que guarda agora o valor conferido: a mesma, se continua na lista com a mesma
// senha, ou a que tomou o lugar dela com o mesmo e-mail e o mesmo valor (a lista é
// regravada inteira por algumas rotas e pela restauração). null = a senha mudou ou a
// conta saiu durante a espera.
function currentHolder(settings, normalizedEmail, account, stored) {
    const list = settings.accounts() || [];
    if (list.includes(account) && account.password === stored && accountEmail(account) === normalizedEmail) return account;
    return list.find(item => accountEmail(item) === normalizedEmail && item.password === stored) || null;
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
        return refusal(429, settings.tooMany, { loginDelayed: true, retryAfterSeconds: Math.max(1, Math.ceil(limit.retryAfterMs / 1000)) });
    }

    // Contas com o e-mail, na ordem em que estão guardadas; vale a primeira cuja senha
    // confere (o banco antigo pode ter o mesmo e-mail em mais de um aluno). Uma nova
    // volta só acontece quando a senha guardada mudou durante a espera.
    let passwordChanged = false;
    for (let round = 0; round < MAX_CHECK_ROUNDS; round += 1) {
        let matched = null;
        let changed = false;
        for (const account of accountsWithEmail(settings, normalizedEmail)) {
            const stored = account.password;
            if (!(await db.verifyPasswordAsync(stored, secret))) continue;
            const holder = currentHolder(settings, normalizedEmail, account, stored);
            if (holder) matched = { account: holder, stored };
            else changed = true;
            break;
        }
        if (changed) { passwordChanged = true; continue; }
        if (!matched) break;

        if (!db.needsPasswordRehash(matched.stored)) {
            return { ok: true, account: matched.account, email: normalizedEmail, rehashed: false, password: matched.stored };
        }
        const upgraded = await db.hashPasswordAsync(secret);
        const holder = currentHolder(settings, normalizedEmail, matched.account, matched.stored);
        if (!holder) { passwordChanged = true; continue; }
        holder.password = upgraded;
        return { ok: true, account: holder, email: normalizedEmail, rehashed: true, password: upgraded };
    }

    if (kind === 'student') {
        recordLoginLog(db.memory, { email: normalizedEmail, role: 'student', status: 'fail', reason: 'Credenciais inválidas', req });
    }
    const refused = refusal(401, settings.invalid);
    if (passwordChanged) refused.passwordChanged = true;
    return refused;
}

module.exports = { attemptPasswordLogin, LOGIN_RATE_LIMIT };
