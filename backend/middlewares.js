const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./database.js');
const {
    isProfessorAccount,
    canAccessAdminPermission,
    resolveAdminApiPermission,
} = require('./utils/adminPermissions.js');
const { SERVER_INSTANCE_ID, ABSOLUTE_TTL_MS } = require('./utils/sessionConfig.js');
const settingsUtil = require('./utils/settings.js');
const { effectiveStructure } = require('./utils/classContent.js');
const { DATA_DIR } = require('./runtimePaths.js');
const { computeAttemptDeadline } = require('./utils/examDeadline.js');
function absoluteTtlMs() { try { return settingsUtil.getSettings().session.absoluteHours * 3600000; } catch (e) { return ABSOLUTE_TTL_MS; } }

// Caminhos dos arquivos de banco de dados locais
const DB_STUDENTS_FILE = path.join(DATA_DIR, 'db_students.json');
const DB_SUBMISSIONS_FILE = path.join(DATA_DIR, 'db_submissions.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DB_CLASSES_FILE = path.join(DATA_DIR, 'db_classes.json');
const DB_ADMINS_FILE = path.join(DATA_DIR, 'db_admins.json');

// Armazena todos os IPs da rede local
let localIpAddresses = [];
function detectIP() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (let devName in interfaces) {
        let iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            let alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                localIpAddresses.push({ name: devName, address: alias.address });
            }
        }
    }
    if (localIpAddresses.length === 0) {
        localIpAddresses.push({ name: 'localhost', address: 'localhost' });
    }
}
detectIP();

function normalizeIp(ip) {
    if (!ip) return '';
    if (ip.startsWith('::ffff:')) {
        return ip.substring(7);
    }
    if (ip === '::1') {
        return '127.0.0.1';
    }
    return ip;
}

function validateStudentSession(req, res, next) {
    const claimedEmails = [
        req.body && req.body.email,
        req.body && req.body.student && req.body.student.email,
        req.query && req.query.email,
    ].filter(Boolean).map(value => String(value).trim().toLowerCase());
    const distinctClaims = [...new Set(claimedEmails)];
    if (distinctClaims.length > 1) {
        return res.status(403).json({ error: 'A identidade informada não corresponde à sessão autenticada.' });
    }

    const providedToken = req.headers['x-session-token']
        || (req.body && req.body.sessionToken)
        || (req.query && req.query.sessionToken);
    let normalizedEmail = distinctClaims[0] || '';
    const tokenMatch = providedToken
        ? Object.entries(db.memory.sessions || {}).find(([, value]) => value && typeof value === 'object' && value.token === providedToken)
        : null;
    if (normalizedEmail && tokenMatch && tokenMatch[0] !== normalizedEmail) {
        return res.status(403).json({ error: 'A identidade informada não corresponde à sessão autenticada.' });
    }
    if (!normalizedEmail && tokenMatch) {
        normalizedEmail = tokenMatch[0];
    }
    if (!normalizedEmail) {
        return res.status(400).json({ error: 'E-mail do estudante é obrigatório.' });
    }
    const session = (db.memory.sessions || {})[normalizedEmail];
    
    if (!session) {
        return res.status(401).json({
            error: 'Sessão expirada ou não autenticada. Por favor, faça login novamente.',
            sessionRevoked: true
        });
    }
    
    if (typeof session !== 'object' || !session.token) {
        delete db.memory.sessions[normalizedEmail];
        return res.status(401).json({
            error: 'Sessao expirada. Faca login novamente.',
            sessionRevoked: true
        });
    }

    const clientIp = normalizeIp(req.ip || req.socket.remoteAddress);
    const sessionIp = normalizeIp(session.ip);
    
    // Sessão única: se a sessão tem um token (login recente), exige que a requisição
    // apresente o mesmo token. Um novo login gera token novo e invalida o dispositivo antigo.
    const sessionObj = db.memory.sessions[normalizedEmail];
    if (sessionObj && typeof sessionObj === 'object' && sessionObj.token) {
        if (!providedToken || providedToken !== sessionObj.token) {
            return res.status(401).json({
                error: 'Sessão encerrada porque a conta foi acessada em outro dispositivo. Faça login novamente.',
                sessionRevoked: true
            });
        }
    }

    // O token (UUID por login) já prova a identidade. Um IP diferente é registrado,
    // mas não derruba a sessão: celular que troca de Wi-Fi para 4G ou recebe outro
    // IP do roteador perdia a prova no meio.
    if (sessionIp && sessionIp !== clientIp) {
        console.warn(`[SESSÃO] IP mudou para ${normalizedEmail}: ${sessionIp} -> ${clientIp}`);
        session.ip = clientIp;
    }

    const nowTs = Date.now();
    const liveSession = db.memory.sessions[normalizedEmail];
    if (liveSession && typeof liveSession === 'object') {
        if (!liveSession.createdAt) liveSession.createdAt = nowTs;
        // Cap ABSOLUTO no servidor (backstop). A ociosidade e enforced no cliente.
        if (nowTs - liveSession.createdAt > absoluteTtlMs()) {
            delete db.memory.sessions[normalizedEmail];
            return res.status(401).json({ error: 'Sessao expirada (limite maximo atingido). Faca login novamente.', sessionRevoked: true });
        }
        liveSession.lastSeen = nowTs;
    }

    const student = (db.memory.students || []).find(item => item && item.email && item.email.toLowerCase() === normalizedEmail);
    if (!student) {
        delete db.memory.sessions[normalizedEmail];
        return res.status(401).json({ error: 'Conta não encontrada. Faça login novamente.', sessionRevoked: true });
    }
    const status = String(student.status || '').trim().toLowerCase();
    if (!['ativo', 'active'].includes(status)) {
        delete db.memory.sessions[normalizedEmail];
        return res.status(403).json({ error: 'Esta conta está bloqueada ou inativa.', sessionRevoked: true });
    }

    req.auth = { role: 'student', email: normalizedEmail, student };
    req.studentEmail = normalizedEmail;
    req.studentAccount = student;

    next();
}

// Identifica quem faz a requisição por token: instrutor (x-admin-session) ou aluno
// (x-session-token). Usado nas rotas que servem conteúdo de prova a qualquer perfil
// autenticado; sem token válido a rota responde 401.
function resolveRequester(req) {
    const adminToken = String(req.get('x-admin-session') || '');
    if (adminToken && db.memory.adminSessions && db.memory.adminSessions[adminToken]) {
        return { role: 'admin', email: db.memory.adminSessions[adminToken].email };
    }
    const studentToken = String(req.get('x-session-token') || (req.query && req.query.sessionToken) || '');
    if (studentToken) {
        const match = Object.entries(db.memory.sessions || {})
            .find(([, value]) => value && typeof value === 'object' && value.token === studentToken);
        if (match) return { role: 'student', email: match[0] };
    }
    return null;
}

function validateAnySession(req, res, next) {
    const requester = resolveRequester(req);
    if (!requester) {
        return res.status(401).json({ error: 'Autenticação necessária.', sessionRevoked: true });
    }
    req.requester = requester;
    next();
}

// Remove dados sensíveis (token de acesso e gabarito embutido nos snapshots de versão)
// das configurações de prova online antes de enviá-las ao navegador do aluno.
function sanitizeOnlineExamConfigsForStudent(onlineExamConfigs) {
    const result = {};
    if (!onlineExamConfigs || typeof onlineExamConfigs !== 'object') return result;

    for (const examKey in onlineExamConfigs) {
        const cfg = onlineExamConfigs[examKey] || {};
        const { accessToken, accessTokenHash, ...safe } = cfg;
        safe.requiresToken = !!accessToken || !!accessTokenHash || cfg.tokenEnabled === true;

        if (Array.isArray(safe.versionSnapshots)) {
            safe.versionSnapshots = safe.versionSnapshots.map(snapshot => {
                const cleanSnapshot = { ...snapshot };
                delete cleanSnapshot.answerKey;
                if (Array.isArray(cleanSnapshot.questions)) {
                    cleanSnapshot.questions = cleanSnapshot.questions.map(question => {
                        const cleanQuestion = { ...question };
                        delete cleanQuestion.correctAnswer;
                        if (Array.isArray(cleanQuestion.alternatives)) {
                            cleanQuestion.alternatives = cleanQuestion.alternatives.map(alt => {
                                const cleanAlt = { ...alt };
                                delete cleanAlt.isCorrect;
                                return cleanAlt;
                            });
                        }
                        return cleanQuestion;
                    });
                }
                return cleanSnapshot;
            });
        }

        result[examKey] = safe;
    }

    return result;
}

function validateRequestedAdminContext(req, res, account) {
    if (!isProfessorAccount(account)) return true;
    const body = req.body || {};
    const query = req.query || {};
    let courseId = String(body.courseId || query.courseId || '').trim();
    let className = String(body.studentClass || query.studentClass || body.className || query.className || '').trim();
    const applicationId = String(body.applicationId || query.applicationId || '').trim();
    if (applicationId) {
        const application = (db.memory.examApplications || []).find(item => String(item.id) === applicationId);
        if (application) {
            courseId = courseId || String(application.courseId || '').trim();
            className = className || String(application.studentClass || '').trim();
        }
    }
    if (courseId && !adminCanAccessCourse(account, courseId)) {
        res.status(403).json({ error: 'Curso não autorizado para esta conta.' });
        return false;
    }
    if (className && !adminCanAccessClass(account, className, courseId)) {
        res.status(403).json({ error: 'Turma não autorizada para esta conta.' });
        return false;
    }
    return true;
}

function validateAdmin(req, res, callback) {
    // 1) Preferir sessao de instrutor via TOKEN (nao expoe a senha no cliente).
    const adminSessionToken = req.headers['x-admin-session'];
    if (adminSessionToken && db.memory.adminSessions && db.memory.adminSessions[adminSessionToken]) {
        const sess = db.memory.adminSessions[adminSessionToken];
        const now = Date.now();
        if (now - (sess.createdAt || now) > absoluteTtlMs()) {
            delete db.memory.adminSessions[adminSessionToken];
            return res.status(401).json({ error: 'Sessao expirada. Faca login novamente.', sessionRevoked: true });
        }
        const adminsList = readJSON(DB_ADMINS_FILE);
        const tokenAdmin = adminsList.find(a => a.email && a.email.toLowerCase() === sess.email);
        if (!tokenAdmin) {
            delete db.memory.adminSessions[adminSessionToken];
            return res.status(401).json({ error: 'Conta nao encontrada. Faca login novamente.', sessionRevoked: true });
        }
        sess.lastSeen = now;
        req.adminSessionToken = adminSessionToken;
        const cfg = readJSON(CONFIG_FILE);
        req.adminAccount = tokenAdmin;
        req.adminConfig = cfg;
        if (!validateRequestedAdminContext(req, res, tokenAdmin)) return;
        return callback(cfg, tokenAdmin);
    }

    // 2) Fallback legado: Authorization "email:senha".
    // Não aceita senha via query string (evita senha em logs/histórico do navegador).
    const authHeader = req.headers.authorization || (req.body && req.body.password);
    if (!authHeader) {
        return res.status(401).json({ error: 'Acesso não autorizado.' });
    }

    const { rateLimit } = require('./utils/rateLimit.js');
    const _rlAdmin = rateLimit(`admin-login:${req.ip}`, { max: 30, windowMs: 60000 });
    if (!_rlAdmin.allowed) {
        return res.status(429).json({ error: 'Muitas tentativas de acesso. Aguarde um instante e tente novamente.' });
    }

    let email, password;
    if (authHeader.includes(':')) {
        const parts = authHeader.split(':');
        email = parts[0].trim().toLowerCase();
        password = parts.slice(1).join(':').trim();
    } else {
        email = db.defaultAdminEmail();
        password = authHeader.trim();
    }
    
    const admins = readJSON(DB_ADMINS_FILE);
    const matchedAdmin = admins.find(a => a.email && a.email.toLowerCase() === email && db.verifyPassword(a.password, password));
    
    if (matchedAdmin) {
        if (db.needsPasswordRehash(matchedAdmin.password)) {
            matchedAdmin.password = db.hashPassword(password);
            db.save();
        }
        const config = readJSON(CONFIG_FILE);
        req.adminAccount = matchedAdmin;
        req.adminConfig = config;
        if (!validateRequestedAdminContext(req, res, matchedAdmin)) return;
        callback(config, matchedAdmin);
    } else {
        res.status(401).json({ error: 'Acesso não autorizado. E-mail ou senha incorretos.' });
    }
}

function issueAdminSession(email) {
    const crypto2 = require('crypto');
    const token = crypto2.randomUUID ? crypto2.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    const now = Date.now();
    db.memory.adminSessions = db.memory.adminSessions || {};
    db.memory.adminSessions[token] = { email: String(email || '').toLowerCase(), createdAt: now, lastSeen: now };
    return token;
}

function validateAdminPermission(req, res, permission, callback) {
    validateAdmin(req, res, (config, matchedAdmin) => {
        if (!canAccessAdminPermission(matchedAdmin, permission)) {
            return res.status(403).json({ error: 'Sua conta não possui permissão para esta operação.' });
        }
        callback(config, matchedAdmin);
    });
}

function adminAssignedClasses(account) {
    if (!isProfessorAccount(account) || !Array.isArray(account.assignedClasses)) return [];
    return account.assignedClasses
        .filter(value => value && typeof value === 'object')
        .map(value => ({ courseId: String(value.courseId || '').trim(), className: String(value.className || value.name || '').trim() }))
        .filter(value => value.courseId && value.className);
}

function normalizedAssignmentIds(account, field) {
    if (!isProfessorAccount(account) || !Array.isArray(account && account[field])) return [];
    return [...new Set(account[field].map(value => String(value || '').trim()).filter(Boolean))];
}

function adminAssignedCourseIds(account) {
    return normalizedAssignmentIds(account, 'assignedCourseIds');
}

function adminAssignedSchoolIds(account) {
    return normalizedAssignmentIds(account, 'assignedSchoolIds');
}

function adminAssignedClassNames(account) {
    return new Set(adminAssignedClasses(account).map(value => value.className));
}

function studentClassNames(student) {
    const values = student && Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student && student.studentClass ? [student.studentClass] : []);
    return values.map(item => typeof item === 'string' ? item : item && item.name).filter(Boolean);
}

function adminCanAccessClass(account, className, courseId) {
    if (!isProfessorAccount(account)) return true;
    const normalizedName = String(className || '').trim();
    let normalizedCourse = String(courseId || '').trim();
    if (!normalizedCourse) {
        const matches = (db.memory.classes || []).filter(cls => cls.name === normalizedName);
        if (matches.length !== 1) return false;
        normalizedCourse = String(matches[0].courseId || '').trim();
    }
    if (adminAssignedClasses(account).some(value => value.className === normalizedName && value.courseId === normalizedCourse)) return true;
    if (adminAssignedCourseIds(account).includes(normalizedCourse)) return true;
    const course = (db.memory.courses || []).find(item => String(item.id) === normalizedCourse);
    return !!(course && course.schoolId && adminAssignedSchoolIds(account).includes(String(course.schoolId)));
}

function adminAllowedCourseIds(account) {
    if (!isProfessorAccount(account)) return new Set((db.memory.courses || []).map(course => course.id));
    const schoolIds = new Set(adminAssignedSchoolIds(account));
    const ids = new Set([
        ...adminAssignedCourseIds(account),
        ...adminAssignedClasses(account).map(value => value.courseId),
    ]);
    (db.memory.courses || []).forEach(course => {
        if (course && course.schoolId && schoolIds.has(String(course.schoolId))) ids.add(String(course.id));
    });
    return ids;
}

function adminCanAccessCourse(account, courseId) {
    if (!isProfessorAccount(account)) return true;
    return adminAllowedCourseIds(account).has(String(courseId || '').trim());
}

function adminCanAccessStudent(account, student) {
    if (!isProfessorAccount(account)) return true;
    const entries = student && Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student && student.studentClass ? [student.studentClass] : []);
    return entries.some(entry => {
        if (entry && typeof entry === 'object') return adminCanAccessClass(account, entry.name || entry.className, entry.courseId);
        return adminCanAccessClass(account, entry, student.courseId || student.currentCourseId);
    });
}

function adminAllowedSchoolIds(account) {
    if (!isProfessorAccount(account)) return new Set((db.memory.schools || []).map(s => s.id));
    const courseIds = adminAllowedCourseIds(account);
    const ids = new Set(adminAssignedSchoolIds(account));
    (db.memory.courses || []).forEach(c => { if (courseIds.has(String(c.id)) && c.schoolId) ids.add(String(c.schoolId)); });
    return ids;
}

function adminCanAccessSchool(account, schoolId) {
    if (!isProfessorAccount(account)) return true;
    return adminAllowedSchoolIds(account).has(String(schoolId || '').trim());
}

function filterSchoolsForAdmin(schools, account) {
    return isProfessorAccount(account) ? (schools || []).filter(s => adminCanAccessSchool(account, s.id)) : (schools || []);
}

function courseContainsItem(course, itemKey) {
    const normalized = String(itemKey || '').replace(/^Gabarito_/, '');
    const contains = structure => (structure || []).some(mod => (mod.units || mod.items || []).some(unit =>
        unit.apostilaKey === normalized || unit.avaliacaoKey === normalized));
    if (contains(course && course.structure)) return true;
    return (db.memory.classes || []).some(cls => String(cls.courseId) === String(course?.id)
        && contains(effectiveStructure(course.id, cls.name)?.structure));
}

function adminCanAccessItem(account, itemKey) {
    if (!isProfessorAccount(account) || !itemKey) return true;
    const matchingCourses = (db.memory.courses || []).filter(course => courseContainsItem(course, itemKey));
    if (matchingCourses.length === 0) return true;
    return matchingCourses.some(course => adminCanAccessCourse(account, course.id));
}

function filterClassesForAdmin(classes, account) {
    return isProfessorAccount(account) ? (classes || []).filter(cls => adminCanAccessClass(account, cls.name, cls.courseId)) : (classes || []);
}

function filterStudentsForAdmin(students, account) {
    return isProfessorAccount(account) ? (students || []).filter(student => adminCanAccessStudent(account, student)) : (students || []);
}

function filterSubmissionsForAdmin(submissions, account) {
    if (!isProfessorAccount(account)) return submissions || [];
    return (submissions || []).filter(submission => {
        const className = submission && submission.student && submission.student.studentClass;
        const courseId = submission && submission.student && submission.student.courseId;
        if (className && adminCanAccessClass(account, className, courseId)) return true;
        const email = submission && submission.student && submission.student.email;
        const student = email && (db.memory.students || []).find(item => item.email && item.email.toLowerCase() === String(email).toLowerCase());
        return student ? adminCanAccessStudent(account, student) : false;
    });
}

function safeDecode(value) {
    try { return decodeURIComponent(value); } catch { return value; }
}

function findScopedStudentEmail(pathName, req) {
    const body = req.body || {};
    const query = req.query || {};
    if (body.studentEmail || body.targetEmail) return body.studentEmail || body.targetEmail;
    if (body.student && body.student.email) return body.student.email;
    if (/^\/student\/observations\/(update|delete)$/.test(pathName) && body.id) {
        const observation = (db.memory.pedagogicalObservations || []).find(item => item.id === body.id);
        return observation && observation.studentEmail;
    }
    if (pathName === '/student/certificates/revoke' && body.id) {
        const certificate = (db.memory.certificates || []).find(item => item.id === body.id);
        return certificate && certificate.studentEmail;
    }
    if (/^\/(student(?:\/.*)?|reset-password|delete-student|submissions(?:\/.*)?)$/.test(pathName)) {
        return body.originalEmail || body.email || query.email;
    }
    if (/^\/(monitor-review|exam-keystrokes)\//.test(pathName)) {
        return query.studentEmail || query.email;
    }
    return null;
}

function validateProfessorRequestScope(req, account) {
    if (!isProfessorAccount(account)) return null;
    const body = req.body || {};
    const query = req.query || {};
    const pathName = req.path || '/';

    const classNames = [body.studentClass, body.className, body.targetClass, query.studentClass, query.className]
        .filter(Boolean)
        .map(value => String(value).trim());
    if (body.student && body.student.studentClass) classNames.push(String(body.student.studentClass).trim());
    if (Array.isArray(body.classes)) {
        body.classes.forEach(item => classNames.push(String(typeof item === 'string' ? item : item && item.name || '').trim()));
    }
    if (/^\/class\/(toggle-registration|delete)$/.test(pathName) && body.name) {
        classNames.push(String(body.name).trim());
    }
    const pathClass = pathName.match(/^\/(?:monitor-status|monitor-review|export-grades|exam-analytics|proctoring-logs|exam-keystrokes)\/([^/]+)/);
    if (pathClass) classNames.push(safeDecode(pathClass[1]));
    const applicationPath = pathName.match(/^\/exam-applications\/([^/]+)/);
    if (applicationPath) {
        const application = (db.memory.examApplications || []).find(item => item.id === safeDecode(applicationPath[1]));
        if (application && !adminCanAccessClass(account, application.studentClass, application.courseId)) {
            return 'A aplicação solicitada não pertence às turmas atribuídas a esta conta.';
        }
    }
    const requestedCourseId = body.courseId || query.courseId || null;
    const forbiddenClass = classNames.filter(Boolean).find(className => !adminCanAccessClass(account, className, requestedCourseId));
    let keepsExistingStudentClasses = false;
    if (forbiddenClass && pathName === '/student/update' && body.originalEmail) {
        const normalizedEmail = String(body.originalEmail).trim().toLowerCase();
        const existingStudent = (db.memory.students || []).find(item => item.email && item.email.toLowerCase() === normalizedEmail);
        const requestedClasses = (Array.isArray(body.classes) ? body.classes : (body.studentClass ? [body.studentClass] : []))
            .map(item => String(typeof item === 'string' ? item : item && (item.name || item.className) || '').trim())
            .filter(Boolean)
            .sort();
        const currentClasses = existingStudent ? studentClassNames(existingStudent).map(value => String(value).trim()).filter(Boolean).sort() : [];
        keepsExistingStudentClasses = !!existingStudent
            && adminCanAccessStudent(account, existingStudent)
            && requestedClasses.length === currentClasses.length
            && requestedClasses.every((value, index) => value === currentClasses[index]);
    }
    if (forbiddenClass && !keepsExistingStudentClasses) return 'A turma solicitada não está atribuída a esta conta.';

    const courseIds = [body.courseId, query.courseId].filter(Boolean).map(value => String(value).trim());
    const pathCourse = pathName.match(/^\/courses\/([^/]+)\/structure$/);
    if (pathCourse) courseIds.push(safeDecode(pathCourse[1]));
    const forbiddenCourse = courseIds.filter(Boolean).find(courseId => !adminCanAccessCourse(account, courseId));
    if (forbiddenCourse) return 'O curso solicitado não pertence às turmas atribuídas a esta conta.';

    const itemKeys = [body.itemKey, body.examKey, body.sourceExamKey, query.examKey].filter(Boolean);
    if (pathName === '/question-bank/delete' && body.key) {
        const question = (db.memory.questionBank || []).find(item => item.key === body.key);
        if (question && question.sourceExamKey) itemKeys.push(question.sourceExamKey);
    }
    const itemPath = pathName.match(/^\/(?:material|evaluation)\/([^/]+)/);
    if (itemPath) itemKeys.push(safeDecode(itemPath[1]));
    const forbiddenItem = itemKeys.find(itemKey => !adminCanAccessItem(account, itemKey));
    if (forbiddenItem) return 'O conteúdo solicitado não pertence às turmas atribuídas a esta conta.';

    const scopedEmail = findScopedStudentEmail(pathName, req);
    if (scopedEmail) {
        const normalizedEmail = String(scopedEmail).trim().toLowerCase();
        const student = (db.memory.students || []).find(item => item.email && item.email.toLowerCase() === normalizedEmail);
        if (student && !adminCanAccessStudent(account, student)) {
            return 'O aluno solicitado não pertence às turmas atribuídas a esta conta.';
        }
    }

    if (pathName === '/schools/update' && body.id && !adminCanAccessSchool(account, body.id)) {
        return 'A escola solicitada não está no seu escopo.';
    }

    return null;
}

function adminRbacGuard(req, res, next) {
    validateAdmin(req, res, (config, matchedAdmin) => {
        const permission = resolveAdminApiPermission(req.method, req.path);
        if (matchedAdmin.mustChangePassword === true && !['/whoami', '/change-password'].includes(req.path)) {
            return res.status(403).json({ error: 'Troque a senha temporária antes de continuar.', passwordChangeRequired: true });
        }
        if (permission === undefined && isProfessorAccount(matchedAdmin)) {
            return res.status(403).json({ error: 'Esta operação administrativa não está liberada para professores.' });
        }
        if (!canAccessAdminPermission(matchedAdmin, permission)) {
            return res.status(403).json({ error: 'Sua conta não possui permissão para esta operação.' });
        }
        const scopeError = validateProfessorRequestScope(req, matchedAdmin);
        if (scopeError) return res.status(403).json({ error: scopeError });
        next();
    });
}

// Função para ler dados JSON de forma segura via Memory DB
function readJSON(file) {
    if (file.includes('db_students.json')) return db.memory.students;
    if (file.includes('db_classes.json')) return db.memory.classes;
    if (file.includes('db_submissions.json')) return db.memory.submissions;
    if (file.includes('config.json')) return db.memory.config;
    if (file.includes('db_admins.json')) return db.memory.admins;
    return [];
}

// Função para escrever dados JSON via Memory DB
function writeJSON(file, data) {
    if (file.includes('db_students.json')) db.memory.students = data;
    else if (file.includes('db_classes.json')) db.memory.classes = data;
    else if (file.includes('db_submissions.json')) db.memory.submissions = data;
    else if (file.includes('config.json')) db.memory.config = data;
    else if (file.includes('db_admins.json')) db.memory.admins = data;
    db.save();
}

function getAnswerKeyReleaseKey(examKey) {
    return `Gabarito_${examKey}`;
}

function normalizeIdentifier(value) {
    return String(value || '').trim();
}

function findClassByNameAndCourse(classes, studentClass, courseId) {
    const className = normalizeIdentifier(studentClass);
    const normalizedCourseId = normalizeIdentifier(courseId);
    if (!className) return null;

    if (normalizedCourseId) {
        const scopedClass = classes.find(c => c.name === className && c.courseId === normalizedCourseId);
        if (scopedClass) return scopedClass;
        return null;
    }

    return classes.find(c => c.name === className) || null;
}

function getCourseForClass(cls) {
    if (!cls || !cls.courseId || !db.memory.courses) return null;
    return db.memory.courses.find(c => c.id === cls.courseId) || null;
}

function getCourseItemKeys(cls) {
    const keys = new Set();
    const course = getCourseForClass(cls);
    const structure = effectiveStructure(course?.id, cls?.name)?.structure || (course && course.structure ? course.structure : (db.memory.courseStructure || []));

    structure.forEach(mod => {
        (mod.units || []).forEach(unit => {
            if (unit.apostilaKey) keys.add(unit.apostilaKey);
            if (unit.avaliacaoKey) {
                keys.add(unit.avaliacaoKey);
                keys.add(getAnswerKeyReleaseKey(unit.avaliacaoKey));
            }
        });
    });

    return keys;
}

function isCourseItemKey(cls, itemKey) {
    if (!itemKey) return false;
    return getCourseItemKeys(cls).has(itemKey);
}

function isCourseExamKey(cls, examKey) {
    if (!examKey) return false;
    const course = getCourseForClass(cls);
    const structure = effectiveStructure(course?.id, cls?.name)?.structure || (course && course.structure ? course.structure : (db.memory.courseStructure || []));
    return structure.some(mod => (mod.units || []).some(unit => unit.avaliacaoKey === examKey));
}

// Sanitização de Questão para Aluno
function sanitizeQuestionForStudent(question) {
    const { correctAnswer, ...safeQuestion } = question || {};
    safeQuestion.alternatives = Array.isArray(question && question.alternatives)
        ? question.alternatives.map(alt => {
            const { isCorrect, ...safeAlt } = alt || {};
            return safeAlt;
        })
        : [];
    return safeQuestion;
}

// Sanitização de Avaliação para Aluno
function sanitizeEvaluationForStudent(evaluation) {
    if (!evaluation || typeof evaluation !== 'object') {
        return evaluation;
    }

    return {
        ...evaluation,
        questions: Array.isArray(evaluation.questions)
            ? evaluation.questions.map(sanitizeQuestionForStudent)
            : []
    };
}

// Sanitização de Submissão para Aluno
function sanitizeSubmissionForStudent(submission, canViewAnswerKey) {
    const gradePublished = submission && submission.gradePublished === true;
    const { examSnapshot, ...submissionWithoutSnapshot } = submission || {};
    const safeGrade = { ...submissionWithoutSnapshot, gradePublished };
    if (!gradePublished) {
        delete safeGrade.score;
        delete safeGrade.correctCount;
        delete safeGrade.totalCount;
        delete safeGrade.consolidatedScore;
        safeGrade.countsTowardResult = false;
    }
    if (canViewAnswerKey) {
        // Gabarito liberado: expõe o conteúdo das questões (enunciado + alternativas)
        // a partir do examSnapshot para permitir a visualização completa da prova.
        // O snapshot em si não é devolvido; apenas os campos necessários e seguros.
        const snapshotQuestions = Array.isArray(examSnapshot?.questions) ? examSnapshot.questions : [];
        if (snapshotQuestions.length) {
            safeGrade.examQuestions = snapshotQuestions.map(question => ({
                number: Number(question?.originalNumber ?? question?.number),
                text: typeof question?.text === 'string' ? question.text : '',
                alternatives: Array.isArray(question?.alternatives)
                    ? question.alternatives.map(alt => ({
                        letter: String(alt?.letter || '').toUpperCase(),
                        text: typeof alt?.text === 'string' ? alt.text : ''
                    }))
                    : []
            }));
        }
        return safeGrade;
    }

    return {
        ...safeGrade,
        gradedAnswers: Array.isArray(submission.gradedAnswers)
            ? submission.gradedAnswers.map(ans => ({
                questionNumber: ans.questionNumber,
                studentChoice: ans.studentChoice || null
            }))
            : []
    };
}

// Verifica se o aluno pode visualizar o gabarito
function canStudentViewAnswerKey(submission, studentEmail) {
    if (!submission || !submission.examKey) return false;

    const normalizedEmail = (studentEmail || (submission.student && submission.student.email) || '').trim().toLowerCase();
    const submittedClass = submission.student && submission.student.studentClass;
    const submittedCourseId = submission.student && submission.student.courseId;
    const classes = readJSON(DB_CLASSES_FILE);
    const cls = findClassByNameAndCourse(classes, submittedClass, submittedCourseId);

    if (!cls) return false;

    const releasedItems = getReleasedItemsForClass(cls, normalizedEmail);
    return releasedItems[getAnswerKeyReleaseKey(submission.examKey)] === true;
}

function getReleasedItemsForClass(cls, studentEmail) {
    const released = { ...(cls.releasedItems || {}) };
    const courseStructure = effectiveStructure(cls?.courseId, cls?.name)?.structure || db.memory.courseStructure || [];
    courseStructure.forEach(mod => {
        (mod.units || mod.items || []).forEach(u => {
            if (u.apostilaKey && released[u.apostilaKey] === undefined) {
                released[u.apostilaKey] = true;
            }
            if (u.avaliacaoKey && released[u.avaliacaoKey] === undefined) {
                released[u.avaliacaoKey] = false;
            }
            if (u.avaliacaoKey && released[getAnswerKeyReleaseKey(u.avaliacaoKey)] === undefined) {
                released[getAnswerKeyReleaseKey(u.avaliacaoKey)] = false;
            }
        });
    });

    const normalizedEmail = (studentEmail || '').trim().toLowerCase();
    if (normalizedEmail && cls.studentReleasedItems && cls.studentReleasedItems[normalizedEmail]) {
        Object.assign(released, cls.studentReleasedItems[normalizedEmail]);
    }

    return released;
}

// Middleware centralizado de tratamento de erros
function errorHandler(err, req, res, next) {
    console.error('🔴 [SERVER ERROR]:', err);
    const status = err.status || 500;
    res.status(status).json({
        success: false,
        error: err.message || 'Ocorreu um erro interno no servidor.'
    });
}

// Sorteia uma versão de prova aleatória para o aluno na PRIMEIRA vez. É display-only:
// a correção é feita por originalNumber, então a versão NÃO afeta a nota. Marca
// versionAssigned para manter a versão estável (não troca a cada poll nem no reload).
function assignRandomExamVersion(state, onlineConfig) {
    if (!state || state.versionAssigned) return false;
    const snaps = Array.isArray(onlineConfig && onlineConfig.versionSnapshots) ? onlineConfig.versionSnapshots : [];
    if (snaps.length > 1) {
        const pick = snaps[Math.floor(Math.random() * snaps.length)];
        if (pick && pick.version) state.assignedVersion = String(pick.version).toUpperCase();
    }
    state.versionAssigned = true;
    return true;
}

// Tempo adicional de acessibilidade (cadastro do aluno: 25/50/100% da duração).
// Calculado sobre a duração base da prova, arredondado para cima em minutos.
function accessibilityExtraMinutes(studentEmail, durationMinutes) {
    const email = String(studentEmail || '').trim().toLowerCase();
    const duration = Number(durationMinutes || 0);
    if (!email || duration <= 0) return 0;
    const student = (db.memory.students || []).find(item => item && String(item.email || '').toLowerCase() === email);
    const access = student && student.accessibility;
    if (!access || access.tempoAdicional !== true) return 0;
    const percent = Number(access.tempoAdicionalPercent);
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    return Math.ceil(duration * Math.min(percent, 200) / 100);
}

function initializeExamState(state, onlineConfig) {
    if (!state || !onlineConfig) return false;
    let changed = false;
    const configVersion = onlineConfig.updatedAt || onlineConfig.preparedAt || onlineConfig.activeHistoryId || null;
    if (configVersion && state.examConfigVersion !== configVersion) {
        state.answers = {};
        state.timerRemaining = null;
        state.startedAt = null;
        state.deadlineAt = null;
        state.assignedVersion = 'A';
        state.versionAssigned = false;
        state.assignedQuestionNumbers = null;
        state.individualTimeAdjustment = 0;
        state.tokenValidated = false;
        state.focusLocked = false;
        state.focusLockedAt = null;
        state.focusLockReason = null;
        state.focusLockEventId = null;
        state.focusUnlockedAt = null;
        state.examConfigVersion = configVersion;
        if (state.applicationId) state.status = 'instructions';
        changed = true;
    }
    changed = assignRandomExamVersion(state, onlineConfig) || changed;
    const snapshots = Array.isArray(onlineConfig.versionSnapshots) ? onlineConfig.versionSnapshots : [];
    const assigned = String(state.assignedVersion || 'A').toUpperCase();
    const snapshot = snapshots.find(item => String(item && item.version || 'A').toUpperCase() === assigned)
        || snapshots[0];

    if (!Array.isArray(state.assignedQuestionNumbers) && snapshot && Array.isArray(snapshot.questions)) {
        state.assignedQuestionNumbers = snapshot.questions
            .map((question, index) => Number(question.originalNumber || question.number || index + 1))
            .filter(Number.isFinite);
        changed = true;
    }

    // Aplicações identificadas só iniciam depois que o aluno confirma a tela de
    // instruções em start-attempt. Estados legados mantêm o comportamento anterior.
    if (state.applicationId && !state.startedAt) return changed;

    const configuredStart = Number(onlineConfig.startTime);
    if (onlineConfig.onlineActive === true && configuredStart > 0 && Date.now() >= configuredStart) {
        if (!state.startedAt) {
            state.startedAt = configuredStart;
            changed = true;
        }
        // "Cronômetro ativo" desligado: a prova não tem prazo, mesmo com duração configurada.
        if (onlineConfig.timerEnabled === false) {
            if (state.deadlineAt !== null || state.timerRemaining !== null) {
                state.deadlineAt = null;
                state.timerRemaining = null;
                changed = true;
            }
            return changed;
        }
        const duration = Number(onlineConfig.durationMinutes || 0);
        if (duration > 0) {
            const extra = accessibilityExtraMinutes(state.studentEmail, duration);
            if (state.accessibilityExtraMinutes !== extra) {
                state.accessibilityExtraMinutes = extra;
                changed = true;
            }
            // Mesma conta do servidor inteiro (inclui as pausas da aplicação). O fim do
            // tempo NÃO muda o status aqui: quem finaliza a tentativa vencida é
            // utils/examDeadline.js, sem nunca recriá-la.
            const application = state.applicationId
                ? (db.memory.examApplications || []).find(item => item && item.id === state.applicationId) || null
                : null;
            const now = Date.now();
            const deadlineAt = computeAttemptDeadline({ application, onlineConfig, state, now });
            if (state.deadlineAt !== deadlineAt) {
                state.deadlineAt = deadlineAt;
                changed = true;
            }
            state.timerRemaining = deadlineAt == null ? null : Math.max(0, Math.ceil((deadlineAt - now) / 1000));
        }
    }
    return changed;
}

module.exports = {
    DB_STUDENTS_FILE,
    DB_SUBMISSIONS_FILE,
    CONFIG_FILE,
    DB_CLASSES_FILE,
    DB_ADMINS_FILE,
    localIpAddresses,
    normalizeIp,
    validateStudentSession,
    resolveRequester,
    validateAnySession,
    validateAdmin,
    issueAdminSession,
    SERVER_INSTANCE_ID,
    validateAdminPermission,
    adminRbacGuard,
    isProfessorAccount,
    adminAssignedCourseIds,
    adminAssignedSchoolIds,
    adminAssignedClassNames,
    adminAllowedCourseIds,
    adminCanAccessClass,
    adminCanAccessCourse,
    adminCanAccessStudent,
    adminCanAccessItem,
    filterClassesForAdmin,
    filterStudentsForAdmin,
    filterSubmissionsForAdmin,
    adminAllowedSchoolIds,
    adminCanAccessSchool,
    filterSchoolsForAdmin,
    readJSON,
    writeJSON,
    sanitizeQuestionForStudent,
    sanitizeEvaluationForStudent,
    sanitizeSubmissionForStudent,
    sanitizeOnlineExamConfigsForStudent,
    canStudentViewAnswerKey,
    getReleasedItemsForClass,
    normalizeIdentifier,
    findClassByNameAndCourse,
    assignRandomExamVersion,
    accessibilityExtraMinutes,
    initializeExamState,
    getCourseForClass,
    getCourseItemKeys,
    isCourseItemKey,
    isCourseExamKey,
    errorHandler
};
