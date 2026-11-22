// Regra acadêmica da nota (fase 3, P2-S2; FUN-02): critérios do curso, plano de avaliação
// da turma, etapas com peso, recuperação, média final, situação e menção.
//
// Módulo PURO: não lê o banco, não grava e não conhece rota. Quem monta os dados
// (gradebook.js, a partir do P2-S3) passa os grupos de nota já consolidados pela regra
// das tentativas (submissionAttempts.calculateAttemptResult) e recebe o resultado pronto.
// Nenhuma tela ou rota refaz esta conta (contrato C1 do P2): a tela recebe
// criterio { mediaMinima, mencoes, regraAntiga } e usa gradeBand/fmtGrade de
// web/src/lib/grades.js.
//
// Escalas: nota de 0 a 100 nos grupos (como no banco) e 0 a 10 nos critérios e na saída
// (como na tela). O arredondamento é um só (roundGrade, uma casa, metade para cima) e só
// no fim: as médias de etapa e a média final são calculadas sobre as notas cruas, e cada
// comparação com a média mínima e cada menção usam a nota como ela aparece (5,96 aparece
// 6,0 e alcança a mínima 6,0, como em gradeBand).
//
// Dois caminhos:
// - regra antiga (curso sem critérios, ou com critérios desligados): a média é a média
//   simples das notas de cada grupo (um grupo por aplicação da prova), exatamente a conta
//   de buildClassGradebook, buildStudentReportModules e consolidatedStudentAverage de
//   gradebook.js; sem etapa, sem situação e sem menção. Nenhuma média muda sozinha
//   depois da atualização (D1 do P2);
// - critérios ligados: média ponderada dos itens dentro de cada etapa (peso do plano da
//   turma, padrão 1), recuperação da etapa, média ponderada das etapas (peso do curso),
//   recuperação final, situação e menção.
//
// Decisões desta conta (o que o desenho deixou aberto):
// - cada item do plano conta uma vez na etapa: quando a prova foi aplicada mais de uma vez
//   para o aluno (dois grupos regulares do mesmo item), vale a média deles (na regra
//   antiga cada aplicação contava como mais uma nota);
// - segunda chamada (finalidade 'segunda_chamada') conta como o mesmo item, só para quem
//   não tem nota regular naquele item (contrato C3);
// - recuperação vem de um item do plano marcado recuperacaoDe ('etapa:N' ou 'final') ou de
//   uma aplicação com finalidade 'recuperacao' (vale para a etapa do item); com mais de
//   uma nota para a mesma recuperação, vale a maior;
// - a recuperação só vale para quem ficou abaixo da média mínima e nunca baixa a nota;
//   etapa sem nota com recuperação lançada conta a média como 0 na regra
//   ("substitui_se_maior" fica com a recuperação; "media" com metade dela);
// - recuperação de etapa com a regra da etapa "nenhuma" vale como recuperação final
//   quando a regra final existe (com uma etapa só, as duas são a mesma prova); sem regra
//   nenhuma, não entra na conta e vira aviso;
// - item sem etapa, quando o curso tem duas etapas ou mais, fica fora da média, com aviso
//   ("N avaliações sem etapa"); com uma etapa só, todo item é dela (D7);
// - situação: "Sem notas" sem nenhuma nota; "Cursando" com o período letivo em andamento
//   ou com etapa ainda sem nota; terminado o período (turma encerrada ou fim do período
//   letivo), etapa sem nota conta 0, com aviso; depois vem "Reprovado por falta"
//   (frequência abaixo da mínima), "Aprovado" (média final alcança a mínima), "Em
//   recuperação" (abaixo da mínima com recuperação da etapa ou final ainda por lançar) e
//   "Reprovado por nota";
// - recuperação por lançar: enquanto a turma não foi encerrada (mesmo depois do fim do
//   período letivo, quando a recuperação costuma acontecer), o aluno fica "Em
//   recuperação"; com a turma encerrada (periodo.encerrada, que é o que o encerramento do
//   P2-S9 passa, inclusive na prévia do resumo), a recuperação que não foi lançada conta
//   como não feita: "Reprovado por nota", com aviso. A situação de uma turma encerrada é
//   sempre final;
// - unidade da situação (P2-A3, padrão sem o Alan): por disciplina quando os módulos
//   estão ligados a disciplinas (disciplinas[].modulos, P2-S7); senão, uma situação para a
//   turma. Por disciplina, a situação geral junta as das disciplinas (Cursando > Em
//   recuperação > Reprovado por falta > Reprovado por nota > Aprovado);
// - frequência por disciplina: cada disciplina usa a própria frequência
//   (frequencia.porDisciplina[id]); disciplina sem chamada própria usa a frequência da
//   turma (frequenciaTurma: true). A frequência da turma inteira (frequenciaGeral, que
//   conta também as aulas lançadas sem disciplina e as de disciplinas sem módulo) continua
//   valendo na situação geral: abaixo da mínima, a situação geral é "Reprovado por falta"
//   (depois de "Sem notas" e "Cursando", como na unidade da turma), com aviso.
//
// Frequência mínima (padrão 75%) é separada do limiar de risco da turma
// (attendanceConfig.limiarRiscoPct, D10): o denominador continua sendo as aulas lançadas;
// as aulas previstas só servem para "pode faltar mais N aulas" (faltasPermitidasRestantes,
// contrato C8).

const { normalizeScore, roundGrade, SCORE_MAX } = require('./submissionAttempts.js');

const GRADE_MAX = SCORE_MAX / 10;

const RECUPERACAO_REGRAS = Object.freeze(['nenhuma', 'substitui_se_maior', 'media', 'ate_a_minima']);
const RECUPERACAO_ROTULOS = Object.freeze({
    nenhuma: 'Sem recuperação',
    substitui_se_maior: 'A recuperação substitui a média, se for maior',
    media: 'Média entre a média e a recuperação',
    ate_a_minima: 'A recuperação sobe a média no máximo até a média mínima',
});
const UNIDADES_SITUACAO = Object.freeze(['disciplina', 'turma']);
const FINALIDADES = Object.freeze(['regular', 'segunda_chamada', 'recuperacao']);

const SITUACOES = Object.freeze(['sem_notas', 'cursando', 'em_recuperacao', 'reprovado_falta', 'reprovado_nota', 'aprovado']);
const SITUACAO_ROTULOS = Object.freeze({
    sem_notas: 'Sem notas',
    cursando: 'Cursando',
    em_recuperacao: 'Em recuperação',
    reprovado_falta: 'Reprovado por falta',
    reprovado_nota: 'Reprovado por nota',
    aprovado: 'Aprovado',
});

const LIMITES = Object.freeze({
    etapasMax: 6,
    nomeEtapaMax: 40,
    pesoMin: 0.1,
    pesoMax: 10,
    mediaMin: 0,
    mediaMax: GRADE_MAX,
    frequenciaMin: 0,
    frequenciaMax: 100,
    mencoesMax: 8,
    siglaMax: 4,
    nomeMencaoMax: 30,
    itensMax: 300,
    itemIdMax: 200,
    manuaisMax: 200,
});

const CRITERIOS_PADRAO = Object.freeze({
    versao: 1,
    ativo: true,
    mediaMinima: 6,
    frequenciaMinima: 75,
    etapas: Object.freeze([Object.freeze({ ordem: 1, nome: 'Etapa única', peso: 1 })]),
    // Recuperação padrão sem o Alan (P2-A2): substitui a média se for maior, no fim.
    recuperacao: Object.freeze({ etapa: 'nenhuma', final: 'substitui_se_maior' }),
    mencoes: null,
    unidadeSituacao: 'disciplina',
});

// Critério da regra antiga: o que a tela recebe quando o curso não tem critérios.
const CRITERIO_REGRA_ANTIGA = Object.freeze({ mediaMinima: CRITERIOS_PADRAO.mediaMinima, mencoes: null, regraAntiga: true });

const MANUAL_TIPOS = Object.freeze(['trabalho', 'pratica', 'seminario', 'participacao', 'outro']);
const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Número de um campo gravado ou digitado: aceita "6,5" com vírgula; vazio não é número.
function toNumber(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value).trim();
    if (!text) return null;
    const number = Number(/^-?\d+,\d+$/.test(text) ? text.replace(',', '.') : text);
    return Number.isFinite(number) ? number : null;
}

function oneDecimal(value) {
    return Math.round(Number((value * 10).toFixed(6))) / 10;
}

function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function inRange(value, min, max) {
    return value !== null && value >= min && value <= max;
}

// Peso de etapa ou de item: 0,1 a 10 com uma casa; fora disso, o padrão 1.
function normalizeWeight(value) {
    const number = toNumber(value);
    if (number === null) return 1;
    const rounded = oneDecimal(number);
    return inRange(rounded, LIMITES.pesoMin, LIMITES.pesoMax) ? rounded : 1;
}

function normalizeEtapas(raw) {
    const seen = new Set();
    const etapas = (Array.isArray(raw) ? raw : [])
        .filter(isPlainObject)
        .map(etapa => ({ ordem: toNumber(etapa.ordem), nome: cleanText(etapa.nome, LIMITES.nomeEtapaMax), peso: normalizeWeight(etapa.peso) }))
        .filter(etapa => Number.isInteger(etapa.ordem) && etapa.ordem >= 1 && etapa.ordem <= LIMITES.etapasMax)
        .filter(etapa => (seen.has(etapa.ordem) ? false : (seen.add(etapa.ordem), true)))
        .sort((a, b) => a.ordem - b.ordem);
    if (!etapas.length) return CRITERIOS_PADRAO.etapas.map(etapa => ({ ...etapa }));
    return etapas.map(etapa => ({
        ...etapa,
        nome: etapa.nome || (etapas.length === 1 ? 'Etapa única' : `${etapa.ordem}ª etapa`),
    }));
}

function normalizeRule(value, fallback) {
    return RECUPERACAO_REGRAS.includes(value) ? value : fallback;
}

// Menções por faixa (MB, B, R, I ou outra lista): da maior nota mínima para a menor.
// Lista vazia ou inválida é "sem menção" (null). A faixa de cada menção é a nota como
// aparece (0 a 10, uma casa).
function normalizeMencoes(raw) {
    if (!Array.isArray(raw)) return null;
    const seenMin = new Set();
    const mencoes = raw
        .filter(isPlainObject)
        .map(item => ({ sigla: cleanText(item.sigla, LIMITES.siglaMax), nome: cleanText(item.nome, LIMITES.nomeMencaoMax), min: toNumber(item.min) }))
        .filter(item => item.sigla && inRange(item.min, LIMITES.mediaMin, LIMITES.mediaMax))
        .map(item => ({ ...item, min: oneDecimal(item.min), nome: item.nome || item.sigla }))
        .sort((a, b) => b.min - a.min)
        .filter(item => (seenMin.has(item.min) ? false : (seenMin.add(item.min), true)))
        .slice(0, LIMITES.mencoesMax);
    return mencoes.length ? mencoes : null;
}

// Critérios do curso (course.avaliacao) com os padrões e os limites. Devolve null quando
// vale a regra antiga: curso sem critérios, campo que não é objeto ou ativo === false.
function normalizeCriteria(raw) {
    if (!isPlainObject(raw) || raw.ativo === false) return null;
    const minima = toNumber(raw.mediaMinima);
    const frequencia = toNumber(raw.frequenciaMinima);
    const recuperacao = isPlainObject(raw.recuperacao) ? raw.recuperacao : {};
    const criterios = {
        versao: 1,
        ativo: true,
        mediaMinima: inRange(minima, LIMITES.mediaMin, LIMITES.mediaMax) ? oneDecimal(minima) : CRITERIOS_PADRAO.mediaMinima,
        frequenciaMinima: inRange(frequencia, LIMITES.frequenciaMin, LIMITES.frequenciaMax) ? Math.round(frequencia) : CRITERIOS_PADRAO.frequenciaMinima,
        etapas: normalizeEtapas(raw.etapas),
        recuperacao: {
            etapa: normalizeRule(recuperacao.etapa, CRITERIOS_PADRAO.recuperacao.etapa),
            final: normalizeRule(recuperacao.final, CRITERIOS_PADRAO.recuperacao.final),
        },
        mencoes: normalizeMencoes(raw.mencoes),
        unidadeSituacao: UNIDADES_SITUACAO.includes(raw.unidadeSituacao) ? raw.unidadeSituacao : CRITERIOS_PADRAO.unidadeSituacao,
    };
    if (typeof raw.atualizadoEm === 'string' || typeof raw.atualizadoEm === 'number') criterios.atualizadoEm = raw.atualizadoEm;
    if (typeof raw.atualizadoPor === 'string') criterios.atualizadoPor = raw.atualizadoPor;
    return criterios;
}

// O que a tela recebe junto dos dados (contrato C1): { mediaMinima, mencoes, regraAntiga }.
function criterioForScreen(raw) {
    const criterios = normalizeCriteria(raw);
    if (!criterios) return { ...CRITERIO_REGRA_ANTIGA };
    return { mediaMinima: criterios.mediaMinima, mencoes: criterios.mencoes, regraAntiga: false };
}

function normalizeRecoveryTarget(value) {
    if (value === 'final') return 'final';
    const match = /^etapa:([1-9]\d*)$/.exec(String(value || ''));
    if (!match) return null;
    const ordem = Number(match[1]);
    return ordem <= LIMITES.etapasMax ? `etapa:${ordem}` : null;
}

function normalizePlanItem(raw) {
    const item = isPlainObject(raw) ? raw : {};
    const etapa = toNumber(item.etapa);
    const normalized = {
        etapa: Number.isInteger(etapa) && etapa >= 1 && etapa <= LIMITES.etapasMax ? etapa : null,
        peso: normalizeWeight(item.peso),
        recuperacaoDe: normalizeRecoveryTarget(item.recuperacaoDe),
        fora: item.fora === true,
    };
    return normalized;
}

function normalizeManualItem(raw) {
    if (!isPlainObject(raw)) return null;
    const id = String(raw.id || '').trim();
    if (!/^man_[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
    const manual = {
        id,
        titulo: cleanText(raw.titulo, 120) || 'Avaliação',
        tipo: MANUAL_TIPOS.includes(raw.tipo) ? raw.tipo : 'outro',
        descricao: cleanText(raw.descricao, 500),
        data: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.data || '')) ? raw.data : null,
    };
    ['criadoPor', 'arquivadoPor'].forEach(field => { if (typeof raw[field] === 'string') manual[field] = raw[field]; });
    ['criadoEm', 'arquivadoEm'].forEach(field => {
        if (typeof raw[field] === 'string' || typeof raw[field] === 'number') manual[field] = raw[field];
    });
    return manual;
}

// Plano de avaliação da turma (classes[].avaliacao): etapa, peso, recuperação e "fora da
// média" de cada item (examKey da estrutura, id 'man_*' ou, depois, id de tarefa).
// Item sem linha no plano vale { etapa: null, peso: 1 }.
function normalizePlan(raw) {
    const plan = isPlainObject(raw) ? raw : {};
    const itens = {};
    if (isPlainObject(plan.itens)) {
        Object.keys(plan.itens).slice(0, LIMITES.itensMax).forEach(id => {
            const key = String(id);
            if (!key || key.length > LIMITES.itemIdMax || PROTO_KEYS.has(key)) return;
            itens[key] = normalizePlanItem(plan.itens[id]);
        });
    }
    const seen = new Set();
    const manuais = (Array.isArray(plan.manuais) ? plan.manuais : [])
        .map(normalizeManualItem)
        .filter(item => item && (seen.has(item.id) ? false : (seen.add(item.id), true)))
        .slice(0, LIMITES.manuaisMax);
    return { itens, manuais };
}

// Item do plano para um id (sem linha no plano: o padrão).
function planItemFor(plan, id) {
    return Object.prototype.hasOwnProperty.call(plan.itens, id) ? plan.itens[id] : normalizePlanItem(null);
}

// Média ponderada de [{ score, peso }] sem arredondar; null sem nenhum valor.
function weightedAverage(entries) {
    let soma = 0;
    let pesos = 0;
    (entries || []).forEach(entry => {
        const score = normalizeScore(entry && entry.score);
        if (score === null) return;
        const peso = entry.peso === undefined ? 1 : Number(entry.peso);
        if (!Number.isFinite(peso) || peso <= 0) return;
        soma += score * peso;
        pesos += peso;
    });
    return pesos > 0 ? soma / pesos : null;
}

function simpleAverage(scores) {
    const valid = (scores || []).map(normalizeScore).filter(score => score !== null);
    return valid.length ? valid.reduce((sum, score) => sum + score, 0) / valid.length : null;
}

// A nota (0 a 100) aparece abaixo da média mínima (0 a 10)? null sem nota.
function belowMinimum(score, mediaMinima) {
    if (score === null || score === undefined) return null;
    const grade = roundGrade(score);
    if (grade === null) return null;
    return grade < mediaMinima;
}

// Regra de recuperação sobre a média (0 a 100). Só vale abaixo da mínima e nunca baixa a
// nota; sem média, a regra conta a média como 0. Devolve { score, aplicada }.
function applyRecovery(media, recuperacao, regra, mediaMinima) {
    const rec = normalizeScore(recuperacao);
    const base = media === null || media === undefined ? null : normalizeScore(media);
    if (rec === null || !RECUPERACAO_REGRAS.includes(regra) || regra === 'nenhuma') return { score: base, aplicada: false };
    if (base !== null && belowMinimum(base, mediaMinima) === false) return { score: base, aplicada: false };
    const atual = base === null ? 0 : base;
    const minimaScore = mediaMinima * 10;
    let proposta = atual;
    if (regra === 'substitui_se_maior') proposta = Math.max(atual, rec);
    else if (regra === 'media') proposta = (atual + rec) / 2;
    else if (regra === 'ate_a_minima') proposta = Math.min(rec, minimaScore);
    const score = Math.max(atual, proposta);
    return { score, aplicada: base === null || score !== base };
}

// Menção da nota (0 a 10, como aparece): a primeira faixa cuja mínima a nota alcança.
function mencaoFor(grade, mencoes) {
    if (!Array.isArray(mencoes) || !mencoes.length) return null;
    const number = toNumber(grade);
    if (number === null || number < 0 || number > GRADE_MAX) return null;
    const value = oneDecimal(number);
    const found = mencoes.find(item => value >= item.min);
    return found ? { sigla: found.sigla, nome: found.nome } : null;
}

// Frequência da entrada: o resultado de attendance.computeAttendanceStats
// ({ frequenciaGeral, faltasContam }), { pct, faltas } ou só o número.
function readFrequency(frequencia) {
    if (typeof frequencia === 'number') return { pct: Number.isFinite(frequencia) ? frequencia : null, faltas: null };
    if (!isPlainObject(frequencia)) return { pct: null, faltas: null };
    const pct = toNumber(frequencia.frequenciaGeral !== undefined ? frequencia.frequenciaGeral
        : frequencia.frequencia !== undefined ? frequencia.frequencia : frequencia.pct);
    const faltas = toNumber(frequencia.faltasContam !== undefined ? frequencia.faltasContam : frequencia.faltas);
    return { pct: inRange(pct, 0, 100) ? pct : null, faltas: faltas !== null && faltas >= 0 ? Math.floor(faltas) : null };
}

// Quantas faltas o aluno ainda pode ter: das aulas previstas, a parte que a frequência
// mínima deixa faltar, menos as faltas que contam. null sem aulas previstas.
function faltasPermitidasRestantes({ aulasPrevistas, frequenciaMinima, faltas }) {
    const previstas = toNumber(aulasPrevistas);
    const minima = toNumber(frequenciaMinima);
    if (previstas === null || previstas <= 0 || minima === null || minima < 0 || minima > 100) return null;
    const permitidas = Math.floor(Number(((Math.floor(previstas) * (100 - minima)) / 100).toFixed(6)));
    const usadas = toNumber(faltas);
    return Math.max(0, permitidas - (usadas !== null && usadas > 0 ? Math.floor(usadas) : 0));
}

// Estado do período: { terminado: true | false | null, encerrada }. Turma encerrada é
// sempre terminada; sem informação, terminado fica null (decide pelas notas).
function readPeriod(periodo) {
    if (!isPlainObject(periodo)) return { terminado: null, encerrada: false };
    if (periodo.encerrada === true) return { terminado: true, encerrada: true };
    if (periodo.terminado === true) return { terminado: true, encerrada: false };
    if (periodo.terminado === false) return { terminado: false, encerrada: false };
    const fim = String(periodo.fim || '');
    const hoje = String(periodo.hoje || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(fim) && /^\d{4}-\d{2}-\d{2}$/.test(hoje)) return { terminado: hoje > fim, encerrada: false };
    return { terminado: null, encerrada: false };
}

function groupItemId(group) {
    return String((group && (group.itemId || group.examKey)) || '');
}

function groupFinalidade(group) {
    return FINALIDADES.includes(group && group.finalidade) ? group.finalidade : 'regular';
}

function aviso(codigo, texto, extra = {}) {
    return { codigo, texto, ...extra };
}

function countLabel(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}

// Regra antiga (sem critérios): a média simples das notas dos grupos, a conta de hoje do
// quadro, do boletim e da ficha. Sem etapa, situação nem menção.
function legacyStudentResult({ grupos = [], frequencia = null } = {}) {
    const scores = (grupos || []).map(group => normalizeScore(group && group.score)).filter(score => score !== null);
    const media = simpleAverage(scores);
    const freq = readFrequency(frequencia);
    return {
        regraAntiga: true,
        criterio: { ...CRITERIO_REGRA_ANTIGA },
        unidadeSituacao: 'turma',
        etapas: [],
        mediaFinalScore: media,
        mediaFinal: roundGrade(media),
        recuperacaoFinal: null,
        recuperacaoFinalAplicada: false,
        mencao: null,
        situacao: null,
        situacaoRotulo: null,
        notasContadas: scores.length,
        frequencia: freq.pct,
        frequenciaMinima: null,
        faltas: freq.faltas,
        aulasPrevistas: null,
        faltasPermitidasRestantes: null,
        avisos: [],
    };
}

// Conta de um conjunto de grupos com os critérios já normalizados (a turma inteira ou uma
// disciplina).
function computeCore(criterios, plan, grupos, { frequencia, aulasPrevistas, terminado, encerrada = false }) {
    const ordens = new Set(criterios.etapas.map(etapa => etapa.ordem));
    const unicaEtapa = criterios.etapas.length === 1 ? criterios.etapas[0].ordem : null;
    const resolveEtapa = (etapa) => {
        if (etapa === null) return unicaEtapa;
        return ordens.has(etapa) ? etapa : null;
    };
    const avisos = [];
    const semEtapa = new Set();
    const itens = new Map(); // id -> { etapa, peso, regulares: [], segundaChamada: [] }
    const recuperacoes = new Map(); // 'etapa:N' | 'final' -> [score]
    let recuperacaoSemEtapa = 0;

    (grupos || []).forEach(group => {
        const score = normalizeScore(group && group.score);
        if (score === null) return;
        const id = groupItemId(group);
        const item = planItemFor(plan, id);
        if (item.fora) return;
        const finalidade = groupFinalidade(group);
        if (item.recuperacaoDe || finalidade === 'recuperacao') {
            let alvo = item.recuperacaoDe;
            if (!alvo) {
                const etapa = resolveEtapa(item.etapa);
                if (etapa === null) { recuperacaoSemEtapa += 1; semEtapa.add(id); return; }
                alvo = `etapa:${etapa}`;
            }
            if (alvo !== 'final' && !ordens.has(Number(alvo.slice(6)))) { recuperacaoSemEtapa += 1; semEtapa.add(id); return; }
            if (!recuperacoes.has(alvo)) recuperacoes.set(alvo, []);
            recuperacoes.get(alvo).push(score);
            return;
        }
        const etapa = resolveEtapa(item.etapa);
        if (etapa === null) { semEtapa.add(id); return; }
        if (!itens.has(id)) itens.set(id, { etapa, peso: item.peso, regulares: [], segundaChamada: [] });
        itens.get(id)[finalidade === 'segunda_chamada' ? 'segundaChamada' : 'regulares'].push(score);
    });

    if (semEtapa.size) {
        avisos.push(aviso('itens_sem_etapa', `${countLabel(semEtapa.size, 'avaliação sem etapa: não entra', 'avaliações sem etapa: não entram')} na média.`, { itens: [...semEtapa].sort() }));
    }

    // Item: média das aplicações regulares; sem regular, a segunda chamada.
    const porEtapa = new Map(criterios.etapas.map(etapa => [etapa.ordem, []]));
    let itensContados = 0;
    itens.forEach(item => {
        const score = simpleAverage(item.regulares.length ? item.regulares : item.segundaChamada);
        if (score === null) return;
        porEtapa.get(item.etapa).push({ score, peso: item.peso });
        itensContados += 1;
    });

    const maxOf = (list) => (list && list.length ? Math.max(...list) : null);
    const regraEtapa = criterios.recuperacao.etapa;
    const regraFinal = criterios.recuperacao.final;
    const recuperacaoFinalNotas = [...(recuperacoes.get('final') || [])];
    let recuperacaoSemRegra = 0;

    const etapas = criterios.etapas.map(etapa => {
        const mediaScore = weightedAverage(porEtapa.get(etapa.ordem));
        const recScore = maxOf(recuperacoes.get(`etapa:${etapa.ordem}`));
        let final = { score: mediaScore, aplicada: false };
        let recuperacao = null;
        if (recScore !== null) {
            if (regraEtapa !== 'nenhuma') {
                recuperacao = recScore;
                final = applyRecovery(mediaScore, recScore, regraEtapa, criterios.mediaMinima);
            } else if (regraFinal !== 'nenhuma') {
                recuperacaoFinalNotas.push(recScore);
            } else {
                recuperacaoSemRegra += 1;
            }
        }
        const pendenteRecuperacao = regraEtapa !== 'nenhuma' && recuperacao === null && belowMinimum(mediaScore, criterios.mediaMinima) === true;
        return {
            ordem: etapa.ordem,
            nome: etapa.nome,
            peso: etapa.peso,
            itens: porEtapa.get(etapa.ordem).length,
            mediaScore,
            media: roundGrade(mediaScore),
            recuperacaoScore: recuperacao,
            recuperacao: roundGrade(recuperacao),
            recuperacaoAplicada: final.aplicada,
            finalScore: final.score,
            final: roundGrade(final.score),
            semNota: final.score === null,
            contouComoZero: false,
            pendenteRecuperacao,
        };
    });

    if (recuperacaoFinalNotas.length && regraFinal === 'nenhuma') recuperacaoSemRegra += recuperacaoFinalNotas.length;
    if (recuperacaoSemRegra) {
        avisos.push(aviso('recuperacao_sem_regra', `${countLabel(recuperacaoSemRegra, 'nota de recuperação não entra', 'notas de recuperação não entram')} na média: os critérios do curso não têm recuperação.`));
    }
    if (recuperacaoSemEtapa) {
        avisos.push(aviso('recuperacao_sem_etapa', `${countLabel(recuperacaoSemEtapa, 'recuperação sem etapa não entra', 'recuperações sem etapa não entram')} na média.`));
    }

    const temNota = itensContados > 0 || recuperacaoFinalNotas.length > 0 || etapas.some(etapa => etapa.recuperacaoScore !== null);
    const etapasSemNota = etapas.filter(etapa => etapa.semNota);
    if (terminado === true && temNota && etapasSemNota.length) {
        etapasSemNota.forEach(etapa => { etapa.finalScore = 0; etapa.final = 0; etapa.contouComoZero = true; });
        avisos.push(aviso('etapa_sem_nota_zero', `${etapasSemNota.map(etapa => etapa.nome).join(', ')} sem nota: ${etapasSemNota.length === 1 ? 'contou' : 'contaram'} como 0 na média final.`));
    }

    const mediaEtapas = weightedAverage(etapas.filter(etapa => etapa.finalScore !== null).map(etapa => ({ score: etapa.finalScore, peso: etapa.peso })));
    const recuperacaoFinal = regraFinal !== 'nenhuma' ? maxOf(recuperacaoFinalNotas) : null;
    const finalResult = applyRecovery(mediaEtapas, recuperacaoFinal, regraFinal, criterios.mediaMinima);
    const mediaFinalScore = finalResult.score;
    const mediaFinal = roundGrade(mediaFinalScore);

    const freq = readFrequency(frequencia);
    const restantes = faltasPermitidasRestantes({ aulasPrevistas, frequenciaMinima: criterios.frequenciaMinima, faltas: freq.faltas });

    const pendente = etapas.some(etapa => etapa.finalScore === null);
    const recuperacaoPorLancar = (regraFinal !== 'nenhuma' && recuperacaoFinal === null) || etapas.some(etapa => etapa.pendenteRecuperacao);
    let situacao;
    if (!temNota) situacao = 'sem_notas';
    else if (terminado === false || pendente) situacao = 'cursando';
    else if (freq.pct !== null && freq.pct < criterios.frequenciaMinima) situacao = 'reprovado_falta';
    else if (belowMinimum(mediaFinalScore, criterios.mediaMinima) === false) situacao = 'aprovado';
    else if (recuperacaoPorLancar && !encerrada) situacao = 'em_recuperacao';
    else {
        situacao = 'reprovado_nota';
        if (recuperacaoPorLancar) {
            avisos.push(aviso('recuperacao_nao_lancada', 'Turma encerrada sem a nota de recuperação: a recuperação contou como não feita.'));
        }
    }

    return {
        etapas,
        mediaFinalScore,
        mediaFinal,
        recuperacaoFinalScore: recuperacaoFinal,
        recuperacaoFinal: roundGrade(recuperacaoFinal),
        recuperacaoFinalAplicada: finalResult.aplicada && recuperacaoFinal !== null,
        mencao: mencaoFor(mediaFinal, criterios.mencoes),
        situacao,
        situacaoRotulo: SITUACAO_ROTULOS[situacao],
        notasContadas: itensContados,
        frequencia: freq.pct,
        frequenciaMinima: criterios.frequenciaMinima,
        faltas: freq.faltas,
        aulasPrevistas: toNumber(aulasPrevistas),
        faltasPermitidasRestantes: restantes,
        avisos,
    };
}

// Situação geral a partir das disciplinas (unidade 'disciplina').
const SITUACAO_PRIORIDADE = ['cursando', 'em_recuperacao', 'reprovado_falta', 'reprovado_nota', 'aprovado'];
function combineSituacoes(situacoes) {
    const comNota = (situacoes || []).filter(situacao => situacao && situacao !== 'sem_notas');
    if (!comNota.length) return 'sem_notas';
    return SITUACAO_PRIORIDADE.find(situacao => comNota.includes(situacao)) || 'aprovado';
}

// Frequência própria da disciplina (chamada lançada com a disciplina); null sem chamada
// própria.
function disciplineFrequency(frequencia, id) {
    if (!isPlainObject(frequencia) || !isPlainObject(frequencia.porDisciplina)) return null;
    if (!Object.prototype.hasOwnProperty.call(frequencia.porDisciplina, id)) return null;
    const entry = frequencia.porDisciplina[id];
    if (!isPlainObject(entry)) return null;
    const own = readFrequency({ frequenciaGeral: entry.frequencia, faltasContam: entry.faltas });
    return own.pct === null ? null : { frequenciaGeral: own.pct, faltasContam: own.faltas };
}

function disciplinePlanned(aulasPrevistas, id) {
    if (!isPlainObject(aulasPrevistas) || !isPlainObject(aulasPrevistas.porDisciplina)) return null;
    return toNumber(aulasPrevistas.porDisciplina[id]);
}

function totalPlanned(aulasPrevistas) {
    if (isPlainObject(aulasPrevistas)) return toNumber(aulasPrevistas.total);
    return toNumber(aulasPrevistas);
}

// Resultado de um aluno numa turma.
// Entrada:
// - criterios: course.avaliacao (ausente ou desligado = regra antiga);
// - plano: classes[].avaliacao;
// - grupos: [{ itemId | examKey, score (0 a 100, já consolidado pela regra das
//   tentativas), finalidade?, moduloId? }], um por aplicação (buildGradeGroups);
// - frequencia: computeAttendanceStats do aluno (ou { pct, faltas }, ou o número);
// - aulasPrevistas: número ou { total, porDisciplina: { id: n } } (academicCalendar.plannedLessons);
// - periodo: { terminado } | { encerrada } | { fim, hoje } (sem período: decide pelas notas;
//   encerrada: turma encerrada, situação final, sem "Em recuperação");
// - disciplinas: [{ id, nome, modulos: [ids de módulo] }] para a situação por disciplina.
// Saída: etapas, média final (crua e como aparece), recuperação, menção, situação (código
// e rótulo), frequência, faltas que ainda pode ter e avisos em português.
function computeStudentResult({ criterios = null, plano = null, grupos = [], frequencia = null, aulasPrevistas = null, periodo = null, disciplinas = [] } = {}) {
    const normalized = normalizeCriteria(criterios);
    if (!normalized) return legacyStudentResult({ grupos, frequencia });
    const plan = normalizePlan(plano);
    const { terminado, encerrada } = readPeriod(periodo);
    const core = computeCore(normalized, plan, grupos, { frequencia, aulasPrevistas: totalPlanned(aulasPrevistas), terminado, encerrada });
    const result = {
        regraAntiga: false,
        criterio: { mediaMinima: normalized.mediaMinima, mencoes: normalized.mencoes, regraAntiga: false },
        unidadeSituacao: 'turma',
        ...core,
    };

    const ligadas = (Array.isArray(disciplinas) ? disciplinas : [])
        .filter(item => isPlainObject(item) && item.id && Array.isArray(item.modulos) && item.modulos.length);
    if (normalized.unidadeSituacao !== 'disciplina' || !ligadas.length) return result;

    const moduloDaDisciplina = new Map();
    ligadas.forEach(item => item.modulos.forEach(modulo => {
        const key = String(modulo);
        if (!moduloDaDisciplina.has(key)) moduloDaDisciplina.set(key, String(item.id));
    }));
    const porDisciplina = new Map(ligadas.map(item => [String(item.id), []]));
    let foraDeDisciplina = 0;
    (grupos || []).forEach(group => {
        if (normalizeScore(group && group.score) === null) return;
        const disciplina = moduloDaDisciplina.get(String((group && group.moduloId) || ''));
        if (!disciplina) { foraDeDisciplina += 1; return; }
        porDisciplina.get(disciplina).push(group);
    });

    // Frequência da turma inteira: todas as aulas lançadas, com ou sem disciplina.
    const turma = readFrequency(frequencia);
    const frequenciaTurma = turma.pct === null ? null : { frequenciaGeral: turma.pct, faltasContam: turma.faltas };

    result.unidadeSituacao = 'disciplina';
    result.disciplinas = ligadas.map(item => {
        const id = String(item.id);
        const propria = disciplineFrequency(frequencia, id);
        // Sem chamada própria, vale a frequência da turma (e as aulas previstas da turma,
        // para "pode faltar mais N aulas").
        const own = computeCore(normalized, plan, porDisciplina.get(id), {
            frequencia: propria || frequenciaTurma,
            aulasPrevistas: propria ? disciplinePlanned(aulasPrevistas, id) : totalPlanned(aulasPrevistas),
            terminado,
            encerrada,
        });
        return { id, nome: cleanText(item.nome, 80) || id, ...own, frequenciaTurma: !propria && !!frequenciaTurma };
    });
    let situacao = combineSituacoes(result.disciplinas.map(item => item.situacao));
    const avisos = [];
    // A frequência mínima vale também para a turma inteira: as faltas lançadas sem
    // disciplina (ou numa disciplina sem módulo) não podem sumir da situação.
    if (situacao !== 'sem_notas' && situacao !== 'cursando' && turma.pct !== null && turma.pct < normalized.frequenciaMinima) {
        avisos.push(aviso('frequencia_turma_abaixo', `Frequência da turma (${turma.pct}%, contando as aulas sem disciplina) abaixo da mínima de ${normalized.frequenciaMinima}%.`));
        situacao = 'reprovado_falta';
    }
    result.situacao = situacao;
    result.situacaoRotulo = SITUACAO_ROTULOS[situacao];
    if (foraDeDisciplina) {
        avisos.push(aviso('itens_fora_de_disciplina', `${countLabel(foraDeDisciplina, 'nota de módulo sem disciplina conta', 'notas de módulos sem disciplina contam')} só na média da turma, não na situação das disciplinas.`));
    }
    if (avisos.length) result.avisos = [...result.avisos, ...avisos];
    return result;
}

module.exports = {
    CRITERIOS_PADRAO,
    CRITERIO_REGRA_ANTIGA,
    FINALIDADES,
    LIMITES,
    MANUAL_TIPOS,
    RECUPERACAO_REGRAS,
    RECUPERACAO_ROTULOS,
    SITUACOES,
    SITUACAO_ROTULOS,
    UNIDADES_SITUACAO,
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
};
