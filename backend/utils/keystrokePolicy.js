// Registro do teclado na prova, por aplicação (fase 2, H8b: CRIT-04, decisões P2).
//
// As provas são de múltipla escolha: o que a pessoa digita não serve para corrigir nada.
// Por isso o padrão é registrar só os atalhos suspeitos. O professor escolhe ao preparar
// a aplicação, e depois de preparada ela não muda de modo:
// - 'eventos' (padrão): só atalhos suspeitos: copiar, colar, recortar, o menu do botão
//   direito e a troca de janela (Alt+Tab, tecla Windows), além das tentativas de atalho
//   que a prova bloqueia (imprimir, buscar, salvar, ferramentas do navegador). Na
//   tabela, são os eventos de kind 'shortcut', 'clipboard' e 'contextmenu'. O servidor
//   não confia no kind que o navegador manda: ele mesmo classifica pela tecla e pelos
//   modificadores (suspiciousKindOf), e a tecla digitada nunca é guardada neste modo;
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

// Lista fechada de kind na tabela de teclas: outro valor (ou nenhum) vira 'key'.
const EVENT_KINDS = Object.freeze(['key', 'char', 'shortcut', 'clipboard', 'contextmenu']);

const INVALID_MODE_MESSAGE = 'Modo de registro de teclado inválido.';

function normalizeKeystrokeMode(value) {
    return KEYSTROKE_MODES.includes(value) ? value : DEFAULT_KEYSTROKE_MODE;
}

// Modo de uma aplicação (sem aplicação ou sem o campo: 'eventos').
function keystrokeModeOf(application) {
    return normalizeKeystrokeMode(application && typeof application === 'object' ? application.keystrokeMode : undefined);
}

// Aplicação gravada antes desta versão (sem o campo): o modo vale 'eventos' daqui em
// diante, mas o que ela já guardou é a digitação completa (o código antigo da prova
// mandava tudo). O painel usa isto para não chamar esses registros de "atalhos".
function keystrokeModeIsLegacy(application) {
    return !!application && typeof application === 'object' && !KEYSTROKE_MODES.includes(application.keystrokeMode);
}

// Cópia da aplicação para o painel do professor, com o modo lido (o banco não muda).
function withKeystrokeMode(application) {
    const out = { ...application, keystrokeMode: keystrokeModeOf(application) };
    if (keystrokeModeIsLegacy(application)) out.keystrokeModeLegacy = true;
    return out;
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

// kind normalizado (sem espaços, minúsculas, lista fechada): 'SHORTCUT ' é 'shortcut',
// e um valor desconhecido é 'key'.
function normalizeEventKind(kind) {
    const value = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
    return EVENT_KINDS.includes(value) ? value : 'key';
}

function eventKind(event) {
    return normalizeEventKind(event && typeof event === 'object' ? event.kind : undefined);
}

function eventMods(event) {
    const mods = event && typeof event === 'object' && typeof event.mods === 'string' ? event.mods : '';
    return new Set(mods.split('+').map(part => part.trim().toLowerCase()).filter(Boolean));
}

function eventKey(event) {
    return event && typeof event === 'object' && typeof event.key === 'string' ? event.key.trim().toLowerCase() : '';
}

// Caractere digitado com AltGr (teclado ABNT2 e outros do Windows): o navegador manda
// Ctrl e Alt juntos, e o código da prova de antes desta versão marcava isso como atalho
// ('shortcut', mods 'Ctrl+Alt'). É digitação: '/', '?', '°', '€'... O ExamRunner novo já
// manda esses como 'char' com mods 'AltGr'; aqui o servidor reconhece o formato antigo
// (Ctrl+Alt, sem Meta, com um caractere que não é letra nem número), para o modo
// 'eventos' não guardar o que a pessoa digitou. O atalho de verdade (Ctrl+Alt+V) chega
// com a letra e continua guardado.
function isAltGrTyping(event) {
    if (!event || typeof event !== 'object') return false;
    const mods = typeof event.mods === 'string' ? event.mods.split('+').map(part => part.trim().toLowerCase()).filter(Boolean) : [];
    if (mods.includes('altgr')) return true;
    if (!mods.includes('ctrl') || !mods.includes('alt') || mods.includes('meta')) return false;
    const key = typeof event.key === 'string' ? event.key : '';
    return Array.from(key).length === 1 && !/[a-z0-9]/i.test(key);
}

// Atalho pela classificação do próprio servidor (decisões §12, sobra do H8b), a mesma do
// classifyCombo do ExamRunner, menos o que é só digitação:
// - Ctrl ou Meta com c, v, x (copiar, colar, recortar) e com f, p, s (buscar, imprimir,
//   salvar, que a prova bloqueia); Ctrl/Meta+Shift com i, j, c e F12 (ferramentas do
//   navegador);
// - troca de janela: Alt+Tab e qualquer tecla com Meta (a tecla Windows sozinha também);
// - Alt sozinho com uma tecla não é atalho ('ç' com Alt é digitação), nem AltGr.
const COPY_PASTE_KEYS = new Set(['c', 'v', 'x']);
const BLOCKED_CTRL_KEYS = new Set(['f', 'p', 's']);
const DEVTOOLS_KEYS = new Set(['i', 'j', 'c']);
const WINDOW_KEYS = new Set(['meta', 'os', 'super']);

function isServerShortcut(event) {
    if (!event || typeof event !== 'object' || isAltGrTyping(event)) return false;
    const mods = eventMods(event);
    const key = eventKey(event);
    const ctrlOrMeta = mods.has('ctrl') || mods.has('meta');
    if (ctrlOrMeta && (COPY_PASTE_KEYS.has(key) || BLOCKED_CTRL_KEYS.has(key))) return true;
    if (ctrlOrMeta && mods.has('shift') && DEVTOOLS_KEYS.has(key)) return true;
    if (key === 'f12') return true;
    if (mods.has('alt') && key === 'tab') return true;
    if (mods.has('meta') || WINDOW_KEYS.has(key)) return true;
    return false;
}

// Eventos de cópia e de menu: o navegador manda o nome do evento no lugar da tecla.
const CLIPBOARD_KEYS = new Set(['copy', 'cut', 'paste']);
const CONTEXTMENU_KEYS = new Set(['contextmenu']);

// Tipo suspeito do evento pela classificação do servidor, ou null (não é atalho e o modo
// 'eventos' não guarda). Cópia e menu do botão direito só com o nome do evento (ou o
// atalho de verdade), nunca com uma tecla digitada.
function suspiciousKindOf(event) {
    if (!event || typeof event !== 'object' || isAltGrTyping(event)) return null;
    const kind = eventKind(event);
    const key = eventKey(event);
    const shortcut = isServerShortcut(event);
    if (kind === 'clipboard' && (CLIPBOARD_KEYS.has(key) || shortcut)) return 'clipboard';
    if (kind === 'contextmenu' && (CONTEXTMENU_KEYS.has(key) || shortcut)) return 'contextmenu';
    return shortcut ? 'shortcut' : null;
}

// O evento entra no registro deste modo?
function keystrokeAllowed(mode, event) {
    const normalized = normalizeKeystrokeMode(mode);
    if (normalized === 'nada') return false;
    if (normalized === 'tudo') return true;
    return suspiciousKindOf(event) !== null;
}

// Os eventos do lote que o modo deixa gravar, na ordem em que vieram, com o kind
// normalizado (no modo 'eventos', o tipo que o servidor classificou).
function filterKeystrokeEvents(mode, events) {
    const list = Array.isArray(events) ? events : [];
    const normalized = normalizeKeystrokeMode(mode);
    if (normalized === 'nada') return [];
    const valid = list.filter(event => event && typeof event === 'object' && !Array.isArray(event));
    if (normalized === 'tudo') return valid.map(event => ({ ...event, kind: eventKind(event) }));
    const out = [];
    for (const event of valid) {
        const kind = suspiciousKindOf(event);
        if (kind) out.push({ ...event, kind });
    }
    return out;
}

module.exports = {
    DEFAULT_KEYSTROKE_MODE,
    EVENT_KINDS,
    INVALID_MODE_MESSAGE,
    KEYSTROKE_MODES,
    KEYSTROKE_MODE_LABELS,
    SUSPICIOUS_EVENT_KINDS,
    filterKeystrokeEvents,
    isAltGrTyping,
    isServerShortcut,
    keystrokeAllowed,
    keystrokeModeIsLegacy,
    keystrokeModeOf,
    normalizeEventKind,
    normalizeKeystrokeMode,
    parseKeystrokeModeOption,
    suspiciousKindOf,
    withKeystrokeMode,
};
