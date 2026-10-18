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

// Gabarito do professor que por engano foi parar numa apostila: regras fixas, sem
// adivinhar pelo conteúdo. Para o professor: o gabarito dele fica sob um título ou
// bloco "Gabarito do professor".
// - Palavra do gabarito: "gabarito" (ou "chave de respostas"/"chave de correção").
// - Marca do professor: professor(a), prof., instrutor(a), docente, exclusivo(a).
//   "Oficial" sozinho não é marca, exceto no <summary> de <details> ("gabarito oficial").
// Sai:
// 1. <details> cujo <summary> tem gabarito + marca (ou "gabarito oficial"): o bloco
//    inteiro, com os <details> aninhados;
// 2. título Markdown (#, sublinhado) ou HTML (<h1>-<h6>), também dentro de citação, com
//    gabarito + marca: até o próximo título de nível igual ou maior;
// 3. parágrafo que é só um rótulo em negrito com gabarito + marca ("**Gabarito do
//    professor**", "<p><strong>GABARITO DO PROFESSOR</strong></p>"): vale como título,
//    abaixo de todos os outros (vai até o próximo título). O rótulo é o texto em negrito
//    até o primeiro ":" ("**Atenção: o gabarito ... professor.**" tem o rótulo "Atenção");
// 4. parágrafo que começa com esse rótulo e traz texto na mesma linha ("**Gabarito do
//    professor:** 1-B, 2-C"): só esse parágrafo (até a linha em branco).
// Nada mais sai: glossário, avisos, "Gabarito dos exercícios", "Ver resposta", tabela,
// rótulo em itálico ou sem negrito ficam. O trecho removido também acaba onde acaba o
// bloco que contém o título (citação, item de lista, <div>/<section>...) e nenhuma tag de
// contêiner fica aberta. Títulos e rótulos dentro de bloco de código não contam.
const ANSWER_KEY_WORD = /\b(gabaritos?|chaves? de (respostas?|correcao))\b/;
const TEACHER_MARKER = /\b(professor|professora|professores|professoras|prof|docente|docentes|instrutor|instrutora|instrutores|instrutoras|exclusivo|exclusiva|exclusivos|exclusivas)\b/;
const OFFICIAL_ANSWER_KEY = /\b(gabaritos?|chaves? de (respostas?|correcao)) oficia(l|is)\b/;

function hasTeacherAnswerKey(text) {
    const label = normalizedLabel(text);
    return ANSWER_KEY_WORD.test(label) && TEACHER_MARKER.test(label);
}

// Regra 1: <summary> do bloco do professor ("GABARITO EXCLUSIVO DO PROFESSOR",
// "Gabarito do prof.", "GABARITO&nbsp;OFICIAL"). "Gabarito dos exercícios" e "Ver
// resposta" são autocorreção do aluno e ficam.
function isTeacherAnswerKeySummary(summaryHtml) {
    return hasTeacherAnswerKey(summaryHtml) || OFFICIAL_ANSWER_KEY.test(normalizedLabel(summaryHtml));
}

// Regra 2: título com gabarito + marca ("## GABARITO EXCLUSIVO DO PROFESSOR", "<h2>GABARITO
// DO PROFESSOR</h2>"). "## Gabarito dos exercícios" e "## Perguntas e respostas com o
// professor" ficam.
function isTeacherAnswerKeyHeading(headingText) {
    return hasTeacherAnswerKey(headingText);
}

// Regras 3 e 4: rótulo em negrito do gabarito do professor. O rótulo é o texto em negrito
// até o primeiro ":" e tem gabarito + marca ("Gabarito do professor", "GABARITO
// EXCLUSIVO DO PROFESSOR", "Gabarito do prof."). Em "**Atenção: o gabarito oficial será
// divulgado pelo professor.**" o rótulo é "Atenção": é aviso e fica.
function isAnswerKeyLabel(text) {
    return hasTeacherAnswerKey(String(text || '').split(':')[0]);
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
    if (THEMATIC_BREAK.test(line)) return 0;
    const underline = /^\s{0,3}(=+|-+)\s*$/.exec(next);
    if (!underline) return 0;
    return underline[1][0] === '=' ? 1 : 2;
}

// Rótulo em negrito vale como título abaixo de qualquer <h6>.
const LABEL_LEVEL = 7;
const HTML_HEADING_LINE = /^\s{0,3}<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>\s*$/i;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const HTML_BLOCK_START = /^\s{0,3}<\/?(p|div|section|article|aside|main|h[1-6]|ul|ol|li|table|blockquote|details|figure|hr)\b/i;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// Negrito no começo da linha ("**...**", "__...__", "***...***", <strong>, <b>), com
// marcador de lista e <p> opcionais. Itálico (*...*, <em>) não é negrito.
const LEADING_BOLD = /^(\s*)((?:[-*+]|\d{1,9}[.)])\s+)?(?:<p\b[^>]*>\s*)?(?:(\*{2,3}|_{2,3})(?!\s)((?:(?!\3).)+?)\3|<(strong|b)\b[^>]*>([\s\S]*?)<\/\5\s*>)/i;

const BLOCKQUOTE_PREFIX = /^(?:\s{0,3}>\s?)+/;
function quoteDepth(line) {
    const prefix = BLOCKQUOTE_PREFIX.exec(line);
    return prefix ? (prefix[0].match(/>/g) || []).length : 0;
}

function indentOf(line) {
    return (/^\s*/.exec(line)[0] || '').replace(/\t/g, '    ').length;
}

// Linha que começa com o rótulo do gabarito do professor em negrito. onlyLabel: a linha
// é só o rótulo (regra 3); senão traz texto depois dele (regra 4). Com 4 espaços ou mais
// fora de lista a linha é bloco de código e não conta.
function answerKeyLabelLine(inner, inList) {
    const match = LEADING_BOLD.exec(inner);
    if (!match) return null;
    const indent = indentOf(match[1]);
    if (indent >= 4 && !inList) return null;
    const bold = match[4] !== undefined ? match[4] : match[6];
    const plain = decodeHtmlEntities(String(bold || '').replace(/<[^>]*>/g, ' '));
    if (!isAnswerKeyLabel(plain)) return null;
    const colon = plain.indexOf(':');
    const insideRest = colon >= 0 ? plain.slice(colon + 1) : '';
    const after = inner.slice(match[0].length).replace(/<\/p>\s*$/i, '');
    const onlyLabel = !normalizedLabel(insideRest) && !normalizedLabel(after);
    return { onlyLabel, indent, listItem: !!match[2] };
}

// Título da linha (já sem o "> " de citação): nível, texto e quantas linhas ocupa.
// O rótulo em negrito sozinho na linha (regra 3) entra como título de nível 7.
// allowSetext: falso quando a linha continua um item de lista ("1. B\nQuestão 3: C\n---"
// não é título sublinhado).
function lineHeading(inner, nextInner, { allowSetext = true, inList = false } = {}) {
    const atx = /^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/.exec(inner);
    if (atx) return { level: atx[1].length, text: atx[2] || '', span: 1 };
    const html = HTML_HEADING_LINE.exec(inner);
    if (html) return { level: Number(html[1]), text: html[2], span: 1 };
    const setext = allowSetext ? setextHeadingLevel(inner, nextInner) : 0;
    if (setext) return { level: setext, text: inner, span: 2 };
    const label = answerKeyLabelLine(inner, inList);
    if (label && label.onlyLabel) return { level: LABEL_LEVEL, text: inner, span: 1, label };
    return null;
}

// Título HTML do gabarito no meio de uma linha ("<div><h2>GABARITO DO PROFESSOR</h2>
// <p>1. B</p></div>") ou quebrado em várias linhas ("<h2>\nGABARITO\n</h2>"): quando
// o texto tem um, cada <h1>-<h6> passa a ocupar uma linha inteira, para a seção ser
// reconhecida e terminar no título seguinte. Blocos de código não mudam.
const HTML_HEADING_ANYWHERE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
const FENCE_LINE = /^(?:\s{0,3}>\s?)*\s{0,3}(```|~~~)/;

function isolateHtmlHeadings(markdown) {
    const source = String(markdown || '');
    const hasTeacherHtmlHeading = [...source.matchAll(HTML_HEADING_ANYWHERE)].some(match => isTeacherAnswerKeyHeading(match[2]));
    if (!hasTeacherHtmlHeading) return source;
    const eol = /\r\n/.test(source) ? '\r\n' : '\n';
    const lines = source.split('\n');
    const output = [];
    let segment = [];
    const flush = () => {
        if (!segment.length) return;
        const text = segment.join('\n').replace(HTML_HEADING_ANYWHERE, (match, level, inner, offset, whole) => {
            const heading = match.replace(/\s*\n\s*/g, ' ');
            const before = offset > 0 && whole[offset - 1] !== '\n' ? eol : '';
            const afterIndex = offset + match.length;
            const after = afterIndex < whole.length && !/^\r?\n/.test(whole.slice(afterIndex, afterIndex + 2)) ? eol : '';
            return `${before}${heading}${after}`;
        });
        output.push(text);
        segment = [];
    };
    let inFence = false;
    lines.forEach(line => {
        if (FENCE_LINE.test(line)) {
            if (!inFence) flush();
            inFence = !inFence;
            output.push(line);
            return;
        }
        if (inFence) output.push(line);
        else segment.push(line);
    });
    flush();
    return output.join('\n');
}

// Contêineres HTML de bloco. O gabarito dentro de um <div>/<section> sai, mas as tags
// que fecham o contêiner de fora continuam no texto, e o trecho removido acaba ali;
// contêiner aberto dentro do trecho removido e fechado depois dele é reaberto.
const CONTAINER_TAG = /<(\/?)(div|section|article|aside|main|header|footer|nav|details|figure|blockquote|table|ul|ol|dl)\b[^>]*?(\/?)>/gi;

// Regras 2, 3 e 4 (a regra 1 é stripTeacherDetails).
function stripTeacherHeadingSections(markdown) {
    const lines = isolateHtmlHeadings(markdown).split('\n');
    const output = [];
    let skip = null;
    let fence = null;
    let previousBlank = true;
    let paragraphIsList = false;
    let inList = false;
    let htmlDepth = 0;

    const startSkip = (kind, fields) => {
        skip = { kind, ...fields, minDepth: htmlDepth, opened: [], containerClosed: false };
    };
    const endSkip = () => {
        // Contêiner aberto dentro do trecho removido e fechado depois: reabre aqui.
        if (skip && skip.opened.length) output.push(...skip.opened);
        skip = null;
    };
    // Atualiza a profundidade dos contêineres HTML; dentro do trecho removido, devolve as
    // tags que fecham contêineres de fora (voltam ao texto) e marca o fim do bloco.
    const trackContainers = line => {
        const kept = [];
        line.replace(CONTAINER_TAG, (tag, closing, name, selfClosing) => {
            if (selfClosing) return tag;
            if (!closing) {
                htmlDepth += 1;
                if (skip) skip.opened.push(tag);
                return tag;
            }
            htmlDepth = Math.max(0, htmlDepth - 1);
            if (skip) {
                if (skip.opened.length) skip.opened.pop();
                else if (htmlDepth < skip.minDepth) { skip.minDepth = htmlDepth; skip.containerClosed = true; kept.push(tag); }
            }
            return tag;
        });
        return kept;
    };
    const startsBlock = (inner, heading) => !!heading || LIST_ITEM.test(inner) || FENCE.test(inner)
        || HTML_BLOCK_START.test(inner) || THEMATIC_BREAK.test(inner);

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const depth = quoteDepth(line);
        const inner = line.replace(BLOCKQUOTE_PREFIX, '');
        const blank = !inner.trim();
        const indent = indentOf(inner);

        // Bloco de código dentro de citação acaba junto com a citação.
        if (fence && depth < fence.depth) fence = null;
        if (fence) {
            // Dentro de bloco de código: nada é título nem rótulo.
            if (new RegExp(`^\\s{0,3}${fence.marker[0] === '`' ? '`' : '~'}{${fence.marker.length},}\\s*$`).test(inner)) fence = null;
            if (!skip) output.push(line);
            previousBlank = false;
            continue;
        }

        if (!blank && previousBlank) paragraphIsList = LIST_ITEM.test(inner);
        const nextLine = lines[index + 1];
        const nextInner = nextLine !== undefined && quoteDepth(nextLine) === depth ? nextLine.replace(BLOCKQUOTE_PREFIX, '') : undefined;
        // Sublinhado logo depois do parágrafo do rótulo (regra 4) faz parte dele, não é título novo.
        const allowSetext = (previousBlank || !paragraphIsList) && !(skip && skip.kind === 'paragraph');
        const heading = blank || FENCE.test(inner) ? null : lineHeading(inner, nextInner, { allowSetext, inList });

        if (skip && !blank) {
            // Fim do bloco onde o título estava: a citação acabou (linha sem ">" que não
            // continua o parágrafo) ou o item de lista acabou.
            if (depth < skip.depth && (previousBlank || startsBlock(inner, heading))) endSkip();
            else if (skip.list) {
                const itemEnded = skip.list.sibling ? indent <= skip.list.indent : indent < skip.list.indent;
                if (itemEnded && (previousBlank || startsBlock(inner, heading))) endSkip();
            }
        }
        if (skip && skip.kind === 'paragraph' && (blank || heading || depth > skip.depth)) endSkip();
        if (skip && skip.kind === 'section' && heading && depth <= skip.depth && heading.level <= skip.level) endSkip();

        if (!skip && !blank && !FENCE.test(inner)) {
            const label = heading ? heading.label : answerKeyLabelLine(inner, inList);
            const list = label && (label.listItem || (label.indent > 0 && inList))
                ? { indent: label.indent, sibling: label.listItem }
                : null;
            if (heading && (heading.label || isTeacherAnswerKeyHeading(heading.text))) {
                startSkip('section', { level: heading.level, depth, list });
            } else if (!heading && label) {
                startSkip('paragraph', { depth, list });
            }
        }

        const fenceOpen = FENCE.exec(inner);
        if (fenceOpen) fence = { marker: fenceOpen[1], depth };
        const span = heading ? heading.span : 1;
        const chunk = lines.slice(index, index + span);
        if (!skip) {
            if (!fenceOpen) chunk.forEach(trackContainers);
            output.push(...chunk);
        } else {
            const kept = fenceOpen ? [] : chunk.flatMap(trackContainers);
            if (skip.containerClosed) {
                // O contêiner onde o título estava fechou nesta linha: a remoção acaba aqui.
                skip.opened = [];
                skip = null;
            }
            if (kept.length) {
                output.push(kept.join('') + (/\r$/.test(chunk[chunk.length - 1]) ? '\r' : ''));
                const following = lines[index + span];
                if (skip || (following !== undefined && following.replace(BLOCKQUOTE_PREFIX, '').trim())) output.push(/\r$/.test(line) ? '\r' : '');
            }
        }

        if (!blank) {
            if (indent <= 3 && LIST_ITEM.test(inner)) inList = true;
            else if (indent === 0 && (previousBlank || heading)) inList = false;
        }
        previousBlank = blank;
        index += span - 1;
    }
    return output.join('\n');
}

// Remove o gabarito do professor (regras acima) que por engano tenha ido parar numa
// apostila. Defesa extra: o material do aluno nunca carrega o gabarito do professor.
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
// ou /imagens/, caminho relativo (uploads/, ./uploads/, ../uploads/) ou com a origem
// do próprio servidor (rede da sala, nome da máquina ou o Host da requisição). Link
// externo que por acaso tem /uploads/ no caminho
// (https://drive.example.com/uploads/doc.pdf?access=X) fica intacto, a não ser que o
// access= seja uma sessão de instrutor ainda válida: essa nunca sai para o aluno,
// qualquer que seja o endereço gravado. contentMedia.js reexporta para o editor.
const STORED_FILE_LINK = /(^|[\s("'<>=\[,])(?:((?:https?:)?\/\/([^\s/)"'<>?#]+))(\/(?:uploads|imagens)\/[^\s)"'<>?#]+)|((?:\.{1,2}\/)*\/?(?:uploads|imagens)\/[^\s)"'<>?#]+))\?([^\s)"'<>#]*)/gi;

function liveInstructorSessionTokens() {
    return new Set(Object.keys((db.memory && db.memory.adminSessions) || {}).filter(Boolean));
}

function decodedParamValue(part) {
    const value = part.slice(part.indexOf('=') + 1);
    try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch (error) { return value; }
}

// "/uploads/..." dentro da query de outro endereço
// (https://drive.example.com/view?u=/uploads/doc.pdf?access=X) é parte do link externo.
function insideOtherUrl(text, offset) {
    let start = offset;
    while (start > 0 && !/[\s"'<>()[\]]/.test(text[start - 1])) start -= 1;
    return /\?|&|:\/\//.test(text.slice(start, offset));
}

function stripStoredAccessTokens(markdown, { ownHosts = [], sessionTokens = liveInstructorSessionTokens() } = {}) {
    return String(markdown || '').replace(STORED_FILE_LINK, (match, lead, origin, host, absolutePath, relativePath, query, offset, whole) => {
        const filePath = absolutePath || relativePath;
        const parts = query.split(/&(?:amp;)?/);
        const isAccess = part => /^access=/i.test(part);
        const external = origin ? !isOwnHost(host, ownHosts) : insideOtherUrl(whole, offset + lead.length);
        const drop = external
            ? part => isAccess(part) && sessionTokens.has(decodedParamValue(part))
            : isAccess;
        if (!parts.some(part => part && drop(part))) return match;
        const kept = parts.filter(part => part && !drop(part));
        return `${lead}${origin || ''}${filePath}${kept.length ? `?${kept.join('&')}` : ''}`;
    });
}

// ownHosts: o Host da requisição do aluno, para links gravados com o nome do próprio
// servidor (https://iclass.escola.com.br/uploads/x.png?access=...).
async function readApostila(key, { ownHosts = [] } = {}) {
    const filePath = await findContentFile(key);
    if (!filePath) return null;
    try {
        return stripStoredAccessTokens(stripAnswerKeyBlocks(await fs.promises.readFile(filePath, 'utf8')), { ownHosts });
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
