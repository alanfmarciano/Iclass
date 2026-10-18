// Regra de foco da prova para quem RECARREGA, fecha ou sai da PÁGINA da prova e volta.
//
// DECISÃO PENDENTE (Alan): a regra de foco ainda não foi decidida. Até lá vale o padrão
// abaixo, e é só aqui que ele muda:
// - PAGE_EXIT_RETURN_WINDOW_MS: quanto tempo a MESMA sessão tem para voltar à MESMA
//   tentativa e a prova destravar sozinha (0 desliga o destravamento automático e a
//   saída da página volta a travar até o professor liberar);
// - pageExitReturnDecision: quando o retorno destrava.
// O retorno fica registrado no Monitor ("Recarregou ou saiu da página e voltou em N s").
// Sem retorno dentro do prazo vale a regra de saída de sempre (travada até o professor
// liberar). Troca de aba ou janela (blur/visibilidade) e saída da tela cheia NÃO entram
// aqui: continuam travando até a liberação do professor.
const crypto = require('crypto');

const PAGE_EXIT_RETURN_WINDOW_MS = 60 * 1000;
// Bloqueio que chega colado à saída da página (a aba fica oculta enquanto a página
// descarrega, ou o aviso "sair do site?" tira o foco da janela) faz parte da mesma saída.
const PAGE_EXIT_BURST_MS = 3 * 1000;
const PAGE_RETURN_EVENT = 'page_return';

// Identifica a sessão sem guardar o token no estado da tentativa.
function sessionFingerprint(sessionToken) {
    const token = String(sessionToken || '');
    if (!token) return null;
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

// Saída da página (pagehide com a prova em andamento): grava o que o retorno precisa
// conferir. Uma prova que já estava travada antes (troca de aba, tela cheia, saída
// pelo botão) continua travada: a saída da página não muda isso e o retorno não destrava.
function markPageExit(state, { sessionToken, now = Date.now() } = {}) {
    if (!state || typeof state !== 'object') return false;
    const lockedBefore = state.focusLocked === true && !state.pageExit
        && Number(state.focusLockedAt) > 0 && now - Number(state.focusLockedAt) > PAGE_EXIT_BURST_MS;
    if (lockedBefore) return false;
    const session = sessionFingerprint(sessionToken);
    if (!session) return false;
    state.pageExit = { at: now, session };
    return true;
}

// Outro bloqueio (troca de aba, tela cheia) depois da saída da página: colado a ela, é a
// própria página descarregando; depois disso é um bloqueio novo, que só o professor libera.
function keepPageExitOnLock(state, now = Date.now()) {
    if (!state?.pageExit) return;
    if (now - Number(state.pageExit.at) > PAGE_EXIT_BURST_MS) delete state.pageExit;
}

// A sessão voltou à tentativa (sincronização da página da prova): destrava sozinho se é
// a mesma sessão, dentro do prazo, e a prova está travada por essa saída da página.
function pageExitReturnDecision(state, { sessionToken, now = Date.now() } = {}) {
    const exit = state?.pageExit;
    if (!exit || state.focusLocked !== true) return { unlock: false };
    const elapsedMs = now - Number(exit.at);
    if (!(PAGE_EXIT_RETURN_WINDOW_MS > 0) || !(elapsedMs >= 0) || elapsedMs > PAGE_EXIT_RETURN_WINDOW_MS) {
        return { unlock: false, expired: elapsedMs > PAGE_EXIT_RETURN_WINDOW_MS };
    }
    if (!exit.session || exit.session !== sessionFingerprint(sessionToken)) return { unlock: false };
    return { unlock: true, seconds: Math.max(0, Math.round(elapsedMs / 1000)) };
}

function pageReturnDetails(seconds) {
    return `Recarregou ou saiu da página e voltou em ${seconds} s (prova destravada sozinha)`;
}

module.exports = {
    PAGE_EXIT_BURST_MS,
    PAGE_EXIT_RETURN_WINDOW_MS,
    PAGE_RETURN_EVENT,
    keepPageExitOnLock,
    markPageExit,
    pageExitReturnDecision,
    pageReturnDetails,
    sessionFingerprint,
};
