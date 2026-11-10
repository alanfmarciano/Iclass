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
    normalizeLegacyStudentAdjustments,
    openApplicationPause,
} = require('./utils/examApplications.js');
const { hashExamToken } = require('./utils/examToken.js');
const { DATA_DIR, CONTENT_DIR } = require('./runtimePaths.js');
const { createDbWriter, DbWriteError, MEMORY_KINDS } = require('./utils/dbWriter.js');
const { currentRequestContext, isSoleApiRequest, trackRequestSave } = require('./utils/persistenceContext.js');
const { logError } = require('./utils/errorLog.js');

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
// Erro de statement sem callback (migração legada) vira evento 'error': sem este
// ouvinte ele derrubava o processo como uncaughtException (CONF-05).
sqliteDb.on('error', err => {
    console.error(`⚠️ [BANCO] ${(err && err.message) || err}`);
});

function classStorageKey(cls) {
    if (!cls || !cls.name) return '';
    return `${String(cls.courseId || '').trim()}::${String(cls.name).trim()}`;
}

// Registro único das tabelas (contrato da fase 2). Cada coleção da memória e cada tabela
// de data/database.db aparecem só aqui; dele derivam createTables, a carga do boot, a
// gravação (utils/dbWriter.js), a lista do backup (utils/backup.js: backup e kind
// diferente de 'derived') e a restauração. Tabela nova só entra por este registro, com
// CREATE TABLE IF NOT EXISTS.
// Campos:
// - collection: nome em db.memory e no backup; table: nome no SQLite;
// - kind: 'array' (lista, uma linha por item), 'object' (uma linha por chave),
//   'singleton' (uma linha de chave fixa), 'store' (tabela própria, fora da memória) ou
//   'derived' (linhas calculadas da memória por rows(memory), fora do backup);
// - key: campo ou função da chave da linha (nos singletons, a chave fixa; nos objetos, a
//   própria chave do objeto);
// - append: coleção que só cresce; na gravação parcial só as linhas novas viram texto
//   (quem altera uma linha antiga dela chama db.save() completo ou passa changed);
// - backup: vai no backup (padrão true);
// - restore: 'replace' (o backup substitui), 'merge' (junta com a atual), 'keep' (fica
//   a atual quando falta no backup) ou 'reset' (volta vazia); padrão 'replace'.
function tableEntry(collection, table, kind, key, extra = {}) {
    return Object.freeze({ collection, table, kind, key, append: false, backup: true, restore: 'replace', ...extra });
}

const COLLECTION_TABLES = Object.freeze([
    tableEntry('students', 'students', 'array', 'email'),
    // Turma é identificada por curso + nome: "TURMA A" pode existir em dois cursos. Com a
    // chave só pelo nome, uma delas era apagada a cada gravação.
    tableEntry('classes', 'classes', 'array', classStorageKey),
    tableEntry('courses', 'courses', 'array', 'id'), // multi-cursos
    tableEntry('branding', 'branding', 'singleton', 'default', { restore: 'keep', empty: () => ({}) }), // white-label
    tableEntry('submissions', 'submissions', 'array', 'id', { append: true }),
    tableEntry('notes', 'notes', 'object', null),
    tableEntry('annotations', 'annotations', 'object', null),
    tableEntry('forum', 'forum', 'array', 'id'),
    tableEntry('config', 'config', 'singleton', 'app_config', { restore: 'keep', empty: () => ({ releasedItems: {} }) }),
    // Em breve obsoleto, migrado para courses.
    tableEntry('courseStructure', 'course_structure', 'singleton', 'structure', { restore: 'keep', empty: () => [] }),
    tableEntry('evaluations', 'evaluations', 'object', null),
    tableEntry('progress', 'progress', 'object', null),
    tableEntry('uploads', 'uploads', 'object', null),
    // Contas de acesso: a restauração só as troca com replaceAccounts (utils/backup.js).
    tableEntry('admins', 'admins', 'array', 'email'),
    tableEntry('proctoringLogs', 'proctoring_logs', 'array', 'id', { append: true }),
    // Modo Prova Rigoroso: histórico de digitação por tentativa (telemetria de prova).
    // Fora do backup, como antes; o H1-b leva para a tabela própria exam_keystroke_events.
    tableEntry('examKeystrokes', 'exam_keystrokes', 'array', 'id', { append: true, backup: false }),
    tableEntry('studentExamState', 'student_exam_state', 'object', null), // chave: studentEmail + '_' + examKey
    tableEntry('broadcastMessages', 'broadcast_messages', 'array', 'id'),
    tableEntry('questionBank', 'question_bank', 'array', 'key'),
    // Auditoria: a restauração junta a trilha do backup com a atual (mergeAuditTrails,
    // utils/audit.js, ligado no applySnapshot de utils/backup.js pelo H7a-2): o que foi
    // registrado depois do backup fica. O laço genérico por modo do registro ('merge',
    // 'keep', 'reset') para as outras coleções é do H4a.
    tableEntry('auditLogs', 'audit_logs', 'array', 'id', { append: true, restore: 'merge' }),
    tableEntry('loginLogs', 'login_logs', 'array', 'id', { append: true }), // segurança/LGPD
    tableEntry('pedagogicalObservations', 'pedagogical_observations', 'array', 'id'),
    tableEntry('attendance', 'attendance', 'array', 'id', { append: true }), // registros de presença
    tableEntry('certificates', 'certificates', 'array', 'id'),
    tableEntry('moduleAccess', 'module_access', 'array', 'id', { append: true }), // módulos acessados
    tableEntry('schools', 'schools', 'array', 'id'), // escolas/instituições (white-label)
    tableEntry('announcements', 'announcements', 'array', 'id'), // avisos (professor -> turma/curso/aluno)
    tableEntry('library', 'library', 'array', 'id'), // biblioteca de materiais reutilizáveis
    // Aplicações de prova: sem elas, restaurar um backup voltava as entregas e a turma,
    // mas não o status das aplicações.
    tableEntry('examApplications', 'exam_applications', 'array', 'id'),
    // Termos de Uso e Política de Privacidade (H8a-1; utils/legalDocuments.js): rascunho
    // e versões publicadas, que não mudam mais. Fora de config e branding, que são
    // regravados a cada save. Na restauração, junta por id: restaurar um backup anterior
    // (ou de versão antiga, sem a coleção) não apaga o texto que os alunos aceitaram.
    tableEntry('legalDocuments', 'legal_documents', 'array', 'id', { restore: 'merge' }),
]);

const TABLE_BY_COLLECTION = new Map(COLLECTION_TABLES.map(entry => [entry.collection, entry]));

// Valor vazio de uma coleção da memória (boot, restauração 'reset').
function emptyCollectionValue(entry) {
    if (!entry) return undefined;
    if (entry.kind === 'array') return [];
    if (entry.kind === 'object') return {};
    if (entry.kind === 'singleton') return entry.empty();
    return undefined;
}

function createEmptyMemory() {
    const memory = {};
    COLLECTION_TABLES.forEach(entry => {
        if (MEMORY_KINDS.has(entry.kind)) memory[entry.collection] = emptyCollectionValue(entry);
    });
    memory.sessions = {}; // Alunos online { "email": sessão } (memória; zeradas a cada boot)
    return memory;
}

let memoryDB = createEmptyMemory();

function runSql(sql, params = []) {
    return new Promise((resolve, reject) => sqliteDb.run(sql, params, err => (err ? reject(err) : resolve())));
}

function getSql(sql, params = []) {
    return new Promise((resolve, reject) => sqliteDb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
}

function allSql(sql, params = []) {
    return new Promise((resolve, reject) => sqliteDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

// Espera por trava do banco (outro programa gravando): ICLASS_DB_BUSY_TIMEOUT_MS ou 5 s.
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
function configuredBusyTimeoutMs() {
    const raw = String(process.env.ICLASS_DB_BUSY_TIMEOUT_MS || '').trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 0) return DEFAULT_BUSY_TIMEOUT_MS;
    return Math.min(Math.round(value), 120000);
}

const SYNCHRONOUS_NAMES = { 0: 'OFF', 1: 'NORMAL', 2: 'FULL', 3: 'EXTRA' };
const connectionInfo = { journalMode: null, synchronous: null, busyTimeoutMs: null };

// PRAGMAs da conexão (CONF-05, DES-01), antes de createTables:
// - busy_timeout: a gravação espera a trava de outro programa em vez de falhar na hora;
// - WAL: um leitor externo (visualizador do banco, cópia) não bloqueia mais a gravação.
//   Em pasta de rede ou sincronizada o modo pode não pegar: segue com aviso, e o modo
//   real fica em storageStatus().journalMode;
// - synchronous FULL: o "salvo" sobrevive também a queda de energia;
// - journal_size_limit: o -wal volta a 64 MB depois de um checkpoint.
async function configureConnection() {
    const busyTimeoutMs = configuredBusyTimeoutMs();
    await runSql(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    let journalMode = null;
    try {
        const row = await getSql('PRAGMA journal_mode = WAL');
        journalMode = String(row ? Object.values(row)[0] : '').toLowerCase();
    } catch (err) {
        console.warn(`⚠️ Não foi possível ligar o modo WAL do banco: ${(err && err.message) || err}`);
    }
    if (!journalMode) {
        const row = await getSql('PRAGMA journal_mode').catch(() => null);
        journalMode = String(row ? Object.values(row)[0] : '').toLowerCase() || null;
    }
    if (journalMode !== 'wal') {
        console.warn(`⚠️ O banco de dados está no modo "${journalMode || 'desconhecido'}" em vez de WAL. A pasta de dados pode estar numa pasta de rede ou sincronizada (OneDrive): mova a pasta do IClass para um disco local.`);
    }
    await runSql('PRAGMA synchronous = FULL');
    await runSql('PRAGMA journal_size_limit = 67108864');
    const busyRow = await getSql('PRAGMA busy_timeout').catch(() => null);
    const syncRow = await getSql('PRAGMA synchronous').catch(() => null);
    connectionInfo.journalMode = journalMode;
    connectionInfo.busyTimeoutMs = busyRow ? Number(Object.values(busyRow)[0]) : busyTimeoutMs;
    connectionInfo.synchronous = syncRow ? (SYNCHRONOUS_NAMES[Number(Object.values(syncRow)[0])] || String(Object.values(syncRow)[0])) : null;
}

// Criação de Tabelas se não existirem: todas pelo registro COLLECTION_TABLES.
async function createTables() {
    for (const entry of COLLECTION_TABLES) {
        const statements = entry.kind === 'store'
            ? (entry.schema || [])
            : [`CREATE TABLE IF NOT EXISTS ${entry.table} (key TEXT PRIMARY KEY, value TEXT)`];
        for (const sql of statements) await runSql(sql);
    }
}

// PRAGMAs e tabelas, uma vez: o init e o primeiro ciclo de gravação esperam. Se falhar
// (disco), a próxima tentativa recomeça.
let connectionReady = null;
function ensureConnection() {
    if (!connectionReady) {
        connectionReady = configureConnection().then(createTables);
        connectionReady.catch(() => { connectionReady = null; });
    }
    return connectionReady;
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
                sqliteDb.run("BEGIN IMMEDIATE");
                
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

// Carrega as coleções do registro para a memória e semeia o motor de gravação com o
// JSON de cada linha exatamente como foi lido (DES-01): a primeira gravação depois do
// boot escreve só o que mudou, em vez de apagar e reinserir todas as tabelas (26 s num
// banco de um ano). Linha com JSON ilegível fica no arquivo, fora da memória e do mapa:
// a gravação nunca a apaga (antes ela sumia no primeiro save). Quando a memória ganha um
// valor com a mesma chave, o texto original é copiado antes para '<chave>.ilegivel-<data>'
// (utils/dbWriter.js). É o caso do singleton ilegível (config, branding,
// courseStructure): o IClass segue com o valor padrão dele, e a primeira gravação guarda
// a linha original ao lado em vez de sobrescrevê-la (antes as configurações e o segredo
// das alternativas da prova sumiam sem aviso).
async function loadRegisteredCollections() {
    for (const entry of COLLECTION_TABLES) {
        if (!MEMORY_KINDS.has(entry.kind)) continue;
        const rows = await allSql(`SELECT key, value FROM ${entry.table}`);
        const seed = new Map();
        const parsed = [];
        const unreadable = [];
        rows.forEach(row => {
            try {
                parsed.push([row.key, JSON.parse(row.value)]);
                seed.set(String(row.key), row.value);
            } catch (e) {
                unreadable.push(String(row.key));
            }
        });
        writer.seed(entry.table, seed, unreadable);
        const singletonUnreadable = entry.kind === 'singleton' && unreadable.includes(String(entry.key));
        const otherUnreadable = unreadable.length - (singletonUnreadable ? 1 : 0);
        if (singletonUnreadable) {
            // logError já põe a linha-resumo no console; o registro fica no crash.log.
            const message = `A linha "${entry.key}" da tabela ${entry.table} está ilegível: o IClass seguiu com os valores padrão de "${entry.collection}". A linha original fica no arquivo, guardada como "${entry.key}.ilegivel-<data>" na primeira gravação. Para recuperar o que ela tinha, restaure um backup.`;
            logError('[BANCO] Registro ilegível', { message }, { details: { tabela: entry.table, chave: entry.key } });
        }
        if (otherUnreadable) {
            console.warn(`⚠️ ${otherUnreadable} registro(s) ilegível(is) na tabela ${entry.table} continuam no arquivo, fora da memória (a gravação não os apaga).`);
        }
        if (entry.kind === 'array') {
            memoryDB[entry.collection] = parsed.map(([, value]) => value);
        } else if (entry.kind === 'object') {
            const object = {};
            parsed.forEach(([key, value]) => { object[key] = value; });
            memoryDB[entry.collection] = object;
        } else {
            const found = parsed.find(([key]) => key === entry.key);
            memoryDB[entry.collection] = (found && found[1]) || emptyCollectionValue(entry);
        }
    }
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

// Matrícula do aluno na turma (nome, e curso quando a matrícula o traz).
function studentRecordInClass(email, cls) {
    const student = (memoryDB.students || []).find(item => item && String(item.email || '').trim().toLowerCase() === email);
    if (!student || !cls) return false;
    const memberships = Array.isArray(student.classes) && student.classes.length
        ? student.classes
        : (student.studentClass ? [student.studentClass] : []);
    return memberships.some(item => (typeof item === 'string'
        ? item === cls.name
        : !!item && (item.name || item.className) === cls.name && (!item.courseId || !cls.courseId || String(item.courseId) === String(cls.courseId))));
}

// Versão escolhida no Monitor antes de o aluno começar: a versão anterior (5b69148)
// gravava a escolha na aplicação e num estado avulso "<email>_<prova>" com
// versionAssigned. O backup daquela versão não levava as aplicações; a escolha volta
// pelo estado avulso (só o desta preparação da prova e de aluno da turma). O estado
// avulso deixa de marcar a versão (ela fica na aplicação, que a tentativa nova lê);
// sem isso ele virava uma "tentativa em uso" que era reiniciada com outra versão e sem
// o "+N min" que o aluno tinha ganhado antes de começar. Devolve as versões escolhidas
// e quantos estados avulsos deixaram de marcar a versão.
function legacyMonitorVersions(cls, examKey, cfg) {
    const versions = new Set((Array.isArray(cfg.versionSnapshots) ? cfg.versionSnapshots : [])
        .map(snapshot => String((snapshot && snapshot.version) || '').trim().toUpperCase())
        .filter(Boolean));
    const configVersion = cfg.updatedAt || cfg.preparedAt || cfg.activeHistoryId || null;
    const chosen = {};
    let released = 0;
    Object.entries(memoryDB.studentExamState || {}).forEach(([key, state]) => {
        if (!state || typeof state !== 'object' || state.applicationId || state.versionAssigned !== true) return;
        const email = String(state.studentEmail || '').trim().toLowerCase();
        if (!email || String(state.examKey || '').trim() !== examKey || key !== `${email}_${examKey}`) return;
        if (state.examConfigVersion && configVersion && state.examConfigVersion !== configVersion) return;
        const version = String(state.assignedVersion || '').trim().toUpperCase();
        if (!versions.has(version) || !studentRecordInClass(email, cls)) return;
        chosen[email] = version;
        const onlyTheChoice = !(Number(state.startedAt) > 0)
            && typeof state.timerRemaining !== 'number'
            && !(state.answers && typeof state.answers === 'object' && Object.keys(state.answers).length)
            && state.tokenValidated !== true;
        if (onlyTheChoice) {
            state.versionAssigned = false;
            released += 1;
        }
    });
    return { chosen, released };
}

// Momento aproximado do encerramento de uma aplicação refeita de um backup antigo: a
// última entrega dela; sem entrega, o último salvamento de uma tentativa; sem nada, a
// preparação. Nunca antes do início.
function approximateFinishedAt(applicationId, cfg) {
    const times = [];
    (memoryDB.submissions || []).forEach(sub => {
        if (!sub || String(sub.applicationId || '') !== applicationId) return;
        const at = Date.parse(sub.timestamp || sub.submittedAt || '');
        if (Number.isFinite(at)) times.push(at);
    });
    if (!times.length) {
        Object.values(memoryDB.studentExamState || {}).forEach(state => {
            if (!state || String(state.applicationId || '') !== applicationId) return;
            const at = Date.parse(state.savedAt || state.updatedAt || '');
            if (Number.isFinite(at)) times.push(at);
        });
    }
    if (!times.length) {
        const prepared = Date.parse(cfg.updatedAt || cfg.preparedAt || '');
        if (Number.isFinite(prepared)) times.push(prepared);
    }
    const start = Number(cfg.startTime) || 0;
    return times.length ? Math.max(start, ...times) : (start || null);
}

// Inicialização Assíncrona do Banco
// options.pausedAt: na restauração de um backup de versão anterior, o momento do
// backup (a aplicação pausada nele fica pausada desde então: o cronômetro não anda
// durante a pausa e ninguém ganha o tempo de novo). No boot, sem esse dado, "agora".
function migrateLegacyExamApplications(options = {}) {
    if (!Array.isArray(memoryDB.examApplications)) memoryDB.examApplications = [];
    let changed = false;
    // Aplicações pausadas por versões antigas passam a registrar o início da pausa
    // (o cronômetro fica congelado a partir dele). "+N min" de aluno duplicado na
    // aplicação vale só para a tentativa em que foi dado. Idempotente.
    memoryDB.examApplications.forEach(application => {
        if (normalizeLegacyApplicationPause(application)) changed = true;
        if (normalizeLegacyStudentAdjustments(application, memoryDB.studentExamState)) changed = true;
    });
    (memoryDB.classes || []).forEach(cls => {
        if (!cls.onlineExamConfigs) return;
        Object.keys(cls.onlineExamConfigs).forEach(examKey => {
            const cfg = cls.onlineExamConfigs[examKey];
            if (!cfg) return;
            let application = findExamApplication(memoryDB.examApplications, cfg.applicationId);
            const existed = !!application;
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
                        // A versão anterior (5b69148) guardava só o hash do token, com
                        // accessToken null: o token continua exigido. Antes o hash era
                        // descartado e qualquer aluno começava sem token.
                        accessTokenHash: cfg.accessTokenHash || hashExamToken(cfg.accessToken),
                        tokenEnabled: cfg.tokenEnabled === true || !!cfg.accessTokenHash || !!cfg.accessToken,
                        studentVersions: { ...(cfg.studentVersions || {}), ...legacyMonitorVersions(cls, examKey, cfg).chosen },
                    },
                    actor: 'migração automática',
                    status: legacyStatus,
                    now: cfg.startTime || Date.now(),
                });
                if (cfg.startTime) application.startsAt = Number(cfg.startTime);
                // Preparada quando a configuração diz (o Monitor lista as aplicações por essa
                // data). Antes ficava a hora da restauração, ou a do início da prova.
                const preparedAt = Date.parse(cfg.preparedAt || '');
                if (Number.isFinite(preparedAt) && preparedAt > 0 && preparedAt <= Date.parse(application.createdAt)) {
                    application.createdAt = new Date(preparedAt).toISOString();
                    application.preparedAt = application.createdAt;
                }
                if (legacyStatus === 'paused') {
                    // Pausada desde o momento do backup (ou de agora): nunca desde o
                    // início da prova, que devolveria a todos o tempo já usado.
                    const hint = Number(options.pausedAt);
                    const pausedAt = Math.max(Number(application.startsAt) || 0, Number.isFinite(hint) && hint > 0 ? hint : Date.now());
                    openApplicationPause(application, pausedAt);
                    application.updatedAt = new Date(pausedAt).toISOString();
                }
                if (legacyStatus === 'finished') {
                    const previousId = String(cfg.applicationId || '').trim();
                    const finishedAt = approximateFinishedAt(previousId || application.id, cfg);
                    if (finishedAt) {
                        application.finishedAt = new Date(finishedAt).toISOString();
                        application.endsAt = application.endsAt || finishedAt;
                        application.updatedAt = application.finishedAt;
                    }
                }
                // A configuração ainda aponta para a aplicação que sumiu (backup de versão
                // anterior, que não trazia as aplicações): ela volta com o mesmo
                // identificador, e as tentativas e entregas gravadas com ele continuam dela.
                const previousId = String(cfg.applicationId || '').trim();
                if (previousId) application.id = previousId;
                memoryDB.examApplications.push(application);
                changed = true;
            }
            if (!application) return;
            // Banco da versão anterior atualizado (a aplicação existe): a versão escolhida
            // no Monitor para quem ainda não tinha começado fica na aplicação e o estado
            // avulso deixa de marcá-la, como na restauração do backup. Antes ele virava a
            // tentativa do aluno, que era reiniciada com outra versão sorteada e sem o
            // "+N min" dado antes de começar (que ficava parado na aplicação). Idempotente.
            if (existed && application.status !== 'finished' && application.status !== 'cancelled') {
                const legacy = legacyMonitorVersions(cls, examKey, {
                    ...cfg,
                    versionSnapshots: Array.isArray(application.versionSnapshots) && application.versionSnapshots.length
                        ? application.versionSnapshots
                        : cfg.versionSnapshots,
                });
                if (legacy.released) changed = true;
                Object.entries(legacy.chosen).forEach(([email, version]) => {
                    if (!application.studentVersions || typeof application.studentVersions !== 'object') application.studentVersions = {};
                    if (application.studentVersions[email]) return;
                    application.studentVersions[email] = version;
                    changed = true;
                });
            }
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
function rebuildExamApplicationsFromClasses({ backupAt = null } = {}) {
    const discarded = Array.isArray(memoryDB.examApplications) ? memoryDB.examApplications.length : 0;
    memoryDB.examApplications = [];
    migrateLegacyExamApplications({ pausedAt: backupAt });
    syncOnlineExamConfigsWithApplications();
    return { discarded, rebuilt: memoryDB.examApplications.length };
}

async function init() {
    // PRAGMAs (busy_timeout, WAL, synchronous) e tabelas do registro.
    await ensureConnection();

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
            await runSql("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", ['app_config', raw]);
            fs.renameSync(CONFIG_FILE, CONFIG_FILE + '.migrated');
        } catch(e){}
    }
    if (fs.existsSync(DB_COURSE_STRUCTURE_FILE)) {
        try {
            const raw = fs.readFileSync(DB_COURSE_STRUCTURE_FILE, 'utf8');
            await runSql("INSERT OR REPLACE INTO course_structure (key, value) VALUES (?, ?)", ['structure', raw]);
            fs.renameSync(DB_COURSE_STRUCTURE_FILE, DB_COURSE_STRUCTURE_FILE + '.migrated');
        } catch(e){}
    }

    // 2. Carrega todas as coleções do registro (e semeia o motor de gravação).
    await loadRegisteredCollections();

    // Migração de studentClass para classes array
    memoryDB.students.forEach(student => {
        if (student && !student.classes) {
            student.classes = [];
            if (student.studentClass) {
                student.classes.push(student.studentClass);
            }
        }
    });

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

// Motor de gravação (utils/dbWriter.js): fila, diff, transação e regravação.
const writer = createDbWriter({
    connection: sqliteDb,
    tables: COLLECTION_TABLES,
    getMemory: () => memoryDB,
    ready: ensureConnection,
    // Administradores pertencem sempre a todas as turmas, inclusive as criadas ou
    // removidas durante a execução; professores só às que ainda existem.
    beforeCycle: () => {
        const adminsChanged = syncAdminClassAssignments();
        const professorsChanged = syncProfessorAssignmentReferences();
        return adminsChanged || professorsChanged;
    },
    // A causa (erro do SQLite ou do plano) vai para o log: a pilha dela diz onde falhou,
    // e a mensagem já começa pelo código (SQLITE_BUSY: database is locked).
    logFailure: err => {
        logError('[GRAVAÇÃO] Não foi possível gravar no banco', (err && err.cause) || err);
    },
    busyTimeoutMs: () => connectionInfo.busyTimeoutMs,
});

// Verificador de gravação parcial (ICLASS_VERIFY_SAVES; ligado no node --test e no e2e):
// numa gravação parcial feita durante um pedido /api, o que mudou na memória desde o
// início do pedido (ou desde a gravação anterior dele) e ficou fora de only (ou linha
// antiga de coleção com append fora de changed) é acusado no console e em
// db.saveVerifyFailures e entra no ciclo assim mesmo, para o dado não se perder.
// A verificação é pulada quando outra coisa pode ter mudado a memória no meio: outro
// pedido /api (utils/persistenceContext.js) ou uma gravação de fora de pedido (timer,
// como a entrega automática do fim do tempo), que conta em backgroundSaveSeq.
const saveVerifyFailures = [];
let backgroundSaveSeq = 0;

function verifyPartialSave(context, scope) {
    const snapshot = context.snapshot;
    if (!snapshot || !isSoleApiRequest(context) || snapshot.backgroundSeq !== backgroundSaveSeq) return;
    writer.uncoveredChanges(snapshot.rows, scope).forEach(problem => {
        const entry = TABLE_BY_COLLECTION.get(problem.collection);
        scope.only.add(problem.collection);
        if (entry && entry.append && problem.existed) {
            const keys = scope.changed.get(problem.collection) || new Set();
            keys.add(problem.key);
            scope.changed.set(problem.collection, keys);
        }
        const signature = `${problem.collection}\u0000${problem.key}`;
        if (context.reported.has(signature)) return;
        context.reported.add(signature);
        const failure = {
            method: context.method,
            path: context.path,
            collection: problem.collection,
            key: problem.key,
            at: new Date().toISOString(),
        };
        saveVerifyFailures.push(failure);
        console.error(`[VERIFICAÇÃO DE GRAVAÇÃO] ${failure.method} ${failure.path} alterou "${failure.collection}" (chave ${failure.key}) sem incluir em only`);
    });
}

if (process.env.NODE_TEST_CONTEXT) {
    // node --test: uma gravação parcial esquecida reprova o arquivo de teste.
    process.on('exit', () => {
        if (!saveVerifyFailures.length) return;
        console.error(`[VERIFICAÇÃO DE GRAVAÇÃO] ${saveVerifyFailures.length} alteração(ões) fora da gravação parcial:`);
        saveVerifyFailures.forEach(item => console.error(`  ${item.method} ${item.path}: "${item.collection}" (chave ${item.key})`));
        process.exitCode = 1;
    });
}

// db.save(): gravação completa (compara todas as coleções). É o que todo código novo usa.
// db.save({ only, changed, detached }): parcial, só nas rotas anotadas (H1-c). Nome
// desconhecido lança TypeError na hora. Dentro de um pedido, a resposta espera o COMMIT
// (utils/persistenceContext.js), a não ser com detached: true (presença automática, timers).
// A promessa rejeita com DbWriteError (code 'ICLASS_DB_WRITE') quando não deu para gravar.
function saveToDisk(options) {
    const scope = writer.scopeFromOptions(options);
    const detached = !!(options && typeof options === 'object' && options.detached === true);
    const adminsChanged = syncAdminClassAssignments();
    const professorsChanged = syncProfessorAssignmentReferences();
    if ((adminsChanged || professorsChanged) && !scope.full) scope.only.add('admins');
    const context = currentRequestContext();
    if (!context) backgroundSaveSeq += 1;
    if (context && !scope.full) verifyPartialSave(context, scope);
    const completion = writer.request(scope);
    if (context) refreshSaveSnapshot(context, scope);
    // Dentro de um pedido a resposta espera esta gravação; a promessa devolvida sabe se a
    // rota tratou a falha (utils/persistenceContext.js).
    if (context && !detached) return trackRequestSave(context, completion);
    return completion;
}

// Foto da memória no início de um pedido /api, para o verificador.
function captureSaveSnapshot() {
    return { rows: writer.snapshotRows(), backgroundSeq: backgroundSaveSeq };
}

// Depois de uma gravação pedida no pedido, o que ela cobre passa a ser o ponto de
// partida da foto: uma gravação completa seguida de uma parcial no mesmo pedido não
// acusa o que a completa já levou.
function refreshSaveSnapshot(context, scope) {
    if (!context.snapshot) return;
    if (scope.full) {
        context.snapshot = captureSaveSnapshot();
        return;
    }
    const covered = new Set([...scope.only, ...scope.changed.keys()]);
    writer.snapshotRows(covered).forEach((rows, collection) => context.snapshot.rows.set(collection, rows));
}

// Estado do armazenamento (fonte única: cartão Armazenamento do H1-c e /api/health do H3).
function storageStatus() {
    const fileSize = file => { try { return fs.statSync(file).size; } catch (e) { return 0; } };
    const rows = {};
    COLLECTION_TABLES.forEach(entry => {
        const value = memoryDB[entry.collection];
        if (entry.kind === 'array') rows[entry.collection] = Array.isArray(value) ? value.length : 0;
        else if (entry.kind === 'object') rows[entry.collection] = value && typeof value === 'object' ? Object.keys(value).length : 0;
        else if (entry.kind === 'singleton') rows[entry.collection] = value === undefined ? 0 : 1;
    });
    const status = writer.status();
    return {
        journalMode: connectionInfo.journalMode,
        synchronous: connectionInfo.synchronous,
        busyTimeoutMs: connectionInfo.busyTimeoutMs,
        databaseBytes: fileSize(dbPath),
        walBytes: fileSize(`${dbPath}-wal`),
        rows,
        lastFullSaveAt: status.lastFullSaveAt,
        lastFullSaveMs: status.lastFullSaveMs,
        commitP95Ms: status.commitP95Ms,
        lastWriteError: status.lastWriteError,
        pendingRetry: status.pendingRetry,
        nextRetryAt: status.nextRetryAt,
        lastCycle: status.lastCycle,
    };
}

function defaultAdminEmail() {
    const first = (memoryDB.admins || []).find(a => a && a.email);
    return first ? String(first.email).toLowerCase() : 'admin@local';
}

// Gravação completa, espera da fila e fechamento da conexão (o SQLite aplica e apaga o
// -wal). Usado no desligamento por SIGINT e SIGTERM (server.js); SIGHUP, SIGBREAK e o
// Reiniciar passam a chamá-lo com o requestShutdown do H3c (plano da fase 2).
// Depois dele, db.save() rejeita com DbWriteError.
function close() {
    return writer.close();
}

module.exports = {
    init,
    defaultAdminEmail,
    get memory() { return memoryDB; },
    COLLECTION_TABLES,
    emptyCollectionValue,
    save: saveToDisk,
    // Resolve quando toda gravação pedida até agora terminou (com sucesso ou não).
    flush: () => writer.flush(),
    // VACUUM e VACUUM INTO só por aqui: fn(conexão) roda com a fila de gravação parada.
    runExclusive: fn => writer.runExclusive(fn),
    close,
    storageStatus,
    captureSaveSnapshot,
    get saveVerifyFailures() { return saveVerifyFailures; },
    clearSaveVerifyFailures() { saveVerifyFailures.length = 0; },
    DbWriteError,
    hashPassword,
    verifyPassword,
    needsPasswordRehash,
    allClassAssignments,
    syncAdminClassAssignments,
    rebuildExamApplicationsFromClasses,
    classStorageKey,
    isHashed
};
