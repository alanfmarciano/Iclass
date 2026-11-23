// Notas sem critérios de avaliação continuam com a conta de antes (fase 3, B6 / P2-S3;
// D1 do P2: "nenhuma média muda sozinha depois da atualização").
//
// fixtures/igualdade-notas-b6.js monta sempre a mesma memória (provas com várias
// aplicações e tentativas, nota inválida de registro antigo, entrega sem curso, aluno em
// dois cursos, monitor e professor sem e-mail do aluno) e chama o boletim, o quadro (JSON,
// CSV e XLSX), a ficha, a visão geral do Dashboard e o Início do portal do aluno. O
// fixtures/igualdade-notas-b6.json é a saída do código de antes do B6 (d9ca33f, antes de
// extrair studentReport.js e de ligar a conta única). Este teste roda o gerador no código
// de agora e confere que tudo é igual, menos os campos novos do B6, que são conferidos à
// parte com o valor da regra antiga.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '../..');
const GENERATOR = path.join(__dirname, 'fixtures/igualdade-notas-b6.js');
const BEFORE = require('./fixtures/igualdade-notas-b6.json');

// Campos que o boletim ganhou no B6 (gradingFields de studentReport.js) e no B9 (a
// identidade da escola do curso do boletim e o fuso, para o cabeçalho e o rodapé do
// documento impresso; não mudam nota nenhuma).
const REPORT_NEW_FIELDS = ['etapas', 'mediaFinal', 'recuperacaoFinal', 'situacao', 'situacaoRotulo', 'mencao', 'situacaoPorDisciplina', 'avisosNotas', 'identidade', 'fuso'];
// Campos que o quadro ganhou no B6 (buildClassGradebook com o contexto de notas) e no B9
// (resumo: média da turma, aprovação e as notas por prova, aplicação e módulo que
// Resultados mostra sem fazer conta; o resumo é conferido à parte abaixo).
const GRADEBOOK_NEW_FIELDS = ['etapas', 'mencoes', 'avisos', 'resumo'];

let now;
test.before(() => {
    const out = execFileSync(process.execPath, [GENERATOR, ROOT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    now = JSON.parse(out);
});

function without(body, fields) {
    if (!body || typeof body !== 'object') return body;
    const copy = { ...body };
    fields.forEach(field => delete copy[field]);
    return copy;
}

test('[UC-NOTAS-005] sem critérios: boletim, quadro, CSV, XLSX, ficha, Dashboard e portal iguais aos de antes do B6', () => {
    assert.deepEqual(Object.keys(now).sort(), Object.keys(BEFORE).sort());
    for (const key of Object.keys(BEFORE)) {
        const before = BEFORE[key];
        const after = now[key];
        if (key.startsWith('boletim') && after.status === 200) {
            assert.deepEqual({ ...after, body: without(after.body, REPORT_NEW_FIELDS) }, before, key);
        } else if ((key === 'quadro' || key === 'quadroProfessor') && after.status === 200) {
            assert.deepEqual({ ...after, body: without(after.body, GRADEBOOK_NEW_FIELDS) }, before, key);
        } else {
            // CSV e XLSX byte a byte (linhas), ficha, visão geral e portal sem campo novo.
            assert.deepEqual(after, before, key);
        }
    }
});

test('[UC-NOTAS-005] sem critérios: os campos novos do boletim e do quadro vêm com o valor da regra antiga', () => {
    const reports = Object.keys(now).filter(key => key.startsWith('boletim') && now[key].status === 200);
    assert.ok(reports.length >= 5, reports.join(', '));
    reports.forEach(key => {
        const body = now[key].body;
        assert.deepEqual(body.etapas, [], key);
        assert.equal(body.mediaFinal, body.overallAverage, key);
        assert.equal(body.recuperacaoFinal, null, key);
        assert.equal(body.situacao, null, key);
        assert.equal(body.situacaoRotulo, null, key);
        assert.equal(body.mencao, null, key);
        assert.deepEqual(body.situacaoPorDisciplina, [], key);
        assert.deepEqual(body.avisosNotas, [], key);
        assert.deepEqual(body.criterio, { mediaMinima: 6, mencoes: null, regraAntiga: true }, key);
    });
    ['quadro', 'quadroProfessor'].forEach(key => {
        const body = now[key].body;
        assert.deepEqual(body.etapas, [], key);
        assert.equal(body.mencoes, null, key);
        assert.deepEqual(body.avisos, [], key);
        body.rows.forEach(row => assert.ok(!('situacao' in row) && !('mediaFinal' in row), `${key}: linha com campo de critério`));
    });
    // As médias de antes, conferidas pelo número (o fixture as guarda).
    assert.equal(now.boletim_ana.body.overallAverage, BEFORE.boletim_ana.body.overallAverage);
    assert.ok(now.boletim_ana.body.overallAverage !== null);
});
