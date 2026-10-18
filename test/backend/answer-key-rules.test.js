// Gabarito do professor na apostila (B-gabarito, ajuste 2): regras fixas de
// stripAnswerKeyBlocks (backend/utils/answerKey.js), numa tabela de casos que saem e que
// ficam. Inclui os casos das revisões anteriores (sobras do G6, decisões do G6, rodada de
// caefc43) e os 9 achados da revisão "gabarito" da rodada 1, com as entradas exatas.
//
// Regra para o professor: o gabarito dele fica sob um título "## Gabarito do professor"
// (ou num <details> com esse resumo); um rótulo em negrito sozinho protege até o fim da
// seção em que está. Palavra do gabarito: "gabarito" (ou "chave de respostas/correção");
// marca do professor: professor(a), prof., profs., instrutor(a), docente, exclusivo(a);
// "oficial" sozinho só vale no <summary> de <details>.
//
// O texto é dividido em blocos numa varredura linear (cercas, <pre>, comentários,
// títulos, itens de lista, citações, blocos HTML e parágrafos, que acabam na linha em
// branco ou quando a linha seguinte abre outro bloco). Sobre os blocos:
// - código (cercado, com recuo, inline, <pre>) nunca é casado nem cortado;
// - todo comentário HTML sai;
// 1. <details> cujo <summary> tem gabarito + marca (ou "gabarito oficial"): sai inteiro;
// 2. título Markdown ou HTML (h1-h6, também em citação ou item de lista) com gabarito +
//    marca: até o próximo título de nível igual ou menor;
// 3. rótulo em negrito com gabarito + marca sozinho no bloco (também com emoji ou "- "
//    antes, e em <p>, <li>, <div>): vale como título, até o próximo título de nível igual
//    ou menor que o do título da seção onde está (sem título acima, até o próximo de
//    nível 1 ou 2, ou o fim);
// 4. rótulo + respostas (na mesma linha ou nas linhas seguintes do mesmo bloco): só esse
//    bloco.
// A remoção nunca atravessa o fechamento de um contêiner aberto antes dela (o fechamento
// fica), e o contêiner aberto dentro dela sai com o fechamento. Nada mais sai.
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
const { tokenize } = require('../../backend/utils/answerKey.js');

test.before(async () => { await db.init(); });
test.after(async () => {
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

const L = (...lines) => lines.join('\n');
const SAME = Symbol('fica igual');

// [regra, caso, entrada, saída esperada (SAME = o texto não muda)]
const CASES = [
    // ---- Casos das revisões anteriores (sobras do G6, decisões do G6 e rodada de caefc43).
    ['1 sai', 'summary "GABARITO&nbsp;OFICIAL" (entidade HTML)', L('<details><summary>GABARITO&nbsp;OFICIAL</summary>', '', '1. B', '</details>', '', 'Texto'), L('', 'Texto')],
    ['1 sai', 'summary "Gabarito do prof."', L('Antes', '<details><summary>Gabarito do prof.</summary>B</details>', 'Depois'), L('Antes', 'Depois')],
    ['1 sai', '<details> aninhado: o bloco inteiro', L('<details>', '<summary><b>GABARITO EXCLUSIVO DO PROFESSOR</b></summary>', '<details><summary>Questão 1</summary>B</details>', 'resto do gabarito', '</details>', 'Texto'), 'Texto'],
    ['1 sai', '<summary> depois de texto', L('<details>', 'Abra só na correção: <summary>Gabarito oficial</summary>B', '</details>', 'Texto'), 'Texto'],
    ['1 fica', '<summary>Resposta do professor</summary> (sem a palavra gabarito)', '<details><summary>Resposta do professor</summary>Explicação</details>', SAME],
    ['1 fica', '<summary>Gabarito dos exercícios</summary> (autocorreção do aluno)', '<details><summary>Gabarito dos exercícios</summary>1. A</details>', SAME],
    ['1 fica', '<summary>Ver Resposta</summary>', '<details><summary>👀 Ver Resposta</summary>42</details>', SAME],
    ['1 fica', '<summary>GABARITO</summary> sem marca do professor', '<details><summary><b>GABARITO</b></summary>1. C</details>', SAME],
    ['2 sai', '"## GABARITO EXCLUSIVO DO PROFESSOR" até o próximo ##', L('## GABARITO EXCLUSIVO DO PROFESSOR', '1. B', '### Questão 2', 'C', '## Próxima seção', 'Texto'), L('## Próxima seção', 'Texto')],
    ['2 sai', '"<h2>GABARITO DO PROFESSOR</h2>" até o próximo <h2>', L('<h2>GABARITO DO PROFESSOR</h2>', '1. B', '<h3>Questão 1</h3>', 'C', '<h2>Leitura complementar</h2>', 'Texto'), L('<h2>Leitura complementar</h2>', 'Texto')],
    ['2 sai', '"> ## GABARITO DO PROFESSOR": até o fim da citação', L('> ## GABARITO DO PROFESSOR', '> 1. B', '> 2. C', '', 'Texto depois da citação'), L('', 'Texto depois da citação')],
    ['2 sai', 'título sublinhado (===)', L('# Unidade', 'GABARITO DO PROFESSOR', '=====================', '1. B', '# Próximo capítulo', 'Texto'), L('# Unidade', '# Próximo capítulo', 'Texto')],
    ['2 sai', '"## Chave de respostas (professor)"', L('## Chave de respostas (professor)', 'B', '## Resolução do exercício', 'Texto'), L('## Resolução do exercício', 'Texto')],
    ['2 sai', '<h2> no meio da linha, dentro de <div>: o </div> fica', L('Intro', '', '<div class="box"><h2>GABARITO DO PROFESSOR</h2><p>1. B</p></div>', '', '## Próximo', 'Texto'), L('Intro', '', '<div class="box"></div>', '', '## Próximo', 'Texto')],
    ['2 sai', '<h2> quebrado em várias linhas', L('<h2 class="gab">', '  GABARITO DO PROFESSOR', '</h2>', '<p>1. D</p>', '', '## Anexo', 'Texto'), L('## Anexo', 'Texto')],
    ['2 sai', '<h3> dentro de <section>: acaba no </section>', L('<section><h3>Gabarito do professor</h3><ol><li>B</li></ol></section>', '<section><h3>Atividade</h3><p>Texto</p></section>'), L('<section></section>', '<section><h3>Atividade</h3><p>Texto</p></section>')],
    ['2 sai', 'acaba no título seguinte de mesmo nível', L('## Gabarito do professor', '## Questão 1', 'Texto'), L('## Questão 1', 'Texto')],
    ['2 sai', 'arquivo com CRLF', '# U\r\n\r\n## GABARITO DO PROFESSOR\r\n\r\n1. B\r\n\r\n## Próximo\r\n\r\nTexto', '# U\r\n\r\n## Próximo\r\n\r\nTexto'],
    ['2 fica', 'título dentro de bloco de código', L('```', '## GABARITO DO PROFESSOR', '```', 'Texto'), SAME],
    ['2 sai', 'bloco de código sem fechamento na citação acaba com a citação', L('> ## Gabarito do professor', '> ```', '> 1. B', '', '## Próximo', 'Texto'), L('', '## Próximo', 'Texto')],
    ['2 fica', 'título em bloco de código com 4 espaços', L('Exemplo:', '', '    ## GABARITO DO PROFESSOR', '', 'Texto'), SAME],
    ['2 fica', '"## Perguntas e respostas com o professor"', L('## Perguntas e respostas com o professor', 'Texto'), SAME],
    ['2 fica', '"## Solução proposta pelo instrutor"', L('## Solução proposta pelo instrutor', 'Texto'), SAME],
    ['2 fica', '"### Resposta do professor à dúvida da turma"', L('### Resposta do professor à dúvida da turma', 'Texto'), SAME],
    ['2 fica', '"## Gabarito dos exercícios"', L('## Gabarito dos exercícios', 'Texto'), SAME],
    ['2 fica', '"## GABARITO" sem marca', L('## GABARITO', '1. B'), SAME],
    ['2 fica', '"## Gabarito oficial" ("oficial" só vale no <summary>)', L('## Gabarito oficial', '1. B'), SAME],
    ['2 fica', '"Gabarito oficial" sublinhado', L('Gabarito oficial', '----------------', '1. B'), SAME],
    ['3 sai', '"**GABARITO DO PROFESSOR**" em parágrafo', L('**GABARITO DO PROFESSOR**', '', '1. B', '', '**Questão 2**', 'C', '', '## Exercícios', 'Texto'), L('## Exercícios', 'Texto')],
    ['3 sai', '"<p><strong>Gabarito do professor</strong></p>"', L('<p><strong>Gabarito do professor</strong></p>', '<ol><li>B</li></ol>', '<h2>Fim</h2>', 'Texto'), L('<h2>Fim</h2>', 'Texto')],
    ['3 sai', 'rótulo com dois-pontos e lista embaixo', L('**Gabarito do professor:**', '- B', '- C', '', 'Texto', '', '## Próximo', 'Texto 2'), L('## Próximo', 'Texto 2')],
    ['3 sai', '"**🔒 Gabarito do prof.**"', L('**🔒 Gabarito do prof.**', '', '1. B', '', '## Fim', 'Texto'), L('## Fim', 'Texto')],
    ['3 sai', 'rótulo dentro de citação: até o fim da citação', L('> **GABARITO DO PROFESSOR**', '>', '> 1. B', '', 'Texto'), L('', 'Texto')],
    ['3 sai', 'rótulo dentro de item de lista: até o fim do item', L('1. Questão sobre ls', '    **Gabarito do professor:**', '    - B', '2. Questão seguinte'), L('1. Questão sobre ls', '2. Questão seguinte')],
    ['3 sai', '"---" não encerra (não é título)', L('**Gabarito do professor**', '', '1. B', '', '---', '', 'Texto', '', '## Fim', 'Texto 2'), L('## Fim', 'Texto 2')],
    ['3 sai', 'outro negrito não encerra (não é título)', L('**Gabarito do professor**', '', '1. A', '', '**Exercício extra**', '', 'Texto', '', '## Fim'), '## Fim'],
    ['3 sai', 'sem título acima, o ### não encerra (vai até o próximo ## ou o fim)', L('**Gabarito do professor**', '', '1. A', '', '### Questão 1', 'Texto'), ''],
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
    ['4 sai', '"**GABARITO DO PROFESSOR:** 1-B, 2-C"', L('**GABARITO DO PROFESSOR:** 1-B (ls -la), 2-C', '', 'Texto'), L('', 'Texto')],
    ['4 sai', 'respostas na linha seguinte do mesmo parágrafo', L('**Gabarito do professor**: 1-B', '3-D', '', 'Texto'), L('', 'Texto')],
    ['4 sai', '"<strong>GABARITO DO PROFESSOR</strong><br>1. B"', L('<strong>GABARITO DO PROFESSOR</strong><br>1. B', '', 'Texto'), L('', 'Texto')],
    ['4 sai', 'dentro de item de lista: só a linha do item', L('1. Questão sobre o comando ls', '   **Gabarito do professor:** B', '2. Questão seguinte'), L('1. Questão sobre o comando ls', '2. Questão seguinte')],
    ['4 sai', 'em citação, linha de continuação sem ">" faz parte do parágrafo', L('> **Gabarito do professor:** 1-B', '2-C', '', 'Texto'), L('', 'Texto')],
    ['2 sai', 'sublinhado (---) colado ao rótulo + respostas: vira título sublinhado com gabarito + marca', L('**Gabarito do professor:** 1-B', '2-C', '---', '', 'Texto'), ''],
    ['4 sai', 'lista colada no rótulo + respostas é outro bloco e fica (o item de lista interrompe o parágrafo)', L('**Gabarito do professor:** respostas abaixo', '- B', '- C', '', 'Texto'), L('- B', '- C', '', 'Texto')],
    ['4 sai', '"**Gabarito do professor: consulte o mural.**": só o parágrafo', L('**Gabarito do professor: consulte o mural da coordenação.**', '', 'Texto'), L('', 'Texto')],
    ['4 sai', 'item de lista com o rótulo: o item seguinte fica', L('- **Gabarito do professor:** 1-B', '- **Prova**: avaliação'), '- **Prova**: avaliação'],
    ['4 fica', '"**Atenção:** o gabarito oficial será divulgado pelo professor."', L('**Atenção:** o gabarito oficial será divulgado pelo professor.', '', 'Texto'), SAME],
    ['4 fica', 'glossário: "**Gabarito oficial**: documento..."', L('**Gabarito oficial**: documento com as respostas corretas usado pelo professor na correção.', '', 'Texto'), SAME],
    ['4 fica', 'glossário em lista: "- **Gabarito**: ..."', L('- **Gabarito**: documento oficial com as respostas', '- **Prova**: avaliação'), SAME],
    ['4 fica', 'rótulo sem negrito com as respostas', L('Gabarito do professor: 1-B, 2-C', '', 'Texto'), SAME],
    ['4 fica', 'frase que cita o gabarito', L('O professor vai publicar o gabarito oficial amanhã.', '', 'Texto'), SAME],
    ['4 fica', 'tabela com coluna "Gabarito do professor"', L('| Questão | Gabarito do professor |', '|---|---|', '| 1 | B |'), SAME],
    ['fica', 'negrito comum no meio do texto', 'Texto com **negrito** e **outro**', SAME],

    // ---- Os 9 achados da revisão "gabarito" da rodada 1, com as entradas exatas.
    ['comentário sai', 'achado 1: título do professor dentro de comentário de várias linhas', L('# Unidade 1 — Redes', '', 'Conteúdo da aula VISIVEL_1.', '', '<!--', '## Gabarito do professor', '1. B SEGREDO_1', '-->', '', '## Exercícios de fixação', '', 'Exercício VISIVEL_2', '', '## Leitura complementar', '', 'Texto VISIVEL_3'), L('# Unidade 1 — Redes', '', 'Conteúdo da aula VISIVEL_1.', '', '', '## Exercícios de fixação', '', 'Exercício VISIVEL_2', '', '## Leitura complementar', '', 'Texto VISIVEL_3')],
    ['comentário sai', 'achado 1: rótulo do professor dentro de comentário', L('# Unidade 1 — Redes', '', 'Conteúdo da aula VISIVEL_1.', '', '<!--', '**Gabarito do professor**', '1. B SEGREDO_1', '-->', '', '## Exercícios de fixação', '', 'Exercício VISIVEL_2'), L('# Unidade 1 — Redes', '', 'Conteúdo da aula VISIVEL_1.', '', '', '## Exercícios de fixação', '', 'Exercício VISIVEL_2')],
    ['4 sai', 'achado 2: rótulo em <p> e os <p> seguintes ficam', L('<h2>Exercícios</h2>', '<p>1. Pergunta VISIVEL_1</p>', '<p><b>Gabarito do professor:</b> 1-B SEGREDO_1</p>', '<p>Leia também o texto complementar VISIVEL_2</p>', '<p>Bons estudos VISIVEL_3</p>'), L('<h2>Exercícios</h2>', '<p>1. Pergunta VISIVEL_1</p>', '<p>Leia também o texto complementar VISIVEL_2</p>', '<p>Bons estudos VISIVEL_3</p>')],
    ['4 sai', 'achado 2: <div> na linha seguinte abre outro bloco', L('**Gabarito do professor:** B', '<div>VISIVEL</div>'), '<div>VISIVEL</div>'],
    ['4 sai', 'achado 2: cerca de código na linha seguinte abre outro bloco', L('**Gabarito do professor:** B', '```', 'código', '```', 'VISIVEL_b'), L('```', 'código', '```', 'VISIVEL_b')],
    ['4 sai', 'achado 3: rótulo sozinho na linha e respostas na linha seguinte: só o parágrafo', L('## Exercícios', '', '1. Quanto é 2+2? VISIVEL_1', '', '**Gabarito do professor**', 'Questão 1: B SEGREDO_1', '', 'Para casa: leia o capítulo 3 VISIVEL_2', '', '## Leitura complementar', '', 'Texto VISIVEL_3'), L('## Exercícios', '', '1. Quanto é 2+2? VISIVEL_1', '', '', 'Para casa: leia o capítulo 3 VISIVEL_2', '', '## Leitura complementar', '', 'Texto VISIVEL_3')],
    ['4 sai', 'achado 3: quebra forçada com "\\" depois do rótulo', L('**Gabarito do professor**\\', 'Questão 1: B SEGREDO_1', '', 'Para casa VISIVEL_2'), L('', 'Para casa VISIVEL_2')],
    ['4 sai', 'achado 3: quebra forçada com dois espaços depois do rótulo', L('**Gabarito do professor**  ', 'Questão 1: B SEGREDO_1', '', 'Para casa VISIVEL_2'), L('', 'Para casa VISIVEL_2')],
    ['3 sai', 'achado 4: rótulo sozinho leva os subtítulos mais fundos da seção', L('# Unidade 2', '', '## Exercícios', '', '1. Qual comando lista arquivos?', '', '**Gabarito do professor**', '', '### Questão 1', '', 'B — ls -la SEGREDO_1', '', '### Questão 2', '', 'Resposta esperada SEGREDO_2', '', '## Leitura complementar', '', 'Texto'), L('# Unidade 2', '', '## Exercícios', '', '1. Qual comando lista arquivos?', '', '## Leitura complementar', '', 'Texto')],
    ['contêiner', 'achado 5: rótulo em <p> de várias linhas: o <p> sai inteiro', L('Intro VISIVEL_1', '', '<p>', '<strong>Gabarito do professor</strong>', '</p>', '<p>1. B SEGREDO_1</p>', '', '## Leitura complementar', '', 'Texto VISIVEL_2'), L('Intro VISIVEL_1', '', '## Leitura complementar', '', 'Texto VISIVEL_2')],
    ['contêiner', 'achado 5: rótulo em <li> de várias linhas: para no </li>', L('<ol>', '<li>Questão VIS_a</li>', '<li>', '<strong>Gabarito do professor</strong>', '<p>SEG</p>', '</li>', '<li>Questão VIS_b</li>', '</ol>'), L('<ol>', '<li>Questão VIS_a</li>', '<li>', '</li>', '<li>Questão VIS_b</li>', '</ol>')],
    ['contêiner', 'achado 5: <details> do professor sem fechamento dentro de <div>', L('<div class="box">', '<details><summary>Gabarito do professor</summary>', 'SEG', '</div>', '', 'VIS'), L('<div class="box">', '</div>', '', 'VIS')],
    ['código fica', 'achado 5: título do professor dentro de <pre> de várias linhas', L('<pre>', '## Gabarito do professor', 'x', '</pre>', '', 'VIS'), SAME],
    ['contêiner', 'achado 5: "## ..." dentro de <p> de várias linhas: para no </p>', L('<p>', '## Gabarito do professor', 'SEG', '</p>', '', '## Próximo VIS'), L('<p>', '</p>', '', '## Próximo VIS')],
    ['contêiner', 'achado 6: título do professor dentro de item de lista para no fim do item', L('1. Questão sobre IP VISIVEL_1', '', '   ### Gabarito do professor', '', '   B SEGREDO_1', '', '2. Questão sobre DNS VISIVEL_2', '', '3. Questão sobre HTTP VISIVEL_3', '', '## Leitura complementar', '', 'Texto VISIVEL_4'), L('1. Questão sobre IP VISIVEL_1', '', '2. Questão sobre DNS VISIVEL_2', '', '3. Questão sobre HTTP VISIVEL_3', '', '## Leitura complementar', '', 'Texto VISIVEL_4')],
    ['4 sai', 'achado 7: <li><strong>rótulo:</strong> respostas</li>', L('<ul>', '<li><strong>Gabarito do professor:</strong> B SEG_a</li>', '<li>Questão VIS_b</li>', '</ul>'), L('<ul>', '<li>Questão VIS_b</li>', '</ul>')],
    ['3 sai', 'achado 7: <div><strong>rótulo</strong></div>', L('<div><strong>Gabarito do professor</strong></div>', '<div>SEG_a</div>'), ''],
    ['3 sai', 'achado 7: emoji fora do negrito', L('🔒 **Gabarito do professor**', '', 'SEG_a', '', '## Fim'), '## Fim'],
    ['2 sai', 'achado 7: título na linha do marcador de lista', L('- ## Gabarito do professor', '  SEG_a'), ''],
    ['marca', 'achado 7: "profs." é marca do professor', L('## Gabarito para profs.', 'SEG_a', '## Fim'), '## Fim'],
    ['3 sai', 'achado 7: rótulo partido em dois negritos', L('**Gabarito** **do professor**', '', 'SEG_a', '', '## Fim'), '## Fim'],
    ['código fica', 'achado 8: <details> do professor em ```html sem fechamento', L('Exemplo:', '', '```html', '<details><summary>Gabarito do professor</summary>', '```', '', 'VIS_a resto da apostila', '', '## Unidade 2 VIS_b'), SAME],
    ['código fica', 'achado 8: <h2> do professor em código inline', L('Use `<h2>Gabarito do professor</h2>` VIS_a', '', 'VIS_b'), SAME],
    ['2 sai', 'achado 8: <h2> do professor em citação: até o fim da citação', L('> <h2>Gabarito do professor</h2>', '> SEG_a', '', 'VIS_a texto', '', '## Próximo VIS_b'), L('', 'VIS_a texto', '', '## Próximo VIS_b')],
    ['código fica', 'achado 8: <h2> inline em texto que fica não é mexido', L('Use a tag `<h2>Título</h2>` VIS_a.', '', '```html', '<h2>Gabarito do professor</h2>', '```'), SAME],

    // ---- Bateria da revisão "gabarito" da rodada 1 (SEG_ sai, VIS_ fica).
    ['1 sai', 'details summary "Gabarito do professor" multi-linha', L('# Unidade', '', 'VIS_a texto', '', '<details>', '<summary>Gabarito do professor</summary>', '', '1. B SEG_a', '2. C SEG_b', '', '</details>', '', 'VIS_b depois'), L('# Unidade', '', 'VIS_a texto', '', '', 'VIS_b depois')],
    ['1 sai', 'details summary com strong e quebras', L('VIS_a', '', '<details>', '  <summary>', '    <strong>GABARITO EXCLUSIVO DO PROFESSOR</strong>', '  </summary>', '  <p>SEG_a</p>', '</details>', '', 'VIS_b'), L('VIS_a', '', '', 'VIS_b')],
    ['1 sai', 'DETAILS maiúsculo e open', L('VIS_a', '<DETAILS open><SUMMARY>Gabarito do Professor</SUMMARY>SEG_a</DETAILS>', 'VIS_b'), L('VIS_a', 'VIS_b')],
    ['1 sai', 'summary "Gabarito oficial – Unidade 3"', L('VIS_a', '', '<details><summary>Gabarito oficial – Unidade 3</summary>', '', 'SEG_a', '</details>', '', 'VIS_b'), L('VIS_a', '', '', 'VIS_b')],
    ['1 sai', 'summary com &nbsp; e &#x2013;', L('VIS_a', '', '<details><summary>Gabarito&nbsp;&#x2013;&nbsp;Professor</summary>SEG_a</details>', '', 'VIS_b'), L('VIS_a', '', '', 'VIS_b')],
    ['1 sai', 'summary com markdown bold', L('VIS_a', '', '<details><summary>**Gabarito da professora**</summary>', '', 'SEG_a', '', '</details>', '', 'VIS_b'), L('VIS_a', '', '', 'VIS_b')],
    ['1 sai', 'summary "Gabarito – uso do docente"', L('<details><summary>🔐 Gabarito – uso do docente</summary>SEG_a</details>', 'VIS_a'), 'VIS_a'],
    ['1 sai', 'summary "Gabarito (instrutora)"', L('<details><summary>Gabarito (instrutora)</summary>SEG_a</details>', 'VIS_a'), 'VIS_a'],
    ['1 sai', 'summary "Gabarito do prof.ª"', L('<details><summary>Gabarito da profª</summary>SEG_a</details>', 'VIS_a'), 'VIS_a'],
    ['1 sai', 'details dentro de citação', L('> Exercício VIS_a', '>', '> <details><summary>Gabarito do professor</summary>SEG_a</details>', '', 'VIS_b'), L('> Exercício VIS_a', '>', '', 'VIS_b')],
    ['1 sai', 'details dentro de lista', L('1. Questão VIS_a', '   <details><summary>Gabarito do professor</summary>SEG_a</details>', '2. Questão VIS_b'), L('1. Questão VIS_a', '2. Questão VIS_b')],
    ['1 sai', 'details dentro de div', L('<div class="card">', '<p>VIS_a</p>', '<details><summary>Gabarito do professor</summary><p>SEG_a</p></details>', '<p>VIS_b</p>', '</div>', '', 'VIS_c'), L('<div class="card">', '<p>VIS_a</p>', '<p>VIS_b</p>', '</div>', '', 'VIS_c')],
    ['1 sai', 'details aninhado: externo do aluno, interno do professor', L('<details><summary>Exercícios VIS_a</summary>', '<p>VIS_b</p>', '<details><summary>Gabarito do professor</summary>SEG_a</details>', '<p>VIS_c</p>', '</details>', 'VIS_d'), L('<details><summary>Exercícios VIS_a</summary>', '<p>VIS_b</p>', '<p>VIS_c</p>', '</details>', 'VIS_d')],
    ['1 sai', 'details aninhado triplo', L('<details><summary>Gabarito exclusivo</summary>', '<details><summary>Q1</summary><details><summary>Q1a</summary>SEG_a</details>SEG_b</details>', 'SEG_c', '</details>', 'VIS_a'), 'VIS_a'],
    ['1 sai', 'dois details do professor seguidos', L('<details><summary>Gabarito do professor (parte 1)</summary>SEG_a</details>', 'VIS_a', '<details><summary>Gabarito do professor (parte 2)</summary>SEG_b</details>', 'VIS_b'), L('VIS_a', 'VIS_b')],
    ['1 fica', 'summary "Gabarito" sem marca', L('<details><summary>Gabarito</summary>VIS_a</details>', 'VIS_b'), SAME],
    ['1 fica', 'summary "Gabarito dos exercícios"', L('<details><summary>Gabarito dos exercícios</summary>', '', '1. A VIS_a', '</details>'), SAME],
    ['1 fica', 'summary "Ver Resposta"', L('<details><summary>👀 Ver Resposta</summary>', '', 'VIS_a', '</details>'), SAME],
    ['1 fica', 'summary "Resposta comentada pelo professor"', '<details><summary>Resposta comentada pelo professor</summary>VIS_a</details>', SAME],
    ['1 fica', 'summary "Dica do professor"', '<details><summary>Dica do professor</summary>VIS_a</details>', SAME],
    ['1 fica', 'summary "Solução (instrutor)"', '<details><summary>Solução (instrutor)</summary>VIS_a</details>', SAME],
    ['1 fica', 'summary "Confira seu gabarito"', '<details><summary>Confira seu gabarito</summary>VIS_a</details>', SAME],
    ['código fica', 'details em bloco de código', L('```html', '<details><summary>Gabarito do professor</summary>VIS_a</details>', '```', 'VIS_b'), SAME],
    ['1 fica', 'details com professor no corpo, summary neutro', '<details><summary>Resumo</summary>O gabarito do professor fica com a coordenação. VIS_a</details>', SAME],
    ['2 sai', '# h1 com ## dentro', L('# Unidade 1 VIS_a', 'Texto VIS_b', '# Gabarito do professor', '## Questão 1', 'SEG_a', '## Questão 2', 'SEG_b', '# Unidade 2 VIS_c', 'VIS_d'), L('# Unidade 1 VIS_a', 'Texto VIS_b', '# Unidade 2 VIS_c', 'VIS_d')],
    ['2 sai', '### com #### dentro e ## depois', L('## Exercícios VIS_a', '1. Pergunta VIS_b', '### Gabarito do Professor', '#### Q1', 'SEG_a', '### Próximo VIS_c', 'VIS_d'), L('## Exercícios VIS_a', '1. Pergunta VIS_b', '### Próximo VIS_c', 'VIS_d')],
    ['2 sai', '## Gabarito do professor ## (fechamento)', L('## Gabarito do professor ##', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '  ## (indentado 2 espaços)', L('  ## GABARITO DO PROFESSOR', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## com emoji e negrito', L('## 🔑 **Gabarito do Professor**', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## com link', L('## [Gabarito do professor](#gab)', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## com {#id}', L('## Gabarito do professor {#gabarito}', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## Gabarito – uso exclusivo', L('## Gabarito – uso exclusivo', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## Gabarito (docente)', L('## Gabarito (docente)', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## GABARITO DA PROFESSORA', L('## GABARITO DA PROFESSORA', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## Gabarito dos instrutores', L('## Gabarito dos instrutores', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## Gabarito do Prof. Carlos', L('## Gabarito do Prof. Carlos', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## Gabarito&nbsp;do&nbsp;professor', L('## Gabarito&nbsp;do&nbsp;professor', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## Gabarito do professor com tab', L('##\tGabarito do professor', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '<h2> com atributos e span', L('<h2 id="gab" class="t"><span>Gabarito</span> do professor</h2>', '<p>SEG_a</p>', '<h2>Fim VIS_a</h2>'), '<h2>Fim VIS_a</h2>'],
    ['2 sai', '<H3> maiúsculo', L('<H3>GABARITO DO PROFESSOR</H3>', 'SEG_a', '<H3>Fim VIS_a</H3>'), '<H3>Fim VIS_a</H3>'],
    ['2 sai', '<h2> numa linha com texto antes', L('<p>VIS_a</p><h2>Gabarito do professor</h2><p>SEG_a</p>', '', '<h2>Fim VIS_b</h2>'), '<p>VIS_a</p><h2>Fim VIS_b</h2>'],
    ['2 sai', 'setext ---', L('Texto VIS_a', '', 'Gabarito do professor', '---------------------', 'SEG_a', '', 'Fim VIS_b', '=======', 'VIS_c'), L('Texto VIS_a', '', 'Fim VIS_b', '=======', 'VIS_c')],
    ['2 sai', '> ## em citação, depois citação continua com outro título', L('> ## Gabarito do professor', '> SEG_a', '> ## Observação VIS_a', '> VIS_b'), L('> ## Observação VIS_a', '> VIS_b')],
    ['2 sai', '> > ## citação aninhada', L('> VIS_a', '> > ## Gabarito do professor', '> > SEG_a', '>', '> VIS_b', '', 'VIS_c'), L('> VIS_a', '>', '> VIS_b', '', 'VIS_c')],
    ['2 sai', '>## sem espaço', L('>## Gabarito do professor', '>SEG_a', '', 'VIS_a'), L('', 'VIS_a')],
    ['2 sai', '<h2> em citação', L('> <h2>Gabarito do professor</h2>', '> SEG_a', '', 'VIS_a texto', '', '## Próximo VIS_b'), L('', 'VIS_a texto', '', '## Próximo VIS_b')],
    ['2 sai', '## no fim do arquivo', L('# U VIS_a', 'VIS_b', '## Gabarito do professor', 'SEG_a', 'SEG_b'), L('# U VIS_a', 'VIS_b', '')],
    ['2 sai', '## dentro de div até </div>', L('<div class="u">', '', '## Gabarito do professor', '', 'SEG_a', '', '</div>', '', 'VIS_a'), L('<div class="u">', '', '</div>', '', 'VIS_a')],
    ['2 sai', '## seguido de details do aluno', L('## Gabarito do professor', '<details><summary>Q1</summary>SEG_a</details>', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '## com bloco de código dentro', L('## Gabarito do professor', '```bash', '## comentário SEG_a', '```', 'SEG_b', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', 'CRLF com h2 html em linha', 'VIS_a\r\n<div><h2>Gabarito do professor</h2><p>SEG_a</p></div>\r\n\r\n## Fim VIS_b', 'VIS_a\r\n<div></div>\r\n\r\n## Fim VIS_b'],
    ['2 sai', 'CRLF setext', 'VIS_a\r\n\r\nGABARITO DO PROFESSOR\r\n=====\r\nSEG_a\r\n# Fim VIS_b', 'VIS_a\r\n\r\n# Fim VIS_b'],
    ['2 sai', '## dentro de item de lista (- ## ...)', L('- Item VIS_a', '- ## Gabarito do professor', '  SEG_a', '- Item VIS_b'), L('- Item VIS_a', '- Item VIS_b')],
    ['2 fica', '## Gabarito', L('## Gabarito', 'VIS_a'), SAME],
    ['2 fica', '## Gabarito comentado', L('## Gabarito comentado', 'VIS_a'), SAME],
    ['2 fica', '## Gabarito oficial', L('## Gabarito oficial', 'VIS_a'), SAME],
    ['2 fica', '## Resposta do professor', L('## Resposta do professor', 'VIS_a'), SAME],
    ['2 fica', '## Gabarito dos exercícios', L('## Gabarito dos exercícios', 'VIS_a'), SAME],
    ['2 fica', '## Exercícios de fixação (corrigidos pelo professor)', L('## Exercícios de fixação (corrigidos pelo professor)', 'VIS_a'), SAME],
    ['código fica', '# título dentro de ~~~', L('~~~markdown', '## Gabarito do professor', 'VIS_a', '~~~', 'VIS_b'), SAME],
    ['código fica', '<h2> em código inline', L('Use `<h2>Gabarito do professor</h2>` VIS_a', '', 'VIS_b'), SAME],
    ['2 fica', 'texto com "gabarito do professor" em parágrafo', L('O gabarito do professor fica com a coordenação. VIS_a', '', 'VIS_b'), SAME],
    ['2 fica', 'item de lista "- Gabarito do professor: 1-B" sem negrito', L('- Gabarito do professor: VIS_a', '- VIS_b'), SAME],
    ['2 fica', 'professor como título e gabarito no corpo', L('## Recado do professor', 'O gabarito sai amanhã VIS_a'), SAME],
    ['3 sai', '__Gabarito do professor__', L('VIS_a', '', '__Gabarito do professor__', '', 'SEG_a', '', '## Fim VIS_b'), L('VIS_a', '', '## Fim VIS_b')],
    ['3 sai', '***Gabarito do professor***', L('VIS_a', '', '***Gabarito do professor***', '', 'SEG_a', '', '## Fim VIS_b'), L('VIS_a', '', '## Fim VIS_b')],
    ['3 sai', '<b>Gabarito do professor</b>', L('VIS_a', '', '<b>Gabarito do professor</b>', '', 'SEG_a', '', '## Fim VIS_b'), L('VIS_a', '', '## Fim VIS_b')],
    ['3 sai', '<p class="x"><strong>Gabarito do professor</strong></p>', L('VIS_a', '', '<p class="x"><strong>Gabarito do professor</strong></p>', '<p>SEG_a</p>', '', '## Fim VIS_b'), L('VIS_a', '', '## Fim VIS_b')],
    ['3 sai', '**Gabarito do professor** com espaços finais', L('VIS_a', '', '**Gabarito do professor**  ', '', 'SEG_a', '', '## Fim VIS_b'), L('VIS_a', '', '## Fim VIS_b')],
    ['3 sai', '**GABARITO – USO EXCLUSIVO DO PROFESSOR**', L('VIS_a', '', '**GABARITO – USO EXCLUSIVO DO PROFESSOR**', '', 'SEG_a', '', '# Fim VIS_b'), L('VIS_a', '', '# Fim VIS_b')],
    ['3 sai', '- **Gabarito do professor** em lista com subitens', L('- Item VIS_a', '- **Gabarito do professor**', '  - SEG_a', '  - SEG_b', '- Item VIS_b'), L('- Item VIS_a', '- Item VIS_b')],
    ['3 sai', 'rótulo + lista HTML + <h2>', L('**Gabarito do professor**', '<ol>', '<li>SEG_a</li>', '</ol>', '<h2>Fim VIS_a</h2>'), '<h2>Fim VIS_a</h2>'],
    ['3 sai', 'rótulo dentro de details do aluno', L('<details><summary>Exercícios VIS_a</summary>', '', '**Gabarito do professor**', '', 'SEG_a', '', '</details>', '', 'VIS_b'), L('<details><summary>Exercícios VIS_a</summary>', '', '</details>', '', 'VIS_b')],
    ['3 sai', 'rótulo em <p> multi-linha', L('VIS_a', '', '<p>', '<strong>Gabarito do professor</strong>', '</p>', '<p>SEG_a</p>', '', '## Fim VIS_b'), L('VIS_a', '', '## Fim VIS_b')],
    ['3 sai', 'rótulo dentro de <li> HTML', L('<ol>', '<li>Questão VIS_a</li>', '<li>', '<strong>Gabarito do professor</strong>', '<p>SEG_a</p>', '</li>', '<li>Questão VIS_b</li>', '</ol>', 'VIS_c'), L('<ol>', '<li>Questão VIS_a</li>', '<li>', '</li>', '<li>Questão VIS_b</li>', '</ol>', 'VIS_c')],
    ['3 sai', '<li><strong>Gabarito do professor</strong></li> numa linha', L('<ul>', '<li><strong>Gabarito do professor</strong></li>', '<li>SEG_a</li>', '</ul>', '', 'VIS_a'), L('<ul>', '</ul>', '', 'VIS_a')],
    ['3 sai', '<div><strong>Gabarito do professor</strong></div>', L('<div><strong>Gabarito do professor</strong></div>', '<div>SEG_a</div>', '', '## Fim VIS_a'), '## Fim VIS_a'],
    ['3 sai', '**Gabarito** **do professor** (dois negritos)', L('**Gabarito** **do professor**', '', 'SEG_a', '', '## Fim VIS_a'), '## Fim VIS_a'],
    ['3 sai', '**Gabarito do professor** com \\ quebra', L('**Gabarito do professor**\\', '1-B SEG_a', '', 'VIS_a', '', '## Fim VIS_b'), L('', 'VIS_a', '', '## Fim VIS_b')],
    ['3 fica', '*Gabarito do professor* itálico', L('*Gabarito do professor*', '', 'VIS_a'), SAME],
    ['3 fica', '**Gabarito**', L('**Gabarito**', '', 'VIS_a'), SAME],
    ['3 fica', '**Gabarito oficial**', L('**Gabarito oficial**', '', 'VIS_a'), SAME],
    ['3 fica', '"**Professor responsável**"', L('**Professor responsável**', '', 'VIS_a'), SAME],
    ['3 fica', 'negrito no meio da frase', L('Confira o **gabarito do professor** no mural. VIS_a', '', 'VIS_b'), SAME],
    ['código fica', 'rótulo em bloco de código', L('```', '**Gabarito do professor**', 'VIS_a', '```', 'VIS_b'), SAME],
    ['código fica', 'rótulo em código com 4 espaços', L('Exemplo:', '', '    **Gabarito do professor**', '', 'VIS_a'), SAME],
    ['3 fica', 'tabela', L('| **Gabarito do professor** | B |', '|---|---|', '| VIS_a | x |'), SAME],
    ['4 sai', '**Gabarito do professor:** respostas + parágrafo seguinte', L('VIS_a', '', '**Gabarito do professor:** 1-B, 2-C SEG_a', '', 'VIS_b', '', '## Fim VIS_c'), L('VIS_a', '', '', 'VIS_b', '', '## Fim VIS_c')],
    ['4 sai', '<p><strong>Gabarito do professor:</strong> 1-B</p>', L('<p>VIS_a</p>', '', '<p><strong>Gabarito do professor:</strong> 1-B SEG_a</p>', '', '<p>VIS_b</p>'), L('<p>VIS_a</p>', '', '', '<p>VIS_b</p>')],
    ['4 sai', '<p> HTML consecutivo (sem linha em branco)', L('<p><strong>Gabarito do professor:</strong> 1-B SEG_a</p>', '<p>VIS_a texto legítimo</p>', '<p>VIS_b</p>'), L('<p>VIS_a texto legítimo</p>', '<p>VIS_b</p>')],
    ['4 sai', '<li><strong>Gabarito do professor:</strong> B</li>', L('<ul>', '<li>Questão VIS_a</li>', '<li><strong>Gabarito do professor:</strong> B SEG_a</li>', '<li>Questão VIS_b</li>', '</ul>'), L('<ul>', '<li>Questão VIS_a</li>', '<li>Questão VIS_b</li>', '</ul>')],
    ['4 sai', '1. **Gabarito do professor:** B (item numerado)', L('1. Questão VIS_a', '2. **Gabarito do professor:** B SEG_a', '3. Questão VIS_b'), L('1. Questão VIS_a', '3. Questão VIS_b')],
    ['4 sai', '**Gabarito do professor** – Unidade 2 (texto depois)', L('**Gabarito do professor** – Unidade 2 SEG_a', '', 'VIS_a', '', '## Fim VIS_b'), L('', 'VIS_a', '', '## Fim VIS_b')],
    ['4 sai', 'em citação', L('> VIS_a', '>', '> **Gabarito do professor:** B SEG_a', '>', '> VIS_b'), L('> VIS_a', '>', '>', '> VIS_b')],
    ['4 sai', 'seguido de título', L('**Gabarito do professor:** B SEG_a', '## Próximo VIS_a'), '## Próximo VIS_a'],
    ['4 sai', 'seguido de <div> na linha seguinte', L('**Gabarito do professor:** B SEG_a', '<div>VIS_a</div>', '', 'VIS_b'), L('<div>VIS_a</div>', '', 'VIS_b')],
    ['4 sai', 'seguido de bloco de código colado', L('**Gabarito do professor:** B SEG_a', '```', 'VIS_a código', '```', 'VIS_b'), L('```', 'VIS_a código', '```', 'VIS_b')],
    ['4 fica', '**Obs.:** o gabarito fica com o professor', L('**Obs.:** o gabarito fica com o professor. VIS_a', '', 'VIS_b'), SAME],
    ['4 fica', '**Importante** o professor publica o gabarito', '**Importante:** o professor publica o gabarito depois. VIS_a', SAME],
    ['4 fica', '- **Gabarito**: definição (glossário)', L('- **Gabarito**: documento com as respostas que o professor usa. VIS_a', '- **Rubrica**: critérios VIS_b'), SAME],
    ['comentário sai', 'gabarito escondido em comentário HTML', L('# Unidade VIS_a', '', '<!--', '## Gabarito do professor', '1. B SEG_a', '-->', '', '## Próxima seção VIS_b', '', 'VIS_c'), L('# Unidade VIS_a', '', '', '## Próxima seção VIS_b', '', 'VIS_c')],
    ['comentário sai', 'rótulo em comentário HTML', L('VIS_a', '', '<!--', '**Gabarito do professor**', '', '1. B SEG_a', '-->', '', 'VIS_b', '', '## Fim VIS_c'), L('VIS_a', '', '', 'VIS_b', '', '## Fim VIS_c')],
    ['código fica', '<h2> dentro de <pre> é código', L('<pre>', '<h2>Gabarito do professor</h2>', 'VIS_a', '</pre>', 'VIS_b'), SAME],
    ['contêiner', '<details> do professor sem fechamento dentro de <div>: o </div> fica', L('<div class="box">', '<details><summary>Gabarito do professor</summary>', 'SEG_a', '</div>', '', 'VIS_a'), L('<div class="box">', '</div>', '', 'VIS_a')],
    ['2 sai', 'h2 do professor + h2 inline em outro lugar (isolamento)', L('Exemplo: o título <h2>Resumo VIS_a</h2> aparece aqui.', '', '<h2>Gabarito do professor</h2>', 'SEG_a', '<h2>Fim VIS_b</h2>'), L('Exemplo: o título <h2>Resumo VIS_a</h2> aparece aqui.', '', '<h2>Fim VIS_b</h2>')],
    ['código fica', 'h2 do professor só dentro de bloco de código + h2 inline', L('Use a tag `<h2>Título</h2>` VIS_a.', '', '```html', '<h2>Gabarito do professor</h2>', '```', 'VIS_b'), SAME],
    ['2 sai', 'cabeçalho YAML antes do título', L('---', 'title: Unidade VIS_a', '---', '', '## Gabarito do professor', 'SEG_a', '## Fim VIS_b'), L('---', 'title: Unidade VIS_a', '---', '', '## Fim VIS_b')],
    ['2 sai', 'setext em parágrafo de 2 linhas', L('VIS_a', '', 'Unidade 3:', 'Gabarito do professor', '---', 'SEG_a', '', '## Fim VIS_b'), L('VIS_a', '', '## Fim VIS_b')],
    ['4 sai', 'rótulo sozinho na linha + respostas na linha seguinte (mesmo parágrafo)', L('## Exercícios VIS_a', '', '1. Quanto é 2+2? VIS_b', '', '**Gabarito do professor**', '1-B, 2-C, 3-A SEG_a', '', 'Exercícios para casa: leia o capítulo 3. VIS_c', '', '## Fim VIS_d'), L('## Exercícios VIS_a', '', '1. Quanto é 2+2? VIS_b', '', '', 'Exercícios para casa: leia o capítulo 3. VIS_c', '', '## Fim VIS_d')],
    ['4 sai', 'rótulo sozinho + "Respostas: ..." na linha seguinte', L('**GABARITO DO PROFESSOR**', 'Respostas: 1-B; 2-C SEG_a', '', 'Texto do aluno VIS_a', '', '### Próximo VIS_b'), L('', 'Texto do aluno VIS_a', '', '### Próximo VIS_b')],
    ['2 sai', '## em item de lista com indentação 3', L('1. Questão VIS_a', '', '   ## Gabarito do professor', '', '   SEG_a', '', '2. Questão VIS_b', '', 'VIS_c', '', '## Fim VIS_d'), L('1. Questão VIS_a', '', '2. Questão VIS_b', '', 'VIS_c', '', '## Fim VIS_d')],
    ['2 sai', '## em details do aluno', L('<details><summary>Exercícios VIS_a</summary>', '', '## Gabarito do professor', '', 'SEG_a', '', '</details>', '', 'VIS_b', '', '## Fim VIS_c'), L('<details><summary>Exercícios VIS_a</summary>', '', '</details>', '', 'VIS_b', '', '## Fim VIS_c')],
    ['código fica', 'details do professor em bloco de código sem </details>', L('Exemplo de como o professor marca o gabarito:', '', '```html', '<details><summary>Gabarito do professor</summary>', '```', '', 'VIS_a resto da apostila', '', '## Unidade 2 VIS_b'), SAME],
    ['4 sai', 'HTML: rótulo inline + parágrafos HTML seguintes', L('<h2>Exercícios VIS_x</h2>', '<p>1. Pergunta VIS_a</p>', '<p><b>Gabarito do professor:</b> 1-B SEG_a</p>', '<p>Leia também o texto complementar VIS_b</p>', '<p>Bons estudos VIS_c</p>'), L('<h2>Exercícios VIS_x</h2>', '<p>1. Pergunta VIS_a</p>', '<p>Leia também o texto complementar VIS_b</p>', '<p>Bons estudos VIS_c</p>')],
    ['4 sai', 'rótulo + respostas e tabela colada: a tabela é do mesmo parágrafo', L('**Gabarito do professor:** veja a tabela SEG_a', '| Q | R |', '|---|---|', '| 1 | B SEG_b |', '', 'VIS_a'), L('', 'VIS_a')],
    ['4 sai', 'rótulo + respostas e imagem colada: a imagem é do mesmo parágrafo', L('**Gabarito do professor:** 1-B SEG_a', '![figura do circuito](/imagens/x.png) VIS_a', '', 'VIS_b'), L('', 'VIS_b')],
    ['2 sai', 'h2 multi-linha com quebra de linha e entidades', L('<h2>', 'GABARITO&nbsp;DO', 'PROFESSOR', '</h2>', '<p>SEG_a</p>', '<h2>Fim VIS_a</h2>'), '<h2>Fim VIS_a</h2>'],
    ['2 sai', 'título com "Gabarito — Prof.ª Ana"', L('## Gabarito — Prof.ª Ana', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', 'título "Gabarito para profs."', L('## Gabarito para profs.', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', 'título com soft hyphen', L('## Gaba\u00adrito do professor', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', 'título com &ccedil; "Chave de corre&ccedil;&atilde;o (professor)"', L('## Chave de corre&ccedil;&atilde;o (professor)', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', '"## Como o professor usa o gabarito": título com gabarito + marca sai (regra ao pé da letra)', L('## Como o professor usa o gabarito', 'Texto explicativo VIS_a', '## Fim VIS_b'), '## Fim VIS_b'],
    ['3 sai', 'rótulo com <strong> e <br>', L('<strong>Gabarito do professor</strong><br>', '', 'SEG_a', '', '## Fim VIS_a'), '## Fim VIS_a'],
    ['3 sai', 'rótulo em negrito com emoji fora', L('🔒 **Gabarito do professor**', '', 'SEG_a', '', '## Fim VIS_a'), '## Fim VIS_a'],
    ['3 sai', 'dois negritos seguidos "**1)** **Gabarito do professor**"', L('**1)** **Gabarito do professor**', '', 'SEG_a', '', '## Fim VIS_a'), '## Fim VIS_a'],
    ['2 sai', 'h2 dentro de table/td', L('<table><tr><td>', '<h3>Gabarito do professor</h3>', 'SEG_a', '</td></tr></table>', '', 'VIS_a'), L('<table><tr><td>', '</td></tr></table>', '', 'VIS_a')],
    ['2 sai', 'heading inside section aninhada, fecha section externa', L('<section class="unidade">', '<section class="exercicios">', '<h3>Exercícios VIS_a</h3>', '</section>', '<section class="gab">', '<h3>Gabarito do professor</h3>', '<p>SEG_a</p>', '</section>', '<p>VIS_b</p>', '</section>', '', 'VIS_c'), L('<section class="unidade">', '<section class="exercicios">', '<h3>Exercícios VIS_a</h3>', '</section>', '<section class="gab">', '</section>', '<p>VIS_b</p>', '</section>', '', 'VIS_c')],
    ['2 sai', 'div aberto antes, fechado depois do próximo título', L('<div class="u">', '', '## Gabarito do professor', 'SEG_a', '', '## Leitura VIS_a', 'VIS_b', '', '</div>', '', 'VIS_c'), L('<div class="u">', '', '## Leitura VIS_a', 'VIS_b', '', '</div>', '', 'VIS_c')],
    ['2 sai', 'div aberta dentro da seção, fechada depois do título seguinte', L('## Gabarito do professor', '<div class="box">', '', 'SEG_a', '', '## Leitura VIS_a', 'VIS_b', '', '</div>', '', 'VIS_c'), L('## Leitura VIS_a', 'VIS_b', '', '', 'VIS_c')],

    // ---- Regras do ajuste 2 (comentários, seção do rótulo, contêineres, marcas).
    ['marca', '"professora" é marca do professor', L('## Gabarito da professora', 'SEG_a', '## Fim'), '## Fim'],
    ['marca', '"**Gabarito exclusivo para profs.**"', L('**Gabarito exclusivo para profs.**', '', 'SEG_a', '', '## Fim VIS_a'), '## Fim VIS_a'],
    ['marca', 'hífen invisível no meio da palavra (&shy;)', L('## Gaba&shy;rito do professor', 'SEG_a', '## Fim VIS_a'), '## Fim VIS_a'],
    ['comentário sai', 'comentário no meio do parágrafo', L('Texto <!-- nota do professor --> continua VIS', '', 'VIS2'), L('Texto  continua VIS', '', 'VIS2')],
    ['comentário sai', 'comentário no fim do título que fica', L('## Título VIS <!-- gabarito do professor: B -->', 'Texto VIS2'), L('## Título VIS ', 'Texto VIS2')],
    ['comentário sai', 'comentário de várias linhas no meio da linha', L('Antes VIS <!-- começa', 'meio SEG', 'fim --> depois VIS2', '', 'VIS3'), L('Antes VIS  depois VIS2', '', 'VIS3')],
    ['comentário sai', 'comentário dentro de <h2> que fica (e não conta no título)', L('<h2>Exercícios <!-- gabarito do professor --></h2>', 'VIS'), L('<h2>Exercícios </h2>', 'VIS')],
    ['comentário sai', 'comentário dentro de <summary> não conta no resumo', '<details><summary>Exercícios <!-- gabarito do professor --></summary>VIS</details>', '<details><summary>Exercícios </summary>VIS</details>'],
    ['código fica', 'comentário em código inline fica', '`<!-- código -->` VIS', SAME],
    ['código fica', 'comentário em bloco de código fica', L('```html', '<!-- exemplo -->', '```', 'VIS'), SAME],
    ['3 sai', 'rótulo sozinho numa seção ##: o ### de dentro sai junto', L('## Exercícios', '', '**Gabarito do professor**', '', '### Questão 1', 'SEG', '', '## Leitura VIS'), L('## Exercícios', '', '## Leitura VIS')],
    ['3 sai', 'rótulo sozinho numa seção #: até o próximo #', L('# U', '', '**Gabarito do professor**', '', '## Q1', 'SEG', '', '# Fim VIS'), L('# U', '', '# Fim VIS')],
    ['3 sai', 'rótulo sozinho numa seção ###: o ## seguinte encerra', L('### Sub', '', '**Gabarito do professor**', '', '#### Q', 'SEG', '', '## Fim VIS'), L('### Sub', '', '## Fim VIS')],
    ['3 sai', 'rótulo sozinho sem título acima: o ### não encerra, o ## encerra', L('**Gabarito do professor**', '', '### Questão 1', 'SEG', '', '## Leitura VIS'), '## Leitura VIS'],
    ['3 sai', 'rótulo sozinho em <div> dentro de seção: para no </div>', L('## Exercícios', '<div>', '', '**Gabarito do professor**', '', '### Q1', 'SEG', '', '</div>', '', 'VIS', '', '## Leitura VIS2'), L('## Exercícios', '<div>', '', '</div>', '', 'VIS', '', '## Leitura VIS2')],
    ['4 sai', 'rótulo + respostas em citação: a citação sai', L('> **Gabarito do professor**', '> SEG', '', 'VIS'), L('', 'VIS')],
    ['3 sai', 'rótulo sozinho em item de lista: até o fim do item', L('- **Gabarito do professor**', '', '  SEG', '', '- VIS'), '- VIS'],
    ['4 sai', 'rótulo no começo da 2ª linha do parágrafo: sai dali até o fim do parágrafo', L('Texto VIS', '**Gabarito do professor:** B SEG', '', 'VIS2'), L('Texto VIS', '', 'VIS2')],
    ['4 fica', 'rótulo no meio da linha não é rótulo', '<p>Texto VIS <strong>Gabarito do professor:</strong> B</p>', SAME],
    ['1 sai', '<details> do professor sem fechamento vai até o fim', L('<details><summary>Gabarito do professor</summary>', 'SEG', '', '## Próximo SEG2'), ''],
    ['contêiner', 'título do professor em <div> que fecha depois do próximo título', L('<div class="u">', '', '## Gabarito do professor', 'SEG_a', '', '</div>', '', '## Leitura VIS_a'), L('<div class="u">', '', '</div>', '', '## Leitura VIS_a')],
    ['contêiner', '<div> aberto dentro do trecho sai com o fechamento', L('## Gabarito do professor', '<div class="box">', 'SEG_a', '## Leitura VIS_a', '</div>', 'VIS_b'), L('## Leitura VIS_a', 'VIS_b')],
    ['contêiner', 'rótulo sozinho em <li> sem fechamento: vai até o </ul>', L('<ul>', '<li>a VIS', '<li><strong>Gabarito do professor</strong>', '<li>SEG', '</ul>', '', 'VIS2'), L('<ul>', '<li>a VIS', '</ul>', '', 'VIS2')],
    ['contêiner', '<details> do professor em item de lista sem fechamento: para no fim do item', L('1. Q VIS', '   <details><summary>Gabarito do professor</summary>', '   SEG', '2. VIS2'), L('1. Q VIS', '2. VIS2')],
];

// Nenhum contêiner fica mais aberto (nem com mais fechamentos soltos) do que na entrada.
const CONTAINERS = ['div', 'section', 'details', 'ol', 'ul', 'table', 'blockquote', 'p', 'li'];
function containerBalance(text) {
    return Object.fromEntries(CONTAINERS.map(name => {
        const opened = (text.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || []).length;
        const closed = (text.match(new RegExp(`</${name}\\s*>`, 'gi')) || []).length;
        return [name, opened - closed];
    }));
}

test('[UC-SIGILO-001] gabarito do professor na apostila: tabela de casos que saem e que ficam (regras fixas)', () => {
    for (const [rule, name, input, expected] of CASES) {
        const label = `regra ${rule} · ${name}`;
        const output = stripAnswerKeyBlocks(input);
        assert.equal(output, expected === SAME ? input : expected, label);
        assert.equal(stripAnswerKeyBlocks(output), output, `${label}: idempotente`);
        const before = containerBalance(input);
        const after = containerBalance(output);
        for (const name of CONTAINERS) {
            assert.ok(after[name] <= Math.max(before[name], 0) && after[name] >= Math.min(before[name], 0), `${label}: nenhuma tag <${name}> fica aberta ou solta`);
        }
        assert.ok(!/SEG/.test(output), `${label}: o gabarito (SEG...) não chega ao aluno`);
        if (!rule.startsWith('código')) assert.ok(!output.includes('<!--'), `${label}: nenhum comentário HTML chega ao aluno`);
    }
});

test('[UC-SIGILO-001] os blocos guardam o trecho exato do original (o que fica não muda)', () => {
    for (const [rule, name, input] of CASES) {
        const units = tokenize(input);
        let position = 0;
        for (const unit of units) {
            assert.equal(unit.start, position, `regra ${rule} · ${name}: blocos contíguos`);
            assert.ok(unit.end >= unit.start, `regra ${rule} · ${name}: bloco com fim depois do começo`);
            position = unit.end;
        }
        assert.equal(position, input.length, `regra ${rule} · ${name}: os blocos cobrem o texto inteiro`);
    }
});

test('[UC-SIGILO-001] a tabela cobre todas as regras e os casos citados nas revisões', () => {
    const kinds = new Set(CASES.map(([rule]) => rule));
    for (const kind of ['código fica', 'comentário sai', 'contêiner', 'marca', '1 sai', '1 fica', '2 sai', '2 fica', '3 sai', '3 fica', '4 sai', '4 fica']) {
        assert.ok(kinds.has(kind), kind);
    }
    const inputs = CASES.map(([, , input]) => input);
    const joined = inputs.join('\n');
    // Casos citados nas revisões anteriores (sobras do G6).
    for (const cited of ['## Perguntas e respostas com o professor', '## Solução proposta pelo instrutor', '### Resposta do professor à dúvida da turma', '<summary>Resposta do professor</summary>', '**GABARITO DO PROFESSOR**', '<h2>GABARITO DO PROFESSOR</h2>', '> ## GABARITO DO PROFESSOR', 'GABARITO&nbsp;OFICIAL', 'Gabarito do prof.', '## GABARITO EXCLUSIVO DO PROFESSOR', 'Gabarito dos exercícios', 'Ver Resposta']) {
        assert.ok(joined.includes(cited), `falta o caso ${cited}`);
    }
    // Os 9 achados da revisão "gabarito" da rodada 1 (entradas exatas).
    for (const cited of [
        '# Unidade 1 — Redes\n\nConteúdo da aula VISIVEL_1.\n\n<!--\n## Gabarito do professor\n1. B SEGREDO_1\n-->\n\n## Exercícios de fixação\n\nExercício VISIVEL_2\n\n## Leitura complementar\n\nTexto VISIVEL_3',
        '<h2>Exercícios</h2>\n<p>1. Pergunta VISIVEL_1</p>\n<p><b>Gabarito do professor:</b> 1-B SEGREDO_1</p>\n<p>Leia também o texto complementar VISIVEL_2</p>\n<p>Bons estudos VISIVEL_3</p>',
        '## Exercícios\n\n1. Quanto é 2+2? VISIVEL_1\n\n**Gabarito do professor**\nQuestão 1: B SEGREDO_1\n\nPara casa: leia o capítulo 3 VISIVEL_2\n\n## Leitura complementar\n\nTexto VISIVEL_3',
        '# Unidade 2\n\n## Exercícios\n\n1. Qual comando lista arquivos?\n\n**Gabarito do professor**\n\n### Questão 1\n\nB — ls -la SEGREDO_1\n\n### Questão 2\n\nResposta esperada SEGREDO_2\n\n## Leitura complementar\n\nTexto',
        'Intro VISIVEL_1\n\n<p>\n<strong>Gabarito do professor</strong>\n</p>\n<p>1. B SEGREDO_1</p>\n\n## Leitura complementar\n\nTexto VISIVEL_2',
        '1. Questão sobre IP VISIVEL_1\n\n   ### Gabarito do professor\n\n   B SEGREDO_1\n\n2. Questão sobre DNS VISIVEL_2\n\n3. Questão sobre HTTP VISIVEL_3\n\n## Leitura complementar\n\nTexto VISIVEL_4',
        '- ## Gabarito do professor\n  SEG_a',
        'Exemplo:\n\n```html\n<details><summary>Gabarito do professor</summary>\n```\n\nVIS_a resto da apostila\n\n## Unidade 2 VIS_b',
        '> <h2>Gabarito do professor</h2>\n> SEG_a\n\nVIS_a texto\n\n## Próximo VIS_b',
    ]) {
        assert.ok(inputs.includes(cited), `falta o achado ${cited.slice(0, 40)}...`);
    }
});

// Achado 9: o custo cresce em linha reta com o tamanho do texto (a função roda em toda
// leitura de apostila pelo aluno).
test('[UC-SIGILO-001] desempenho: 2.000 títulos HTML sem fechamento em menos de 200 ms', () => {
    const inputs = {
        'títulos HTML sem fechamento na mesma linha': `<h2>Gabarito do professor</h2>\n${'<h2>x '.repeat(2000)}`,
        'títulos HTML sem fechamento, um por linha': `<h2>Gabarito do professor</h2>\n${'<h2>x\n'.repeat(2000)}`,
        'títulos HTML sem fechamento, sem título do professor': `<p>Texto</p>\n${'<h3>x '.repeat(2000)}`,
        '<details> sem fechamento': '<details><summary>Gabarito do professor</summary>\n'.repeat(2000),
        'itens de lista aninhados na mesma linha': `${'- '.repeat(2000)}**Gabarito do professor**`,
        'código inline com 2.000 tamanhos de crase': Array.from({ length: 2000 }, (_, index) => `${'`'.repeat(index + 1)} a `).join(''),
        'título com 2.000 espaços antes do texto': `# a${' '.repeat(2000 * 50)}b`,
        '<pre> fechados na mesma linha': '<pre>x</pre>'.repeat(2000),
    };
    for (const [name, input] of Object.entries(inputs)) {
        const started = process.hrtime.bigint();
        stripAnswerKeyBlocks(input);
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        assert.ok(elapsed < 200, `${name}: ${elapsed.toFixed(1)} ms`);
    }
});
