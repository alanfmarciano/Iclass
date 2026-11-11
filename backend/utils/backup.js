const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream');
const db = require('../database.js');
const runtimePaths = require('../runtimePaths.js');
const { resolveInside } = require('./safePath.js');
const { normalizeStoredStudentClasses } = require('./students.js');
const zipInspect = require('./zipInspect.js');
const { mergeAuditTrails } = require('./audit.js');
const { logError } = require('./errorLog.js');
const archive = require('./backupArchive.js');
const schema = require('./backupSchema.js');
const dbFile = require('./dbFile.js');
const { KEYSTROKE_TABLE, LEGACY_KEYSTROKE_TABLE } = require('./keystrokeStore.js');

const { backupRefusal } = schema;
const CONTENT_DIR = runtimePaths.CONTENT_DIR;
const DATA_DIR = runtimePaths.DATA_DIR;
const BACKUPS_DIR = runtimePaths.BACKUPS_DIR;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
// Pasta de trabalho do backup (cópia do banco antes de compactar) e da restauração
// (envios, prévias extraídas). Nenhuma das duas entra em backup; as duas são limpas no
// boot (cleanWorkDirs).
const WORK_DIR = path.join(DATA_DIR, '.backup-trabalho');
const RESTORE_DIR = path.join(DATA_DIR, '.restauracao');
const UPLOADS_INBOX_DIR = path.join(RESTORE_DIR, 'envios');
// Coleções do backup: derivadas do registro único de tabelas (database.js,
// COLLECTION_TABLES), as que têm backup e não são derivadas. A ordem é a do registro.
// Entre elas está examApplications: sem as aplicações, restaurar um backup (por exemplo o
// salvo antes de "Resetar sala") voltava as entregas e a turma, mas não o status das
// aplicações. Backup de versão anterior sem a coleção: as aplicações atuais são
// descartadas e refeitas a partir das turmas do backup (ver legacyApplications).
const BACKUP_TABLES = db.COLLECTION_TABLES.filter(entry => entry.backup !== false && entry.kind !== 'derived');
const COLLECTIONS = BACKUP_TABLES.map(entry => entry.collection);
// Tabelas próprias (kind 'store', fora da memória: o histórico de digitação). Entram no
// backup desde o H4a: no JSON pelo db.keystrokes.exportRows() (coleção examKeystrokes) e
// no ZIP formato 2 dentro do próprio data/database.db. Na restauração voltam pelo
// importRows (JSON) ou pelo copyFromAttached (formato 2), substituindo as atuais.
const STORE_COLLECTIONS = new Set(BACKUP_TABLES.filter(entry => entry.kind === 'store').map(entry => entry.collection));

// Nome de cada coleção na prévia da restauração ("no backup × hoje").
const COLLECTION_LABELS = {
    students: 'Alunos',
    classes: 'Turmas',
    courses: 'Cursos',
    branding: 'Identidade visual',
    submissions: 'Entregas e notas',
    notes: 'Anotações dos alunos',
    annotations: 'Marcações nas apostilas',
    forum: 'Fórum',
    config: 'Configurações',
    courseStructure: 'Estrutura antiga dos cursos',
    evaluations: 'Avaliações',
    progress: 'Progresso nas apostilas',
    uploads: 'Registro de arquivos enviados',
    admins: 'Contas de acesso',
    proctoringLogs: 'Registros de foco na prova',
    examKeystrokes: 'Histórico de digitação',
    studentExamState: 'Tentativas de prova',
    broadcastMessages: 'Mensagens da prova',
    questionBank: 'Banco de questões',
    auditLogs: 'Auditoria',
    loginLogs: 'Registros de login',
    pedagogicalObservations: 'Observações pedagógicas',
    attendance: 'Presenças',
    certificates: 'Certificados',
    moduleAccess: 'Acessos aos módulos',
    schools: 'Escolas',
    announcements: 'Avisos e calendário',
    library: 'Biblioteca',
    examApplications: 'Aplicações de prova',
    legalDocuments: 'Termos e Privacidade',
};

function collectionLabel(collection) {
    return COLLECTION_LABELS[collection] || collection;
}

// Backup gerado por versão anterior do IClass, que não guardava as aplicações de prova.
function hasLegacyApplications(snapshot) {
    return !!(snapshot && snapshot.data && typeof snapshot.data === 'object' && snapshot.data.examApplications === undefined);
}

// Diz o que volta e o que não volta: o backup antigo não guardava as aplicações, só as
// turmas, as tentativas e as entregas.
const LEGACY_BACKUP_WARNING = 'Este backup é de uma versão anterior do IClass e não traz as aplicações de prova. '
    + 'Ao restaurar, as aplicações de prova atuais serão descartadas (inclusive as criadas depois do backup) e refeitas '
    + 'a partir das turmas do backup. Volta a última aplicação de cada prova em cada turma, com as tentativas, as '
    + 'respostas e as entregas dos alunos, o token de acesso e a versão escolhida no Monitor para quem ainda não tinha '
    + 'começado. As aplicações anteriores de uma prova reaplicada e as canceladas não voltam como aplicação, mas as '
    + 'notas delas continuam. Prova que estava pausada continua pausada, mas a pausa passa a contar do momento do backup, porque '
    + 'esse backup não guardava a hora da pausa: o tempo entre a pausa e o backup é descontado do tempo dos alunos. '
    + 'Não voltam: as contestações de questão feitas pelos alunos (esse backup não as guardava) e o "+N min" dado '
    + 'a um aluno que ainda não tinha começado a tentativa. O horário de encerramento das provas já encerradas é '
    + 'aproximado pela última entrega. Um backup de segurança dos dados atuais é criado antes.';

const BACKUP_BUSY_MESSAGE = 'Já há um backup em andamento. Tente de novo em alguns minutos.';
const SAFETY_BACKUP_FAILED_MESSAGE = 'Não foi possível salvar o backup de segurança; nada foi alterado.';

// adm-zip só nos testes e no buildFullZipBuffer (o ZIP formato 1 de antes, para conferir
// a compatibilidade); a produção usa o archiver e o zipInspect.
function getZipLib() { try { return require('adm-zip'); } catch (e) { return null; } }

// ---------------------------------------------------------------------------
// Um backup por vez (H4a): gerar (automático, manual, segurança, download) e restaurar
// usam a mesma trava em memória. Pedido com outro em andamento recebe 409.
// ---------------------------------------------------------------------------
let activeJob = null;

function backupBusyError() {
    return Object.assign(new Error(BACKUP_BUSY_MESSAGE), { status: 409, code: 'ICLASS_BACKUP_BUSY' });
}

async function withBackupLock(kind, fn) {
    if (activeJob) throw backupBusyError();
    activeJob = { kind, startedAt: Date.now() };
    try {
        return await fn();
    } finally {
        activeJob = null;
    }
}

function backupInProgress() {
    return activeJob ? { ...activeJob } : null;
}

// ---------------------------------------------------------------------------
// Snapshot dos dados na memória (JSON)
// ---------------------------------------------------------------------------

// As coleções da memória como estão (sem cópia; quem guarda para desfazer não altera).
function memorySnapshot() {
    const data = {};
    COLLECTIONS.forEach(key => { if (!STORE_COLLECTIONS.has(key) && db.memory[key] !== undefined) data[key] = db.memory[key]; });
    return { type: 'iclass-backup-data', version: '3.0', exportedAt: new Date().toISOString(), data };
}

// JSON de dados (formato antigo, ainda usado pelo GET /api/admin/backup/data): as
// coleções da memória e os .md de content/. Sem as teclas (tabela própria): o JSON
// completo, com elas, é o buildFullDataSnapshot.
function buildDataSnapshot() {
    const snapshot = memorySnapshot();
    const content = {};
    if (fs.existsSync(CONTENT_DIR)) {
        fs.readdirSync(CONTENT_DIR).filter(filename => filename.endsWith('.md')).forEach(filename => {
            content[filename] = fs.readFileSync(path.join(CONTENT_DIR, filename), 'utf8');
        });
    }
    return { ...snapshot, content };
}

// JSON de dados com o histórico de digitação (examKeystrokes, pelo exportRows). Antes o
// "Baixar dados (JSON)" saía sem as teclas (CONF-07, OPS-04).
async function buildFullDataSnapshot() {
    const snapshot = buildDataSnapshot();
    snapshot.data.examKeystrokes = await db.keystrokes.exportRows();
    return snapshot;
}

// JSON do backup cortado ou corrompido (download pela metade, arquivo editado à mão):
// antes o SyntaxError chegava à tela em inglês ("Unterminated string in JSON at
// position 300"), sem código e sem registro.
function parseBackupJson(text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        if (error instanceof SyntaxError) throw backupRefusal('O arquivo de backup está corrompido ou incompleto e não pôde ser lido.');
        throw error;
    }
}

// Tipo e versão do JSON de dados e as regras de estrutura de cada coleção
// (utils/backupSchema.js, CONF-08). Devolve o snapshot; os avisos (que não bloqueiam)
// ficam em snapshot.warnings só para a prévia.
function validateDataSnapshot(snapshot) {
    if (!snapshot || snapshot.type !== 'iclass-backup-data' || !snapshot.data || typeof snapshot.data !== 'object' || Array.isArray(snapshot.data)) throw backupRefusal('Arquivo de backup inválido.');
    if (!String(snapshot.version || '').startsWith('3.')) throw backupRefusal('Versão de backup incompatível.');
    schema.validateBackupData(snapshot.data, BACKUP_TABLES);
    if (snapshot.content !== undefined && (!snapshot.content || typeof snapshot.content !== 'object' || Array.isArray(snapshot.content))) throw backupRefusal('Conteúdo Markdown inválido.');
    Object.keys(snapshot.content || {}).forEach(filename => {
        if (!/^[\w.\-() ]+\.md$/.test(filename)) throw backupRefusal(`Nome de conteúdo inválido: ${filename}`);
    });
    return snapshot;
}

function backupWarnings(snapshot) {
    try { return schema.validateBackupData(snapshot.data, BACKUP_TABLES).warnings; } catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// Gerar backup (ZIP formato 2)
// ---------------------------------------------------------------------------

async function newWorkDir(base = WORK_DIR) {
    await fs.promises.mkdir(base, { recursive: true });
    return fs.promises.mkdtemp(path.join(base, `${archive.backupStamp()}-`));
}

// Limpa as pastas de trabalho deixadas por uma execução interrompida (boot): a cópia do
// banco em .backup-trabalho e os envios e prévias em .restauracao (os tokens de prévia
// ficam na memória e não sobrevivem ao reinício). Também volta uma pasta que ficou só
// como "anterior" numa troca interrompida no meio (recoverInterruptedSwaps).
function cleanWorkDirs() {
    [WORK_DIR, RESTORE_DIR].forEach(dir => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { logError('limpeza da pasta de trabalho do backup', e); }
    });
    recoverInterruptedSwaps();
}

// Gera um backup formato 2 em `dir` (padrão data/backups) com o nome
// <origem>_<variante>_<carimbo>.zip e o .sha256 ao lado. keepDbCopy: devolve também a
// cópia do banco (dbCopy, em workDir), que quem chama apaga depois (a restauração a usa
// para desfazer as teclas). lock false: quem chama já tem a trava.
async function createBackup({ origem = 'manual', variante = 'dados', dir = BACKUPS_DIR, keepDbCopy = false, lock = true } = {}) {
    const run = async () => {
        const workDir = await newWorkDir();
        let keep = false;
        try {
            const now = new Date();
            const dbInfo = await db.snapshotTo(path.join(workDir, 'database.db'));
            const saved = await archive.saveBackupZip({ dir, name: archive.backupFileName(origem, variante, now), dbInfo, variante, origem, now });
            if (keepDbCopy) {
                keep = true;
                return { ...saved, dbCopy: dbInfo.file, workDir };
            }
            return saved;
        } finally {
            if (!keep) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    };
    return lock ? withBackupLock(origem, run) : run();
}

// Download do backup formato 2 direto para a resposta (GET /api/admin/backup/full), sem
// gravar o ZIP no servidor. variante 'completo' (com data/uploads) ou 'dados'. O nome da
// função continua o de antes (o teste de erro troca esta função).
async function streamFullZip(output, { variante = 'completo', origem = 'download' } = {}) {
    return withBackupLock('download', async () => {
        const workDir = await newWorkDir();
        try {
            const dbInfo = await db.snapshotTo(path.join(workDir, 'database.db'));
            return await archive.writeBackupZip(output, { dbInfo, variante, origem });
        } finally {
            await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    });
}

// Nome dos arquivos de backup no servidor: <grupo>[_<variante>]_<carimbo>.(zip|json).
// Os .json antigos e os .zip novos do mesmo grupo contam juntos na retenção.
function groupPattern(prefix) {
    const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}(?:_(dados|completo))?_(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z)\\.(zip|json)$`);
}

function groupFiles(prefix, dir = BACKUPS_DIR) {
    if (!fs.existsSync(dir)) return [];
    const pattern = groupPattern(prefix);
    return fs.readdirSync(dir)
        .map(name => ({ name, match: pattern.exec(name) }))
        .filter(item => item.match)
        .sort((a, b) => (a.match[2] < b.match[2] ? 1 : a.match[2] > b.match[2] ? -1 : 0));
}

// Guarda os `keep` mais recentes do grupo (pelo carimbo do nome) e apaga os mais antigos
// com o .sha256 deles. O mais recente nunca sai; arquivo fora do padrão nunca é tocado.
function pruneBackups(prefix, keep, dir = BACKUPS_DIR) {
    const limit = Math.max(1, Math.floor(Number(keep)) || 1);
    const removed = [];
    groupFiles(prefix, dir).slice(limit).forEach(item => {
        try {
            fs.rmSync(path.join(dir, item.name), { force: true });
            fs.rmSync(path.join(dir, `${item.name}.sha256`), { force: true });
            removed.push(item.name);
        } catch (e) {}
    });
    return removed;
}

// Backup automático dos dados (ZIP formato 2, variante dados) em data/backups com
// retenção: guarda os `keep` mais recentes do prefixo (contando os JSON antigos). Antes
// era o JSON do banco inteiro, sem as teclas, gravado de forma síncrona (o servidor parava
// segundos num banco de um ano). Devolve o caminho do arquivo.
async function runAutomaticBackup({ prefix = 'automatico', keep = 14 } = {}) {
    const saved = await createBackup({ origem: prefix, variante: 'dados' });
    pruneBackups(prefix, keep);
    return saved.file;
}

function lastAutomaticBackupAt(prefix = 'automatico') {
    const times = groupFiles(prefix).map(item => {
        try { return fs.statSync(path.join(BACKUPS_DIR, item.name)).mtimeMs; } catch (e) { return 0; }
    });
    return times.length ? Math.max(...times) : null;
}

// Backup de segurança antes de uma ação destrutiva (limpar estado de prova, resetar sala):
// ZIP formato 2 dos dados, gerado sem travar o servidor. Rejeita se não deu para gravar;
// a rota responde 503 e não apaga nada.
async function createSafetyBackup(prefix) {
    const saved = await createBackup({ origem: prefix, variante: 'dados' });
    return saved;
}

// ZIP formato 1 (backup-data.json + pastas) pelo adm-zip, como o IClass gerava antes do
// H4a: só para os testes de compatibilidade e de detecção em /uploads.
function buildFullZipBuffer() {
    const AdmZip = getZipLib();
    if (!AdmZip) return null;
    const zip = new AdmZip();
    zip.addFile('backup-data.json', Buffer.from(JSON.stringify(buildDataSnapshot()), 'utf8'));
    if (fs.existsSync(CONTENT_DIR)) zip.addLocalFolder(CONTENT_DIR, 'content');
    if (fs.existsSync(runtimePaths.UPLOADS_DIR)) zip.addLocalFolder(runtimePaths.UPLOADS_DIR, 'data/uploads');
    if (fs.existsSync(runtimePaths.STUDENTS_DIR)) zip.addLocalFolder(runtimePaths.STUDENTS_DIR, 'data/alunos');
    return zip.toBuffer();
}

// ---------------------------------------------------------------------------
// Restaurar
// ---------------------------------------------------------------------------

// SEG-X1: contas de acesso (administradores e professores) só são trocadas pela
// restauração quando um administrador pede isso explicitamente. Nesse caso o backup
// precisa ter ao menos um administrador e nenhuma senha em texto puro (um JSON editado
// à mão não pode criar ou promover conta).
function validateRestoredAccounts(snapshot) {
    const admins = snapshot && snapshot.data ? snapshot.data.admins : undefined;
    if (admins === undefined) return;
    if (!Array.isArray(admins)) throw backupRefusal('Contas de acesso inválidas no backup.');
    const plain = admins.find(account => !account || !account.email || !db.isHashed(account.password));
    if (plain) throw backupRefusal(`O backup traz a conta ${(plain && plain.email) || 'sem e-mail'} sem senha protegida (texto puro). Restaure sem substituir as contas.`);
    if (!admins.some(account => account.role !== 'professor')) throw backupRefusal('O backup não tem nenhuma conta de administrador. Restaure sem substituir as contas.');
}

// O que foi restaurado, para o registro de auditoria e para a tela avisar das contas
// do backup que ficaram de fora (instalação nova, troca de computador).
function snapshotSummary(snapshot, format) {
    const data = (snapshot && snapshot.data) || {};
    return {
        format,
        exportedAt: String((snapshot && snapshot.exportedAt) || ''),
        version: String((snapshot && snapshot.version) || ''),
        collections: COLLECTIONS.filter(key => data[key] !== undefined),
        legacyApplications: hasLegacyApplications(snapshot),
        accountEmails: Array.isArray(data.admins)
            ? data.admins.map(account => String((account && account.email) || '').trim().toLowerCase()).filter(Boolean)
            : [],
    };
}

// Junta uma lista do backup com a atual pela chave do registro (key): a linha do backup
// vence quando a chave é a mesma, e as atuais que o backup não tem continuam (na ordem
// de antes, depois das do backup). Linha sem chave fica como veio.
function mergeRowsByKey(entry, restored, current) {
    if (!Array.isArray(restored)) return Array.isArray(current) ? current.slice() : current;
    const keyOf = typeof entry.key === 'function' ? entry.key : row => (row && typeof row === 'object' ? row[entry.key] : undefined);
    const known = new Set(restored.map(row => keyOf(row)).filter(key => key !== undefined && key !== null && key !== '').map(String));
    const extra = (Array.isArray(current) ? current : []).filter(row => {
        const key = keyOf(row);
        return key === undefined || key === null || key === '' || !known.has(String(key));
    });
    return [...restored, ...extra];
}

// Valor restaurado de uma coleção que veio no backup, conforme o modo dela no registro:
// - 'replace' e 'keep': o backup substitui a atual;
// - 'merge': o backup junta com a atual. A auditoria passa por mergeAuditTrails
//   (utils/audit.js): todas as entradas do backup (a do backup vence no mesmo id) mais as
//   atuais que o backup não tem, em ordem de hora. Restaurar dados não apaga o registro de
//   quem fez o quê depois do backup (FUN-03, CONF-09), e por isso o grade_restore deixa
//   de valer na lixeira de notas quando há restauração de backup depois dele
//   (gradeTrashIndex em routes/admin.js). Outra coleção em 'merge' (Termos e Privacidade)
//   junta pela chave do registro;
// - 'reset': volta vazia.
// exact: a volta ao estado de antes quando a restauração falha no meio. Aí tudo é
// substituído pela cópia tirada antes, inclusive a auditoria (juntar traria de volta as
// entradas do backup que acabou de ser recusado).
function restoredCollectionValue(entry, restored, { exact = false } = {}) {
    if (entry.restore === 'reset') return db.emptyCollectionValue(entry);
    if (entry.restore === 'merge' && !exact) {
        const current = db.memory[entry.collection];
        const value = entry.collection === 'auditLogs'
            ? mergeAuditTrails(restored, current)
            : mergeRowsByKey(entry, restored, current);
        return structuredClone(value);
    }
    return structuredClone(restored);
}

// O que acontece com a coleção que FALTA no backup (laço genérico por modo do registro,
// H4a, CONF-07): 'replace' fica vazia (a restauração substitui tudo, como a tela promete;
// antes a atual ficava e misturava, por exemplo, as presenças antigas com as novas);
// 'keep' (config, identidade visual, estrutura antiga) e 'merge' (auditoria, Termos)
// ficam como estão. Exceções: as contas de acesso ficam (só mudam com replaceAccounts e
// se o backup as traz) e as aplicações de prova seguem o caminho de versão anterior
// (refeitas a partir das turmas do backup).
function missingCollectionOutcome(entry) {
    if (entry.collection === 'admins' || entry.collection === 'examApplications') return 'keep';
    if (entry.restore === 'keep' || entry.restore === 'merge') return 'keep';
    return 'empty';
}

// Aplica as coleções da memória do snapshot pelo modo de cada uma, roda os ganchos
// pós-restauração (db.afterRestore: sessões zeradas, senhas antigas protegidas, regra de
// rede e configuração protegida de agora) e grava. As teclas (kind 'store') não passam
// por aqui: quem chama as troca antes (importRows ou copyFromAttached).
async function applySnapshot(snapshot, { replaceAccounts = false, exact = false } = {}) {
    validateDataSnapshot(snapshot);
    // A regra de rede e a configuração protegida de agora, lidas antes do laço: os ganchos
    // 'networkSettings' e 'protectedConfig' as põem de volta depois (decisões §7). Na volta
    // exata (exact) a cópia de antes já as traz.
    const restoreContext = {
        keepNetwork: !exact,
        previousNetwork: db.currentNetworkSettings(db.memory),
        keepProtectedConfig: !exact,
        previousProtectedConfig: db.currentProtectedConfig(db.memory),
    };
    db.COLLECTION_TABLES.forEach(entry => {
        // Tabela derivada (auth_sessions) não tem valor próprio na memória nem no backup:
        // ela sai do que outras coleções guardam, e quem zera esse conteúdo é o gancho dela
        // em db.afterRestore, depois do laço. As teclas (store) ficam fora da memória.
        if (entry.kind === 'derived' || STORE_COLLECTIONS.has(entry.collection)) return;
        if (entry.restore === 'reset') {
            db.memory[entry.collection] = restoredCollectionValue(entry);
            return;
        }
        if (!COLLECTIONS.includes(entry.collection)) return;
        // Contas de acesso só com o pedido explícito do administrador (SEG-X1).
        if (entry.collection === 'admins' && !replaceAccounts) return;
        const value = snapshot.data[entry.collection];
        if (value === undefined) {
            if (exact || missingCollectionOutcome(entry) === 'keep') return;
            db.memory[entry.collection] = db.emptyCollectionValue(entry);
            return;
        }
        db.memory[entry.collection] = restoredCollectionValue(entry, value, { exact });
    });
    // Backups antigos podem trazer `studentClass` em objeto (DES-03).
    (db.memory.students || []).forEach(student => normalizeStoredStudentClasses(student));
    // Backup de versão anterior: aplicações refeitas a partir das turmas restauradas,
    // pelo mesmo caminho do boot para dados antigos (database.js).
    // A prova pausada no backup fica pausada desde o momento dele (exportedAt).
    const backupAt = Date.parse(String(snapshot.exportedAt || '')) || null;
    const applications = hasLegacyApplications(snapshot) ? db.rebuildExamApplicationsFromClasses({ backupAt }) : null;
    // Ganchos pós-restauração (database.js AFTER_RESTORE_HOOKS), com a memória já
    // restaurada, em todos os formatos (JSON, ZIP formato 1 e formato 2). Restaurar
    // desconecta todos (sessões não vão no backup): o gancho 'authSessions' zera as
    // sessões, e a gravação esvazia a tabela auth_sessions; o 'legacyPasswordHashes' troca
    // os hashes SHA-256 antigos do backup por scrypt-sha256$ antes da gravação (H5a,
    // SEG-X2), como no boot; o 'networkSettings' mantém a regra de rede de agora
    // (settings.network, decisões §7); o 'protectedConfig' mantém settings.backup e o
    // segredo das alternativas da prova quando o do backup falta.
    await db.runAfterRestore(db.memory, restoreContext);
    await db.save();
    return applications;
}

function withApplications(summary, applications) {
    if (!applications) return summary;
    return { ...summary, applicationsDiscarded: applications.discarded, applicationsRebuilt: applications.rebuilt };
}

// Backup de versão anterior só é restaurado depois de o administrador ver o aviso do
// que acontece com as aplicações de prova (acceptLegacy). Sem isso, nada muda: a tela
// mostra o aviso e manda de novo com a confirmação.
function legacyBackupError(snapshot) {
    return Object.assign(new Error(LEGACY_BACKUP_WARNING), {
        legacyBackup: true,
        exportedAt: String((snapshot && snapshot.exportedAt) || ''),
    });
}

// --- troca das pastas -------------------------------------------------------

function folderTarget(prefix) {
    if (prefix === 'content') return CONTENT_DIR;
    if (prefix === 'data/uploads') return runtimePaths.UPLOADS_DIR;
    if (prefix === 'data/alunos') return runtimePaths.STUDENTS_DIR;
    if (prefix === 'cursos_arquivados') return runtimePaths.ARCHIVE_DIR;
    throw new Error(`Pasta de backup desconhecida: ${prefix}`);
}

const SWAP_PREFIX = '.iclass-restauracao-';

// Cópia recursiva (quando o rename não serve: pasta em outro disco, EXDEV).
async function copyDirRecursive(from, to) {
    await fs.promises.mkdir(to, { recursive: true });
    for (const item of await fs.promises.readdir(from, { withFileTypes: true })) {
        const source = path.join(from, item.name);
        const target = path.join(to, item.name);
        if (item.isDirectory()) await copyDirRecursive(source, target);
        else if (item.isFile()) await fs.promises.copyFile(source, target);
    }
}

async function moveDir(from, to) {
    try {
        await archive.renameWithRetry(from, to);
    } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await copyDirRecursive(from, to);
        await fs.promises.rm(from, { recursive: true, force: true });
    }
}

// Troca a pasta de destino pela do backup sem nunca ficar sem nenhuma das duas: a do
// backup vai primeiro para <pasta-mãe>/.iclass-restauracao-<id>/novo (mesmo disco do
// destino: o rename não dá EXDEV), a atual para .../anterior e a nova para o lugar.
// A anterior só é apagada depois de a restauração inteira dar certo (finishSwaps).
async function swapFolder(staged, target, id) {
    const prep = path.join(path.dirname(target), `${SWAP_PREFIX}${id}`);
    await fs.promises.rm(prep, { recursive: true, force: true });
    await fs.promises.mkdir(prep, { recursive: true });
    const fresh = path.join(prep, 'novo');
    const previous = path.join(prep, 'anterior');
    if (fs.existsSync(staged)) await moveDir(staged, fresh);
    else await fs.promises.mkdir(fresh, { recursive: true });
    const swap = { target, prep, previous, hadPrevious: fs.existsSync(target) };
    if (swap.hadPrevious) await archive.renameWithRetry(target, previous);
    try {
        await archive.renameWithRetry(fresh, target);
    } catch (err) {
        if (swap.hadPrevious) await archive.renameWithRetry(previous, target).catch(() => {});
        throw err;
    }
    return swap;
}

async function undoSwap(swap) {
    try {
        await fs.promises.rm(swap.target, { recursive: true, force: true });
        if (swap.hadPrevious && fs.existsSync(swap.previous)) await archive.renameWithRetry(swap.previous, swap.target);
        await fs.promises.rm(swap.prep, { recursive: true, force: true });
    } catch (err) {
        logError('restauração: volta de uma pasta trocada', err, { details: { pasta: swap.target } });
    }
}

async function finishSwap(swap) {
    await fs.promises.rm(swap.prep, { recursive: true, force: true }).catch(() => {});
}

// Troca interrompida no meio (o processo caiu entre mover a pasta atual e pôr a nova no
// lugar): no boot, a pasta que ficou só como "anterior" volta para o lugar. Uma troca
// completa deixa a pasta anterior guardada ao lado (nunca é apagada aqui).
function recoverInterruptedSwaps() {
    ['content', 'data/uploads', 'data/alunos', 'cursos_arquivados'].forEach(prefix => {
        const target = folderTarget(prefix);
        const parent = path.dirname(target);
        let names = [];
        try { names = fs.readdirSync(parent).filter(name => name.startsWith(SWAP_PREFIX)); } catch (e) { return; }
        names.forEach(name => {
            const previous = path.join(parent, name, 'anterior');
            try {
                if (!fs.existsSync(target) && fs.existsSync(previous)) {
                    fs.renameSync(previous, target);
                    console.warn(`⚠️ Restauração interrompida: a pasta ${target} voltou ao que era antes.`);
                }
                if (!fs.existsSync(previous)) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
            } catch (e) {
                logError('restauração interrompida: volta da pasta', e, { details: { pasta: target } });
            }
        });
    });
}

// Cursos arquivados (histórico só de acréscimo): as pastas do backup que não existem são
// acrescentadas; nenhuma é apagada nem trocada. Devolve as pastas acrescentadas.
async function mergeArchiveFolders(staged) {
    const added = [];
    if (!fs.existsSync(staged)) return added;
    const target = runtimePaths.ARCHIVE_DIR;
    await fs.promises.mkdir(target, { recursive: true });
    for (const item of await fs.promises.readdir(staged, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const destination = path.join(target, item.name);
        if (fs.existsSync(destination)) continue;
        await moveDir(path.join(staged, item.name), destination);
        added.push(destination);
    }
    return added;
}

// --- aplicação --------------------------------------------------------------

// Restauração em si, com o que já foi conferido: as pastas do backup (troca e cursos
// arquivados), os .md do JSON, as teclas e as coleções da memória. Falha no meio desfaz
// tudo: as pastas voltam, a memória volta à cópia de antes (exact) e as teclas voltam da
// cópia do banco tirada antes (rollbackDb).
// - stagingRoot + inclui: pastas extraídas que substituem as atuais;
// - contentMd: os .md do JSON (só acrescentam ou trocam arquivos);
// - keystrokes: { mode: 'copy', file } (formato 2) ou { mode: 'import', rows } (JSON).
async function applyRestore({ snapshot, format, stagingRoot = null, inclui = [], mergeArchives = false, contentMd = null, keystrokes, replaceAccounts = false, rollbackDb = null }) {
    const previous = memorySnapshot();
    const id = crypto.randomBytes(6).toString('hex');
    const swaps = [];
    const writtenMd = [];
    const addedArchives = [];
    try {
        if (contentMd) {
            await fs.promises.mkdir(CONTENT_DIR, { recursive: true });
            for (const [filename, value] of Object.entries(contentMd)) {
                const target = resolveInside(CONTENT_DIR, filename);
                const temporary = `${target}.restore-${process.pid}-${Date.now()}`;
                await fs.promises.writeFile(temporary, String(value), 'utf8');
                writtenMd.push({ target, temporary, previous: fs.existsSync(target) ? await fs.promises.readFile(target) : null });
            }
            for (const file of writtenMd) await fs.promises.rename(file.temporary, file.target);
        }
        for (const prefix of inclui) {
            if (prefix === 'cursos_arquivados') continue;
            swaps.push(await swapFolder(path.join(stagingRoot, ...prefix.split('/')), folderTarget(prefix), id));
        }
        if (mergeArchives && stagingRoot) addedArchives.push(...await mergeArchiveFolders(path.join(stagingRoot, 'cursos_arquivados')));
        let imported = Promise.resolve();
        if (keystrokes && keystrokes.mode === 'copy') {
            await db.keystrokes.copyFromAttached(keystrokes.file, { replace: true });
        } else if (keystrokes && keystrokes.mode === 'import') {
            // Entra na mesma transação da gravação das coleções (db.save do applySnapshot).
            imported = db.keystrokes.importRows(keystrokes.rows || [], { replace: true });
        }
        const applications = await applySnapshot(snapshot, { replaceAccounts });
        await imported;
        for (const swap of swaps) await finishSwap(swap);
        return withApplications(snapshotSummary(snapshot, format), applications);
    } catch (error) {
        for (const file of writtenMd) {
            try {
                if (fs.existsSync(file.temporary)) fs.rmSync(file.temporary, { force: true });
                if (file.previous === null) fs.rmSync(file.target, { force: true });
                else fs.writeFileSync(file.target, file.previous);
            } catch (e) {}
        }
        for (const swap of swaps.reverse()) await undoSwap(swap);
        for (const added of addedArchives) await fs.promises.rm(added, { recursive: true, force: true }).catch(() => {});
        await applySnapshot(previous, { replaceAccounts: true, exact: true }).catch(err => logError('restauração: volta da memória', err));
        if (rollbackDb) {
            await db.keystrokes.copyFromAttached(rollbackDb, { replace: true }).catch(err => logError('restauração: volta do histórico de digitação', err));
        }
        throw error;
    }
}

// Restauração de um snapshot JSON já na memória (programática; a tela passa pela prévia).
async function restoreDataSnapshot(snapshot, { replaceAccounts = false } = {}) {
    validateDataSnapshot(snapshot);
    if (replaceAccounts) validateRestoredAccounts(snapshot);
    return withBackupLock('restore', async () => {
        const workDir = await newWorkDir();
        try {
            const before = await db.snapshotTo(path.join(workDir, 'antes.db'));
            return await applyRestore({
                snapshot,
                format: 'json',
                contentMd: snapshot.content || null,
                keystrokes: { mode: 'import', rows: Array.isArray(snapshot.data.examKeystrokes) ? snapshot.data.examKeystrokes : [] },
                replaceAccounts,
                rollbackDb: before.file,
            });
        } finally {
            await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    });
}

// --- prévia -----------------------------------------------------------------

function countValue(entry, value) {
    if (value === undefined || value === null) return null;
    if (entry.kind === 'array' || entry.kind === 'store') return Array.isArray(value) ? value.length : 0;
    if (entry.kind === 'object') return typeof value === 'object' ? Object.keys(value).length : 0;
    if (entry.kind === 'singleton') return 1;
    return null;
}

function currentCount(entry) {
    if (entry.kind === 'store') return db.keystrokes.total();
    return countValue(entry, db.memory[entry.collection]) || 0;
}

// Alunos anonimizados agora (anonymizedAt, H7c) que o backup traz ainda com os dados
// pessoais (decisões do coordenador §3): o aluno anonimizado não está no backup com o
// mesmo pseudônimo (anonymizedRef ou e-mail anonimizado). Backup sem a coleção de alunos
// não traz ninguém de volta.
function anonymizedReturning(backupStudents) {
    if (!Array.isArray(backupStudents)) return 0;
    const backupRefs = new Set();
    const backupEmails = new Set();
    backupStudents.forEach(student => {
        if (!student || !student.anonymizedAt) return;
        if (student.anonymizedRef) backupRefs.add(String(student.anonymizedRef));
        if (student.email) backupEmails.add(String(student.email).trim().toLowerCase());
    });
    return (db.memory.students || []).filter(student => student && student.anonymizedAt
        && !(student.anonymizedRef && backupRefs.has(String(student.anonymizedRef)))
        && !backupEmails.has(String(student.email || '').trim().toLowerCase())).length;
}

function anonymizedNotice(count) {
    if (!count) return '';
    return count === 1
        ? '1 aluno anonimizado depois deste backup voltará com dados pessoais.'
        : `${count} alunos anonimizados depois deste backup voltarão com dados pessoais.`;
}

function activeApplicationsNow() {
    const { ACTIVE_APPLICATION_STATUSES } = require('./examApplications.js');
    return (db.memory.examApplications || [])
        .filter(item => item && ACTIVE_APPLICATION_STATUSES.has(item.status))
        .map(item => ({ id: item.id, examKey: item.examKey, studentClass: item.studentClass, courseId: item.courseId, status: item.status }));
}

// O que a prévia mostra antes de qualquer mudança (CONF-08, CONF-11): o backup ao lado de
// hoje por coleção, o que ficará vazio, as pastas trocadas, as contas, as provas em
// andamento, os avisos e a conferência de integridade.
function buildPreview(prepared, snapshot) {
    const data = snapshot.data || {};
    const contagens = BACKUP_TABLES.map(entry => {
        const backup = entry.kind === 'store'
            ? (prepared.keystrokesInBackup === undefined ? countValue(entry, data[entry.collection]) : prepared.keystrokesInBackup)
            : countValue(entry, data[entry.collection]);
        return { colecao: entry.collection, rotulo: collectionLabel(entry.collection), backup, atual: currentCount(entry) };
    });
    const ficaraoVazias = contagens.filter(item => {
        const entry = BACKUP_TABLES.find(table => table.collection === item.colecao);
        return item.backup === null && item.atual > 0 && missingCollectionOutcome(entry) === 'empty';
    }).map(item => ({ colecao: item.colecao, rotulo: item.rotulo, atual: item.atual }));
    const here = new Set((db.memory.admins || []).map(account => String((account && account.email) || '').toLowerCase()));
    const backupAccounts = Array.isArray(data.admins) ? data.admins : [];
    const anonymized = anonymizedReturning(data.students);
    const legacy = hasLegacyApplications(snapshot);
    return {
        formato: prepared.formato,
        variante: prepared.variante || null,
        geradoEm: prepared.geradoEm || String(snapshot.exportedAt || ''),
        versaoApp: prepared.versaoApp || null,
        computador: prepared.computador || null,
        contagens,
        arquivos: prepared.arquivos,
        ficaraoVazias,
        legado: legacy ? { aviso: LEGACY_BACKUP_WARNING } : null,
        contas: {
            noBackup: backupAccounts.length,
            foraDaqui: backupAccounts.filter(account => account && account.email && !here.has(String(account.email).toLowerCase())).length,
        },
        provasEmAndamento: activeApplicationsNow(),
        anonimizados: { quantidade: anonymized, aviso: anonymizedNotice(anonymized) },
        avisos: [...prepared.warnings, ...(anonymized ? [anonymizedNotice(anonymized)] : [])],
        integridade: prepared.formato === 'zip-2'
            ? { verificada: true, texto: 'Soma de verificação (SHA-256), integridade do banco e contagens conferidas.' }
            : { verificada: false, texto: 'sem soma de verificação (formato antigo)' },
        redeMantida: true,
    };
}

// Lê o banco que veio no backup formato 2 (só leitura) pelo mesmo caminho do boot.
async function readBackupDatabase(file) {
    const connection = await dbFile.openDatabaseFile(file, { readOnly: true });
    try {
        const stored = await db.readStoredData(connection);
        const data = {};
        Object.entries(stored.memory).forEach(([collection, value]) => {
            if (!stored.absent.has(collection)) data[collection] = value;
        });
        let unreadable = 0;
        stored.unreadable.forEach(keys => { unreadable += keys.length; });
        return { data, unreadable };
    } finally {
        await dbFile.closeDatabaseFile(connection);
    }
}

function keystrokeCountFromTables(tables) {
    return (Number(tables[KEYSTROKE_TABLE]) || 0) + (Number(tables[LEGACY_KEYSTROKE_TABLE]) || 0);
}

// Snapshot (formato da memória) do backup preparado: o JSON relido ou o banco do ZIP.
async function loadPreparedSnapshot(prepared) {
    if (prepared.formato === 'zip-2') {
        const { data, unreadable } = await readBackupDatabase(prepared.dbFile);
        return { snapshot: { type: 'iclass-backup-data', version: '3.0', exportedAt: prepared.geradoEm, data }, unreadable };
    }
    const snapshot = await archive.readJsonFile(prepared.jsonFile, parseBackupJson);
    return { snapshot, unreadable: 0 };
}

async function fileHead(file, length = 8) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

function countStagedFiles(stagingRoot, prefixes) {
    let quantidade = 0;
    let bytes = 0;
    const walk = dir => {
        let items = [];
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        items.forEach(item => {
            const abs = path.join(dir, item.name);
            if (item.isDirectory()) walk(abs);
            else if (item.isFile()) { quantidade += 1; try { bytes += fs.statSync(abs).size; } catch (e) {} }
        });
    };
    prefixes.forEach(prefix => walk(path.join(stagingRoot, ...prefix.split('/'))));
    return { quantidade, bytes };
}

// Extrai e confere o arquivo enviado (JSON, ZIP formato 1 ou formato 2) numa pasta só
// dele em DATA_DIR/.restauracao, sem mudar nada nos dados. O arquivo enviado sai daqui
// (apagado ou movido para a pasta da prévia). Devolve { prepared, preview }; quem chama
// guarda prepared (token) e apaga a pasta quando terminar (discardPrepared).
async function prepareRestore(uploadedFile, { originalName = '' } = {}) {
    const id = crypto.randomBytes(12).toString('hex');
    const stagingDir = path.join(RESTORE_DIR, id);
    const prepared = { id, stagingDir, originalName: String(originalName || '').slice(0, 200), warnings: [] };
    try {
        await fs.promises.mkdir(stagingDir, { recursive: true });
        const head = await fileHead(uploadedFile, 4);
        const isZip = head.subarray(0, 2).toString('latin1') === 'PK' || /\.zip$/i.test(originalName || '');
        let snapshot;
        if (isZip) {
            const extracted = await archive.extractBackupZip(uploadedFile, path.join(stagingDir, 'arquivo'));
            await fs.promises.rm(uploadedFile, { force: true });
            prepared.stagingRoot = path.join(stagingDir, 'arquivo');
            prepared.formato = extracted.layout;
            if (extracted.layout === 'zip-2') {
                const manifest = schema.validateManifest(await archive.readJsonFile(path.join(prepared.stagingRoot, archive.MANIFEST_ENTRY), text => {
                    try { return JSON.parse(text); } catch (e) { throw backupRefusal('Backup inválido: o manifesto iclass-backup.json está ilegível.'); }
                }));
                prepared.dbFile = path.join(prepared.stagingRoot, ...archive.DB_ENTRY.split('/'));
                let info;
                try {
                    info = await dbFile.inspectDatabaseFile(prepared.dbFile);
                } catch (err) {
                    if (err && err.code === 'ICLASS_DB_CORRUPT') throw backupRefusal('Backup inválido: o banco de dados dentro do ZIP está danificado.');
                    throw err;
                }
                schema.compareManifestWithDatabase(manifest, info);
                prepared.manifest = manifest;
                prepared.variante = manifest.variante || null;
                prepared.geradoEm = String(manifest.geradoEm || '');
                prepared.versaoApp = manifest.versaoApp || null;
                prepared.computador = manifest.computador || null;
                prepared.inclui = (Array.isArray(manifest.inclui) ? manifest.inclui : []).filter(prefix => archive.FOLDER_PREFIXES.includes(prefix));
                prepared.keystrokesInBackup = keystrokeCountFromTables(info.tabelas);
            } else {
                prepared.jsonFile = path.join(prepared.stagingRoot, archive.LEGACY_DATA_ENTRY);
                // O formato 1 sempre trocava as três pastas, mesmo as que vinham vazias.
                prepared.inclui = ['content', 'data/uploads', 'data/alunos'];
                prepared.variante = 'completo';
            }
        } else {
            prepared.formato = 'json';
            prepared.jsonFile = path.join(stagingDir, archive.LEGACY_DATA_ENTRY);
            await fs.promises.rename(uploadedFile, prepared.jsonFile);
            prepared.inclui = [];
            prepared.variante = 'dados';
        }
        const loaded = await loadPreparedSnapshot(prepared);
        snapshot = validateDataSnapshot(loaded.snapshot);
        if (prepared.formato !== 'zip-2') prepared.geradoEm = String(snapshot.exportedAt || '');
        prepared.warnings = backupWarnings(snapshot);
        if (loaded.unreadable) prepared.warnings.push(`${loaded.unreadable} registro(s) ilegível(is) no banco do backup ficam de fora.`);
        prepared.legacy = hasLegacyApplications(snapshot);
        prepared.arquivos = {
            inclui: prepared.inclui,
            ...(prepared.formato === 'json' ? { quantidade: Object.keys(snapshot.content || {}).length, bytes: 0 } : countStagedFiles(prepared.stagingRoot, prepared.inclui)),
        };
        return { prepared, preview: buildPreview(prepared, snapshot) };
    } catch (error) {
        await fs.promises.rm(uploadedFile, { force: true }).catch(() => {});
        await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

async function discardPrepared(prepared) {
    if (!prepared || !prepared.stagingDir) return;
    await fs.promises.rm(prepared.stagingDir, { recursive: true, force: true }).catch(() => {});
}

function safetyBackupError(cause) {
    return Object.assign(new Error(SAFETY_BACKUP_FAILED_MESSAGE), { code: 'ICLASS_SAFETY_BACKUP', cause });
}

// Restaura o backup já conferido pela prévia: confere de novo, faz o backup de segurança
// (seguranca-restauracao_<variante>_*.zip, com data/uploads quando o backup traz a
// biblioteca; se ele falhar, nada muda) e aplica. A pasta da prévia sai no fim, com ou
// sem sucesso.
async function applyPreparedRestore(prepared, { replaceAccounts = false, acceptLegacy = false } = {}) {
    try {
        return await withBackupLock('restore', async () => {
            const { snapshot } = await loadPreparedSnapshot(prepared);
            validateDataSnapshot(snapshot);
            if (replaceAccounts) validateRestoredAccounts(snapshot);
            if (hasLegacyApplications(snapshot) && !acceptLegacy) throw legacyBackupError(snapshot);
            let safety;
            try {
                safety = await createBackup({
                    origem: 'seguranca-restauracao',
                    variante: (prepared.inclui || []).includes('data/uploads') ? 'completo' : 'dados',
                    keepDbCopy: true,
                    lock: false,
                });
            } catch (err) {
                throw safetyBackupError(err);
            }
            try {
                const isDb = prepared.formato === 'zip-2';
                const summary = await applyRestore({
                    snapshot,
                    format: prepared.formato === 'json' ? 'json' : 'zip',
                    stagingRoot: prepared.stagingRoot || null,
                    inclui: prepared.inclui || [],
                    mergeArchives: isDb && (prepared.inclui || []).includes('cursos_arquivados'),
                    contentMd: prepared.formato === 'json' ? (snapshot.content || null) : null,
                    keystrokes: isDb
                        ? { mode: 'copy', file: prepared.dbFile }
                        : { mode: 'import', rows: Array.isArray(snapshot.data.examKeystrokes) ? snapshot.data.examKeystrokes : [] },
                    replaceAccounts,
                    rollbackDb: safety.dbCopy,
                });
                return { ok: true, replaceAccounts, safetyBackup: safety.name, formato: prepared.formato, ...summary };
            } finally {
                await fs.promises.rm(safety.workDir, { recursive: true, force: true }).catch(() => {});
            }
        });
    } finally {
        await discardPrepared(prepared);
    }
}

// Envio único (o contrato de antes: arquivo, confirm e acceptLegacy no mesmo pedido).
async function restoreFromFile(absPath, originalName, { replaceAccounts = false, acceptLegacy = false } = {}) {
    if (activeJob) throw backupBusyError();
    const { prepared } = await prepareRestore(absPath, { originalName });
    return applyPreparedRestore(prepared, { replaceAccounts, acceptLegacy });
}

// --- tokens da prévia -------------------------------------------------------
// De uso único, valem 1 h, presos ao e-mail do administrador que fez a prévia e guardados
// só na memória. A pasta da prévia é apagada ao expirar (varredura de hora em hora) e no
// boot (cleanWorkDirs).
const RESTORE_TOKEN_TTL_MS = 60 * 60 * 1000;
const restoreTokens = new Map();

function normalizedEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function createRestoreToken(prepared, email, { now = Date.now() } = {}) {
    sweepRestoreTokens({ now });
    const token = crypto.randomBytes(24).toString('base64url');
    restoreTokens.set(token, { prepared, email: normalizedEmail(email), expiresAt: now + RESTORE_TOKEN_TTL_MS });
    return { token, expiraEm: new Date(now + RESTORE_TOKEN_TTL_MS).toISOString() };
}

// Devolve { prepared } e tira o token da lista; { error, status } quando não vale:
// 400 inexistente, já usado ou vencido; 403 de outro administrador (o token continua
// valendo para quem fez a prévia).
function takeRestoreToken(token, email, { now = Date.now() } = {}) {
    sweepRestoreTokens({ now });
    const key = String(token || '');
    const entry = key ? restoreTokens.get(key) : null;
    if (!entry) return { status: 400, error: 'A prévia desta restauração não vale mais (já usada ou vencida). Envie o arquivo de novo para conferir.' };
    if (entry.email !== normalizedEmail(email)) return { status: 403, error: 'Esta prévia foi feita por outro administrador. Envie o arquivo de novo para conferir.' };
    restoreTokens.delete(key);
    return { prepared: entry.prepared };
}

function sweepRestoreTokens({ now = Date.now() } = {}) {
    let removed = 0;
    for (const [token, entry] of [...restoreTokens]) {
        if (entry.expiresAt > now) continue;
        restoreTokens.delete(token);
        discardPrepared(entry.prepared);
        removed += 1;
    }
    return removed;
}

// SEG-X1: um .json/.zip em /uploads pode ser o banco inteiro (backup com os hashes
// das senhas), venha ele da lixeira, de um envio ou de um vínculo que o próprio
// professor criou na estrutura da turma. Por isso a decisão é pelo CONTEÚDO, não
// pelo vínculo nem pela extensão: marca do backup ("type": "iclass-backup-data"),
// hash de senha (scrypt$...) ou a tabela de contas do banco do iClass; um ZIP (pela
// assinatura, mesmo gravado como .json) com backup-data.json ou com um .json, um
// banco SQLite ou outro ZIP dentro que tenha essas marcas. Um banco .db/.sqlite de
// exemplo (material de aula) não é backup. O ZIP é lido aos pedaços, sem travar o
// servidor. Resultado em cache por caminho + data + tamanho.
const BACKUP_TEXT_MARKERS = [
    /"type"\s*:\s*"iclass-backup-data"/,
    // Manifesto do ZIP formato 2 (H4a): o banco vai dentro como data/database.db.
    /"type"\s*:\s*"iclass-backup-manifest"/,
    /scrypt\$[A-Za-z0-9+/=]{8,}\$/,
    // Esquema chave-valor do banco do iClass (database.js), como o SQLite o grava.
    /CREATE TABLE "?admins"? \(key TEXT PRIMARY KEY, value TEXT\)/,
];
const BACKUP_DATA_ENTRY = /(^|\/)(backup-data|iclass-backup)\.json$/i;
const ZIP_ENTRY_KIND_BY_NAME = [
    [/\.zip$/i, 'zip'],
    [/\.json$/i, 'text'],
    [/\.(?:db|db3|sqlite|sqlite3)$/i, 'text'],
];
// Arquivos de mídia comuns em material de aula: não são conferidos por dentro.
const MEDIA_ENTRY = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|tiff?|mp4|m4v|webm|mov|avi|mkv|mp3|wav|ogg|m4a|flac|pdf|ttf|otf|woff2?)$/i;
const BACKUP_SCAN_CHUNK = 1024 * 1024;
const BACKUP_SCAN_OVERLAP = 256;
// Total descomprimido conferido por arquivo (mídia não entra na conta).
const MAX_ZIP_SCAN_BYTES = MAX_UNCOMPRESSED_BYTES;
const MAX_NESTED_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_NESTED_ZIP_DEPTH = 2;
const MAX_SNIFFED_ZIP_ENTRIES = 1000;
const backupContentCache = new Map();

function textHasBackupMarker(text) {
    return BACKUP_TEXT_MARKERS.some(marker => marker.test(text));
}

// Procura as marcas em pedaços sucessivos (com sobreposição entre eles). Texto em
// UTF-16 (backup salvo pelo Bloco de Notas como "Unicode") tem um byte zero entre os
// caracteres ASCII: as marcas são procuradas também sem eles.
function backupMarkerScanner(extraLiterals = []) {
    let carry = '';
    const hasMarker = text => textHasBackupMarker(text) || extraLiterals.some(literal => text.includes(literal));
    return chunk => {
        // latin1 mantém um caractere por byte: as marcas são ASCII.
        const text = carry + (typeof chunk === 'string' ? chunk : chunk.toString('latin1'));
        if (hasMarker(text) || (text.includes('\0') && hasMarker(text.replace(/\0/g, '')))) return true;
        carry = text.slice(-BACKUP_SCAN_OVERLAP * 2);
        return false;
    };
}

const GZIP_MAGIC = head => !!head && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

async function fileHasBackupMarker(filePath, extraLiterals = []) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(BACKUP_SCAN_CHUNK);
        const scan = backupMarkerScanner(extraLiterals);
        let position = 0;
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, BACKUP_SCAN_CHUNK, position);
            if (!bytesRead) return false;
            position += bytesRead;
            if (scan(buffer.subarray(0, bytesRead))) return true;
        }
    } finally {
        await handle.close();
    }
}

// Tipo da entrada pelo conteúdo (para nomes que não dizem nada): ZIP, banco SQLite ou JSON.
function entryKindFromHead(head) {
    if (!head || !head.length) return null;
    if (zipInspect.hasZipMagic(head)) return 'zip';
    // Compactado com gzip (dados.json.gz, ou .bin/.json que é gzip por dentro).
    if (GZIP_MAGIC(head)) return 'gzip';
    if (head.toString('latin1', 0, 15) === 'SQLite format 3') return 'text';
    const first = head.toString('latin1').replace(/\0/g, '').replace(/^\uFEFF|^\xEF\xBB\xBF|^\xFF\xFE|^\xFE\xFF/, '').trimStart()[0];
    return first === '{' || first === '[' ? 'text' : null;
}

// true: backup (ou não dá para conferir uma entrada que poderia ser); false: não é;
// null: a fonte não é um ZIP legível. As entradas são lidas aos pedaços (sem limite
// de memória); `budget.left` limita o total descomprimido conferido (ZIP-bomba: na
// dúvida, só o administrador). ZIP dentro de ZIP (inclusive .docx/.pptx, que também
// são ZIP) é aberto na memória até MAX_NESTED_ZIP_BYTES e MAX_NESTED_ZIP_DEPTH níveis;
// além disso, os nomes das entradas internas são procurados nos bytes.
async function zipLooksLikeBackup(source, depth, budget) {
    const directory = await zipInspect.readZipDirectory(source);
    if (!directory) return null;
    let sniffed = 0;
    const scanEntry = async (entry, extraLiterals = [], { gunzip = false } = {}) => {
        const result = await zipInspect.scanZipEntry(source, directory, entry, backupMarkerScanner(extraLiterals), { maxBytes: budget.left, gunzip });
        if (result === 'done') budget.left -= entry.size;
        return result;
    };
    for (const entry of directory.entries) {
        if (BACKUP_DATA_ENTRY.test(entry.name)) return true;
        if (entry.isDirectory) continue;
        const byName = (ZIP_ENTRY_KIND_BY_NAME.find(([pattern]) => pattern.test(entry.name)) || [])[1] || null;
        let kind = byName;
        if (!kind) {
            if (MEDIA_ENTRY.test(entry.name) || sniffed >= MAX_SNIFFED_ZIP_ENTRIES) continue;
            sniffed += 1;
            kind = entryKindFromHead(await zipInspect.readZipEntryHead(source, directory, entry, 16));
            if (!kind) continue;
        } else if (kind === 'text' && GZIP_MAGIC(await zipInspect.readZipEntryHead(source, directory, entry, 2))) {
            kind = 'gzip'; // .json/.db que na verdade é gzip
        }
        if (kind === 'gzip') {
            // Descompacta aos pedaços (com o mesmo limite total) e procura as marcas e o
            // nome do backup (um .tar.gz guarda os nomes sem compressão por dentro).
            // gzip que não abre: na dúvida, só o administrador.
            const result = await scanEntry(entry, ['backup-data.json'], { gunzip: true });
            if (result !== 'done') return true;
            continue;
        }
        if (kind === 'zip') {
            const fitsInMemory = depth < MAX_NESTED_ZIP_DEPTH && entry.size <= MAX_NESTED_ZIP_BYTES && entry.size <= budget.left;
            const buffer = fitsInMemory ? await zipInspect.readZipEntryBuffer(source, directory, entry, Math.min(MAX_NESTED_ZIP_BYTES, budget.left)) : null;
            if (buffer) {
                budget.left -= buffer.length;
                const nested = await zipLooksLikeBackup(zipInspect.bufferSource(buffer), depth + 1, budget);
                if (nested === true) return true;
                if (nested === null && backupMarkerScanner(['backup-data.json'])(buffer)) return true;
                continue;
            }
            // ZIP interno grande ou fundo demais: os nomes das entradas dele ficam sem
            // compressão nos bytes descomprimidos desta entrada.
            const result = await scanEntry(entry, ['backup-data.json']);
            if (result === 'found' || result === 'limit') return true;
            if (result === null && byName) return true; // .zip que não dá para ler
            continue;
        }
        // JSON ou banco SQLite: confere o conteúdo inteiro. Cifrado ou ilegível: na
        // dúvida, só o administrador.
        const result = await scanEntry(entry);
        if (result !== 'done') return true;
    }
    return false;
}

async function inspectBackupFile(filePath, stat) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const source = zipInspect.fileSource(filePath, handle, stat.size);
        const head = await source.read(0, 4);
        const zipByName = path.extname(filePath).toLowerCase() === '.zip';
        // Backup compactado com gzip e gravado como .json: confere descompactado, aos
        // pedaços e com o mesmo limite do ZIP. gzip que não abre: na dúvida, só o administrador.
        if (GZIP_MAGIC(head)) {
            const stream = zlib.createGunzip();
            pipeline(fs.createReadStream(filePath), stream, () => {});
            const result = await zipInspect.scanStream(stream, backupMarkerScanner(['backup-data.json']), { maxBytes: MAX_ZIP_SCAN_BYTES });
            return result !== 'done';
        }
        // Um ZIP gravado como .json também é aberto como ZIP (assinatura PK, ou o
        // diretório central no fim quando há bytes antes do ZIP).
        if (zipByName || zipInspect.hasZipMagic(head) || !/^[\s{[\uFEFF\xEF]/.test(head.toString('latin1', 0, 1))) {
            const result = await zipLooksLikeBackup(source, 0, { left: MAX_ZIP_SCAN_BYTES });
            if (result !== null) return result;
            // ZIP que não abre: procura os nomes e as marcas nos bytes.
            if (zipByName || zipInspect.hasZipMagic(head)) return fileHasBackupMarker(filePath, ['backup-data.json']);
        }
    } finally {
        await handle.close();
    }
    return fileHasBackupMarker(filePath);
}

async function fileLooksLikeBackup(filePath) {
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch (error) { return false; }
    if (!stat.isFile()) return false;
    const key = `${filePath}|${stat.mtimeMs}|${stat.size}`;
    if (backupContentCache.has(key)) return backupContentCache.get(key);
    // Pedidos simultâneos do mesmo arquivo esperam a mesma conferência.
    const pending = inspectBackupFile(filePath, stat);
    if (backupContentCache.size > 500) backupContentCache.clear();
    backupContentCache.set(key, pending);
    pending.catch(() => backupContentCache.delete(key));
    return pending;
}


module.exports = {
    COLLECTIONS, LEGACY_BACKUP_WARNING, SAFETY_BACKUP_FAILED_MESSAGE, BACKUP_BUSY_MESSAGE, UPLOADS_INBOX_DIR,
    RESTORE_DIR, WORK_DIR, RESTORE_TOKEN_TTL_MS, hasLegacyApplications,
    buildDataSnapshot, buildFullDataSnapshot, validateDataSnapshot, restoreDataSnapshot,
    runAutomaticBackup, lastAutomaticBackupAt, createBackup, createSafetyBackup, pruneBackups, backupInProgress,
    buildFullZipBuffer, streamFullZip, restoreFromFile, prepareRestore, applyPreparedRestore, discardPrepared,
    createRestoreToken, takeRestoreToken, sweepRestoreTokens, cleanWorkDirs, getZipLib,
    fileLooksLikeBackup, mergeRowsByKey,
};
