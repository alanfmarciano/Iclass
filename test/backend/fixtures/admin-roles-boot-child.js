// Processo filho de test/backend/admin-roles-matrix.test.js: cada execução é um boot do
// banco (ICLASS_DATA_DIR). 'seed' grava contas de cada papel; 'read' devolve as contas
// como o boot as deixou e o resumo do whoami de cada uma. Imprime '@@' + JSON.
const db = require('../../../backend/database.js');
const { adminAccessSummary } = require('../../../backend/utils/adminPermissions.js');

const scenarios = {
    async seed() {
        db.memory.schools = [{ id: 'escola_a', name: 'Escola A' }];
        db.memory.courses = [{ id: 'curso_a', name: 'Curso A', schoolId: 'escola_a', structure: [] }];
        db.memory.classes = [{ name: '1A', courseId: 'curso_a', period: 'Manhã', onlineExamConfigs: {} }];
        const base = { password: db.hashPassword('Senha-forte-2026'), assignedClasses: [], assignedSchoolIds: [], assignedCourseIds: [], additionalPermissions: [] };
        db.memory.admins = [
            { ...base, email: 'adm@boot.local', name: 'Admin', role: 'admin' },
            { ...base, email: 'legado@boot.local', name: 'Legado', role: undefined },
            { ...base, email: 'estranho@boot.local', name: 'Estranho', role: 'superusuario' },
            { ...base, email: 'prof@boot.local', name: 'Prof', role: 'professor', assignedClasses: [{ courseId: 'curso_a', className: '1A' }] },
            { ...base, email: 'mon@boot.local', name: 'Mon', role: 'monitor', assignedClasses: [{ courseId: 'curso_a', className: '1A' }] },
            { ...base, email: 'sec@boot.local', name: 'Sec', role: 'secretaria', assignedSchoolIds: ['escola_a'], assignedCourseIds: ['curso_a'], assignedClasses: [{ courseId: 'curso_a', className: '1A' }], additionalPermissions: ['page.forum', 'system.manage'] },
            { ...base, email: 'coord@boot.local', name: 'Coord', role: 'coordenacao', assignedSchoolIds: ['escola_a'] },
        ];
        await db.save();
        return { ok: true };
    },
    async read() {
        const admins = (db.memory.admins || []).map(account => ({
            email: account.email,
            role: account.role,
            assignedClasses: account.assignedClasses,
            assignedSchoolIds: account.assignedSchoolIds,
            assignedCourseIds: account.assignedCourseIds,
            additionalPermissions: account.additionalPermissions,
        })).sort((a, b) => a.email.localeCompare(b.email));
        const whoami = Object.fromEntries((db.memory.admins || []).map(account => [account.email, adminAccessSummary(account)]));
        return { admins, whoami };
    },
};

(async () => {
    await db.init();
    const result = await scenarios[process.argv[2]]();
    await db.save();
    await db.close();
    process.stdout.write(`@@${JSON.stringify(result)}\n`);
})().catch(err => {
    process.stderr.write(String((err && err.stack) || err));
    process.exit(1);
});
