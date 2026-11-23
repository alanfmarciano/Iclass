// Motor da regra acadêmica (fase 3, P2-S2; FUN-02): testes de tabela de
// backend/utils/gradingRules.js, a única conta de etapa, peso, recuperação, média final,
// situação e menção. Sem servidor nem banco: o módulo é puro.
const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../../backend/utils/gradingRules.js');
const gradebook = require('../../backend/utils/gradebook.js');

const {
    applyRecovery,
    combineSituacoes,
    computeStudentResult,
    criterioForScreen,
    faltasPermitidasRestantes,
    legacyStudentResult,
    mencaoFor,
    normalizeCriteria,
    normalizePlan,
    weightedAverage,
} = rules;

const MENCOES = [
    { sigla: 'MB', nome: 'Muito bom', min: 9 },
    { sigla: 'B', nome: 'Bom', min: 7 },
    { sigla: 'R', nome: 'Regular', min: 5 },
    { sigla: 'I', nome: 'Insuficiente', min: 0 },
];
const DUAS_ETAPAS = [{ ordem: 1, nome: '1º bimestre', peso: 1 }, { ordem: 2, nome: '2º bimestre', peso: 2 }];

const g = (examKey, score, extra = {}) => ({ examKey, score, ...extra });
const criterios = (extra = {}) => ({ ativo: true, mediaMinima: 6, frequenciaMinima: 75, ...extra });

test('[UC-NOTAS-005] normalizeCriteria: sem critérios ou desligado é a regra antiga; padrões e limites', () => {
    for (const raw of [undefined, null, 'x', 7, [], { ativo: false, mediaMinima: 5 }]) {
        assert.equal(normalizeCriteria(raw), null, JSON.stringify(raw));
    }
    const padrao = normalizeCriteria({});
    assert.deepEqual(padrao, {
        versao: 1,
        ativo: true,
        mediaMinima: 6,
        frequenciaMinima: 75,
        etapas: [{ ordem: 1, nome: 'Etapa única', peso: 1 }],
        recuperacao: { etapa: 'nenhuma', final: 'substitui_se_maior' },
        mencoes: null,
        unidadeSituacao: 'disciplina',
    });
    const tabela = [
        // [campo, valor gravado, valor normalizado]
        ['mediaMinima', '5,5', 5.5], ['mediaMinima', 10.5, 6], ['mediaMinima', -1, 6], ['mediaMinima', '', 6], ['mediaMinima', 0, 0], ['mediaMinima', 7.25, 7.3],
        ['frequenciaMinima', 74.6, 75], ['frequenciaMinima', 101, 75], ['frequenciaMinima', 0, 0], ['frequenciaMinima', 'abc', 75],
        ['unidadeSituacao', 'turma', 'turma'], ['unidadeSituacao', 'escola', 'disciplina'],
    ];
    for (const [campo, valor, esperado] of tabela) {
        assert.equal(normalizeCriteria({ [campo]: valor })[campo], esperado, `${campo} ${JSON.stringify(valor)}`);
    }
    // Etapas: ordem 1 a 6, sem repetição, em ordem; peso 0,1 a 10 (fora disso, 1); nome padrão.
    const etapas = normalizeCriteria({
        etapas: [
            { ordem: 2, nome: '  2º   bim ', peso: 0.1 }, { ordem: 1, peso: 10 }, { ordem: 1, peso: 3 },
            { ordem: 7, peso: 1 }, { ordem: 3, peso: 0 }, { ordem: 4, peso: 11 }, { ordem: 'x' }, null,
        ],
    }).etapas;
    assert.deepEqual(etapas, [
        { ordem: 1, nome: '1ª etapa', peso: 10 },
        { ordem: 2, nome: '2º bim', peso: 0.1 },
        { ordem: 3, nome: '3ª etapa', peso: 1 },
        { ordem: 4, nome: '4ª etapa', peso: 1 },
    ]);
    assert.deepEqual(normalizeCriteria({ etapas: [] }).etapas, [{ ordem: 1, nome: 'Etapa única', peso: 1 }]);
    assert.deepEqual(normalizeCriteria({ recuperacao: { etapa: 'media', final: 'qualquer' } }).recuperacao, { etapa: 'media', final: 'substitui_se_maior' });
    // Menções: da maior mínima para a menor, sem sigla vazia nem mínima fora de 0 a 10.
    assert.deepEqual(normalizeCriteria({ mencoes: [{ sigla: 'I', min: 0 }, { sigla: 'MB', nome: 'Muito bom', min: '9' }, { sigla: '', min: 5 }, { sigla: 'X', min: 11 }, { sigla: 'B', min: 7 }] }).mencoes, [
        { sigla: 'MB', nome: 'Muito bom', min: 9 }, { sigla: 'B', nome: 'B', min: 7 }, { sigla: 'I', nome: 'I', min: 0 },
    ]);
    assert.equal(normalizeCriteria({ mencoes: [] }).mencoes, null);
    assert.deepEqual(criterioForScreen(undefined), { mediaMinima: 6, mencoes: null, regraAntiga: true });
    assert.deepEqual(criterioForScreen({ mediaMinima: 5, mencoes: MENCOES }), { mediaMinima: 5, mencoes: MENCOES, regraAntiga: false });
    // O critério da regra antiga é o mesmo padrão de gradebook.js (gradeBand e telas).
    assert.deepEqual(criterioForScreen(null), { ...gradebook.DEFAULT_GRADE_CRITERION });
});

test('[UC-NOTAS-005] normalizePlan: etapa, peso, recuperação e "fora"; avaliação manual', () => {
    const plan = normalizePlan({
        itens: {
            A: { etapa: 2, peso: '2,5' },
            B: { etapa: 7, peso: 0 },
            C: { recuperacaoDe: 'etapa:1' },
            D: { recuperacaoDe: 'final', fora: true },
            E: { recuperacaoDe: 'etapa:9' },
            ['__proto__']: { etapa: 1 },
        },
        manuais: [
            { id: 'man_1_abcdef', titulo: 'Seminário', tipo: 'seminario', data: '2027-03-10' },
            { id: 'man_1_abcdef', titulo: 'Repetido' },
            { id: 'outro', titulo: 'Sem prefixo' },
            { id: 'man_2_abcdef', titulo: '', tipo: 'qualquer', data: 'ontem' },
        ],
    });
    assert.deepEqual(plan.itens.A, { etapa: 2, peso: 2.5, recuperacaoDe: null, fora: false });
    assert.deepEqual(plan.itens.B, { etapa: null, peso: 1, recuperacaoDe: null, fora: false });
    assert.equal(plan.itens.C.recuperacaoDe, 'etapa:1');
    assert.deepEqual(plan.itens.D, { etapa: null, peso: 1, recuperacaoDe: 'final', fora: true });
    assert.equal(plan.itens.E.recuperacaoDe, null);
    assert.equal(Object.prototype.hasOwnProperty.call(plan.itens, '__proto__'), false);
    assert.deepEqual(plan.manuais.map(item => [item.id, item.titulo, item.tipo, item.data]), [
        ['man_1_abcdef', 'Seminário', 'seminario', '2027-03-10'],
        ['man_2_abcdef', 'Avaliação', 'outro', null],
    ]);
    assert.deepEqual(normalizePlan(undefined), { itens: {}, manuais: [] });
});

test('[UC-NOTAS-005] média ponderada dentro da etapa e entre as etapas, arredondada só no fim', () => {
    assert.equal(weightedAverage([{ score: 80, peso: 2 }, { score: 60, peso: 1 }]), (80 * 2 + 60) / 3);
    assert.equal(weightedAverage([{ score: null, peso: 3 }, { score: 70 }]), 70);
    assert.equal(weightedAverage([]), null);
    const r = computeStudentResult({
        criterios: criterios({ etapas: DUAS_ETAPAS, recuperacao: { etapa: 'nenhuma', final: 'nenhuma' } }),
        plano: { itens: { A: { etapa: 1 }, B: { etapa: 2, peso: 2 }, C: { etapa: 2 } } },
        grupos: [g('A', 50), g('B', 80), g('C', 60)],
    });
    assert.equal(r.regraAntiga, false);
    assert.deepEqual(r.etapas.map(etapa => [etapa.ordem, etapa.itens, etapa.media]), [[1, 1, 5], [2, 2, 7.3]]);
    // (50 × 1 + 73,333... × 2) / 3 = 65,555... -> 6,6 (arredondar a etapa antes daria 6,5).
    assert.equal(r.mediaFinal, 6.6);
    assert.equal(r.situacao, 'aprovado');
    assert.equal(r.situacaoRotulo, 'Aprovado');
    // Pesos nas bordas: 0,1 e 10.
    const bordas = computeStudentResult({
        criterios: criterios({ recuperacao: { final: 'nenhuma' } }),
        plano: { itens: { A: { peso: 0.1 }, B: { peso: 10 } } },
        grupos: [g('A', 0), g('B', 100)],
    });
    assert.equal(bordas.mediaFinalScore, (0 * 0.1 + 100 * 10) / 10.1);
    assert.equal(bordas.mediaFinal, 9.9);
});

test('[UC-NOTAS-005] item sem etapa com duas etapas ou mais fica fora com aviso; com uma etapa, conta', () => {
    const duas = computeStudentResult({
        criterios: criterios({ etapas: DUAS_ETAPAS }),
        plano: { itens: { A: { etapa: 1 }, B: { etapa: 2 }, C: { etapa: 5 } } },
        grupos: [g('A', 70), g('B', 70), g('C', 0), g('Sem_Plano', 0)],
    });
    assert.equal(duas.mediaFinal, 7);
    assert.deepEqual(duas.avisos.find(item => item.codigo === 'itens_sem_etapa'), {
        codigo: 'itens_sem_etapa', texto: '2 avaliações sem etapa: não entram na média.', itens: ['C', 'Sem_Plano'],
    });
    const uma = computeStudentResult({ criterios: criterios(), grupos: [g('A', 70), g('Sem_Plano', 50)] });
    assert.equal(uma.mediaFinal, 6);
    assert.deepEqual(uma.avisos, []);
    // "Conta na média" desmarcado (fora): não conta e não é aviso.
    const fora = computeStudentResult({ criterios: criterios(), plano: { itens: { B: { fora: true } } }, grupos: [g('A', 70), g('B', 0)] });
    assert.equal(fora.mediaFinal, 7);
    assert.equal(fora.notasContadas, 1);
});

test('[UC-NOTAS-005] reaplicação conta uma vez; segunda chamada só para quem não tem a regular', () => {
    const r = computeStudentResult({
        criterios: criterios({ recuperacao: { final: 'nenhuma' } }),
        grupos: [
            g('A', 40, { applicationId: 'app1' }), g('A', 80, { applicationId: 'app2' }),
            g('B', 50), g('B', 100, { finalidade: 'segunda_chamada' }),
            g('C', 90, { finalidade: 'segunda_chamada' }),
        ],
    });
    // A = média das duas regulares (60), B = 50 (a segunda chamada não vale), C = 90.
    assert.equal(r.notasContadas, 3);
    assert.equal(r.mediaFinalScore, (60 + 50 + 90) / 3);
    // Na regra antiga, cada aplicação é mais uma nota.
    const antiga = computeStudentResult({ grupos: [g('A', 40), g('A', 80), g('B', 50)] });
    assert.equal(antiga.mediaFinalScore, (40 + 80 + 50) / 3);
});

test('[UC-NOTAS-005] recuperação: as quatro regras, na etapa e no fim', () => {
    // Mínima 6,0 (60): média 40 e recuperação 70.
    const tabela = [
        ['substitui_se_maior', 40, 70, 70],
        ['media', 40, 70, 55],
        ['ate_a_minima', 40, 70, 60],
        ['nenhuma', 40, 70, 40],
        // Nunca baixa a nota.
        ['substitui_se_maior', 40, 30, 40],
        ['media', 40, 30, 40],
        ['ate_a_minima', 40, 50, 50],
        ['ate_a_minima', 55, 50, 55],
        // Só vale abaixo da mínima (5,96 aparece 6,0 e já alcança).
        ['substitui_se_maior', 65, 100, 65],
        ['substitui_se_maior', 59.6, 100, 59.6],
        ['substitui_se_maior', 59.4, 100, 100],
        // Sem média: a regra conta a média como 0.
        ['substitui_se_maior', null, 70, 70],
        ['media', null, 70, 35],
        ['ate_a_minima', null, 70, 60],
        // Sem recuperação lançada.
        ['substitui_se_maior', 40, null, 40],
    ];
    for (const [regra, media, rec, esperado] of tabela) {
        assert.equal(applyRecovery(media, rec, regra, 6).score, esperado, `${regra} ${media} + ${rec}`);
    }
    // Na etapa (item do plano marcado recuperacaoDe 'etapa:1') e no fim ('final').
    const naEtapa = computeStudentResult({
        criterios: criterios({ etapas: DUAS_ETAPAS, recuperacao: { etapa: 'media', final: 'nenhuma' } }),
        plano: { itens: { A: { etapa: 1 }, B: { etapa: 2 }, REC1: { recuperacaoDe: 'etapa:1' } } },
        grupos: [g('A', 40), g('B', 70), g('REC1', 70)],
    });
    assert.deepEqual(naEtapa.etapas.map(etapa => [etapa.media, etapa.recuperacao, etapa.final, etapa.recuperacaoAplicada]), [[4, 7, 5.5, true], [7, null, 7, false]]);
    assert.equal(naEtapa.mediaFinalScore, (55 + 70 * 2) / 3);
    const noFim = computeStudentResult({
        criterios: criterios({ recuperacao: { etapa: 'nenhuma', final: 'ate_a_minima' } }),
        plano: { itens: { RF: { recuperacaoDe: 'final' } } },
        grupos: [g('A', 30), g('RF', 95)],
    });
    assert.equal(noFim.mediaFinal, 6);
    assert.equal(noFim.recuperacaoFinal, 9.5);
    assert.equal(noFim.recuperacaoFinalAplicada, true);
    assert.equal(noFim.situacao, 'aprovado');
    // Duas notas para a mesma recuperação: vale a maior.
    const duas = computeStudentResult({ criterios: criterios(), plano: { itens: { R1: { recuperacaoDe: 'final' }, R2: { recuperacaoDe: 'final' } } }, grupos: [g('A', 30), g('R1', 50), g('R2', 65)] });
    assert.equal(duas.mediaFinal, 6.5);
});

test('[UC-NOTAS-005] aplicação de recuperação (finalidade) vale para a etapa do item; sem regra, aviso', () => {
    const r = computeStudentResult({
        criterios: criterios({ etapas: DUAS_ETAPAS, recuperacao: { etapa: 'substitui_se_maior', final: 'nenhuma' } }),
        plano: { itens: { A: { etapa: 1 }, B: { etapa: 2 } } },
        grupos: [g('A', 30), g('A', 80, { finalidade: 'recuperacao' }), g('B', 60)],
    });
    assert.deepEqual(r.etapas.map(etapa => etapa.final), [8, 6]);
    assert.equal(r.notasContadas, 2);
    // Com uma etapa só e a regra da etapa "nenhuma", a recuperação da etapa vale como final.
    const umaEtapa = computeStudentResult({ criterios: criterios(), grupos: [g('A', 30), g('A', 90, { finalidade: 'recuperacao' })] });
    assert.equal(umaEtapa.mediaFinal, 9);
    assert.equal(umaEtapa.recuperacaoFinal, 9);
    // Sem nenhuma regra de recuperação: fica fora e avisa.
    const semRegra = computeStudentResult({
        criterios: criterios({ recuperacao: { etapa: 'nenhuma', final: 'nenhuma' } }),
        grupos: [g('A', 30), g('A', 90, { finalidade: 'recuperacao' })],
    });
    assert.equal(semRegra.mediaFinal, 3);
    assert.equal(semRegra.situacao, 'reprovado_nota');
    assert.match(semRegra.avisos.map(item => item.texto).join(' '), /1 nota de recuperação não entra na média/);
});

test('[UC-NOTAS-005] situação: Aprovado, Reprovado por nota, Reprovado por falta, Em recuperação, Cursando e Sem notas', () => {
    const base = { criterios: criterios({ etapas: DUAS_ETAPAS }), plano: { itens: { A: { etapa: 1 }, B: { etapa: 2 } } } };
    const tabela = [
        ['sem notas', { grupos: [] }, 'sem_notas'],
        ['etapa 2 sem nota', { grupos: [g('A', 90)] }, 'cursando'],
        ['período em andamento', { grupos: [g('A', 90), g('B', 90)], periodo: { terminado: false } }, 'cursando'],
        ['período pelo fim e hoje', { grupos: [g('A', 90), g('B', 90)], periodo: { fim: '2027-07-10', hoje: '2027-07-01' } }, 'cursando'],
        ['aprovado', { grupos: [g('A', 60), g('B', 60)], frequencia: { frequenciaGeral: 75 } }, 'aprovado'],
        ['74% com mínima 75%', { grupos: [g('A', 90), g('B', 90)], frequencia: { frequenciaGeral: 74 } }, 'reprovado_falta'],
        ['abaixo da mínima, recuperação final por lançar', { grupos: [g('A', 40), g('B', 40)] }, 'em_recuperacao'],
        ['abaixo da mínima, recuperação final lançada e ainda abaixo', { grupos: [g('A', 40), g('B', 40), g('A', 50, { finalidade: 'recuperacao' })] }, 'reprovado_nota'],
        ['falta vem antes da recuperação', { grupos: [g('A', 40), g('B', 40)], frequencia: 50 }, 'reprovado_falta'],
    ];
    for (const [nome, extra, esperado] of tabela) {
        assert.equal(computeStudentResult({ ...base, ...extra }).situacao, esperado, nome);
    }
    // Sem recuperação nos critérios: abaixo da mínima é reprovado direto.
    const semRec = computeStudentResult({ ...base, criterios: criterios({ etapas: DUAS_ETAPAS, recuperacao: { etapa: 'nenhuma', final: 'nenhuma' } }), grupos: [g('A', 40), g('B', 40)] });
    assert.equal(semRec.situacao, 'reprovado_nota');
    // Recuperação da etapa por lançar (regra da etapa ligada, sem regra final).
    const etapaPendente = computeStudentResult({ ...base, criterios: criterios({ etapas: DUAS_ETAPAS, recuperacao: { etapa: 'substitui_se_maior', final: 'nenhuma' } }), grupos: [g('A', 20), g('B', 60)] });
    assert.equal(etapaPendente.etapas[0].pendenteRecuperacao, true);
    assert.equal(etapaPendente.situacao, 'em_recuperacao');
    // Turma encerrada com etapa sem nota: a etapa conta 0, com aviso.
    const encerrada = computeStudentResult({ ...base, grupos: [g('A', 90)], periodo: { encerrada: true } });
    assert.deepEqual(encerrada.etapas.map(etapa => [etapa.final, etapa.contouComoZero]), [[9, false], [0, true]]);
    assert.equal(encerrada.mediaFinal, 3);
    // Turma encerrada é final: a recuperação final que não foi lançada conta como não feita.
    assert.equal(encerrada.situacao, 'reprovado_nota');
    assert.match(encerrada.avisos.find(item => item.codigo === 'etapa_sem_nota_zero').texto, /^2º bimestre sem nota: contou como 0/);
    assert.equal(encerrada.avisos.find(item => item.codigo === 'recuperacao_nao_lancada').texto, 'Turma encerrada sem a nota de recuperação: a recuperação contou como não feita.');
    // Todo rótulo em português ("Aguardando correção" entrou no B10: correção pendente).
    assert.deepEqual(rules.SITUACOES.map(codigo => rules.SITUACAO_ROTULOS[codigo]), ['Sem notas', 'Cursando', 'Aguardando correção', 'Em recuperação', 'Reprovado por falta', 'Reprovado por nota', 'Aprovado']);
});

test('[UC-NOTAS-005] menção pela nota como aparece (9,0 é MB; 8,99 vira 9,0; 6,95 vira 7,0)', () => {
    const tabela = [[10, 'MB'], [9, 'MB'], [8.99, 'MB'], [8.94, 'B'], [7, 'B'], [6.95, 'B'], [6.94, 'R'], [5, 'R'], [4.9, 'I'], [0, 'I']];
    const mencoes = normalizeCriteria({ mencoes: MENCOES }).mencoes;
    for (const [nota, sigla] of tabela) assert.equal(mencaoFor(nota, mencoes).sigla, sigla, String(nota));
    for (const estranha of [null, undefined, '', 'abc', -1, 10.5]) assert.equal(mencaoFor(estranha, mencoes), null, String(estranha));
    assert.equal(mencaoFor(8, null), null);
    // Na conta inteira: 89,9 aparece 9,0 e é MB; 69,5 aparece 7,0 e é B.
    const com = (score) => computeStudentResult({ criterios: criterios({ mencoes: MENCOES }), grupos: [g('A', score)] });
    assert.deepEqual(com(89.9).mencao, { sigla: 'MB', nome: 'Muito bom' });
    assert.deepEqual(com(69.5).mencao, { sigla: 'B', nome: 'Bom' });
    assert.equal(com(89.9).mediaFinal, 9);
    // Sem menções nos critérios (padrão), não há menção.
    assert.equal(computeStudentResult({ criterios: criterios(), grupos: [g('A', 90)] }).mencao, null);
});

test('[UC-NOTAS-005] frequência mínima e faltas que ainda pode ter (aulas previstas)', () => {
    const tabela = [
        // [aulas previstas, frequência mínima, faltas, restantes]
        [40, 75, 4, 6], [40, 75, 10, 0], [40, 75, 15, 0], [80, 75, 0, 20], [33, 75, 0, 8], [10, 100, 0, 0], [10, 0, 3, 7],
        [null, 75, 1, null], [0, 75, 0, null], ['abc', 75, 0, null],
    ];
    for (const [aulasPrevistas, frequenciaMinima, faltas, esperado] of tabela) {
        assert.equal(faltasPermitidasRestantes({ aulasPrevistas, frequenciaMinima, faltas }), esperado, `${aulasPrevistas}/${frequenciaMinima}/${faltas}`);
    }
    // Lida do computeAttendanceStats do aluno.
    const r = computeStudentResult({ criterios: criterios(), grupos: [g('A', 80)], frequencia: { frequenciaGeral: 90, faltasContam: 4, totalAulas: 40 }, aulasPrevistas: 60 });
    assert.deepEqual([r.frequencia, r.frequenciaMinima, r.faltas, r.aulasPrevistas, r.faltasPermitidasRestantes], [90, 75, 4, 60, 11]);
});

test('[UC-NOTAS-005] situação por disciplina quando os módulos estão ligados; senão, da turma', () => {
    const disciplinas = [{ id: 'REDES', nome: 'Redes', modulos: ['m1'] }, { id: 'PROG', nome: 'Programação', modulos: ['m2'] }];
    const grupos = [g('A', 90, { moduloId: 'm1' }), g('B', 30, { moduloId: 'm2' }), g('C', 80, { moduloId: 'm3' })];
    const frequencia = { frequenciaGeral: 90, porDisciplina: { REDES: { frequencia: 70, faltas: 6 }, PROG: { frequencia: 95, faltas: 1 } } };
    const r = computeStudentResult({ criterios: criterios(), grupos, frequencia, disciplinas, aulasPrevistas: { total: 80, porDisciplina: { REDES: 40, PROG: 40 } } });
    assert.equal(r.unidadeSituacao, 'disciplina');
    assert.deepEqual(r.disciplinas.map(item => [item.id, item.mediaFinal, item.situacao, item.faltasPermitidasRestantes]), [
        ['REDES', 9, 'reprovado_falta', 4], ['PROG', 3, 'em_recuperacao', 9],
    ]);
    // A falta de Redes vem antes da recuperação de Programação (pendência do B4 na J2).
    assert.equal(r.situacao, 'reprovado_falta');
    // A média da turma continua com todas as notas (inclusive a do módulo sem disciplina).
    assert.equal(r.mediaFinalScore, (90 + 30 + 80) / 3);
    assert.match(r.avisos.find(item => item.codigo === 'itens_fora_de_disciplina').texto, /^1 nota de módulo sem disciplina conta só na média da turma/);
    // Unidade "turma" nos critérios, ou disciplinas sem módulos: uma situação só.
    assert.equal(computeStudentResult({ criterios: criterios({ unidadeSituacao: 'turma' }), grupos, frequencia, disciplinas }).unidadeSituacao, 'turma');
    const semModulos = computeStudentResult({ criterios: criterios(), grupos, frequencia, disciplinas: [{ id: 'REDES', modulos: [] }] });
    assert.equal(semModulos.unidadeSituacao, 'turma');
    assert.equal(semModulos.disciplinas, undefined);
    assert.equal(semModulos.situacao, 'aprovado');
    assert.equal(combineSituacoes(['aprovado', 'sem_notas']), 'aprovado');
    assert.equal(combineSituacoes(['sem_notas']), 'sem_notas');
    assert.equal(combineSituacoes(['aprovado', 'reprovado_nota', 'reprovado_falta']), 'reprovado_falta');
    assert.equal(combineSituacoes(['aprovado', 'cursando', 'reprovado_falta']), 'cursando');
});

test('[UC-NOTAS-005] recuperação por lançar: Em recuperação até a turma ser encerrada; encerrada, é Reprovado por nota', () => {
    const base = { criterios: criterios({ etapas: DUAS_ETAPAS }), plano: { itens: { A: { etapa: 1 }, B: { etapa: 2 } } }, grupos: [g('A', 40), g('B', 40)] };
    const tabela = [
        // [período, situação, aviso de recuperação não lançada]
        [null, 'em_recuperacao', false],
        [{ terminado: true }, 'em_recuperacao', false],
        [{ fim: '2027-07-10', hoje: '2027-07-20' }, 'em_recuperacao', false],
        [{ encerrada: true }, 'reprovado_nota', true],
        [{ encerrada: true, terminado: false }, 'reprovado_nota', true],
    ];
    for (const [periodo, esperado, comAviso] of tabela) {
        const r = computeStudentResult({ ...base, periodo });
        assert.equal(r.situacao, esperado, JSON.stringify(periodo));
        assert.equal(r.avisos.some(item => item.codigo === 'recuperacao_nao_lancada'), comAviso, JSON.stringify(periodo));
    }
    // Recuperação da etapa por lançar, com a turma encerrada: também é final.
    const etapa = { ...base, criterios: criterios({ etapas: DUAS_ETAPAS, recuperacao: { etapa: 'substitui_se_maior', final: 'nenhuma' } }), grupos: [g('A', 20), g('B', 60)] };
    assert.equal(computeStudentResult(etapa).situacao, 'em_recuperacao');
    assert.equal(computeStudentResult({ ...etapa, periodo: { encerrada: true } }).situacao, 'reprovado_nota');
    // Com a recuperação lançada, a turma encerrada usa a nota dela (aqui, 7,0 com 4,0 de média).
    const lancada = computeStudentResult({ ...base, grupos: [...base.grupos, g('A', 70, { finalidade: 'recuperacao' })], periodo: { encerrada: true } });
    assert.deepEqual([lancada.mediaFinal, lancada.situacao], [7, 'aprovado']);
    assert.equal(lancada.avisos.some(item => item.codigo === 'recuperacao_nao_lancada'), false);
    // Encerrada e com a média alcançada: aprovado sem aviso; por disciplina, cada disciplina também.
    const disciplinas = [{ id: 'd1', nome: 'Redes', modulos: ['m1'] }];
    const porDisciplina = computeStudentResult({ criterios: criterios(), grupos: [g('A', 40, { moduloId: 'm1' })], disciplinas, periodo: { encerrada: true } });
    assert.deepEqual([porDisciplina.disciplinas[0].situacao, porDisciplina.situacao], ['reprovado_nota', 'reprovado_nota']);
});

test('[UC-NOTAS-005] por disciplina, a frequência da turma (aulas sem disciplina) continua valendo', () => {
    const { computeAttendanceStats } = require('../../backend/utils/attendance.js');
    const registro = (date, aulas) => ({ id: `r${date}`, date, studentEmail: 'ana@x.local', aulas });
    // 10 dias com chamada sem disciplina (8 faltas) e 1 presença na disciplina d1.
    const registros = [];
    for (let dia = 1; dia <= 10; dia += 1) registros.push(registro(`2027-03-${String(dia).padStart(2, '0')}`, [{ status: dia <= 8 ? 'falta' : 'presente' }]));
    registros.push(registro('2027-03-11', [{ status: 'presente', disciplinaId: 'd1' }]));
    const frequencia = computeAttendanceStats(registros);
    assert.equal(frequencia.frequenciaGeral, 27);
    assert.equal(frequencia.porDisciplina.d1.frequencia, 100);
    const disciplinas = [{ id: 'd1', nome: 'Redes', modulos: ['m1'] }, { id: 'd2', nome: 'Programação', modulos: ['m2'] }];
    const grupos = [g('A', 90, { moduloId: 'm1' }), g('B', 80, { moduloId: 'm2' })];
    const porDisciplina = computeStudentResult({ criterios: criterios(), grupos, frequencia, disciplinas });
    assert.equal(porDisciplina.unidadeSituacao, 'disciplina');
    // d1 tem chamada própria (100%); d2 não tem e usa a frequência da turma (27%).
    assert.deepEqual(porDisciplina.disciplinas.map(item => [item.id, item.frequencia, item.frequenciaTurma, item.situacao]), [
        ['d1', 100, false, 'aprovado'], ['d2', 27, true, 'reprovado_falta'],
    ]);
    assert.equal(porDisciplina.situacao, 'reprovado_falta');
    // Mesmo com todas as disciplinas aprovadas pela própria chamada, a turma a 27% reprova.
    const soD1 = computeStudentResult({ criterios: criterios(), grupos: [g('A', 90, { moduloId: 'm1' })], frequencia, disciplinas: [disciplinas[0]] });
    assert.deepEqual([soD1.disciplinas[0].situacao, soD1.situacao, soD1.situacaoRotulo], ['aprovado', 'reprovado_falta', 'Reprovado por falta']);
    assert.equal(soD1.avisos.find(item => item.codigo === 'frequencia_turma_abaixo').texto, 'Frequência da turma (27%, contando as aulas sem disciplina) abaixo da mínima de 75%.');
    // O mesmo resultado da unidade "turma" com os mesmos dados.
    assert.equal(computeStudentResult({ criterios: criterios({ unidadeSituacao: 'turma' }), grupos, frequencia, disciplinas }).situacao, 'reprovado_falta');
    // Só a frequência geral (sem porDisciplina), em número ou no formato { pct }.
    for (const geral of [50, { pct: 50, faltas: 5 }, { frequenciaGeral: 50, faltasContam: 5 }]) {
        const r = computeStudentResult({ criterios: criterios(), grupos, frequencia: geral, disciplinas });
        assert.equal(r.situacao, 'reprovado_falta', JSON.stringify(geral));
        assert.deepEqual(r.disciplinas.map(item => [item.situacao, item.frequenciaTurma]), [['reprovado_falta', true], ['reprovado_falta', true]], JSON.stringify(geral));
    }
    // A frequência da turma não passa na frente de "Cursando" nem de "Sem notas".
    assert.equal(computeStudentResult({ criterios: criterios(), grupos, frequencia: 50, disciplinas, periodo: { terminado: false } }).situacao, 'cursando');
    assert.equal(computeStudentResult({ criterios: criterios(), grupos: [], frequencia: 50, disciplinas }).situacao, 'sem_notas');
    // Frequência da turma na mínima: nada muda (a regra de hoje das disciplinas).
    const ok = computeStudentResult({ criterios: criterios(), grupos, frequencia: { frequenciaGeral: 75, porDisciplina: { d1: { frequencia: 75, faltas: 1 }, d2: { frequencia: 80, faltas: 1 } } }, disciplinas });
    assert.deepEqual([ok.situacao, ok.avisos.some(item => item.codigo === 'frequencia_turma_abaixo')], ['aprovado', false]);
    // Sem nenhuma chamada lançada, a frequência não decide.
    const semChamada = computeStudentResult({ criterios: criterios(), grupos, frequencia: computeAttendanceStats([]), disciplinas });
    assert.deepEqual([semChamada.situacao, semChamada.disciplinas.map(item => item.frequenciaTurma)], ['aprovado', [false, false]]);
});

test('[UC-NOTAS-005] por disciplina, os avisos de situação seguem as disciplinas e a disciplina sem nota não esconde a falta', () => {
    // Nota alta na disciplina e nota baixa num módulo sem disciplina, turma encerrada: a
    // média da turma fica abaixo da mínima, mas a situação é da disciplina (aprovado) e o
    // aviso de recuperação não lançada da média da turma não aparece ao lado de "Aprovado".
    const d1 = { id: 'd1', nome: 'Redes', modulos: ['m1'] };
    const fora = computeStudentResult({ criterios: criterios(), grupos: [g('A', 90, { moduloId: 'm1' }), g('C', 10, { moduloId: 'm3' })], disciplinas: [d1], periodo: { encerrada: true } });
    assert.deepEqual([fora.situacao, fora.mediaFinal], ['aprovado', 5]);
    assert.deepEqual(fora.avisos.map(item => item.codigo), ['itens_fora_de_disciplina']);
    // Na unidade "turma", com as mesmas notas, o aviso continua (a situação é da média).
    const turma = computeStudentResult({ criterios: criterios({ unidadeSituacao: 'turma' }), grupos: [g('A', 90, { moduloId: 'm1' }), g('C', 10, { moduloId: 'm3' })], disciplinas: [d1], periodo: { encerrada: true } });
    assert.deepEqual([turma.situacao, turma.avisos.map(item => item.codigo)], ['reprovado_nota', ['recuperacao_nao_lancada']]);
    // A recuperação que falta numa disciplina aparece com o nome dela.
    const d2 = { id: 'd2', nome: 'Programação', modulos: ['m2'] };
    const reprovada = computeStudentResult({ criterios: criterios(), grupos: [g('A', 90, { moduloId: 'm1' }), g('B', 30, { moduloId: 'm2' })], disciplinas: [d1, d2], periodo: { encerrada: true } });
    assert.deepEqual([reprovada.situacao, reprovada.disciplinas.map(item => item.situacao)], ['reprovado_nota', ['aprovado', 'reprovado_nota']]);
    const rec = reprovada.avisos.filter(item => item.codigo === 'recuperacao_nao_lancada');
    assert.deepEqual(rec, [{ codigo: 'recuperacao_nao_lancada', disciplinaId: 'd2', texto: 'Programação: Turma encerrada sem a nota de recuperação: a recuperação contou como não feita.' }]);

    // Disciplina sem nota com a própria frequência baixa: reprova por falta com o período
    // terminado ou a turma encerrada; antes disso, continua "Sem notas" (e Cursando no geral).
    const grupos = [g('A', 90, { moduloId: 'm1' })];
    const frequencia = { frequenciaGeral: 80, porDisciplina: { d2: { frequencia: 10, faltas: 9 } } };
    for (const periodo of [{ encerrada: true }, { terminado: true }, { fim: '2027-07-10', hoje: '2027-07-20' }]) {
        const r = computeStudentResult({ criterios: criterios(), grupos, frequencia, disciplinas: [d1, d2], periodo });
        assert.deepEqual(r.disciplinas.map(item => [item.id, item.situacao, item.frequencia]), [['d1', 'aprovado', 80], ['d2', 'reprovado_falta', 10]], JSON.stringify(periodo));
        assert.deepEqual([r.situacao, r.situacaoRotulo], ['reprovado_falta', 'Reprovado por falta'], JSON.stringify(periodo));
    }
    const semPeriodo = computeStudentResult({ criterios: criterios(), grupos, frequencia, disciplinas: [d1, d2] });
    assert.deepEqual([semPeriodo.disciplinas[1].situacao, semPeriodo.situacao], ['sem_notas', 'aprovado']);
    const cursando = computeStudentResult({ criterios: criterios(), grupos, frequencia, disciplinas: [d1, d2], periodo: { terminado: false } });
    assert.deepEqual([cursando.disciplinas[1].situacao, cursando.situacao], ['sem_notas', 'cursando']);
    // Disciplina sem nota e sem falta, com a turma encerrada: não reprova, mas avisa.
    const semFalta = computeStudentResult({ criterios: criterios(), grupos, disciplinas: [d1, d2], periodo: { encerrada: true } });
    assert.deepEqual([semFalta.situacao, semFalta.disciplinas[1].situacao], ['aprovado', 'sem_notas']);
    assert.equal(semFalta.avisos.find(item => item.codigo === 'disciplina_sem_notas').texto, 'Programação sem notas: não entra na situação geral.');
    // Nenhuma nota na turma e a frequência da turma abaixo da mínima: reprova só com o período terminado.
    const nada = { criterios: criterios(), grupos: [], frequencia: { frequenciaGeral: 40, porDisciplina: { d1: { frequencia: 90, faltas: 1 }, d2: { frequencia: 90, faltas: 1 } } }, disciplinas: [d1, d2] };
    assert.equal(computeStudentResult(nada).situacao, 'sem_notas');
    const nadaEncerrada = computeStudentResult({ ...nada, periodo: { encerrada: true } });
    assert.deepEqual([nadaEncerrada.disciplinas.map(item => item.situacao), nadaEncerrada.situacao], [['sem_notas', 'sem_notas'], 'reprovado_falta']);
    assert.ok(nadaEncerrada.avisos.some(item => item.codigo === 'frequencia_turma_abaixo'));
    // Unidade "turma": sem nota, a falta também reprova com o período terminado.
    assert.equal(computeStudentResult({ criterios: criterios(), grupos: [], frequencia: 40, periodo: { encerrada: true } }).situacao, 'reprovado_falta');
    assert.equal(computeStudentResult({ criterios: criterios(), grupos: [], frequencia: 90, periodo: { encerrada: true } }).situacao, 'sem_notas');
    assert.equal(computeStudentResult({ criterios: criterios(), grupos: [], frequencia: 40 }).situacao, 'sem_notas');
});

// Semente de notas com várias aplicações, tentativas, regras, notas inválidas e arquivadas.
function seedSubmissions() {
    const subs = [];
    let id = 0;
    const T0 = Date.parse('2027-03-01T10:00:00Z');
    const alunos = ['ana@x.local', 'bia@x.local', 'caio@x.local', 'davi@x.local'];
    const provas = ['Prova_1', 'Prova_2', 'Prova_3'];
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    alunos.forEach((email, ai) => provas.forEach((examKey, pi) => {
        const aplicacoes = pi === 1 ? ['app_a', 'app_b'] : [`app_${pi}`];
        aplicacoes.forEach(applicationId => {
            const tentativas = 1 + Math.floor(rand() * 3);
            for (let t = 0; t < tentativas; t += 1) {
                id += 1;
                const roll = rand();
                subs.push({
                    id: `s${id}`,
                    examKey,
                    applicationId,
                    student: { email, courseId: 'curso', studentClass: '1A', name: email },
                    score: roll < 0.08 ? null : roll < 0.12 ? '' : Math.round(rand() * 1000) / 10,
                    resultStatus: roll > 0.95 ? 'archived' : 'considered',
                    aggregationPolicy: ['highest', 'latest', 'average', 'selected'][(ai + pi) % 4],
                    selectedForResult: t === 0,
                    gradePublished: true,
                    timestamp: new Date(T0 + (ai * 100 + pi * 10 + t) * 60000).toISOString(),
                });
            }
        });
    }));
    return subs;
}

test('[UC-NOTAS-005] regra antiga reproduz as médias de hoje do quadro, do boletim e da ficha', () => {
    const subs = seedSubmissions();
    const structure = [{ id: 'm1', name: 'Módulo 1', units: [{ avaliacaoKey: 'Prova_1' }, { avaliacaoKey: 'Prova_2' }, { avaliacaoKey: 'Prova_3' }] }];
    const quadro = gradebook.buildClassGradebook({ submissions: subs, structure });
    assert.equal(quadro.rows.length, 4);
    for (const row of quadro.rows) {
        const own = subs.filter(item => item.student.email === row.email);
        const grupos = gradebook.buildGradeGroups(own);
        for (const resultado of [legacyStudentResult({ grupos }), computeStudentResult({ grupos }), computeStudentResult({ criterios: { ativo: false, mediaMinima: 9 }, grupos })]) {
            assert.equal(resultado.regraAntiga, true);
            assert.equal(resultado.mediaFinalScore, row.averageScore, row.email);
            assert.equal(resultado.mediaFinal, row.average, row.email);
            assert.equal(resultado.notasContadas, row.gradedCount, row.email);
            assert.equal(resultado.situacao, null);
            assert.equal(resultado.mencao, null);
            assert.deepEqual(resultado.etapas, []);
            assert.deepEqual(resultado.criterio, { mediaMinima: 6, mencoes: null, regraAntiga: true });
        }
        const ficha = gradebook.consolidatedStudentAverage(own);
        assert.equal(legacyStudentResult({ grupos }).mediaFinalScore, ficha.average, row.email);
        const boletim = gradebook.buildStudentReportModules({ submissions: own, structure });
        assert.equal(legacyStudentResult({ grupos }).mediaFinal, boletim.overallAverage, row.email);
    }
    // Sem nenhuma nota válida: média null, como no quadro.
    assert.equal(legacyStudentResult({ grupos: [{ score: null }, { score: '' }] }).mediaFinal, null);
});

test('[UC-NOTAS-005] o motor é puro: não muda a entrada e dá o mesmo resultado a cada chamada', () => {
    const entrada = {
        criterios: criterios({ etapas: DUAS_ETAPAS, mencoes: MENCOES }),
        plano: { itens: { A: { etapa: 1 }, B: { etapa: 2 } } },
        grupos: [g('A', 40), g('B', 75), g('A', 80, { finalidade: 'recuperacao' })],
        frequencia: { frequenciaGeral: 88, faltasContam: 3 },
        aulasPrevistas: 50,
    };
    const copia = JSON.parse(JSON.stringify(entrada));
    const primeiro = computeStudentResult(entrada);
    assert.deepEqual(entrada, copia);
    assert.deepEqual(computeStudentResult(entrada), primeiro);
    assert.equal(Object.isFrozen(rules.CRITERIOS_PADRAO), true);
    const fonte = require('node:fs').readFileSync(require.resolve('../../backend/utils/gradingRules.js'), 'utf8');
    assert.doesNotMatch(fonte, /require\(['"][^'"]*(database|db|routes|express)[^'"]*['"]\)/);
});

test('[UC-NOTAS-005] por disciplina: a falta vem antes da recuperação, a recuperação final lançada à mão vale para as disciplinas e a etapa que contou 0 avisa no geral', () => {
    const disciplinas = [{ id: 'd1', nome: 'Redes', modulos: ['m1'] }, { id: 'd2', nome: 'Programação', modulos: ['m2'] }];
    // (1) Redes reprovada por falta e Programação em recuperação: a situação geral é a falta
    // (na unidade "turma", a falta também decide antes da nota).
    const falta = computeStudentResult({
        criterios: criterios(), grupos: [g('A', 90, { moduloId: 'm1' }), g('B', 40, { moduloId: 'm2' })],
        frequencia: { frequenciaGeral: 80, porDisciplina: { d1: { frequencia: 50, faltas: 10 }, d2: { frequencia: 90, faltas: 1 } } },
        disciplinas, periodo: { terminado: true },
    });
    assert.deepEqual(falta.disciplinas.map(item => item.situacao), ['reprovado_falta', 'em_recuperacao']);
    assert.deepEqual([falta.situacao, falta.situacaoRotulo], ['reprovado_falta', 'Reprovado por falta']);
    assert.equal(combineSituacoes(['em_recuperacao', 'reprovado_falta', 'aprovado']), 'reprovado_falta');
    assert.equal(combineSituacoes(['em_recuperacao', 'reprovado_nota']), 'em_recuperacao');

    // (2) Recuperação final como avaliação manual (sem módulo): entra na conta de cada
    // disciplina com nota, sem o aviso falso de recuperação não lançada.
    const rec = computeStudentResult({
        criterios: criterios(), plano: { itens: { man_rec: { recuperacaoDe: 'final' } } },
        grupos: [g('A', 90, { moduloId: 'm1' }), g('B', 40, { moduloId: 'm2' }), g('man_rec', 80)],
        disciplinas, periodo: { encerrada: true },
    });
    assert.deepEqual(rec.disciplinas.map(item => [item.id, item.mediaFinal, item.situacao]), [['d1', 9, 'aprovado'], ['d2', 8, 'aprovado']]);
    assert.equal(rec.situacao, 'aprovado');
    assert.deepEqual(rec.avisos.map(item => item.codigo), []);
    // Disciplina sem nota nenhuma não ganha nota só pela recuperação.
    const soUma = computeStudentResult({
        criterios: criterios(), plano: { itens: { man_rec: { recuperacaoDe: 'final' } } },
        grupos: [g('B', 40, { moduloId: 'm2' }), g('man_rec', 80)], disciplinas, periodo: { encerrada: true },
    });
    assert.deepEqual(soUma.disciplinas.map(item => item.situacao), ['sem_notas', 'aprovado']);
    // A nota lançada à mão sem módulo (que não é recuperação) continua só na média da turma,
    // e o aviso diz que é avaliação sem módulo.
    const manual = computeStudentResult({ criterios: criterios(), grupos: [g('A', 90, { moduloId: 'm1' }), g('man_1', 80)], disciplinas });
    assert.equal(manual.avisos.find(item => item.codigo === 'itens_fora_de_disciplina').texto, '1 nota de avaliação sem módulo conta só na média da turma, não na situação das disciplinas.');
    const misto = computeStudentResult({ criterios: criterios(), grupos: [g('A', 90, { moduloId: 'm1' }), g('man_1', 80), g('C', 70, { moduloId: 'm3' })], disciplinas });
    assert.match(misto.avisos.find(item => item.codigo === 'itens_fora_de_disciplina').texto, /^2 notas fora das disciplinas \(módulos sem disciplina ou avaliações sem módulo\) contam só na média da turma/);
    // Só notas manuais: a situação geral é a da turma (B6), com o aviso.
    const soManuais = computeStudentResult({ criterios: criterios(), grupos: [g('man_1', 80), g('man_2', 90)], disciplinas, periodo: { terminado: true } });
    assert.deepEqual([soManuais.situacao, soManuais.mediaFinal], ['aprovado', 8.5]);

    // (3) Etapa sem nota numa disciplina (a turma tem nota nela): contou 0 na disciplina e
    // o aviso sobe para o geral com o nome da disciplina; sem repetir o da turma.
    const etapas = {
        criterios: criterios({ etapas: DUAS_ETAPAS }), plano: { itens: { A: { etapa: 1 }, A2: { etapa: 2 }, B: { etapa: 1 } } },
        grupos: [g('A', 90, { moduloId: 'm1' }), g('A2', 90, { moduloId: 'm1' }), g('B', 90, { moduloId: 'm2' })], disciplinas,
    };
    const zero = computeStudentResult({ ...etapas, periodo: { terminado: true } });
    assert.equal(zero.disciplinas[1].etapas[1].contouComoZero, true);
    assert.deepEqual(zero.avisos.filter(item => item.codigo === 'etapa_sem_nota_zero'), [
        { codigo: 'etapa_sem_nota_zero', disciplinaId: 'd2', texto: 'Programação: 2º bimestre sem nota: contou como 0 na média final.' },
    ]);
    const turmaSemEtapa = computeStudentResult({ ...etapas, grupos: [g('A', 90, { moduloId: 'm1' }), g('B', 90, { moduloId: 'm2' })], periodo: { terminado: true } });
    // Sem nota no 2º bimestre na turma inteira: um aviso só, o da turma.
    assert.deepEqual(turmaSemEtapa.avisos.filter(item => item.codigo === 'etapa_sem_nota_zero').map(item => item.texto), [
        '2º bimestre sem nota: contou como 0 na média final.',
    ]);
});
