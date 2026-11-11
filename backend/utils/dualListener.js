// ---------------------------------------------------------------------------
// http e https na MESMA porta (H6c, SEG-03 e OPS-08).
//
// Uma porta só (3000): não muda a regra do firewall nem o launcher, o localhost continua
// em http e o pedido http de outro aparelho pode ser redirecionado no próprio endereço.
// O primeiro byte de cada conexão decide: 0x16 é o começo de um handshake TLS e vai para
// o servidor https; qualquer outro vai para o http. Os dois atendem com o mesmo handler
// trocável do startServer (H3c: boot e depois o app), então req.socket.encrypted diz por
// onde o pedido chegou.
//
// - Conexão que não manda nenhum byte em firstByteTimeoutMs (15 s) é fechada.
// - Erro de socket e handshake TLS recusado (aparelho sem a CA, certificado aceito só
//   com aviso) fecham só aquela conexão; nunca derrubam o servidor.
// - Sem material TLS (tls null: a pasta de dados não deixou gravar o certificado), o
//   servidor atende só http, e a conexão que tenta TLS é fechada.
// - updateTls({ key, cert }) troca o certificado a quente (setSecureContext): o vigia de
//   rede do startServer refaz o certificado quando o IP muda, sem reiniciar nada.
//
// O objeto devolvido é um net.Server com o mesmo jeito de usar do http.Server que o
// startServer já tratava: listen, close, address, listening, os eventos 'listening' e
// 'error' (porta ocupada), closeIdleConnections() e closeAllConnections().
// ---------------------------------------------------------------------------
const http = require('http');
const https = require('https');
const net = require('net');

const TLS_HANDSHAKE_BYTE = 0x16;
const FIRST_BYTE_TIMEOUT_MS = 15000;

function createDualServer(handler, { tls = null, firstByteTimeoutMs = FIRST_BYTE_TIMEOUT_MS } = {}) {
    if (typeof handler !== 'function') throw new TypeError('handler obrigatório');
    const httpServer = http.createServer(handler);
    let httpsServer = null;
    // Conexões ainda esperando o primeiro byte (as outras ficam com o http/https).
    const waiting = new Set();

    function createHttpsServer(material) {
        const server = https.createServer({ key: material.key, cert: material.cert }, handler);
        // Aparelho que recusa o certificado (sem a CA) ou fala TLS errado: só a conexão cai.
        server.on('tlsClientError', (err, socket) => { try { socket.destroy(); } catch (e) { /* já fechada */ } });
        server.on('error', () => {});
        if (front.listening) server.emit('listening');
        return server;
    }

    function route(socket) {
        socket.on('error', () => socket.destroy());
        waiting.add(socket);
        const timer = setTimeout(() => socket.destroy(), firstByteTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        const done = () => {
            clearTimeout(timer);
            waiting.delete(socket);
        };
        socket.once('close', done);
        socket.once('readable', function onReadable() {
            if (socket.destroyed) return done();
            const chunk = socket.read(1);
            if (chunk === null) {
                // Fim sem dados ou leitura vazia: espera o próximo pedaço (ou o close).
                if (!socket.readableEnded) socket.once('readable', onReadable);
                return undefined;
            }
            done();
            socket.removeListener('close', done);
            socket.unshift(chunk);
            if (chunk[0] === TLS_HANDSHAKE_BYTE) {
                if (!httpsServer) return socket.destroy();
                return httpsServer.emit('connection', socket);
            }
            return httpServer.emit('connection', socket);
        });
    }

    const front = net.createServer({ pauseOnConnect: true }, route);
    if (tls && tls.key && tls.cert) httpsServer = createHttpsServer(tls);

    // O http.Server e o https.Server nunca escutam (quem escuta é o front): o controle de
    // conexões deles (tempo-limite de cabeçalho e de pedido, closeIdleConnections) começa
    // no evento 'listening', então ele é repassado.
    front.on('listening', () => {
        httpServer.emit('listening');
        if (httpsServer) httpsServer.emit('listening');
    });
    front.on('close', () => {
        // Para o controle de conexões dos dois (sem a porta, o close só limpa os timers).
        [httpServer, httpsServer].forEach(server => { if (server) server.close(() => {}); });
    });

    front.closeIdleConnections = () => {
        httpServer.closeIdleConnections();
        if (httpsServer) httpsServer.closeIdleConnections();
        waiting.forEach(socket => socket.destroy());
    };
    front.closeAllConnections = () => {
        httpServer.closeAllConnections();
        if (httpsServer) httpsServer.closeAllConnections();
        waiting.forEach(socket => socket.destroy());
    };
    // Troca (ou liga) o certificado sem reiniciar: conexões novas já usam o novo.
    front.updateTls = material => {
        if (!material || !material.key || !material.cert) return false;
        if (httpsServer) httpsServer.setSecureContext({ key: material.key, cert: material.cert });
        else httpsServer = createHttpsServer(material);
        return true;
    };
    front.tlsEnabled = () => !!httpsServer;
    front.httpServer = httpServer;
    front.httpsServer = () => httpsServer;
    return front;
}

// Abre a porta: resolve com o servidor quando está escutando; rejeita com o erro do
// listen (EADDRINUSE, EACCES...), para o startServer sair com o código 2.
function listenHttpAndHttps({ handler, port, host = '0.0.0.0', tls = null, firstByteTimeoutMs } = {}) {
    const server = createDualServer(handler, { tls, firstByteTimeoutMs });
    return new Promise((resolve, reject) => {
        const onError = err => {
            server.off('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve(server);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

module.exports = {
    FIRST_BYTE_TIMEOUT_MS,
    createDualServer,
    listenHttpAndHttps,
};
