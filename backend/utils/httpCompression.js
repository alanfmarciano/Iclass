// Compressão das respostas de texto (fase 2, H2-A: DES-05, DES-13).
//
// Sem o pacote `compression` (pacote novo é proibido): envolve res.send, por onde passam
// res.json, res.sendStatus e as rotas que mandam texto (data.js, apostilas .md, CSV).
// sendFile, streams e ZIP não passam por aqui e ficam como estão. O build já traz os
// arquivos do app comprimidos (.gz e .br, utils/staticAssets.js); aqui é só o que a API
// monta a cada pedido.
//
// Ordem no createApp: montado ANTES do persistenceContext (H1-a). O último a envolver
// res.send é o primeiro a rodar: o persistenceContext espera o COMMIT, decide entre a
// resposta da rota e o 503 retryable e só então chama este envio, que comprime o que
// realmente vai sair. O redator de privacidade do professor (studentPrivacy.js) envolve
// res.json, que chama res.send: o corpo já chega aqui mascarado.
//
// Comprime só quando todas as condições valem: o navegador aceita gzip, o pedido não é
// HEAD, o status não é 204 nem 304, a resposta ainda não tem Content-Encoding nem
// `Cache-Control: no-transform`, o corpo é texto ou Buffer de um tipo de texto e o
// tamanho fica entre minBytes e maxBytes. O gzip roda no pool de threads (zlib.gzip
// assíncrono), sem parar o servidor. Brotli fica para quando houver HTTPS: na rede da
// sala, em http, o navegador só anuncia gzip.
const zlib = require('zlib');

const COMPRESSIBLE_TYPE = /^(application\/(json|javascript)|text\/)/i;
const DEFAULTS = { minBytes: 1024, maxBytes: 32 * 1024 * 1024, level: 6 };

// O cabeçalho Accept-Encoding aceita a codificação (q > 0)? 'gzip' também vale como
// 'x-gzip'; '*' vale para o que não foi citado. q inválido conta como recusa.
function acceptsEncoding(header, encoding) {
    if (!header) return false;
    const wanted = String(encoding || '').toLowerCase();
    const aliases = wanted === 'gzip' ? ['gzip', 'x-gzip'] : [wanted];
    let named = null;
    let star = null;
    for (const part of String(header).split(',')) {
        const [rawName, ...params] = part.split(';');
        const name = rawName.trim().toLowerCase();
        if (!name) continue;
        let q = 1;
        for (const param of params) {
            const match = /^\s*q\s*=\s*(.*?)\s*$/i.exec(param);
            if (match) q = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(match[1]) ? Number(match[1]) : 0;
        }
        if (aliases.includes(name)) named = Math.max(named === null ? 0 : named, q);
        else if (name === '*') star = q;
    }
    if (named !== null) return named > 0;
    return star !== null && star > 0;
}

function hasNoTransform(res) {
    const cacheControl = res.get('Cache-Control');
    return typeof cacheControl === 'string' && /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(cacheControl);
}

// Texto sai em UTF-8 (como o Express faz com string): o charset vai no Content-Type,
// porque o Buffer comprimido não passa pela regra do Express que o acrescenta.
function withUtf8Charset(type) {
    return `${String(type).replace(/;\s*charset=[^;]*/ig, '')}; charset=utf-8`;
}

// Status e cabeçalhos da resposta no momento do envio. Enquanto o gzip roda, a resposta
// ainda não saiu (res.headersSent é false), e quem vem depois pode mexer nela: a rota que
// respondeu um CSV e depois lançou leva o errorHandler a tirar o Content-Disposition e o
// Content-Type e a pôr o 500. Sem compressão, a resposta já teria saído e nada disso a
// alcançaria; com a compressão, a resposta que sai é a mesma: a guardada aqui.
function snapshotResponse(res) {
    return { statusCode: res.statusCode, statusMessage: res.statusMessage, headers: res.getHeaders() };
}

function restoreResponse(res, snapshot) {
    for (const name of res.getHeaderNames()) {
        if (!Object.prototype.hasOwnProperty.call(snapshot.headers, name)) res.removeHeader(name);
    }
    for (const name of Object.keys(snapshot.headers)) {
        if (res.getHeader(name) !== snapshot.headers[name]) res.setHeader(name, snapshot.headers[name]);
    }
    res.statusCode = snapshot.statusCode;
    res.statusMessage = snapshot.statusMessage;
}

function compressTextResponses(options = {}) {
    const { minBytes, maxBytes, level } = { ...DEFAULTS, ...options };
    return function compressTextResponsesMiddleware(req, res, next) {
        const originalSend = res.send;
        const originalEnd = res.end;
        // idle: nada enviado; pending: comprimindo; sent: já entregue ao Express.
        let state = 'idle';
        res.send = function sendCompressed(body) {
            if (state === 'pending') {
                // A primeira resposta ainda está no gzip: um segundo envio (rota que
                // respondeu e depois lançou) é ignorado, como seria com a primeira já
                // enviada. Antes do gzip o Express lançava "headers already sent".
                console.warn('[COMPRESSÃO] resposta enviada duas vezes', req.path);
                return this;
            }
            if (state === 'sent') return originalSend.call(this, body);
            const isText = typeof body === 'string';
            // Objeto: o Express chama res.json, que volta aqui com o texto.
            if (!isText && !Buffer.isBuffer(body)) return originalSend.call(this, body);
            if (isText && !this.get('Content-Type')) this.type('html');
            const type = String(this.get('Content-Type') || '');
            if (!COMPRESSIBLE_TYPE.test(type)
                || this.statusCode === 204 || this.statusCode === 304
                || this.get('Content-Encoding') || hasNoTransform(this)) {
                return originalSend.call(this, body);
            }
            const size = isText ? Buffer.byteLength(body, 'utf8') : body.length;
            if (size < minBytes || size > maxBytes) return originalSend.call(this, body);
            // A resposta muda com o Accept-Encoding, mesmo quando este pedido não aceita gzip.
            this.vary('Accept-Encoding');
            if (req.method === 'HEAD' || !acceptsEncoding(req.get('Accept-Encoding'), 'gzip')) {
                return originalSend.call(this, body);
            }
            state = 'pending';
            if (isText) this.set('Content-Type', withUtf8Charset(type));
            const snapshot = snapshotResponse(this);
            const input = isText ? Buffer.from(body, 'utf8') : body;
            zlib.gzip(input, { level }, (err, compressed) => {
                state = 'sent';
                if (res.headersSent || res.writableEnded) return;
                restoreResponse(res, snapshot);
                if (err) {
                    // Sem gzip (não deveria acontecer): vai o corpo original.
                    originalSend.call(res, input);
                    return;
                }
                res.set('Content-Encoding', 'gzip');
                originalSend.call(res, compressed);
            });
            return this;
        };
        // res.end direto durante o gzip (sem passar por res.send) também não encerra a
        // resposta pela metade: a que está no gzip sai inteira.
        res.end = function endAfterCompression(...args) {
            if (state === 'pending') {
                console.warn('[COMPRESSÃO] resposta encerrada durante a compressão', req.path);
                return this;
            }
            return originalEnd.apply(this, args);
        };
        next();
    };
}

module.exports = { acceptsEncoding, compressTextResponses, COMPRESSIBLE_TYPE };
