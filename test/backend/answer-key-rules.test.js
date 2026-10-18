// Gabarito do professor na apostila (B-gabarito): regras fixas de
// stripAnswerKeyBlocks/stripTeacherHeadingSections, numa tabela de casos que saem e que
// ficam. Inclui os casos das revisões anteriores (sobras do G6 e decisões do G6).
//
// Regra para o professor: o gabarito dele fica sob um título ou bloco "Gabarito do
// professor". Palavra do gabarito: "gabarito" (ou "chave de respostas"); marca do
// professor: professor(a), prof., instrutor(a), docente, exclusivo(a); "oficial" sozinho
// só vale no <summary> de <details>. Sai:
// 1. <details> cujo <summary> tem gabarito + marca (ou "gabarito oficial"), inteiro;
// 2. título Markdown ou HTML (h1-h6, também em citação) com gabarito + marca, até o
//    próximo título de nível igual ou maior;
// 3. parágrafo que é só o rótulo em negrito com gabarito + marca (o rótulo é o texto em
//    negrito até o primeiro ":"): vale como título, abaixo de todos os outros;
// 4. parágrafo que começa com esse rótulo e traz texto na mesma linha: só o parágrafo.
// Nada mais sai, e nenhuma tag de contêiner fica aberta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-answer-key-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { stripAnswerKeyBlocks } = require('../../backend/utils/contentAccess.js');

test.before(async () => { await db.init(); });
test.after(async () => {
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const L = (...lines) => lines.join('\n');
const SAME = Symbol('fica igual');

// [regra, caso, entrada, saída esperada (SAME = o texto não muda)]
const CASES = [
    // ---- Regra 1: <details> do professor sai inteiro.
    ['1 sai', 'summary "GABARITO&nbsp;OFICIAL" (entidade HTML)', L('<details><summary>GABARITO&nbsp;OFICIAL</summary>', '', '1. B', '</details>', '', 'Texto'), L('', '', 'Texto')],
    ['1 sai', 'summary "Gabarito do prof."', L('Antes', '<details><summary>Gabarito do prof.</summary>B</details>', 'Depois'), L('Antes', '', 'Depois')],
    ['1 sai', '<details> aninhado: o bloco inteiro', L('<details>', '<summary><b>GABARITO EXCLUSIVO DO PROFESSOR</b></summary>', '<details><summary>Questão 1</summary>B</details>', 'resto do gabarito', '</details>', 'Texto'), L('', 'Texto')],
    ['1 sai', '<summary> depois de texto', L('<details>', 'Abra só na correção: <summary>Gabarito oficial</summary>B', '</details>', 'Texto'), L('', 'Texto')],
    ['1 fica', '<summary>Resposta do professor</summary> (sem a palavra gabarito)', '<details><summary>Resposta do professor</summary>Explicação</details>', SAME],
    ['1 fica', '<summary>Gabarito dos exercícios</summary> (autocorreção do aluno)', '<details><summary>Gabarito dos exercícios</summary>1. A</details>', SAME],
    ['1 fica', '<summary>Ver Resposta</summary>', '<details><summary>👀 Ver Resposta</summary>42</details>', SAME],
    ['1 fica', '<summary>GABARITO</summary> sem marca do professor', '<details><summary><b>GABARITO</b></summary>1. C</details>', SAME],

    // ---- Regra 2: título com gabarito + marca, até o próximo título de nível igual ou maior.
    ['2 sai', '"## GABARITO EXCLUSIVO DO PROFESSOR" até o próximo ##', L('## GABARITO EXCLUSIVO DO PROFESSOR', '1. B', '### Questão 2', 'C', '## Próxima seção', 'Texto'), L('## Próxima seção', 'Texto')],
    ['2 sai', '"<h2>GABARITO DO PROFESSOR</h2>" até o próximo <h2>', L('<h2>GABARITO DO PROFESSOR</h2>', '1. B', '<h3>Questão 1</h3>', 'C', '<h2>Leitura complementar</h2>', 'Texto'), L('<h2>Leitura complementar</h2>', 'Texto')],
    ['2 sai', '"> ## GABARITO DO PROFESSOR": até o fim da citação', L('> ## GABARITO DO PROFESSOR', '> 1. B', '> 2. C', '', 'Texto depois da citação'), 'Texto depois da citação'],
    ['2 sai', 'título sublinhado (===)', L('# Unidade', 'GABARITO DO PROFESSOR', '=====================', '1. B', '# Próximo capítulo', 'Texto'), L('# Unidade', '# Próximo capítulo', 'Texto')],
    ['2 sai', '"## Chave de respostas (professor)"', L('## Chave de respostas (professor)', 'B', '## Resolução do exercício', 'Texto'), L('## Resolução do exercício', 'Texto')],
    ['2 sai', '<h2> no meio da linha, dentro de <div>: o </div> fica', L('Intro', '', '<div class="box"><h2>GABARITO DO PROFESSOR</h2><p>1. B</p></div>', '', '## Próximo', 'Texto'), L('Intro', '', '<div class="box">', '</div>', '', '## Próximo', 'Texto')],
    ['2 sai', '<h2> quebrado em várias linhas', L('<h2 class="gab">', '  GABARITO DO PROFESSOR', '</h2>', '<p>1. D</p>', '', '## Anexo', 'Texto'), L('## Anexo', 'Texto')],
    ['2 sai', '<h3> dentro de <section>: acaba no </section>', L('<section><h3>Gabarito do professor</h3><ol><li>B</li></ol></section>', '<section><h3>Atividade</h3><p>Texto</p></section>'), L('<section>', '</section>', '', '<section>', '<h3>Atividade</h3>', '<p>Texto</p></section>')],
    ['2 sai', 'acaba no título seguinte de mesmo nível', L('## Gabarito do professor', '## Questão 1', 'Texto'), L('## Questão 1', 'Texto')],
    ['2 sai', 'arquivo com CRLF', ['# U', '', '## GABARITO DO PROFESSOR', '', '1. B', '', '## Próximo', '', 'Texto'].join('\r\n'), ['# U', '', '## Próximo', '', 'Texto'].join('\r\n')],
    ['2 fica', 'título dentro de bloco de código', L('```', '## GABARITO DO PROFESSOR', '```', 'Texto'), SAME],
    ['2 sai', 'bloco de código sem fechamento na citação acaba com a citação', L('> ## Gabarito do professor', '> ```', '> 1. B', '', '## Próximo', 'Texto'), L('## Próximo', 'Texto')],
    ['2 fica', 'título em bloco de código com 4 espaços', L('Exemplo:', '', '    ## GABARITO DO PROFESSOR', '', 'Texto'), SAME],
    ['2 fica', '"## Perguntas e respostas com o professor"', L('## Perguntas e respostas com o professor', 'Texto'), SAME],
    ['2 fica', '"## Solução proposta pelo instrutor"', L('## Solução proposta pelo instrutor', 'Texto'), SAME],
    ['2 fica', '"### Resposta do professor à dúvida da turma"', L('### Resposta do professor à dúvida da turma', 'Texto'), SAME],
    ['2 fica', '"## Gabarito dos exercícios"', L('## Gabarito dos exercícios', 'Texto'), SAME],
    ['2 fica', '"## GABARITO" sem marca', L('## GABARITO', '1. B'), SAME],
    ['2 fica', '"## Gabarito oficial" ("oficial" só vale no <summary>)', L('## Gabarito oficial', '1. B'), SAME],
    ['2 fica', '"Gabarito oficial" sublinhado', L('Gabarito oficial', '----------------', '1. B'), SAME],

    // ---- Regra 3: parágrafo só com o rótulo em negrito vale como título (até o próximo título).
    ['3 sai', '"**GABARITO DO PROFESSOR**" em parágrafo', L('**GABARITO DO PROFESSOR**', '', '1. B', '', '**Questão 2**', 'C', '', '## Exercícios', 'Texto'), L('## Exercícios', 'Texto')],
    ['3 sai', '"<p><strong>Gabarito do professor</strong></p>"', L('<p><strong>Gabarito do professor</strong></p>', '<ol><li>B</li></ol>', '<h2>Fim</h2>', 'Texto'), L('<h2>Fim</h2>', 'Texto')],
    ['3 sai', 'rótulo com dois-pontos e lista embaixo', L('**Gabarito do professor:**', '- B', '- C', '', 'Texto', '', '## Próximo', 'Texto 2'), L('## Próximo', 'Texto 2')],
    ['3 sai', '"**🔒 Gabarito do prof.**"', L('**🔒 Gabarito do prof.**', '', '1. B', '', '## Fim', 'Texto'), L('## Fim', 'Texto')],
    ['3 sai', 'rótulo dentro de citação: até o fim da citação', L('> **GABARITO DO PROFESSOR**', '>', '> 1. B', '', 'Texto'), 'Texto'],
    ['3 sai', 'rótulo dentro de item de lista: até o fim do item', L('1. Questão sobre ls', '    **Gabarito do professor:**', '    - B', '2. Questão seguinte'), L('1. Questão sobre ls', '2. Questão seguinte')],
    ['3 sai', '"---" não encerra (não é título)', L('**Gabarito do professor**', '', '1. B', '', '---', '', 'Texto', '', '## Fim', 'Texto 2'), L('## Fim', 'Texto 2')],
    ['3 sai', 'outro negrito não encerra (não é título)', L('**Gabarito do professor**', '', '1. A', '', '**Exercício extra**', '', 'Texto', '', '## Fim'), '## Fim'],
    ['3 sai', 'qualquer título encerra, até ###', L('**Gabarito do professor**', '', '1. A', '', '### Questão 1', 'Texto'), L('### Questão 1', 'Texto')],
    ['3 sai', '"**Gabarito oficial disponível com o professor**" (gabarito + marca, sem ":")', L('**Gabarito oficial disponível com o professor**', '', '1. Exercício para casa', '', '## Fim'), '## Fim'],
    ['3 sai', 'frase inteira em negrito com gabarito + marca, sem ":", conta como rótulo', L('**O gabarito será entregue pelo professor**', '', 'Texto', '', '## Fim'), '## Fim'],
    ['3 sai', '"**Respostas do gabarito (professor)**"', L('**Respostas do gabarito (professor)**', 'B', '## Fim'), '## Fim'],
    ['3 sai', 'rótulo dentro de <div>: acaba no </div>', L('<div class="aula">', '', '**Gabarito do professor**', '', '1. B', '', '</div>', '', 'Texto'), L('<div class="aula">', '', '</div>', '', 'Texto')],
    ['3 fica', 'aviso em negrito: o rótulo antes do ":" é "Atenção"', L('**Atenção: o gabarito oficial será divulgado pelo professor após a prova.**', '', 'Texto'), SAME],
    ['3 fica', '"**Gabarito oficial: será divulgado após a prova**" (rótulo sem marca)', L('**Gabarito oficial: será divulgado após a prova**', '', 'Texto'), SAME],
    ['3 fica', '"**Gabarito comentado**" sem marca', L('**Gabarito comentado**', '', 'Texto'), SAME],
    ['3 fica', '"<strong>Gabarito oficial</strong>" ("oficial" não é marca)', L('<p><strong>Gabarito oficial</strong></p>', '<ol><li>B</li></ol>'), SAME],
    ['3 fica', 'rótulo em itálico (não é negrito)', L('*Gabarito do professor*', '', '1. A'), SAME],
    ['3 fica', 'rótulo sem negrito', L('GABARITO DO PROFESSOR', '', '1. E'), SAME],

    // ---- Regra 4: rótulo com texto na mesma linha: só esse parágrafo (até a linha em branco).
    ['4 sai', '"**GABARITO DO PROFESSOR:** 1-B, 2-C"', L('**GABARITO DO PROFESSOR:** 1-B (ls -la), 2-C', '', 'Texto'), L('', 'Texto')],
    ['4 sai', 'respostas na linha seguinte do mesmo parágrafo', L('**Gabarito do professor**: 1-B', '3-D', '', 'Texto'), L('', 'Texto')],
    ['4 sai', '"<strong>GABARITO DO PROFESSOR</strong><br>1. B"', L('<strong>GABARITO DO PROFESSOR</strong><br>1. B', '', 'Texto'), L('', 'Texto')],
    ['4 sai', 'dentro de item de lista: só a linha do item', L('1. Questão sobre o comando ls', '   **Gabarito do professor:** B', '2. Questão seguinte'), L('1. Questão sobre o comando ls', '2. Questão seguinte')],
    ['4 sai', 'em citação, linha de continuação sem ">" faz parte do parágrafo', L('> **Gabarito do professor:** 1-B', '2-C', '', 'Texto'), L('', 'Texto')],
    ['4 sai', 'sublinhado colado no parágrafo do rótulo faz parte dele', L('**Gabarito do professor:** 1-B', '2-C', '---', '', 'Texto'), L('', 'Texto')],
    ['4 sai', 'lista colada no rótulo faz parte do parágrafo', L('**Gabarito do professor:** respostas abaixo', '- B', '- C', '', 'Texto'), L('', 'Texto')],
    ['4 sai', '"**Gabarito do professor: consulte o mural.**": só o parágrafo', L('**Gabarito do professor: consulte o mural da coordenação.**', '', 'Texto'), L('', 'Texto')],
    ['4 sai', 'item de lista com o rótulo: o item seguinte fica', L('- **Gabarito do professor:** 1-B', '- **Prova**: avaliação'), '- **Prova**: avaliação'],
    ['4 fica', '"**Atenção:** o gabarito oficial será divulgado pelo professor."', L('**Atenção:** o gabarito oficial será divulgado pelo professor.', '', 'Texto'), SAME],
    ['4 fica', 'glossário: "**Gabarito oficial**: documento..."', L('**Gabarito oficial**: documento com as respostas corretas usado pelo professor na correção.', '', 'Texto'), SAME],
    ['4 fica', 'glossário em lista: "- **Gabarito**: ..."', L('- **Gabarito**: documento oficial com as respostas', '- **Prova**: avaliação'), SAME],
    ['4 fica', 'rótulo sem negrito com as respostas', L('Gabarito do professor: 1-B, 2-C', '', 'Texto'), SAME],
    ['4 fica', 'frase que cita o gabarito', L('O professor vai publicar o gabarito oficial amanhã.', '', 'Texto'), SAME],
    ['4 fica', 'tabela com coluna "Gabarito do professor"', L('| Questão | Gabarito do professor |', '|---|---|', '| 1 | B |'), SAME],
    ['fica', 'negrito comum no meio do texto', 'Texto com **negrito** e **outro**', SAME],
];

const CONTAINERS = ['div', 'section', 'details', 'ol', 'ul', 'table', 'blockquote'];
function containerBalance(text) {
    return CONTAINERS.map(name => {
        const opened = (text.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || []).length;
        const closed = (text.match(new RegExp(`</${name}\\s*>`, 'gi')) || []).length;
        return `${name}:${opened - closed}`;
    }).join(' ');
}

test('[UC-SIGILO-001] gabarito do professor na apostila: tabela de casos que saem e que ficam (regras fixas)', () => {
    for (const [rule, name, input, expected] of CASES) {
        const label = `regra ${rule} · ${name}`;
        const output = stripAnswerKeyBlocks(input);
        assert.equal(output, expected === SAME ? input : expected, label);
        assert.equal(stripAnswerKeyBlocks(output), output, `${label}: idempotente`);
        assert.equal(containerBalance(output), containerBalance(input), `${label}: nenhuma tag de contêiner fica aberta`);
    }
});

test('[UC-SIGILO-001] a tabela cobre as quatro regras, com casos que saem e que ficam', () => {
    const kinds = new Set(CASES.map(([rule]) => rule));
    for (const kind of ['1 sai', '1 fica', '2 sai', '2 fica', '3 sai', '3 fica', '4 sai', '4 fica']) assert.ok(kinds.has(kind), kind);
    // Casos citados nas revisões anteriores (sobras do G6).
    const inputs = CASES.map(([, , input]) => input).join('\n');
    for (const cited of ['## Perguntas e respostas com o professor', '## Solução proposta pelo instrutor', '### Resposta do professor à dúvida da turma', '<summary>Resposta do professor</summary>', '**GABARITO DO PROFESSOR**', '<h2>GABARITO DO PROFESSOR</h2>', '> ## GABARITO DO PROFESSOR', 'GABARITO&nbsp;OFICIAL', 'Gabarito do prof.', '## GABARITO EXCLUSIVO DO PROFESSOR', 'Gabarito dos exercícios', 'Ver Resposta']) {
        assert.ok(inputs.includes(cited), `falta o caso ${cited}`);
    }
});
