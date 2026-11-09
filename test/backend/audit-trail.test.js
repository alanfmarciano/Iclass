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

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { recordGradeAudit } = require('../../backend/utils/gradebook.js');
const { recordStudentAudit } = require('../../backend/utils/students.js');
const { normalizeAuditEntry } = require('../../backend/utils/audit.js');

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
const MUTATORS = '(?:splice|pop|shift|unshift|sort|reverse|fill|copyWithin)';
// "Cria a lista se faltar" não altera nada que já existe.
const ENSURE_IDIOM = /if\s*\(\s*!\s*Array\.isArray\(\s*([\w$.]+?)\.auditLogs\s*\)\s*\)\s*\1\.auditLogs\s*=\s*\[\s*\]\s*;?/g;
// Entrada de prova no formato próprio (type + applicationId), lida por buildApplicationAuditTrail.
const isExamEntryLiteral = text => /^\s*\{/.test(text) && /\btype\s*[:,]/.test(text) && /\bapplicationId\s*[:,]/.test(text);

// O que um arquivo faz com auditLogs: 'alter' (muda ou remove entrada existente, troca a
// lista) e 'append' (entrada nova sem passar pelo recordAudit).
function auditLogFindings(source) {
    const code = blankNonCode(source).replace(ENSURE_IDIOM, match => match.replace(/[^\n]/g, ' '));
    const findings = [];
    const add = (kind, index, length) => findings.push({ kind, index, line: lineOf(code, index), text: code.slice(index, index + length).replace(/\s+/g, ' ').trim() });
    const alterPatterns = [
        new RegExp(`\\.\\s*auditLogs\\s*${ASSIGN}`, 'g'),
        new RegExp(`\\.\\s*auditLogs\\s*\\[[^\\]]*\\]\\s*${ASSIGN}`, 'g'),
        new RegExp(`\\.\\s*auditLogs\\s*(?:\\|\\|\\s*\\[\\s*\\]\\s*)?\\)?\\s*\\.\\s*${MUTATORS}\\s*\\(`, 'g'),
        /\.\s*auditLogs\s*\.\s*length\s*=(?!=)/g,
        /\bdelete\s+[\w$.]*\.auditLogs\b/g,
        // Lista de coleções percorrida por nome (como na troca de e-mail).
        /\[[^[\]]*['"`]auditLogs['"`][^[\]]*\]\s*\.\s*(?:forEach|map)\s*\(/g,
    ];
    alterPatterns.forEach(pattern => {
        for (const match of code.matchAll(pattern)) add('alter', match.index, match[0].length);
    });
    for (const match of code.matchAll(/\.\s*auditLogs\s*\.\s*push\s*\(/g)) {
        const argument = callArgument(code, match.index + match[0].length - 1);
        if (!isExamEntryLiteral(argument)) add('append', match.index, match[0].length + 40);
    }
    // Apelido: const logs = db.memory.auditLogs (|| []); logs.splice(...)
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.]*\.auditLogs\s*(?:\|\|\s*\[\s*\]\s*)?(?:;|\n)/g)) {
        const alias = match[1];
        const scope = code.slice(match.index, blockEnd(code, match.index));
        const offset = match.index;
        const aliasPatterns = [
            [new RegExp(`\\b${alias}\\s*\\.\\s*${MUTATORS}\\s*\\(`, 'g'), 'alter'],
            [new RegExp(`\\b${alias}\\s*\\[[^\\]]*\\]\\s*${ASSIGN}`, 'g'), 'alter'],
            [new RegExp(`\\b${alias}\\s*\\.\\s*length\\s*=(?!=)`, 'g'), 'alter'],
        ];
        aliasPatterns.forEach(([pattern, kind]) => {
            for (const found of scope.matchAll(pattern)) add(kind, offset + found.index, found[0].length);
        });
        for (const found of scope.matchAll(new RegExp(`\\b${alias}\\s*\\.\\s*push\\s*\\(`, 'g'))) {
            const argument = callArgument(scope, found.index + found[0].length - 1);
            if (!isExamEntryLiteral(argument)) add('append', offset + found.index, found[0].length + 40);
        }
        // E as entradas lidas pelo apelido: logs.forEach(entry => { entry.x = ... }).
        entryCallbacks(scope, new RegExp(`(?<![.\\w$])${alias}\\s*`, 'g')).forEach(({ index, length }) => add('alter', offset + index, length));
    }
    // Entrada existente alterada no lugar: no callback que percorre a trilha
    // (auditLogs.forEach(entry => { entry.campo = ... })), no for...of e numa entrada
    // achada por find ou por posição (const entry = auditLogs.find(...); entry.campo = ...).
    entryCallbacks(code, /\.\s*auditLogs\s*(?:\|\|\s*\[\s*\]\s*)?\)?\s*/g).forEach(({ index, length }) => add('alter', index, length));
    for (const match of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+[^)\n]*\.auditLogs\b[^)\n]*\)/g)) {
        const scope = code.slice(match.index, blockEnd(code, match.index));
        for (const found of scope.matchAll(entryMutation(match[1]))) add('alter', match.index + found.index, found[0].length);
    }
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.auditLogs\s*(?:\|\|\s*\[\s*\]\s*)?\)?\s*(?:\.\s*(?:find|findLast)\s*\(|\[)/g)) {
        const scope = code.slice(match.index + match[0].length, blockEnd(code, match.index));
        const offset = match.index + match[0].length;
        for (const found of scope.matchAll(entryMutation(match[1]))) add('alter', offset + found.index, found[0].length);
    }
    return { code, findings };
}

// Mudança numa entrada pelo nome que ela tem no trecho: entry.campo = x, entry[k] += x,
// delete entry.campo, Object.assign(entry, ...).
function entryMutation(name) {
    return new RegExp(`(?<![.\\w$])${name}\\s*(?:\\.\\s*[\\w$]+|\\[[^\\]\\n]*\\])+\\s*${ASSIGN}|\\bdelete\\s+${name}\\s*[.[]|\\bObject\\.assign\\(\\s*${name}\\b`, 'g');
}

// Callbacks que recebem as entradas da trilha, a partir de onde a lista aparece (start):
// auditLogs.forEach/map/some/every/find/filter(entry => ...), também depois de um
// filter/slice no meio (auditLogs.filter(...).forEach(entry => ...)). Devolve onde o
// callback muda a entrada que recebe.
const ENTRY_METHODS = new Set(['forEach', 'map', 'flatMap', 'some', 'every', 'find', 'findLast', 'findIndex', 'findLastIndex', 'filter']);
const PASS_THROUGH = new Set(['filter', 'slice']);
function entryCallbacks(code, start) {
    const results = [];
    for (const match of code.matchAll(start)) {
        let cursor = match.index + match[0].length;
        for (;;) {
            const call = /^\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(cursor));
            if (!call) break;
            const open = cursor + call[0].length - 1;
            const argument = callArgument(code, open);
            if (ENTRY_METHODS.has(call[1])) {
                const param = /^\s*(?:async\s+)?(?:\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=>|function\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*))/.exec(argument);
                const name = param && (param[1] || param[2] || param[3]);
                if (name) {
                    for (const found of argument.matchAll(entryMutation(name))) results.push({ index: open + 1 + found.index, length: found[0].length });
                }
            }
            if (!PASS_THROUGH.has(call[1])) break;
            cursor = open + argument.length + 2;
            while (/\s/.test(code[cursor] || '')) cursor += 1;
        }
    }
    return results;
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
    const sample = [
        "// db.memory.auditLogs = []; comentário não conta",
        "/* memory.auditLogs.splice(0, 1) */",
        "const text = 'memory.auditLogs.pop() dentro de texto // não é comentário';",
        "if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];",
        "const lidos = (db.memory.auditLogs || []).filter(item => item.ok).sort();",
        "function trilha(application, auditLogs = []) { return auditLogs; }",
        "if (db.memory.auditLogs === lidos) {}",
        "const re = /auditLogs = \\//g;",
        "const label = `${a ? `x ${b}` : ''} // dentro do template`;",
        "memory.auditLogs.push({ id: 1, type, actor, applicationId: app.id, details: {} });",
        "db.memory.auditLogs = db.memory.auditLogs.filter(item => item.keep);", // 11
        "memory.auditLogs.splice(2, 1);", // 12
        "memory.auditLogs[index] = next;", // 13
        "(db.memory.auditLogs || []).sort((a, b) => a - b);", // 14
        "memory.auditLogs.length = 0;", // 15
        "delete memory.auditLogs;", // 16
        "['students', 'auditLogs'].forEach(name => { memory[name] = []; });", // 17
        "memory.auditLogs.push({ id: 'x', type: 'class_reset', actorEmail: 'a' });", // 18
        "function f() {",
        "    const logs = db.memory.auditLogs || [];",
        "    logs.pop();", // 21
        "    logs.push({ action: 'x' });", // 22
        "}",
        "const outra = db.memory.loginLogs || [];",
        "outra.pop();",
        "(db.memory.auditLogs || []).forEach(entry => { if (entry.ok) entry.studentEmail = novo; });", // 26
        "memory.auditLogs.filter(item => item.ok).forEach((item, index) => { delete item.ip; });", // 27
        "for (const registro of db.memory.auditLogs) {",
        "    registro.oldValue += '!';", // 29
        "}",
        "const achada = (db.memory.auditLogs || []).find(item => item.id === id);",
        "Object.assign(achada, { reason: 'x' });", // 32
        "const lidas = db.memory.auditLogs.map(entry => ({ ...entry, label: 'x' }));",
        "const copia = { ...lidas[0] }; copia.label = 'y';",
        "db.memory.auditLogs.forEach(entry => { const next = { ...entry }; next.ip = ''; outro.entry.x = 1; });",
        "function g() {",
        "    const trilha = memory.auditLogs;",
        "    trilha.forEach(entry => { entry.at = 0; });", // 38
        "}",
    ].join('\n');
    const { findings } = auditLogFindings(sample);
    assert.deepEqual(findings.map(item => `${item.kind}:${item.line}`).sort(), [
        'alter:11', 'alter:12', 'alter:13', 'alter:14', 'alter:15', 'alter:16', 'alter:17', 'alter:21',
        'alter:26', 'alter:27', 'alter:29', 'alter:32', 'alter:38',
        'append:18', 'append:22',
    ].sort());
    const ranged = 'x();\n    function keep() {\n        a.auditLogs.pop();\n    }\nb.auditLogs.pop();\n';
    const { code, findings: rangedFindings } = auditLogFindings(ranged);
    const rules = { 'f.js': ['keep'] };
    assert.deepEqual(rangedFindings.map(item => allowedAt(rules, 'f.js', code, item.index)), [true, false]);
});

test('[UC-AUDITORIA-001] só acréscimo: nenhum arquivo do backend altera a trilha fora das funções permitidas', () => {
    const violations = [];
    for (const file of backendFiles()) {
        const rel = path.relative(REPO, file).split(path.sep).join('/');
        const source = fs.readFileSync(file, 'utf8');
        if (!source.includes('auditLogs')) continue;
        const { code, findings } = auditLogFindings(source);
        findings.forEach(finding => {
            const rules = finding.kind === 'alter' ? MAY_ALTER : MAY_APPEND;
            if (!allowedAt(rules, rel, code, finding.index)) violations.push(`${rel}:${finding.line} (${finding.kind === 'alter' ? 'altera a trilha' : 'entrada nova sem recordAudit'}): ${finding.text}`);
        });
    }
    assert.deepEqual(violations, [], `Use recordAudit (utils/audit.js) para gravar auditoria; só as funções de MAY_ALTER podem mudar entradas existentes.\n${violations.join('\n')}`);
});

test('[UC-AUDITORIA-001] as funções permitidas continuam existindo onde a lista diz', () => {
    for (const rules of [MAY_ALTER, MAY_APPEND]) {
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

test('[UC-AUDITORIA-001] turma com token de prova: a auditoria guarda a turma sem o token', async () => {
    db.memory.classes[0].onlineExamConfigs = { Avaliacao_A: { status: 'running', token: 'PROVA123', requireToken: true } };
    const updated = await asAdmin(request(app).post('/api/admin/class/update')).send({ name: '1AUD', courseId, period: 'Tarde' });
    assert.equal(updated.status, 200, updated.body.error);
    const entry = db.memory.auditLogs.find(item => item.type === 'class_updated');
    assert.equal(JSON.stringify(entry).includes('PROVA123'), false);
    assert.equal(entry.after.onlineExamConfigs.Avaliacao_A.requireToken, true);
    assert.equal(db.memory.classes[0].onlineExamConfigs.Avaliacao_A.token, 'PROVA123', 'a turma continua com o token');
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
