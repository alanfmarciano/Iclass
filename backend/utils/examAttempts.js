const MAX_ATTEMPTS_ALLOWED = 10;

function parseMaxAttempts(value) {
    if (value === null || value === undefined || value === '') {
        return { valid: true, value: null };
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ATTEMPTS_ALLOWED) {
        return { valid: false, value: null };
    }

    return { valid: true, value: parsed };
}

function normalizeMaxAttempts(value) {
    const parsed = parseMaxAttempts(value);
    return parsed.valid ? parsed.value : null;
}

function filterStudentExamAttempts(submissions, { studentEmail, examKey, courseId, applicationId } = {}) {
    const normalizedEmail = String(studentEmail || '').trim().toLowerCase();
    const normalizedExamKey = String(examKey || '').trim();
    const normalizedCourseId = String(courseId || '').trim();

    const normalizedApplicationId = String(applicationId || '').trim();
    if (!normalizedEmail || (!normalizedExamKey && !normalizedApplicationId)) return [];

    return (Array.isArray(submissions) ? submissions : []).filter(submission => {
        const submissionEmail = String(submission?.student?.email || '').trim().toLowerCase();
        const submissionCourseId = String(submission?.student?.courseId || '').trim();
        const applicationMatches = normalizedApplicationId
            ? submission?.applicationId === normalizedApplicationId
            : submission?.examKey === normalizedExamKey;
        return submissionEmail === normalizedEmail
            && applicationMatches
            && submission?.resultStatus !== 'invalidated'
            && (!submissionCourseId || !normalizedCourseId || submissionCourseId === normalizedCourseId);
    });
}

function countStudentExamAttempts(submissions, scope = {}) {
    return filterStudentExamAttempts(submissions, scope).length;
}

module.exports = {
    MAX_ATTEMPTS_ALLOWED,
    countStudentExamAttempts,
    filterStudentExamAttempts,
    normalizeMaxAttempts,
    parseMaxAttempts,
};
