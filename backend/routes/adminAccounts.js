const express = require('express');
const db = require('../database.js');
const { recordAudit } = require('../utils/audit.js');
const {
    DB_ADMINS_FILE,
    readJSON,
    validateAdmin,
    issueAdminSession,
    SERVER_INSTANCE_ID,
} = require('../middlewares.js');
const { parseAdditionalPermissions, isProfessorAccount } = require('../utils/adminPermissions.js');
const { revokeAdminSession, revokeAdminSessions } = require('../utils/authSessions.js');
const { attemptPasswordLogin, logRole } = require('../utils/passwordLogin.js');
const loginGuard = require('../utils/loginGuard.js');
const { recordLoginLog } = require('../utils/security.js');
const { passwordPolicyRefusal, validateNewPassword } = require('../utils/passwordPolicy.js');
const { adminPasswordChangeState, passwordChangeRuleActive, passwordChanged, requirePasswordChange } = require('../utils/passwordChange.js');
const { body, bool, dict, either, list, shape, str } = require('../utils/inputSchema.js');

// Entrada do login e das contas (fase 2, H9b: ENG-03, ENG-04): tipo e tamanho
// (utils/inputSchema.js), a partir do que LoginPage, AdminEditPage e PasswordChangeForm
// mandam. Nas rotas de /api/admin a sessão já foi conferida (adminRbacGuard); a presença
// de cada campo continua com a rota, com as mensagens de antes.
const accountEmailField = () => str({ max: 254, nullable: true, label: 'e-mail' });
const accountPasswordField = (label = 'senha') => str({ max: 200, trim: false, nullable: true, label });
const assignmentIdsField = (label) => list(str({ max: 100, label }), { max: 500, nullable: true, label });
const accountFields = () => ({
    email: accountEmailField(),
    name: str({ max: 120, nullable: true, label: 'nome' }),
    role: str({ max: 40, nullable: true, label: 'papel' }),
    // Turmas atribuídas: o nome da turma (tela antiga) ou { courseId, className }.
    assignedClasses: list(either([
        str({ max: 200 }),
        shape({
            courseId: str({ max: 100, nullable: true, label: 'curso da turma' }),
            className: str({ max: 200, nullable: true, label: 'turma' }),
            name: str({ max: 200, nullable: true, label: 'turma' }),
        }),
    ], { label: 'turmas atribuídas' }), { max: 500, nullable: true, label: 'turmas atribuídas' }),
    assignedSchoolIds: assignmentIdsField('escolas atribuídas'),
    assignedCourseIds: assignmentIdsField('cursos atribuídos'),
    additionalPermissions: list(str({ max: 100, label: 'permissões extras' }), { max: 100, nullable: true, label: 'permissões extras' }),
    requirePasswordChange: bool({ nullable: true, label: 'pedir troca no primeiro acesso' }),
});
// Preferências da tela (painel, fórum, portão de curso): chave curta e no máximo 100
// chaves; as preferências juntas ficam em até 64 KB (só recusa quando crescem, para a
// conta que já passou disso continuar salvando o que diminui).
const PREFERENCES_MAX_BYTES = 64 * 1024;
const PREFERENCES_MAX_KEYS = 100;
const ACCOUNT_SCHEMAS = {
    // Login: tipo errado continua com a mensagem de antes ('Informe e-mail e senha.').
    login: body({
        email: str({ max: 254, nullable: true, label: 'e-mail', typeMessage: 'Informe e-mail e senha.' }),
        password: str({ max: 200, trim: false, nullable: true, label: 'senha', typeMessage: 'Informe e-mail e senha.' }),
    }),
    create: body({ ...accountFields(), password: accountPasswordField() }),
    update: body(accountFields()),
    delete: body({ email: accountEmailField() }),
    changePassword: body({ currentPassword: accountPasswordField('senha atual'), newPassword: accountPasswordField('nova senha') }),
    logout: body({}),
    preferences: body({}),
};
const PREFERENCES_DICT = dict(null, { maxKeys: PREFERENCES_MAX_KEYS, keyPattern: /^[A-Za-z0-9_.-]{1,64}$/, label: 'preferências' });

function jsonBytes(value) {
    try { return Buffer.byteLength(JSON.stringify(value || {}), 'utf8'); } catch (_) { return Infinity; }
}

// Gestão de contas (criar/editar/excluir) é exclusiva de administradores.
// Backstop além do RBAC: mesmo que a capability accounts.manage vaze para um
// professor, o handler recusa — impede criar conta admin ou auto-promoção.
function requireAdminManager(res, requester) {
    if (isProfessorAccount(requester)) {
        res.status(403).json({ error: 'Apenas administradores podem gerenciar contas.' });
        return false;
    }
    return true;
}

const ADMIN_ACCOUNT_ROLES = new Set(['admin', 'professor']);

function parseAdminAccountRole(value, fallback = 'admin') {
    if (value === undefined || value === null || String(value).trim() === '') {
        return { ok: true, role: fallback };
    }
    const role = String(value).trim().toLowerCase();
    if (!ADMIN_ACCOUNT_ROLES.has(role)) return { ok: false, error: 'Papel inválido. Use admin ou professor.' };
    return { ok: true, role };
}

function parseAssignedClasses(value) {
    if (value === undefined) return { ok: true, classes: undefined };
    if (!Array.isArray(value)) return { ok: false, error: 'Turmas atribuídas devem ser enviadas como uma lista.' };

    const classes = [];
    for (const item of value) {
        if (item && typeof item === 'object') {
            const assignment = {
                courseId: String(item.courseId || '').trim(),
                className: String(item.className || item.name || '').trim(),
            };
            if (!assignment.courseId || !assignment.className) {
                return { ok: false, error: 'Cada turma deve informar courseId e className.' };
            }
            classes.push(assignment);
            continue;
        }
        const className = String(item || '').trim();
        if (!className) continue;
        const matches = (db.memory.classes || []).filter(cls => cls.name === className);
        if (matches.length !== 1) {
            return { ok: false, error: `A turma "${className}" é inexistente ou ambígua; selecione também o curso.` };
        }
        classes.push({ courseId: matches[0].courseId, className });
    }
    return { ok: true, classes: [...new Map(classes.map(item => [`${item.courseId}::${item.className}`, item])).values()] };
}

function findUnknownAssignedClass(assignedClasses) {
    return (assignedClasses || []).find(assignment => !(db.memory.classes || []).some(cls => (
        cls.name === assignment.className && cls.courseId === assignment.courseId
    )));
}

function parseAssignmentIds(value, label) {
    if (value === undefined) return { ok: true, ids: undefined };
    if (!Array.isArray(value)) return { ok: false, error: `${label} devem ser enviados como uma lista.` };
    return { ok: true, ids: [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] };
}

function findUnknownSchool(ids) {
    return (ids || []).find(id => !(db.memory.schools || []).some(school => String(school.id) === id));
}

function findUnknownCourse(ids) {
    return (ids || []).find(id => !(db.memory.courses || []).some(course => (
        String(course.id) === id && !course.deleted && course.status !== 'deleted' && course.status !== 'inactive'
    )));
}

function assignmentSnapshot(account) {
    return {
        assignedSchoolIds: Array.isArray(account && account.assignedSchoolIds) ? account.assignedSchoolIds : [],
        assignedCourseIds: Array.isArray(account && account.assignedCourseIds) ? account.assignedCourseIds : [],
        assignedClasses: Array.isArray(account && account.assignedClasses) ? account.assignedClasses : [],
    };
}

// Escopo do professor (turmas, cursos, escolas): atalho para recordAudit, na categoria
// 'account', gravando também type/actorEmail/at como as entradas antigas.
function recordAssignmentAudit(req, requester, targetEmail, before, after) {
    const timestamp = Date.now();
    recordAudit(db.memory, {
        req,
        actor: requester,
        action: 'professor_assignments_updated',
        category: 'account',
        targetEmail,
        before,
        after,
    }, { timestamp, legacy: { type: 'professor_assignments_updated', actorEmail: requester && requester.email, at: timestamp } });
}

// Fotografia da conta para a auditoria (account_created, account_updated,
// account_deleted): sem senha e sem preferências da tela.
function accountAuditSnapshot(account) {
    if (!account) return null;
    return {
        name: account.name || '',
        email: account.email || '',
        role: account.role || 'admin',
        additionalPermissions: Array.isArray(account.additionalPermissions) ? account.additionalPermissions : [],
    };
}

// Resposta do login e do whoami: a mesma, para o painel montar a sessão do mesmo jeito.
function adminSessionPayload(account, sessionToken) {
    // A tela segue o que vale agora (com TEST_MODE, a troca do H5a não é pedida).
    const passwordChange = adminPasswordChangeState(account);
    return {
        email: account.email,
        name: account.name || '',
        role: account.role || 'admin',
        assignedSchoolIds: Array.isArray(account.assignedSchoolIds) ? account.assignedSchoolIds : [],
        assignedCourseIds: Array.isArray(account.assignedCourseIds) ? account.assignedCourseIds : [],
        assignedClasses: Array.isArray(account.assignedClasses) ? account.assignedClasses : [],
        additionalPermissions: Array.isArray(account.additionalPermissions) ? account.additionalPermissions : [],
        mustChangePassword: passwordChange.required === true,
        ...(passwordChange.required ? { passwordChangeReason: passwordChange.reason } : {}),
        sessionToken,
        instanceId: SERVER_INSTANCE_ID,
    };
}

function createAdminAccountsRouter() {
    const router = express.Router();

    // Login do professor e do administrador (SEG-03): a senha passa só aqui, uma vez, e
    // a resposta traz o token da sessão (x-admin-session), igual ao whoami. Fica fora de
    // /api/admin para não passar pelo adminRbacGuard; a política de rede (utils/
    // networkPolicy.js) já decidiu antes se este aparelho pode abrir o painel. A senha é
    // conferida pelo attemptPasswordLogin (scrypt assíncrono, teto por IP, regravação do
    // hash antigo), o único caminho que confere senha.
    router.post('/api/session/admin-login', ACCOUNT_SCHEMAS.login, async (req, res) => {
        const login = await attemptPasswordLogin({ kind: 'admin', email: req.body.email, password: req.body.password, req });
        if (!login.ok) return res.status(login.status).json(login.body);
        // Senha fraca pela política de hoje (H5a, decisão P3 do Alan): a troca passa a ser
        // pedida no painel (adminRbacGuard), menos com TEST_MODE (contas demo).
        if (passwordChangeRuleActive() && login.weakPassword && login.account.mustChangePassword !== true) {
            requirePasswordChange(login.account, 'weak');
        }
        const sessionToken = issueAdminSession(login.account.email);
        // A entrada do instrutor também fica em loginLogs (H5b): antes só as do aluno.
        recordLoginLog(db.memory, { email: login.email, role: logRole('admin', login.account), status: 'success', req });
        // O login espera o COMMIT, como o do aluno (hash regravado e, com o H3a-2, a sessão).
        await db.save();
        res.json(adminSessionPayload(login.account, sessionToken));
    });

    router.get('/api/admin/accounts', (req, res) => {
        validateAdmin(req, res, () => {
            const admins = readJSON(DB_ADMINS_FILE);
            const now = Date.now();
            res.json(admins.map(account => {
                const listed = {
                    name: account.name,
                    email: account.email,
                    role: account.role || 'admin',
                    assignedSchoolIds: Array.isArray(account.assignedSchoolIds) ? account.assignedSchoolIds : [],
                    assignedCourseIds: Array.isArray(account.assignedCourseIds) ? account.assignedCourseIds : [],
                    assignedClasses: Array.isArray(account.assignedClasses) ? account.assignedClasses : [],
                    additionalPermissions: Array.isArray(account.additionalPermissions) ? account.additionalPermissions : [],
                };
                // Atraso de login por senhas erradas (H5b): selo e "Liberar login" em Contas.
                const loginProtection = account.email ? loginGuard.protectionFor(loginGuard.accountKey('admin', account.email), now) : null;
                if (loginProtection) listed.loginProtection = loginProtection;
                return listed;
            }));
        });
    });

    // Liberar login de uma conta de instrutor (H5b; SEG-06): depois de muitas senhas
    // erradas a conta espera antes de tentar de novo (utils/loginGuard.js). Só
    // administrador (accounts.manage e requireAdminManager); fica na auditoria
    // (account_login_unlocked). Não mexe na senha.
    router.post('/api/admin/accounts/unlock-login', (req, res) => {
        validateAdmin(req, res, async (config, currentAdmin) => {
            if (!requireAdminManager(res, currentAdmin)) return;
            const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
            if (!email) return res.status(400).json({ success: false, error: 'Informe o e-mail da conta.', field: 'email' });
            const account = (db.memory.admins || []).find(item => item && item.email && item.email.toLowerCase() === email);
            if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
            const key = loginGuard.accountKey('admin', email);
            // Só a conta que chegou ao atraso (5 senhas erradas ou mais) é liberada e vai para a
            // auditoria. Com 1 a 4 falhas não há bloqueio: a resposta diz isso e nada muda
            // (antes, o contador era apagado e a auditoria ganhava um desbloqueio vazio; sobra do
            // H5b, J2).
            const before = loginGuard.protectionFor(key);
            const released = before ? loginGuard.clear(key) : false;
            if (released) {
                recordAudit(db.memory, {
                    req,
                    actor: currentAdmin,
                    action: 'account_login_unlocked',
                    category: 'account',
                    targetEmail: email,
                    details: { failures: before.failures, retryAt: before.retryAt },
                });
                await db.save();
            }
            res.json({
                success: true,
                unlocked: released,
                message: released ? 'Login liberado. A conta já pode entrar.' : 'Esta conta não estava com o login em espera.',
            });
        });
    });

    router.post('/api/admin/accounts/create', ACCOUNT_SCHEMAS.create, (req, res) => {
        validateAdmin(req, res, async (config, currentAdmin) => {
            if (!requireAdminManager(res, currentAdmin)) return;
            const { name, email, password } = req.body;
            if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string'
                || name.trim() === '' || email.trim() === '' || password.trim() === '') {
                const field = (typeof name !== 'string' || name.trim() === '') ? 'name'
                    : ((typeof email !== 'string' || email.trim() === '') ? 'email' : 'password');
                return res.status(400).json({ success: false, error: 'Dados incompletos ou inválidos.', field });
            }
            // Política de senha do instrutor (H5a, SEG-06): pelo menos 10 caracteres, como a
            // troca de senha já exigia; antes a criação aceitava a senha "1".
            const policy = validateNewPassword(password, { kind: 'instructor', email, name });
            if (!policy.ok) return res.status(400).json(passwordPolicyRefusal(policy));
            // "Pedir troca no primeiro acesso" vem marcada (decisão P3 do Alan); sem o campo
            // (tela antiga), vale marcada.
            const askPasswordChange = req.body.requirePasswordChange !== false;
            // Hash com o scrypt assíncrono (DES-07) antes de ler as contas: a conferência de
            // e-mail repetido e a gravação rodam depois da espera, de uma vez.
            const passwordHash = await db.hashPasswordAsync(password.trim());

            const parsedRole = parseAdminAccountRole(req.body.role);
            if (!parsedRole.ok) return res.status(400).json({ error: parsedRole.error });
            const parsedClasses = parseAssignedClasses(req.body.assignedClasses);
            if (!parsedClasses.ok) return res.status(400).json({ error: parsedClasses.error });
            const parsedSchools = parseAssignmentIds(req.body.assignedSchoolIds, 'Escolas atribuídas');
            if (!parsedSchools.ok) return res.status(400).json({ error: parsedSchools.error });
            const parsedCourses = parseAssignmentIds(req.body.assignedCourseIds, 'Cursos atribuídos');
            if (!parsedCourses.ok) return res.status(400).json({ error: parsedCourses.error });
            const parsedPermissions = parseAdditionalPermissions(req.body.additionalPermissions);
            if (!parsedPermissions.ok) return res.status(400).json({ error: parsedPermissions.error });

            const role = parsedRole.role;
            let assignedClasses = parsedClasses.classes || [];
            let assignedSchoolIds = parsedSchools.ids || [];
            let assignedCourseIds = parsedCourses.ids || [];
            let additionalPermissions = parsedPermissions.permissions || [];
            if (role === 'professor') {
                const invalid = findUnknownAssignedClass(assignedClasses);
                if (invalid) return res.status(400).json({ error: `Turma inexistente: ${invalid.className}.` });
                const invalidSchool = findUnknownSchool(assignedSchoolIds);
                if (invalidSchool) return res.status(400).json({ error: `Escola inexistente: ${invalidSchool}.` });
                const invalidCourse = findUnknownCourse(assignedCourseIds);
                if (invalidCourse) return res.status(400).json({ error: `Curso inexistente: ${invalidCourse}.` });
            } else {
                assignedClasses = [];
                assignedSchoolIds = [];
                assignedCourseIds = [];
                additionalPermissions = [];
            }

            const admins = readJSON(DB_ADMINS_FILE);
            const normalizedEmail = email.trim().toLowerCase();
            if (admins.some(account => account.email && account.email.toLowerCase() === normalizedEmail)) {
                return res.status(400).json({ error: 'E-mail administrativo já cadastrado.' });
            }
            const created = {
                name: name.trim(),
                email: normalizedEmail,
                password: passwordHash,
                role,
                assignedSchoolIds,
                assignedCourseIds,
                assignedClasses,
                additionalPermissions,
                passwordChangedAt: new Date().toISOString(),
            };
            if (askPasswordChange) requirePasswordChange(created, 'created');
            admins.push(created);
            db.memory.admins = admins;
            // Conta nova com o e-mail de uma que já foi excluída não herda sessão que tenha
            // ficado dela (gravada em auth_sessions e retomada no boot, H3a-2).
            revokeAdminSessions(db.memory, normalizedEmail);
            recordAudit(db.memory, {
                req,
                actor: currentAdmin,
                action: 'account_created',
                category: 'account',
                targetEmail: normalizedEmail,
                after: accountAuditSnapshot(created),
                details: { mustChangePassword: askPasswordChange },
            });
            await db.save();
            // O que vale no primeiro acesso: com TEST_MODE a troca não é pedida (o pedido
            // fica gravado na conta, como a escolha do administrador).
            res.json({ success: true, mustChangePassword: askPasswordChange && passwordChangeRuleActive() });
        });
    });

    router.post('/api/admin/accounts/update', ACCOUNT_SCHEMAS.update, (req, res) => {
        validateAdmin(req, res, async (config, currentAdmin) => {
            if (!requireAdminManager(res, currentAdmin)) return;
            const email = (req.body.email || '').trim().toLowerCase();
            if (!email) return res.status(400).json({ error: 'E-mail não informado.' });
            const admins = readJSON(DB_ADMINS_FILE);
            const account = admins.find(item => item.email && item.email.toLowerCase() === email);
            const assignmentsBefore = account ? assignmentSnapshot(account) : null;
            if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });

            const nextName = req.body.name === undefined ? (account.name || '') : String(req.body.name).trim();
            if (!nextName) return res.status(400).json({ error: 'Nome da conta não pode ficar vazio.' });
            const parsedRole = parseAdminAccountRole(req.body.role, account.role === 'professor' ? 'professor' : 'admin');
            if (!parsedRole.ok) return res.status(400).json({ error: parsedRole.error });
            const parsedClasses = parseAssignedClasses(req.body.assignedClasses);
            if (!parsedClasses.ok) return res.status(400).json({ error: parsedClasses.error });
            const parsedSchools = parseAssignmentIds(req.body.assignedSchoolIds, 'Escolas atribuídas');
            if (!parsedSchools.ok) return res.status(400).json({ error: parsedSchools.error });
            const parsedCourses = parseAssignmentIds(req.body.assignedCourseIds, 'Cursos atribuídos');
            if (!parsedCourses.ok) return res.status(400).json({ error: parsedCourses.error });
            const parsedPermissions = parseAdditionalPermissions(req.body.additionalPermissions);
            if (!parsedPermissions.ok) return res.status(400).json({ error: parsedPermissions.error });

            const nextRole = parsedRole.role;
            const nextAssignedClasses = nextRole === 'professor'
                ? (parsedClasses.classes === undefined ? (Array.isArray(account.assignedClasses) ? account.assignedClasses : []) : parsedClasses.classes)
                : [];
            const nextAssignedSchoolIds = nextRole === 'professor'
                ? (parsedSchools.ids === undefined ? (Array.isArray(account.assignedSchoolIds) ? account.assignedSchoolIds : []) : parsedSchools.ids)
                : [];
            const nextAssignedCourseIds = nextRole === 'professor'
                ? (parsedCourses.ids === undefined ? (Array.isArray(account.assignedCourseIds) ? account.assignedCourseIds : []) : parsedCourses.ids)
                : [];
            const invalid = findUnknownAssignedClass(nextAssignedClasses);
            if (nextRole === 'professor' && invalid) {
                return res.status(400).json({ error: `Turma inexistente: ${invalid.className}.` });
            }
            const invalidSchool = findUnknownSchool(nextAssignedSchoolIds);
            if (nextRole === 'professor' && invalidSchool) return res.status(400).json({ error: `Escola inexistente: ${invalidSchool}.` });
            const invalidCourse = findUnknownCourse(nextAssignedCourseIds);
            if (nextRole === 'professor' && invalidCourse) return res.status(400).json({ error: `Curso inexistente: ${invalidCourse}.` });
            const nextAdditionalPermissions = nextRole === 'professor'
                ? (parsedPermissions.permissions === undefined
                    ? (Array.isArray(account.additionalPermissions) ? account.additionalPermissions : [])
                    : parsedPermissions.permissions)
                : [];

            const accountBefore = accountAuditSnapshot(account);
            account.name = nextName;
            account.role = nextRole;
            account.assignedSchoolIds = nextAssignedSchoolIds;
            account.assignedCourseIds = nextAssignedCourseIds;
            account.assignedClasses = nextAssignedClasses;
            account.additionalPermissions = nextAdditionalPermissions;
            const assignmentsAfter = assignmentSnapshot(account);
            if (assignmentsBefore && JSON.stringify(assignmentsBefore) !== JSON.stringify(assignmentsAfter)) {
                recordAssignmentAudit(req, currentAdmin, email, assignmentsBefore, assignmentsAfter);
            }
            // Nome, papel e permissões extras (as turmas, os cursos e as escolas já ficam em
            // professor_assignments_updated, acima).
            const accountAfter = accountAuditSnapshot(account);
            if (JSON.stringify(accountBefore) !== JSON.stringify(accountAfter)) {
                recordAudit(db.memory, {
                    req,
                    actor: currentAdmin,
                    action: 'account_updated',
                    category: 'account',
                    targetEmail: email,
                    before: accountBefore,
                    after: accountAfter,
                });
            }
            db.memory.admins = admins;
            await db.save();
            res.json({ success: true });
        });
    });

    // Confere a sessão guardada no navegador. Só aceita o token (validateAdmin): nunca
    // cria sessão nova, e devolve o mesmo token que recebeu.
    router.get('/api/admin/whoami', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            res.json(adminSessionPayload(matchedAdmin, req.adminSessionToken));
        });
    });

    router.post('/api/session/logout', (req, res) => {
        validateAdmin(req, res, async () => {
            // Fora de /api/admin: o corpo é conferido depois da sessão (quem não entrou
            // recebe o 401, não um 400).
            if (!ACCOUNT_SCHEMAS.logout.check(req, res)) return;
            revokeAdminSession(db.memory, req.adminSessionToken, { reason: 'logout' });
            // Também sai da tabela auth_sessions (H3a-2): não volta depois de um reinício.
            await db.save();
            res.json({ success: true });
        });
    });

    router.post('/api/admin/teacher-assignments', (req, res) => {
        validateAdmin(req, res, async (config, currentAdmin) => {
            if (!requireAdminManager(res, currentAdmin)) return;
            const email = String(req.body.email || '').trim().toLowerCase();
            if (!email) return res.status(400).json({ error: 'Professor não informado.' });
            const account = (db.memory.admins || []).find(item => item && String(item.email || '').toLowerCase() === email);
            if (!account || account.role !== 'professor') return res.status(404).json({ error: 'Professor não encontrado.' });

            const parsedSchools = parseAssignmentIds(req.body.assignedSchoolIds, 'Escolas atribuídas');
            const parsedCourses = parseAssignmentIds(req.body.assignedCourseIds, 'Cursos atribuídos');
            const parsedClasses = parseAssignedClasses(req.body.assignedClasses);
            if (!parsedSchools.ok) return res.status(400).json({ error: parsedSchools.error });
            if (!parsedCourses.ok) return res.status(400).json({ error: parsedCourses.error });
            if (!parsedClasses.ok) return res.status(400).json({ error: parsedClasses.error });

            const next = {
                assignedSchoolIds: parsedSchools.ids === undefined ? assignmentSnapshot(account).assignedSchoolIds : parsedSchools.ids,
                assignedCourseIds: parsedCourses.ids === undefined ? assignmentSnapshot(account).assignedCourseIds : parsedCourses.ids,
                assignedClasses: parsedClasses.classes === undefined ? assignmentSnapshot(account).assignedClasses : parsedClasses.classes,
            };
            const invalidSchool = findUnknownSchool(next.assignedSchoolIds);
            const invalidCourse = findUnknownCourse(next.assignedCourseIds);
            const invalidClass = findUnknownAssignedClass(next.assignedClasses);
            if (invalidSchool) return res.status(400).json({ error: `Escola inexistente: ${invalidSchool}.` });
            if (invalidCourse) return res.status(400).json({ error: `Curso inexistente: ${invalidCourse}.` });
            if (invalidClass) return res.status(400).json({ error: `Turma inexistente: ${invalidClass.className}.` });

            const before = assignmentSnapshot(account);
            account.assignedSchoolIds = next.assignedSchoolIds;
            account.assignedCourseIds = next.assignedCourseIds;
            account.assignedClasses = next.assignedClasses;
            recordAssignmentAudit(req, currentAdmin, email, before, assignmentSnapshot(account));
            await db.save();
            res.json({ success: true, assignments: assignmentSnapshot(account) });
        });
    });

    router.post('/api/admin/accounts/delete', ACCOUNT_SCHEMAS.delete, (req, res) => {
        validateAdmin(req, res, async (config, currentAdmin) => {
            if (!requireAdminManager(res, currentAdmin)) return;
            const { email } = req.body;
            if (!email) return res.status(400).json({ error: 'E-mail não informado.' });
            const targetEmail = email.trim().toLowerCase();
            if (currentAdmin.email.toLowerCase() === targetEmail) {
                return res.status(400).json({ error: 'Você não pode excluir a sua própria conta conectada.' });
            }

            const admins = readJSON(DB_ADMINS_FILE);
            const target = admins.find(account => account.email && account.email.toLowerCase() === targetEmail);
            const adminCount = admins.filter(account => !account.role || account.role === 'admin').length;
            if (target && (!target.role || target.role === 'admin') && adminCount <= 1) {
                return res.status(400).json({ error: 'Não é possível excluir o único administrador cadastrado.' });
            }
            const filtered = admins.filter(account => !account.email || account.email.toLowerCase() !== targetEmail);
            if (admins.length === filtered.length) return res.status(404).json({ error: 'Administrador não encontrado.' });
            db.memory.admins = filtered;
            // As sessões abertas da conta acabam aqui e saem da tabela auth_sessions na
            // gravação (H3a-2). Antes ficavam na memória (401 'Conta não encontrada.' a cada
            // pedido) e, gravadas, voltavam no boot: recriada a conta com o mesmo e-mail, o
            // token antigo entrava de novo.
            revokeAdminSessions(db.memory, targetEmail);
            recordAudit(db.memory, {
                req,
                actor: currentAdmin,
                action: 'account_deleted',
                category: 'account',
                targetEmail,
                before: accountAuditSnapshot(target),
            });
            await db.save();
            res.json({ success: true, message: 'Administrador removido com sucesso!' });
        });
    });

    router.post('/api/admin/change-password', ACCOUNT_SCHEMAS.changePassword, (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const { newPassword, currentPassword } = req.body;
            if (typeof newPassword !== 'string' || !newPassword.trim()) {
                return res.status(400).json({ success: false, error: 'Informe a nova senha.', field: 'newPassword' });
            }
            // Política de senha do instrutor (H5a): os 10 caracteres de antes e as regras de
            // senha comum e de dado pessoal.
            const policy = validateNewPassword(newPassword, { kind: 'instructor', email: matchedAdmin.email, name: matchedAdmin.name });
            if (!policy.ok) return res.status(400).json(passwordPolicyRefusal(policy, 'newPassword'));
            // Fora da troca obrigatória inicial (mustChangePassword), exige a senha
            // atual — impede que uma sessão sequestrada troque a senha sem conhecê-la.
            // Também na troca obrigatória de uma conta criada pelo administrador (H5a: a
            // senha nova não pode ser a que ele definiu e conhece) e na troca pedida por
            // senha fraca (a sessão roubada não troca a senha sem saber a atual). Fica sem
            // a senha atual só a troca da senha temporária do launcher, como antes.
            // A senha atual é conferida pelo attemptPasswordLogin, o único caminho que
            // confere senha: scrypt assíncrono (DES-07) e o mesmo teto por IP do login do
            // instrutor, para a sessão roubada não testar senhas sem limite (429).
            let storedBefore = matchedAdmin.password;
            const needsCurrent = matchedAdmin.mustChangePassword !== true
                || matchedAdmin.passwordChangeReason === 'created' || matchedAdmin.passwordChangeReason === 'weak';
            if (needsCurrent && (typeof currentPassword !== 'string' || !currentPassword.trim())) {
                return res.status(400).json({ success: false, error: 'Informe a senha atual.', currentPasswordRequired: true, field: 'currentPassword' });
            }
            if (needsCurrent && newPassword.trim() === currentPassword.trim()) {
                return res.status(400).json({ success: false, error: 'A nova senha precisa ser diferente da atual.', passwordPolicy: true, field: 'newPassword' });
            }
            if (needsCurrent) {
                const check = await attemptPasswordLogin({ kind: 'admin', email: matchedAdmin.email, password: currentPassword, req, purpose: 'change_password' });
                if (!check.ok && check.status === 429) return res.status(429).json(check.body);
                // Outra troca terminou durante a conferência (a senha digitada não vale
                // para a nova) ou a conta foi regravada no meio: 409, não "incorreta".
                if (!check.ok && check.passwordChanged) {
                    return res.status(409).json({ error: 'A senha desta conta acabou de ser alterada. Confira e tente de novo.' });
                }
                if (!check.ok) return res.status(400).json({ success: false, error: 'Senha atual incorreta.', field: 'currentPassword' });
                // O valor que a conferência confirmou (o hash novo, se o antigo foi
                // regravado): outra troca no meio da espera ainda dá o 409 abaixo.
                if (check.account !== matchedAdmin || matchedAdmin.password !== check.password) {
                    return res.status(409).json({ error: 'A senha desta conta acabou de ser alterada. Confira e tente de novo.' });
                }
                storedBefore = check.password;
            }
            const passwordHash = await db.hashPasswordAsync(newPassword.trim());
            // Outra troca terminou durante a espera: não sobrescreve a senha que ela gravou.
            if (matchedAdmin.password !== storedBefore) {
                return res.status(409).json({ error: 'A senha desta conta acabou de ser alterada. Confira e tente de novo.' });
            }
            const forced = adminPasswordChangeState(matchedAdmin).required === true;
            matchedAdmin.password = passwordHash;
            passwordChanged(matchedAdmin);
            // As outras sessões da conta (outro navegador, outro computador) saem; a deste
            // pedido continua (H5b, SEG-10). Antes a sessão aberta em outro lugar seguia
            // valendo com a senha antiga.
            const endedSessions = revokeAdminSessions(db.memory, matchedAdmin.email, { exceptToken: req.adminSessionToken, reason: 'password_changed' });
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'account_password_changed',
                category: 'account',
                targetEmail: matchedAdmin.email,
                details: { forced, endedSessions },
            });
            await db.save();
            res.json({ success: true, message: 'Senha atualizada com sucesso!', endedSessions });
        });
    });

    router.get('/api/admin/preferences', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => res.json((matchedAdmin && matchedAdmin.preferences) || {}));
    });

    router.post('/api/admin/preferences', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const account = (db.memory.admins || []).find(item => (
                item.email && matchedAdmin && item.email.toLowerCase() === String(matchedAdmin.email || '').toLowerCase()
            ));
            if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
            if (!ACCOUNT_SCHEMAS.preferences.check(req, res)) return;
            // O corpo é o próprio mapa: o `field` da recusa é a chave enviada que não passou
            // ('a b'), a primeira chave nova além das 100, ou a maior das enviadas quando o
            // total passa de 64 KB.
            const checked = PREFERENCES_DICT.run(req.body, '', 'preferências');
            if (!checked.ok) return res.status(400).json({ success: false, error: checked.error, field: checked.field });
            const current = account.preferences && typeof account.preferences === 'object' && !Array.isArray(account.preferences) ? account.preferences : {};
            const merged = { ...current, ...req.body };
            const mergedBytes = jsonBytes(merged);
            const sentKeys = Object.keys(req.body);
            if (Object.keys(merged).length > PREFERENCES_MAX_KEYS && Object.keys(merged).length > Object.keys(current).length) {
                const extra = sentKeys.filter(key => !Object.prototype.hasOwnProperty.call(current, key));
                const field = extra[Math.max(0, PREFERENCES_MAX_KEYS - Object.keys(current).length)] || extra[extra.length - 1] || sentKeys[0];
                return res.status(400).json({ success: false, error: `O campo "preferências" aceita no máximo ${PREFERENCES_MAX_KEYS} itens.`, field });
            }
            if (mergedBytes > PREFERENCES_MAX_BYTES && mergedBytes > jsonBytes(current)) {
                const field = sentKeys.reduce((biggest, key) => (
                    biggest === null || jsonBytes(req.body[key]) > jsonBytes(req.body[biggest]) ? key : biggest
                ), null);
                return res.status(400).json({ success: false, error: 'As preferências desta conta passaram do limite de 64 KB. Limpe favoritos ou modelos de resposta antigos.', field });
            }
            account.preferences = merged;
            await db.save();
            res.json({ success: true, preferences: account.preferences });
        });
    });

    return router;
}

module.exports = { createAdminAccountsRouter };
