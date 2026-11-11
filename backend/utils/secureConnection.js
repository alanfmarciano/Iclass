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
//
// Sem prepare (testes com supertest, scripts), o estado é "indisponível" sem motivo.
// ---------------------------------------------------------------------------
const path = require('path');
const runtimePaths = require('../runtimePaths.js');
const { ensureTlsMaterial } = require('./tlsCertificates.js');

const UNAVAILABLE_PREFIX = 'Conexão segura indisponível';

let state = { available: false, error: null, dir: null, material: null, checkedAt: 0 };

function defaultDir() {
    return path.join(runtimePaths.DATA_DIR, 'tls');
}

function describeError(error) {
    const code = error && typeof error === 'object' && error.code ? String(error.code) : '';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'sem permissão para gravar o certificado na pasta de dados (tls)';
    if (code === 'ENOSPC') return 'disco cheio: não foi possível gravar o certificado';
    const message = error && error.message ? String(error.message) : String(error || 'erro desconhecido');
    return code ? `${code}: ${message}` : message;
}

function apply(dir, material) {
    state = { available: true, error: null, dir, material, checkedAt: Date.now() };
    return material;
}

function fail(dir, error) {
    state = { available: false, error: describeError(error), dir, material: null, checkedAt: Date.now() };
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
            recreatedAt: ca.recreatedAt || null,
        },
        server: { validFrom: server.validFrom, validTo: server.validTo, names: server.names, ips: server.ips },
    };
}

function unavailableText() {
    return state.error ? `${UNAVAILABLE_PREFIX}: ${state.error}.` : `${UNAVAILABLE_PREFIX}.`;
}

function caCertificateDer() {
    return state.available && state.material ? state.material.ca.der : null;
}

// Só nos testes: volta ao estado inicial (sem https).
function resetForTests() {
    state = { available: false, error: null, dir: null, material: null, checkedAt: 0 };
}

module.exports = {
    UNAVAILABLE_PREFIX,
    caCertificateDer,
    isAvailable,
    prepare,
    refresh,
    resetForTests,
    serverExpiresBefore,
    status,
    unavailableText,
};
