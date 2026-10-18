const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../database.js');
const runtimePaths = require('../runtimePaths.js');
const { resolveInside } = require('./safePath.js');
const { normalizeStoredStudentClasses } = require('./students.js');

const CONTENT_DIR = runtimePaths.CONTENT_DIR;
const DATA_DIR = runtimePaths.DATA_DIR;
const BACKUPS_DIR = runtimePaths.BACKUPS_DIR;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const COLLECTIONS = [
    'students', 'classes', 'courses', 'branding', 'submissions', 'notes', 'annotations',
    'forum', 'config', 'courseStructure', 'evaluations', 'progress', 'uploads', 'admins',
    'proctoringLogs', 'studentExamState', 'broadcastMessages', 'questionBank', 'auditLogs',
    'loginLogs', 'pedagogicalObservations', 'attendance', 'certificates', 'moduleAccess',
    'schools', 'announcements', 'library',
];

function getZipLib() { try { return require('adm-zip'); } catch (e) { return null; } }

function buildDataSnapshot() {
    const data = {};
    COLLECTIONS.forEach(key => { if (db.memory[key] !== undefined) data[key] = db.memory[key]; });
    const content = {};
    if (fs.existsSync(CONTENT_DIR)) {
        fs.readdirSync(CONTENT_DIR).filter(filename => filename.endsWith('.md')).forEach(filename => {
            content[filename] = fs.readFileSync(path.join(CONTENT_DIR, filename), 'utf8');
        });
    }
    return { type: 'iclass-backup-data', version: '3.0', exportedAt: new Date().toISOString(), data, content };
}

function validateDataSnapshot(snapshot) {
    if (!snapshot || snapshot.type !== 'iclass-backup-data' || !snapshot.data || typeof snapshot.data !== 'object') throw new Error('Arquivo de backup inválido.');
    if (!String(snapshot.version || '').startsWith('3.')) throw new Error('Versão de backup incompatível.');
    COLLECTIONS.forEach(key => {
        if (snapshot.data[key] === undefined) return;
        const current = db.memory[key];
        if (Array.isArray(current) !== Array.isArray(snapshot.data[key])) throw new Error(`Schema incompatível na coleção ${key}.`);
        if (current && typeof current === 'object' && (!snapshot.data[key] || typeof snapshot.data[key] !== 'object')) throw new Error(`Schema incompatível na coleção ${key}.`);
    });
    if (snapshot.content !== undefined && (!snapshot.content || typeof snapshot.content !== 'object' || Array.isArray(snapshot.content))) throw new Error('Conteúdo Markdown inválido.');
    Object.keys(snapshot.content || {}).forEach(filename => {
        if (!/^[\w.\-() ]+\.md$/.test(filename)) throw new Error(`Nome de conteúdo inválido: ${filename}`);
    });
    return snapshot;
}

function saveServerBackup(prefix) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUPS_DIR, `${prefix || 'backup'}_${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(buildDataSnapshot()));
    return file;
}

// Backup automático dos dados (JSON) com retenção: guarda os `keep` mais recentes
// do prefixo informado e apaga os mais antigos. Não inclui uploads (use o completo).
function runAutomaticBackup({ prefix = 'automatico', keep = 14 } = {}) {
    const file = saveServerBackup(prefix);
    const own = fs.readdirSync(BACKUPS_DIR)
        .filter(name => name.startsWith(`${prefix}_`) && name.endsWith('.json'))
        .sort()
        .reverse();
    own.slice(keep).forEach(name => { try { fs.rmSync(path.join(BACKUPS_DIR, name), { force: true }); } catch (e) {} });
    return file;
}

function lastAutomaticBackupAt(prefix = 'automatico') {
    if (!fs.existsSync(BACKUPS_DIR)) return null;
    const times = fs.readdirSync(BACKUPS_DIR)
        .filter(name => name.startsWith(`${prefix}_`) && name.endsWith('.json'))
        .map(name => { try { return fs.statSync(path.join(BACKUPS_DIR, name)).mtimeMs; } catch (e) { return 0; } });
    return times.length ? Math.max(...times) : null;
}

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

function streamFullZip(output) {
    const archiver = require('archiver');
    return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 6 } });
        const onError = error => reject(error);
        output.once('error', onError);
        archive.once('error', onError);
        output.once('close', resolve);
        archive.pipe(output);
        archive.append(JSON.stringify(buildDataSnapshot()), { name: 'backup-data.json' });
        if (fs.existsSync(CONTENT_DIR)) archive.directory(CONTENT_DIR, 'content');
        if (fs.existsSync(runtimePaths.UPLOADS_DIR)) archive.directory(runtimePaths.UPLOADS_DIR, 'data/uploads');
        if (fs.existsSync(runtimePaths.STUDENTS_DIR)) archive.directory(runtimePaths.STUDENTS_DIR, 'data/alunos');
        archive.finalize().catch(reject);
    });
}

async function saveServerFullBackup(prefix = 'seguranca-completa') {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUPS_DIR, `${prefix}_${stamp}.zip`);
    await streamFullZip(fs.createWriteStream(file));
    return file;
}

function validateZip(buffer) {
    const AdmZip = getZipLib();
    if (!AdmZip) throw new Error('Recurso de ZIP indisponível.');
    const zip = new AdmZip(buffer);
    const seen = new Set();
    let total = 0;
    for (const entry of zip.getEntries()) {
        const name = String(entry.entryName || '').replace(/\\/g, '/');
        if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw new Error(`Caminho inseguro no ZIP: ${name}`);
        const normalized = path.posix.normalize(name);
        if (normalized.replace(/\/$/, '') !== name.replace(/\/$/, '')) throw new Error(`Caminho não normalizado no ZIP: ${name}`);
        const key = normalized.toLowerCase();
        if (seen.has(key)) throw new Error(`Entrada duplicada no ZIP: ${name}`);
        seen.add(key);
        total += Number(entry.header && entry.header.size || 0);
        if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('ZIP excede o limite descompactado de 2 GB.');
        if (name !== 'backup-data.json' && !/^(content|data\/uploads|data\/alunos)(\/|$)/.test(name)) throw new Error(`Destino não permitido no ZIP: ${name}`);
    }
    const dataEntry = zip.getEntry('backup-data.json');
    if (!dataEntry) throw new Error('ZIP inválido: backup-data.json ausente.');
    const snapshot = validateDataSnapshot(JSON.parse(zip.readAsText(dataEntry)));
    return { zip, snapshot };
}

function extractZipToStage(zip, stageRoot) {
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory || entry.entryName === 'backup-data.json') continue;
        const target = resolveInside(stageRoot, entry.entryName.replace(/\\/g, '/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
    }
}

// SEG-X1: contas de acesso (administradores e professores) só são trocadas pela
// restauração quando um administrador pede isso explicitamente. Nesse caso o backup
// precisa ter ao menos um administrador e nenhuma senha em texto puro (um JSON editado
// à mão não pode criar ou promover conta).
function validateRestoredAccounts(snapshot) {
    const admins = snapshot && snapshot.data ? snapshot.data.admins : undefined;
    if (admins === undefined) return;
    if (!Array.isArray(admins)) throw new Error('Contas de acesso inválidas no backup.');
    const plain = admins.find(account => !account || !account.email || !db.isHashed(account.password));
    if (plain) throw new Error(`O backup traz a conta ${(plain && plain.email) || 'sem e-mail'} sem senha protegida (texto puro). Restaure sem substituir as contas.`);
    if (!admins.some(account => account.role !== 'professor')) throw new Error('O backup não tem nenhuma conta de administrador. Restaure sem substituir as contas.');
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
        accountEmails: Array.isArray(data.admins)
            ? data.admins.map(account => String((account && account.email) || '').trim().toLowerCase()).filter(Boolean)
            : [],
    };
}

async function applySnapshot(snapshot, { replaceAccounts = false } = {}) {
    validateDataSnapshot(snapshot);
    COLLECTIONS.forEach(key => {
        if (snapshot.data[key] === undefined) return;
        if (key === 'admins' && !replaceAccounts) return;
        db.memory[key] = structuredClone(snapshot.data[key]);
    });
    // Backups antigos podem trazer `studentClass` em objeto (DES-03).
    (db.memory.students || []).forEach(student => normalizeStoredStudentClasses(student));
    db.memory.sessions = {};
    db.memory.adminSessions = {};
    await db.save();
}

async function restoreDataSnapshot(snapshot, { replaceAccounts = false } = {}) {
    validateDataSnapshot(snapshot);
    if (replaceAccounts) validateRestoredAccounts(snapshot);
    const previous = buildDataSnapshot();
    const staged = [];
    try {
        fs.mkdirSync(CONTENT_DIR, { recursive: true });
        for (const [filename, value] of Object.entries(snapshot.content || {})) {
            const target = resolveInside(CONTENT_DIR, filename);
            const temporary = `${target}.restore-${process.pid}-${Date.now()}`;
            fs.writeFileSync(temporary, String(value), 'utf8');
            staged.push({ target, temporary, previous: fs.existsSync(target) ? fs.readFileSync(target) : null });
        }
        staged.forEach(file => fs.renameSync(file.temporary, file.target));
        await applySnapshot(snapshot, { replaceAccounts });
        return snapshotSummary(snapshot, 'json');
    } catch (error) {
        staged.forEach(file => {
            try {
                if (fs.existsSync(file.temporary)) fs.rmSync(file.temporary, { force: true });
                if (file.previous === null) fs.rmSync(file.target, { force: true });
                else fs.writeFileSync(file.target, file.previous);
            } catch (e) {}
        });
        await applySnapshot(previous, { replaceAccounts: true }).catch(() => {});
        throw error;
    }
}

async function restoreFullZip(buffer, { replaceAccounts = false } = {}) {
    const { zip, snapshot } = validateZip(buffer);
    if (replaceAccounts) validateRestoredAccounts(snapshot);
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-restore-'));
    const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-recovery-'));
    const targets = [
        ['content', CONTENT_DIR],
        ['data/uploads', runtimePaths.UPLOADS_DIR],
        ['data/alunos', runtimePaths.STUDENTS_DIR],
    ];
    const moved = [];
    const previous = buildDataSnapshot();
    try {
        extractZipToStage(zip, stageRoot);
        for (const [relative, target] of targets) {
            const staged = path.join(stageRoot, ...relative.split('/'));
            if (!fs.existsSync(staged)) fs.mkdirSync(staged, { recursive: true });
            const recovery = path.join(recoveryRoot, ...relative.split('/'));
            fs.mkdirSync(path.dirname(recovery), { recursive: true });
            if (fs.existsSync(target)) fs.renameSync(target, recovery);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(staged, target);
            moved.push({ target, recovery });
        }
        await applySnapshot(snapshot, { replaceAccounts });
        return snapshotSummary(snapshot, 'zip');
    } catch (error) {
        for (const item of moved.reverse()) {
            try {
                if (fs.existsSync(item.target)) fs.rmSync(item.target, { recursive: true, force: true });
                if (fs.existsSync(item.recovery)) fs.renameSync(item.recovery, item.target);
            } catch (e) {}
        }
        await applySnapshot(previous, { replaceAccounts: true }).catch(() => {});
        throw error;
    } finally {
        fs.rmSync(stageRoot, { recursive: true, force: true });
        fs.rmSync(recoveryRoot, { recursive: true, force: true });
    }
}

async function restoreFromFile(absPath, originalName, { replaceAccounts = false } = {}) {
    await db.save();
    await saveServerFullBackup();
    const buffer = fs.readFileSync(absPath);
    const isZip = /\.zip$/i.test(originalName || '') || buffer.subarray(0, 2).toString() === 'PK';
    const summary = isZip
        ? await restoreFullZip(buffer, { replaceAccounts })
        : await restoreDataSnapshot(JSON.parse(buffer.toString('utf8')), { replaceAccounts });
    return { ok: true, replaceAccounts, ...summary };
}

// SEG-X1: um .json/.zip em /uploads pode ser o banco inteiro (backup com os hashes
// das senhas), venha ele da lixeira, de um envio ou de um vínculo que o próprio
// professor criou na estrutura da turma. Por isso a decisão é pelo CONTEÚDO, não
// pelo vínculo: marca do backup ("type": "iclass-backup-data"), hash de senha
// (scrypt$...) ou, num ZIP, o backup-data.json, um banco .db/.sqlite ou um .json
// interno com essas marcas. Resultado em cache por caminho + data + tamanho.
const BACKUP_TEXT_MARKERS = [/"type"\s*:\s*"iclass-backup-data"/, /scrypt\$[A-Za-z0-9+/=]{8,}\$/];
const BACKUP_ZIP_ENTRY = /(^|\/)(backup-data\.json|[^/]+\.(?:db|sqlite3?))$/i;
const BACKUP_SCAN_CHUNK = 1024 * 1024;
const BACKUP_SCAN_OVERLAP = 256;
const MAX_ZIP_JSON_SCAN_BYTES = 128 * 1024 * 1024;
const backupContentCache = new Map();

function textHasBackupMarker(text) {
    return BACKUP_TEXT_MARKERS.some(marker => marker.test(text));
}

async function fileHasBackupMarker(filePath, extraLiterals = []) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(BACKUP_SCAN_CHUNK);
        let carry = '';
        let position = 0;
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, BACKUP_SCAN_CHUNK, position);
            if (!bytesRead) return false;
            position += bytesRead;
            // latin1 mantém um caractere por byte: as marcas são ASCII.
            const text = carry + buffer.toString('latin1', 0, bytesRead);
            if (textHasBackupMarker(text) || extraLiterals.some(literal => text.includes(literal))) return true;
            carry = text.slice(-BACKUP_SCAN_OVERLAP);
        }
    } finally {
        await handle.close();
    }
}

function zipHasBackupEntry(filePath) {
    const AdmZip = getZipLib();
    if (!AdmZip) return null;
    let entries;
    try { entries = new AdmZip(filePath).getEntries(); } catch (error) { return null; }
    let scanned = 0;
    for (const entry of entries) {
        const name = String(entry.entryName || '').replace(/\\/g, '/');
        if (BACKUP_ZIP_ENTRY.test(name)) return true;
        if (entry.isDirectory || !/\.json$/i.test(name)) continue;
        const size = Number(entry.header && entry.header.size || 0);
        if (scanned + size > MAX_ZIP_JSON_SCAN_BYTES) return true; // grande demais para conferir: na dúvida, só o administrador
        scanned += size;
        let data;
        try { data = entry.getData(); } catch (error) { continue; }
        if (data && textHasBackupMarker(data.toString('latin1'))) return true;
    }
    return false;
}

async function fileLooksLikeBackup(filePath) {
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch (error) { return false; }
    if (!stat.isFile()) return false;
    const key = `${filePath}|${stat.mtimeMs}|${stat.size}`;
    if (backupContentCache.has(key)) return backupContentCache.get(key);
    let result;
    if (path.extname(filePath).toLowerCase() === '.zip') {
        const fromEntries = zipHasBackupEntry(filePath);
        // ZIP que não abre: procura os nomes e as marcas nos bytes (entrada sem compressão).
        result = fromEntries === null ? await fileHasBackupMarker(filePath, ['backup-data.json']) : fromEntries;
    } else {
        result = await fileHasBackupMarker(filePath);
    }
    if (backupContentCache.size > 500) backupContentCache.clear();
    backupContentCache.set(key, result);
    return result;
}

module.exports = {
    COLLECTIONS, buildDataSnapshot, validateDataSnapshot, restoreDataSnapshot, saveServerBackup,
    runAutomaticBackup, lastAutomaticBackupAt,
    buildFullZipBuffer, streamFullZip, saveServerFullBackup, restoreFullZip, restoreFromFile, getZipLib, validateZip,
    fileLooksLikeBackup,
};
