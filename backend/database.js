const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const { parseEvaluationMarkdown } = require('./utils/parser.js');
const { normalizeAdditionalPermissions } = require('./utils/adminPermissions.js');
const { normalizeStoredStudentClasses } = require('./utils/students.js');
const {
    ACTIVE_APPLICATION_STATUSES,
    applicationToOnlineConfig,
    createExamApplication,
    findExamApplication,
    normalizeLegacyApplicationPause,
} = require('./utils/examApplications.js');
const { hashExamToken } = require('./utils/examToken.js');
const { DATA_DIR, CONTENT_DIR } = require('./runtimePaths.js');

function legacyHashPassword(password) {
    const salt = 'senai_salt_4.0_!@#';
    return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function hashPassword(password) {
    if (!password) return '';
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(String(password), salt, 64);
    return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(stored, password) {
    if (!stored || password == null) return false;
    const value = String(stored);
    if (value.startsWith('scrypt$')) {
        const parts = value.split('$');
        if (parts.length !== 3) return false;
        try {
            const salt = Buffer.from(parts[1], 'base64');
            const expected = Buffer.from(parts[2], 'base64');
            const actual = crypto.scryptSync(String(password), salt, expected.length);
            return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
        } catch (e) { return false; }
    }
    if (/^[0-9a-f]{64}$/i.test(value)) return value === legacyHashPassword(String(password));
    return value === String(password);
}

function isHashed(password) {
    return typeof password === 'string' && (password.startsWith('scrypt$') || /^[0-9a-f]{64}$/i.test(password));
}

function needsPasswordRehash(password) { return typeof password === 'string' && !password.startsWith('scrypt$'); }

// Turmas atribuídas sem repetição e numa ordem fixa (curso, depois turma). A ordem
// não depende mais da ordem em que as turmas foram lidas do banco: depois de restaurar
// um backup (turmas regravadas em outra ordem) cada boot reordenava a lista e regravava
// as contas, e o boot deixava de ser idempotente.
function compareCodeUnits(a, b) {
    return a < b ? -1 : (a > b ? 1 : 0);
}

function uniqueSortedAssignments(assignments) {
    return [...new Map(assignments.map(item => [`${item.courseId}::${item.className}`, item])).values()]
        .sort((a, b) => compareCodeUnits(a.courseId, b.courseId) || compareCodeUnits(a.className, b.className));
}

function allClassAssignments() {
    const assignments = (memoryDB.classes || [])
        .filter(cls => cls && cls.courseId && cls.name)
        .map(cls => ({ courseId: String(cls.courseId), className: String(cls.name) }));
    return uniqueSortedAssignments(assignments);
}

function syncAdminClassAssignments() {
    const allAssignments = allClassAssignments();
    let changed = false;
    (memoryDB.admins || []).forEach(admin => {
        if (!admin || admin.role === 'professor') return;
        if (!Array.isArray(admin.assignedClasses) || JSON.stringify(admin.assignedClasses) !== JSON.stringify(allAssignments)) {
            admin.assignedClasses = allAssignments.map(item => ({ ...item }));
            changed = true;
        }
        if (Array.isArray(admin.unresolvedAssignedClasses) && admin.unresolvedAssignedClasses.length) {
            admin.unresolvedAssignedClasses = [];
            changed = true;
        }
    });
    return changed;
}

function syncProfessorAssignmentReferences() {
    const schoolIds = new Set((memoryDB.schools || []).map(school => String(school && school.id || '')).filter(Boolean));
    const activeCourses = (memoryDB.courses || []).filter(course => course && !course.deleted && course.status !== 'deleted' && course.status !== 'inactive');
    const courseIds = new Set(activeCourses.map(course => String(course.id)));
    const deletedCourseIds = new Set((memoryDB.courses || [])
        .filter(course => course && (course.deleted || course.status === 'deleted' || course.status === 'inactive'))
        .map(course => String(course.id)));
    const classKeys = new Set((memoryDB.classes || [])
        .filter(cls => cls && !deletedCourseIds.has(String(cls.courseId)))
        .map(cls => `${cls.courseId}::${cls.name}`));
    let changed = false;

    (memoryDB.admins || []).forEach(account => {
        if (!account || account.role !== 'professor') return;
        const nextSchools = [...new Set((account.assignedSchoolIds || []).map(value => String(value || '').trim()).filter(id => id && schoolIds.has(id)))];
        const nextCourses = [...new Set((account.assignedCourseIds || []).map(value => String(value || '').trim()).filter(id => id && courseIds.has(id)))];
        const nextClasses = uniqueSortedAssignments((account.assignedClasses || [])
            .filter(value => value && typeof value === 'object')
            .map(value => ({ courseId: String(value.courseId || '').trim(), className: String(value.className || value.name || '').trim() }))
            .filter(value => classKeys.has(`${value.courseId}::${value.className}`)));

        if (JSON.stringify(account.assignedSchoolIds || []) !== JSON.stringify(nextSchools)) { account.assignedSchoolIds = nextSchools; changed = true; }
        if (JSON.stringify(account.assignedCourseIds || []) !== JSON.stringify(nextCourses)) { account.assignedCourseIds = nextCourses; changed = true; }
        if (JSON.stringify(account.assignedClasses || []) !== JSON.stringify(nextClasses)) { account.assignedClasses = nextClasses; changed = true; }
    });
    return changed;
}

// Caminhos dos arquivos de banco de dados locais legados
const DB_STUDENTS_FILE = path.join(DATA_DIR, 'db_students.json');
const DB_CLASSES_FILE = path.join(DATA_DIR, 'db_classes.json');
const DB_SUBMISSIONS_FILE = path.join(DATA_DIR, 'db_submissions.json');
const DB_NOTES_FILE = path.join(DATA_DIR, 'db_notes.json');
const DB_ANNOTATIONS_FILE = path.join(DATA_DIR, 'db_annotations.json');
const DB_FORUM_FILE = path.join(DATA_DIR, 'db_forum.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DB_COURSE_STRUCTURE_FILE = path.join(DATA_DIR, 'db_course_structure.json');
const DB_EVALUATIONS_FILE = path.join(DATA_DIR, 'db_evaluations.json');
const DB_PROGRESS_FILE = path.join(DATA_DIR, 'db_progress.json');
const DB_UPLOADS_FILE = path.join(DATA_DIR, 'db_uploads.json');
const DB_ADMINS_FILE = path.join(DATA_DIR, 'db_admins.json');

// Conexão com SQLite
fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'database.db');
const sqliteDb = new sqlite3.Database(dbPath);

let memoryDB = {
    students: [],
    classes: [],
    courses: [], // Novo: multi-cursos
    branding: {}, // Novo: white-label
    submissions: [],
    examApplications: [],
    notes: {},
    annotations: {},
    forum: [],
    config: { releasedItems: {} },
    courseStructure: [], // Em breve obsoleto, migrado para courses
    evaluations: {},
    progress: {},
    uploads: {},
    admins: [],
    sessions: {}, // Alunos online { "email": last_ping_timestamp }
    proctoringLogs: [],
    examKeystrokes: [], // Modo Prova Rigoroso: histórico de digitação por tentativa (telemetria de prova)
    studentExamState: {}, // chave: studentEmail + '_' + examKey
    broadcastMessages: [],
    questionBank: [],
    auditLogs: [], // Fase 1: auditoria de alterações no perfil do aluno
    loginLogs: [], // Fase 2: logs de login (segurança/LGPD)
    pedagogicalObservations: [], // Fase 3: observações pedagógicas controladas
    attendance: [], // Fase 4: registros de presença
    certificates: [], // Fase 4: certificados emitidos
    moduleAccess: [], // Fase 4: histórico de módulos acessados
    schools: [], // Fase I.1: escolas/instituições (white-label)
    announcements: [], // Avisos/Comunicados (professor -> turma/curso/aluno)
    library: [] // Biblioteca de materiais reutilizaveis
};

let isSaving = false;
let hasPendingSave = false;
let saveWaiters = [];
// Último conteúdo gravado por tabela ({ tabela: Map(chave -> json) }); null força reescrita completa.
let lastWrittenRows = null;

function classStorageKey(cls) {
    if (!cls || !cls.name) return '';
    return `${String(cls.courseId || '').trim()}::${String(cls.name).trim()}`;
}

// Criação de Tabelas se não existirem
function createTables() {
    return new Promise((resolve, reject) => {
        sqliteDb.serialize(() => {
            sqliteDb.run("CREATE TABLE IF NOT EXISTS students (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS classes (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS courses (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS branding (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS submissions (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS exam_applications (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS annotations (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS forum (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS course_structure (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS evaluations (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS progress (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS uploads (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS proctoring_logs (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS exam_keystrokes (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS student_exam_state (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS broadcast_messages (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS question_bank (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS audit_logs (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS login_logs (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS pedagogical_observations (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS attendance (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS certificates (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS module_access (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS schools (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS announcements (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS library (key TEXT PRIMARY KEY, value TEXT)");
            sqliteDb.run("CREATE TABLE IF NOT EXISTS admins (key TEXT PRIMARY KEY, value TEXT)", (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });
}

// Helper para migrar arquivo JSON legado para tabela SQLite
function migrateJsonToTable(filePath, tableName, keyField, isArray = true) {
    return new Promise((resolve) => {
        if (!fs.existsSync(filePath)) {
            return resolve();
        }
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(raw);
            
            sqliteDb.serialize(() => {
                sqliteDb.run("BEGIN TRANSACTION");
                
                if (isArray) {
                    const stmt = sqliteDb.prepare(`INSERT OR REPLACE INTO ${tableName} (key, value) VALUES (?, ?)`);
                    if (Array.isArray(data)) {
                        data.forEach(item => {
                            const keyVal = item[keyField];
                            if (keyVal) stmt.run(keyVal.toLowerCase ? keyVal.toLowerCase() : keyVal, JSON.stringify(item));
                        });
                    }
                    stmt.finalize();
                } else {
                    const stmt = sqliteDb.prepare(`INSERT OR REPLACE INTO ${tableName} (key, value) VALUES (?, ?)`);
                    for (const key in data) {
                        stmt.run(key.toLowerCase ? key.toLowerCase() : key, JSON.stringify(data[key]));
                    }
                    stmt.finalize();
                }
                
                sqliteDb.run("COMMIT", (err) => {
                    if (err) {
                        console.error(`Erro ao comitar migração de ${tableName}:`, err);
                    } else {
                        console.log(`Migrado ${path.basename(filePath)} para SQLite com sucesso.`);
                        try { fs.renameSync(filePath, filePath + '.migrated'); } catch(e){}
                    }
                    resolve();
                });
            });
        } catch (e) {
            console.error(`Erro ao migrar arquivo ${filePath}:`, e);
            resolve();
        }
    });
}

// Carregar dados de tabela SQLite para memória
function loadTable(tableName, isArray = true) {
    return new Promise((resolve, reject) => {
        sqliteDb.all(`SELECT key, value FROM ${tableName}`, (err, rows) => {
            if (err) return reject(err);
            
            if (isArray) {
                const arr = [];
                rows.forEach(r => {
                    try { arr.push(JSON.parse(r.value)); } catch(e){}
                });
                resolve(arr);
            } else {
                const obj = {};
                rows.forEach(r => {
                    try { obj[r.key] = JSON.parse(r.value); } catch(e){}
                });
                resolve(obj);
            }
        });
    });
}

function bootstrapAdminPassword() {
    if (process.env.TEST_MODE === '1') return 'admin';
    const configured = String(process.env.ICLASS_BOOTSTRAP_ADMIN_PASSWORD || '').trim();
    if (configured) return configured;
    const file = path.join(DATA_DIR, 'bootstrap-admin.txt');
    if (fs.existsSync(file)) {
        const match = fs.readFileSync(file, 'utf8').match(/^Senha temporária:\s*(.+)$/m);
        if (match) return match[1].trim();
    }
    const generated = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(file, `Usuário: admin@local\nSenha temporária: ${generated}\nTroque a senha no primeiro acesso.\n`, { mode: 0o600 });
    console.warn(`Credencial inicial criada em ${file}. Troque a senha no primeiro acesso.`);
    return generated;
}

// Inicializa Defaults se o banco de dados estiver vazio
function populateDefaultsIfEmpty() {
    if (memoryDB.admins.length === 0) {
        const initialPassword = bootstrapAdminPassword();
        memoryDB.admins = [{
            name: 'Administrador Geral',
            email: 'admin@local',
            password: initialPassword,
            role: 'admin',
            mustChangePassword: true
        }];
    }

    const existingAlan = memoryDB.students.find(s => s.email && s.email.toLowerCase() === 'alan@alan.com');
    if (process.env.TEST_MODE === '1' && !existingAlan) {
        memoryDB.students.push({
            name: 'Alan Marciano',
            email: 'alan@alan.com',
            password: '123',
            classes: [{ name: '1DES', courseId: 'curso_legacy_01', period: 'Manhã' }],
            studentClass: '1DES',
            period: 'Manhã',
            loginTime: null,
            recoveryRequested: false
        });
    } else if (process.env.TEST_MODE === '1' && existingAlan && existingAlan.password === 'alan') {
        existingAlan.password = '123';
        saveToDisk();
    }
    
    if (memoryDB.classes.length === 0) {
        const defaultReleasedItems = {};
        const modules = ['FUTEC', 'FECOP', 'IRCOM'];
        modules.forEach(m => {
            for (let i = 1; i <= 5; i++) {
                defaultReleasedItems[`Apostila_${m}_${i}`] = true;
                defaultReleasedItems[`Avaliacao_${m}_${i}`] = false;
            }
        });
        memoryDB.classes = [
            { 
                name: '1DES', 
                period: 'Manhã',
                courseId: 'curso_legacy_01',
                registrationEnabled: true,
                activeExamKey: null,
                activeExamQuestionCount: 20,
                releasedItems: { ...defaultReleasedItems }
            },
            { 
                name: '2DES', 
                period: 'Tarde',
                courseId: 'curso_legacy_01',
                registrationEnabled: true,
                activeExamKey: null,
                activeExamQuestionCount: 20,
                releasedItems: { ...defaultReleasedItems }
            }
        ];
    }

    if (Object.keys(memoryDB.branding).length === 0) {
        memoryDB.branding = {
            id: 'default',
            institutionName: 'IClass',
            primaryColor: '#ef4444',
            logoUrl: ''
        };
    }

    // Fase I.1: garante uma escola padrão e vincula cursos sem schoolId a ela.
    if (!Array.isArray(memoryDB.schools) || memoryDB.schools.length === 0) {
        memoryDB.schools = [{
            id: 'escola_default',
            name: (memoryDB.branding && memoryDB.branding.institutionName) || 'Minha Instituição',
            info: {},
            branding: {},
            createdAt: Date.now()
        }];
    }
    const defaultSchoolId = (memoryDB.schools[0] && memoryDB.schools[0].id) || 'escola_default';
    (memoryDB.courses || []).forEach(c => { if (c && !c.schoolId) c.schoolId = defaultSchoolId; });

    if (memoryDB.courses.length === 0) {
        // Migration will populate structure if it comes from legacy courseStructure
        memoryDB.courses = [
            {
                id: 'curso_legacy_01',
                name: 'Curso Técnico em TI (Legado)',
                description: 'Curso original contendo os módulos FUTEC, FECOP e IRCOM.',
                structure: memoryDB.courseStructure && memoryDB.courseStructure.length > 0 ? [...memoryDB.courseStructure] : [
                    {
                        id: 'FUTEC',
                        name: 'FUTEC — Fund. de TI (80h)',
                        units: [
                            { id: "1", name: "Sistemas Operacionais + Dispositivos", apostilaKey: "Apostila_FUTEC_1", avaliacaoKey: "Avaliacao_FUTEC_1", files: [] },
                            { id: "2", name: "Indústria 4.0 + Internet", apostilaKey: "Apostila_FUTEC_2", avaliacaoKey: "Avaliacao_FUTEC_2", files: [] },
                            { id: "3", name: "Hardware + BIOS/UEFI + Periféricos", apostilaKey: "Apostila_FUTEC_3", avaliacaoKey: "Avaliacao_FUTEC_3", files: [] },
                            { id: "4", name: "Instalação de Windows Server + KMS", apostilaKey: "Apostila_FUTEC_4", avaliacaoKey: "Avaliacao_FUTEC_4", files: [] },
                            { id: "5", name: "CLI de Linux + Permissões + FHS", apostilaKey: "Apostila_FUTEC_5", avaliacaoKey: "Avaliacao_FUTEC_5", files: [] }
                        ]
                    },
                    {
                        id: 'FECOP',
                        name: 'FECOP — Colab. e Prod. (120h)',
                        units: [
                            { id: "1", name: "Produtividade + Office 365", apostilaKey: "Apostila_FECOP_1", avaliacaoKey: "Avaliacao_FECOP_1", files: [] },
                            { id: "2", name: "Active Directory + LDAP + Grupos/GPO", apostilaKey: "Apostila_FECOP_2", avaliacaoKey: "Avaliacao_FECOP_2", files: [] },
                            { id: "3", name: "Serviços em Nuvem + AWS/Azure", apostilaKey: "Apostila_FECOP_3", avaliacaoKey: "Avaliacao_FECOP_3", files: [] },
                            { id: "4", name: "Políticas Corporativas + Auditoria/Logs", apostilaKey: "Apostila_FECOP_4", avaliacaoKey: "Avaliacao_FECOP_4", files: [] },
                            { id: "5", name: "Trabalho Remoto + VPN + Segurança", apostilaKey: "Apostila_FECOP_5", avaliacaoKey: "Avaliacao_FECOP_5", files: [] }
                        ]
                    },
                    {
                        id: 'IRCOM',
                        name: 'IRCOM — Inst. Rec. Comp. (120h)',
                        units: [
                            { id: "1", name: "Planejamento de Instalação + Requisitos", apostilaKey: "Apostila_IRCOM_1", avaliacaoKey: "Avaliacao_IRCOM_1", files: [] },
                            { id: "2", name: "CLP (PLC) + Redes Industriais", apostilaKey: "Apostila_IRCOM_2", avaliacaoKey: "Avaliacao_IRCOM_2", files: [] },
                            { id: "3", name: "Protocolos Industriais + Modbus/OPC-UA", apostilaKey: "Apostila_IRCOM_3", avaliacaoKey: "Avaliacao_IRCOM_3", files: [] },
                            { id: "4", name: "Comissionamento de Sistemas + Testes", apostilaKey: "Apostila_IRCOM_4", avaliacaoKey: "Avaliacao_IRCOM_4", files: [] },
                            { id: "5", name: "Manutenção Preventiva e Corretiva", apostilaKey: "Apostila_IRCOM_5", avaliacaoKey: "Avaliacao_IRCOM_5", files: [] }
                        ]
                    }
                ]
            }
        ];
    }

    const fallbackCourseId = memoryDB.courses[0] && memoryDB.courses[0].id ? memoryDB.courses[0].id : 'curso_legacy_01';
    const fallbackReleasedItems = {};
    ['FUTEC', 'FECOP', 'IRCOM'].forEach(m => {
        for (let i = 1; i <= 5; i++) {
            fallbackReleasedItems[`Apostila_${m}_${i}`] = true;
            fallbackReleasedItems[`Avaliacao_${m}_${i}`] = false;
        }
    });

    memoryDB.classes.forEach(cls => {
        if (!cls.courseId) cls.courseId = fallbackCourseId;
        if (!cls.examConfigs) cls.examConfigs = {};
        if (!cls.onlineExamConfigs) cls.onlineExamConfigs = {};
        if (!cls.releasedItems) cls.releasedItems = { ...fallbackReleasedItems };
        if (typeof cls.registrationEnabled !== 'boolean') cls.registrationEnabled = true;
    });

    if (!memoryDB.config || !memoryDB.config.releasedItems) {
        const defaultReleasedItems = {};
        const modules = ['FUTEC', 'FECOP', 'IRCOM'];
        modules.forEach(m => {
            for (let i = 1; i <= 5; i++) {
                defaultReleasedItems[`Apostila_${m}_${i}`] = true;
                defaultReleasedItems[`Avaliacao_${m}_${i}`] = false;
            }
        });
        memoryDB.config = {
            adminPassword: bootstrapAdminPassword(),
            activeExamKey: null,
            releasedItems: defaultReleasedItems
        };
    }
}

// Inicialização Assíncrona do Banco
function migrateLegacyExamApplications() {
    if (!Array.isArray(memoryDB.examApplications)) memoryDB.examApplications = [];
    let changed = false;
    // Aplicações pausadas por versões antigas passam a registrar o início da pausa
    // (o cronômetro fica congelado a partir dele). Idempotente.
    memoryDB.examApplications.forEach(application => {
        if (normalizeLegacyApplicationPause(application)) changed = true;
    });
    (memoryDB.classes || []).forEach(cls => {
        if (!cls.onlineExamConfigs) return;
        Object.keys(cls.onlineExamConfigs).forEach(examKey => {
            const cfg = cls.onlineExamConfigs[examKey];
            if (!cfg) return;
            let application = findExamApplication(memoryDB.examApplications, cfg.applicationId);
            const hasPreparedContent = cfg.activeHistoryId
                && Array.isArray(cfg.versionSnapshots)
                && cfg.versionSnapshots.length > 0;
            if (!application && hasPreparedContent) {
                const legacyStatus = ['prepared', 'waiting', 'running', 'paused', 'finished'].includes(cfg.status)
                    ? cfg.status
                    : (cfg.onlineActive ? 'running' : 'prepared');
                application = createExamApplication({
                    examKey,
                    courseId: cls.courseId,
                    studentClass: cls.name,
                    historyId: cfg.activeHistoryId,
                    config: {
                        ...cfg,
                        accessTokenHash: hashExamToken(cfg.accessToken),
                        tokenEnabled: !!cfg.accessToken,
                    },
                    actor: 'migração automática',
                    status: legacyStatus,
                    now: cfg.startTime || Date.now(),
                });
                if (cfg.startTime) application.startsAt = Number(cfg.startTime);
                // A configuração ainda aponta para a aplicação que sumiu (backup de versão
                // anterior, que não trazia as aplicações): ela volta com o mesmo
                // identificador, e as tentativas e entregas gravadas com ele continuam dela.
                const previousId = String(cfg.applicationId || '').trim();
                if (previousId) application.id = previousId;
                memoryDB.examApplications.push(application);
                changed = true;
            }
            if (!application) return;
            cls.onlineExamConfigs[examKey] = applicationToOnlineConfig(application, cfg);
            const active = ACTIVE_APPLICATION_STATUSES.has(application.status);
            if (!cls.releasedItems) cls.releasedItems = {};
            cls.releasedItems[examKey] = active;
            if (active) {
                cls.activeExamKey = examKey;
                cls.activeApplicationId = application.id;
            }
        });
    });
    return changed;
}

// Configuração da prova em cada turma conforme a aplicação dela; configuração sem
// aplicação (versões antigas) volta bloqueada e parada. Usada no boot e ao restaurar um
// backup de versão anterior. Devolve true quando mudou alguma coisa.
function syncOnlineExamConfigsWithApplications() {
    if (!Array.isArray(memoryDB.classes)) return false;
    let resetSomething = false;
    memoryDB.classes.forEach(cls => {
        if (cls.activeExamKey) { cls.activeExamKey = null; resetSomething = true; }
        if (cls.onlineExamConfigs) {
            Object.keys(cls.onlineExamConfigs).forEach(examKey => {
                const cfg = cls.onlineExamConfigs[examKey];
                if (!cfg) return;
                const application = findExamApplication(memoryDB.examApplications, cfg.applicationId);
                if (application) {
                    cls.onlineExamConfigs[examKey] = applicationToOnlineConfig(application, cfg);
                    if (ACTIVE_APPLICATION_STATUSES.has(application.status)) {
                        cls.activeExamKey = examKey;
                        cls.activeApplicationId = application.id;
                    }
                    return;
                }
                cfg.onlineActive = false;
                cfg.status = 'not_applied';
                cfg.startTime = null;
                cfg.waitingRoomStartTimestamp = null;
                resetSomething = true;
            });
        }
        if (cls.releasedItems) {
            Object.keys(cls.releasedItems).forEach(key => {
                if (key.startsWith('Avaliacao_') && cls.releasedItems[key] === true && !cls.onlineExamConfigs?.[key]?.applicationId) {
                    cls.releasedItems[key] = false;
                    resetSomething = true;
                }
            });
        }
    });
    return resetSomething;
}

// Restaurar um backup de versão anterior (sem a coleção examApplications) é voltar
// àquele momento: as aplicações atuais (inclusive as criadas depois do backup) saem e
// são refeitas a partir das turmas do backup pelo mesmo caminho do boot para dados
// antigos. Antes as atuais ficavam: aplicação "finalizada" com as tentativas "em
// andamento" que vieram do backup, e aplicações posteriores ao backup sobrando.
function rebuildExamApplicationsFromClasses() {
    const discarded = Array.isArray(memoryDB.examApplications) ? memoryDB.examApplications.length : 0;
    memoryDB.examApplications = [];
    migrateLegacyExamApplications();
    syncOnlineExamConfigsWithApplications();
    return { discarded, rebuilt: memoryDB.examApplications.length };
}

async function init() {
    await createTables();

    // 1. Executa migrações de arquivos JSON legados se houverem
    await migrateJsonToTable(DB_STUDENTS_FILE, 'students', 'email', true);
    await migrateJsonToTable(DB_CLASSES_FILE, 'classes', 'name', true);
    await migrateJsonToTable(DB_SUBMISSIONS_FILE, 'submissions', 'id', true);
    await migrateJsonToTable(DB_ADMINS_FILE, 'admins', 'email', true);
    await migrateJsonToTable(DB_FORUM_FILE, 'forum', 'id', true);
    
    await migrateJsonToTable(DB_NOTES_FILE, 'notes', '', false);
    await migrateJsonToTable(DB_ANNOTATIONS_FILE, 'annotations', '', false);
    await migrateJsonToTable(DB_EVALUATIONS_FILE, 'evaluations', '', false);
    await migrateJsonToTable(DB_PROGRESS_FILE, 'progress', '', false);
    await migrateJsonToTable(DB_UPLOADS_FILE, 'uploads', '', false);

    // Migração de config e course structure legados (singletons)
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
            sqliteDb.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", 'app_config', raw);
            fs.renameSync(CONFIG_FILE, CONFIG_FILE + '.migrated');
        } catch(e){}
    }
    if (fs.existsSync(DB_COURSE_STRUCTURE_FILE)) {
        try {
            const raw = fs.readFileSync(DB_COURSE_STRUCTURE_FILE, 'utf8');
            sqliteDb.run("INSERT OR REPLACE INTO course_structure (key, value) VALUES (?, ?)", 'structure', raw);
            fs.renameSync(DB_COURSE_STRUCTURE_FILE, DB_COURSE_STRUCTURE_FILE + '.migrated');
        } catch(e){}
    }

    memoryDB.students = await loadTable('students', true);
    
    // Migração de studentClass para classes array
    memoryDB.students.forEach(student => {
        if (!student.classes) {
            student.classes = [];
            if (student.studentClass) {
                student.classes.push(student.studentClass);
            }
        }
    });
    memoryDB.classes = await loadTable('classes', true);
    memoryDB.courses = await loadTable('courses', true);
    memoryDB.submissions = await loadTable('submissions', true);
    memoryDB.examApplications = await loadTable('exam_applications', true);
    memoryDB.forum = await loadTable('forum', true);
    memoryDB.admins = await loadTable('admins', true);
    memoryDB.proctoringLogs = await loadTable('proctoring_logs', true);
    memoryDB.examKeystrokes = await loadTable('exam_keystrokes', true);
    memoryDB.studentExamState = await loadTable('student_exam_state', false);
    memoryDB.broadcastMessages = await loadTable('broadcast_messages', true);
    memoryDB.questionBank = await loadTable('question_bank', true);
    memoryDB.auditLogs = await loadTable('audit_logs', true);
    memoryDB.loginLogs = await loadTable('login_logs', true);
    memoryDB.pedagogicalObservations = await loadTable('pedagogical_observations', true);
    memoryDB.attendance = await loadTable('attendance', true);
    memoryDB.certificates = await loadTable('certificates', true);
    memoryDB.moduleAccess = await loadTable('module_access', true);
    memoryDB.schools = await loadTable('schools', true);
    memoryDB.announcements = await loadTable('announcements', true);
    memoryDB.library = await loadTable('library', true);

    memoryDB.notes = await loadTable('notes', false);
    memoryDB.annotations = await loadTable('annotations', false);
    memoryDB.evaluations = await loadTable('evaluations', false);
    memoryDB.progress = await loadTable('progress', false);
    memoryDB.uploads = await loadTable('uploads', false);

    // Carrega Singletons
    const loadedConfig = await loadTable('config', false);
    memoryDB.config = loadedConfig['app_config'] || { releasedItems: {} };

    const loadedBranding = await loadTable('branding', false);
    if (loadedBranding['default']) {
        memoryDB.branding = loadedBranding['default'];
    }

    const loadedStructure = await loadTable('course_structure', false);
    memoryDB.courseStructure = loadedStructure['structure'] || [];

    // 3. Garante defaults se tabelas estruturais estiverem vazias
    populateDefaultsIfEmpty();

    // Migração de contas administrativas e senhas legadas.
    // Fase 5.1: contas sem papel (ou com papel desconhecido) continuam sendo
    // administradores. O shape normalizado também é persistido no SQLite.
    let needsSave = migrateLegacyExamApplications();
    if (memoryDB.admins && Array.isArray(memoryDB.admins)) {
        memoryDB.admins.forEach(admin => {
            if (!admin) return;

            const normalizedRole = admin.role === 'professor' ? 'professor' : 'admin';
            if (admin.role !== normalizedRole) {
                admin.role = normalizedRole;
                needsSave = true;
            }

            const unresolved = [];
            const normalizedAssignedClasses = [];
            if (normalizedRole === 'professor' && Array.isArray(admin.assignedClasses)) {
                admin.assignedClasses.forEach(value => {
                    if (value && typeof value === 'object') {
                        const courseId = String(value.courseId || '').trim();
                        const className = String(value.className || value.name || '').trim();
                        if ((memoryDB.classes || []).some(cls => cls.courseId === courseId && cls.name === className)) {
                            normalizedAssignedClasses.push({ courseId, className });
                        } else if (className) unresolved.push(className);
                        return;
                    }
                    const className = String(value || '').trim();
                    const matches = (memoryDB.classes || []).filter(cls => cls.name === className);
                    if (matches.length === 1) normalizedAssignedClasses.push({ courseId: matches[0].courseId, className });
                    else if (className) unresolved.push(className);
                });
            }
            const uniqueAssignments = normalizedRole === 'professor'
                ? uniqueSortedAssignments(normalizedAssignedClasses)
                : allClassAssignments();
            if (!Array.isArray(admin.assignedClasses) || JSON.stringify(admin.assignedClasses) !== JSON.stringify(uniqueAssignments)) {
                admin.assignedClasses = uniqueAssignments;
                needsSave = true;
            }

            const validSchoolIds = new Set((memoryDB.schools || []).map(school => String(school && school.id || '')).filter(Boolean));
            const validCourseIds = new Set((memoryDB.courses || [])
                .filter(course => course && !course.deleted && course.status !== 'deleted' && course.status !== 'inactive')
                .map(course => String(course.id)));
            const normalizedSchoolIds = normalizedRole === 'professor'
                ? [...new Set((admin.assignedSchoolIds || []).map(value => String(value || '').trim()).filter(id => id && validSchoolIds.has(id)))]
                : [];
            const normalizedCourseIds = normalizedRole === 'professor'
                ? [...new Set((admin.assignedCourseIds || []).map(value => String(value || '').trim()).filter(id => id && validCourseIds.has(id)))]
                : [];
            if (!Array.isArray(admin.assignedSchoolIds) || JSON.stringify(admin.assignedSchoolIds) !== JSON.stringify(normalizedSchoolIds)) {
                admin.assignedSchoolIds = normalizedSchoolIds;
                needsSave = true;
            }
            if (!Array.isArray(admin.assignedCourseIds) || JSON.stringify(admin.assignedCourseIds) !== JSON.stringify(normalizedCourseIds)) {
                admin.assignedCourseIds = normalizedCourseIds;
                needsSave = true;
            }
            if (JSON.stringify(admin.unresolvedAssignedClasses || []) !== JSON.stringify(unresolved)) {
                admin.unresolvedAssignedClasses = unresolved;
                needsSave = true;
            }

            const normalizedAdditionalPermissions = normalizedRole === 'professor'
                ? normalizeAdditionalPermissions(admin.additionalPermissions)
                : [];
            if (!Array.isArray(admin.additionalPermissions) || JSON.stringify(admin.additionalPermissions) !== JSON.stringify(normalizedAdditionalPermissions)) {
                admin.additionalPermissions = normalizedAdditionalPermissions;
                needsSave = true;
            }

            if (admin.password && !isHashed(admin.password)) {
                admin.password = hashPassword(admin.password);
                needsSave = true;
            }
        });
    }
    if (memoryDB.students && Array.isArray(memoryDB.students)) {
        memoryDB.students.forEach(student => {
            if (student.email && student.email.toLowerCase() === 'alan@alan.com'
                && student.name === 'Alan Marciano' && verifyPassword(student.password, '123')) {
                if (student.status !== 'Inativo' || student.mustChangePassword !== true) {
                    student.status = 'Inativo';
                    student.mustChangePassword = true;
                    needsSave = true;
                }
            }
            if (student.password && !isHashed(student.password)) {
                student.password = hashPassword(student.password);
                needsSave = true;
            }
            // Backfill: alunos antigos sem status recebem "Ativo" (idempotente).
            if (!student.status || String(student.status).trim() === "") {
                student.status = "Ativo";
                needsSave = true;
            }
            // DES-03: `studentClass` gravado como objeto (aprovação + matrícula em lote)
            // volta a ser o nome da turma; idempotente.
            if (normalizeStoredStudentClasses(student)) needsSave = true;
        });
    }
    if (memoryDB.config && memoryDB.config.adminPassword && !isHashed(memoryDB.config.adminPassword)) {
        memoryDB.config.adminPassword = hashPassword(memoryDB.config.adminPassword);
        needsSave = true;
    }
    // Segredo dos identificadores opacos das alternativas da prova (AVA-05). Gerado uma
    // vez e gravado antes de servir: os identificadores não mudam ao reiniciar.
    if (memoryDB.config && typeof memoryDB.config === 'object'
        && (typeof memoryDB.config.examAnswerSecret !== 'string' || memoryDB.config.examAnswerSecret.length < 32)) {
        memoryDB.config.examAnswerSecret = crypto.randomBytes(32).toString('hex');
        needsSave = true;
    }
    if (needsSave) {
        await saveToDisk();
    }

    // 4. Migração das avaliações do disco se não houver nenhuma cadastrada no DB
    if (Object.keys(memoryDB.evaluations).length === 0) {
        console.log("Migrando avaliações em Markdown da pasta para o SQLite...");
        const evaluations = {};
        const modulesList = ['FUTEC', 'FECOP', 'IRCOM'];
        modulesList.forEach(m => {
            for (let i = 1; i <= 5; i++) {
                const examKey = `Avaliacao_${m}_${i}`;
                const mdPath = path.join(CONTENT_DIR, `${examKey}.md`);
                if (fs.existsSync(mdPath)) {
                    try {
                        const mdContent = fs.readFileSync(mdPath, 'utf8');
                        const parsed = parseEvaluationMarkdown(mdContent, examKey);
                        if (parsed) {
                            evaluations[examKey] = parsed;
                        }
                    } catch (err) {
                        console.error(`Erro ao migrar ${examKey}:`, err);
                    }
                }
            }
        });
        memoryDB.evaluations = evaluations;
        
        await saveToDisk();
    }

    // 5. Ao LIGAR o servidor, nenhuma prova online deve voltar liberada ou rodando.
    // Zera o estado transitório das provas (liberação, status e cronômetro) para que o
    // professor libere/inicie manualmente quando a turma for fazer. Apostilas e gabaritos
    // mantêm sua liberação; só as avaliações são bloqueadas.
    if (syncOnlineExamConfigsWithApplications()) {
        console.log("🔒 Provas online resetadas para BLOQUEADAS/PARADAS no início do servidor.");
        await saveToDisk();
    }

    console.log("💾 Banco de dados SQLite inicializado e carregado na memória.");
}

// Sincroniza dados da memória de volta para o SQLite (Atomic Transactions)
function saveToDisk() {
    // Administradores pertencem sempre a todas as turmas, inclusive as criadas ou removidas durante a execução.
    syncAdminClassAssignments();
    syncProfessorAssignmentReferences();
    const completion = new Promise((resolve, reject) => saveWaiters.push({ resolve, reject }));
    if (isSaving) {
        hasPendingSave = true;
        return completion;
    }
    
    isSaving = true;
    hasPendingSave = false;
    
    setTimeout(() => {
        const cycleWaiters = saveWaiters.splice(0);
        sqliteDb.serialize(() => {
            sqliteDb.run("BEGIN TRANSACTION");
            
            // Gravação incremental: cada tabela guarda o JSON da última escrita por chave
            // e só as linhas que mudaram são gravadas. Antes, cada save apagava e regravava
            // TODAS as tabelas (inclusive milhares de teclas e logs), o que pesava durante
            // uma prova com muitos alunos. Na primeira gravação (ou após falha) a tabela
            // inteira é reescrita para garantir consistência.
            const writtenThisCycle = {};
            const writeTable = (tableName, next) => {
                const previous = lastWrittenRows && lastWrittenRows[tableName];
                if (!previous) {
                    sqliteDb.run(`DELETE FROM ${tableName}`);
                    const insert = sqliteDb.prepare(`INSERT OR REPLACE INTO ${tableName} (key, value) VALUES (?, ?)`);
                    next.forEach((json, key) => insert.run(key, json));
                    insert.finalize();
                } else {
                    const remove = sqliteDb.prepare(`DELETE FROM ${tableName} WHERE key = ?`);
                    previous.forEach((_, key) => { if (!next.has(key)) remove.run(key); });
                    remove.finalize();
                    const upsert = sqliteDb.prepare(`INSERT OR REPLACE INTO ${tableName} (key, value) VALUES (?, ?)`);
                    next.forEach((json, key) => { if (previous.get(key) !== json) upsert.run(key, json); });
                    upsert.finalize();
                }
                writtenThisCycle[tableName] = next;
            };

            const syncArrayTable = (tableName, arr, keyField) => {
                const next = new Map();
                (arr || []).forEach((item, idx) => {
                    if (!item) return;
                    let keyVal = typeof keyField === 'function' ? keyField(item) : item[keyField];
                    if (keyVal === undefined || keyVal === null || keyVal === '') {
                        // NUNCA descarta um registro por falta da chave (era isso que apagava as
                        // notas: submissões sem 'id' eram puladas). Gera uma chave estável e a
                        // grava de volta no objeto em memória para mantê-la consistente.
                        keyVal = `${tableName}_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`;
                        if (typeof keyField === 'string') { try { item[keyField] = keyVal; } catch (e) {} }
                    }
                    next.set(String(keyVal), JSON.stringify(item));
                });
                writeTable(tableName, next);
            };

            const syncObjectTable = (tableName, obj) => {
                const next = new Map();
                for (const key in obj) next.set(String(key), JSON.stringify(obj[key]));
                writeTable(tableName, next);
            };

            try {
                syncArrayTable('students', memoryDB.students, 'email');
                // Turma é identificada por curso + nome: "TURMA A" pode existir em dois cursos.
                // Com a chave só pelo nome, uma delas era apagada a cada gravação.
                syncArrayTable('classes', memoryDB.classes, classStorageKey);
                syncArrayTable('courses', memoryDB.courses, 'id');
                syncArrayTable('submissions', memoryDB.submissions, 'id');
                syncArrayTable('exam_applications', memoryDB.examApplications, 'id');
                syncArrayTable('forum', memoryDB.forum, 'id');
                syncArrayTable('admins', memoryDB.admins, 'email');
                syncArrayTable('proctoring_logs', memoryDB.proctoringLogs, 'id');
                syncArrayTable('exam_keystrokes', memoryDB.examKeystrokes, 'id');
                syncArrayTable('broadcast_messages', memoryDB.broadcastMessages, 'id');
                syncArrayTable('question_bank', memoryDB.questionBank, 'key');
                syncArrayTable('audit_logs', memoryDB.auditLogs, 'id');
                syncArrayTable('login_logs', memoryDB.loginLogs, 'id');
                syncArrayTable('pedagogical_observations', memoryDB.pedagogicalObservations, 'id');
                syncArrayTable('attendance', memoryDB.attendance, 'id');
                syncArrayTable('certificates', memoryDB.certificates, 'id');
                syncArrayTable('module_access', memoryDB.moduleAccess, 'id');
                syncArrayTable('schools', memoryDB.schools, 'id');
                syncArrayTable('announcements', memoryDB.announcements, 'id');
                syncArrayTable('library', memoryDB.library, 'id');

                syncObjectTable('notes', memoryDB.notes);
                syncObjectTable('annotations', memoryDB.annotations);
                syncObjectTable('evaluations', memoryDB.evaluations);
                syncObjectTable('progress', memoryDB.progress);
                syncObjectTable('uploads', memoryDB.uploads);
                syncObjectTable('student_exam_state', memoryDB.studentExamState);

                sqliteDb.run("DELETE FROM config");
                sqliteDb.run("INSERT INTO config (key, value) VALUES (?, ?)", 'app_config', JSON.stringify(memoryDB.config));

                sqliteDb.run("DELETE FROM branding");
                sqliteDb.run("INSERT INTO branding (key, value) VALUES (?, ?)", 'default', JSON.stringify(memoryDB.branding));

                sqliteDb.run("DELETE FROM course_structure");
                sqliteDb.run("INSERT INTO course_structure (key, value) VALUES (?, ?)", 'structure', JSON.stringify(memoryDB.courseStructure));
                
                sqliteDb.run("COMMIT", (err) => {
                    if (err) {
                        console.error("Erro ao comitar alterações no SQLite:", err);
                    }
                    // Só confia no diff incremental se o COMMIT deu certo; caso contrário a
                    // próxima gravação reescreve tudo.
                    lastWrittenRows = err ? null : writtenThisCycle;
                    if (err) cycleWaiters.forEach(waiter => waiter.reject(err));
                    else cycleWaiters.forEach(waiter => waiter.resolve());
                    isSaving = false;
                    if (hasPendingSave) {
                        saveToDisk();
                    }
                });
            } catch (err) {
                console.error("Falha ao salvar dados no SQLite:", err);
                lastWrittenRows = null;
                sqliteDb.run("ROLLBACK");
                cycleWaiters.forEach(waiter => waiter.reject(err));
                isSaving = false;
                if (hasPendingSave) {
                    saveToDisk();
                }
            }
        });
    }, 250);
    return completion;
}

function defaultAdminEmail() {
    const first = (memoryDB.admins || []).find(a => a && a.email);
    return first ? String(first.email).toLowerCase() : 'admin@local';
}

async function close() {
    await saveToDisk();
    await new Promise((resolve, reject) => {
        sqliteDb.close(err => err ? reject(err) : resolve());
    });
}

module.exports = {
    init,
    defaultAdminEmail,
    get memory() { return memoryDB; },
    save: saveToDisk,
    close,
    hashPassword,
    verifyPassword,
    needsPasswordRehash,
    allClassAssignments,
    syncAdminClassAssignments,
    rebuildExamApplicationsFromClasses,
    classStorageKey,
    isHashed
};
