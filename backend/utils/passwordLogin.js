// ---------------------------------------------------------------------------
// Login com senha (H2-B, H6b): o único caminho que confere senha, a de quem entra,
// aluno (POST /api/student/login) ou instrutor (POST /api/session/admin-login), e a senha
// atual pedida na troca de senha do aluno e do instrutor (POST /api/student/change-password
// e /api/admin/change-password), que assim também fica sob um teto por IP: uma sessão
// roubada não testa senhas à vontade.
//
// - Só texto vale como credencial: e-mail ou senha ausentes, vazios ou de outro tipo
//   respondem 400 sem gastar tentativa nem calcular scrypt.
// - Teto por IP de 300 tentativas por minuto, por perfil, contando todas (H5b, DES-X2):
//   só protege a CPU do scrypt. A turma de 40 atrás do mesmo roteador (NAT) entra sem
//   429; antes eram 30 por minuto, e os últimos da turma esperavam.
// - Atraso progressivo por conta (utils/loginGuard.js, H5b, SEG-06, decisão 6 do Alan):
//   da 5.ª senha errada seguida em diante a conta espera (30 s, 1, 2, 4, 8 e 15 min) e
//   recebe 429 { loginDelayed: true, retryAfterSeconds } sem a senha ser conferida. O
//   professor libera ("Liberar login"); nunca há trava definitiva. As tentativas de uma
//   mesma conta são conferidas uma de cada vez (accountQueue): uma rajada de pedidos
//   simultâneos não passa toda junto antes de o atraso começar.
// - E-mail que não é de conta nenhuma também conta no atraso e confere a senha contra um
//   valor qualquer (mesmo tempo de resposta): nem a demora nem o 429 dizem se a conta
//   existe.
// - A senha é conferida com o scrypt assíncrono (database.verifyPasswordAsync), no pool
//   de threads: uma turma inteira entrando junto não para o servidor (DES-07).
// - A senha guardada pode mudar durante o await (o professor redefine, a conta é
//   apagada, um backup é restaurado). Depois de cada espera, a conta só vale se ainda
//   guardar o mesmo valor conferido; senão a senha digitada é conferida de novo contra
//   o valor de agora. Assim a senha antiga nunca abre sessão depois de trocada, e o
//   hash antigo (SHA-256 legado, texto puro) só é regravado em scrypt$ sobre o valor
//   que foi conferido: a troca feita no meio nunca é sobrescrita pela senha antiga.
// - Toda falha vai para loginLogs (aluno e, desde o H5b, instrutor), sem esperar o banco:
//   a falha fica na memória, igual dentro de 60 s soma em count, e a gravação é agrupada
//   (security.scheduleLoginLogSave, no máximo uma a cada 60 s). O atraso também fica
//   registrado (status 'throttled'). 50 senhas erradas em 10 min vindas do mesmo IP
//   gravam um alerta (status 'alert', um por janela) que aparece na fila "Precisa de
//   você" do administrador.
//
// Quem chama monta a resposta: { ok: true, account, email, rehashed, password,
// weakPassword } ou
// { ok: false, status, body } (400, 401 ou 429), já com a mensagem em português; o 401
// leva passwordChanged: true (fora do body) quando a senha da conta mudou durante a
// conferência e a digitada não vale para a nova. O 429
// segue o formato combinado entre os grupos: { error, loginDelayed: true,
// retryAfterSeconds }. `password` é o valor guardado na conta logo depois da conferência
// (o hash novo, se foi regravado): quem ainda vai mudar a senha compara com ele para não
// sobrescrever uma troca feita por outro pedido durante a espera. `weakPassword` diz se
// a senha digitada seria recusada hoje pela política (utils/passwordPolicy.js): a rota
// do login pede a troca dela (H5a, decisão P3 do Alan).
// ---------------------------------------------------------------------------
const db = require('../database.js');
const rateLimiter = require('./rateLimit.js');
const loginGuard = require('./loginGuard.js');
const { getClientIp, recordLoginLog, scheduleLoginLogSave } = require('./security.js');
const { isWeakPassword } = require('./passwordPolicy.js');

const LOGIN_KINDS = Object.freeze({
    student: {
        accounts: () => db.memory.students,
        rateKey: 'student-login-all',
        // A senha atual da troca de senha do aluno tem teto próprio (ver purpose).
        changeRateKey: 'student-change-password-all',
        missing: 'E-mail e senha são obrigatórios.',
        invalid: 'E-mail ou senha incorretos.',
        tooMany: 'Muitas tentativas de login. Aguarde um instante e tente novamente.',
        whoUnlocks: 'peça ao professor para liberar',
    },
    admin: {
        accounts: () => db.memory.admins,
        rateKey: 'admin-login-all',
        // Instrutor: a troca divide o teto com o login, como antes (são poucas contas).
        changeRateKey: 'admin-login-all',
        missing: 'Informe e-mail e senha.',
        invalid: 'E-mail ou senha incorretos.',
        tooMany: 'Muitas tentativas de acesso. Aguarde um instante e tente novamente.',
        whoUnlocks: 'peça a um administrador para liberar',
    },
});
// Teto por IP (H5b, DES-X2): conta todas as tentativas, só para proteger a CPU do scrypt.
const LOGIN_RATE_LIMIT = Object.freeze({ max: 300, windowMs: 60000 });
// Alerta por IP (H5b): 50 senhas erradas em 10 min vindas do mesmo IP.
const IP_ALERT_THRESHOLD = 50;
const IP_ALERT_WINDOW_MS = 10 * 60 * 1000;

// "30 segundos", "1 minuto", "4 minutos".
function waitText(seconds) {
    const value = Math.max(1, Math.ceil(Number(seconds) || 0));
    if (value < 60) return `${value} ${value === 1 ? 'segundo' : 'segundos'}`;
    const minutes = Math.ceil(value / 60);
    return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
}

function delayedRefusal(settings, guard) {
    return refusal(429, `Muitas tentativas com senha errada para esta conta. Tente de novo em ${waitText(guard.retryAfterSeconds)} ou ${settings.whoUnlocks}.`, {
        loginDelayed: true,
        retryAfterSeconds: guard.retryAfterSeconds,
    });
}

// Tentativas da mesma conta, uma de cada vez: cada uma vê o atraso que a anterior deixou.
const accountQueue = new Map();

function withAccountTurn(key, task) {
    const previous = accountQueue.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => undefined, () => undefined);
    accountQueue.set(key, tail);
    tail.then(() => { if (accountQueue.get(key) === tail) accountQueue.delete(key); });
    return run;
}

// Valor de senha que nunca confere, para o e-mail sem conta gastar o mesmo tempo.
let decoyHashPromise = null;
function decoyHash() {
    if (!decoyHashPromise) {
        decoyHashPromise = db.hashPasswordAsync(require('crypto').randomBytes(24).toString('base64url')).catch(() => {
            decoyHashPromise = null;
            return '';
        });
    }
    return decoyHashPromise;
}

// Papel gravado em loginLogs: o do aluno, ou o da conta de instrutor ('admin' ou
// 'professor'; 'instructor' quando o e-mail não é de conta nenhuma).
function logRole(kind, account) {
    if (kind === 'student') return 'student';
    if (!account) return 'instructor';
    return account.role === 'professor' ? 'professor' : 'admin';
}

// Alerta por IP: um registro por janela de 10 min, com count atualizado enquanto a
// janela dura. Fica em loginLogs (status 'alert') e vira item da fila do administrador.
const ipAlerts = new Map();

function noteIpFailure(req, now) {
    const ip = getClientIp(req);
    if (!ip) return;
    const failures = rateLimiter.hit(`login-fail-ip:${ip}`, { max: Number.MAX_SAFE_INTEGER, windowMs: IP_ALERT_WINDOW_MS, now });
    if (failures.count < IP_ALERT_THRESHOLD) return;
    const current = ipAlerts.get(ip);
    if (current && now - current.startedAt <= IP_ALERT_WINDOW_MS && (db.memory.loginLogs || []).includes(current.entry)) {
        current.entry.count = failures.count;
        current.entry.lastAt = now;
        return;
    }
    const entry = recordLoginLog(db.memory, {
        email: '',
        role: 'security',
        status: 'alert',
        reason: 'Muitas senhas erradas vindas deste endereço em 10 minutos',
        req,
        count: failures.count,
        now,
    });
    entry.count = failures.count;
    ipAlerts.set(ip, { startedAt: now, entry });
    // Teto da memória dos alertas: os mais antigos saem (o registro continua em loginLogs).
    if (ipAlerts.size > 1000) ipAlerts.delete(ipAlerts.keys().next().value);
}

function resetForTests() {
    ipAlerts.clear();
    accountQueue.clear();
}

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

// A senha digitada (já conferida) seria recusada hoje pela política? Com os dados da
// conta, para a regra de "igual ao e-mail, nome ou matrícula".
function weakPasswordFor(kind, account, secret) {
    return isWeakPassword(secret, {
        kind: kind === 'admin' ? 'instructor' : 'student',
        email: account && account.email,
        name: account && account.name,
        nomeSocial: account && account.nomeSocial,
        matricula: account && account.matricula,
    });
}

function refusal(status, error, extra = {}) {
    return { ok: false, status, body: { error, ...extra } };
}

// purpose: 'login' (padrão) ou 'change_password' (a senha atual pedida na troca de
// senha, do aluno e do instrutor). Na troca do aluno o teto por IP é próprio, do mesmo
// tamanho (changeRateKey): ela só roda com uma sessão válida, e dividir o teto com o
// login fazia a turma atrás do mesmo IP (Wi-Fi da sala) gastar duas tentativas por aluno
// na primeira aula depois da atualização (login com a senha fraca e a troca
// obrigatória). A falha do aluno vai para loginLogs com o motivo change_password.
const PASSWORD_CHECK_PURPOSES = Object.freeze({
    login: { rateKey: settings => settings.rateKey, failReason: 'Credenciais inválidas' },
    change_password: { rateKey: settings => settings.changeRateKey, failReason: 'change_password' },
});

async function attemptPasswordLogin({ kind, email, password, req, purpose = 'login' }) {
    const settings = LOGIN_KINDS[kind];
    if (!settings) throw new TypeError(`Tipo de login desconhecido: ${kind}`);
    const check = PASSWORD_CHECK_PURPOSES[purpose];
    if (!check) throw new TypeError(`Finalidade de conferência desconhecida: ${purpose}`);
    const normalizedEmail = credentialText(email).toLowerCase();
    const secret = credentialText(password);
    if (!normalizedEmail || !secret) return refusal(400, settings.missing);

    const limit = rateLimiter.hit(`${check.rateKey(settings)}:${getClientIp(req)}`, LOGIN_RATE_LIMIT);
    if (!limit.allowed) {
        return refusal(429, settings.tooMany, { loginDelayed: true, retryAfterSeconds: Math.max(1, Math.ceil(limit.retryAfterMs / 1000)) });
    }
    const guardKey = loginGuard.accountKey(kind, normalizedEmail);
    return withAccountTurn(guardKey, () => checkPassword({ kind, settings, check, normalizedEmail, secret, req, guardKey }));
}

async function checkPassword({ kind, settings, check, normalizedEmail, secret, req, guardKey }) {
    const knownAccount = () => accountsWithEmail(settings, normalizedEmail)[0] || null;
    const guard = loginGuard.check(guardKey);
    if (guard.delayed) {
        // Conta esperando o atraso: não confere a senha e não conta outra falha.
        recordLoginLog(db.memory, { email: normalizedEmail, role: logRole(kind, knownAccount()), status: 'throttled', reason: check.failReason, req, aggregate: true });
        scheduleLoginLogSave();
        return delayedRefusal(settings, guard);
    }

    // Contas com o e-mail, na ordem em que estão guardadas; vale a primeira cuja senha
    // confere (o banco antigo pode ter o mesmo e-mail em mais de um aluno). Uma nova
    // volta só acontece quando a senha guardada mudou durante a espera.
    let passwordChanged = false;
    let checkedAny = false;
    for (let round = 0; round < MAX_CHECK_ROUNDS; round += 1) {
        let matched = null;
        let changed = false;
        for (const account of accountsWithEmail(settings, normalizedEmail)) {
            checkedAny = true;
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
            loginGuard.recordSuccess(guardKey);
            return { ok: true, account: matched.account, email: normalizedEmail, rehashed: false, password: matched.stored, weakPassword: weakPasswordFor(kind, matched.account, secret) };
        }
        const upgraded = await db.hashPasswordAsync(secret);
        const holder = currentHolder(settings, normalizedEmail, matched.account, matched.stored);
        if (!holder) { passwordChanged = true; continue; }
        holder.password = upgraded;
        loginGuard.recordSuccess(guardKey);
        return { ok: true, account: holder, email: normalizedEmail, rehashed: true, password: upgraded, weakPassword: weakPasswordFor(kind, holder, secret) };
    }
    // E-mail sem conta: confere contra um valor qualquer, para responder no mesmo tempo.
    if (!checkedAny) {
        const decoy = await decoyHash();
        if (decoy) await db.verifyPasswordAsync(decoy, secret);
    }

    // A senha mudou durante a espera e a digitada não vale para a nova: não é uma senha
    // errada de quem tenta adivinhar (o professor redefiniu no meio), não conta no atraso.
    if (!passwordChanged) {
        const now = Date.now();
        loginGuard.recordFailure(guardKey, now);
        recordLoginLog(db.memory, { email: normalizedEmail, role: logRole(kind, knownAccount()), status: 'fail', reason: check.failReason, req, aggregate: true, now });
        noteIpFailure(req, now);
        scheduleLoginLogSave(now);
    }
    const refused = refusal(401, settings.invalid);
    if (passwordChanged) refused.passwordChanged = true;
    return refused;
}

module.exports = { attemptPasswordLogin, logRole, waitText, LOGIN_RATE_LIMIT, IP_ALERT_THRESHOLD, IP_ALERT_WINDOW_MS, resetForTests };
