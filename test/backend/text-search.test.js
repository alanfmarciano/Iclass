// Busca e ordem de texto sem acento (fase 3, C0a; CRIT-07, D23 do P5). Uma regra só nos
// dois lados: backend/utils/textSearch.js no servidor e web/src/lib/textSearch.js na
// tela. O mesmo quadro de casos roda nos dois, e o teste confere que dão o mesmo
// resultado (a tela é ESM e entra por import(), sem require de ESM).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const server = require('../../backend/utils/textSearch.js');
const { isClosedStudentStatus, isAnonymizedStudent } = require('../../backend/utils/students.js');

const WEB_TEXT_SEARCH = pathToFileURL(path.join(__dirname, '..', '..', 'web', 'src', 'lib', 'textSearch.js')).href;

const NORMALIZE_CASES = [
    ['João', 'joao'],
    ['AÇÃO', 'acao'],
    ['  Maria   da\tSilva\n', 'maria da silva'],
    ['Ângela', 'angela'],
    [null, ''],
    [undefined, ''],
    [0, '0'],
    [12.5, '12.5'],
    [NaN, ''],
    [['Redes', 'Lógica'], 'redes logica'],
    [{ nome: 'x' }, ''],
    [true, ''],
];

const MATCH_CASES = [
    [['João da Silva'], 'joao', true],
    [['JOÃO'], 'João', true],
    [['Ação educativa'], 'acao', true],
    [['Ana Souza', 'ana@escola.local'], 'souza escola', true],
    [['Ana Souza', '1DES'], 'ana 1des', true],
    [['Ana Souza'], 'ana 1des', false],
    [[null, undefined], 'und', false],
    [[undefined], 'null', false],
    [['qualquer'], '', true],
    [['qualquer'], '   ', true],
    [[], 'x', false],
    ['Programação Web', 'programacao   web', true],
    [[['redes', 'hardware']], 'hard', true],
];

const SORT_INPUT = ['Zélia', 'Bruno', 'ana', 'Érica', 'Ângela', 'Carlos'];
const SORT_EXPECTED = ['ana', 'Ângela', 'Bruno', 'Carlos', 'Érica', 'Zélia'];
const NUMERIC_INPUT = ['Turma 10', 'Turma 2', 'Turma 1'];
const NUMERIC_EXPECTED = ['Turma 1', 'Turma 2', 'Turma 10'];

function checkImplementation(impl, label) {
    for (const [value, expected] of NORMALIZE_CASES) {
        assert.equal(impl.normalizeSearch(value), expected, `${label}: normalizeSearch(${JSON.stringify(value)})`);
    }
    for (const [values, term, expected] of MATCH_CASES) {
        assert.equal(impl.matchesSearch(values, term), expected, `${label}: matchesSearch(${JSON.stringify(values)}, ${JSON.stringify(term)})`);
    }
    assert.deepEqual([...SORT_INPUT].sort(impl.compareText), SORT_EXPECTED, `${label}: ordem pt-BR`);
    assert.deepEqual([...NUMERIC_INPUT].sort(impl.compareText), NUMERIC_EXPECTED, `${label}: números em ordem natural`);
    assert.equal(impl.compareText('ana', 'ANA'), 0, `${label}: maiúscula não muda a ordem`);
    assert.equal(impl.compareText(null, undefined), 0, `${label}: ausente é texto vazio`);
    assert.ok(impl.compareText(null, 'a') < 0, `${label}: ausente vem antes de texto`);
    assert.deepEqual(['2026-11-10T09:00', '2026-11-02T10:00', '2026-11-10T08:00'].sort(impl.compareOrdinal),
        ['2026-11-02T10:00', '2026-11-10T08:00', '2026-11-10T09:00'], `${label}: compareOrdinal em data ISO`);
    assert.equal(impl.compareOrdinal(undefined, ''), 0, `${label}: compareOrdinal com ausente`);
}

test('[UC-BUSCA-001] servidor: "joao" acha "João", null não vira "null" e a ordem é a do português', () => {
    checkImplementation(server, 'servidor');
    // O que a regra antiga fazia (para o quadro não ficar sem sentido): a ordem por código
    // Unicode punha as minúsculas e os acentos no fim.
    assert.deepEqual([...SORT_INPUT].sort((a, b) => (a > b ? 1 : -1)), ['Bruno', 'Carlos', 'Zélia', 'ana', 'Ângela', 'Érica']);
    assert.equal(String(undefined).toLowerCase().includes('und'), true);
});

test('[UC-BUSCA-001] tela e servidor dão o mesmo resultado no mesmo quadro', async () => {
    const web = await import(WEB_TEXT_SEARCH);
    checkImplementation(web, 'tela');
    for (const [value] of NORMALIZE_CASES) assert.equal(web.normalizeSearch(value), server.normalizeSearch(value));
    for (const [values, term] of MATCH_CASES) assert.equal(web.matchesSearch(values, term), server.matchesSearch(values, term));
    const names = ['Érica', 'erica', 'Eduardo', 'Élcio', 'Turma 10', 'Turma 9', 'ção', 'cao', 'Çarlos', 'zz', 'Ana Paula', 'Ana'];
    assert.deepEqual([...names].sort(web.compareText), [...names].sort(server.compareText));
});

test('[UC-BUSCA-001] situação do aluno pela mesma normalização (students.js usa textSearch)', () => {
    for (const status of ['Concluído', 'concluido', ' CONCLUIDO ', 'Inativo', 'evadido', 'Transferido', 'Anonimizado']) {
        assert.equal(isClosedStudentStatus(status), true, status);
    }
    for (const status of ['Ativo', 'Bloqueado', '', null, undefined]) assert.equal(isClosedStudentStatus(status), false, String(status));
    assert.equal(isAnonymizedStudent({ status: 'anonimizado' }), true);
    assert.equal(isAnonymizedStudent({ status: 'Ativo' }), false);
});
