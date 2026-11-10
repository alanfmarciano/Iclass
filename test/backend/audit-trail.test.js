// Trilha de auditoria (H7a-1; SEG-07, FUN-04).
// 1) Só acréscimo, conferido no código: nenhum arquivo do backend altera ou remove
//    entradas de auditLogs fora das funções permitidas, e entrada nova só nasce pelo
//    recordAudit (utils/audit.js), salvo as entradas de prova no formato próprio.
// 2) Os registradores que já existiam viraram atalhos do recordAudit: gravam a entrada
//    canônica e continuam gravando os campos antigos que as telas e a lixeira leem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-audit-trail-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

// audit.js antes do servidor: server.js registra o process.on('uncaughtException'), que
// engoliria a falha deste require e o arquivo passaria sem rodar nenhum teste.
const { normalizeAuditEntry } = require('../../backend/utils/audit.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { recordGradeAudit } = require('../../backend/utils/gradebook.js');
const { recordStudentAudit } = require('../../backend/utils/students.js');

const REPO = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(REPO, 'backend');

// ------------------------------------------------------------ varredura do código
// Deixa só o código: comentários, texto entre aspas, texto de template (o ${...} de
// dentro continua código, com template aninhado) e expressão regular viram espaços,
// mantendo as posições e as quebras de linha. O texto 'auditLogs' sozinho entre aspas
// fica (lista de coleções percorrida por nome).
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await']);
function blankNonCode(source) {
    const out = source.split('');
    const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
    const stack = [];
    let prev = '';
    let prevWord = '';
    let i = 0;
    while (i < source.length) {
        const top = stack[stack.length - 1];
        const ch = source[i];
        if (top && top.kind === 'template') {
            if (ch === '\\') { blank(i, i + 2); i += 2; continue; }
            if (ch === '`') { stack.pop(); i += 1; prev = '`'; prevWord = ''; continue; }
            if (ch === '$' && source[i + 1] === '{') { stack.push({ kind: 'expr', depth: 0 }); i += 2; prev = '{'; prevWord = ''; continue; }
            blank(i, i + 1);
            i += 1;
            continue;
        }
        if (ch === '/' && source[i + 1] === '/') {
            const end = source.indexOf('\n', i);
            const stop = end < 0 ? source.length : end;
            blank(i, stop);
            i = stop;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
            const end = source.indexOf('*/', i + 2);
            const stop = end < 0 ? source.length : end + 2;
            blank(i, stop);
            i = stop;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            let j = i + 1;
            while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
            if (source.slice(i + 1, j) !== 'auditLogs') blank(i + 1, Math.min(j, source.length));
            i = j + 1;
            prev = ch;
            prevWord = '';
            continue;
        }
        if (ch === '`') { stack.push({ kind: 'template' }); i += 1; continue; }
        if (ch === '/' && (prev === '' || REGEX_BEFORE.test(prev) || REGEX_WORDS.has(prevWord))) {
            let j = i + 1;
            let inClass = false;
            while (j < source.length && source[j] !== '\n') {
                const c = source[j];
                if (c === '\\') { j += 2; continue; }
                if (c === '[') inClass = true;
                else if (c === ']') inClass = false;
                else if (c === '/' && !inClass) break;
                j += 1;
            }
            blank(i + 1, Math.min(j, source.length));
            j += 1;
            while (j < source.length && /[a-z]/i.test(source[j])) j += 1;
            i = j;
            prev = '/';
            prevWord = '';
            continue;
        }
        if (top && top.kind === 'expr') {
            if (ch === '{') top.depth += 1;
            else if (ch === '}') {
                if (top.depth === 0) { stack.pop(); i += 1; prev = '}'; prevWord = ''; continue; }
                top.depth -= 1;
            }
        }
        if (/[\w$]/.test(ch)) {
            let j = i;
            while (j < source.length && /[\w$]/.test(source[j])) j += 1;
            prevWord = source.slice(i, j);
            prev = source[j - 1];
            i = j;
            continue;
        }
        if (!/\s/.test(ch)) { prev = ch; prevWord = ''; }
        i += 1;
    }
    return out.join('');
}

function lineOf(code, index) {
    return code.slice(0, index).split('\n').length;
}

// Argumento de uma chamada a partir do "(" (texto entre aspas não conta nos parênteses).
function callArgument(code, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < code.length; i += 1) {
        const ch = code[i];
        if (ch === '\'' || ch === '"' || ch === '`') {
            let j = i + 1;
            while (j < code.length && code[j] !== ch) j += code[j] === '\\' ? 2 : 1;
            i = j;
            continue;
        }
        if (ch === '(') depth += 1;
        else if (ch === ')') {
            depth -= 1;
            if (depth === 0) return code.slice(openIndex + 1, i);
        }
    }
    return code.slice(openIndex + 1);
}

// Fim do bloco onde está a posição: a primeira linha seguinte com recuo menor.
function blockEnd(code, index) {
    const lineStart = code.lastIndexOf('\n', index) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))[0].length;
    let cursor = code.indexOf('\n', index);
    while (cursor >= 0 && cursor < code.length) {
        const next = code.indexOf('\n', cursor + 1);
        const line = code.slice(cursor + 1, next < 0 ? code.length : next);
        if (line.trim() && /^[ \t]*/.exec(line)[0].length < indent) return cursor + 1;
        if (next < 0) break;
        cursor = next;
    }
    return code.length;
}

// Trecho de uma função pelo nome: da declaração até a "}" no mesmo recuo.
function functionRange(code, name) {
    const declaration = new RegExp(`^([ \\t]*)(?:async\\s+)?function\\s+${name}\\s*\\(|^([ \\t]*)(?:const|let|var)\\s+${name}\\s*=`, 'm').exec(code);
    if (!declaration) return null;
    const indent = declaration[1] !== undefined ? declaration[1] : declaration[2];
    const close = new RegExp(`^${indent}\\}`, 'gm');
    close.lastIndex = declaration.index + declaration[0].length;
    const found = close.exec(code);
    return { start: declaration.index, end: found ? found.index + found[0].length : code.length };
}

const ASSIGN = '(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])';
// Depois da expressão: atribuição (=, +=, ??=...) ou ++/--.
const ASSIGN_AFTER = new RegExp(`^\\s*(?:${ASSIGN}|\\+\\+|--)`);
// Métodos que mudam a própria lista.
const MUTATORS = new Set(['splice', 'pop', 'shift', 'unshift', 'sort', 'reverse', 'fill', 'copyWithin']);
// Métodos que passam entradas a um callback, com a posição dos parâmetros que são entradas.
const CALLBACK_PARAMS = {
    forEach: [0], map: [0], flatMap: [0], some: [0], every: [0], find: [0], findLast: [0],
    findIndex: [0], findLastIndex: [0], filter: [0], reduce: [1], reduceRight: [1], sort: [0, 1], toSorted: [0, 1],
};
// Lista nova com as mesmas entradas (mexer nela não muda a trilha; mexer numa entrada dela, sim).
const RETURNS_ENTRIES = new Set(['filter', 'slice', 'concat', 'toSorted', 'toReversed', 'toSpliced', 'values', 'flat']);
// Uma entrada da trilha.
const RETURNS_ENTRY = new Set(['find', 'findLast', 'at']);
// "Cria a lista se faltar" não altera nada que já existe.
const ENSURE_IDIOMS = [
    /if\s*\(\s*!\s*Array\.isArray\(\s*([\w$.]+?)\.auditLogs\s*\)\s*\)\s*\1\.auditLogs\s*=\s*\[\s*\]\s*;?/g,
    /(?<![\w$.])([\w$.]+?)\.auditLogs\s*(?:\?\?|\|\|)=\s*\[\s*\]\s*;?/g,
    /(?<![\w$.])([\w$.]+?)\.auditLogs\s*=\s*\1\.auditLogs\s*(?:\?\?|\|\|)\s*\[\s*\]\s*;?/g,
];

// Fecho do colchete aberto em openIndex (o texto entre aspas já está em branco).
function matchingBracket(code, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < code.length; i += 1) {
        if (code[i] === '[') depth += 1;
        else if (code[i] === ']') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return code.length - 1;
}

// Partes de uma lista separada por vírgula no primeiro nível: [{ from, to }].
function topLevelParts(code, from, to) {
    const parts = [];
    let depth = 0;
    let start = from;
    for (let i = from; i < to; i += 1) {
        const ch = code[i];
        if ('([{'.includes(ch)) depth += 1;
        else if (')]}'.includes(ch)) depth -= 1;
        else if (ch === ',' && depth === 0) { parts.push({ from: start, to: i }); start = i + 1; }
    }
    if (code.slice(start, to).trim()) parts.push({ from: start, to });
    return parts;
}

// Nomes dos parâmetros de um callback (x => ..., (a, b) => ..., function (x) {...});
// parâmetro desestruturado fica null (não dá nome à entrada).
function callbackParams(code, from, to) {
    const text = code.slice(from, to);
    const arrow = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(text);
    if (arrow) return [arrow[1]];
    const head = /^\s*(?:async\s+)?(?:function\s*[\w$]*\s*)?\(/.exec(text);
    if (!head) return [];
    const open = from + head[0].length - 1;
    const inner = callArgument(code, open);
    return topLevelParts(code, open + 1, open + 1 + inner.length).map(part => {
        const name = /^\s*([A-Za-z_$][\w$]*)\s*(?:=[^]*)?$/.exec(code.slice(part.from, part.to));
        return name ? name[1] : null;
    });
}

// Chaves de primeiro nível de um objeto literal { ... } que começa em from: { nome: texto do valor no fonte original }.
function literalKeys(code, original, from, to) {
    const open = code.indexOf('{', from);
    if (open < 0 || open >= to || code.slice(from, open).trim()) return null;
    let depth = 0;
    let close = to;
    for (let i = open; i < to; i += 1) {
        if (code[i] === '{') depth += 1;
        else if (code[i] === '}') { depth -= 1; if (depth === 0) { close = i; break; } }
    }
    const keys = {};
    topLevelParts(code, open + 1, close).forEach(part => {
        const key = /^\s*([A-Za-z_$][\w$]*)\s*(:)?/.exec(code.slice(part.from, part.to));
        if (key) keys[key[1]] = key[2] ? original.slice(part.from + key[0].length, part.to).trim() : key[1];
    });
    return keys;
}

const KEYWORDS_BEFORE_PAREN = new Set([...REGEX_WORDS, 'if', 'while', 'for', 'switch', 'catch', 'return']);

// Acesso por colchete com o nome fixo (memory['auditLogs']) vira .auditLogs, com espaços
// no lugar do que sobra, para manter as posições.
function normalizeTrailAccess(code) {
    return code.replace(/(\?\.)?\[\s*(['"])auditLogs\2\s*\]/g, (match, optional, quote, offset) => {
        const before = code.slice(0, offset).replace(/\s+$/, '');
        const last = before[before.length - 1] || '';
        if (!/[\w$)\]]/.test(last)) return match;
        const word = /[\w$]+$/.exec(before);
        if (word && REGEX_WORDS.has(word[0])) return match;
        return '.auditLogs'.padEnd(match.length, ' ');
    });
}

// O que um arquivo faz com auditLogs, seguindo a lista e as entradas dela pelo código:
// - 'alter': muda, troca ou remove entrada existente, ou troca/esvazia a lista;
// - 'append': entrada nova sem passar pelo recordAudit;
// - 'exam': entrada de prova (type + applicationId) sem type 'exam_...' escrito no
//   próprio objeto (só vale dentro de um registrador de prova, EXAM_REGISTRARS).
// Cada ocorrência tem um papel: a lista guardada (X.auditLogs), outro nome para a lista
// (const { auditLogs } = db.memory, const logs = db.memory.auditLogs, parâmetro
// auditLogs), uma lista nova com as mesmas entradas (filter, slice, [...lista]) ou uma
// entrada (find, at, lista[i], for...of, o parâmetro do callback). Cada nome novo é
// seguido no trecho onde vale.
function auditLogFindings(source) {
    const original = source.replace(/`auditLogs`/g, '\'auditLogs\'');
    let code = normalizeTrailAccess(blankNonCode(original));
    ENSURE_IDIOMS.forEach(pattern => { code = code.replace(pattern, match => match.replace(/[^\n]/g, ' ')); });
    const findings = [];
    const reported = new Set();
    const add = (kind, index, length) => {
        if (reported.has(`${kind}:${index}`)) return;
        reported.add(`${kind}:${index}`);
        findings.push({ kind, index, line: lineOf(code, index), text: code.slice(index, index + length).replace(/\s+/g, ' ').trim() });
    };
    const queue = [];
    const queued = new Set();
    const enqueue = (index, end, role, member = false) => {
        const key = `${index}:${role}`;
        if (queued.has(key)) return;
        queued.add(key);
        queue.push({ index, end, role, member });
    };
    // Um nome que passa a valer (lista, entradas ou entrada) entre from e to.
    const bind = (name, role, from, to) => {
        const pattern = new RegExp(`(?<![.\\w$'"])${name.replace(/\$/g, '\\$')}(?![\\w$])(?!\\s*:)`, 'g');
        for (const found of code.slice(from, to).matchAll(pattern)) enqueue(from + found.index, from + found.index + found[0].length, role);
    };

    for (const match of code.matchAll(/\.\s*auditLogs(?![\w$])/g)) enqueue(match.index, match.index + match[0].length, 'list', true);
    // O nome auditLogs solto (desestruturação, parâmetro) é a lista no arquivo todo.
    bind('auditLogs', 'list', 0, code.length);
    // const { auditLogs: logs } = db.memory
    for (const match of code.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)) {
        for (const renamed of match[1].matchAll(/(?<![\w$])auditLogs\s*:\s*([A-Za-z_$][\w$]*)/g)) bind(renamed[1], 'list', match.index + match[0].length, blockEnd(code, match.index));
    }

    while (queue.length) {
        const ref = queue.shift();
        let role = ref.role;
        // Começo da expressão: volta pelo objeto (db.memory.) para ver o que vem antes.
        let start = ref.index;
        while (start > 0 && (/[\w$.]/.test(code[start - 1]) || (code[start - 1] === '?' && code[start] === '.'))) start -= 1;
        // Expressão não começa por ponto: o que sobrou é o "..." de um espalhamento.
        while (start < ref.index && code[start] === '.') start += 1;
        let cursor = ref.end;
        // X.auditLogs || [], (X.auditLogs || []) e ((memory && memory.auditLogs) || []):
        // o parêntese que só agrupa sai; o de uma chamada (f(X.auditLogs)) fica.
        for (let level = 0; level < 3; level += 1) {
            const fallback = /^\s*(?:\|\||\?\?)\s*\[\s*\]/.exec(code.slice(cursor));
            if (fallback) cursor += fallback[0].length;
            const opening = /\(\s*(?:[\w$.]+\s*&&\s*)?$/.exec(code.slice(0, start));
            const closing = /^\s*\)/.exec(code.slice(cursor));
            if (!opening || !closing) break;
            const callee = /([\w$]+|[\])])\s*$/.exec(code.slice(0, opening.index));
            if (callee && !KEYWORDS_BEFORE_PAREN.has(callee[1])) break;
            start = opening.index;
            cursor += closing[0].length;
        }
        // O que vem depois: .nome, .metodo(...), [índice].
        const segments = [];
        for (;;) {
            const rest = code.slice(cursor);
            let found = /^\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/.exec(rest);
            if (found) {
                const after = cursor + found[0].length;
                const call = /^[ \t]*(?:\?\.)?\(/.exec(code.slice(after));
                if (call) {
                    const open = after + call[0].length - 1;
                    const args = callArgument(code, open);
                    segments.push({ type: 'call', name: found[1], at: cursor, from: open + 1, to: open + 1 + args.length });
                    cursor = open + args.length + 2;
                } else {
                    segments.push({ type: 'prop', name: found[1], at: cursor });
                    cursor = after;
                }
                continue;
            }
            found = /^[ \t]*(?:\?\.)?\[/.exec(rest);
            if (found) {
                const open = cursor + found[0].length - 1;
                segments.push({ type: 'index', at: cursor });
                cursor = matchingBracket(code, open) + 1;
                continue;
            }
            break;
        }
        // Segue a expressão: a lista, uma lista com as mesmas entradas, uma entrada, uma
        // parte de uma entrada (entry.details), [índice, entrada] (entries()) ou outra coisa.
        let state = role;
        let listElement = false;
        for (const segment of segments) {
            if (state === 'list' || state === 'entries') {
                if (segment.type === 'index') { listElement = state === 'list'; state = 'entry'; continue; }
                if (segment.type === 'prop') { state = segment.name === 'length' && state === 'list' ? 'length' : 'other'; continue; }
                if (CALLBACK_PARAMS[segment.name]) {
                    const params = callbackParams(code, segment.from, segment.to);
                    CALLBACK_PARAMS[segment.name].forEach(position => { if (params[position]) bind(params[position], 'entry', segment.from, segment.to); });
                }
                if (state === 'list' && MUTATORS.has(segment.name)) {
                    add('alter', segment.at, segment.name.length + 2);
                    state = ['sort', 'reverse', 'fill', 'copyWithin'].includes(segment.name) ? 'list' : (segment.name === 'splice' ? 'entries' : (['pop', 'shift'].includes(segment.name) ? 'entry' : 'other'));
                    continue;
                }
                if (state === 'list' && segment.name === 'push') {
                    // Entrada de prova: objeto com type 'exam_...' escrito e applicationId no
                    // primeiro nível. Com o type vindo de uma variável, só no registrador de prova.
                    const keys = literalKeys(code, original, segment.from, segment.to);
                    const examShape = !!keys && 'type' in keys && 'applicationId' in keys;
                    const writtenType = examShape && /^['"`]/.test(keys.type);
                    if (!examShape || (writtenType && !/^(['"])exam_[a-z0-9_]+\1$/.test(keys.type))) add('append', segment.at, 45);
                    else if (!writtenType) add('exam', segment.at, 45);
                    state = 'other';
                    continue;
                }
                if (RETURNS_ENTRIES.has(segment.name) || MUTATORS.has(segment.name)) { state = 'entries'; continue; }
                if (RETURNS_ENTRY.has(segment.name)) { state = 'entry'; listElement = false; continue; }
                state = segment.name === 'entries' ? 'pairs' : 'other';
                continue;
            }
            if (state === 'entry' || state === 'part') {
                if (segment.type !== 'call') { state = 'part'; continue; }
                if (state === 'part' && (MUTATORS.has(segment.name) || segment.name === 'push')) add('alter', segment.at, segment.name.length + 2);
                state = 'other';
                continue;
            }
            state = 'other';
            break;
        }
        const before = code.slice(Math.max(0, start - 160), start);
        const after = code.slice(cursor);
        const changesStored = state === 'part' || state === 'length' || (state === 'entry' && listElement) || (ref.member && !segments.length);
        if (changesStored && ASSIGN_AFTER.test(after)) add('alter', start, cursor - start + 3);
        if (changesStored && /\bdelete\s+$/.test(before)) add('alter', start, cursor - start);
        if (['list', 'entry', 'part'].includes(state) && /\bObject\.assign\(\s*$/.test(before) && /^\s*[,)]/.test(after)) add('alter', start, cursor - start);
        // Nome novo para o resultado: const x = ..., const [a, b] = ..., for (const x of ...).
        const ends = /^\s*(?:[;,)}\]\n]|$)/.test(after);
        // (const copy = entry && entry.details && entry.details.deletedSubmission: o último operando)
        const declared = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[^;\n]*?(?:&&|\|\||\?\?)\s*)?$/.exec(before);
        const spread = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\[\s*\.\.\.|Array\.from\(\s*)$/.exec(before);
        const destructured = /\b(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*$/.exec(before);
        const forOf = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+$/.exec(before);
        const forPairs = /\bfor\s*\(\s*(?:const|let|var)\s+\[\s*[\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s+of\s+$/.exec(before);
        const scopeOf = match => [start, blockEnd(code, start - (before.length - match.index))];
        if (declared && ends && ['list', 'entries', 'entry', 'part', 'pairs'].includes(state)) {
            bind(declared[1], state === 'part' ? 'entry' : state, ...scopeOf(declared));
        }
        if (spread && ['list', 'entries'].includes(state)) bind(spread[1], 'entries', ...scopeOf(spread));
        if (destructured && ['list', 'entries'].includes(state)) {
            destructured[1].split(',').map(name => name.trim()).filter(name => /^[A-Za-z_$][\w$]*$/.test(name)).forEach(name => bind(name, 'entry', ...scopeOf(destructured)));
        }
        if (forOf && ['list', 'entries'].includes(state)) bind(forOf[1], 'entry', ...scopeOf(forOf));
        if (forPairs && state === 'pairs') bind(forPairs[1], 'entry', ...scopeOf(forPairs));
    }

    // Lista de coleções percorrida por nome (como na troca de e-mail).
    const nameLists = [
        /\[[^[\]]*['"]auditLogs['"][^[\]]*\]\s*\.\s*(?:forEach|map)\s*\(/g,
        /\bfor\s*\(\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s+of\s+\[[^[\]]*['"]auditLogs['"][^[\]]*\]/g,
    ];
    nameLists.forEach(pattern => {
        for (const match of code.matchAll(pattern)) add('alter', match.index, match[0].length);
    });
    // Object.assign(db.memory, { auditLogs: [] }) troca a lista.
    for (const match of code.matchAll(/\bObject\s*\.\s*assign\s*\(/g)) {
        const args = callArgument(code, match.index + match[0].length - 1);
        if (/(?<![.\w$'"])auditLogs\s*(?::|[,}])/.test(args)) add('alter', match.index, match[0].length + args.length + 1);
    }
    findings.sort((a, b) => a.index - b.index);
    return { code, findings };
}

// Onde a trilha pode mudar (contrato 6): a troca de e-mail do aluno, a anonimização, o
// apagar de vez (studentLifecycle.js, H7c), a restauração (backup.js) e a carga do banco.
const MAY_ALTER = {
    'backend/utils/audit.js': '*',
    'backend/utils/backup.js': '*',
    'backend/utils/studentLifecycle.js': '*',
    'backend/database.js': '*',
    'backend/utils/gradebook.js': ['anonymizeStudentAuditTrail'],
    'backend/routes/admin.js': ['renameStudentEmailEverywhere'],
};
// Onde entra entrada sem o recordAudit: o próprio audit.js, a carga do banco e a
// restauração, que devolve o histórico de backup (keepBackupHistory, até o H7a-2 trocar
// pela junção mergeAuditTrails).
const MAY_APPEND = {
    'backend/utils/audit.js': '*',
    'backend/utils/backup.js': '*',
    'backend/database.js': '*',
    'backend/routes/adminRecovery.js': ['keepBackupHistory'],
};
// Entrada de prova (type + applicationId) com o type vindo de fora: só no registrador de
// prova, e quem o chama passa sempre um 'exam_...' escrito (teste abaixo).
const EXAM_REGISTRARS = {
    'backend/utils/examFinish.js': ['recordExamAudit'],
};
const RULES_BY_KIND = { alter: MAY_ALTER, append: MAY_APPEND, exam: EXAM_REGISTRARS };
const KIND_TEXT = { alter: 'altera a trilha', append: 'entrada nova sem recordAudit', exam: 'entrada de prova sem type \'exam_...\' escrito' };

function backendFiles(directory = BACKEND) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (entry.name === 'node_modules') return [];
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return backendFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

function allowedAt(rules, rel, code, index) {
    const rule = rules[rel];
    if (rule === '*') return true;
    if (!Array.isArray(rule)) return false;
    return rule.some(name => {
        const range = functionRange(code, name);
        return !!range && index >= range.start && index < range.end;
    });
}

test('[UC-AUDITORIA-001] a varredura acha cada forma de alterar a trilha e ignora leitura, comentário e prova', () => {
    // Cada linha que a varredura deve acusar termina com //! e o tipo (alter, append, exam).
    const sample = [
        "// db.memory.auditLogs = []; comentário não conta",
        "/* memory.auditLogs.splice(0, 1) */",
        "const text = 'memory.auditLogs.pop() dentro de texto // não é comentário';",
        "if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];",
        "db.memory.auditLogs ??= [];",
        "const lidos = (db.memory.auditLogs || []).filter(item => item.ok).sort();",
        "function trilha(application, auditLogs = []) { return auditLogs; }",
        "if (db.memory.auditLogs === lidos) {}",
        "const re = /auditLogs = \\//g;",
        "const label = `${a ? `x ${b}` : ''} // dentro do template`;",
        "memory.auditLogs.push({ id: 1, type, actor, applicationId: app.id, details: {} }); //! exam",
        "db.memory.auditLogs = db.memory.auditLogs.filter(item => item.keep); //! alter",
        "memory.auditLogs.splice(2, 1); //! alter",
        "memory.auditLogs[index] = next; //! alter",
        "(db.memory.auditLogs || []).sort((a, b) => a - b); //! alter",
        "memory.auditLogs.length = 0; //! alter",
        "delete memory.auditLogs; //! alter",
        "['students', 'auditLogs'].forEach(name => { memory[name] = []; }); //! alter",
        "memory.auditLogs.push({ id: 'x', type: 'class_reset', actorEmail: 'a' }); //! append",
        "function f() {",
        "    const logs = db.memory.auditLogs || [];",
        "    logs.pop(); //! alter",
        "    logs.push({ action: 'x' }); //! append",
        "}",
        "const outra = db.memory.loginLogs || [];",
        "outra.pop();",
        "(db.memory.auditLogs || []).forEach(entry => { if (entry.ok) entry.studentEmail = novo; }); //! alter",
        "memory.auditLogs.filter(item => item.ok).forEach((item, index) => { delete item.ip; }); //! alter",
        "for (const registro of db.memory.auditLogs) {",
        "    registro.oldValue += '!'; //! alter",
        "}",
        "const achada = (db.memory.auditLogs || []).find(item => item.id === id);",
        "Object.assign(achada, { reason: 'x' }); //! alter",
        "const lidas = db.memory.auditLogs.map(entry => ({ ...entry, label: 'x' }));",
        "const copia = { ...lidas[0] }; copia.label = 'y';",
        "db.memory.auditLogs.forEach(entry => { const next = { ...entry }; next.ip = ''; outro.entry.x = 1; });",
        "function g() {",
        "    const trilha = memory.auditLogs;",
        "    trilha.forEach(entry => { entry.at = 0; }); //! alter",
        "}",
        // Formas que a primeira versão da varredura deixava passar.
        "db.memory.auditLogs[0].actor = 'x'; //! alter",
        "for (let i = 0; i < total; i += 1) db.memory.auditLogs[i].ip = ''; //! alter",
        "db.memory.auditLogs[db.memory.auditLogs.length - 1].reason = 'x'; //! alter",
        "db.memory.auditLogs.find(entry => entry.id === id).reason = 'x'; //! alter",
        "function h() {",
        "    const filtradas = db.memory.auditLogs.filter(entry => entry.ok);",
        "    filtradas.forEach(entry => { entry.ip = ''; }); //! alter",
        "    filtradas.sort(); filtradas.push({ nova: true }); filtradas.length = 0;",
        "}",
        "function k() {",
        "    const { auditLogs } = db.memory;",
        "    auditLogs.splice(0, 1); //! alter",
        "}",
        "db.memory['auditLogs'] = []; //! alter",
        "db.memory[`auditLogs`].pop(); //! alter",
        "Object.assign(db.memory, { auditLogs: [] }); //! alter",
        "db.memory.auditLogs.push({ type: 'account_created', applicationId: null, actor }); //! append",
        "db.memory.auditLogs.push({ details: { type: 'exam_x', applicationId: 1 }, action: 'y' }); //! append",
        "db.memory.auditLogs.push({ type: 'exam_question_reported', actor, applicationId: app.id, details: { type: 'x' } });",
        "function m() {",
        "    const { auditLogs: registro } = db.memory;",
        "    registro.map(entry => ({ ...entry }));",
        "    registro.pop(); //! alter",
        "    const ultima = registro[registro.length - 1];",
        "    const copiaUltima = { ...ultima }; copiaUltima.x = 1;",
        "    ultima.details.lista.push('x'); //! alter",
        "    ultima.contador++; //! alter",
        "}",
        "res.json({ auditLogs: lidos, total: lidos.length });",
        "db.memory['auditLogs'].at(-1).ip = ''; //! alter",
        "db.memory?.['auditLogs']?.forEach(entry => { entry.ip = ''; }); //! alter",
        "const ordenadas = [...db.memory.auditLogs]; ordenadas.sort(); ordenadas[0].ip = ''; //! alter",
        "for (const [posicao, item] of db.memory.auditLogs.entries()) {",
        "    item.reason = posicao; //! alter",
        "}",
        "const [primeira] = db.memory.auditLogs; delete primeira.ip; //! alter",
        "db.memory.auditLogs.reduce((total, entry) => { entry.x = 1; return total; }, 0); //! alter",
        "db.memory.auditLogs.forEach(entry => { const copy = entry && entry.details && entry.details.deletedSubmission; if (copy) copy.student = null; }); //! alter",
        "((memory && memory.auditLogs) || []).forEach(entry => { entry.ip = ''; }); //! alter",
        "return (db.memory.auditLogs || []).filter(entry => entry.ok).map(entry => ({ id: entry.id, at: entry.timestamp }));",
        "const restored = new Set(logs.filter(entry => entry.action === 'grade_restore').map(entry => String(entry.id)));",
    ];
    const expected = sample.flatMap((line, index) => {
        const mark = /\/\/! (alter|append|exam)$/.exec(line);
        return mark ? [`${mark[1]}:${index + 1}`] : [];
    });
    const { findings } = auditLogFindings(sample.join('\n'));
    assert.deepEqual(findings.map(item => `${item.kind}:${item.line}`).sort(), expected.sort());
    const ranged = 'x();\n    function keep() {\n        a.auditLogs.pop();\n    }\nb.auditLogs.pop();\n';
    const { code, findings: rangedFindings } = auditLogFindings(ranged);
    const rules = { 'f.js': ['keep'] };
    assert.deepEqual(rangedFindings.map(item => allowedAt(rules, 'f.js', code, item.index)), [true, false]);
});

test('[UC-AUDITORIA-001] só acréscimo: nenhum arquivo do backend altera a trilha fora das funções permitidas', () => {
    const violations = [];
    let scanned = 0;
    for (const file of backendFiles()) {
        const rel = path.relative(REPO, file).split(path.sep).join('/');
        const source = fs.readFileSync(file, 'utf8');
        if (!source.includes('auditLogs')) continue;
        scanned += 1;
        const { code, findings } = auditLogFindings(source);
        findings.forEach(finding => {
            if (!allowedAt(RULES_BY_KIND[finding.kind], rel, code, finding.index)) violations.push(`${rel}:${finding.line} (${KIND_TEXT[finding.kind]}): ${finding.text}`);
        });
    }
    assert.ok(scanned >= 8, `a varredura leu só ${scanned} arquivos com auditLogs`);
    assert.deepEqual(violations, [], `Use recordAudit (utils/audit.js) para gravar auditoria; só as funções de MAY_ALTER podem mudar entradas existentes.\n${violations.join('\n')}`);
});

test('[UC-AUDITORIA-001] entrada de prova: o registrador de prova só é chamado com um type \'exam_...\' escrito', () => {
    const calls = [];
    for (const file of backendFiles()) {
        const source = fs.readFileSync(file, 'utf8');
        if (!source.includes('recordExamAudit') && !source.includes('RecordExamAudit')) continue;
        const code = blankNonCode(source);
        const rel = path.relative(REPO, file).split(path.sep).join('/');
        const wrapper = functionRange(code, 'recordExamAudit');
        for (const match of code.matchAll(/(?<![\w$.])(?:recordExamAudit|sharedRecordExamAudit)\s*\(/g)) {
            if (/\bfunction\s+$/.test(code.slice(Math.max(0, match.index - 20), match.index))) continue;
            const open = match.index + match[0].length - 1;
            const args = callArgument(code, open);
            const parts = topLevelParts(code, open + 1, open + 1 + args.length).map(part => source.slice(part.from, part.to).trim());
            const written = parts.find(part => /^['"`]/.test(part));
            // O atalho de uma linha que repassa o próprio type (adminExamConfig.js) é um registrador também.
            const forwards = !written && parts.includes('type') && !!wrapper && match.index >= wrapper.start && match.index < wrapper.end;
            const where = `${rel}:${lineOf(code, match.index)}`;
            calls.push(where);
            assert.ok(forwards || /^(['"])exam_[a-z0-9_]+\1$/.test(written || ''), `${where}: registrador de prova chamado sem type 'exam_...' escrito`);
        }
    }
    assert.ok(calls.length >= 8, `achou só ${calls.length} chamadas: ${calls.join(', ')}`);
});

test('[UC-AUDITORIA-001] as funções permitidas continuam existindo onde a lista diz', () => {
    for (const rules of [MAY_ALTER, MAY_APPEND, EXAM_REGISTRARS]) {
        for (const [rel, names] of Object.entries(rules)) {
            if (!Array.isArray(names)) continue;
            const code = blankNonCode(fs.readFileSync(path.join(REPO, rel), 'utf8'));
            names.forEach(name => assert.ok(functionRange(code, name), `${rel} não tem mais ${name}: atualize a lista`));
        }
    }
    // E a varredura de fato enxerga as alterações que essas funções fazem.
    const gradebook = auditLogFindings(fs.readFileSync(path.join(BACKEND, 'utils/gradebook.js'), 'utf8'));
    assert.ok(gradebook.findings.some(item => item.kind === 'alter'), 'anonymizeStudentAuditTrail troca entradas');
    const admin = auditLogFindings(fs.readFileSync(path.join(BACKEND, 'routes/admin.js'), 'utf8'));
    assert.ok(admin.findings.some(item => item.kind === 'alter'), 'a troca de e-mail renomeia entradas');
    const examFinish = auditLogFindings(fs.readFileSync(path.join(BACKEND, 'utils/examFinish.js'), 'utf8'));
    assert.deepEqual(examFinish.findings.map(item => item.kind), ['exam'], 'o registrador de prova é visto como tal');
});

// ------------------------------------------------------------ registradores
let app;
const adminToken = 'admin-token-audit';
const professorToken = 'professor-token-audit';
const courseId = 'curso-audit';
const UA = 'Navegador de teste/1.0';

function seed() {
    db.memory.admins = [
        { email: 'admin@audit.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') },
        { email: 'prof@audit.local', name: 'Professora', role: 'professor', password: db.hashPassword('y'), assignedClasses: [{ courseId, className: '1AUD' }] },
    ];
    db.memory.adminSessions = {
        [adminToken]: { email: 'admin@audit.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: 'prof@audit.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    db.memory.courses = [{ id: courseId, name: 'Curso Auditoria', structure: [] }];
    db.memory.classes = [{ name: '1AUD', courseId, period: 'Manhã', releasedItems: {} }];
    db.memory.students = [];
    db.memory.auditLogs = [];
    db.memory.examApplications = [];
    db.memory.studentExamState = {};
}

const asAdmin = req => req.set('x-admin-session', adminToken).set('User-Agent', UA);

test.before(async () => { await db.init(); app = createApp(); });
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function assertCanonical(entry, { action, category, actor = 'admin@audit.local', actorRole = 'admin' }) {
    assert.ok(entry, `sem entrada ${action}`);
    assert.equal(entry.action, action);
    assert.equal(entry.category, category);
    assert.equal(entry.actor, actor);
    if (actorRole) assert.equal(entry.actorRole, actorRole);
    assert.equal(typeof entry.timestamp, 'number');
    assert.match(entry.id, new RegExp(`^audit_${category}_${entry.timestamp}_[0-9a-f]{8}$`));
    assert.equal(typeof entry.ip, 'string');
    assert.equal(entry.device, UA);
}

test('[UC-AUDITORIA-001] turma criada e alterada: entrada canônica, campos antigos e uma cópia que não muda com a turma', async () => {
    const created = await asAdmin(request(app).post('/api/admin/class/create')).send({ name: '2aud', period: 'Manhã', courseId });
    assert.equal(created.status, 200, created.body.error);
    const createdEntry = db.memory.auditLogs.find(entry => entry.type === 'class_created');
    assertCanonical(createdEntry, { action: 'class_created', category: 'academic' });
    // Campos que as entradas de turma sempre tiveram.
    assert.equal(createdEntry.actorEmail, 'admin@audit.local');
    assert.equal(createdEntry.at, createdEntry.timestamp);
    assert.deepEqual(createdEntry.target, { courseId, className: '2AUD' });
    assert.equal(createdEntry.courseId, courseId);
    assert.equal(createdEntry.studentClass, '2AUD');
    assert.equal(createdEntry.before, null);
    assert.equal(createdEntry.after.period, 'Manhã');

    const updated = await asAdmin(request(app).post('/api/admin/class/update')).send({ name: '2AUD', courseId, period: 'Noite' });
    assert.equal(updated.status, 200, updated.body.error);
    // Antes a entrada guardava a própria turma (referência): virava "Noite" junto.
    assert.equal(createdEntry.after.period, 'Manhã', 'a entrada de criação não muda com a turma');
    const live = db.memory.classes.find(item => item.name === '2AUD');
    live.releasedItems.Avaliacao_X = true;
    const updatedEntry = db.memory.auditLogs.find(entry => entry.type === 'class_updated');
    assertCanonical(updatedEntry, { action: 'class_updated', category: 'academic' });
    assert.equal(updatedEntry.before.period, 'Manhã');
    assert.equal(updatedEntry.after.period, 'Noite');
    assert.equal(updatedEntry.after.releasedItems.Avaliacao_X, undefined, 'o objeto aninhado também é cópia');
    assert.equal(normalizeAuditEntry(updatedEntry).label, 'Turma alterada');
});

test('[UC-AUDITORIA-001] turma com prova preparada com token: a auditoria guarda a turma sem o token nem o hash dele', async () => {
    // Prova preparada pelas rotas de verdade: a turma fica com o token em examHistory e
    // o sha256 do token em onlineExamConfigs[prova].accessTokenHash (adminExamConfig.js).
    // O token tem 5 letras e o hash não tem sal: o hash na auditoria é o token.
    const { hashExamToken } = require('../../backend/utils/examToken.js');
    db.memory.courses[0].structure = [{ id: 'm1', title: 'Módulo 1', units: [{ id: 'u1', title: 'Unidade 1', avaliacaoKey: 'Avaliacao_A' }] }];
    const questions = [1, 2].map(number => ({
        originalNumber: number, examNumber: number, text: `Questão ${number}`, correctAnswer: 'A',
        alternatives: [{ letter: 'A', displayLetter: 'A', text: 'certa', isCorrect: true }, { letter: 'B', displayLetter: 'B', text: 'errada', isCorrect: false }],
    }));
    const history = await asAdmin(request(app).post('/api/admin/exam-history/add')).send({
        studentClass: '1AUD', courseId, examKey: 'Avaliacao_A', type: 'online', questionNumbers: [1, 2],
        printSnapshot: [{ version: 'A', questions, answerKey: { 1: 'A', 2: 'A' } }], durationMinutes: 30, waitingRoomMinutes: 0, maxAttempts: 1, accessToken: 'PROVA',
    });
    assert.equal(history.status, 200, history.body.error);
    const prepared = await asAdmin(request(app).post('/api/admin/exam-applications')).send({
        studentClass: '1AUD', courseId, examKey: 'Avaliacao_A', historyId: history.body.entry.id,
        applicationOptions: { timerMode: 'per_attempt', waitingRoomMinutes: 0, maxAttempts: 1, tokenEnabled: true, accessToken: 'PROVA' },
    });
    assert.equal(prepared.status, 201, prepared.body.error);
    const tokenHash = hashExamToken('PROVA');
    const cls = db.memory.classes[0];
    assert.equal(cls.onlineExamConfigs.Avaliacao_A.accessTokenHash, tokenHash, 'o campo real que a turma guarda');
    assert.equal(cls.examHistory.Avaliacao_A[0].accessToken, 'PROVA');

    const updated = await asAdmin(request(app).post('/api/admin/class/update')).send({ name: '1AUD', courseId, period: 'Manhã' });
    assert.equal(updated.status, 200, updated.body.error);
    const toggled = await asAdmin(request(app).post('/api/admin/class/toggle-registration')).send({ name: '1AUD', courseId });
    assert.equal(toggled.status, 200, toggled.body.error);
    const classEntries = db.memory.auditLogs.filter(item => item.type === 'class_updated');
    assert.equal(classEntries.length, 2);
    const trail = JSON.stringify(db.memory.auditLogs);
    assert.equal(trail.includes(tokenHash), false, 'o hash do token da prova não vai para a auditoria');
    assert.equal(trail.includes('accessTokenHash'), false);
    assert.equal(trail.includes('"accessToken"'), false);
    assert.equal(trail.includes('PROVA'), false);
    // O resto da configuração continua na fotografia da turma.
    for (const entry of classEntries) {
        assert.equal(entry.before.onlineExamConfigs.Avaliacao_A.tokenEnabled, true);
        assert.equal(entry.after.onlineExamConfigs.Avaliacao_A.status, 'prepared');
    }
    // E a turma continua com o hash, para a prova pedir o token.
    assert.equal(cls.onlineExamConfigs.Avaliacao_A.accessTokenHash, tokenHash, 'a turma continua com o hash');

    // Excluir a turma também copia a turma inteira para before.
    const removed = await asAdmin(request(app).post('/api/admin/class/delete')).send({ name: '1AUD', courseId });
    assert.equal(removed.status, 200, removed.body.error);
    const deleted = db.memory.auditLogs.find(item => item.type === 'class_deleted');
    assert.ok(deleted, 'turma excluída auditada');
    assert.equal(JSON.stringify(deleted).includes(tokenHash), false);
    assert.equal(JSON.stringify(deleted).includes('PROVA'), false);
});

test('[UC-AUDITORIA-001] escopo do professor: account com os campos antigos e cópia das listas', async () => {
    const response = await asAdmin(request(app).post('/api/admin/teacher-assignments')).send({ email: 'prof@audit.local', assignedClasses: [{ courseId, className: '1AUD' }], assignedCourseIds: [courseId] });
    assert.equal(response.status, 200, response.body.error);
    const entry = db.memory.auditLogs.find(item => item.action === 'professor_assignments_updated');
    assertCanonical(entry, { action: 'professor_assignments_updated', category: 'account' });
    assert.equal(entry.type, 'professor_assignments_updated');
    assert.equal(entry.actorEmail, 'admin@audit.local');
    assert.equal(entry.at, entry.timestamp);
    assert.equal(entry.targetEmail, 'prof@audit.local');
    assert.deepEqual(entry.after.assignedCourseIds, [courseId]);
    db.memory.admins[1].assignedCourseIds.push('outro');
    assert.deepEqual(entry.after.assignedCourseIds, [courseId], 'a lista da conta não é a mesma da auditoria');
});

test('[UC-AUDITORIA-001] resetar sala: system com type/actorEmail/at e os dados em details', async () => {
    const response = await asAdmin(request(app).post('/api/admin/reset')).send({ studentClass: '1AUD', courseId, confirm: 'RESETAR' });
    assert.equal(response.status, 200, response.body.error);
    const entry = db.memory.auditLogs.find(item => item.type === 'class_reset');
    assertCanonical(entry, { action: 'class_reset', category: 'system' });
    assert.equal(entry.actorEmail, 'admin@audit.local');
    assert.equal(entry.at, entry.timestamp);
    assert.equal(entry.studentClass, '1AUD');
    assert.equal(entry.courseId, courseId);
    assert.equal(typeof entry.details.disconnectedStudents, 'number');
});

test('[UC-AUDITORIA-001] cópia de backup no servidor: backup no formato canônico, sem type', async () => {
    const response = await asAdmin(request(app).post('/api/admin/backup/server')).send({});
    assert.equal(response.status, 200, response.body.error);
    const entry = db.memory.auditLogs.find(item => item.action === 'backup_server_created');
    assertCanonical(entry, { action: 'backup_server_created', category: 'backup' });
    assert.equal(entry.type, undefined);
    assert.equal(entry.details.file, response.body.fileName);
});

test('[UC-AUDITORIA-001] cadastro do aluno: student, uma entrada por campo, sem a senha', async () => {
    const response = await asAdmin(request(app).post('/api/admin/student/create')).send({
        name: 'Ana Auditada', email: 'Ana@Audit.Local', studentPassword: 'senha-secreta-123', classes: [{ name: '1AUD', courseId }],
    });
    assert.equal(response.status, 200, response.body.error);
    const entry = db.memory.auditLogs.find(item => item.action === 'create');
    assertCanonical(entry, { action: 'create', category: 'student' });
    assert.equal(entry.studentEmail, 'ana@audit.local');
    assert.equal(entry.field, 'Cadastro');
    assert.equal(entry.newValue, 'Aluno criado');
    assert.equal(JSON.stringify(db.memory.auditLogs).includes('senha-secreta-123'), false);

    // Várias alterações de uma vez: mesma hora, ids diferentes.
    recordStudentAudit(db.memory, {
        actor: 'admin@audit.local', studentEmail: 'ana@audit.local', action: 'update',
        changes: [{ field: 'Nome completo', oldValue: 'Ana', newValue: 'Ana B' }, { field: 'Status', oldValue: 'Ativo', newValue: 'Inativo' }],
        req: { ip: '127.0.0.1', headers: { 'user-agent': UA } },
    });
    const updates = db.memory.auditLogs.filter(item => item.action === 'update');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].timestamp, updates[1].timestamp);
    assert.notEqual(updates[0].id, updates[1].id);
    assert.deepEqual(updates.map(item => [item.field, item.oldValue, item.newValue]), [['Nome completo', 'Ana', 'Ana B'], ['Status', 'Ativo', 'Inativo']]);
    // Sem alteração: a entrada leva o nome da ação, como antes.
    recordStudentAudit(db.memory, { actor: '', studentEmail: 'ana@audit.local', action: 'observation_create', changes: [] });
    const fallback = db.memory.auditLogs[db.memory.auditLogs.length - 1];
    assert.equal(fallback.field, 'observation_create');
    assert.equal(fallback.actor, 'desconhecido');
});

test('[UC-AUDITORIA-001] nota: grade com os campos que a lixeira e o histórico leem', () => {
    const req = { ip: '::ffff:192.168.0.9', headers: { 'user-agent': UA }, adminAccount: { email: 'prof@audit.local', role: 'professor' } };
    const submission = { id: 77, examKey: 'Avaliacao_A', applicationId: 'app_1', student: { email: 'Bia@Audit.Local', courseId, studentClass: '1AUD' } };
    const entry = recordGradeAudit(db.memory, { req, actor: { email: 'prof@audit.local' }, submission, action: 'grade_delete', oldValue: 7, newValue: '', details: { deletedSubmission: { id: 77, score: 70 } } });
    assert.equal(db.memory.auditLogs[db.memory.auditLogs.length - 1], entry);
    assertCanonical(entry, { action: 'grade_delete', category: 'grade', actor: 'prof@audit.local', actorRole: 'professor' });
    assert.equal(entry.ip, '192.168.0.9');
    assert.equal(entry.studentEmail, 'bia@audit.local');
    assert.equal(entry.field, 'Nota');
    assert.equal(entry.oldValue, '7');
    assert.equal(entry.newValue, '');
    assert.equal(entry.submissionId, '77');
    assert.equal(entry.examKey, 'Avaliacao_A');
    assert.equal(entry.applicationId, 'app_1');
    assert.equal(entry.courseId, courseId);
    assert.equal(entry.studentClass, '1AUD');
    assert.deepEqual(entry.details, { deletedSubmission: { id: 77, score: 70 } });
    // Entrega sem identificadores: os campos ficam com null, como antes.
    const bare = recordGradeAudit(db.memory, { actor: 'admin@audit.local', submission: {}, action: 'grade_create' });
    assert.deepEqual([bare.submissionId, bare.examKey, bare.applicationId, bare.courseId, bare.studentClass], [null, null, null, null, null]);
    assert.equal('details' in bare, false);
    assert.equal(recordGradeAudit(null, { action: 'grade_create' }), null);
});

test('[UC-AUDITORIA-001] modo de configuração local: security com type/actorEmail/at em ISO', async () => {
    const { createSetupModeRouter } = require('../../backend/routes/setupMode.js');
    db.memory.admins.push({ email: 'admin@teste.local', name: 'Admin Demo', role: 'admin', password: db.hashPassword('teste') });
    const local = express();
    local.use(express.json());
    local.use(createSetupModeRouter({ enabled: true, setupToken: 'token-local' }));
    const quick = await request(local).post('/api/setup/quick-session').set('User-Agent', UA).send({ token: 'token-local', profile: 'admin' });
    assert.equal(quick.status, 200, quick.body.error);
    const quickEntry = db.memory.auditLogs.find(item => item.action === 'local_quick_login');
    assertCanonical(quickEntry, { action: 'local_quick_login', category: 'security', actor: 'admin@teste.local', actorRole: null });
    assert.equal(quickEntry.type, 'local_quick_login');
    assert.equal(quickEntry.profile, 'admin');
    assert.equal(quickEntry.actorEmail, 'admin@teste.local');
    assert.equal(quickEntry.at, new Date(quickEntry.timestamp).toISOString());
    assert.equal(quickEntry.ip, '127.0.0.1');

    const session = await request(local).post('/api/setup/admin-session').set('User-Agent', UA).send({ token: 'token-local' });
    assert.equal(session.status, 200, session.body.error);
    const setupEntry = db.memory.auditLogs.find(item => item.action === 'admin_local_setup_login');
    assertCanonical(setupEntry, { action: 'admin_local_setup_login', category: 'security', actor: session.body.email, actorRole: 'admin' });
    assert.equal(setupEntry.type, 'admin_local_setup_login');
    assert.equal(setupEntry.actorEmail, session.body.email);
    assert.equal(setupEntry.targetEmail, session.body.email);
    assert.equal(setupEntry.at, new Date(setupEntry.timestamp).toISOString());
    assert.equal(JSON.stringify(db.memory.auditLogs).includes('token-local'), false);
});

test('[UC-AUDITORIA-001] redefinição local de senha pelo launcher: security sem a senha temporária', async () => {
    const { resetAdminPassword } = require('../../backend/scripts/reset-admin-password.js');
    const result = await resetAdminPassword('prof@audit.local');
    const entry = db.memory.auditLogs.find(item => item.action === 'admin_password_reset_local');
    assert.ok(entry);
    assert.equal(entry.category, 'security');
    assert.equal(entry.actor, 'launcher-local');
    assert.equal(entry.actorRole, 'sistema');
    assert.equal(entry.type, 'admin_password_reset_local');
    assert.equal(entry.actorEmail, 'launcher-local');
    assert.equal(entry.at, entry.timestamp);
    assert.equal(entry.targetEmail, 'prof@audit.local');
    assert.equal(JSON.stringify(entry).includes(result.temporaryPassword), false);
});
