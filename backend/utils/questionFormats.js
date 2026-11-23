// Importar e exportar o banco de questões em GIFT e em planilha CSV (fase 3, P3-S9b:
// AVA-15; decisão D22 do desenho P3, K11 do plano).
//
// GIFT é o formato de texto que o Moodle importa e exporta: o arquivo serve para levar as
// questões ao Moodle, trazer de lá e passar de um IClass para outro. A planilha abre no
// Excel. Nada é gravado aqui: a rota (routes/adminQuestionBank.js) faz a prévia, confere o
// sha256 do arquivo na confirmação e grava.
//
// GIFT (o subconjunto que vira os seis tipos):
// - uma correta: { =certa ~errada ~errada }; várias corretas: { ~%50%certa ~%50%certa
//   ~%-100%errada } (alternativa com peso maior que zero é certa);
// - verdadeiro ou falso: {T} ou {TRUE}, {F} ou {FALSE};
// - numérica: {#3.5:0.1} (valor:tolerância), {#1..5} (faixa) ou {#=3.5:0.1 =%50%3:1} (vale
//   a primeira resposta de 100%);
// - resposta curta: { =resposta =outra } (todas com "=");
// - dissertativa: {};
// - comentário geral (#### dentro das chaves) vira a explicação; o comentário de cada
//   alternativa (#) não existe aqui e fica de fora, com aviso;
// - $CATEGORY: a categoria das questões seguintes (do caminho do Moodle, vale a última
//   parte: "$course$/top/Redes/Sub-redes" é "Sub-redes"; "//" é uma barra no nome);
// - ::título:: e o formato do texto ([markdown], [plain], [moodle] ou [html]; o HTML vira
//   texto) saem; "texto {respostas} mais texto" (palavra que falta) vira "texto _____
//   mais texto";
// - escapes \~ \= \# \{ \} \: \\ e \n (quebra de linha);
// - comentários (linha começando com //) são ignorados, menos "// [tag:etiqueta]" (o
//   Moodle grava as etiquetas assim) e "// iclass: {...}", que o IClass grava antes de cada
//   questão com o que o GIFT não tem (pontos, dificuldade, habilidades, revisão, unidade,
//   resposta esperada, rubrica, pontuação parcial): o Moodle ignora a linha e o IClass lê
//   de volta (ida e volta sem perder nada).
// Associação (->) não existe no IClass e vira erro na linha.
//
// Planilha: lida só por parseTabularFile (utils/tabularFile.js, contrato C4 do P4; CSV com
// ";", "," ou tab, UTF-8 ou Windows-1252, e também XLSX) e gravada por buildCsv
// (utils/gradebook.js, com csvSafe contra fórmula). A primeira linha é o cabeçalho, com as
// colunas de CSV_COLUMNS em qualquer ordem (sem acento, maiúscula ou espaço importar);
// só "enunciado" é obrigatória. O apóstrofo que o csvSafe põe na frente de "=", "+", "-"
// e "@" sai na leitura.
//
// Cada questão passa pelo modelo único do banco (normalizeBankQuestion): o erro de uma
// questão vem com a linha onde ela começa e não impede as outras.
const { formatCount } = require('./inputSchema.js');
const { TYPE_LABELS, DIFFICULTIES } = require('./questionModel.js');
const { QUESTION_TYPES } = require('./examScoring.js');
const {
    DEFAULT_CATEGORY,
    QUESTION_CATEGORY_MAX_CHARS,
    bankQuestionText,
    itemCategory,
    normalizeBankQuestion,
} = require('./questionBank.js');
const { normalizeSearch } = require('./textSearch.js');
const { TabularFileError, decodeText, fileSha256, parseTabularFile } = require('./tabularFile.js');
const { buildCsv } = require('./gradebook.js');

const IMPORT_LIMITS = Object.freeze({
    maxBytes: 2 * 1024 * 1024,
    maxQuestions: 2000,
});
const FORMATS = Object.freeze(['gift', 'csv']);
const MISSING_WORD = '_____';

class QuestionFormatError extends Error {
    constructor(message, code, { status = 400 } = {}) {
        super(message);
        this.name = 'QuestionFormatError';
        this.code = code;
        this.status = status;
    }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sizeText(bytes) {
    const megabytes = bytes / (1024 * 1024);
    return Number.isInteger(megabytes) ? String(megabytes) : megabytes.toFixed(1).replace('.', ',');
}

function formatDecimal(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return String(number).replace('.', ',');
}

// ------------------------------------------------------------------ GIFT: escapes

// Caractere escapado -> marca (área de uso privado do Unicode) durante a leitura da
// estrutura; no fim cada marca volta a ser o caractere. "\n" vira quebra de linha.
const GIFT_ESCAPES = Object.freeze({ '\\': '', '~': '', '=': '', '#': '', '{': '', '}': '', ':': '', n: '' });
const GIFT_RESTORE = Object.freeze({ '': '\\', '': '~', '': '=', '': '#', '': '{', '': '}', '': ':', '': '\n' });
const PLACEHOLDERS = /[-]/g;

function protectGift(text) {
    let out = '';
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === '\\' && index + 1 < text.length && Object.prototype.hasOwnProperty.call(GIFT_ESCAPES, text[index + 1])) {
            out += GIFT_ESCAPES[text[index + 1]];
            index += 1;
        } else {
            out += char;
        }
    }
    return out;
}

function restoreGift(text) {
    return String(text || '').replace(PLACEHOLDERS, char => GIFT_RESTORE[char]);
}

// Texto -> GIFT: os caracteres da sintaxe com barra e a quebra de linha como "\n" (o
// arquivo tem uma questão por bloco, e uma linha em branco no meio dela a partiria).
function giftEscape(text) {
    return String(text == null ? '' : text)
        .replace(/\r\n?/g, '\n')
        .replace(/[\\~=#{}:]/g, char => `\\${char}`)
        .replace(/\n/g, '\\n');
}

// ------------------------------------------------------------------ GIFT: leitura

const HTML_ENTITIES = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
function decodeHtmlEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|nbsp|lt|gt|quot|apos|amp);/gi, (match, entity) => {
        const lower = entity.toLowerCase();
        if (lower[0] === '#') {
            const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
        }
        return HTML_ENTITIES[lower] ?? match;
    });
}

// HTML do Moodle ([html]) -> texto: parágrafo e <br> viram quebra de linha, item de lista
// vira "- ", negrito, itálico e código viram o Markdown deles e as outras marcas saem.
// Devolve { text, image } (image: havia <img>, que não vem junto).
function htmlToText(html) {
    const source = String(html || '');
    const image = /<img\b/i.test(source);
    const text = decodeHtmlEntities(source
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '- ')
        .replace(/<\/?(?:b|strong)\b[^>]*>/gi, '**')
        .replace(/<\/?(?:i|em)\b[^>]*>/gi, '*')
        .replace(/<\/?code\b[^>]*>/gi, '`')
        .replace(/<[^>]*>/g, ''))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text, image };
}

const FORMAT_MARKER = /^\s*\[(html|markdown|plain|moodle)\]/i;

// Categoria do $CATEGORY: a última parte do caminho do Moodle ("//" é uma barra no nome).
function giftCategory(raw) {
    const path = restoreGift(String(raw || '')).trim();
    const parts = path.replace(/\/\//g, '\u0000').split('/').map(part => part.replace(/\u0000/g, '/').trim()).filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : '';
    if (!last || /^\$[a-z]+\$$/i.test(last) || last.toLowerCase() === 'top') return '';
    return last;
}

// Peso "%50%" no começo do texto de uma resposta.
function readWeight(text) {
    const match = /^\s*%\s*(-?\d+(?:[.,]\d+)?)\s*%/.exec(text);
    if (!match) return { weight: null, rest: text };
    return { weight: Number(match[1].replace(',', '.')), rest: text.slice(match[0].length) };
}

// Respostas "=a ~b ..." -> [{ mark: '=' | '~', weight, text, feedback }]. Texto antes da
// primeira marca é erro.
function splitAnswers(section) {
    const tokens = [];
    const pattern = /[=~]/g;
    const first = section.search(/[=~]/);
    if (first < 0) return { tokens, leading: section.trim() };
    const leading = section.slice(0, first).trim();
    let match;
    const marks = [];
    pattern.lastIndex = first;
    while ((match = pattern.exec(section))) marks.push(match.index);
    marks.forEach((start, index) => {
        const end = index + 1 < marks.length ? marks[index + 1] : section.length;
        const mark = section[start];
        const { weight, rest } = readWeight(section.slice(start + 1, end));
        const hash = rest.indexOf('#');
        const text = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
        const feedback = hash >= 0 ? rest.slice(hash + 1).trim() : '';
        tokens.push({ mark, weight, text, feedback });
    });
    return { tokens, leading };
}

function parseGiftNumber(text) {
    const clean = String(text || '').trim();
    if (!clean) return NaN;
    const normalized = clean.includes('.') ? clean : clean.replace(',', '.');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return NaN;
    return Number(normalized);
}

// Uma resposta numérica: "3.5:0.1", "1..5" ou "3.5" (sem o comentário).
function parseNumericAnswer(text) {
    const value = restoreGift(text).trim();
    const range = /^(.+?)\.\.(.+)$/.exec(value);
    if (range) {
        const min = parseGiftNumber(range[1]);
        const max = parseGiftNumber(range[2]);
        if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
        return { value: (min + max) / 2, tolerance: (max - min) / 2 };
    }
    const colon = value.lastIndexOf(':');
    if (colon > 0) {
        const number = parseGiftNumber(value.slice(0, colon));
        const tolerance = parseGiftNumber(value.slice(colon + 1));
        if (!Number.isFinite(number) || !Number.isFinite(tolerance)) return null;
        return { value: number, tolerance };
    }
    const number = parseGiftNumber(value);
    return Number.isFinite(number) ? { value: number, tolerance: 0 } : null;
}

// Campos que o comentário "// iclass: {...}" pode trazer (o que o GIFT não tem).
const META_FIELDS = Object.freeze(['points', 'partialCredit', 'review', 'unit', 'expectedAnswer', 'rubric', 'difficulty', 'skills', 'tags']);

function readComments(comments, warn) {
    const tags = [];
    let meta = null;
    comments.forEach(comment => {
        const body = comment.replace(/^\s*\/\//, '');
        const iclass = /^\s*iclass:\s*(.*)$/i.exec(body);
        if (iclass) {
            try {
                const parsed = JSON.parse(iclass[1]);
                if (!isPlainObject(parsed)) throw new Error('não é objeto');
                meta = {};
                META_FIELDS.forEach(field => { if (parsed[field] !== undefined) meta[field] = parsed[field]; });
            } catch (error) {
                warn('o comentário "// iclass:" não pôde ser lido e ficou de fora.');
            }
            return;
        }
        const pattern = /\[tag:([^\]]*)\]/gi;
        let match;
        while ((match = pattern.exec(body))) {
            const tag = match[1].trim();
            if (tag) tags.push(tag);
        }
    });
    return { tags, meta };
}

// Uma questão GIFT (já sem os comentários, com os escapes protegidos) -> questão crua para
// o modelo do banco. Lança QuestionFormatError com a mensagem da linha.
function parseGiftQuestion(source, warn) {
    let text = source.trim();
    if (text.startsWith('::')) {
        const close = text.indexOf('::', 2);
        if (close < 0) throw new QuestionFormatError('o título (entre ::) não foi fechado.', 'gift_title');
        text = text.slice(close + 2);
    }
    const open = text.indexOf('{');
    if (open < 0) throw new QuestionFormatError('a questão não tem a parte das respostas entre chaves { }. Para dissertativa, use {} no fim.', 'gift_no_answers');
    const close = text.lastIndexOf('}');
    if (close < open) throw new QuestionFormatError('a chave { das respostas não foi fechada com }.', 'gift_unclosed');
    if (text.indexOf('{', open + 1) >= 0 && text.indexOf('{', open + 1) < close) {
        throw new QuestionFormatError('a questão tem mais de um par de chaves { }; use \\{ e \\} para escrever uma chave no texto.', 'gift_braces');
    }
    let before = text.slice(0, open);
    const after = text.slice(close + 1).trim();
    let section = text.slice(open + 1, close);
    let format = 'markdown';
    const marker = FORMAT_MARKER.exec(before);
    if (marker) {
        format = marker[1].toLowerCase();
        before = before.slice(marker[0].length);
    }
    let image = false;
    const toText = value => {
        const restored = restoreGift(value).trim();
        if (format !== 'html') return restored;
        const converted = htmlToText(restored);
        if (converted.image) image = true;
        return converted.text;
    };
    let questionText = toText(before);
    if (after) {
        questionText = `${questionText} ${MISSING_WORD} ${toText(after)}`.trim();
        warn(`a questão de palavra que falta virou "${MISSING_WORD}" no enunciado.`);
    }
    // Comentário geral (####) é a explicação.
    let explanation = '';
    const general = section.indexOf('####');
    if (general >= 0) {
        explanation = toText(section.slice(general + 4));
        section = section.slice(0, general);
    }
    const answers = section.trim();
    const raw = { text: questionText };
    if (explanation) raw.explanation = explanation;
    if (!answers) {
        raw.type = 'essay';
    } else if (answers.startsWith('#')) {
        raw.type = 'numeric';
        const rest = answers.slice(1).trim();
        let chosen = null;
        if (/^[=~]/.test(rest)) {
            const { tokens } = splitAnswers(rest);
            const full = tokens.filter(token => token.mark === '=' && (token.weight === null || token.weight === 100));
            if (!full.length) throw new QuestionFormatError('a numérica precisa de uma resposta que vale 100%.', 'gift_numeric');
            chosen = parseNumericAnswer(full[0].text);
            if (tokens.length > 1) warn('a numérica tem mais de uma resposta; ficou só a primeira que vale 100%.');
        } else {
            const hash = rest.indexOf('#');
            if (hash >= 0) warn('o comentário de cada resposta (#) não existe no IClass e ficou de fora.');
            chosen = parseNumericAnswer(hash >= 0 ? rest.slice(0, hash) : rest);
        }
        if (!chosen) throw new QuestionFormatError('o número da resposta numérica não pôde ser lido (use 3.5, 3.5:0.1 ou 1..5).', 'gift_numeric');
        raw.numeric = chosen;
    } else if (/^(?:t|true|f|false)\s*(?:#|$)/i.test(answers)) {
        raw.type = 'true_false';
        const word = /^(t|true|f|false)/i.exec(answers)[1].toLowerCase();
        raw.correctAnswer = word.startsWith('t') ? 'A' : 'B';
        if (answers.includes('#')) warn('o comentário de cada resposta (#) não existe no IClass e ficou de fora.');
    } else {
        const { tokens, leading } = splitAnswers(answers);
        if (leading) throw new QuestionFormatError('cada resposta começa com = (certa) ou ~ (errada).', 'gift_answers');
        if (!tokens.length) throw new QuestionFormatError('a questão não tem respostas.', 'gift_answers');
        if (tokens.some(token => token.text.includes('->'))) {
            throw new QuestionFormatError('questão de associação (->) não existe no IClass.', 'gift_matching');
        }
        if (tokens.some(token => token.feedback)) warn('o comentário de cada resposta (#) não existe no IClass e ficou de fora.');
        if (tokens.every(token => token.mark === '=')) {
            raw.type = 'short_answer';
            const full = tokens.filter(token => token.weight === null || token.weight === 100);
            if (full.length < tokens.length) warn('as respostas que valem só parte dos pontos ficaram de fora; ficaram as que valem 100%.');
            raw.acceptedAnswers = full.map(token => toText(token.text));
        } else {
            // Com "=" (a certa de 100%), é uma correta: alternativa "~%50%" (meio ponto no
            // Moodle) vira errada, com aviso. Sem "=", as de peso maior que zero são as
            // certas: uma é "uma correta"; mais de uma, "várias corretas".
            const full = token => token.mark === '=' || token.weight === 100;
            const hasFull = tokens.some(full);
            const correct = hasFull ? tokens.filter(full) : tokens.filter(token => token.weight !== null && token.weight > 0);
            if (hasFull && tokens.some(token => !full(token) && token.weight !== null && token.weight > 0)) {
                warn('a alternativa que valia só parte dos pontos virou errada: aqui a questão de uma correta vale tudo ou nada.');
            }
            raw.type = correct.length > 1 ? 'multiple_answer' : 'multiple_choice';
            raw.alternatives = tokens.map(token => ({ text: toText(token.text), isCorrect: correct.includes(token) }));
            if (raw.type === 'multiple_answer') raw.partialCredit = true;
        }
    }
    if (image) warn('a imagem do HTML não foi importada; envie de novo pelo editor.');
    return raw;
}

// Aplica o comentário // iclass: e as etiquetas por cima da questão lida.
function applyGiftMeta(raw, { tags, meta }) {
    const question = { ...raw };
    if (meta) {
        ['points', 'partialCredit', 'review', 'expectedAnswer', 'rubric', 'difficulty', 'skills'].forEach(field => {
            if (meta[field] !== undefined) question[field] = meta[field];
        });
        if (meta.unit !== undefined && isPlainObject(question.numeric)) question.numeric = { ...question.numeric, unit: meta.unit };
    }
    const allTags = [...tags, ...(meta && Array.isArray(meta.tags) ? meta.tags : [])];
    if (allTags.length) question.tags = allTags;
    return question;
}

// Texto GIFT -> { entradas: [{ linha, categoria, questao, avisos }], erros: [{ linha,
// mensagem }] }. A linha é a primeira linha da questão (sem os comentários).
function parseGift(text) {
    const lines = String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
    const entradas = [];
    const erros = [];
    let category = '';
    let block = null;
    let questionCount = 0;
    const flush = () => {
        if (!block) return;
        const current = block;
        block = null;
        if (!current.content.length) return;
        let content = current.content;
        const firstLine = content[0];
        const categoryMatch = /^\s*\$CATEGORY:(.*)$/i.exec(firstLine.text);
        if (categoryMatch) {
            category = giftCategory(protectGift(categoryMatch[1]));
            content = content.slice(1);
            if (!content.length) return;
        }
        questionCount += 1;
        if (questionCount > IMPORT_LIMITS.maxQuestions) {
            throw new QuestionFormatError(`O arquivo tem mais de ${formatCount(IMPORT_LIMITS.maxQuestions)} questões. Divida em arquivos menores.`, 'too_many_questions');
        }
        const linha = content[0].number;
        const avisos = [];
        const warn = message => { const text = capitalize(message); if (!avisos.includes(text)) avisos.push(text); };
        try {
            const protectedText = protectGift(content.map(line => line.text).join('\n'));
            const parsed = parseGiftQuestion(protectedText, warn);
            const comments = readComments(current.comments, warn);
            entradas.push({ linha, categoria: category, questao: applyGiftMeta(parsed, comments), avisos });
        } catch (error) {
            if (!(error instanceof QuestionFormatError)) throw error;
            erros.push({ linha, mensagem: capitalize(error.message) });
        }
    };
    lines.forEach((textLine, index) => {
        const number = index + 1;
        if (!textLine.trim()) {
            flush();
            return;
        }
        if (!block) block = { comments: [], content: [] };
        if (/^\s*\/\//.test(textLine)) {
            // Comentário: só os que vêm antes do texto da questão (como no Moodle) contam;
            // os do meio também saem do texto.
            block.comments.push(textLine);
            return;
        }
        block.content.push({ number, text: textLine });
    });
    flush();
    return { entradas, erros };
}

function capitalize(text) {
    const value = String(text || '');
    return value.charAt(0).toUpperCase() + value.slice(1);
}

// ------------------------------------------------------------------ planilha

// Colunas da planilha, na ordem da exportação. `header` é o que a exportação escreve; na
// leitura vale o nome sem acento, maiúscula, espaço ou pontuação (alternativa_a,
// "Alternativa A", "ALTERNATIVA-A").
const LETTERS = 'ABCDEFGH'.split('');
const CSV_COLUMNS = Object.freeze([
    { key: 'categoria', header: 'Categoria' },
    { key: 'tipo', header: 'Tipo' },
    { key: 'enunciado', header: 'Enunciado' },
    ...LETTERS.map(letter => ({ key: `alternativa_${letter.toLowerCase()}`, header: `Alternativa ${letter}` })),
    { key: 'correta', header: 'Correta' },
    { key: 'pontos', header: 'Pontos' },
    { key: 'valor', header: 'Valor' },
    { key: 'tolerancia', header: 'Tolerância' },
    { key: 'unidade', header: 'Unidade' },
    { key: 'respostas_aceitas', header: 'Respostas aceitas' },
    { key: 'revisao', header: 'Revisão' },
    { key: 'resposta_esperada', header: 'Resposta esperada' },
    { key: 'rubrica', header: 'Rubrica' },
    { key: 'explicacao', header: 'Explicação' },
    { key: 'dificuldade', header: 'Dificuldade' },
    { key: 'habilidades', header: 'Habilidades' },
    { key: 'etiquetas', header: 'Etiquetas' },
    { key: 'pontuacao_parcial', header: 'Pontuação parcial' },
]);
const CSV_KEYS = new Set(CSV_COLUMNS.map(column => column.key));
const LIST_SEPARATOR = ' | ';

function headerKey(value) {
    return normalizeSearch(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Tipo escrito na planilha: o nome da tela ("Uma correta"), o nome interno
// ("multiple_choice") ou um nome comum ("múltipla escolha", "V/F", "discursiva").
const TYPE_ALIASES = (() => {
    const map = new Map();
    QUESTION_TYPES.forEach(type => {
        map.set(headerKey(type), type);
        map.set(headerKey(TYPE_LABELS[type]), type);
    });
    [
        ['múltipla escolha', 'multiple_choice'], ['escolha única', 'multiple_choice'], ['objetiva', 'multiple_choice'],
        ['múltipla resposta', 'multiple_answer'], ['múltiplas corretas', 'multiple_answer'],
        ['v/f', 'true_false'], ['vf', 'true_false'], ['verdadeiro/falso', 'true_false'], ['verdadeiro falso', 'true_false'],
        ['número', 'numeric'], ['numérica', 'numeric'],
        ['curta', 'short_answer'], ['resposta curta', 'short_answer'],
        ['discursiva', 'essay'], ['aberta', 'essay'], ['dissertativa', 'essay'],
    ].forEach(([alias, type]) => map.set(headerKey(alias), type));
    return map;
})();

// O apóstrofo do csvSafe na frente de =, +, -, @, tab e CR sai (o número "-5" exportado
// como "'-5" volta a ser "-5").
function cellText(value) {
    const text = String(value == null ? '' : value);
    return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

function splitList(value) {
    return String(value || '').split('|').map(item => item.trim()).filter(Boolean);
}

// "A, C", "A e C", "A;C", "AC" -> ['A', 'C']; V/F: "V", "F", "Verdadeiro", "Falso".
function readLetters(value) {
    // " e " minúsculo é a conjunção ("A e C"); o "E" maiúsculo é a letra.
    const parts = String(value || '').replace(/\s+e\s+/g, ',').split(/[\s,;/+|]+/).map(part => part.trim()).filter(Boolean);
    if (parts.length === 1 && /^[A-H]{2,8}$/i.test(parts[0])) return [...new Set(parts[0].toUpperCase().split(''))];
    return [...new Set(parts.map(part => part.toUpperCase()))];
}

function readRubric(value) {
    return splitList(value).map(part => {
        const colon = part.lastIndexOf(':');
        if (colon < 0) return { nome: part, pontos: '' };
        return { nome: part.slice(0, colon).trim(), pontos: part.slice(colon + 1).trim() };
    });
}

function readBoolean(value) {
    const key = headerKey(value);
    if (!key) return undefined;
    if (['nao', 'n', 'false', 'falso', '0', 'tudo_ou_nada'].includes(key)) return false;
    return true;
}

function readDifficulty(value) {
    const key = headerKey(value);
    if (!key || key === 'sem') return '';
    const found = DIFFICULTIES.find(difficulty => headerKey(difficulty) === key);
    return found || String(value).trim();
}

function readReview(value) {
    const key = headerKey(value);
    if (!key) return '';
    if (key === 'professor' || key.startsWith('mandar') || key === 'sim') return 'professor';
    if (key === 'auto' || key === 'automatica' || key === 'nao') return 'auto';
    return String(value).trim();
}

// Uma linha da planilha (objeto coluna -> texto) -> questão crua para o modelo.
function rowQuestion(cells, warn) {
    const typeText = cells.tipo || '';
    let type = '';
    if (typeText.trim()) {
        type = TYPE_ALIASES.get(headerKey(typeText));
        if (!type) throw new QuestionFormatError(`o tipo "${typeText.trim().slice(0, 40)}" não existe. Use: ${QUESTION_TYPES.map(item => TYPE_LABELS[item]).join(', ')}.`, 'csv_type');
    }
    const alternatives = LETTERS.map(letter => cells[`alternativa_${letter.toLowerCase()}`] || '');
    let last = alternatives.length;
    while (last > 0 && !alternatives[last - 1].trim()) last -= 1;
    const filled = alternatives.slice(0, last);
    if (!type) type = 'multiple_choice';
    const raw = { type, text: cells.enunciado || '' };
    if (cells.pontos && cells.pontos.trim()) raw.points = cells.pontos.trim();
    const correct = readLetters(cells.correta);
    if (type === 'multiple_choice' || type === 'multiple_answer') {
        if (filled.some(text => !text.trim())) throw new QuestionFormatError('há uma alternativa vazia entre as preenchidas.', 'csv_alternatives');
        raw.alternatives = filled.map(text => ({ text }));
        if (type === 'multiple_choice') {
            if (correct.length > 1) throw new QuestionFormatError('"Uma correta" aceita só uma letra em "Correta" (para várias, use o tipo "Várias corretas").', 'csv_correct');
            raw.correctAnswer = correct[0] || '';
        } else {
            raw.correctAnswers = correct;
            const partial = readBoolean(cells.pontuacao_parcial);
            if (partial !== undefined) raw.partialCredit = partial;
        }
        if (correct.some(letter => !/^[A-H]$/.test(letter))) throw new QuestionFormatError('"Correta" deve ter as letras das alternativas (por exemplo, B ou A, C).', 'csv_correct');
        const beyond = correct.find(letter => LETTERS.indexOf(letter) >= filled.length);
        if (beyond && filled.length) {
            throw new QuestionFormatError(`"Correta" tem a letra ${beyond}, mas a linha só tem ${filled.length} ${filled.length === 1 ? 'alternativa' : `alternativas (A a ${LETTERS[filled.length - 1]})`}.`, 'csv_correct');
        }
    } else if (type === 'true_false') {
        raw.correctAnswer = String(cells.correta || '').trim().toUpperCase();
        if (filled.length) warn('verdadeiro ou falso usa só "Verdadeiro" e "Falso"; as alternativas da linha ficaram de fora.');
    } else if (type === 'numeric') {
        raw.numeric = { value: cells.valor || '', tolerance: cells.tolerancia || '', unit: cells.unidade || '' };
        raw.review = readReview(cells.revisao);
    } else if (type === 'short_answer') {
        raw.acceptedAnswers = splitList(cells.respostas_aceitas);
        raw.review = readReview(cells.revisao);
    } else {
        if (cells.resposta_esperada) raw.expectedAnswer = cells.resposta_esperada;
        if (cells.rubrica && cells.rubrica.trim()) raw.rubric = readRubric(cells.rubrica);
    }
    if ((type === 'numeric' || type === 'short_answer' || type === 'essay') && filled.length) {
        warn(`${TYPE_LABELS[type]} não tem alternativas; as da linha ficaram de fora.`);
    }
    if (cells.explicacao) raw.explanation = cells.explicacao;
    const difficulty = readDifficulty(cells.dificuldade);
    if (difficulty) raw.difficulty = difficulty;
    const skills = splitList(cells.habilidades);
    if (skills.length) raw.skills = skills;
    const tags = splitList(cells.etiquetas);
    if (tags.length) raw.tags = tags;
    return raw;
}

// Planilha (buffer) -> { entradas, erros, avisos }.
function parseQuestionSheet(buffer, { nomeArquivo } = {}) {
    let table;
    try {
        table = parseTabularFile(buffer, {
            nomeArquivo,
            maxLinhas: IMPORT_LIMITS.maxQuestions,
            maxColunas: 50,
            maxBytes: IMPORT_LIMITS.maxBytes,
        });
    } catch (error) {
        if (error instanceof TabularFileError) throw new QuestionFormatError(error.message, error.code, { status: error.status });
        throw error;
    }
    const keys = table.cabecalho.map(header => headerKey(cellText(header)));
    if (!keys.includes('enunciado')) {
        throw new QuestionFormatError('A primeira linha da planilha precisa ser o cabeçalho, com pelo menos a coluna "Enunciado" (veja as colunas na Ajuda ou exporte o banco para ter o modelo).', 'csv_header');
    }
    const avisos = [];
    const unknown = table.cabecalho.filter((header, index) => keys[index] && !CSV_KEYS.has(keys[index]));
    if (unknown.length) avisos.push({ linha: 1, mensagem: `As colunas ${unknown.map(name => `"${String(name).trim().slice(0, 40)}"`).join(', ')} não fazem parte da importação e ficaram de fora.` });
    const seenKeys = new Set();
    keys.forEach(key => {
        if (key && CSV_KEYS.has(key) && seenKeys.has(key)) avisos.push({ linha: 1, mensagem: `A coluna "${key}" aparece duas vezes; vale a primeira.` });
        seenKeys.add(key);
    });
    (table.avisos || []).forEach(message => avisos.push({ linha: 1, mensagem: String(message) }));
    const entradas = [];
    const erros = [];
    table.linhas.forEach(row => {
        const cells = {};
        keys.forEach((key, index) => {
            if (!CSV_KEYS.has(key) || Object.prototype.hasOwnProperty.call(cells, key)) return;
            cells[key] = cellText(row.valores[index]);
        });
        const lineWarnings = [];
        const warn = message => { const text = capitalize(message); if (!lineWarnings.includes(text)) lineWarnings.push(text); };
        try {
            const questao = rowQuestion(cells, warn);
            entradas.push({ linha: row.numero, categoria: String(cells.categoria || '').trim(), questao, avisos: lineWarnings });
        } catch (error) {
            if (!(error instanceof QuestionFormatError)) throw error;
            erros.push({ linha: row.numero, mensagem: capitalize(error.message) });
        }
    });
    return { entradas, erros, avisos };
}

// ------------------------------------------------------------------ entrada única

// Pedido -> bytes do arquivo: o texto colado (UTF-8) ou o arquivo escolhido em base64.
function importBuffer({ conteudo, arquivo } = {}) {
    let buffer;
    if (typeof arquivo === 'string' && arquivo) {
        const clean = arquivo.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new QuestionFormatError('O arquivo enviado está corrompido. Escolha o arquivo de novo.', 'file_invalid');
        buffer = Buffer.from(clean, 'base64');
    } else if (typeof conteudo === 'string') {
        buffer = Buffer.from(conteudo, 'utf8');
    } else {
        throw new QuestionFormatError('Escolha um arquivo ou cole o texto das questões.', 'file_missing');
    }
    if (!buffer.length || !buffer.toString('utf8').trim()) throw new QuestionFormatError('O arquivo está vazio.', 'file_empty');
    if (buffer.length > IMPORT_LIMITS.maxBytes) {
        throw new QuestionFormatError(`O arquivo passa de ${sizeText(IMPORT_LIMITS.maxBytes)} MB. Divida em arquivos menores.`, 'file_too_large', { status: 413 });
    }
    return buffer;
}

function looksBinary(buffer) {
    const head = buffer.subarray(0, 8);
    if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4B) return true; // ZIP (XLSX, DOCX)
    if (head.length >= 8 && head.readUInt32BE(0) === 0xD0CF11E0) return true; // .xls, .doc
    if (head.toString('latin1', 0, 5) === '%PDF-') return true;
    return false;
}

// Impressão digital da questão para achar repetida: tipo, enunciado e alternativas sem
// acento, maiúscula nem espaço a mais.
function questionFingerprint(question) {
    const type = typeof question?.type === 'string' && QUESTION_TYPES.includes(question.type) ? question.type : 'multiple_choice';
    const text = normalizeSearch(bankQuestionText(question) || question?.text || '');
    const alternatives = (Array.isArray(question?.alternatives) ? question.alternatives : [])
        .map(alternative => normalizeSearch(typeof alternative === 'string' ? alternative : alternative?.text || ''));
    return `${type}\u0000${text}\u0000${alternatives.join('\u0001')}`;
}

// Leitura completa para a prévia e para a confirmação: cada questão pelo modelo do banco,
// a categoria (a do arquivo, senão a padrão, senão "Geral") e a marca de repetida (no
// banco que a conta vê, inclusive arquivada, ou mais acima no mesmo arquivo).
// Devolve { formato, sha256, itens: [{ linha, category, question, duplicada, arquivada,
// noArquivo, avisos }], erros, avisos }. Erro do arquivo inteiro: QuestionFormatError.
function readQuestionImport({ formato, conteudo, arquivo, nomeArquivo, categoriaPadrao, existingItems = [] } = {}) {
    if (!FORMATS.includes(formato)) throw new QuestionFormatError('Escolha o formato: GIFT ou planilha (CSV).', 'format_invalid');
    const buffer = importBuffer({ conteudo, arquivo });
    let parsed;
    if (formato === 'gift') {
        if (looksBinary(buffer)) throw new QuestionFormatError('O arquivo não é um texto GIFT. No Moodle, exporte o banco em "Formato GIFT"; para planilha, escolha "Planilha (CSV)".', 'unsupported_format');
        const { texto } = decodeText(buffer);
        if (texto.includes('\u0000')) throw new QuestionFormatError('O arquivo não é um texto GIFT.', 'unsupported_format');
        parsed = { ...parseGift(texto), avisos: [] };
    } else {
        parsed = parseQuestionSheet(buffer, { nomeArquivo });
    }
    if (!parsed.entradas.length && !parsed.erros.length) {
        throw new QuestionFormatError(formato === 'gift' ? 'O arquivo não tem nenhuma questão GIFT.' : 'A planilha não tem nenhuma linha de questão depois do cabeçalho.', 'no_questions');
    }
    const fallbackCategory = String(categoriaPadrao || '').trim() || DEFAULT_CATEGORY;
    const known = new Map();
    (Array.isArray(existingItems) ? existingItems : []).filter(Boolean).forEach(item => {
        const key = questionFingerprint({ ...item, text: bankQuestionText(item) });
        if (!known.has(key) || known.get(key).archived) known.set(key, { archived: item.archived === true });
    });
    const inFile = new Map();
    const itens = [];
    const erros = [...parsed.erros];
    parsed.entradas.forEach(entry => {
        const category = String(entry.categoria || '').trim() || fallbackCategory;
        if (category.length > QUESTION_CATEGORY_MAX_CHARS) {
            erros.push({ linha: entry.linha, mensagem: `A categoria aceita no máximo ${QUESTION_CATEGORY_MAX_CHARS} caracteres.` });
            return;
        }
        let question;
        try {
            question = normalizeBankQuestion(entry.questao);
        } catch (error) {
            if (!error || error.status !== 400) throw error;
            erros.push({ linha: entry.linha, mensagem: error.message });
            return;
        }
        const fingerprint = questionFingerprint(question);
        const existing = known.get(fingerprint);
        const earlier = inFile.get(fingerprint);
        if (!earlier) inFile.set(fingerprint, entry.linha);
        itens.push({
            linha: entry.linha,
            category,
            question,
            duplicada: !!existing || !!earlier,
            arquivada: !!existing && existing.archived,
            noArquivo: !existing && earlier ? earlier : null,
            avisos: entry.avisos || [],
        });
    });
    erros.sort((a, b) => a.linha - b.linha);
    return { formato, sha256: fileSha256(buffer), itens, erros, avisos: parsed.avisos || [] };
}

// ------------------------------------------------------------------ exportação

// Item do banco -> questão no modelo (o item antigo é lido com padrão, como no GET). null
// quando o modelo recusa (item antigo incompleto): ele fica fora do arquivo.
function exportQuestion(item) {
    try {
        return normalizeBankQuestion({}, { previous: item });
    } catch (error) {
        if (error && error.status === 400) return null;
        throw error;
    }
}

function weightText(value) {
    const rounded = Math.round(value * 100000) / 100000;
    return String(rounded);
}

function giftMeta(question) {
    const meta = {};
    if (question.points !== undefined && question.points !== 1) meta.points = question.points;
    if (question.type === 'multiple_answer' && question.partialCredit === false) meta.partialCredit = false;
    if ((question.type === 'numeric' || question.type === 'short_answer') && question.review === 'professor') meta.review = 'professor';
    if (question.type === 'numeric' && question.numeric && question.numeric.unit) meta.unit = question.numeric.unit;
    if (question.expectedAnswer) meta.expectedAnswer = question.expectedAnswer;
    if (Array.isArray(question.rubric) && question.rubric.length) meta.rubric = question.rubric.map(({ nome, pontos }) => ({ nome, pontos }));
    if (question.difficulty) meta.difficulty = question.difficulty;
    if (Array.isArray(question.skills) && question.skills.length) meta.skills = question.skills;
    const oddTags = (question.tags || []).filter(tag => /[\]\r\n]/.test(tag));
    if (oddTags.length) meta.tags = oddTags;
    return meta;
}

function giftAnswers(question) {
    const lines = [];
    const alternatives = Array.isArray(question.alternatives) ? question.alternatives : [];
    if (question.type === 'multiple_choice') {
        alternatives.forEach(alternative => lines.push(`${alternative.isCorrect ? '=' : '~'}${giftEscape(alternative.text)}`));
    } else if (question.type === 'multiple_answer') {
        const correct = alternatives.filter(alternative => alternative.isCorrect).length;
        const wrong = alternatives.length - correct;
        alternatives.forEach(alternative => {
            const weight = alternative.isCorrect ? 100 / correct : -100 / (wrong || 1);
            lines.push(`~%${weightText(weight)}%${giftEscape(alternative.text)}`);
        });
    } else if (question.type === 'true_false') {
        lines.push(question.correctAnswer === 'B' ? 'FALSE' : 'TRUE');
    } else if (question.type === 'numeric') {
        const numeric = question.numeric || {};
        lines.push(`#${numeric.value}${Number(numeric.tolerance) > 0 ? `:${numeric.tolerance}` : ''}`);
    } else if (question.type === 'short_answer') {
        (question.acceptedAnswers || []).forEach(answer => lines.push(`=${giftEscape(answer)}`));
    }
    if (question.explanation) lines.push(`####${giftEscape(question.explanation)}`);
    return lines;
}

// Itens do banco -> texto GIFT. Devolve { text, quantidade, foraDoArquivo }.
function toGift(items, { exportedAt = '' } = {}) {
    const groups = new Map();
    let skipped = 0;
    (Array.isArray(items) ? items : []).forEach(item => {
        const question = exportQuestion(item);
        if (!question) { skipped += 1; return; }
        const category = itemCategory(item);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(question);
    });
    const total = [...groups.values()].reduce((sum, list) => sum + list.length, 0);
    const out = [
        `// Banco de questões do IClass${exportedAt ? `, exportado em ${exportedAt}` : ''}: ${total} ${total === 1 ? 'questão' : 'questões'}.`,
        '// Formato GIFT: importe no Moodle (Banco de questões > Importar > GIFT) ou em outro IClass (Provas > Ver banco de questões > Importar).',
        '// As linhas "// iclass:" guardam o que o GIFT não tem (pontos, dificuldade, rubrica...); o Moodle as ignora.',
        '',
    ];
    groups.forEach((questions, category) => {
        out.push(`$CATEGORY: ${giftEscape(category).replace(/\//g, '//')}`, '');
        questions.forEach(question => {
            const tags = (question.tags || []).filter(tag => !/[\]\r\n]/.test(tag));
            if (tags.length) out.push(`// ${tags.map(tag => `[tag:${tag}]`).join(' ')}`);
            const meta = giftMeta(question);
            if (Object.keys(meta).length) out.push(`// iclass: ${JSON.stringify(meta)}`);
            const answers = giftAnswers(question);
            out.push(`[markdown]${giftEscape(question.questionText)} {`);
            answers.forEach(line => out.push(`\t${line}`));
            out.push('}', '');
        });
    });
    return { text: out.join('\r\n'), quantidade: total, foraDoArquivo: skipped };
}

function sheetRow(question, category) {
    const cells = Object.fromEntries(CSV_COLUMNS.map(column => [column.key, '']));
    cells.categoria = category;
    cells.tipo = TYPE_LABELS[question.type] || TYPE_LABELS.multiple_choice;
    cells.enunciado = question.questionText;
    cells.pontos = formatDecimal(question.points ?? 1);
    const alternatives = Array.isArray(question.alternatives) ? question.alternatives : [];
    if (question.type === 'multiple_choice' || question.type === 'multiple_answer') {
        alternatives.slice(0, LETTERS.length).forEach((alternative, index) => { cells[`alternativa_${LETTERS[index].toLowerCase()}`] = alternative.text; });
        const letters = alternatives.filter(alternative => alternative.isCorrect).map(alternative => alternative.letter);
        cells.correta = letters.join(', ');
        if (question.type === 'multiple_answer') cells.pontuacao_parcial = question.partialCredit === false ? 'não' : 'sim';
    } else if (question.type === 'true_false') {
        cells.correta = question.correctAnswer === 'B' ? 'F' : 'V';
    } else if (question.type === 'numeric') {
        const numeric = question.numeric || {};
        cells.valor = formatDecimal(numeric.value);
        cells.tolerancia = formatDecimal(numeric.tolerance || 0);
        cells.unidade = numeric.unit || '';
        cells.revisao = question.review === 'professor' ? 'professor' : '';
    } else if (question.type === 'short_answer') {
        cells.respostas_aceitas = (question.acceptedAnswers || []).join(LIST_SEPARATOR);
        cells.revisao = question.review === 'professor' ? 'professor' : '';
    } else {
        cells.resposta_esperada = question.expectedAnswer || '';
        cells.rubrica = (question.rubric || []).map(criterion => `${criterion.nome}: ${formatDecimal(criterion.pontos)}`).join(LIST_SEPARATOR);
    }
    cells.explicacao = question.explanation || '';
    cells.dificuldade = { facil: 'Fácil', media: 'Média', dificil: 'Difícil' }[question.difficulty] || '';
    cells.habilidades = (question.skills || []).join(LIST_SEPARATOR);
    cells.etiquetas = (question.tags || []).join(LIST_SEPARATOR);
    return CSV_COLUMNS.map(column => cells[column.key]);
}

// Itens do banco -> CSV (BOM UTF-8, ";", CRLF e fórmula neutralizada pelo buildCsv).
// Devolve { text, quantidade, foraDoArquivo }.
function toCsv(items) {
    const rows = [];
    let skipped = 0;
    (Array.isArray(items) ? items : []).forEach(item => {
        const question = exportQuestion(item);
        if (!question) { skipped += 1; return; }
        rows.push(sheetRow(question, itemCategory(item)));
    });
    return { text: buildCsv([CSV_COLUMNS.map(column => column.header), ...rows]), quantidade: rows.length, foraDoArquivo: skipped };
}

module.exports = {
    CSV_COLUMNS,
    FORMATS,
    IMPORT_LIMITS,
    QuestionFormatError,
    parseGift,
    parseQuestionSheet,
    questionFingerprint,
    readQuestionImport,
    toCsv,
    toGift,
    // Para os testes.
    _internals: { giftEscape, htmlToText, protectGift, restoreGift, giftCategory, readLetters },
};
