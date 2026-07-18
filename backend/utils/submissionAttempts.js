const VALID_POLICIES = new Set(['highest', 'latest', 'average', 'selected']);

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
    const considered = attempts.filter(item => !isArchived(item) && Number.isFinite(Number(item.score)));
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
        selected = [...considered].sort((a, b) => Number(b.score) - Number(a.score) || new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0];
        contributing = [selected];
    }

    const score = contributing.reduce((sum, item) => sum + Number(item.score), 0) / contributing.length;
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
        }));
    });
    return (submissions || []).map(submission => ({ ...submission, ...(resultById.get(String(submission.id)) || {}) }));
}

module.exports = {
    VALID_POLICIES,
    attemptGroupKey,
    calculateAttemptResult,
    consolidateSubmissions,
    enrichSubmissionsWithAttemptResult,
    isArchived,
    submissionEmail,
};
