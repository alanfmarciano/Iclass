// Acesso a apostilas (arquivos Markdown da pasta de conteúdo).
// Regra: o caminho pedido nunca vira nome de arquivo direto. A chave é comparada,
// sem diferenciar maiúsculas/minúsculas (o NTFS do Windows e o APFS do macOS não
// diferenciam), com uma lista do que PODE ser servido, e o arquivo é aberto pelo nome
// canônico dessa lista. Avaliações (Avaliacao_*, inclusive as cópias *_JOYA e
// *_COPIA) e gabaritos nunca entram nessa lista.
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const runtimePaths = require('../runtimePaths.js');
const { effectiveStructure } = require('./classContent.js');

const SAFE_CONTENT_KEY = /^[a-zA-Z0-9_-]+$/;

function isCourseDeleted(course) {
    return !!course && (course.deleted === true || course.status === 'deleted' || course.status === 'inactive' || !!course.deletedAt);
}

// Chaves que nunca podem ser servidas como material, em qualquer grafia.
function isRestrictedContentKey(key) {
    const normalized = String(key || '').trim().toLowerCase();
    return normalized.startsWith('avaliacao_') || normalized.startsWith('gabarito_');
}

// Entidades HTML mais comuns em títulos escritos à mão (GABARITO&nbsp;OFICIAL).
const NAMED_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '-', mdash: '-' };
function decodeHtmlEntities(text) {
    return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
        if (code[0] === '#') {
            const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            try { return Number.isFinite(value) ? String.fromCodePoint(value) : ' '; } catch (error) { return ' '; }
        }
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, code.toLowerCase()) ? NAMED_ENTITIES[code.toLowerCase()] : ' ';
    });
}

function normalizedLabel(html) {
    return decodeHtmlEntities(String(html || '').replace(/<[^>]*>/g, ' '))
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

// Marcador forte do gabarito do professor: a palavra "gabarito" (ou "chave de
// respostas"/"chave de correção"), junto de uma marca de material do professor
// ("oficial", "professor", "prof.", "docente", "instrutor", "exclusivo"). "Resposta"
// ou "solução" com "professor" não basta: "## Perguntas e respostas com o professor",
// "## Solução proposta pelo instrutor" e "<summary>Resposta do professor</summary>"
// são material do aluno e ficam.
const TEACHER_MARKER = /\b(oficial|professor|professora|prof|docente|instrutor|instrutora|exclusivo|exclusiva)\b/;
const ANSWER_KEY_WORD = /\b(gabaritos?|chaves? de (respostas?|correcao))\b/;
const BARE_ANSWER_KEY = /^(gabaritos?|chaves? de (respostas?|correcao))$/;

// Título de bloco que marca o gabarito do professor, nos formatos dos arquivos de
// avaliação: "GABARITO EXCLUSIVO DO PROFESSOR", "GABARITO OFICIAL", "Gabarito do prof."
// ou só "GABARITO". Um bloco de autocorreção escrito para o aluno ("Gabarito dos
// exercícios", "Ver resposta") não casa e continua na apostila.
function isTeacherAnswerKeySummary(summaryHtml) {
    const text = normalizedLabel(summaryHtml);
    if (BARE_ANSWER_KEY.test(text)) return true;
    return ANSWER_KEY_WORD.test(text) && TEACHER_MARKER.test(text);
}

// Título de seção do professor ("## GABARITO EXCLUSIVO DO PROFESSOR", "<h2>GABARITO DO
// PROFESSOR</h2>", "**GABARITO DO PROFESSOR**"). Aqui "Gabarito" sozinho não basta:
// uma seção assim pode ser a autocorreção do aluno.
function isTeacherAnswerKeyHeading(headingText) {
    const text = normalizedLabel(headingText);
    return ANSWER_KEY_WORD.test(text) && TEACHER_MARKER.test(text);
}

// Remove <details> do professor inteiro, inclusive com <details> aninhado dentro (a
// expressão antiga parava no primeiro </details> e deixava o resto do gabarito).
function stripTeacherDetails(markdown) {
    const source = String(markdown || '');
    const tagPattern = /<(\/?)details\b[^>]*>/gi;
    const blocks = [];
    const stack = [];
    let match;
    while ((match = tagPattern.exec(source))) {
        if (!match[1]) stack.push({ start: match.index, openEnd: match.index + match[0].length });
        else if (stack.length) blocks.push({ ...stack.pop(), end: match.index + match[0].length });
    }
    // <details> sem fechamento vai até o fim do texto (mesmo efeito de antes).
    stack.forEach(open => blocks.push({ ...open, end: source.length }));
    const remove = blocks.filter(block => {
        // O <summary> do próprio bloco: o primeiro antes de algum <details> aninhado,
        // mesmo que venha depois de outro texto.
        const inner = source.slice(block.openEnd, block.end);
        const nested = inner.search(/<details\b/i);
        const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(nested >= 0 ? inner.slice(0, nested) : inner);
        return !!summary && isTeacherAnswerKeySummary(summary[1]);
    }).sort((a, b) => a.start - b.start);
    let output = '';
    let cursor = 0;
    remove.forEach(block => {
        if (block.start < cursor) return; // já dentro de um bloco removido
        output += source.slice(cursor, block.start);
        cursor = block.end;
    });
    return output + source.slice(cursor);
}

// Título setext ("GABARITO DO PROFESSOR" sublinhado com === ou ---): nível 1 ou 2.
function setextHeadingLevel(line, next) {
    if (!line || !line.trim() || next === undefined) return 0;
    if (/^\s{0,3}(#{1,6}(\s|$)|[-*+]\s|\d+[.)]\s|```|~~~|>)/.test(line)) return 0;
    const underline = /^\s{0,3}(=+|-+)\s*$/.exec(next);
    if (!underline) return 0;
    return underline[1][0] === '=' ? 1 : 2;
}

// Parágrafo só em negrito ("**GABARITO DO PROFESSOR**", "<p><strong>...</strong></p>")
// funciona como título: nível 7, abaixo de qualquer título de verdade.
const BOLD_LINE_LEVEL = 7;
const MARKDOWN_BOLD_LINE = /^\s{0,3}(\*\*|__)(?!\s)((?:(?!\1).)+)\1\s*:?\s*$/;
const HTML_BOLD_LINE = /^\s{0,3}(?:<p\b[^>]*>\s*)?<(strong|b)\b[^>]*>([\s\S]+?)<\/\1>\s*:?\s*(?:<\/p>)?\s*$/i;
const HTML_HEADING_LINE = /^\s{0,3}<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>\s*$/i;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
// Negrito que é item do próprio gabarito ("**Questão 2**", "**1.**") não encerra o bloco.
const ANSWER_ITEM_LABEL = /^(\d|q\s*\d|questao|questoes|item|letra|alternativa|resposta|exercicio)/;

const BLOCKQUOTE_PREFIX = /^(?:\s{0,3}>\s?)+/;
function quoteDepth(line) {
    const prefix = BLOCKQUOTE_PREFIX.exec(line);
    return prefix ? (prefix[0].match(/>/g) || []).length : 0;
}

// Título da linha (já sem o "> " de citação): nível, texto e quantas linhas ocupa.
function lineHeading(inner, nextInner) {
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(inner);
    if (atx) return { level: atx[1].length, text: atx[2], span: 1 };
    const html = HTML_HEADING_LINE.exec(inner);
    if (html) return { level: Number(html[1]), text: html[2], span: 1 };
    const setext = setextHeadingLevel(inner, nextInner);
    if (setext) return { level: setext, text: inner, span: 2 };
    const bold = MARKDOWN_BOLD_LINE.exec(inner) || HTML_BOLD_LINE.exec(inner);
    if (bold && normalizedLabel(bold[2])) return { level: BOLD_LINE_LEVEL, text: bold[2], span: 1, bold: true };
    return null;
}

// Remove a seção do professor até o próximo título do mesmo nível ou acima (títulos
// com #, sublinhados, <h1>-<h6> e parágrafos só em negrito). Dentro de citação
// ("> ## GABARITO DO PROFESSOR") a seção acaba também quando a citação termina.
// Títulos dentro de bloco de código não contam.
function stripTeacherHeadingSections(markdown) {
    const lines = String(markdown || '').split('\n');
    const output = [];
    let skip = null;
    let inFence = false;
    let previousBlank = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const depth = quoteDepth(line);
        const inner = line.replace(BLOCKQUOTE_PREFIX, '');
        const blank = !inner.trim();
        // Saiu da citação onde o gabarito começou (linha sem ">" depois de uma em branco).
        if (skip && skip.depth > 0 && !blank && depth < skip.depth && previousBlank && !inFence) skip = null;
        if (/^\s{0,3}(```|~~~)/.test(inner)) {
            inFence = !inFence;
            if (!skip) output.push(line);
            previousBlank = false;
            continue;
        }
        let span = 1;
        if (!inFence) {
            const nextLine = lines[index + 1];
            const nextInner = nextLine !== undefined && quoteDepth(nextLine) === depth ? nextLine.replace(BLOCKQUOTE_PREFIX, '') : undefined;
            const heading = lineHeading(inner, nextInner);
            if (heading) {
                span = heading.span;
                if (skip && heading.level <= skip.level && depth <= skip.depth
                    && !(heading.bold && skip.level === BOLD_LINE_LEVEL && ANSWER_ITEM_LABEL.test(normalizedLabel(heading.text)))) {
                    skip = null;
                }
                if (!skip && isTeacherAnswerKeyHeading(heading.text)) skip = { level: heading.level, depth };
            } else if (skip && skip.level === BOLD_LINE_LEVEL && depth <= skip.depth && THEMATIC_BREAK.test(inner)) {
                skip = null;
            }
        }
        if (!skip) output.push(...lines.slice(index, index + span));
        previousBlank = blank;
        index += span - 1;
    }
    return output.join('\n');
}

// Remove blocos de gabarito do professor (<details><summary>GABARITO ...</summary>...) e
// seções "## GABARITO ... DO PROFESSOR" que por engano tenham ido parar numa apostila.
// Defesa extra: o material do aluno nunca carrega o gabarito do professor.
function stripAnswerKeyBlocks(markdown) {
    return stripTeacherHeadingSections(stripTeacherDetails(markdown));
}

function classStructure(cls) {
    return effectiveStructure(cls?.courseId, cls?.name)?.structure || db.memory.courseStructure || [];
}

function structureApostilaKeys(structure) {
    const keys = [];
    (Array.isArray(structure) ? structure : []).forEach(mod => {
        (mod?.units || mod?.items || []).forEach(unit => {
            const key = String(unit?.apostilaKey || '').trim();
            if (key && SAFE_CONTENT_KEY.test(key) && !isRestrictedContentKey(key)) keys.push(key);
        });
    });
    return keys;
}

// Apostilas liberadas para o aluno numa turma (estrutura efetiva + liberação da turma).
// getReleasedItems é injetado para evitar dependência circular com middlewares.js.
function releasedApostilaKeysForClass(cls, studentEmail, getReleasedItems) {
    if (!cls) return [];
    const course = (db.memory.courses || []).find(item => String(item.id) === String(cls.courseId));
    if (cls.courseId && (!course || isCourseDeleted(course))) return [];
    const released = getReleasedItems(cls, studentEmail) || {};
    return structureApostilaKeys(classStructure(cls)).filter(key => released[key] === true);
}

// Nome canônico do arquivo .md na pasta de conteúdo (comparação sem diferenciar
// maiúsculas). Devolve null se o arquivo não existir.
async function findContentFile(key) {
    if (!SAFE_CONTENT_KEY.test(String(key || ''))) return null;
    let files;
    try {
        files = await fs.promises.readdir(runtimePaths.CONTENT_DIR);
    } catch (error) {
        return null;
    }
    const wanted = `${key}.md`;
    const exact = files.find(file => file === wanted);
    const match = exact || files.find(file => file.toLowerCase() === wanted.toLowerCase());
    return match ? path.join(runtimePaths.CONTENT_DIR, match) : null;
}

// Host do próprio servidor: o app roda na máquina do professor e é aberto pela rede
// da sala (localhost, IP da rede local, nome da máquina sem domínio ou .local), além
// dos hosts informados (o Host da requisição). Site externo (drive.example.com) não é.
const LOCAL_NETWORK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|::1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[a-z0-9-]+|[a-z0-9.-]+\.local)$/i;

function hostWithoutPort(value) {
    const host = String(value || '').trim().toLowerCase();
    if (host.startsWith('[')) return host.slice(1, host.indexOf(']') > 0 ? host.indexOf(']') : undefined);
    return host.replace(/:\d+$/, '');
}

function isOwnHost(host, ownHosts) {
    const bare = hostWithoutPort(host);
    if (!bare) return false;
    return LOCAL_NETWORK_HOST.test(bare) || (ownHosts || []).some(item => hostWithoutPort(item) === bare);
}

// Remove ?access=<sessão> de links /uploads e /imagens do PRÓPRIO site (o editor
// antigo gravava a sessão do instrutor na apostila): caminho que começa em /uploads/
// ou /imagens/, ou com a origem do próprio servidor. Link externo que por acaso tem
// /uploads/ no caminho (https://drive.example.com/uploads/doc.pdf?access=X) fica
// intacto. contentMedia.js reexporta para o editor.
const STORED_FILE_LINK = /(^|[\s("'<>=\[,])((?:https?:)?\/\/([^\s/)"'<>?#]+))?(\/(?:uploads|imagens)\/[^\s)"'<>?#]+)\?([^\s)"'<>#]*)/gi;

function stripStoredAccessTokens(markdown, { ownHosts = [] } = {}) {
    return String(markdown || '').replace(STORED_FILE_LINK, (match, lead, origin, host, filePath, query) => {
        if (origin && !isOwnHost(host, ownHosts)) return match;
        const kept = query.split(/&(?:amp;)?/).filter(part => part && !/^access=/i.test(part));
        return `${lead}${origin || ''}${filePath}${kept.length ? `?${kept.join('&')}` : ''}`;
    });
}

async function readApostila(key) {
    const filePath = await findContentFile(key);
    if (!filePath) return null;
    try {
        return stripStoredAccessTokens(stripAnswerKeyBlocks(await fs.promises.readFile(filePath, 'utf8')));
    } catch (error) {
        return null;
    }
}

module.exports = {
    SAFE_CONTENT_KEY,
    classStructure,
    findContentFile,
    isCourseDeleted,
    isRestrictedContentKey,
    readApostila,
    releasedApostilaKeysForClass,
    stripAnswerKeyBlocks,
    stripStoredAccessTokens,
    structureApostilaKeys,
};
