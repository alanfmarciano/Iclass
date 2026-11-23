const VALID_POLICIES = new Set(['highest', 'latest', 'average', 'selected']);

// Escala interna da nota: 0 a 100 (a correção online grava inteiros). As telas
// mostram 0 a 10 com uma casa decimal. Registros antigos podem ter valores fora
// da faixa ou vazios (lançamento manual sem validação): devolve null para que
// nunca entrem em média nem apareçam como nota (ex.: 150 virando "15,0").
const SCORE_MAX = 100;
function normalizeScore(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    // Texto só com espaços também é nota vazia (Number('  ') daria 0).
    const text = typeof value === 'number' ? null : String(value).trim();
    if (text === '') return null;
    const number = typeof value === 'number' ? value : Number(text.replace(',', '.'));
    if (!Number.isFinite(number) || number < 0 || number > SCORE_MAX) return null;
    return number;
}

// Nota (0-100) -> 0 a 10 com uma casa, arredondando "metade para cima"
// (73,5 -> 7,4). É a única regra de arredondamento de nota do sistema: boletim,
// quadro, planilhas, portal do aluno e telas usam esta conta (a mesma de
// web/src/lib/grades.js). O toFixed(6) tira o ruído de ponto flutuante das
// médias, que fazia toFixed(1) mostrar 7,3 para 7,35.
function roundGrade(score) {
    const normalized = normalizeScore(score);
    if (normalized === null) return null;
    return Math.round(Number(normalized.toFixed(6))) / 10;
}

// Toda entrega deveria ter nota: vazia, texto ou fora de 0 a 100 é registro inválido.
function isScoreInvalid(submission) {
    return normalizeScore(submission?.score) === null;
}

function submissionEmail(submission) {
    return String(submission?.student?.email || submission?.studentEmail || submission?.email || '').trim().toLowerCase();
}

function submissionCourse(submission) {
    return String(submission?.student?.courseId || submission?.courseId || '');
}

function submissionClass(submission) {
    return String(submission?.student?.studentClass || submission?.studentClass || '');
}

function attemptGroupKey(submission) {
    const applicationScope = submission?.applicationId
        ? `application:${submission.applicationId}`
        : `legacy-exam:${String(submission?.examKey || '')}`;
    return [submissionEmail(submission), submissionCourse(submission), submissionClass(submission), applicationScope].join('::');
}

function isArchived(submission) {
    return submission?.resultStatus === 'archived' || submission?.archived === true;
}

// Anulação por integridade (fase 3, P3-S4a; D18 e P-B1 do desenho do P3):
// submission.integrity = { decisao: 'zero' | 'desconsiderar', motivo, por, em,
// desfeitaEm?, desfeitaPor? }. Só vale enquanto não foi desfeita; decisão desconhecida
// (dado estranho) não muda nada. 'zero': a entrega conta com nota 0; 'desconsiderar': a
// entrega fica fora da conta, como se o aluno não tivesse feito.
const INTEGRITY_DECISIONS = Object.freeze(['zero', 'desconsiderar']);
function integrityDecision(submission) {
    const integrity = submission?.integrity;
    if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) return null;
    if (integrity.desfeitaEm) return null;
    return INTEGRITY_DECISIONS.includes(integrity.decisao) ? integrity.decisao : null;
}

// Correção do professor (D7 e D8): submission.correcao = { situacao: 'pendente' |
// 'concluida', versao, itens, comentarioGeral, concluidaPor, concluidaEm }. Entrega sem
// correcao é concluída (todas as de antes da fase 3), a não ser a que tem resposta
// esperando o professor em gradedAnswers (pending): entregas gravadas entre os tipos
// novos (P3-S1) e esta regra nasceram sem o campo, e a nota delas é só a das objetivas.
// Esta é a única leitura de correcao para a conta da nota (contrato C1 do P3).
function hasPendingAnswer(submission) {
    return (Array.isArray(submission?.gradedAnswers) ? submission.gradedAnswers : [])
        .some(answer => answer && answer.pending === true && answer.annulled !== true);
}

function isAwaitingCorrection(submission) {
    const correcao = submission?.correcao;
    if (correcao && typeof correcao === 'object' && !Array.isArray(correcao)) {
        if (correcao.situacao === 'pendente') return true;
        if (correcao.situacao === 'concluida') return false;
    }
    return hasPendingAnswer(submission);
}

// Nota que a entrega leva para a conta: 0 na anulada com 'zero'; a gravada (0 a 100) nas
// outras; null quando ela não entra (desconsiderada, aguardando correção ou nota
// inválida).
function effectiveScore(submission) {
    const decision = integrityDecision(submission);
    if (decision === 'zero') return 0;
    if (decision === 'desconsiderar') return null;
    if (isAwaitingCorrection(submission)) return null;
    return normalizeScore(submission?.score);
}

function policyFor(attempts) {
    const ordered = [...attempts].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    const configured = ordered.find(item => VALID_POLICIES.has(item.aggregationPolicy))?.aggregationPolicy;
    return configured || 'highest';
}

// Regra da nota de um grupo de tentativas. Fora da conta: arquivada, nota inválida,
// anulada com 'desconsiderar' e aguardando a correção do professor (esta deixa o grupo
// com aguardandoCorrecao: true, para as telas dizerem "Aguardando correção" em vez da
// nota). A anulada com 'zero' entra com 0 (contrato C1 do P3).
function calculateAttemptResult(attempts) {
    const policy = policyFor(attempts);
    const live = attempts.filter(item => !isArchived(item) && integrityDecision(item) !== 'desconsiderar');
    const aguardandoCorrecao = live.some(item => integrityDecision(item) !== 'zero' && isAwaitingCorrection(item));
    const considered = live.filter(item => effectiveScore(item) !== null);
    if (considered.length === 0) {
        return { policy, score: null, selectedSubmissionId: null, contributingIds: [], aguardandoCorrecao };
    }

    const latest = [...considered].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    let selected = null;
    let contributing = [];

    if (policy === 'average') {
        contributing = considered;
    } else if (policy === 'latest') {
        selected = latest[0];
        contributing = [selected];
    } else if (policy === 'selected') {
        selected = considered.find(item => item.selectedForResult === true) || latest[0];
        contributing = [selected];
    } else {
        selected = [...considered].sort((a, b) => effectiveScore(b) - effectiveScore(a) || new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0];
        contributing = [selected];
    }

    const score = contributing.reduce((sum, item) => sum + effectiveScore(item), 0) / contributing.length;
    return {
        policy,
        score,
        selectedSubmissionId: selected?.id || null,
        contributingIds: contributing.map(item => String(item.id)),
        aguardandoCorrecao,
    };
}

function consolidateSubmissions(submissions) {
    const groups = new Map();
    (submissions || []).forEach(submission => {
        const key = attemptGroupKey(submission);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(submission);
    });
    return [...groups.values()].map(attempts => ({ attempts, ...calculateAttemptResult(attempts) }));
}

function enrichSubmissionsWithAttemptResult(submissions) {
    const resultById = new Map();
    consolidateSubmissions(submissions).forEach(group => {
        const contributing = new Set(group.contributingIds);
        group.attempts.forEach(attempt => resultById.set(String(attempt.id), {
            resultStatus: isArchived(attempt) ? 'archived' : 'considered',
            aggregationPolicy: group.policy,
            consolidatedScore: group.score,
            countsTowardResult: contributing.has(String(attempt.id)),
            selectedSubmissionId: group.selectedSubmissionId,
            scoreInvalid: isScoreInvalid(attempt),
            // Fase 3 (P3-S4a): a tentativa espera a correção do professor; a anulação por
            // integridade que vale ('zero' ou 'desconsiderar', null sem anulação); e se o
            // grupo dela tem alguma tentativa esperando correção.
            awaitingCorrection: integrityDecision(attempt) === null && isAwaitingCorrection(attempt),
            integrityDecision: integrityDecision(attempt),
            aguardandoCorrecao: group.aguardandoCorrecao === true,
        }));
    });
    return (submissions || []).map(submission => ({ ...submission, ...(resultById.get(String(submission.id)) || {}) }));
}

module.exports = {
    INTEGRITY_DECISIONS,
    SCORE_MAX,
    VALID_POLICIES,
    attemptGroupKey,
    calculateAttemptResult,
    consolidateSubmissions,
    effectiveScore,
    enrichSubmissionsWithAttemptResult,
    integrityDecision,
    isArchived,
    isAwaitingCorrection,
    isScoreInvalid,
    normalizeScore,
    roundGrade,
    submissionEmail,
};
