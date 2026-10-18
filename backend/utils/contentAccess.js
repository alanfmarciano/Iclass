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

// Parágrafo só em negrito ou itálico ("**GABARITO DO PROFESSOR**", "*Gabarito
// oficial*", "<p><strong>...</strong></p>") funciona como título: nível 7, abaixo de
// qualquer título de verdade. Quando o texto em negrito começa com "gabarito" (ou
// "chave de respostas") e tem a marca do professor, é o rótulo do gabarito, com
// qualquer tamanho ou pontuação ("**GABARITO OFICIAL.**", "**GABARITO EXCLUSIVO DO
// PROFESSOR - NÃO DIVULGAR PARA OS ALUNOS**"). Os outros só contam se parecerem
// título (curtos e sem ponto final): "**Atenção: o gabarito oficial será divulgado
// pelo professor após a prova.**" é um aviso, não o começo do gabarito.
const BOLD_LINE_LEVEL = 7;
const MARKDOWN_BOLD_LINE = /^\s{0,3}(\*{1,3}|_{1,3})(?!\s)((?:(?!\1).)+)\1\s*:?\s*$/;
const HTML_BOLD_LINE = /^\s{0,3}(?:<p\b[^>]*>\s*)?<(strong|b|em|i)\b[^>]*>([\s\S]+?)<\/\1>\s*:?\s*(?:<\/p>)?\s*$/i;
const HTML_HEADING_LINE = /^\s{0,3}<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>\s*$/i;
const MAX_BOLD_TITLE_WORDS = 8;
// O rótulo começa com o nome do gabarito ("Gabarito do professor", "Chave de respostas").
const ANSWER_KEY_START = /^(gabaritos?|chaves? de (respostas?|correcao))\b/;
// Rótulo que só diz onde o gabarito está ("**Gabarito oficial disponível com o
// professor**"): sai o próprio parágrafo, mas o conteúdo seguinte é do aluno.
const ANSWER_KEY_NOTICE = /\b(disponive(l|is)|divulgad[oa]s?|publicad[oa]s?|sera|serao|estara|estarao|fica|ficam|ficara|ficarao|entregues?|solicite|solicitar|peca|pedir|consulte|consultar|procure|procurar|secretaria|mural|coordenacao)\b|\bcom (o|a) (professor|professora|docente|instrutor|instrutora|prof)\b/;
// Subtítulo em negrito dentro do gabarito ("**Parte objetiva**", "**Seção A**",
// "**Questão 2**"): não encerra o gabarito aberto por negrito. Outro negrito
// ("**Exercício extra**") encerra.
const ANSWER_KEY_SUBPART = /^(partes?|secao|secoes|bloco|questao|questoes|q ?\d+|itens?|letra|versao|versoes|resolucao|resolucoes|respostas?|comentarios?|justificativas?|criterios?|correcao|rubrica|objetivas?|discursivas?|dissertativas?|[a-e]|\d+)\b/;
// Linha de resposta ("1. B", "2) c", "Questão 3 - D", "4. E (ls -la)"). "2. A rede..."
// é texto, não resposta.
const ANSWER_LINE = /^\s*(?:[-*+]\s+)?(?:(?:quest[aã]o|q)\s*)?\d{1,3}\s*[).:\-–—]\s*(?:letra\s+)?\(?[a-e]\)?(?=\s*(?:$|[,;.:)(\-–—]))/i;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const HTML_BLOCK_START = /^\s{0,3}<\/?(p|div|section|article|aside|main|h[1-6]|ul|ol|li|table|blockquote|details|figure|hr)\b/i;
// Rótulo em negrito no começo da linha, com texto depois na mesma linha ("**GABARITO
// DO PROFESSOR:** 1-B, 2-C", "<strong>Gabarito oficial</strong><br>1. B"), também
// dentro de item de lista.
const LEADING_BOLD_LABEL = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?(?:<p\b[^>]*>\s*)?(?:(\*{1,3}|_{1,3})(?!\s)((?:(?!\1).)+?)\1|<(strong|b|em|i)\b[^>]*>([\s\S]+?)<\/\3>)/i;

function looksLikeTitle(text) {
    const plain = decodeHtmlEntities(String(text || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    const words = normalizedLabel(plain).split(' ').filter(Boolean);
    if (!words.length || words.length > MAX_BOLD_TITLE_WORDS) return false;
    // Frase terminada em ponto é aviso; "Gabarito do prof." é abreviação.
    return !/[.!?…]\s*$/.test(plain) || /\bprof\.\s*$/i.test(plain);
}

// Rótulo do gabarito do professor: começa com "gabarito" e tem a marca do professor.
function isAnswerKeyLabel(text) {
    const label = normalizedLabel(text);
    return ANSWER_KEY_START.test(label) && TEACHER_MARKER.test(label);
}

const BLOCKQUOTE_PREFIX = /^(?:\s{0,3}>\s?)+/;
function quoteDepth(line) {
    const prefix = BLOCKQUOTE_PREFIX.exec(line);
    return prefix ? (prefix[0].match(/>/g) || []).length : 0;
}

function indentOf(line) {
    return (/^\s*/.exec(line)[0] || '').replace(/\t/g, '    ').length;
}

// Título da linha (já sem o "> " de citação): nível, texto e quantas linhas ocupa.
// allowSetext: falso quando a linha continua um item de lista ("1. B\nQuestão 3: C\n---"
// não é título sublinhado; o "---" ali é só uma linha).
function lineHeading(inner, nextInner, { allowSetext = true } = {}) {
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(inner);
    if (atx) return { level: atx[1].length, text: atx[2], span: 1 };
    const html = HTML_HEADING_LINE.exec(inner);
    if (html) return { level: Number(html[1]), text: html[2], span: 1 };
    const setext = allowSetext ? setextHeadingLevel(inner, nextInner) : 0;
    if (setext) return { level: setext, text: inner, span: 2 };
    const bold = MARKDOWN_BOLD_LINE.exec(inner) || HTML_BOLD_LINE.exec(inner);
    if (bold && normalizedLabel(bold[2])) {
        if (isAnswerKeyLabel(bold[2])) {
            return { level: BOLD_LINE_LEVEL, text: bold[2], span: 1, bold: true, notice: ANSWER_KEY_NOTICE.test(normalizedLabel(bold[2])) };
        }
        if (looksLikeTitle(bold[2])) return { level: BOLD_LINE_LEVEL, text: bold[2], span: 1, bold: true };
    }
    return null;
}

// Rótulo do gabarito no começo da linha com as respostas na mesma linha.
function leadingAnswerKeyLabel(inner) {
    const match = LEADING_BOLD_LABEL.exec(inner);
    return !!match && isAnswerKeyLabel(match[2] || match[4]);
}

// Linha sem negrito que é só o rótulo ("GABARITO DO PROFESSOR", "Gabarito oficial:"),
// em maiúsculas ou terminada em dois-pontos, no começo de um parágrafo.
function plainAnswerKeyTitle(inner) {
    const text = inner.trim();
    if (!text || /^[#>*_<`|\-+]|^\d+[.)]/.test(text)) return false;
    const label = normalizedLabel(text);
    if (!isAnswerKeyLabel(text) || ANSWER_KEY_NOTICE.test(label)) return false;
    const letters = text.replace(/[^\p{L}]/gu, '');
    return /:\s*$/.test(text) || (letters.length > 0 && letters === letters.toUpperCase());
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
    const lines = source.split('\n');
    const output = [];
    let segment = [];
    const flush = () => {
        if (!segment.length) return;
        const text = segment.join('\n').replace(HTML_HEADING_ANYWHERE, (match, level, inner, offset, whole) => {
            const heading = match.replace(/\s*\n\s*/g, ' ');
            const before = offset > 0 && whole[offset - 1] !== '\n' ? '\n' : '';
            const afterIndex = offset + match.length;
            const after = afterIndex < whole.length && whole[afterIndex] !== '\n' ? '\n' : '';
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
// que abrem ou fecham o contêiner de fora continuam no texto: sem isso o <div> ficava
// aberto e o "## Próximo" seguinte aparecia como texto cru.
const CONTAINER_TAG = /<(\/?)(div|section|article|aside|main|header|footer|nav|details|figure|blockquote|table)\b[^>]*?(\/?)>/gi;

// Remove a seção do professor:
// - aberta por título (#, sublinhado, <h1>-<h6>): até o próximo título do mesmo nível
//   ou acima;
// - aberta por parágrafo em negrito: até o próximo título de verdade, outro negrito que
//   não seja subtítulo do gabarito ("**Exercício extra**" encerra, "**Parte objetiva**"
//   não) ou um "---" que não seja seguido de mais respostas;
// - rótulo com as respostas na mesma linha ("**GABARITO DO PROFESSOR:** 1-B") ou aviso
//   que começa com o rótulo: só o parágrafo.
// Dentro de citação ("> ## GABARITO DO PROFESSOR") a seção acaba também quando a
// citação termina; dentro de item de lista, quando o item termina. Títulos dentro de
// bloco de código não contam.
function stripTeacherHeadingSections(markdown) {
    const lines = isolateHtmlHeadings(markdown).split('\n');
    const output = [];
    let skip = null;
    let inFence = false;
    let previousBlank = true;
    let paragraphIsList = false;
    let htmlDepth = 0;

    const startSkip = (kind, fields) => {
        skip = { kind, ...fields, htmlDepth, minDepth: htmlDepth, opened: [] };
    };
    const endSkip = () => {
        // Contêiner aberto dentro do trecho removido e fechado depois: reabre aqui.
        if (skip && skip.opened.length) output.push(...skip.opened);
        skip = null;
    };
    // Atualiza a profundidade dos contêineres HTML; dentro do trecho removido, guarda as
    // tags que fecham contêineres de fora (voltam ao texto, seguidas de linha em branco).
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
                else if (htmlDepth < skip.minDepth) { skip.minDepth = htmlDepth; kept.push(tag); }
            }
            return tag;
        });
        return kept;
    };
    const nextNonBlank = from => {
        for (let index = from; index < lines.length; index++) {
            if (lines[index].replace(BLOCKQUOTE_PREFIX, '').trim()) return index;
        }
        return -1;
    };
    // Depois de um "---" no gabarito em negrito: continua se vier mais resposta.
    const continuesAnswerKey = index => {
        if (index < 0) return false;
        const inner = lines[index].replace(BLOCKQUOTE_PREFIX, '');
        if (ANSWER_LINE.test(inner) || leadingAnswerKeyLabel(inner)) return true;
        const heading = lineHeading(inner, undefined, { allowSetext: false });
        return !!heading && heading.bold && (ANSWER_KEY_SUBPART.test(normalizedLabel(heading.text)) || isTeacherAnswerKeyHeading(heading.text));
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const depth = quoteDepth(line);
        const inner = line.replace(BLOCKQUOTE_PREFIX, '');
        const blank = !inner.trim();
        if (!blank && previousBlank) paragraphIsList = LIST_ITEM.test(inner);
        // Saiu da citação onde o gabarito começou (linha sem ">" depois de uma em branco).
        if (skip && skip.depth > 0 && !blank && depth < skip.depth && previousBlank && !inFence) endSkip();
        // Saiu do item de lista onde o rótulo estava.
        if (skip && skip.indent > 0 && !blank && !inFence && indentOf(inner) < skip.indent) endSkip();
        if (/^\s{0,3}(```|~~~)/.test(inner)) {
            inFence = !inFence;
            if (!skip) output.push(line);
            previousBlank = false;
            continue;
        }
        if (inFence) {
            if (!skip) output.push(line);
            previousBlank = false;
            continue;
        }
        // Rótulo com as respostas na mesma linha: o parágrafo acaba na linha em branco.
        if (skip && skip.kind === 'paragraph') {
            // Mais respostas na linha seguinte ("2. C") continuam no mesmo parágrafo.
            // Bloco HTML novo (<p>, <div>...) também começa outro parágrafo.
            const startsBlock = blank || (LIST_ITEM.test(inner) && indentOf(inner) <= skip.listIndent && !ANSWER_LINE.test(inner))
                || HTML_BLOCK_START.test(inner) || !!lineHeading(inner, undefined, { allowSetext: false }) || depth !== skip.depth;
            if (startsBlock) endSkip();
        }
        let span = 1;
        const nextLine = lines[index + 1];
        const nextInner = nextLine !== undefined && quoteDepth(nextLine) === depth ? nextLine.replace(BLOCKQUOTE_PREFIX, '') : undefined;
        const heading = blank ? null : lineHeading(inner, nextInner, { allowSetext: previousBlank || !paragraphIsList });
        if (skip && skip.kind === 'section') {
            let closes = false;
            if (heading && depth <= skip.depth) {
                if (skip.level !== BOLD_LINE_LEVEL) closes = heading.level <= skip.level;
                else if (heading.level < BOLD_LINE_LEVEL) closes = true;
                else closes = !ANSWER_KEY_SUBPART.test(normalizedLabel(heading.text)) && !isTeacherAnswerKeyHeading(heading.text);
            } else if (skip.level === BOLD_LINE_LEVEL && THEMATIC_BREAK.test(inner) && depth <= skip.depth) {
                closes = !continuesAnswerKey(nextNonBlank(index + 1));
            }
            if (closes) endSkip();
        }
        if (!skip && !blank) {
            const listIndent = LIST_ITEM.test(inner) ? indentOf(inner) : -1;
            const indent = indentOf(inner) >= 2 ? indentOf(inner) : 0;
            if (heading && isTeacherAnswerKeyHeading(heading.text)) {
                if (heading.bold && heading.notice) startSkip('paragraph', { depth, listIndent: Math.max(listIndent, indentOf(inner)), indent: 0 });
                else startSkip('section', { level: heading.level, depth, indent: heading.bold ? indent : 0 });
            } else if (!heading && leadingAnswerKeyLabel(inner)) {
                startSkip('paragraph', { depth, listIndent: Math.max(listIndent, indentOf(inner)), indent: 0 });
            } else if (!heading && previousBlank && plainAnswerKeyTitle(inner)) {
                startSkip('section', { level: BOLD_LINE_LEVEL, depth, indent });
            }
        }
        if (heading) span = heading.span;
        const chunk = lines.slice(index, index + span);
        if (!skip) {
            chunk.forEach(trackContainers);
            output.push(...chunk);
        } else {
            const kept = chunk.flatMap(trackContainers);
            if (kept.length) output.push(kept.join(''), '');
        }
        previousBlank = blank;
        index += span - 1;
    }
    if (skip) skip.opened = [];
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
