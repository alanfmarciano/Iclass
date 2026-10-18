const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const db = require('../database.js');
const runtimePaths = require('../runtimePaths.js');
const { resolveInside } = require('./safePath.js');
const { normalizeStoredStudentClasses } = require('./students.js');
const zipInspect = require('./zipInspect.js');

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
    // Aplicações de prova: sem elas, restaurar um backup (por exemplo o salvo antes de
    // "Resetar sala") voltava as entregas e a turma, mas não o status das aplicações.
    // Backups antigos sem a coleção mantêm as aplicações atuais.
    'examApplications',
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
// pelo vínculo nem pela extensão: marca do backup ("type": "iclass-backup-data"),
// hash de senha (scrypt$...) ou a tabela de contas do banco do iClass; um ZIP (pela
// assinatura, mesmo gravado como .json) com backup-data.json ou com um .json, um
// banco SQLite ou outro ZIP dentro que tenha essas marcas. Um banco .db/.sqlite de
// exemplo (material de aula) não é backup. O ZIP é lido aos pedaços, sem travar o
// servidor. Resultado em cache por caminho + data + tamanho.
const BACKUP_TEXT_MARKERS = [
    /"type"\s*:\s*"iclass-backup-data"/,
    /scrypt\$[A-Za-z0-9+/=]{8,}\$/,
    // Esquema chave-valor do banco do iClass (database.js), como o SQLite o grava.
    /CREATE TABLE "?admins"? \(key TEXT PRIMARY KEY, value TEXT\)/,
];
const BACKUP_DATA_ENTRY = /(^|\/)backup-data\.json$/i;
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
    COLLECTIONS, buildDataSnapshot, validateDataSnapshot, restoreDataSnapshot, saveServerBackup,
    runAutomaticBackup, lastAutomaticBackupAt,
    buildFullZipBuffer, streamFullZip, saveServerFullBackup, restoreFullZip, restoreFromFile, getZipLib, validateZip,
    fileLooksLikeBackup,
};
