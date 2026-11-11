// Cabeçalhos de segurança de toda resposta (H5d, SEG-16): segunda linha de defesa caso
// um dia entre um XSS (script de fora não roda), contra embutir o painel do professor
// num iframe de outro site (clickjacking), contra o navegador "adivinhar" o tipo de um
// arquivo e contra o caminho e o ?access= das páginas irem para sites de fora.
//
// O que a política deixa passar, e por quê (conferido no Chromium em todas as páginas do
// professor e do aluno):
// - script-src 'self': o build do Vite só tem <script src> de /assets, sem script inline;
//   as janelas de impressão (about:blank, que herda esta política) são chamadas pela
//   janela de origem (win.print()), sem <script> dentro.
// - style-src 'unsafe-inline': atributos style do React e do markdown e o <style> das
//   janelas de impressão e da página "iniciando" do boot.
// - img-src e media-src com http: e https:: logo da identidade visual, imagens e vídeos
//   da biblioteca e imagens das apostilas podem apontar para endereço de fora (inclusive
//   http, já gravado em bancos antigos); data: e blob: para prévias e cópias locais.
// - frame-src: os players do YouTube e do Vimeo da biblioteca e a prévia de PDF de
//   /uploads (mesma origem). As apostilas não têm iframe (o DOMPurify tira).
// - frame-ancestors 'self' e X-Frame-Options SAMEORIGIN (não DENY): a prévia de PDF da
//   biblioteca é um iframe do próprio IClass.
// - Referrer-Policy strict-origin-when-cross-origin (não same-origin): o YouTube recusa o
//   embed sem origem; assim só a origem sai, nunca o caminho nem o ?access=.
// Os arquivos de /uploads e /imagens trocam a CSP por uma sandbox própria, mais fechada
// (sendControlledFile em server.js), que vale por cima desta.
//
// HSTS (Strict-Transport-Security): não é enviado, nem na conexão https (H6c). O IClass fala http com os alunos
// (studentsHttps desligado) no mesmo endereço; um HSTS gravado no navegador trancaria esse
// acesso (e o computador do IClass, em http://localhost). Há teste que confere as duas
// respostas, http e https (dual-listener.test.js e https-end-to-end.test.js).

const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob: http: https:",
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
});

// Middleware do passo 3 do createApp (logo depois do cors) e do app de boot. Rota que
// define a própria CSP (arquivos enviados) continua definindo: res.set troca o valor.
function securityHeaders() {
    return function applySecurityHeaders(req, res, next) {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
        next();
    };
}

module.exports = { securityHeaders, SECURITY_HEADERS, CONTENT_SECURITY_POLICY };
