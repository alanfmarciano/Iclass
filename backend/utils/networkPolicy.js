// ---------------------------------------------------------------------------
// Acesso ao painel do professor conforme o aparelho (H6b, SEG-03).
//
// settings.network.adminAccess (utils/settings.js) decide quem abre o painel:
// - 'rede-sem-https' (padrão, e também o banco antigo sem o campo): qualquer aparelho
//   da rede, como antes. Em outro aparelho, por http, a tela do professor mostra um
//   aviso fixo de que a senha passa pela rede sem proteção (connectionInfo.insecureAdmin);
// - 'local': só o computador onde o IClass está ligado. De outro aparelho, todo pedido
//   de professor recebe 403 { adminAccess: 'local-only' };
// - 'rede': outros aparelhos só pela conexão segura (https). Pedido por http de outro
//   aparelho recebe 403 { adminAccess: 'https-required', httpsUrl }. Esta versão ainda
//   não tem https (H6c): a rota de rede recusa essa escolha, e um valor 'rede' vindo de
//   fora (backup de versão nova) deixa o painel só neste computador até alguém trocar.
//
// "Este computador": o endereço de quem conecta (socket, nunca cabeçalho) é de loopback
// (127.0.0.0/8, ::1) ou um dos endereços atuais dos adaptadores desta máquina (o
// professor que abre pelo IP da rede no próprio computador). Com TEST_MODE=1, os IPs
// de ICLASS_TEST_REMOTE_IPS (separados por vírgula) contam como outro aparelho, para
// conferir a regra numa máquina só.
//
// "Pedido de professor": caminho em /api/admin, o POST /api/session/admin-login, pedido
// com o cabeçalho x-admin-session, ou com um token de sessão de professor em ?access=
// (link de arquivo de apostila; repetido, conta cada valor) ou em x-session-token (a
// entrega de arquivos aceita os dois). Aluno e páginas públicas nunca passam por aqui.
// O Sair do professor (POST /api/session/logout) também não: só apaga a própria sessão.
//
// O middleware fica no createApp depois do persistenceContext e antes de /assets, dos
// arquivos e de qualquer rota (contrato da ordem do createApp, passo 9).
// ---------------------------------------------------------------------------
const os = require('os');
const settingsUtil = require('./settings.js');
const { checkAdminSessionToken } = require('./authSessions.js');

const LOCAL_ONLY_MESSAGE = 'O painel do professor só abre no computador onde o IClass está ligado. O administrador pode liberar outros aparelhos em Sistema → Rede.';
const HTTPS_REQUIRED_MESSAGE = 'O painel do professor em outro aparelho só abre pela conexão segura (https), e ela ainda não está disponível neste IClass. Use o painel no computador onde o IClass está ligado.';
const ADDRESS_CACHE_MS = 2000;

let addressCache = { at: 0, addresses: new Set() };

function normalizeAddress(value) {
    let ip = String(value || '').trim().toLowerCase();
    if (!ip) return '';
    const zone = ip.indexOf('%');
    if (zone !== -1) ip = ip.slice(0, zone);
    if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
    return ip;
}

function isLoopbackAddress(ip) {
    return ip === '::1' || /^127\./.test(ip);
}

// Endereços atuais dos adaptadores desta máquina, relidos no máximo a cada 2 s (o
// Wi-Fi pode trocar de IP com o IClass ligado).
function localAddresses(now = Date.now()) {
    if (now - addressCache.at < ADDRESS_CACHE_MS) return addressCache.addresses;
    const addresses = new Set();
    try {
        Object.values(os.networkInterfaces() || {}).forEach(list => {
            (list || []).forEach(item => {
                const ip = normalizeAddress(item && item.address);
                if (ip) addresses.add(ip);
            });
        });
    } catch (error) { /* sem a lista, só o loopback conta como este computador */ }
    addressCache = { at: now, addresses };
    return addresses;
}

function testRemoteAddresses() {
    if (process.env.TEST_MODE !== '1') return null;
    const list = String(process.env.ICLASS_TEST_REMOTE_IPS || '').split(',').map(normalizeAddress).filter(Boolean);
    return list.length ? new Set(list) : null;
}

function isThisComputerRequest(req) {
    const ip = normalizeAddress(req && req.socket && req.socket.remoteAddress);
    if (!ip) return false;
    const remote = testRemoteAddresses();
    if (remote && remote.has(ip)) return false;
    if (isLoopbackAddress(ip)) return true;
    return localAddresses().has(ip);
}

function isSecureRequest(req) {
    return !!(req && req.socket && req.socket.encrypted);
}

// Há conexão segura (https) neste IClass? Ainda não: entra com o H6c, que também
// passa a montar o httpsUrl.
function httpsAvailable() {
    return false;
}

function httpsUrlFor() {
    return null;
}

// Tokens que a entrega de arquivos (server.js, sendControlledFile) aceitaria como sessão
// de professor fora do x-admin-session: x-session-token e cada ?access= do pedido.
function otherSessionTokens(req) {
    const tokens = [];
    const sessionHeader = req.headers && req.headers['x-session-token'];
    if (typeof sessionHeader === 'string' && sessionHeader) tokens.push(sessionHeader);
    const access = req.query && req.query.access;
    (Array.isArray(access) ? access : [access]).forEach(value => {
        if (typeof value === 'string' && value) tokens.push(value);
    });
    return tokens;
}

// Sair (POST /api/session/logout) passa sempre: só encerra a própria sessão, e o
// aparelho recusado consegue apagar o token que ainda guardava.
function isInstructorRequest(req) {
    const pathName = String(req.path || '').toLowerCase();
    if (req.method === 'POST' && (pathName === '/api/session/logout' || pathName === '/api/session/logout/')) return false;
    if (pathName === '/api/admin' || pathName.startsWith('/api/admin/')) return true;
    if (pathName === '/api/session/admin-login' || pathName === '/api/session/admin-login/') return true;
    const header = req.headers && req.headers['x-admin-session'];
    if ((typeof header === 'string' && header) || (Array.isArray(header) && header.length)) return true;
    return otherSessionTokens(req).some(token => checkAdminSessionToken(token).ok);
}

// Decisão para um pedido de professor. Pura, para os testes.
function adminAccessDecision({ mode, thisComputer, secure, httpsUrl = null }) {
    if (thisComputer) return { allowed: true, insecure: false };
    if (mode === 'local') {
        return { allowed: false, body: { error: LOCAL_ONLY_MESSAGE, adminAccess: 'local-only' } };
    }
    if (mode === 'rede') {
        if (secure) return { allowed: true, insecure: false };
        return { allowed: false, body: { error: HTTPS_REQUIRED_MESSAGE, adminAccess: 'https-required', httpsUrl } };
    }
    return { allowed: true, insecure: !secure };
}

function thisComputerFor(req, isThisComputer) {
    if (typeof req.isThisComputer === 'function') return req.isThisComputer();
    return isThisComputer(req);
}

// Como esta conexão é tratada, para a tela de login e o aviso do painel
// (GET /api/connection). Não revela segredo: só o que vale para quem pergunta.
function connectionInfo(req, { isThisComputer = isThisComputerRequest } = {}) {
    const mode = settingsUtil.networkSettings().adminAccess;
    const thisComputer = thisComputerFor(req, isThisComputer);
    const secure = isSecureRequest(req);
    const httpsUrl = httpsUrlFor(req);
    const decision = adminAccessDecision({ mode, thisComputer, secure, httpsUrl });
    return {
        secure,
        thisComputer,
        adminAccess: decision.allowed ? 'ok' : decision.body.adminAccess,
        adminAccessMode: mode,
        insecureAdmin: decision.allowed && decision.insecure,
        tlsAvailable: httpsAvailable(),
        studentsHttps: false,
        httpsUrl,
    };
}

// createApp(options): options.isThisComputer troca a regra de "este computador" nos
// testes (supertest sempre conecta pelo loopback).
function createNetworkPolicy({ isThisComputer = isThisComputerRequest } = {}) {
    return function networkPolicy(req, res, next) {
        let memo;
        req.isThisComputer = () => {
            if (memo === undefined) memo = !!isThisComputer(req);
            return memo;
        };
        if (!isInstructorRequest(req)) return next();
        const decision = adminAccessDecision({
            mode: settingsUtil.networkSettings().adminAccess,
            thisComputer: req.isThisComputer(),
            secure: isSecureRequest(req),
            httpsUrl: httpsUrlFor(req),
        });
        if (decision.allowed) return next();
        return res.status(403).json(decision.body);
    };
}

module.exports = {
    LOCAL_ONLY_MESSAGE,
    HTTPS_REQUIRED_MESSAGE,
    adminAccessDecision,
    connectionInfo,
    createNetworkPolicy,
    httpsAvailable,
    isInstructorRequest,
    isThisComputerRequest,
    normalizeAddress,
};
