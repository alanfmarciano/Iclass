// Leitura das avaliações antigas em Markdown (backend/utils/parser.js, ENG-02):
// gabarito detalhado e compacto, alternativas de a) a e), questão sem gabarito,
// título com emoji e recusa explícita (com aviso) de letra depois de e).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-parser-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const { avisosDaAvaliacaoGravada, importWarningsFor, parseEvaluationMarkdown, parseEvaluationMarkdownWithWarnings } = require('../../backend/utils/parser.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const REPO_CONTENT = path.join(__dirname, '..', '..', 'content');
let app;
const adminToken = 'admin-token-parser';

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.admins = [{ email: 'admin@parser.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') }];
    db.memory.adminSessions = { [adminToken]: { email: 'admin@parser.local', createdAt: Date.now(), lastSeen: Date.now() } };
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function prova({ questoes, gabarito = '', titulo = '# 📝 Avaliação: Redes 1', extra = '' }) {
    return [
        titulo,
        '---',
        '',
        '**Tema:** Endereçamento IP',
        '',
        '## Parte 1: Quiz',
        '',
        ...questoes,
        extra,
        gabarito ? `<details>\n<summary>Gabarito</summary>\n\n${gabarito}\n</details>` : '',
    ].join('\n');
}

const Q1 = '**1. Quantos bits tem um endereço IPv4?**\na) 16\nb) 32\nc) 64\nd) 128\n';
const Q2 = '**2. Qual camada roteia pacotes?**\na) Física\nb) Enlace\nc) Rede\nd) Transporte\ne) Aplicação\n';
const Q3 = '**3. Qual protocolo resolve nomes?**\na) DNS\nb) DHCP\n';

test('[UC-TENTATIVA-003] título sem emoji, tema e gabarito detalhado "1. **C**"', () => {
    const avaliacao = parseEvaluationMarkdown(prova({ questoes: [Q1, Q2, Q3], gabarito: '1. **B**\n2. **E**\n3. **A**' }), 'Avaliacao_REDES_1');
    assert.equal(avaliacao.key, 'Avaliacao_REDES_1');
    assert.equal(avaliacao.title, 'Avaliação: Redes 1');
    assert.equal(avaliacao.theme, 'Endereçamento IP');
    assert.deepEqual(avaliacao.questions.map(q => [q.originalNumber, q.correctAnswer, q.alternatives.length]), [[1, 'B', 4], [2, 'E', 5], [3, 'A', 2]]);
    assert.equal(avaliacao.questions[0].text, 'Quantos bits tem um endereço IPv4?');
    assert.equal(avaliacao.questions[0].weight, 1);
    assert.deepEqual(avaliacao.questions[0].alternatives.map(a => [a.letter, a.text, a.isCorrect]), [
        ['A', '16', false], ['B', '32', true], ['C', '64', false], ['D', '128', false],
    ]);
});

test('[UC-TENTATIVA-003] alternativa e) é aceita: não se cola na d) e o gabarito "E" vale', () => {
    const avaliacao = parseEvaluationMarkdown(prova({ questoes: [Q2], gabarito: '2. **E**' }), 'Avaliacao_E');
    const [questao] = avaliacao.questions;
    assert.deepEqual(questao.alternatives.map(a => a.letter), ['A', 'B', 'C', 'D', 'E']);
    assert.equal(questao.alternatives[3].text, 'Transporte', 'a e) ficava colada no texto da d)');
    assert.equal(questao.alternatives[4].text, 'Aplicação');
    assert.equal(questao.correctAnswer, 'E');
    assert.equal(questao.alternatives[4].isCorrect, true);
});

test('[UC-TENTATIVA-003] gabarito compacto "1. C" (minúscula também) quando não há o detalhado', () => {
    const avaliacao = parseEvaluationMarkdown(prova({ questoes: [Q1, Q2], gabarito: '1. b\n2. E' }), 'Avaliacao_C');
    assert.deepEqual(avaliacao.questions.map(q => q.correctAnswer), ['B', 'E']);
});

test('[UC-TENTATIVA-003] questão sem gabarito fica com correctAnswer vazio e nenhuma alternativa certa', () => {
    const { evaluation, avisos } = parseEvaluationMarkdownWithWarnings(prova({ questoes: [Q1, Q3], gabarito: '1. **B**' }), 'Avaliacao_S');
    assert.equal(evaluation.questions[1].correctAnswer, '');
    assert.ok(evaluation.questions[1].alternatives.every(a => a.isCorrect === false));
    assert.deepEqual(avisos, []);
    // Sem <details>, nenhuma tem gabarito.
    const semGabarito = parseEvaluationMarkdown(prova({ questoes: [Q1] }), 'Avaliacao_SG');
    assert.equal(semGabarito.questions[0].correctAnswer, '');
});

test('[UC-TENTATIVA-003] letra f) é recusada com aviso, nunca descartada em silêncio', () => {
    const q = '**1. Qual é a porta do HTTPS?**\na) 21\nb) 22\nc) 80\nd) 8080\ne) 8443\nf) 443\n';
    const { evaluation, avisos } = parseEvaluationMarkdownWithWarnings(prova({ questoes: [q], gabarito: '1. **F**' }), 'Avaliacao_F');
    const [questao] = evaluation.questions;
    assert.deepEqual(questao.alternatives.map(a => a.letter), ['A', 'B', 'C', 'D', 'E']);
    assert.equal(questao.alternatives[4].text, '8443', 'a f) não entra no texto da e)');
    assert.equal(questao.correctAnswer, '');
    assert.deepEqual(avisos, [
        'Questão 1: o gabarito "F" não é aceito (use de A a E). A questão ficou sem gabarito.',
        'Questão 1: a alternativa f) não é aceita (use de a) a e)) e ficou de fora.',
    ]);
    // A função de sempre devolve só a avaliação (sem avisos dentro do registro gravado).
    assert.equal(Object.prototype.hasOwnProperty.call(parseEvaluationMarkdown(prova({ questoes: [q] }), 'x'), 'avisos'), false);
});

test('[UC-TENTATIVA-003] gabarito para letra que a questão não tem gera aviso', () => {
    const { evaluation, avisos } = parseEvaluationMarkdownWithWarnings(prova({ questoes: [Q3], gabarito: '3. **D**' }), 'Avaliacao_D');
    assert.equal(evaluation.questions[0].correctAnswer, 'D');
    assert.deepEqual(avisos, ['Questão 3: o gabarito é D, mas a questão não tem a alternativa d).']);
});

test('[UC-TENTATIVA-003] parêntese no meio do texto não vira alternativa; texto vazio não é nota', () => {
    const q = '**1. Em f(x) = 2x, quanto vale f(3)?**\na) 5 (ver item b) acima)\nb) 6\nc) 9\n';
    const avaliacao = parseEvaluationMarkdown(prova({ questoes: [q], gabarito: '1. **B**' }), 'Avaliacao_P');
    assert.deepEqual(avaliacao.questions[0].alternatives.map(a => [a.letter, a.text]), [['A', '5 (ver item b) acima)'], ['B', '6'], ['C', '9']]);
    assert.equal(parseEvaluationMarkdown('', 'x'), null);
    assert.deepEqual(parseEvaluationMarkdownWithWarnings(null, 'x'), { evaluation: null, avisos: [] });
});

test('[UC-TENTATIVA-003] questão com menos de duas alternativas fica fora; rubrica da Parte 2 é lida', () => {
    const md = prova({
        questoes: ['**1. Só uma?**\na) sim\n', Q3],
        extra: '## Parte 2: Prática\n\nMonte a rede da figura.\n',
        gabarito: '3. **A**',
    });
    const { evaluation: avaliacao, avisos } = parseEvaluationMarkdownWithWarnings(md, 'Avaliacao_R');
    assert.deepEqual(avaliacao.questions.map(q => q.originalNumber), [3]);
    assert.match(avaliacao.rubric, /^## Parte 2: Prática/);
    // A questão que fica de fora sai com aviso (D21: nunca descartada em silêncio).
    assert.deepEqual(avisos, ['Questão 1: só 1 alternativa reconhecida (escreva cada uma no começo da linha, como "a) texto"). A questão ficou de fora.']);
    assert.equal(parseEvaluationMarkdown('sem título', 'x').title, 'Avaliação');
    // Alternativas na mesma linha não são reconhecidas: aviso, não sumiço.
    const naMesmaLinha = parseEvaluationMarkdownWithWarnings(prova({ questoes: ['**1. Qual?**\na) um   b) dois   c) três\n'], gabarito: '1. **B**' }), 'x');
    assert.deepEqual(naMesmaLinha.evaluation.questions, []);
    assert.equal(naMesmaLinha.avisos.length, 1);
    assert.match(naMesmaLinha.avisos[0], /^Questão 1: só 1 alternativa reconhecida .* A questão ficou de fora\.$/);
    const semNenhuma = parseEvaluationMarkdownWithWarnings(prova({ questoes: ['**1. Explique o modelo OSI.**\nResposta livre.\n'] }), 'x');
    assert.deepEqual(semNenhuma.avisos, ['Questão 1: nenhuma alternativa reconhecida (escreva cada uma no começo da linha, como "a) texto"). A questão ficou de fora.']);
});

test('[UC-TENTATIVA-003] alternativas em negrito ou em lista são lidas, sem os asteriscos no texto', () => {
    const negrito = parseEvaluationMarkdownWithWarnings(prova({ questoes: ['**1. Pergunta?**\n**a)** um\n**b)** dois\n**c) três**\n'], gabarito: '1. **A**' }), 'x');
    assert.deepEqual(negrito.avisos, []);
    assert.deepEqual(negrito.evaluation.questions[0].alternatives.map(a => [a.letter, a.text, a.isCorrect]), [['A', 'um', true], ['B', 'dois', false], ['C', 'três', false]]);
    const lista = parseEvaluationMarkdownWithWarnings(prova({ questoes: ['**2. Pergunta?**\n- a) um\n- b) dois\n* c) três\n'], gabarito: '2. **C**' }), 'x');
    assert.deepEqual(lista.avisos, []);
    assert.deepEqual(lista.evaluation.questions[0].alternatives.map(a => [a.letter, a.text]), [['A', 'um'], ['B', 'dois'], ['C', 'três']]);
    assert.equal(lista.evaluation.questions[0].correctAnswer, 'C');
});

test('[UC-TENTATIVA-003] "**a)** texto em **negrito**": o negrito do fim do texto continua fechado', () => {
    // Antes o "**" do fim saía mesmo quando o negrito já tinha fechado logo depois de "a)".
    const md = prova({ questoes: ['**1. Qual comando lista arquivos?**\n**a)** usa o comando **ls**\n**b)** usa **cd**\n__c)__ usa __pwd__\n**d) tudo em negrito**\n'], gabarito: '1. **A**' });
    const { evaluation, avisos } = parseEvaluationMarkdownWithWarnings(md, 'x');
    assert.deepEqual(avisos, []);
    assert.deepEqual(evaluation.questions[0].alternatives.map(a => a.text), ['usa o comando **ls**', 'usa **cd**', 'usa __pwd__', 'tudo em negrito']);
});

test('[UC-TENTATIVA-003] gabarito compacto: texto livre depois não apaga a letra da questão', () => {
    // "Nota: a questão 2. O enunciado..." casava como "2. O" e, com o último valendo,
    // a questão 2 perdia o "C" (o parser antigo, só A-D, mantinha).
    const q2 = '**2. Qual camada roteia pacotes?**\na) Física\nb) Enlace\nc) Rede\nd) Transporte\n';
    const md = prova({ questoes: [Q1, q2], gabarito: '1. B\n2. C\n\nNota: a questão 2. O enunciado foi revisto.' });
    const { evaluation, avisos } = parseEvaluationMarkdownWithWarnings(md, 'x');
    assert.deepEqual(evaluation.questions.map(q => q.correctAnswer), ['B', 'C']);
    assert.deepEqual(avisos, []);
    // Igual ao parser antigo nesse caso; com só letra recusada, a recusa continua avisada.
    const soRecusada = parseEvaluationMarkdownWithWarnings(prova({ questoes: [Q1], gabarito: '1. F' }), 'x');
    assert.equal(soRecusada.evaluation.questions[0].correctAnswer, '');
    assert.match(soRecusada.avisos[0], /^Questão 1: o gabarito "F" não é aceito/);
    // A primeira letra aceita vale também quando a recusada vem antes.
    const depois = parseEvaluationMarkdownWithWarnings(prova({ questoes: [Q1], gabarito: '1. F\n1. B' }), 'x');
    assert.equal(depois.evaluation.questions[0].correctAnswer, 'B');
    assert.deepEqual(depois.avisos, []);
});

test('[UC-TENTATIVA-003] aviso de importação vem da avaliação gravada, não de um .md que não é o dela', () => {
    const md = prova({ questoes: ['**1. Porta do HTTPS?**\na) 21\nb) 22\nc) 80\nd) 8080\ne) 8443\nf) 443\n'], gabarito: '1. **E**' });
    const doArquivo = parseEvaluationMarkdown(md, 'x');
    // Gravada a partir deste arquivo: os avisos do arquivo valem.
    assert.deepEqual(importWarningsFor(doArquivo, md, 'x'), ['Questão 1: a alternativa f) não é aceita (use de a) a e)) e ficou de fora.']);
    // Outros campos que as telas acrescentam (revisão não, mas weight, title) não contam.
    assert.equal(importWarningsFor({ ...doArquivo, title: 'Outro título', courseId: 'c1' }, md, 'x').length, 1);
    // Avaliação gravada com outro conteúdo (seed de demonstração, prova editada por outro
    // caminho): o aviso do arquivo não tem a ver com ela.
    const outra = { key: 'x', title: 'Seed', questions: [{ originalNumber: 1, text: 'Outra?', correctAnswer: 'B', alternatives: [{ letter: 'A', text: 'um' }, { letter: 'B', text: 'dois' }] }] };
    assert.deepEqual(importWarningsFor(outra, md, 'x'), []);
    assert.deepEqual(importWarningsFor(outra, '', 'x'), []);
    assert.deepEqual(importWarningsFor(null, md, 'x'), []);

    // Gravada pela versão antiga (só a-d): a e) entrou no texto da d) e o gabarito "E"
    // sumiu. O arquivo de hoje é lido sem problema, mas a gravada continua quebrada e avisa.
    const comE = prova({ questoes: [Q2], gabarito: '2. **E**' });
    const antiga = { key: 'x', title: 'Redes', questions: [{ originalNumber: 2, text: 'Qual camada roteia pacotes?', weight: 1, correctAnswer: '', alternatives: [
        { letter: 'A', text: 'Física', isCorrect: false }, { letter: 'B', text: 'Enlace', isCorrect: false },
        { letter: 'C', text: 'Rede', isCorrect: false }, { letter: 'D', text: 'Transporte\ne) Aplicação', isCorrect: false },
    ] }] };
    assert.deepEqual(parseEvaluationMarkdownWithWarnings(comE, 'x').avisos, []);
    const aviso = ['Questão 2: a alternativa e) ficou colada no texto da d) (a prova foi lida por uma versão que só aceitava de a) a d)). Abra a prova no editor, separe as alternativas, escolha o gabarito e salve.'];
    assert.deepEqual(importWarningsFor(antiga, comE, 'x'), aviso);
    assert.deepEqual(avisosDaAvaliacaoGravada(antiga), aviso);
    // Com gabarito gravado, o aviso não pede para escolher o gabarito.
    const comGabarito = { ...antiga, questions: [{ ...antiga.questions[0], correctAnswer: 'C' }] };
    assert.match(avisosDaAvaliacaoGravada(comGabarito)[0], /separe as alternativas e salve\.$/);
    // Parêntese no meio da linha não é alternativa colada.
    assert.deepEqual(avisosDaAvaliacaoGravada({ questions: [{ originalNumber: 1, alternatives: [{ letter: 'A', text: 'veja o item b) acima' }] }] }), []);
    assert.deepEqual(avisosDaAvaliacaoGravada({}), []);
});

test('[UC-TENTATIVA-003] letra estranha no gabarito de questão que não existe não gera aviso', () => {
    // "2. O gabarito..." numa observação do <details> compacto não é a questão 2.
    const md = prova({ questoes: [Q3], gabarito: '3. A\nObs.: 2. O gabarito foi revisado.' });
    const { evaluation, avisos } = parseEvaluationMarkdownWithWarnings(md, 'x');
    assert.equal(evaluation.questions[0].correctAnswer, 'A');
    assert.deepEqual(avisos, []);
});

test('[UC-TENTATIVA-003] as avaliações de exemplo do repositório são lidas sem aviso', () => {
    const dir = REPO_CONTENT;
    const arquivos = fs.readdirSync(dir).filter(nome => /^Avaliacao_.*\.md$/.test(nome));
    assert.ok(arquivos.length > 0);
    for (const nome of arquivos) {
        const { evaluation, avisos } = parseEvaluationMarkdownWithWarnings(fs.readFileSync(path.join(dir, nome), 'utf8'), nome.replace(/\.md$/, ''));
        assert.deepEqual(avisos, [], nome);
        assert.ok(evaluation.questions.length > 0, nome);
        for (const questao of evaluation.questions) {
            assert.ok(questao.alternatives.length >= 2 && questao.alternatives.length <= 5, `${nome} questão ${questao.originalNumber}`);
            assert.ok(questao.alternatives.every(a => 'ABCDE'.includes(a.letter)));
        }
    }
});

test('[UC-TENTATIVA-003] abrir no painel prova antiga em .md com f): avisa a cada abertura até salvar no editor, sem gravar o aviso', async () => {
    const md = prova({ questoes: ['**1. Porta do HTTPS?**\na) 21\nb) 22\nc) 80\nd) 8080\ne) 8443\nf) 443\n'], gabarito: '1. **E**' });
    fs.mkdirSync(process.env.ICLASS_CONTENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.ICLASS_CONTENT_DIR, 'Avaliacao_Antiga_F.md'), md);
    const aviso = ['Questão 1: a alternativa f) não é aceita (use de a) a e)) e ficou de fora.'];
    const primeira = await request(app).get('/api/admin/evaluation/Avaliacao_Antiga_F').set('x-admin-session', adminToken).expect(200);
    assert.deepEqual(primeira.body.questions[0].alternatives.map(a => a.letter), ['A', 'B', 'C', 'D', 'E']);
    assert.equal(primeira.body.questions[0].correctAnswer, 'E');
    assert.deepEqual(primeira.body.avisosImportacao, aviso);
    // A avaliação gravada não leva os avisos; a segunda abertura (já do banco) avisa de novo.
    assert.equal('avisosImportacao' in db.memory.evaluations.Avaliacao_Antiga_F, false);
    const segunda = await request(app).get('/api/admin/evaluation/Avaliacao_Antiga_F').set('x-admin-session', adminToken).expect(200);
    assert.deepEqual(segunda.body.avisosImportacao, aviso);
    assert.equal(segunda.body.questions.length, 1);

    // Quem gravou primeiro foi outra tela ou o boot (registro sem revision): o aviso vem.
    fs.writeFileSync(path.join(process.env.ICLASS_CONTENT_DIR, 'Avaliacao_Antiga_G.md'), md);
    db.memory.evaluations.Avaliacao_Antiga_G = parseEvaluationMarkdown(md, 'Avaliacao_Antiga_G');
    const doBoot = await request(app).get('/api/admin/evaluation/Avaliacao_Antiga_G').set('x-admin-session', adminToken).expect(200);
    assert.deepEqual(doBoot.body.avisosImportacao, aviso);

    // Salvar no editor é a revisão do professor: o aviso some.
    await request(app).put('/api/admin/evaluation/Avaliacao_Antiga_F').set('x-admin-session', adminToken)
        .send({ ...segunda.body, avisosImportacao: undefined }).expect(200);
    assert.equal('avisosImportacao' in db.memory.evaluations.Avaliacao_Antiga_F, false);
    const depois = await request(app).get('/api/admin/evaluation/Avaliacao_Antiga_F').set('x-admin-session', adminToken).expect(200);
    assert.equal('avisosImportacao' in depois.body, false);

    // Avaliação do banco sem revision com conteúdo diferente do .md (o seed de
    // demonstração com a FUTEC_1 de 4 questões): o aviso do arquivo não aparece.
    fs.writeFileSync(path.join(process.env.ICLASS_CONTENT_DIR, 'Avaliacao_Seed_H.md'), md);
    db.memory.evaluations.Avaliacao_Seed_H = { key: 'Avaliacao_Seed_H', title: 'Seed', questions: [
        { originalNumber: 1, text: 'Outra pergunta', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'um', isCorrect: true }, { letter: 'B', text: 'dois', isCorrect: false }] },
    ] };
    const doSeed = await request(app).get('/api/admin/evaluation/Avaliacao_Seed_H').set('x-admin-session', adminToken).expect(200);
    assert.equal('avisosImportacao' in doSeed.body, false);
    // Importada pela versão antiga (e) colada na d), gabarito vazio): avisa, mesmo com o
    // .md de hoje lido sem problema.
    const comE = prova({ questoes: [Q2], gabarito: '2. **E**' });
    fs.writeFileSync(path.join(process.env.ICLASS_CONTENT_DIR, 'Avaliacao_Antiga_I.md'), comE);
    db.memory.evaluations.Avaliacao_Antiga_I = { key: 'Avaliacao_Antiga_I', title: 'Redes', questions: [
        { originalNumber: 2, text: 'Qual camada roteia pacotes?', weight: 1, correctAnswer: '', alternatives: [
            { letter: 'A', text: 'Física', isCorrect: false }, { letter: 'B', text: 'Enlace', isCorrect: false },
            { letter: 'C', text: 'Rede', isCorrect: false }, { letter: 'D', text: 'Transporte\ne) Aplicação', isCorrect: false },
        ] },
    ] };
    const daVersaoAntiga = await request(app).get('/api/admin/evaluation/Avaliacao_Antiga_I').set('x-admin-session', adminToken).expect(200);
    assert.equal(daVersaoAntiga.body.avisosImportacao.length, 1);
    assert.match(daVersaoAntiga.body.avisosImportacao[0], /^Questão 2: a alternativa e\) ficou colada no texto da d\)/);
    assert.equal('avisosImportacao' in db.memory.evaluations.Avaliacao_Antiga_I, false);

    // Prova sem .md (criada no painel) e chave com caminho não leem arquivo.
    db.memory.evaluations.Prova_Do_Painel = { key: 'Prova_Do_Painel', title: 'Nova', questions: [] };
    const doPainel = await request(app).get('/api/admin/evaluation/Prova_Do_Painel').set('x-admin-session', adminToken).expect(200);
    assert.equal('avisosImportacao' in doPainel.body, false);
    await request(app).get('/api/admin/evaluation/..%2Fsegredo').set('x-admin-session', adminToken).expect(404);
});
