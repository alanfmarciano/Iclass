const VALID_POLICIES = new Set(['highest', 'latest', 'average', 'selected']);

// Escala interna da nota: 0 a 100 (a correção online grava inteiros). As telas
// mostram 0 a 10 com uma casa decimal. Registros antigos podem ter valores fora
// da faixa ou vazios (lançamento manual sem validação): devolve null para que
// nunca entrem em média nem apareçam como nota (ex.: 150 virando "15,0").
const SCORE_MAX = 100;
function normalizeScore(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const number = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
    if (!Number.isFinite(number) || number < 0 || number > SCORE_MAX) return null;
    return number;
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

function policyFor(attempts) {
    const ordered = [...attempts].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    const configured = ordered.find(item => VALID_POLICIES.has(item.aggregationPolicy))?.aggregationPolicy;
    return configured || 'highest';
}

function calculateAttemptResult(attempts) {
    const policy = policyFor(attempts);
    const considered = attempts.filter(item => !isArchived(item) && normalizeScore(item.score) !== null);
    if (considered.length === 0) {
        return { policy, score: null, selectedSubmissionId: null, contributingIds: [] };
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
        selected = [...considered].sort((a, b) => normalizeScore(b.score) - normalizeScore(a.score) || new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0];
        contributing = [selected];
    }

    const score = contributing.reduce((sum, item) => sum + normalizeScore(item.score), 0) / contributing.length;
    return {
        policy,
        score,
        selectedSubmissionId: selected?.id || null,
        contributingIds: contributing.map(item => String(item.id)),
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
        }));
    });
    return (submissions || []).map(submission => ({ ...submission, ...(resultById.get(String(submission.id)) || {}) }));
}

module.exports = {
    SCORE_MAX,
    VALID_POLICIES,
    attemptGroupKey,
    calculateAttemptResult,
    consolidateSubmissions,
    enrichSubmissionsWithAttemptResult,
    isArchived,
    isScoreInvalid,
    normalizeScore,
    submissionEmail,
};
