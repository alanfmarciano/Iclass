// Gabarito do professor que por engano foi parar numa apostila (B-gabarito): sai do
// texto servido ao aluno por regras fixas, sem adivinhar pelo conteúdo.
//
// Regra para o professor: o gabarito dele fica sob um título "## Gabarito do professor"
// (ou num <details> com esse resumo). Um rótulo em negrito ("**Gabarito do professor**")
// protege até o fim da seção em que está.
//
// Palavras: gabarito = "gabarito" (ou "chave de respostas"/"chave de correção"); marca do
// professor = professor(a), prof., profs., profa. (também "Prof&ordf;"), instrutor(a),
// docente, exclusivo(a). "Oficial" sozinho não é marca, exceto no <summary> de <details>
// ("gabarito oficial").
//
// A remoção é feita em etapas, sem dependência nova:
// 0. pré-passagem: todos os comentários HTML <!-- --> fora de código saem ANTES de
//    reconhecer títulos e rótulos (comentário nunca é para o aluno, e "## Gabarito <!-- x
//    --> do professor" é o título do professor). Depois do ">" de uma citação, o
//    comentário sai sem o ">" e sem a quebra de linha (a citação não se parte em duas);
// 1. tokenize: uma varredura LINEAR divide o texto em blocos: cercas de código (``` e
//    ~~~), código com recuo, <pre>, comentários, títulos Markdown e <h1>-<h6>, itens de
//    lista e citações (com o recuo de cada um), tags de contêiner HTML (<p>, <div>,
//    <section>, <details>, <ul>, <ol>, <li>, <table>, <blockquote>...) e parágrafos ou
//    trechos de texto (o parágrafo acaba na linha em branco ou quando a linha seguinte
//    abre outro bloco). Cada bloco guarda o trecho exato do original, e o documento é
//    remontado só com os trechos que ficam, sem alterar nada do resto;
// 2. as regras escolhem trechos inteiros para tirar:
//    - código (cercado, com recuo, inline ou <pre>) nunca é casado nem cortado;
//    - <details> cujo <summary> tem gabarito + marca (ou "gabarito oficial"): o elemento
//      inteiro, com os <details> de dentro;
//    - título (Markdown, sublinhado ou <h1>-<h6>, também em citação ou item de lista) com
//      gabarito + marca: até o próximo título de nível igual ou menor (## para em ## ou #);
//    - rótulo em negrito com gabarito + marca no começo de um bloco ou de uma linha dele
//      ("**Gabarito do professor**", <strong>, <b>, também em maiúsculas, dentro de
//      itálico ("_**...**_", <em><strong>) ou de <span>; também depois de emoji ou outro
//      símbolo, e em <p>, <li>, <div>). O rótulo é o texto em negrito até o primeiro ":".
//      O rótulo SEMPRE abre uma seção, sozinho ou com texto (as respostas) depois dele no
//      mesmo bloco: vai até o próximo título de nível igual ou menor que o do título da
//      seção onde está (subtítulos mais fundos, como "### Questão 1" numa seção "##", saem
//      junto); sem título acima, até o próximo título de nível 1 ou 2 ou o fim. Elemento
//      (<p>, <li>, <div>...), item de lista ou citação que só tem o bloco do rótulo sai
//      junto com ele, e o item de lista que a remoção esvazia (rótulo sozinho + sublista)
//      sai inteiro. Rótulo em célula de tabela HTML não é reconhecido (tabela não é
//      suportada e fica inteira), nem negrito quebrado em duas linhas ("**Gabarito do" e
//      "professor**" na linha seguinte);
//    - a remoção nunca atravessa o fechamento de um contêiner aberto antes dela (div,
//      section, li, details, blockquote, p..., citação ou item de lista em Markdown): para
//      nele e o fechamento fica. Contêiner aberto dentro do trecho removido sai junto com
//      o fechamento dele, mesmo que o fechamento venha depois do trecho. Trecho que
//      termina num título Markdown preserva a linha em branco que fechava um bloco HTML
//      aberto antes dele (sem ela, o título viraria texto do bloco HTML).
// Nada mais sai: glossário, avisos, "Gabarito dos exercícios", "Ver resposta", tabela,
// rótulo em itálico ou sem negrito e "gabarito" sem a marca do professor ficam. A função
// é idempotente: aplicada de novo no resultado, não muda nada.

// ---------------------------------------------------------------- palavras do gabarito

// Entidades HTML mais comuns em títulos escritos à mão (GABARITO&nbsp;OFICIAL).
// Letra acentuada (&ccedil;, &atilde;, &eacute;...) vira a letra sem acento, que é como o
// rótulo é comparado; &shy; (hífen invisível) some.
const NAMED_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '-', mdash: '-', shy: '', ordf: 'a', ordm: 'o' };
const ACCENTED_ENTITY = /^([a-z])(acute|grave|circ|tilde|uml|cedil|ring)$/i;
function decodeHtmlEntities(text) {
    return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
        if (code[0] === '#') {
            const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            try { return Number.isFinite(value) ? String.fromCodePoint(value) : ' '; } catch (error) { return ' '; }
        }
        const accented = ACCENTED_ENTITY.exec(code);
        if (accented) return accented[1];
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, code.toLowerCase()) ? NAMED_ENTITIES[code.toLowerCase()] : ' ';
    });
}

function normalizedLabel(html) {
    return decodeHtmlEntities(String(html || '').replace(/<[^<>]*>/g, ' '))
        .replace(/\p{Cf}/gu, '')      // hífen invisível, espaço de largura zero
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const ANSWER_KEY_WORD = /\b(gabaritos?|chaves? de (respostas?|correcao))\b/;
const TEACHER_MARKER = /\b(professor|professora|professores|professoras|prof|profs|profa|profas|docente|docentes|instrutor|instrutora|instrutores|instrutoras|exclusivo|exclusiva|exclusivos|exclusivas)\b/;
const OFFICIAL_ANSWER_KEY = /\b(gabaritos?|chaves? de (respostas?|correcao)) oficia(l|is)\b/;

function hasTeacherAnswerKey(text) {
    const label = normalizedLabel(text);
    return ANSWER_KEY_WORD.test(label) && TEACHER_MARKER.test(label);
}

// <summary> do bloco do professor ("GABARITO EXCLUSIVO DO PROFESSOR", "Gabarito do
// prof.", "GABARITO&nbsp;OFICIAL"). "Gabarito dos exercícios" e "Ver resposta" ficam.
function isTeacherAnswerKeySummary(summaryHtml) {
    return hasTeacherAnswerKey(summaryHtml) || OFFICIAL_ANSWER_KEY.test(normalizedLabel(summaryHtml));
}

// Código inline (`...`) não conta no texto de título ou de rótulo.
function withoutInlineCode(text) {
    const value = String(text || '');
    if (!value.includes('`')) return value;
    const codeEnd = codeSpanFinder(value);
    let output = '';
    let position = 0;
    for (let tick = value.indexOf('`'); tick >= 0;) {
        const span = codeEnd(tick);
        if (span.end >= 0) {
            output += `${value.slice(position, tick)} `;
            position = span.end;
            tick = value.indexOf('`', span.end);
        } else {
            tick = value.indexOf('`', span.runEnd);
        }
    }
    return output + value.slice(position);
}

// ---------------------------------------------------------------- etapa 1: blocos

// Tags que abrem bloco HTML no começo da linha (CommonMark, tipo 6).
const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt '
    + 'fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem '
    + 'nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
// Contêineres HTML: a remoção não atravessa o fechamento de um deles aberto antes dela.
const CONTAINER_TAGS = new Set(('address article aside blockquote caption center dd details dialog div dl dt fieldset figcaption figure footer '
    + 'form header li main nav ol p section summary table tbody td tfoot th thead tr ul').split(' '));
// Conteúdo cru: código, nunca é casado nem cortado.
const RAW_TAGS = new Set(['pre', 'script', 'style', 'textarea']);
// Fechamento implícito: <li> abre e fecha o <li> anterior; <p> fecha com outro bloco.
const P_CLOSERS = new Set(('address article aside blockquote center details dialog div dl fieldset figcaption figure footer form header '
    + 'main nav ol p section summary table ul h1 h2 h3 h4 h5 h6 pre').split(' '));
function closesImplicitly(openTag, nextTag) {
    if (openTag === 'p') return P_CLOSERS.has(nextTag);
    if (openTag === 'li') return nextTag === 'li';
    if (openTag === 'dt' || openTag === 'dd') return nextTag === 'dt' || nextTag === 'dd';
    if (openTag === 'td' || openTag === 'th') return nextTag === 'td' || nextTag === 'th' || nextTag === 'tr';
    if (openTag === 'tr') return nextTag === 'tr';
    return false;
}

// Tag na posição (sticky): o [^<>]* para no próximo "<" (custo linear).
const TAG_AT = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^<>]*>/y;
const ATX_OPEN = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^( {0,3})([-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
const QUOTE_PREFIX = /^ {0,3}>[ ]?/;
const HTML_BLOCK_START = /^ {0,3}<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>]|$)/;
const HTML_TAG_ALONE = /^ {0,3}<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>[ \t]*$/;
const RAW_BLOCK_START = /^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/i;
const COMMENT_START = /^ {0,3}<!--/;
const NEXT_MARK = /[<`]/g;

function isBlank(text) {
    return !/\S/.test(text);
}

// Título Markdown "## Texto ##" no começo do texto: nível, texto e onde o texto começa.
// Feito à mão (sem regex com recuo) para custar linear em linhas longas.
function atxHeading(text) {
    const open = ATX_OPEN.exec(text);
    if (!open) return null;
    const isSpace = char => char === ' ' || char === '\t';
    let start = open[0].length;
    while (start < text.length && isSpace(text[start])) start += 1;
    let end = text.length;
    while (end > start && isSpace(text[end - 1])) end -= 1;
    let hashes = end;
    while (hashes > start && text[hashes - 1] === '#') hashes -= 1;
    if (hashes < end && (hashes === start || isSpace(text[hashes - 1]))) {
        end = hashes;
        while (end > start && isSpace(text[end - 1])) end -= 1;
    }
    return { level: open[1].length, text: text.slice(start, end), textStart: start };
}

// Código inline de uma linha: para a sequência de crases em `tick`, onde acaba o código
// (depois da próxima sequência com o mesmo número de crases) ou -1 se não fecha. As
// posições de cada tamanho de sequência são guardadas uma vez e lidas em ordem, por isso
// a linha inteira custa linear (as chamadas vêm com `tick` crescente).
function codeSpanFinder(text) {
    const byLength = new Map();
    for (let tick = text.indexOf('`'); tick >= 0;) {
        let end = tick;
        while (end < text.length && text[end] === '`') end += 1;
        const size = end - tick;
        if (!byLength.has(size)) byLength.set(size, { positions: [], next: 0 });
        byLength.get(size).positions.push(tick);
        tick = text.indexOf('`', end);
    }
    return tick => {
        let runEnd = tick;
        while (runEnd < text.length && text[runEnd] === '`') runEnd += 1;
        const size = runEnd - tick;
        const runs = byLength.get(size);
        if (!runs) return { end: -1, runEnd };
        while (runs.next < runs.positions.length && runs.positions[runs.next] <= tick) runs.next += 1;
        if (runs.next >= runs.positions.length) return { end: -1, runEnd };
        return { end: runs.positions[runs.next] + size, runEnd };
    };
}

function leadingSpaces(text) {
    return text.length - text.trimStart().length;
}

// Colunas de recuo (tab = até a próxima coluna múltipla de 4) a partir de `from`.
function indentWidth(text, from = 0) {
    let column = 0;
    for (let index = from; index < text.length; index += 1) {
        if (text[index] === ' ') column += 1;
        else if (text[index] === '\t') column += 4 - (column % 4);
        else break;
    }
    return column;
}

// O recuo a partir de `from` chega a `columns` colunas? (para de contar ao chegar)
function indentReaches(text, from, columns) {
    let column = 0;
    for (let index = from; index < text.length && column < columns; index += 1) {
        if (text[index] === ' ') column += 1;
        else if (text[index] === '\t') column += 4 - (column % 4);
        else break;
    }
    return column >= columns;
}

// Avança `columns` colunas de recuo a partir de `from`; devolve a nova posição.
function advanceColumns(text, from, columns) {
    let column = 0;
    let index = from;
    while (index < text.length && column < columns && (text[index] === ' ' || text[index] === '\t')) {
        column += text[index] === '\t' ? 4 - (column % 4) : 1;
        index += 1;
    }
    return index;
}

// Item de lista no começo do texto: onde começa o conteúdo e o recuo dele. isBreak(marca,
// recuo) diz se o resto é um separador (- - -), que não é item; sem ele, usa a regex.
function listItemAt(text, isBreak) {
    const match = LIST_MARKER.exec(text);
    if (!match) return null;
    if ((match[2] === '-' || match[2] === '*') && (isBreak ? isBreak(match[2], match[1].length) : THEMATIC_BREAK.test(text))) return null;
    const markerEnd = match[0].length;
    const after = text.slice(markerEnd);
    const empty = isBlank(after);
    const spaces = indentWidth(after);
    const markerColumns = indentWidth(text) + match[2].length;
    const contentColumns = empty || spaces > 4 ? markerColumns + 1 : markerColumns + spaces;
    const contentPos = empty ? text.length : (spaces > 4 ? markerEnd + 1 : advanceColumns(text, markerEnd, spaces));
    const ordered = /\d/.test(match[2]);
    return { contentPos, contentColumns, first: !ordered || Number(match[2].slice(0, -1)) === 1, empty };
}

function startsHtmlBlock(text, inParagraph) {
    if (COMMENT_START.test(text) || RAW_BLOCK_START.test(text)) return true;
    const html = HTML_BLOCK_START.exec(text);
    if (html && HTML_BLOCK_TAGS.has(html[1].toLowerCase())) return true;
    return !inParagraph && HTML_TAG_ALONE.test(text);
}

// A linha abre outro bloco (e por isso não continua o parágrafo de um contêiner que acabou)?
function startsBlock(text) {
    return QUOTE_PREFIX.test(text) || !!atxHeading(text) || FENCE_OPEN.test(text) || THEMATIC_BREAK.test(text)
        || startsHtmlBlock(text, true) || !!listItemAt(text);
}

// Posição do próximo "<!--" fora de código inline, a partir de `from`; -1 se não há.
// codeEnd: o localizador de código inline da linha (codeSpanFinder), criado uma vez por
// linha e reaproveitado nas chamadas seguintes com `from` crescente (custo linear).
function findCommentStart(text, from, codeEnd = null) {
    let comment = text.indexOf('<!--', from);
    if (comment < 0 || !text.includes('`')) return comment;
    if (!codeEnd) codeEnd = codeSpanFinder(text);
    let index = from;
    while (comment >= 0) {
        const tick = text.indexOf('`', index);
        if (tick < 0 || tick > comment) return comment;
        const span = codeEnd(tick);
        index = span.end >= 0 ? span.end : span.runEnd;
        if (index > comment) comment = text.indexOf('<!--', index);
    }
    return -1;
}

// Divide o texto em blocos: unidades contíguas que cobrem o texto inteiro, na ordem. A
// primeira unidade de cada linha começa no começo da linha (com o ">" da citação e o recuo
// do item), e a última vai até o fim da linha. kind:
// - text: trecho de parágrafo ou de texto entre tags (run = o trecho corrido; atLineStart =
//   começa a linha);
// - heading: título Markdown (#, sublinhado) ou <h1>-<h6> (level, text ou innerStart/End);
// - open/close: tag de contêiner HTML; mdopen/mdclose: citação ou item de lista em
//   Markdown (largura zero, no começo da linha);
// - code (cercado, com recuo, <pre>), comment, blank, hr, space, tail (resto inerte de título).
function tokenize(source) {
    const units = [];
    let cursor = 0;
    let runSeq = 0;
    let run = null;          // trecho de texto corrido atual
    const md = [];           // contêineres Markdown abertos: { type, columns, index }
    let leaf = null;         // { type: 'paragraph' | 'fence' | 'html' | 'raw' | 'comment', ... }
    let heading = null;      // título HTML aberto (<h2> ... </h2>), pode ocupar várias linhas

    const emit = (kind, end, extra) => {
        const unit = { kind, start: cursor, end, ...extra };
        units.push(unit);
        cursor = end;
        if (kind !== 'text' && kind !== 'comment' && kind !== 'space') run = null;
        return unit;
    };
    const emitText = (end, contentStart, atLineStart) => {
        if (run === null) run = ++runSeq;
        return emit('text', end, { contentStart, atLineStart, run });
    };
    const extend = (unit, end) => { unit.end = end; cursor = end; };
    // Fim da linha: o espaço que sobrou entra no último bloco da linha (comentário não
    // leva a quebra de linha: o que vem depois dele continua na linha seguinte).
    const finishLine = line => {
        if (cursor >= line.end) return;
        const last = units[units.length - 1];
        if (last && cursor > line.start && last.end > last.start && last.kind !== 'comment') extend(last, line.end);
        else emit('space', line.end);
    };
    const closeHeading = () => {
        if (heading && heading.innerEnd === undefined) heading.innerEnd = heading.end;
        heading = null;
    };
    const closeMd = from => {
        while (md.length > from) {
            const container = md.pop();
            emit('mdclose', cursor, { type: container.type, openIndex: container.index });
        }
    };

    // Conteúdo de uma linha a partir de `from`: tags de contêiner, títulos <hN>, <pre>,
    // comentários e o texto entre eles (tags inline como <strong> ficam no texto).
    // codeAware: no parágrafo Markdown, o código inline (`...`) não é olhado por dentro.
    const scanContent = (line, from, lineStart, codeAware) => {
        const text = line.text;
        let pending = from;          // começo do texto ainda não emitido
        let atLineStart = lineStart;
        let codeEnd = null;          // código inline da linha (criado na primeira crase)
        // Recuo da linha: comentário depois só de espaços está em linha própria; depois do
        // ">" de uma citação (ou de texto), a remoção começa no "<!--" e a quebra de linha
        // fica, para a citação não se partir em duas.
        let indent = 0;
        while (indent < text.length && (text[indent] === ' ' || text[indent] === '\t')) indent += 1;
        const flush = until => {
            if (pending >= until) return;
            const piece = text.slice(pending, until);
            if (isBlank(piece)) emit('space', line.start + until);
            else emitText(line.start + until, line.start + pending + leadingSpaces(piece), atLineStart);
            atLineStart = false;
            pending = until;
        };
        let index = from;
        while (index < text.length) {
            NEXT_MARK.lastIndex = index;
            const mark = NEXT_MARK.exec(text);
            if (!mark) break;
            const next = mark.index;
            if (text[next] === '`') {
                if (!codeAware) { index = next + 1; continue; }
                if (!codeEnd) codeEnd = codeSpanFinder(text);
                const span = codeEnd(next);
                index = span.end >= 0 ? span.end : span.runEnd;
                continue;
            }
            if (heading) {
                // Dentro de <hN>: só o fechamento ou outro título encerra. Comentário de
                // dentro do título sai sozinho (hole), mesmo quando o título fica.
                if (text.startsWith('<!--', next)) {
                    const close = text.indexOf('-->', next + 4);
                    const hole = [line.start + next, close < 0 ? null : line.start + close + 3];
                    (heading.holes || (heading.holes = [])).push(hole);
                    if (close < 0) {
                        extend(heading, line.end);
                        leaf = { type: 'comment', resume: leaf, midLine: true, unit: heading, hole };
                        return;
                    }
                    index = close + 3;
                    continue;
                }
                TAG_AT.lastIndex = next;
                const tag = TAG_AT.exec(text);
                if (tag && /^h[1-6]$/i.test(tag[2])) {
                    const end = tag[1] ? next + tag[0].length : next;
                    heading.innerEnd = line.start + next;
                    extend(heading, line.start + end);
                    heading = null;
                    run = null;
                    atLineStart = false;
                    pending = end;
                    index = end;
                    continue;
                }
                index = next + 1;
                continue;
            }
            if (text.startsWith('<!--', next)) {
                flush(next);
                const close = text.indexOf('-->', next + 4);
                const cutStart = next > indent ? line.start + next : cursor;
                if (close < 0) {
                    leaf = { type: 'comment', resume: leaf, midLine: next > indent, unit: emit('comment', line.end, { cutStart }) };
                    return;
                }
                emit('comment', line.start + close + 3, { cutStart });
                atLineStart = false;
                pending = close + 3;
                index = pending;
                continue;
            }
            TAG_AT.lastIndex = next;
            const tag = TAG_AT.exec(text);
            if (!tag) { index = next + 1; continue; }
            const closing = !!tag[1];
            const name = tag[2].toLowerCase();
            const tagEnd = next + tag[0].length;
            const level = /^h([1-6])$/.exec(name);
            if (!closing && RAW_TAGS.has(name)) {
                flush(next);
                const closeTag = new RegExp(`</${name}`, 'gi');
                closeTag.lastIndex = tagEnd;
                const closeMatch = closeTag.exec(text);
                const close = closeMatch ? closeMatch.index : -1;
                if (close < 0) {
                    leaf = { type: 'raw', tag: name, resume: leaf, unit: emit('code', line.end) };
                    return;
                }
                const closeEnd = text.indexOf('>', close);
                const end = closeEnd < 0 ? text.length : closeEnd + 1;
                emit('code', line.start + end);
                atLineStart = false;
                pending = end;
                index = end;
                continue;
            }
            if (level && !closing) {
                flush(next);
                heading = emit('heading', line.start + tagEnd, { level: Number(level[1]), html: true, innerStart: line.start + tagEnd });
                atLineStart = false;
                pending = tagEnd;
                index = tagEnd;
                continue;
            }
            if (CONTAINER_TAGS.has(name) && !/\/>$/.test(tag[0])) {
                flush(next);
                emit(closing ? 'close' : 'open', line.start + tagEnd, { tag: name, tagStart: line.start + next, tagEnd: line.start + tagEnd });
                atLineStart = false;
                pending = tagEnd;
                index = tagEnd;
                continue;
            }
            // Tag inline (strong, b, em, span, a, br, img...): faz parte do texto.
            index = tagEnd;
        }
        if (heading) { extend(heading, line.end); return; }
        flush(text.length);
        finishLine(line);
    };

    // Resto da linha de um título Markdown: comentários saem, o resto é inerte. codeEnd: o
    // localizador de código inline da linha (um só por linha, sem custo quadrático).
    const scanTail = (line, from, codeEnd) => {
        const text = line.text;
        let index = from;
        for (;;) {
            const comment = findCommentStart(text, index, codeEnd);
            if (comment < 0) break;
            if (line.start + comment > cursor) emit('tail', line.start + comment);
            const close = text.indexOf('-->', comment + 4);
            if (close < 0) {
                leaf = { type: 'comment', resume: null, midLine: true, unit: emit('comment', line.end, { cutStart: line.start + comment }) };
                return;
            }
            emit('comment', line.start + close + 3, { cutStart: line.start + comment });
            index = close + 3;
        }
        finishLine(line);
    };

    const lines = [];
    for (let start = 0; start < source.length;) {
        const newline = source.indexOf('\n', start);
        const end = newline < 0 ? source.length : newline + 1;
        lines.push({ start, end, text: source.slice(start, newline < 0 ? source.length : newline).replace(/\r$/, '') });
        start = end;
    }

    for (const line of lines) {
        const text = line.text;

        // Comentário de várias linhas: engole tudo até o "-->".
        if (leaf && leaf.type === 'comment') {
            const close = text.indexOf('-->');
            if (close < 0) { extend(leaf.unit, line.end); continue; }
            const after = close + 3;
            const { resume, midLine, hole } = leaf;
            if (hole) hole[1] = line.start + after;
            leaf = resume;
            if (isBlank(text.slice(after))) {
                // Comentário de linhas inteiras sai com a quebra de linha; no meio de uma linha, não.
                extend(units[units.length - 1], midLine ? line.start + after : line.end);
                if (midLine) finishLine(line);
                continue;
            }
            extend(units[units.length - 1], line.start + after);
            scanContent(line, after, false, !!(leaf && leaf.type === 'paragraph'));
            if (leaf && !['paragraph', 'html', 'comment', 'raw'].includes(leaf.type)) leaf = null;
            continue;
        }

        // Contêineres Markdown que continuam nesta linha.
        const blankFrom = text.trimEnd().length;   // a linha é vazia a partir daqui
        let pos = 0;
        let matched = 0;
        for (const container of md) {
            if (container.type === 'quote') {
                const quote = QUOTE_PREFIX.exec(text.slice(pos));
                if (!quote) break;
                pos += quote[0].length;
            } else if (pos >= blankFrom) {
                pos = text.length;
            } else if (indentReaches(text, pos, container.columns)) {
                pos = advanceColumns(text, pos, container.columns);
            } else {
                break;
            }
            matched += 1;
        }
        let rest = text.slice(pos);
        // Separador "- - -" no resto da linha (não é item de lista): o trecho final da linha
        // só com a marca e espaços é calculado uma vez por marca, e cada consulta é curta.
        const tails = {};
        const breakAt = (char, lead) => {
            if (tails[char] === undefined) {
                let tail = text.length;
                while (tail > 0 && (text[tail - 1] === char || text[tail - 1] === ' ' || text[tail - 1] === '\t')) tail -= 1;
                tails[char] = tail;
            }
            const from = pos + lead;
            if (from < tails[char]) return false;
            let count = 0;
            for (let index = from; index < text.length && count < 3; index += 1) if (text[index] === char) count += 1;
            return count >= 3;
        };
        const allMatched = matched === md.length;

        // Código cercado e <pre> continuam enquanto os contêineres continuam.
        if (allMatched && leaf && (leaf.type === 'fence' || leaf.type === 'raw')) {
            extend(leaf.unit, line.end);
            if (leaf.type === 'fence') {
                const close = new RegExp(`^ {0,3}${leaf.char === '`' ? '`' : '~'}{${leaf.length},}[ \\t]*$`);
                if (close.test(rest)) leaf = null;
            } else if (rest.toLowerCase().includes(`</${leaf.tag}`)) {
                leaf = leaf.resume && ['html', 'paragraph'].includes(leaf.resume.type) ? leaf.resume : null;
            }
            continue;
        }
        // Bloco HTML continua até a linha em branco. Linha "## ..." dentro dele (que o
        // Markdown mostra como texto) também conta como título, para o gabarito não vazar.
        if (allMatched && leaf && leaf.type === 'html') {
            if (isBlank(rest)) {
                const closesHtmlFrom = leaf.firstIndex;
                closeHeading();
                leaf = null;
                emit('blank', line.end, { closesHtmlFrom });
            } else if (!heading && atxHeading(rest)) {
                const atx = atxHeading(rest);
                emit('heading', line.end, { level: atx.level, text: atx.text });
            } else {
                scanContent(line, pos, true, false);
            }
            continue;
        }

        // Linha preguiçosa: continua o parágrafo mesmo sem o ">" ou o recuo do item.
        if (!allMatched && leaf && leaf.type === 'paragraph' && !isBlank(rest) && !startsBlock(rest)) {
            scanContent(line, pos, true, true);
            continue;
        }
        if (!allMatched) {
            closeHeading();
            leaf = null;
            closeMd(matched);
        }

        // Novos contêineres Markdown (citação, item de lista) no começo da linha.
        for (;;) {
            const quote = QUOTE_PREFIX.exec(rest);
            if (quote) {
                closeHeading();
                leaf = null;
                emit('mdopen', cursor, { type: 'quote' });
                md.push({ type: 'quote', index: units.length - 1 });
                pos += quote[0].length;
                rest = text.slice(pos);
                continue;
            }
            const item = listItemAt(rest, breakAt);
            const inParagraph = leaf && leaf.type === 'paragraph';
            if (item && (!inParagraph || (!item.empty && item.first))) {
                closeHeading();
                leaf = null;
                emit('mdopen', cursor, { type: 'item' });
                md.push({ type: 'item', columns: item.contentColumns, index: units.length - 1 });
                pos += item.contentPos;
                rest = text.slice(pos);
                if (item.empty) break;
                continue;
            }
            break;
        }

        // Folha: linha em branco, código, título, separador, HTML ou parágrafo.
        const inParagraph = leaf && leaf.type === 'paragraph';
        if (isBlank(rest)) {
            closeHeading();
            leaf = null;
            emit('blank', line.end);
            continue;
        }
        if (indentWidth(rest) >= 4 && !inParagraph) {
            leaf = null;
            emit('code', line.end);
            continue;
        }
        const fence = FENCE_OPEN.exec(rest);
        if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
            closeHeading();
            leaf = { type: 'fence', char: fence[1][0], length: fence[1].length, unit: emit('code', line.end) };
            continue;
        }
        if (inParagraph && !heading && SETEXT_UNDERLINE.test(rest)) {
            // Parágrafo sublinhado (=== ou ---): o parágrafo inteiro vira um título; os
            // comentários de dentro dele continuam saindo (holes).
            const first = leaf.firstIndex;
            const inner = [];
            const holes = [];
            units.slice(first).forEach(unit => {
                if (unit.kind === 'comment') holes.push([unit.start, unit.end]);
                else if (unit.kind === 'text') inner.push(source.slice(unit.contentStart, unit.end));
                else inner.push(source.slice(unit.start, unit.end));
            });
            cursor = units[first].start;
            units.length = first;
            run = null;
            emit('heading', line.end, { level: SETEXT_UNDERLINE.exec(rest)[1][0] === '=' ? 1 : 2, text: inner.join(' '), holes });
            leaf = null;
            continue;
        }
        const atx = atxHeading(rest);
        if (atx) {
            closeHeading();
            leaf = null;
            const title = atx.text;
            const titleStart = title ? pos + atx.textStart : text.length;
            const codeEnd = text.includes('`') ? codeSpanFinder(text) : null;
            const comment = findCommentStart(text, titleStart, codeEnd);
            emit('heading', comment < 0 ? line.end : line.start + comment, { level: atx.level, text: comment < 0 ? title : text.slice(titleStart, comment) });
            if (comment >= 0) scanTail(line, comment, codeEnd);
            continue;
        }
        if (THEMATIC_BREAK.test(rest)) {
            closeHeading();
            leaf = null;
            emit('hr', line.end);
            continue;
        }
        if (startsHtmlBlock(rest, inParagraph)) {
            // Comentário e <pre> no começo da linha acabam na própria linha; os outros
            // blocos HTML vão até a linha em branco.
            const untilBlank = !COMMENT_START.test(rest) && !RAW_BLOCK_START.test(rest);
            closeHeading();
            leaf = untilBlank ? { type: 'html', firstIndex: units.length } : null;
            run = null;
            scanContent(line, pos, true, false);
            continue;
        }
        // Parágrafo (novo ou continuação).
        if (!inParagraph) {
            run = null;
            leaf = { type: 'paragraph', firstIndex: units.length };
        }
        scanContent(line, pos, true, true);
    }
    if (leaf && leaf.type === 'comment' && leaf.hole) leaf.hole[1] = source.length;
    closeHeading();
    if (cursor < source.length) emit('space', source.length);
    closeMd(0);
    return units;
}

// ---------------------------------------------------------------- etapa 2: regras

// Rótulo em negrito no começo do texto: prefixo opcional sem letra nem número (emoji,
// seta, "- "), abertura opcional de itálico ou de <span> ("_**...**_", <em><strong>,
// <span><strong>), depois um ou mais trechos em negrito seguidos (**, __, ***, <strong>,
// <b>, também em maiúsculas). Negrito quebrado em duas linhas ("**Gabarito do" e
// "professor**" na linha seguinte) não é rótulo.
const LABEL_PREFIX = /^[^\p{L}\p{N}*_<`|[\]!\\]{0,16}/u;
const BOLD_AT = /(\*{2,3}|_{2,3})(?!\s)((?:(?!\1).)+?)\1|<(strong|b)\b[^<>]*>([\s\S]*?)<\/\3\s*>/iy;
const BOLD_OPENER_AT = /(?:<(?:em|i|span|u|mark|small|font)\b[^<>]*>|[*_](?=\*\*|__|<(?:strong|b)\b))[ \t]*/iy;
const GAP_AT = /[ \t]*/y;

// Rótulo do gabarito do professor no começo do texto? (o texto em negrito até o primeiro
// ":" tem gabarito + marca do professor)
function parseLabel(text) {
    let index = LABEL_PREFIX.exec(text)[0].length;
    // Itálico ou <span> em volta do negrito (no máximo três aberturas).
    for (let opener = 0; opener < 3; opener += 1) {
        BOLD_AT.lastIndex = index;
        if (BOLD_AT.test(text)) break;
        BOLD_OPENER_AT.lastIndex = index;
        const open = BOLD_OPENER_AT.exec(text);
        if (!open || !open[0]) break;
        index += open[0].length;
    }
    const parts = [];
    for (;;) {
        BOLD_AT.lastIndex = index;
        const bold = BOLD_AT.exec(text);
        if (!bold) break;
        parts.push(bold[2] !== undefined ? bold[2] : bold[4]);
        index = BOLD_AT.lastIndex;
        GAP_AT.lastIndex = index;
        const gap = GAP_AT.exec(text)[0].length;
        if (!gap) break;
        BOLD_AT.lastIndex = index + gap;
        if (!BOLD_AT.test(text)) break;
        index += gap;
    }
    if (!parts.length) return false;
    const plain = decodeHtmlEntities(withoutInlineCode(parts.join(' ')).replace(/<[^<>]*>/g, ' '));
    const colon = plain.indexOf(':');
    return hasTeacherAnswerKey(colon >= 0 ? plain.slice(0, colon) : plain);
}

const INERT = new Set(['space', 'blank', 'comment']);
// Elementos que, quando só têm o bloco do rótulo, saem junto com ele. Célula de tabela
// não: tabela não é suportada e fica inteira (rótulo dentro dela não é reconhecido).
const LABEL_WRAPPERS = new Set(['p', 'div', 'li', 'dd', 'dt', 'blockquote', 'md:item', 'md:quote']);
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption']);
// Item de lista que a remoção esvazia (o rótulo sozinho e a sublista ou as respostas
// dele) sai inteiro, sem deixar um marcador vazio.
const LIST_ITEMS = new Set(['li', 'md:item']);

// Trechos [início, fim) do texto sem os trechos de `ranges` (ordenados ou não).
function withoutRanges(source, ranges) {
    if (!ranges.length) return source;
    ranges.sort((a, b) => a[0] - b[0]);
    let output = '';
    let position = 0;
    ranges.forEach(([start, end]) => {
        if (start > position) output += source.slice(position, start);
        position = Math.max(position, end);
    });
    return output + source.slice(position);
}

// Comentários HTML fora de código (os de dentro de <hN> também): onde cada um começa e
// acaba. Depois do ">" de uma citação, o comentário sai sem o ">" e sem a quebra de linha.
function commentRanges(units, length) {
    const ranges = [];
    units.forEach(unit => {
        if (unit.kind === 'comment') ranges.push([unit.cutStart !== undefined ? unit.cutStart : unit.start, unit.end]);
        (unit.holes || []).forEach(([from, to]) => ranges.push([from, to === null || to === undefined ? length : to]));
    });
    return ranges;
}

// Pré-passagem: todos os comentários HTML fora de código saem ANTES de reconhecer títulos
// e rótulos ("## Gabarito <!-- x --> do professor" é o título do professor). Repete até não
// sobrar comentário (tirar um pode formar outro: "<!<!-- x -->-- y -->").
const MAX_COMMENT_PASSES = 50;
function withoutComments(source) {
    let text = source;
    let units = tokenize(text);
    for (let pass = 0; pass < MAX_COMMENT_PASSES; pass += 1) {
        const ranges = commentRanges(units, text.length);
        if (!ranges.length) break;
        text = withoutRanges(text, ranges);
        units = tokenize(text);
    }
    return { text, units };
}

// A função é idempotente: aplicada de novo no resultado, não muda nada. Cada rodada só
// tira trechos; repete enquanto a rodada anterior tirou algo (no texto comum, uma rodada
// tira e a seguinte confirma).
const MAX_STRIP_ROUNDS = 20;
function stripAnswerKeyBlocks(markdown) {
    let text = String(markdown || '');
    for (let round = 0; round < MAX_STRIP_ROUNDS && text; round += 1) {
        const next = stripRound(text);
        if (next === text) break;
        text = next;
    }
    return text;
}

function stripRound(original) {
    const { text: source, units } = withoutComments(original);
    if (!source) return source;
    const count = units.length;

    // Pares de abertura e fechamento (HTML e Markdown), num passe só:
    // - endOf[i]: índice onde acaba o contêiner aberto em i (o fechamento explícito, o
    //   bloco que o fecha sem tag ou o fim);
    // - explicitClose[i]: o fechamento explícito (</div>) do contêiner aberto em i;
    // - closedAt[j]: o menor índice de abertura fechado em j (a remoção para antes de j
    //   quando esse contêiner foi aberto antes dela);
    // - parent[j]: o contêiner mais de dentro que contém j.
    const endOf = new Array(count).fill(count);
    const explicitClose = new Array(count).fill(-1);
    const closedAt = new Array(count).fill(Infinity);
    const parent = new Array(count).fill(-1);
    const runStart = new Map();
    const runEnd = new Map();
    const stack = [];
    const top = () => (stack.length ? stack[stack.length - 1] : -1);
    const popTo = (depth, at) => {
        while (stack.length > depth) {
            const index = stack.pop();
            endOf[index] = at;
            closedAt[at] = Math.min(closedAt[at], index);
        }
    };
    for (let j = 0; j < count; j += 1) {
        const unit = units[j];
        if (unit.kind === 'text') {
            if (!runStart.has(unit.run)) runStart.set(unit.run, j);
            runEnd.set(unit.run, j);
        }
        if (unit.kind === 'open' || (unit.kind === 'heading' && unit.html)) {
            const tag = unit.kind === 'open' ? unit.tag : `h${unit.level}`;
            while (top() >= 0 && units[top()].kind === 'open' && closesImplicitly(units[top()].tag, tag)) popTo(stack.length - 1, j);
            parent[j] = top();
            if (unit.kind === 'open') stack.push(j);
        } else if (unit.kind === 'close') {
            // </div> fecha o <div> aberto mais próximo, sem passar de citação ou item Markdown.
            let depth = stack.length - 1;
            while (depth >= 0 && units[stack[depth]].kind === 'open' && units[stack[depth]].tag !== unit.tag) depth -= 1;
            if (depth >= 0 && units[stack[depth]].kind === 'open') {
                explicitClose[stack[depth]] = j;
                popTo(depth, j);
            }
            parent[j] = top();
        } else if (unit.kind === 'mdopen') {
            parent[j] = top();
            stack.push(j);
        } else if (unit.kind === 'mdclose') {
            const depth = stack.lastIndexOf(unit.openIndex);
            if (depth >= 0) popTo(depth, j);
            parent[j] = top();
        } else {
            parent[j] = top();
        }
    }

    const removed = [];
    const dropped = new Set();
    const offsetOf = index => (index < count ? units[index].start : source.length);
    // Tira as unidades [from, to); contêiner aberto ali dentro e fechado depois leva o
    // fechamento junto. Trecho que termina num título Markdown e engoliu a linha em branco
    // que fechava um bloco HTML aberto antes dele: essa linha fica (sem ela, o título
    // seguinte viraria texto do bloco HTML).
    const cut = (from, to) => {
        if (to <= from) return;
        let keep = -1;
        if (to < count && units[to].kind === 'heading' && !units[to].html) {
            for (let j = from; j < to; j += 1) {
                if (units[j].kind === 'blank' && units[j].closesHtmlFrom !== undefined && units[j].closesHtmlFrom < from) keep = j;
            }
        }
        if (keep >= 0) {
            if (keep > from) removed.push([units[from].start, units[keep].start]);
            if (keep + 1 < to) removed.push([units[keep].end, offsetOf(to)]);
        } else {
            removed.push([units[from].start, offsetOf(to)]);
        }
        for (let j = from; j < to; j += 1) {
            if (units[j].kind === 'open' && explicitClose[j] >= to) dropped.add(explicitClose[j]);
        }
    };
    // Dentro de tabela HTML (o rótulo não é reconhecido: a tabela fica inteira)?
    const insideTable = index => {
        for (let container = parent[index]; container >= 0; container = parent[container]) {
            if (units[container].kind === 'open' && TABLE_TAGS.has(units[container].tag)) return true;
        }
        return false;
    };
    // Item de lista que o trecho [from, to) esvazia (começa no primeiro conteúdo dele e vai
    // até o fechamento) sai inteiro, com o fechamento.
    const wholeListItem = (from, to) => {
        let start = from;
        let end = to;
        for (;;) {
            const container = parent[start];
            if (container < 0) break;
            const unit = units[container];
            const name = unit.kind === 'mdopen' ? `md:${unit.type}` : unit.tag;
            if (!LIST_ITEMS.has(name)) break;
            const contentEnd = explicitClose[container] >= 0 ? explicitClose[container] : endOf[container];
            if (end !== contentEnd || !inert(container + 1, start)) break;
            start = container;
            end = explicitClose[container] >= 0 ? explicitClose[container] + 1 : endOf[container];
        }
        return [start, end];
    };
    // Fim do trecho que começa em `start` e vale como título de nível `level`: o próximo
    // título de nível igual ou menor, o fechamento de um contêiner aberto antes do trecho
    // ou o fim.
    const sectionEnd = (start, from, level) => {
        for (let j = from; j < count; j += 1) {
            if (closedAt[j] < start) return j;
            if (units[j].kind === 'heading' && units[j].level <= level) return j;
        }
        return count;
    };
    const inert = (from, to) => {
        for (let j = from; j < to; j += 1) if (!INERT.has(units[j].kind)) return false;
        return true;
    };
    // Elemento, item de lista ou citação que só tem o bloco [from, to) sai junto com ele.
    const expand = (from, to) => {
        let start = from;
        let end = to;
        for (;;) {
            const container = parent[start];
            if (container < 0) break;
            const unit = units[container];
            const name = unit.kind === 'mdopen' ? `md:${unit.type}` : unit.tag;
            if (!LABEL_WRAPPERS.has(name)) break;
            const contentEnd = explicitClose[container] >= 0 ? explicitClose[container] : endOf[container];
            if (!inert(container + 1, start) || !inert(end, contentEnd)) break;
            start = container;
            end = explicitClose[container] >= 0 ? explicitClose[container] + 1 : endOf[container];
        }
        return [start, end];
    };
    // Texto do título, sem código inline e sem os comentários de dentro dele.
    const headingText = unit => {
        if (unit.text !== undefined) return withoutInlineCode(unit.text);
        const end = unit.innerEnd !== undefined ? unit.innerEnd : unit.end;
        let text = '';
        let position = unit.innerStart;
        (unit.holes || []).forEach(([from, to]) => {
            if (from > position) text += source.slice(position, Math.min(from, end));
            position = Math.max(position, to);
        });
        if (position < end) text += source.slice(position, end);
        return withoutInlineCode(text);
    };
    // <details> do professor: o resumo é o primeiro <summary> antes de algum <details> de dentro.
    const isTeacherDetails = index => {
        for (let j = index + 1; j < endOf[index]; j += 1) {
            const unit = units[j];
            if (unit.kind === 'open' && unit.tag === 'details') return false;
            if (unit.kind === 'open' && unit.tag === 'summary') {
                const close = explicitClose[j] >= 0 ? units[explicitClose[j]].tagStart : offsetOf(endOf[j]);
                return isTeacherAnswerKeySummary(source.slice(unit.tagEnd, close).replace(/<!--[\s\S]*?-->/g, ' '));
            }
        }
        return false;
    };
    // Títulos vistos, para saber a seção onde está o rótulo (o título continua valendo
    // enquanto o contêiner onde ele está não fechou).
    const headings = [];
    const sectionLevel = index => {
        while (headings.length) {
            const last = headings[headings.length - 1];
            if (last.parent < 0 || endOf[last.parent] > index) return last.level;
            headings.pop();
        }
        return 0;
    };

    let i = 0;
    while (i < count) {
        const unit = units[i];
        if (dropped.has(i) || unit.kind === 'comment') {
            removed.push([unit.start, unit.end]);
            i += 1;
            continue;
        }
        if (unit.kind === 'heading') {
            headings.push({ level: unit.level, parent: parent[i] });
            if (hasTeacherAnswerKey(headingText(unit))) {
                const end = sectionEnd(i, i + 1, unit.level);
                cut(i, end);
                i = end;
                continue;
            }
            (unit.holes || []).forEach(hole => removed.push(hole));
            i += 1;
            continue;
        }
        if (unit.kind === 'open' && unit.tag === 'details' && isTeacherDetails(i)) {
            const end = explicitClose[i] >= 0 ? explicitClose[i] + 1 : endOf[i];
            cut(i, end);
            i = end;
            continue;
        }
        // Rótulo em negrito no começo do bloco (ou de uma linha dele): sempre abre uma
        // seção, com ou sem texto depois dele no mesmo bloco, até o próximo título de nível
        // igual ou menor que o do título da seção onde está (sem título acima, até o
        // próximo # ou ##), sem atravessar o fechamento de um contêiner aberto antes.
        if (unit.kind === 'text' && (unit.atLineStart || runStart.get(unit.run) === i)
            && parseLabel(source.slice(unit.contentStart, unit.end)) && !insideTable(i)) {
            const [start, end] = expand(i, runEnd.get(unit.run) + 1);
            const [from, stop] = wholeListItem(start, sectionEnd(start, end, sectionLevel(i) || 2));
            cut(from, stop);
            i = stop;
            continue;
        }
        i += 1;
    }

    return withoutRanges(source, removed);
}

module.exports = {
    stripAnswerKeyBlocks,
    tokenize,
    hasTeacherAnswerKey,
    isTeacherAnswerKeySummary,
};
