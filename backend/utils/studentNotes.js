// Tetos do caderno e das anotações do aluno (fase 2, H9b: ENG-03).
// Antes o aluno gravava qualquer texto em qualquer chave: 5 notas de 9 MB levaram o
// banco de 0,8 MB a 45,9 MB, a memória do servidor a 620 MB e cada gravação de qualquer
// aluno passou a demorar 75 a 95 ms (a linha do aluno inteira é regravada). Com os
// tetos, cada aluno fica em torno de 1 MB de caderno, mesmo de propósito.
//
// Dado antigo acima do limite nunca é apagado nem encurtado aqui: a nota antiga maior que
// o limite pode ser editada desde que não cresça, e o aluno acima do total ou da
// quantidade de unidades continua editando as que já tem (só não cria nem aumenta).
// Valores combinados (defaults_without_alan, pergunta 1 do H9): ficam aqui, para trocar
// sem mexer na lógica.
const { formatCount, MESSAGES } = require('./inputSchema.js');
const { isInheritedKey } = require('./ownEntry.js');

const NOTE_MAX_CHARS = 50000;
const NOTES_MAX_KEYS = 300;
const NOTES_MAX_TOTAL_CHARS = 1000000;

const ANNOTATION_NOTE_MAX_CHARS = 5000;
const ANNOTATION_HIGHLIGHT_MAX_CHARS = 1000;
const ANNOTATION_MAX_PARAGRAPHS = 500;
const ANNOTATION_MAX_KEYS = 300;

const NOTE_LABEL = 'nota';

function own(map, key) {
    return !!map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, key);
}

// Tamanho de uma nota gravada: o texto, ou o JSON de um valor antigo que não é texto
// (o servidor aceitava qualquer coisa).
function storedLength(value) {
    if (value == null) return 0;
    if (typeof value === 'string') return value.length;
    try { return JSON.stringify(value).length || 0; } catch (_) { return 0; }
}

function notesTotal(notes) {
    if (!notes || typeof notes !== 'object') return 0;
    return Object.keys(notes).reduce((sum, key) => sum + storedLength(notes[key]), 0);
}

// Nota do caderno (notes/save). `notes` é o mapa do aluno ({ chave: texto }), alterado
// aqui só quando a gravação é aceita. Texto vazio ou null apaga a chave (notes/get
// continua devolvendo ''). Devolve { ok: true, deleted } ou { ok: false, error, field }.
function applyNoteWrite(notes, key, text) {
    if (typeof key !== 'string' || !key || isInheritedKey(key)) {
        return { ok: false, field: 'moduleKey', error: 'Unidade inválida.' };
    }
    if (text !== null && text !== undefined && typeof text !== 'string') {
        return { ok: false, field: 'note', error: MESSAGES.invalid(NOTE_LABEL) };
    }
    const exists = own(notes, key);
    if (text === null || text === undefined || text === '') {
        if (exists) delete notes[key];
        return { ok: true, deleted: true };
    }
    const before = exists ? storedLength(notes[key]) : 0;
    if (text.length > NOTE_MAX_CHARS && text.length > before) {
        return { ok: false, field: 'note', error: MESSAGES.maxChars(NOTE_LABEL, NOTE_MAX_CHARS) };
    }
    if (!exists && Object.keys(notes).length >= NOTES_MAX_KEYS) {
        return { ok: false, field: 'moduleKey', error: `Seu caderno chegou ao limite de ${formatCount(NOTES_MAX_KEYS)} unidades com anotações.` };
    }
    const totalBefore = notesTotal(notes);
    const totalAfter = totalBefore - before + text.length;
    if (totalAfter > NOTES_MAX_TOTAL_CHARS && totalAfter > totalBefore) {
        return {
            ok: false,
            field: 'note',
            error: `Seu caderno chegou ao limite total de ${formatCount(NOTES_MAX_TOTAL_CHARS)} caracteres. Apague anotações antigas para continuar.`,
        };
    }
    notes[key] = text;
    return { ok: true, deleted: false };
}

// Anotação de parágrafo (annotation). `annotations` é o mapa do aluno
// ({ chave: { parágrafo: { highlightedText, note, timestamp } } }). note e
// highlightedText null juntos apagam (sempre aceito). O trecho destacado é guardado com
// até 1.000 caracteres. Devolve { ok: true } ou { ok: false, error, field }.
function applyAnnotationWrite(annotations, key, paragraphId, { note, highlightedText }, now = new Date()) {
    if (isInheritedKey(key) || isInheritedKey(paragraphId)) {
        return { ok: false, field: isInheritedKey(key) ? 'key' : 'paragraphId', error: 'Unidade ou parágrafo inválido.' };
    }
    const unit = own(annotations, key) && annotations[key] && typeof annotations[key] === 'object' ? annotations[key] : null;
    if (note === null && highlightedText === null) {
        if (unit) {
            delete unit[paragraphId];
            if (Object.keys(unit).length === 0) delete annotations[key];
        }
        return { ok: true, deleted: true };
    }
    if (typeof note === 'string' && note.length > ANNOTATION_NOTE_MAX_CHARS) {
        return { ok: false, field: 'note', error: MESSAGES.maxChars('anotação', ANNOTATION_NOTE_MAX_CHARS) };
    }
    if (!unit && Object.keys(annotations).length >= ANNOTATION_MAX_KEYS) {
        return { ok: false, field: 'key', error: `Você chegou ao limite de ${formatCount(ANNOTATION_MAX_KEYS)} unidades com anotações.` };
    }
    if (unit && !own(unit, paragraphId) && Object.keys(unit).length >= ANNOTATION_MAX_PARAGRAPHS) {
        return { ok: false, field: 'paragraphId', error: 'Limite de anotações desta unidade atingido.' };
    }
    const target = unit || (annotations[key] = {});
    target[paragraphId] = {
        highlightedText: typeof highlightedText === 'string' ? highlightedText.slice(0, ANNOTATION_HIGHLIGHT_MAX_CHARS) : (highlightedText ?? null),
        note: note === undefined ? null : note,
        timestamp: now.toISOString(),
    };
    return { ok: true, deleted: false };
}

module.exports = {
    ANNOTATION_HIGHLIGHT_MAX_CHARS,
    ANNOTATION_MAX_KEYS,
    ANNOTATION_MAX_PARAGRAPHS,
    ANNOTATION_NOTE_MAX_CHARS,
    NOTE_MAX_CHARS,
    NOTES_MAX_KEYS,
    NOTES_MAX_TOTAL_CHARS,
    applyAnnotationWrite,
    applyNoteWrite,
    notesTotal,
};
