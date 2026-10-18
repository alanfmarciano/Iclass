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

// Marca de material do professor junto da palavra "gabarito" (ou "respostas",
// "resolução", "solução": "## Respostas (professor)").
const TEACHER_MARKER = /\b(oficial|professor|professora|prof|docente|instrutor|instrutora|exclusivo)\b/;
const ANSWER_WORD = /\b(gabarito|respostas?|resolucao|resolucoes|solucao|solucoes)\b/;

// Título de bloco que marca o gabarito do professor, nos formatos dos arquivos de
// avaliação: "GABARITO EXCLUSIVO DO PROFESSOR", "GABARITO OFICIAL", "Gabarito do prof."
// ou só "GABARITO". Um bloco de autocorreção escrito para o aluno ("Gabarito dos
// exercícios", "Ver resposta") não casa e continua na apostila.
function isTeacherAnswerKeySummary(summaryHtml) {
    const text = normalizedLabel(summaryHtml);
    if (text === 'gabarito') return true;
    return ANSWER_WORD.test(text) && TEACHER_MARKER.test(text);
}

// Título Markdown de seção do professor ("## GABARITO EXCLUSIVO DO PROFESSOR"). Aqui
// "Gabarito" sozinho não basta: uma seção assim pode ser a autocorreção do aluno.
function isTeacherAnswerKeyHeading(headingText) {
    const text = normalizedLabel(headingText);
    return ANSWER_WORD.test(text) && TEACHER_MARKER.test(text);
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
    if (/^\s{0,3}(#{1,6}(\s|$)|[-*+]\s|\d+[.)]\s|```|~~~)/.test(line)) return 0;
    const underline = /^\s{0,3}(=+|-+)\s*$/.exec(next);
    if (!underline) return 0;
    return underline[1][0] === '=' ? 1 : 2;
}

// Remove a seção Markdown do professor até o próximo título do mesmo nível ou acima
// (títulos com # e títulos sublinhados). Títulos dentro de bloco de código não contam.
function stripTeacherHeadingSections(markdown) {
    const lines = String(markdown || '').split('\n');
    const output = [];
    let skipLevel = 0;
    let inFence = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (/^\s{0,3}(```|~~~)/.test(line)) {
            inFence = !inFence;
            if (!skipLevel) output.push(line);
            continue;
        }
        let level = 0;
        let text = '';
        let span = 1;
        const heading = !inFence && /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            level = heading[1].length;
            text = heading[2];
        } else if (!inFence) {
            level = setextHeadingLevel(line, lines[index + 1]);
            if (level) { text = line; span = 2; }
        }
        if (level) {
            if (skipLevel && level <= skipLevel) skipLevel = 0;
            if (!skipLevel && isTeacherAnswerKeyHeading(text)) skipLevel = level;
        }
        if (!skipLevel) output.push(...lines.slice(index, index + span));
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

// Remove ?access=<sessão> de links /uploads e /imagens (o editor antigo gravava a
// sessão do instrutor na apostila). contentMedia.js reexporta para o editor.
function stripStoredAccessTokens(markdown) {
    return String(markdown || '').replace(/(\/(?:uploads|imagens)\/[^\s)"'<>?#]+)\?([^\s)"'<>#]*)/g, (match, base, query) => {
        const kept = query.split(/&(?:amp;)?/).filter(part => part && !/^access=/i.test(part));
        return kept.length ? `${base}?${kept.join('&')}` : base;
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
