const ADMIN_PERMISSION_VALUES = Object.freeze([
    'page.dashboard',
    'page.exams',
    'page.monitor',
    'page.results',
    'page.materials',
    'page.editor',
    'page.classes',
    'page.students',
    'page.accounts',
    'page.forum',
    'page.branding',
    'page.system',
    'course.manage',
    'classes.manage',
    'accounts.manage',
    'branding.manage',
    'system.manage',
    'students.destroy',
    'students.certificates',
    'students.security',
    'schools.scope',
    'course.purge',
    'forum.purge',
]);

const ADMIN_PERMISSION_SET = new Set(ADMIN_PERMISSION_VALUES);
// Exclusivas de administrador: nunca fazem parte do professor nem podem ser concedidas.
const ADMIN_ONLY_PERMISSION_SET = new Set(['page.accounts', 'accounts.manage', 'students.destroy', 'students.certificates', 'students.security', 'course.purge', 'forum.purge']);
const PROFESSOR_DEFAULT_PERMISSIONS = Object.freeze([
    'page.dashboard',
    'page.exams',
    'page.monitor',
    'page.results',
    'page.materials',
    'page.editor',
    'page.students',
    'page.forum',
    'schools.scope',
]);
const PERMISSION_DEPENDENCIES = Object.freeze({
    'classes.manage': 'page.classes',
    'accounts.manage': 'page.accounts',
    'branding.manage': 'page.branding',
    'system.manage': 'page.system',
});

function expandPermissionDependencies(permissions) {
    const expanded = new Set(permissions);
    permissions.forEach(permission => {
        const dependency = PERMISSION_DEPENDENCIES[permission];
        if (dependency) expanded.add(dependency);
    });
    return [...expanded];
}

function normalizeAdditionalPermissions(value) {
    if (!Array.isArray(value)) return [];
    const valid = [...new Set(value
        .map(permission => String(permission).trim())
        .filter(permission => ADMIN_PERMISSION_SET.has(permission) && !ADMIN_ONLY_PERMISSION_SET.has(permission)))];
    return expandPermissionDependencies(valid);
}

function parseAdditionalPermissions(value) {
    if (value === undefined) return { ok: true, permissions: undefined };
    if (!Array.isArray(value)) {
        return { ok: false, error: 'Permissões adicionais devem ser enviadas como uma lista.' };
    }

    const requested = [...new Set(value.map(permission => String(permission).trim()).filter(Boolean))];
    const unknown = requested.find(permission => !ADMIN_PERMISSION_SET.has(permission));
    if (unknown) {
        return { ok: false, error: `Permissão adicional desconhecida: ${unknown}.` };
    }
    const adminOnly = requested.find(permission => ADMIN_ONLY_PERMISSION_SET.has(permission));
    if (adminOnly) {
        return { ok: false, error: `Permissão exclusiva de administrador e não concedível a professores: ${adminOnly}.` };
    }

    return { ok: true, permissions: expandPermissionDependencies(requested) };
}

function isProfessorAccount(account) {
    return account && account.role === 'professor';
}

function getEffectiveAdminPermissions(account) {
    if (!isProfessorAccount(account)) return new Set(ADMIN_PERMISSION_VALUES);
    return new Set([
        ...PROFESSOR_DEFAULT_PERMISSIONS,
        ...normalizeAdditionalPermissions(account.additionalPermissions),
    ]);
}

function canAccessAdminPermission(account, permission) {
    return !permission || getEffectiveAdminPermissions(account).has(permission);
}

const ADMIN_API_PERMISSION_RULES = Object.freeze([
    { methods: ['GET'], pattern: /^\/whoami$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/accounts$/, permission: 'page.accounts' },
    { methods: ['POST'], pattern: /^\/accounts\/(create|update|delete)$/, permission: 'accounts.manage' },
    { methods: ['POST'], pattern: /^\/teacher-assignments$/, permission: 'accounts.manage' },
    { methods: ['GET'], pattern: /^\/network-info$/, permission: 'page.system' },
    { methods: ['POST'], pattern: /^\/(flush-exam-state|server\/restart|reset)$/, permission: 'system.manage' },
    { methods: ['GET', 'POST'], pattern: /^\/settings$/, permission: 'system.manage' },
    { methods: ['GET', 'POST'], pattern: /^\/trash(?:\/.*)?$/, permission: 'system.manage' },
    { methods: ['GET', 'POST'], pattern: /^\/backup(?:\/.*)?$/, permission: 'system.manage' },
    { methods: ['POST'], pattern: /^\/config$/, permission: 'page.dashboard' },
    { methods: ['POST'], pattern: /^\/(exam-config|online-exam-config)$/, permission: 'page.exams' },
    { methods: ['GET', 'POST'], pattern: /^\/exam-applications(?:\/.*)?$/, permission: 'page.exams' },
    { methods: ['GET', 'POST'], pattern: /^\/exam-history(?:\/.*)?$/, permission: 'page.exams' },
    { methods: ['POST'], pattern: /^\/release-item$/, permission: 'page.materials' },
    { methods: ['GET', 'POST'], pattern: /^\/submissions(?:\/.*)?$/, permission: 'page.results' },
    { methods: ['POST'], pattern: /^\/delete-student$/, permission: 'students.destroy' },
    { methods: ['POST'], pattern: /^\/student\/certificates\/(issue|revoke)$/, permission: 'students.certificates' },
    { methods: ['GET'], pattern: /^\/student\/login-logs$/, permission: 'students.security' },
    { methods: ['GET', 'POST'], pattern: /^\/(students|student(?:\/.*)?|reset-password|delete-student)$/, permission: 'page.students' },
    { methods: ['GET', 'POST'], pattern: /^\/enrollment-requests(?:\/.*)?$/, permission: 'page.students' },
    { methods: ['GET', 'POST'], pattern: /^\/attendance(?:\/.*)?$/, permission: 'page.students' },
    { methods: ['GET', 'POST'], pattern: /^\/announcements(?:\/.*)?$/, permission: 'page.forum' },
    { methods: ['POST'], pattern: /^\/forum\/(resolve|faq|restore)$/, permission: 'page.forum' },
    { methods: ['POST'], pattern: /^\/forum\/purge$/, permission: 'forum.purge' },
    { methods: ['GET', 'POST'], pattern: /^\/library(?:\/.*)?$/, permission: 'page.editor' },


    { methods: ['POST'], pattern: /^\/change-password$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/classes$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/course-summaries$/, permission: 'page.dashboard' },
    { methods: ['POST'], pattern: /^\/class\/(create|update|toggle-registration|delete)$/, permission: 'classes.manage' },
    { methods: ['POST'], pattern: /^\/course\/disciplinas$/, permission: 'course.manage' },
    { methods: ['POST'], pattern: /^\/course\/grade-templates$/, permission: 'course.manage' },
    { methods: ['GET'], pattern: /^\/courses\/[^/]+\/structure$/, permission: 'page.editor' },
    { methods: ['POST'], pattern: /^\/courses\/[^/]+\/structure$/, permission: 'page.editor' },
    { methods: ['POST'], pattern: /^\/courses\/[^/]+\/clone$/, permission: 'course.manage' },
    { methods: ['POST'], pattern: /^\/courses\/[^/]+\/purge$/, permission: 'course.purge' },
    { methods: ['GET'], pattern: /^\/archived-courses$/, permission: 'course.manage' },
    { methods: ['POST'], pattern: /^\/archived-courses\/restore$/, permission: 'course.manage' },
    { methods: ['POST'], pattern: /^\/archived-courses\/delete$/, permission: 'course.purge' },
    { methods: ['GET', 'PUT', 'POST'], pattern: /^\/(material|evaluation)(?:\/.*)?$/, permission: 'page.editor' },
    { methods: ['POST'], pattern: /^\/(upload|upload-image)$/, permission: 'page.editor' },
    { methods: ['POST'], pattern: /^\/(server-exam-control|adjust-student-time|assign-student-version|unlock-student-focus|send-broadcast-message)$/, permission: 'page.monitor' },
    { methods: ['GET', 'POST'], pattern: /^\/message-history(?:\/.*)?$/, permission: 'page.monitor' },
    { methods: ['GET', 'POST'], pattern: /^\/question-reports(?:\/.*)?$/, permission: 'page.monitor' },
    { methods: ['POST'], pattern: /^\/(correct-live-question|annul-question|replace-question)$/, permission: 'page.monitor' },
    { methods: ['GET'], pattern: /^\/(monitor-status|monitor-review|proctoring-logs|exam-keystrokes)\/.*$/, permission: 'page.monitor' },
    { methods: ['GET'], pattern: /^\/export-grades\/.*$/, permission: 'page.results' },
    { methods: ['GET'], pattern: /^\/exam-analytics\/.*$/, permission: 'page.results' },
    { methods: ['GET', 'POST'], pattern: /^\/question-bank(?:\/.*)?$/, permission: 'page.exams' },
    { methods: ['POST'], pattern: /^\/forum\/all$/, permission: 'page.forum' },
    { methods: ['GET', 'POST'], pattern: /^\/preferences$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/dashboard\/students-overview$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/dashboard\/(now|queue|trends)$/, permission: 'page.dashboard' },
    { methods: ['GET'], pattern: /^\/schools$/, permission: 'schools.scope' },
    { methods: ['POST'], pattern: /^\/schools\/update$/, permission: 'schools.scope' },
    { methods: ['POST'], pattern: /^\/schools\/(create|delete)$/, permission: 'branding.manage' },
]);

function resolveAdminApiPermission(method, path) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const normalizedPath = String(path || '/').split('?')[0];
    const rule = ADMIN_API_PERMISSION_RULES.find(item => item.methods.includes(normalizedMethod) && item.pattern.test(normalizedPath));
    return rule ? rule.permission : undefined;
}

module.exports = {
    ADMIN_PERMISSION_VALUES,
    PROFESSOR_DEFAULT_PERMISSIONS,
    normalizeAdditionalPermissions,
    parseAdditionalPermissions,
    isProfessorAccount,
    getEffectiveAdminPermissions,
    canAccessAdminPermission,
    resolveAdminApiPermission,
};
