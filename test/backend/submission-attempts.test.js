// Regra das tentativas (ENG-02): testes de tabela de calculateAttemptResult e
// consolidateSubmissions (backend/utils/submissionAttempts.js), a única conta que
// decide a nota de uma prova feita mais de uma vez. Resultados, quadro, boletim,
// portal do aluno e ficha usam o resultado dela; o navegador não recalcula.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateAttemptResult,
    consolidateSubmissions,
    enrichSubmissionsWithAttemptResult,
    normalizeScore,
    roundGrade,
} = require('../../backend/utils/submissionAttempts.js');

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
let seq = 0;
// Tentativa: score e minutos depois de T0; o resto vem de `extra`.
function attempt(score, minutes, extra = {}) {
    seq += 1;
    return {
        id: extra.id || `t${seq}`,
        score,
        timestamp: new Date(T0 + minutes * 60000).toISOString(),
        student: { email: 'ana@regra.local', courseId: 'curso', studentClass: '1A' },
        examKey: 'Avaliacao_Regra',
        applicationId: 'app_1',
        ...extra,
    };
}

test('[UC-TENTATIVA-003] normalizeScore: nota vazia, texto, booleano ou fora de 0 a 100 não é nota', () => {
    const tabela = [
        [null, null], [undefined, null], ['', null], ['  ', null], [true, null], [false, null],
        ['abc', null], [NaN, null], [Infinity, null], [-5, null], [150, null], [100.0001, null],
        [0, 0], [100, 100], [85, 85], ['85', 85], [' 72,5 ', 72.5], ['72.5', 72.5],
    ];
    for (const [entrada, esperado] of tabela) {
        assert.equal(normalizeScore(entrada), esperado, `normalizeScore(${JSON.stringify(entrada)})`);
    }
});

test('[UC-TENTATIVA-003] roundGrade: uma casa, metade para cima, sem ruído de ponto flutuante', () => {
    const tabela = [[73.5, 7.4], [73.49, 7.3], [73.35, 7.3], [89.9, 9], [59.5, 6], [59.4, 5.9], [0, 0], [100, 10], [null, null], [150, null]];
    for (const [score, nota] of tabela) assert.equal(roundGrade(score), nota, `roundGrade(${score})`);
    // Média 7,35 que o ponto flutuante guarda como 73,49999…: continua 7,4.
    assert.equal(roundGrade((72.2 + 74.8) / 2), 7.4);
});

// Cada linha: política, tentativas (score, minutos, extra) -> nota esperada e quem compõe.
const CASOS = [
    {
        nome: 'maior nota (padrão sem política)',
        tentativas: [[60, 0], [80, 10], [70, 20]],
        esperado: { policy: 'highest', score: 80, compoe: [1] },
    },
    {
        nome: 'maior nota com empate: vale a mais recente',
        tentativas: [[80, 0, { aggregationPolicy: 'highest' }], [80, 30]],
        esperado: { policy: 'highest', score: 80, compoe: [1] },
    },
    {
        nome: 'última: a mais recente entre as que contam',
        tentativas: [[90, 0, { aggregationPolicy: 'latest' }], [40, 10]],
        esperado: { policy: 'latest', score: 40, compoe: [1] },
    },
    {
        nome: 'última com a mais recente arquivada: vale a anterior',
        tentativas: [[90, 0, { aggregationPolicy: 'latest' }], [40, 10, { resultStatus: 'archived' }]],
        esperado: { policy: 'latest', score: 90, compoe: [0] },
    },
    {
        nome: 'última com a mais recente sem nota (null): não vira 0',
        tentativas: [[70, 0, { aggregationPolicy: 'latest' }], [null, 10]],
        esperado: { policy: 'latest', score: 70, compoe: [0] },
    },
    {
        nome: 'média das consideradas',
        tentativas: [[80, 0, { aggregationPolicy: 'average' }], [60, 10], [100, 20]],
        esperado: { policy: 'average', score: 80, compoe: [0, 1, 2] },
    },
    {
        nome: 'média: nota null fica fora (80 e null dão 80, não 40)',
        tentativas: [[80, 0, { aggregationPolicy: 'average' }], [null, 10]],
        esperado: { policy: 'average', score: 80, compoe: [0] },
    },
    {
        nome: "média: '' , texto, 150 e -5 ficam fora; '85' (texto numérico) conta",
        tentativas: [[70, 0, { aggregationPolicy: 'average' }], ['', 1], ['abc', 2], [150, 3], [-5, 4], ['85', 5]],
        esperado: { policy: 'average', score: 77.5, compoe: [0, 5] },
    },
    {
        nome: 'média: arquivada fica fora',
        tentativas: [[100, 0, { aggregationPolicy: 'average' }], [50, 10, { archived: true }], [70, 20]],
        esperado: { policy: 'average', score: 85, compoe: [0, 2] },
    },
    {
        nome: 'escolhida: vale a marcada pelo professor, mesmo menor',
        tentativas: [[90, 0, { aggregationPolicy: 'selected' }], [50, 10, { selectedForResult: true }], [70, 20]],
        esperado: { policy: 'selected', score: 50, compoe: [1] },
    },
    {
        nome: 'escolhida sem marca: cai na mais recente (não na primeira)',
        tentativas: [[90, 0, { aggregationPolicy: 'selected' }], [50, 10], [70, 20]],
        esperado: { policy: 'selected', score: 70, compoe: [2] },
    },
    {
        nome: 'escolhida arquivada: cai na mais recente que conta',
        tentativas: [[90, 0, { aggregationPolicy: 'selected', selectedForResult: true, resultStatus: 'archived' }], [50, 10], [70, 20]],
        esperado: { policy: 'selected', score: 70, compoe: [2] },
    },
    {
        nome: 'política lida da tentativa mais recente que tem uma',
        tentativas: [[90, 0, { aggregationPolicy: 'highest' }], [50, 10, { aggregationPolicy: 'latest' }], [70, 20]],
        esperado: { policy: 'latest', score: 70, compoe: [2] },
    },
    {
        nome: 'política inválida é ignorada (vale a válida mais recente)',
        tentativas: [[90, 0, { aggregationPolicy: 'average' }], [50, 10, { aggregationPolicy: 'pior' }]],
        esperado: { policy: 'average', score: 70, compoe: [0, 1] },
    },
    {
        nome: 'todas arquivadas: sem nota',
        tentativas: [[90, 0, { resultStatus: 'archived' }], [50, 10, { archived: true }]],
        esperado: { policy: 'highest', score: null, compoe: [] },
    },
    {
        nome: 'só notas inválidas: sem nota (nunca 0)',
        tentativas: [[null, 0, { aggregationPolicy: 'latest' }], ['', 10]],
        esperado: { policy: 'latest', score: null, compoe: [] },
    },
    // Anulação por integridade e correção pendente (P3-S4a, contrato C1 do P3): a nota
    // gravada não muda; 'zero' entra como 0, 'desconsiderar' e a correção pendente ficam
    // fora, e a pendente marca o grupo (aguardandoCorrecao).
    {
        nome: 'anulada com zero entra como 0 (maior nota fica com a outra)',
        tentativas: [[90, 0, { integrity: { decisao: 'zero', motivo: 'cola' } }], [50, 10]],
        esperado: { policy: 'highest', score: 50, compoe: [1] },
    },
    {
        nome: 'anulada com zero na média conta 0',
        tentativas: [[90, 0, { aggregationPolicy: 'average', integrity: { decisao: 'zero' } }], [60, 10]],
        esperado: { policy: 'average', score: 30, compoe: [0, 1] },
    },
    {
        nome: 'anulada com zero e única: a nota é 0',
        tentativas: [[90, 0, { integrity: { decisao: 'zero' } }]],
        esperado: { policy: 'highest', score: 0, compoe: [0] },
    },
    {
        nome: 'anulada "não conta" fica fora da média',
        tentativas: [[90, 0, { aggregationPolicy: 'average', integrity: { decisao: 'desconsiderar' } }], [60, 10]],
        esperado: { policy: 'average', score: 60, compoe: [1] },
    },
    {
        nome: 'anulada "não conta" e única: sem nota',
        tentativas: [[90, 0, { integrity: { decisao: 'desconsiderar' } }]],
        esperado: { policy: 'highest', score: null, compoe: [] },
    },
    {
        nome: 'escolhida e anulada "não conta": cai na mais recente que conta',
        tentativas: [[90, 0, { aggregationPolicy: 'selected', selectedForResult: true, integrity: { decisao: 'desconsiderar' } }], [50, 10], [70, 20]],
        esperado: { policy: 'selected', score: 70, compoe: [2] },
    },
    {
        nome: 'anulação desfeita volta a contar como era',
        tentativas: [[90, 0, { integrity: { decisao: 'zero', desfeitaEm: T0 + 1 } }], [50, 10]],
        esperado: { policy: 'highest', score: 90, compoe: [0] },
    },
    {
        nome: 'decisão desconhecida é ignorada',
        tentativas: [[90, 0, { integrity: { decisao: 'apagar' } }]],
        esperado: { policy: 'highest', score: 90, compoe: [0] },
    },
    {
        nome: 'aguardando correção fica fora e marca o grupo',
        tentativas: [[90, 0, { correcao: { situacao: 'pendente', versao: 1, itens: {} } }], [50, 10]],
        esperado: { policy: 'highest', score: 50, compoe: [1], aguardando: true },
    },
    {
        nome: 'só tentativa aguardando correção: sem nota parcial',
        tentativas: [[45, 0, { correcao: { situacao: 'pendente', versao: 1, itens: {} } }]],
        esperado: { policy: 'highest', score: null, compoe: [], aguardando: true },
    },
    {
        nome: 'mais recente aguardando correção: vale a mais recente que conta',
        tentativas: [[70, 0, { aggregationPolicy: 'latest' }], [90, 10, { correcao: { situacao: 'pendente', versao: 1, itens: {} } }]],
        esperado: { policy: 'latest', score: 70, compoe: [0], aguardando: true },
    },
    {
        nome: 'correção concluída conta',
        tentativas: [[90, 0, { correcao: { situacao: 'concluida', versao: 3, itens: {} }, gradedAnswers: [{ questionNumber: 1, pending: true }] }], [50, 10]],
        esperado: { policy: 'highest', score: 90, compoe: [0] },
    },
    {
        nome: 'entrega antiga sem correcao com questão pendente também espera',
        tentativas: [[90, 0, { gradedAnswers: [{ questionNumber: 1, pending: true }, { questionNumber: 2, pending: false }] }], [50, 10]],
        esperado: { policy: 'highest', score: 50, compoe: [1], aguardando: true },
    },
    {
        nome: 'questão pendente anulada não espera',
        tentativas: [[90, 0, { gradedAnswers: [{ questionNumber: 1, pending: true, annulled: true }] }]],
        esperado: { policy: 'highest', score: 90, compoe: [0] },
    },
    {
        nome: 'pendente e anulada com zero: vale 0 e não espera',
        tentativas: [[90, 0, { correcao: { situacao: 'pendente', versao: 1, itens: {} }, integrity: { decisao: 'zero' } }]],
        esperado: { policy: 'highest', score: 0, compoe: [0] },
    },
    {
        nome: 'pendente e anulada "não conta": fora e não espera',
        tentativas: [[90, 0, { correcao: { situacao: 'pendente', versao: 1, itens: {} }, integrity: { decisao: 'desconsiderar' } }], [40, 10]],
        esperado: { policy: 'highest', score: 40, compoe: [1] },
    },
    {
        nome: 'pendente arquivada não marca o grupo',
        tentativas: [[90, 0, { correcao: { situacao: 'pendente', versao: 1, itens: {} }, resultStatus: 'archived' }], [50, 10]],
        esperado: { policy: 'highest', score: 50, compoe: [1] },
    },
];

for (const caso of CASOS) {
    test(`[UC-TENTATIVA-003] calculateAttemptResult: ${caso.nome}`, () => {
        const tentativas = caso.tentativas.map(([score, minutos, extra]) => attempt(score, minutos, extra));
        const resultado = calculateAttemptResult(tentativas);
        assert.equal(resultado.policy, caso.esperado.policy);
        assert.equal(resultado.score, caso.esperado.score);
        assert.deepEqual(resultado.contributingIds, caso.esperado.compoe.map(index => tentativas[index].id));
        assert.equal(resultado.aguardandoCorrecao, caso.esperado.aguardando === true, 'aguardandoCorrecao');
        if (caso.esperado.policy === 'average' || caso.esperado.score === null) {
            assert.equal(resultado.selectedSubmissionId, null);
        } else {
            assert.equal(resultado.selectedSubmissionId, tentativas[caso.esperado.compoe[0]].id);
        }
    });
}

test('[UC-TENTATIVA-003] a ordem de chegada das tentativas não muda o resultado', () => {
    const tentativas = [attempt(90, 0, { aggregationPolicy: 'selected' }), attempt(50, 10), attempt(70, 20)];
    const invertidas = [...tentativas].reverse();
    assert.deepEqual(calculateAttemptResult(invertidas), calculateAttemptResult(tentativas));
});

test('[UC-TENTATIVA-003] consolidateSubmissions separa por aluno, curso, turma e aplicação', () => {
    const base = { examKey: 'Avaliacao_Regra' };
    const linhas = [
        attempt(80, 0, { ...base, id: 'a1', applicationId: 'app_1' }),
        attempt(60, 5, { ...base, id: 'a2', applicationId: 'app_1' }),
        // Mesma prova, outra aplicação (reaplicação): outro grupo, outra nota.
        attempt(40, 10, { ...base, id: 'a3', applicationId: 'app_2' }),
        // Mesmo e-mail em maiúsculas: mesmo aluno.
        attempt(90, 15, { ...base, id: 'a4', applicationId: 'app_1', student: { email: 'ANA@regra.local', courseId: 'curso', studentClass: '1A' } }),
        // Outra turma e outro curso: grupos próprios.
        attempt(30, 20, { ...base, id: 'a5', applicationId: 'app_1', student: { email: 'ana@regra.local', courseId: 'curso', studentClass: '1B' } }),
        attempt(20, 25, { ...base, id: 'a6', applicationId: 'app_1', student: { email: 'ana@regra.local', courseId: 'outro', studentClass: '1A' } }),
        // Outro aluno.
        attempt(10, 30, { ...base, id: 'a7', applicationId: 'app_1', student: { email: 'bia@regra.local', courseId: 'curso', studentClass: '1A' } }),
    ];
    const grupos = consolidateSubmissions(linhas);
    const porIds = Object.fromEntries(grupos.map(grupo => [grupo.attempts.map(item => item.id).sort().join(','), grupo.score]));
    assert.deepEqual(porIds, {
        'a1,a2,a4': 90,
        a3: 40,
        a5: 30,
        a6: 20,
        a7: 10,
    });
});

test('[UC-TENTATIVA-003] consolidateSubmissions junta registro antigo sem aplicação pela prova', () => {
    const antigo = (score, minutos, examKey, id) => attempt(score, minutos, { id, applicationId: undefined, examKey });
    const grupos = consolidateSubmissions([
        antigo(50, 0, 'Avaliacao_Antiga', 'l1'),
        antigo(70, 10, 'Avaliacao_Antiga', 'l2'),
        antigo(90, 20, 'Avaliacao_Outra', 'l3'),
        // Com aplicação: nunca se mistura com o antigo da mesma prova.
        attempt(100, 30, { id: 'l4', examKey: 'Avaliacao_Antiga', applicationId: 'app_9' }),
    ]);
    const porIds = Object.fromEntries(grupos.map(grupo => [grupo.attempts.map(item => item.id).sort().join(','), grupo.score]));
    assert.deepEqual(porIds, { 'l1,l2': 70, l3: 90, l4: 100 });
    assert.deepEqual(consolidateSubmissions([]), []);
    assert.deepEqual(consolidateSubmissions(null), []);
});

test('[UC-TENTATIVA-003] enrich marca em cada tentativa a nota do grupo e se ela compõe', () => {
    const linhas = [
        attempt(60, 0, { id: 'e1', aggregationPolicy: 'average' }),
        attempt(80, 10, { id: 'e2' }),
        attempt(null, 20, { id: 'e3' }),
        attempt(100, 30, { id: 'e4', resultStatus: 'archived' }),
    ];
    const enriquecidas = enrichSubmissionsWithAttemptResult(linhas);
    const porId = Object.fromEntries(enriquecidas.map(item => [item.id, item]));
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
        assert.equal(porId[id].consolidatedScore, 70, `${id} leva a nota do grupo`);
        assert.equal(porId[id].aggregationPolicy, 'average');
    }
    assert.equal(porId.e1.countsTowardResult, true);
    assert.equal(porId.e2.countsTowardResult, true);
    assert.equal(porId.e3.countsTowardResult, false);
    assert.equal(porId.e3.scoreInvalid, true);
    assert.equal(porId.e4.countsTowardResult, false);
    assert.equal(porId.e4.resultStatus, 'archived');
    assert.equal(porId.e1.resultStatus, 'considered');
    // Grupo sem nota válida: consolidatedScore null em todas (a tela mostra "-").
    const vazio = enrichSubmissionsWithAttemptResult([attempt(null, 0, { id: 'v1', applicationId: 'app_v' })]);
    assert.equal(vazio[0].consolidatedScore, null);
    assert.equal(vazio[0].countsTowardResult, false);
});
