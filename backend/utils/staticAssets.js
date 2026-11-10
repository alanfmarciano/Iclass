// Arquivos do app em /assets (fase 2, H2-A: DES-05).
//
// O Vite põe o hash do conteúdo no nome de cada arquivo de web/dist/assets
// (index-<hash>.js), então o mesmo nome nunca muda de conteúdo e pode ficar no aparelho
// para sempre: `Cache-Control: public, max-age=31536000, immutable`. Antes, todo .js saía
// com no-store e o celular baixava o app inteiro a cada abertura ou recarga.
//
// O handler é terminal e nunca passa adiante: um nome que não existe responde 404 com
// no-store, nunca o index.html. Com cache imutável, o HTML do fallback do app no lugar
// de um .js ficaria gravado no aparelho por um ano.
//
// O build grava ao lado de cada arquivo de texto as versões comprimidas
// (web/scripts/compress-assets.mjs): <nome>.br e <nome>.gz. Sai a .br quando o navegador
// aceita br (só em HTTPS), senão a .gz quando aceita gzip, senão o original. Sem as
// versões comprimidas (build antigo), sai o original, também com cache imutável.
//
// Usado pelo createApp (posição 10 do contrato) e pelo handler de boot do H3c.
const fs = require('fs');
const path = require('path');
const { acceptsEncoding } = require('./httpCompression.js');
const { logError } = require('./errorLog.js');

// Só nomes simples, como os que o Vite gera: sem barra, sem '%', sem começar com ponto.
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PRECOMPRESSED_SUFFIX = /\.(gz|br)$/i;
const ASSET_MAX_AGE = '365d';
const NOT_FOUND_TEXT = 'Arquivo não encontrado.';

function setNoStore(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

function sendAssetNotFound(res) {
    setNoStore(res);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.status(404).type('text/plain').send(NOT_FOUND_TEXT);
}

async function isFile(file) {
    try {
        return (await fs.promises.stat(file)).isFile();
    } catch (error) {
        return false;
    }
}

// Versão a enviar: [codificação, caminho], com a codificação null para o original.
async function pickVariant(file, acceptEncoding) {
    if (acceptsEncoding(acceptEncoding, 'br') && await isFile(`${file}.br`)) return ['br', `${file}.br`];
    if (acceptsEncoding(acceptEncoding, 'gzip') && await isFile(`${file}.gz`)) return ['gzip', `${file}.gz`];
    return [null, file];
}

// serveBuildAssets(distDir): handler para app.use('/assets', ...). distDir é a pasta do
// build (web/dist); os arquivos ficam em distDir/assets.
function serveBuildAssets(distDir) {
    const assetsDir = path.resolve(distDir, 'assets');
    return function serveBuildAsset(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            setNoStore(res);
            res.set('Allow', 'GET, HEAD');
            return res.status(405).type('text/plain').send('Método não permitido.');
        }
        // req.path é relativo ao ponto de montagem: '/index-abc123.js'.
        const name = String(req.path || '').replace(/^\//, '');
        if (!ASSET_NAME.test(name) || PRECOMPRESSED_SUFFIX.test(name)) return sendAssetNotFound(res);
        const file = path.join(assetsDir, name);
        (async () => {
            if (!await isFile(file)) return sendAssetNotFound(res);
            const [encoding, chosen] = await pickVariant(file, req.get('Accept-Encoding'));
            res.vary('Accept-Encoding');
            // Tipo pelo nome original (o .gz seria application/gzip).
            res.type(path.extname(name));
            const headers = { 'X-Content-Type-Options': 'nosniff' };
            if (encoding) headers['Content-Encoding'] = encoding;
            res.sendFile(chosen, {
                maxAge: ASSET_MAX_AGE,
                immutable: true,
                headers,
                // Pedaço de um arquivo comprimido não faz sentido para o navegador.
                acceptRanges: !encoding,
            }, (err) => {
                if (!err || res.headersSent) return;
                if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') return;
                // Sumiu entre a conferência e o envio (build refeito com o servidor ligado).
                if (err.status === 404 || err.statusCode === 404 || err.code === 'ENOENT') {
                    res.removeHeader('Content-Encoding');
                    return sendAssetNotFound(res);
                }
                logError('arquivo do app', err, { req });
                res.removeHeader('Content-Encoding');
                setNoStore(res);
                res.status(500).type('text/plain').send('Não foi possível enviar um arquivo do app. Recarregue a página.');
            });
        })().catch((err) => {
            logError('arquivo do app', err, { req });
            if (res.headersSent) return;
            setNoStore(res);
            res.status(500).type('text/plain').send('Não foi possível enviar um arquivo do app. Recarregue a página.');
        });
    };
}

module.exports = { serveBuildAssets, sendAssetNotFound, setNoStore, ASSET_MAX_AGE };
