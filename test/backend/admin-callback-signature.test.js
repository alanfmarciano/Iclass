// Guarda contra a volta do SEG-05 (fase 2, H5c). O callback de validateAdmin e de
// validateAdminPermission recebe (config, conta). As rotas de aprovar e recusar matrícula
// tinham validateAdmin(req, res, async matchedAdmin => ...): a variável recebia a
// configuração, isProfessorAccount nunca era verdadeiro (o professor aprovava matrícula
// em turma fora do escopo dele) e o registro gravava 'admin' em vez do e-mail de quem
// aprovou. A fase 1 corrigiu as duas rotas; esta varredura impede que uma rota nova nasça
// com a mesma assinatura (um parâmetro só, que não é a configuração, ou a conta no lugar
// da configuração).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const backendDir = path.join(root, 'backend');

// Nome aceito para o primeiro parâmetro: a configuração (o segundo é a conta).
const CONFIG_PARAMS = new Set(['config', 'cfg', '_config', '_cfg', '_']);

function backendFiles(directory = backendDir) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : backendFiles(fullPath);
        return entry.name.endsWith('.js') ? [fullPath] : [];
    });
}

const ARG = String.raw`[\w$.]+`;
const PERMISSION_ARG = String.raw`(?:'[^']*'|"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[\w$.]+)`;
const CALL_PREFIX = new RegExp(String.raw`\bvalidateAdmin(Permission)?\s*\(`, 'g');
const ADMIN_ARGS = new RegExp(String.raw`^\s*${ARG}\s*,\s*${ARG}\s*,\s*`);
const PERMISSION_ARGS = new RegExp(String.raw`^\s*${ARG}\s*,\s*${ARG}\s*,\s*${PERMISSION_ARG}\s*,\s*`);
const INLINE_CALLBACK = /^(?:async\s+)?(?:function\s*[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|([\w$]+)\s*=>)/;
const REFERENCE_CALLBACK = /^[\w$.]+\s*\)/;

// Cada chamada de validateAdmin/validateAdminPermission no texto: o callback em linha com
// a lista de parâmetros, ou a referência a uma função (callback, next...), que não dá para
// conferir aqui. Chamada que não se consegue ler entra em `unparsed`, para a varredura
// não passar calada com um jeito novo de escrever a chamada.
// Comentários saem antes da varredura (um comentário que cita "validateAdmin (...)" não é
// chamada), mantendo as quebras de linha para o número da linha continuar certo.
function withoutComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
        .split('\n')
        .map(line => (/^\s*\/\//.test(line) ? '' : line.replace(/\s\/\/\s.*$/, '')))
        .join('\n');
}

function inspectSource(rawSource, file = '<texto>') {
    const source = withoutComments(rawSource);
    const calls = [];
    const unparsed = [];
    let match;
    CALL_PREFIX.lastIndex = 0;
    while ((match = CALL_PREFIX.exec(source))) {
        const line = source.slice(0, match.index).split('\n').length;
        const where = `${path.relative(root, file) || file}:${line}`;
        const rest = source.slice(match.index + match[0].length);
        const args = (match[1] ? PERMISSION_ARGS : ADMIN_ARGS).exec(rest);
        if (!args) { unparsed.push(where); continue; }
        const callbackText = rest.slice(args[0].length);
        const inline = INLINE_CALLBACK.exec(callbackText);
        if (inline) {
            const list = inline[1] !== undefined ? inline[1] : inline[2] !== undefined ? inline[2] : inline[3];
            const params = list.split(',').map(param => param.trim().replace(/\s*=.*$/, '')).filter(Boolean);
            calls.push({ where, params, inline: true });
        } else if (REFERENCE_CALLBACK.test(callbackText)) {
            calls.push({ where, params: null, inline: false });
        } else {
            unparsed.push(where);
        }
    }
    return { calls, unparsed };
}

function wrongSignatures(calls) {
    return calls.filter(call => call.inline && call.params.length > 0 && !CONFIG_PARAMS.has(call.params[0]))
        .map(call => `${call.where}: (${call.params.join(', ')})`);
}

test('[UC-ADMIN-001] callbacks de validateAdmin e validateAdminPermission recebem (config, conta), nunca a conta no lugar da configuração (SEG-05)', () => {
    const calls = [];
    const unparsed = [];
    for (const file of backendFiles()) {
        const result = inspectSource(fs.readFileSync(file, 'utf8'), file);
        calls.push(...result.calls);
        unparsed.push(...result.unparsed);
    }
    assert.ok(calls.filter(call => call.inline).length >= 150, `a varredura achou só ${calls.length} chamadas (o jeito de escrever mudou?)`);
    assert.deepEqual(unparsed, [], 'Chamadas que a varredura não conseguiu ler: escreva como validateAdmin(req, res, (config, conta) => ...)');
    assert.deepEqual(wrongSignatures(calls), [], 'Callback com a conta no primeiro parâmetro: o primeiro é a configuração');
});

test('[UC-ADMIN-001] a varredura do SEG-05 acusa a assinatura antiga das rotas de matrícula e aceita as certas', () => {
    const bad = inspectSource([
        "router.post('/api/admin/enrollment-requests/:id/approve', (req, res) => {",
        '    validateAdmin(req, res, async matchedAdmin => {',
        '    validateAdmin(req, res, (admin) => {',
        "    validateAdminPermission(req, res, 'page.students', function (account) {",
        "    validateAdminPermission(req, res, ['page.monitor', 'page.exams'], async (matchedAdmin, config) => {",
        '    // validateAdmin (comentário) não conta',
    ].join('\n'));
    assert.deepEqual(bad.unparsed, []);
    assert.equal(wrongSignatures(bad.calls).length, 4);

    const good = inspectSource([
        '    validateAdmin(req, res, (config, matchedAdmin) => {',
        '    validateAdmin(req, res, async (config, currentAdmin) => {',
        '    validateAdmin(req, res, () => {',
        '    validateAdmin(req, res, config => {',
        "    validateAdminPermission(req, res, 'course.manage', (cfg, account) => {",
        '    return validateAdmin(req, res, callback);',
        'function validateAdmin(req, res, callback) {',
        '    validateAdmin(req,',
        '        res,',
        '        async (config, matchedAdmin) => {',
    ].join('\n'));
    assert.deepEqual(good.unparsed, []);
    assert.equal(good.calls.length, 8);
    assert.deepEqual(wrongSignatures(good.calls), []);
});
