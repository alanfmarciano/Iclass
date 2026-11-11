// ---------------------------------------------------------------------------
// Estado da conexão segura (https) deste IClass (H6c, SEG-03, OPS-08).
//
// Uma fonte só para quem precisa saber se há https e com qual certificado: a política
// de acesso (utils/networkPolicy.js: httpsUrl, 'rede', studentsHttps), as rotas
// (/iclass-ca.crt, /api/connection/certificate, network-info), o banner do console e o
// vigia de rede do startServer, que refaz o certificado quando o IP muda.
//
// - prepare({ dir, addresses }) lê ou cria a CA e o certificado do servidor
//   (utils/tlsCertificates.js) e devolve { key, cert } para o listener. Falhou (pasta
//   sem permissão, disco cheio)? O IClass sobe só em http: o estado fica indisponível
//   com o motivo, e o console e a tela Sistema mostram "Conexão segura indisponível".
// - refresh({ addresses }) refaz o que for preciso (IP novo, vencendo em 30 dias) e
//   devolve o material novo só quando o certificado do servidor mudou (para o updateTls).
// - status() devolve o que a tela mostra; caCertificateDer() o arquivo de /iclass-ca.crt.
// - O motivo de "indisponível" é sempre um texto em português, sem o caminho da pasta de
//   dados (no Windows, C:\Users\<usuário>\...) nem a mensagem crua do sistema: essas vão
//   só para o crash.log (utils/errorLog.js). As rotas públicas (/iclass-ca.crt e
//   /api/connection/certificate, lidas sem login) dizem só que está indisponível
//   (publicUnavailableText); o motivo aparece no console e em Sistema → Rede.
//
// Sem prepare (testes com supertest, scripts), o estado é "indisponível" sem motivo.
// ---------------------------------------------------------------------------
const path = require('path');
const runtimePaths = require('../runtimePaths.js');
const { ensureTlsMaterial } = require('./tlsCertificates.js');
const { logError } = require('./errorLog.js');

const UNAVAILABLE_PREFIX = 'Conexão segura indisponível';
const PUBLIC_UNAVAILABLE_TEXT = 'Conexão segura indisponível neste IClass agora.';
// O aviso "o certificado do IClass foi criado de novo" fica em Sistema → Rede por 30 dias
// (tempo de passar nos aparelhos); depois some sozinho. ca-recriada.json continua na
// pasta tls como histórico.
const CA_RECREATED_NOTICE_MS = 30 * 24 * 3600 * 1000;

let state = { available: false, error: null, dir: null, material: null, checkedAt: 0 };

function defaultDir() {
    return path.join(runtimePaths.DATA_DIR, 'tls');
}

// Motivo em português para a falha ao ler ou gravar o certificado. Nunca leva o caminho
// nem a mensagem do sistema (em inglês); o código técnico só quando não há texto próprio.
function describeError(error) {
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'sem permissão para gravar o certificado na pasta de dados (tls)';
    if (code === 'ENOSPC' || code === 'EDQUOT') return 'disco cheio: não foi possível gravar o certificado';
    if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'EISDIR') return 'há um arquivo com o nome "tls" na pasta de dados, no lugar da pasta do certificado: tire esse arquivo de lá e ligue o IClass de novo';
    if (code === 'EBUSY' || code === 'ETXTBSY') return 'o arquivo do certificado está aberto em outro programa (antivírus ou sincronização de pasta)';
    if (code === 'EMFILE' || code === 'ENFILE') return 'arquivos abertos demais neste computador agora';
    if (code === 'EIO') return 'erro de leitura ou gravação no disco';
    const safeCode = /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : '';
    return safeCode ? `não foi possível preparar o certificado (código ${safeCode})` : 'não foi possível preparar o certificado';
}

function apply(dir, material) {
    state = { available: true, error: null, dir, material, checkedAt: Date.now() };
    return material;
}

function fail(dir, error) {
    const text = describeError(error);
    // O detalhe (mensagem do sistema e caminho) vai só para o crash.log, uma vez por motivo:
    // o vigia de rede tenta de novo a cada 30 s.
    if (text !== state.error) {
        logError('conexão segura (https)', error, { details: { motivo: text } });
    }
    state = { available: false, error: text, dir, material: null, checkedAt: Date.now() };
    return null;
}

// Lê ou cria o material. Devolve { key, cert, ... } ou null (só http).
function prepare({ dir = defaultDir(), addresses = [], now } = {}) {
    try {
        return apply(dir, ensureTlsMaterial({ dir, addresses, now }));
    } catch (error) {
        return fail(dir, error);
    }
}

// Confere de novo com os endereços de agora. Devolve o material quando o certificado do
// servidor (ou a CA) mudou, para o listener trocar a quente; null quando nada mudou ou
// falhou (a falha fica em status().error; o certificado antigo continua servindo).
function refresh({ addresses = [], now } = {}) {
    const dir = state.dir || defaultDir();
    const wasAvailable = state.available;
    try {
        const material = ensureTlsMaterial({ dir, addresses, now });
        apply(dir, material);
        return (!wasAvailable || material.changed.server || material.changed.ca) ? material : null;
    } catch (error) {
        // O que já estava carregado continua valendo: o certificado em memória ainda serve.
        if (wasAvailable) {
            state = { ...state, checkedAt: Date.now() };
            return null;
        }
        return fail(dir, error);
    }
}

// O certificado do servidor vence em menos de 30 dias? (o vigia refaz sem esperar o IP mudar)
function serverExpiresBefore(limitMs, now = Date.now()) {
    if (!state.available || !state.material) return false;
    return Date.parse(state.material.server.validTo) - now < limitMs;
}

function isAvailable() {
    return state.available;
}

// IPs do certificado do servidor (o SAN). Só eles servem de endereço seguro
// (utils/networkAddresses.js secureAddressStatus).
function serverIps() {
    return state.available && state.material ? [...state.material.server.ips] : [];
}

function coversIp(ip) {
    return serverIps().includes(String(ip || ''));
}

// A CA foi recriada há menos de 30 dias? (o aviso da tela some depois disso)
function recentRecreation(recreatedAt, now = Date.now()) {
    const time = Date.parse(recreatedAt || '');
    return Number.isFinite(time) && now - time < CA_RECREATED_NOTICE_MS ? recreatedAt : null;
}

function status() {
    if (!state.available || !state.material) {
        return { available: false, error: state.error, ca: null, server: null };
    }
    const { ca, server } = state.material;
    return {
        available: true,
        error: null,
        ca: {
            fingerprintSha256: ca.fingerprintSha256,
            validFrom: ca.validFrom,
            validTo: ca.validTo,
            recreatedAt: recentRecreation(ca.recreatedAt),
        },
        server: { validFrom: server.validFrom, validTo: server.validTo, names: server.names, ips: server.ips },
    };
}

function unavailableText() {
    return state.error ? `${UNAVAILABLE_PREFIX}: ${state.error}.` : `${UNAVAILABLE_PREFIX}.`;
}

function publicUnavailableText() {
    return PUBLIC_UNAVAILABLE_TEXT;
}

function caCertificateDer() {
    return state.available && state.material ? state.material.ca.der : null;
}

// Só nos testes: volta ao estado inicial (sem https).
function resetForTests() {
    state = { available: false, error: null, dir: null, material: null, checkedAt: 0 };
}

module.exports = {
    CA_RECREATED_NOTICE_MS,
    PUBLIC_UNAVAILABLE_TEXT,
    UNAVAILABLE_PREFIX,
    caCertificateDer,
    coversIp,
    describeError,
    isAvailable,
    prepare,
    publicUnavailableText,
    refresh,
    resetForTests,
    serverExpiresBefore,
    serverIps,
    status,
    unavailableText,
};
