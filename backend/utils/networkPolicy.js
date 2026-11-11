// ---------------------------------------------------------------------------
// Acesso ao painel do professor conforme o aparelho (H6b e H6c, SEG-03).
//
// settings.network.adminAccess (utils/settings.js) decide quem abre o painel:
// - 'rede-sem-https' (padrão, e também o banco antigo sem o campo): qualquer aparelho
//   da rede, como antes. Em outro aparelho, por http, a tela do professor mostra um
//   aviso fixo de que a senha passa pela rede sem proteção (connectionInfo.insecureAdmin),
//   com o link "Usar conexão segura" para o guia /certificado;
// - 'local': só o computador onde o IClass está ligado. De outro aparelho, todo pedido
//   de professor recebe 403 { adminAccess: 'local-only' };
// - 'rede': outros aparelhos só pela conexão segura (https na mesma porta, H6c). Por
//   http, de outro aparelho: a página do painel (e o login do instrutor) é redirecionada
//   para o endereço https (302), e a API responde 403 { adminAccess: 'https-required',
//   httpsUrl } com um texto que aponta para o guia /certificado. Sem a conexão segura
//   funcionando (o certificado não pôde ser gravado), não há para onde mandar: o painel
//   fica só neste computador, com o motivo no texto.
//
// settings.network.studentsHttps (padrão false): ligado, e com a conexão segura
// funcionando, o aluno que abre uma página por http em outro aparelho vai para o https
// (302), e o login, o cadastro e o "esqueci a senha" por http recebem 403
// { httpsRequired: true, httpsUrl }. O resto da API do aluno continua em http: uma
// página aberta antes da troca não quebra no meio do uso. O guia /certificado e o
// arquivo /iclass-ca.crt nunca são redirecionados (é por eles que o aparelho passa a
// confiar no https). Nenhuma resposta manda Strict-Transport-Security: os alunos (e o
// computador do IClass, em http://localhost) continuam usando http no mesmo endereço.
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
const secureConnection = require('./secureConnection.js');
const { networkAddresses } = require('./networkAddresses.js');

const LOCAL_ONLY_MESSAGE = 'O painel do professor só abre no computador onde o IClass está ligado. O administrador pode liberar outros aparelhos em Sistema → Rede.';
// 'rede' com a conexão segura funcionando: o texto aponta para o endereço seguro e para o
// guia do certificado (cada aparelho instala uma vez).
const HTTPS_REQUIRED_MESSAGE = 'O painel do professor em outro aparelho só abre pela conexão segura (https). Abra o endereço seguro. Se o navegador avisar que a conexão não é particular, instale antes o certificado do IClass neste aparelho: o passo a passo está na página /certificado.';
// 'rede' sem a conexão segura (o certificado não pôde ser gravado neste computador).
const HTTPS_UNAVAILABLE_MESSAGE = 'O painel do professor em outro aparelho só abre pela conexão segura (https), e ela não está funcionando neste IClass agora. Use o painel no computador onde o IClass está ligado; o motivo aparece em Sistema → Rede.';
const STUDENT_HTTPS_MESSAGE = 'Abra o endereço seguro para entrar.';
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

// Há conexão segura (https) neste IClass? Sim quando o certificado foi lido ou criado na
// pasta de dados (utils/secureConnection.js, preparado pelo startServer).
function httpsAvailable() {
    return secureConnection.isAvailable();
}

function hostHeaderName(req) {
    const raw = String((req && req.headers && req.headers.host) || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']') === -1 ? raw.length : raw.indexOf(']'));
    return raw.split(':')[0];
}

// Porta do endereço seguro: a do listener (http e https na mesma porta), nunca a do Host.
function listenerPort(req) {
    const port = req && req.socket && Number(req.socket.localPort);
    return Number.isInteger(port) && port > 0 ? port : (Number(process.env.PORT) || 3000);
}

// Endereço seguro para quem pergunta: 'https://<host>:<porta>'. O host vem do cabeçalho
// Host só quando é 'localhost' ou um IPv4 atual desta máquina (um Host forjado como
// 'evil.com' não vira link); senão, o IP recomendado para os alunos; sem rede, o IP em
// que o pedido chegou. null quando não há conexão segura.
function httpsUrlFor(req) {
    if (!httpsAvailable()) return null;
    const port = listenerPort(req);
    const host = hostHeaderName(req);
    if (host === 'localhost' || (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && (host.startsWith('127.') || localAddresses().has(host)))) {
        return `https://${host}:${port}`;
    }
    const recommended = networkAddresses({ port }).recommended;
    if (recommended) return `https://${recommended.address}:${port}`;
    const local = normalizeAddress(req && req.socket && req.socket.localAddress);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(local)) return `https://${local}:${port}`;
    return `https://localhost:${port}`;
}

// Os alunos entram pela conexão segura? settings.network.studentsHttps ligado E a conexão
// segura funcionando: sem o certificado, mandar a turma para o https deixaria todos sem
// entrar. Enquanto for false, o endereço da sala e o QR (H6a, utils/networkAddresses.js)
// usam http://IP:porta.
function studentsHttpsEnabled() {
    return settingsUtil.networkSettings().studentsHttps === true && httpsAvailable();
}

// Páginas do painel do professor (as rotas do instrutor no App.jsx, fora a '/', que
// também é a entrada dos alunos pelo QR). Um teste confere esta lista com
// ADMIN_PATH_PERMISSIONS de web/src/lib/adminPermissions.js.
const ADMIN_PANEL_PAGES = Object.freeze([
    '/endereco', '/provas', '/monitor', '/resultados', '/materiais', '/editor', '/biblioteca',
    '/turmas', '/alunos', '/matriculas', '/chamada', '/diretorio', '/admins', '/avisos',
    '/calendario', '/forum', '/escolas', '/identidade', '/sistema', '/auditoria', '/lgpd',
]);
// Nunca redirecionados para o https: é por eles que o aparelho passa a confiar no https.
const CERTIFICATE_PATHS = Object.freeze(['/certificado', '/iclass-ca.crt']);

function lowerPath(req) {
    return String((req && req.path) || '').toLowerCase().replace(/\/+$/, '') || '/';
}

function isReadMethod(req) {
    return req && (req.method === 'GET' || req.method === 'HEAD');
}

function isCertificatePath(pathName) {
    return CERTIFICATE_PATHS.some(item => pathName === item || pathName.startsWith(`${item}/`));
}

// Abertura de página (a barra de endereço): GET/HEAD fora de /api, dos arquivos do app e
// dos arquivos enviados, sem extensão (ou .html). Um pedaço do app (/assets) ou uma
// imagem pedidos por uma página já aberta em http seguem em http.
function isPageNavigation(req) {
    if (!isReadMethod(req)) return false;
    const pathName = lowerPath(req);
    if (pathName === '/api' || pathName.startsWith('/api/')) return false;
    if (/^\/(assets|uploads|imagens)(\/|$)/.test(pathName)) return false;
    if (isCertificatePath(pathName)) return false;
    const last = pathName.split('/').pop();
    return !last.includes('.') || last.endsWith('.html');
}

// Página do painel: uma das rotas do instrutor ou o login do instrutor (/login?mode=admin).
function isAdminPanelPage(req) {
    if (!isPageNavigation(req)) return false;
    const pathName = lowerPath(req);
    if (pathName === '/login') {
        const mode = req.query && req.query.mode;
        return (Array.isArray(mode) ? mode[mode.length - 1] : mode) === 'admin';
    }
    return ADMIN_PANEL_PAGES.some(page => pathName === page || pathName.startsWith(`${page}/`));
}

const STUDENT_ENTRY_ROUTES = Object.freeze(['/api/student/login', '/api/student/register', '/api/student/recover']);

function isStudentEntryPost(req) {
    return req && req.method === 'POST' && STUDENT_ENTRY_ROUTES.includes(lowerPath(req));
}

function redirectToHttps(req, res, httpsUrl) {
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, `${httpsUrl}${req.originalUrl || req.url || '/'}`);
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

// Decisão para um pedido de professor. Pura, para os testes. As duas recusas têm o
// formato combinado entre os grupos (contrato 9): { error, adminAccess, httpsUrl }, com
// httpsUrl null quando não há conexão segura.
function adminAccessDecision({ mode, thisComputer, secure, httpsUrl = null }) {
    if (thisComputer) return { allowed: true, insecure: false };
    if (mode === 'local') {
        return { allowed: false, body: { error: LOCAL_ONLY_MESSAGE, adminAccess: 'local-only', httpsUrl } };
    }
    if (mode === 'rede') {
        if (secure) return { allowed: true, insecure: false };
        return { allowed: false, body: { error: httpsUrl ? HTTPS_REQUIRED_MESSAGE : HTTPS_UNAVAILABLE_MESSAGE, adminAccess: 'https-required', httpsUrl } };
    }
    return { allowed: true, insecure: !secure };
}

// Como o pedido é visto (este computador? conexão cifrada? endereço seguro?). O
// middleware guarda isto em req.networkAccess para as rotas (GET /api/connection,
// network-settings) enxergarem o mesmo que a política; fora dele, calcula na hora.
// options (createApp({ network }), só nos testes) troca cada regra: isThisComputer(req),
// isSecure(req) e httpsUrl(req).
function networkDetectors(options = {}) {
    return {
        isThisComputer: typeof options.isThisComputer === 'function' ? options.isThisComputer : isThisComputerRequest,
        isSecure: typeof options.isSecure === 'function' ? options.isSecure : isSecureRequest,
        httpsUrl: typeof options.httpsUrl === 'function' ? options.httpsUrl : httpsUrlFor,
    };
}

function createNetworkAccess(req, options) {
    const detectors = networkDetectors(options);
    let memo;
    let urlMemo;
    return {
        thisComputer() {
            if (memo === undefined) memo = !!detectors.isThisComputer(req);
            return memo;
        },
        secure: !!detectors.isSecure(req),
        // Calculado só quando alguém pergunta (a maior parte dos pedidos não precisa).
        get httpsUrl() {
            if (urlMemo === undefined) urlMemo = detectors.httpsUrl(req) || null;
            return urlMemo;
        },
    };
}

function networkAccessFor(req, options) {
    if (req && req.networkAccess && typeof req.networkAccess.thisComputer === 'function') return req.networkAccess;
    return createNetworkAccess(req, options);
}

// Como esta conexão é tratada, para a tela de login e o aviso do painel
// (GET /api/connection). Não revela segredo: só o que vale para quem pergunta.
function connectionInfo(req, options = {}) {
    const mode = settingsUtil.networkSettings().adminAccess;
    const access = networkAccessFor(req, options);
    const thisComputer = access.thisComputer();
    const { secure, httpsUrl } = access;
    const decision = adminAccessDecision({ mode, thisComputer, secure, httpsUrl });
    return {
        secure,
        thisComputer,
        adminAccess: decision.allowed ? 'ok' : decision.body.adminAccess,
        adminAccessMode: mode,
        insecureAdmin: decision.allowed && decision.insecure,
        tlsAvailable: httpsAvailable(),
        studentsHttps: studentsHttpsEnabled(),
        httpsUrl,
    };
}

// createApp(options): options.network = { isThisComputer, isSecure, httpsUrl } troca as
// regras nos testes (supertest sempre conecta pelo loopback e sem cifra);
// options.isThisComputer sozinho continua valendo.
function createNetworkPolicy(options = {}) {
    return function networkPolicy(req, res, next) {
        const access = createNetworkAccess(req, options);
        req.networkAccess = access;
        // Conexão sem cifra de outro aparelho, com endereço seguro para onde mandar.
        const plainRemote = !access.secure && !access.thisComputer() && !!access.httpsUrl;
        if (plainRemote) {
            const network = settingsUtil.networkSettings();
            const studentsHttps = network.studentsHttps === true;
            if (network.adminAccess === 'rede' && isAdminPanelPage(req)) return redirectToHttps(req, res, access.httpsUrl);
            if (studentsHttps && isPageNavigation(req)) return redirectToHttps(req, res, access.httpsUrl);
            if (studentsHttps && isStudentEntryPost(req)) {
                return res.status(403).json({ error: STUDENT_HTTPS_MESSAGE, httpsRequired: true, httpsUrl: access.httpsUrl });
            }
        }
        if (!isInstructorRequest(req)) return next();
        const decision = adminAccessDecision({
            mode: settingsUtil.networkSettings().adminAccess,
            thisComputer: access.thisComputer(),
            secure: access.secure,
            httpsUrl: access.httpsUrl,
        });
        if (decision.allowed) return next();
        return res.status(403).json(decision.body);
    };
}

module.exports = {
    ADMIN_PANEL_PAGES,
    LOCAL_ONLY_MESSAGE,
    HTTPS_REQUIRED_MESSAGE,
    HTTPS_UNAVAILABLE_MESSAGE,
    STUDENT_HTTPS_MESSAGE,
    adminAccessDecision,
    httpsUrlFor,
    isAdminPanelPage,
    isPageNavigation,
    connectionInfo,
    createNetworkPolicy,
    httpsAvailable,
    isInstructorRequest,
    isThisComputerRequest,
    normalizeAddress,
    studentsHttpsEnabled,
};
