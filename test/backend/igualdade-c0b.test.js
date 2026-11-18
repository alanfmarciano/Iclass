// Teste de igualdade da fundação C0b (fase 3; K13, K14 e X8 do plano): o sino e o
// calendário do aluno, a fila "Precisa de você" e o sino do instrutor, Meus dados (aluno
// e administrador), Cadastros encerrados, a troca de e-mail, o anonimizar e o apagar de
// vez continuam dando a saída de hoje depois que passaram a percorrer os provedores
// (utils/studentFeeds.js) e os handlers (utils/studentDataHandlers.js).
//
// fixtures/igualdade-c0b.json é a saída do código de antes do C0b (222dcae), gerada por
// fixtures/igualdade-c0b.js numa cópia daquele código (git archive 222dcae). O teste
// roda o mesmo gerador no código de agora, sem nada registrado e com provedores e
// handlers que não acrescentam nada, e compara.
//
// Diferença de propósito: a subetapa que muda a saída de hoje acrescenta o caminho em
// DIFERENCAS_ESPERADAS, com o motivo ('*' vale um nível; '**' no fim vale o resto). O
// B16 marca aqui a do certificado no 'apagar de vez' (X8: o registro fica, sem dado
// pessoal).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '../..');
const GENERATOR = path.join(__dirname, 'fixtures/igualdade-c0b.js');
const BEFORE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/igualdade-c0b.json'), 'utf8'));

// { caminho, motivo }
const DIFERENCAS_ESPERADAS = [];

function run(env = {}) {
    const result = spawnSync(process.execPath, [GENERATOR, ROOT], {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...env },
    });
    assert.equal(result.status, 0, `o gerador falhou:\n${result.stderr}`);
    return { output: JSON.parse(result.stdout), stderr: result.stderr };
}

// Caminhos ('a.b.0.c') onde as duas saídas diferem.
function differences(before, after, base = '', out = []) {
    const isObject = value => value && typeof value === 'object';
    if (!isObject(before) || !isObject(after) || Array.isArray(before) !== Array.isArray(after)) {
        if (!Object.is(before, after)) out.push(base || '(raiz)');
        return out;
    }
    const keys = Array.isArray(before)
        ? Array.from({ length: Math.max(before.length, after.length) }, (_, index) => String(index))
        : [...new Set([...Object.keys(before), ...Object.keys(after)])];
    keys.forEach(key => {
        const next = base ? `${base}.${key}` : key;
        if (!(key in before) || !(key in after)) out.push(next);
        else differences(before[key], after[key], next, out);
    });
    // Ordem das chaves também é saída (o JSON baixado em Meus dados, a resposta da API).
    if (!Array.isArray(before) && Object.keys(before).join('|') !== Object.keys(after).join('|')
        && Object.keys(before).length === Object.keys(after).length) out.push(`${base || '(raiz)'}:ordem`);
    return out;
}

function expected(pathText) {
    return DIFERENCAS_ESPERADAS.some(({ caminho }) => {
        const pattern = caminho.split('.');
        const parts = pathText.split('.');
        for (let i = 0; i < pattern.length; i++) {
            if (pattern[i] === '**') return true;
            if (i >= parts.length || (pattern[i] !== '*' && pattern[i] !== parts[i])) return false;
        }
        return pattern.length === parts.length;
    });
}

test('[UC-FUNDACAO-002] sem provedor nem handler, a saída é a de antes do C0b', () => {
    const { output } = run();
    const found = differences(BEFORE, output).filter(item => !expected(item));
    assert.deepEqual(found, [], 'saída diferente da de antes');
});

test('[UC-FUNDACAO-002] com provedores e handlers que não acrescentam nada, a saída continua a de antes e os handlers são chamados', () => {
    const { output, stderr } = run({ ICLASS_IGUALDADE_COM_REGISTROS: '1' });
    const found = differences(BEFORE, output).filter(item => !expected(item));
    assert.deepEqual(found, [], 'saída diferente da de antes');
    const line = stderr.split('\n').find(item => item.startsWith('chamadas dos handlers: '));
    assert.ok(line, stderr);
    const calls = JSON.parse(line.slice('chamadas dos handlers: '.length));
    assert.deepEqual(calls.map(call => call[0]), ['rename', 'anonymize', 'purge']);
    assert.deepEqual(calls[0], ['rename', 'duda@igualdade.local', 'duda.nova@igualdade.local']);
    assert.equal(calls[1][1], 'bia@igualdade.local');
    assert.match(calls[1][2], /^anonimizado-[0-9a-f]{12}@anonimizado\.invalid$/);
    assert.deepEqual(calls[2], ['purge', 'caio@igualdade.local']);
});

test('o comparador acha diferença de valor, de chave e de ordem (não ficou cego)', () => {
    assert.deepEqual(differences({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), []);
    assert.deepEqual(differences({ a: 1, b: [1, 2] }, { a: 2, b: [1] }), ['a', 'b.1']);
    assert.deepEqual(differences({ a: 1 }, { a: 1, c: 1 }), ['c']);
    assert.deepEqual(differences({ a: 1, b: 2 }, { b: 2, a: 1 }), ['(raiz):ordem']);
    // A cópia de antes tem o que o teste precisa olhar (não é um arquivo vazio).
    ['sinoAluno', 'calendarioAluno', 'fila', 'sinoInstrutor', 'meusDadosAluno', 'meusDadosAdmin', 'encerrados', 'trocaEmail', 'anonimizar', 'apagar', 'memoriaDepoisDeApagar']
        .forEach(key => assert.ok(BEFORE[key], key));
    assert.ok(BEFORE.sinoAluno.body.items.length >= 4);
    assert.ok(BEFORE.fila.length >= 4);
    assert.equal(BEFORE.anonimizar.status, 200);
    assert.equal(BEFORE.apagar.status, 200);
    assert.equal(BEFORE.trocaEmail.status, 200);
});
