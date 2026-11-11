// Registro do teclado na prova, por aplicação (fase 2, H8b: CRIT-04, decisões P2).
//
// As provas são de múltipla escolha: o que a pessoa digita não serve para corrigir nada.
// Por isso o padrão é registrar só os atalhos suspeitos. O professor escolhe ao preparar
// a aplicação, e depois de preparada ela não muda de modo:
// - 'eventos' (padrão): só atalhos suspeitos: copiar, colar, recortar, o menu do botão
//   direito e a troca de janela (Alt+Tab, tecla Windows), além das tentativas de atalho
//   que a prova bloqueia (imprimir, buscar, ferramentas do navegador). Na tabela, são os
//   eventos de kind 'shortcut', 'clipboard' e 'contextmenu';
// - 'tudo': todas as teclas da tela da prova (como era antes desta versão);
// - 'nada': nenhuma tecla é registrada.
// O bloqueio dos atalhos continua igual nos três modos; as saídas da tela e da tela cheia
// (registros de foco) também, porque são elas que travam a prova.
//
// Aplicação gravada antes desta versão (sem o campo) e tecla de prova sem aplicação valem
// 'eventos'. O servidor filtra em log-keystrokes, então a regra vale mesmo com um
// navegador que ainda tem o código antigo da prova (que mandava tudo). O campo "Reportar
// problema" é filtrado no navegador (ExamRunner), que é quem sabe onde a tecla foi.
const KEYSTROKE_MODES = Object.freeze(['eventos', 'tudo', 'nada']);
const DEFAULT_KEYSTROKE_MODE = 'eventos';

const KEYSTROKE_MODE_LABELS = Object.freeze({
    eventos: 'Só atalhos suspeitos',
    tudo: 'Toda a digitação',
    nada: 'Não registrar o teclado',
});

// Tipos de evento que o modo 'eventos' guarda (os que o ExamRunner marca como atalho,
// cópia ou menu do botão direito).
const SUSPICIOUS_EVENT_KINDS = new Set(['shortcut', 'clipboard', 'contextmenu']);

const INVALID_MODE_MESSAGE = 'Modo de registro de teclado inválido.';

function normalizeKeystrokeMode(value) {
    return KEYSTROKE_MODES.includes(value) ? value : DEFAULT_KEYSTROKE_MODE;
}

// Modo de uma aplicação (sem aplicação ou sem o campo: 'eventos').
function keystrokeModeOf(application) {
    return normalizeKeystrokeMode(application && typeof application === 'object' ? application.keystrokeMode : undefined);
}

// Escolha vinda da tela de preparar (applicationOptions.keystrokeMode): ausente, null ou
// vazio vale o padrão; texto fora da lista (ou outro tipo) é recusado.
function parseKeystrokeModeOption(options) {
    const source = options && typeof options === 'object' ? options : {};
    if (!Object.prototype.hasOwnProperty.call(source, 'keystrokeMode')) return { valid: true, value: DEFAULT_KEYSTROKE_MODE };
    const raw = source.keystrokeMode;
    if (raw === undefined || raw === null || raw === '') return { valid: true, value: DEFAULT_KEYSTROKE_MODE };
    if (typeof raw !== 'string' || !KEYSTROKE_MODES.includes(raw.trim())) return { valid: false, error: INVALID_MODE_MESSAGE };
    return { valid: true, value: raw.trim() };
}

function eventKind(event) {
    return event && typeof event === 'object' && typeof event.kind === 'string' ? event.kind.trim().toLowerCase() : 'key';
}

// O evento entra no registro deste modo?
function keystrokeAllowed(mode, event) {
    const normalized = normalizeKeystrokeMode(mode);
    if (normalized === 'nada') return false;
    if (normalized === 'tudo') return true;
    return SUSPICIOUS_EVENT_KINDS.has(eventKind(event));
}

// Os eventos do lote que o modo deixa gravar, na ordem em que vieram.
function filterKeystrokeEvents(mode, events) {
    const list = Array.isArray(events) ? events : [];
    const normalized = normalizeKeystrokeMode(mode);
    if (normalized === 'tudo') return list.slice();
    if (normalized === 'nada') return [];
    return list.filter(event => keystrokeAllowed(normalized, event));
}

module.exports = {
    DEFAULT_KEYSTROKE_MODE,
    INVALID_MODE_MESSAGE,
    KEYSTROKE_MODES,
    KEYSTROKE_MODE_LABELS,
    SUSPICIOUS_EVENT_KINDS,
    filterKeystrokeEvents,
    keystrokeAllowed,
    keystrokeModeOf,
    normalizeKeystrokeMode,
    parseKeystrokeModeOption,
};
