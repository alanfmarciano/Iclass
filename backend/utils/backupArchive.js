// ZIP do backup formato 2 e extração em streaming (H4a: CONF-07, OPS-04, OPS-05, CONF-08).
//
// Formato 2 (um construtor só para o automático, o manual, o de segurança, o download e a
// backup-cli):
// - iclass-backup.json: o manifesto { type: 'iclass-backup-manifest', formato: 2,
//   versaoApp, variante, origem, geradoEm, computador, inclui, arquivos, banco: { arquivo,
//   bytes, sha256, tabelas } };
// - data/database.db: a cópia do banco feita pelo VACUUM INTO (db.snapshotTo), legível
//   sozinha (dá para recuperar só descompactando);
// - content/**, data/alunos/** e cursos_arquivados/** (dados dos cursos excluídos, que já
//   saíram do banco e antes não estavam em nenhum backup do app);
// - data/uploads/**, só na variante 'completo'.
// Nunca entram: data/tls (a chave da CA do HTTPS), runtime/, logs/, crash.log, backups/,
// .backup-trabalho/, .restauracao/, quarentena/ e a lixeira. Links simbólicos ficam de fora.
//
// Este módulo não depende de database.js: a backup-cli usa o mesmo construtor e a mesma
// extração com o servidor parado.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');
const runtimePaths = require('../runtimePaths.js');
const zipInspect = require('./zipInspect.js');
const { resolveInside } = require('./safePath.js');
const { BACKUP_FORMAT, backupRefusal } = require('./backupSchema.js');

const MANIFEST_ENTRY = 'iclass-backup.json';
const DB_ENTRY = 'data/database.db';
const LEGACY_DATA_ENTRY = 'backup-data.json';
const MANIFEST_TYPE = 'iclass-backup-manifest';
// Teto do total descompactado de um backup (bytes reais, não os declarados).
const MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
// Folga de disco exigida além do total declarado antes de extrair.
const FREE_SPACE_MARGIN_BYTES = 512 * 1024 * 1024;
// JSON de dados (formato 1) lido até 1 GiB.
const MAX_JSON_BYTES = 1024 * 1024 * 1024;
// Arquivos que já vêm comprimidos: guardados sem compressão (deflate só gasta CPU).
const STORED_EXTENSIONS = /\.(?:pdf|mp4|webm|mov|mp3|jpe?g|png|gif|webp|zip|docx|xlsx|pptx)$/i;
// Prefixos de pasta que um backup pode trazer, na ordem do ZIP.
const FOLDER_PREFIXES = ['content', 'data/alunos', 'cursos_arquivados', 'data/uploads'];
const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 500;

function appVersion() {
    try { return String(require('../../package.json').version || ''); } catch (e) { return ''; }
}

// Pastas de origem de cada prefixo (lidas na hora: os testes mudam as variáveis).
function folderSources() {
    return [
        { prefix: 'content', dir: runtimePaths.CONTENT_DIR },
        { prefix: 'data/alunos', dir: runtimePaths.STUDENTS_DIR },
        { prefix: 'cursos_arquivados', dir: runtimePaths.ARCHIVE_DIR },
        { prefix: 'data/uploads', dir: runtimePaths.UPLOADS_DIR, completoOnly: true },
    ];
}

// Pastas que nunca entram num backup, mesmo que uma pasta de origem esteja configurada
// por cima delas (ICLASS_CONTENT_DIR dentro da pasta de dados, por exemplo).
function excludedDirs() {
    const data = runtimePaths.DATA_DIR;
    return new Set(['tls', 'runtime', 'logs', 'backups', '.backup-trabalho', '.restauracao', 'quarentena', 'lixeira']
        .map(name => path.resolve(data, name)));
}

// Arquivos de uma pasta (recursivo), sem seguir link simbólico e sem as pastas excluídas.
async function listFolderFiles(root, excluded = excludedDirs()) {
    const files = [];
    async function walk(dir, relative) {
        if (excluded.has(path.resolve(dir))) return;
        let items;
        try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) {
            if (e.code === 'ENOENT') return;
            throw e;
        }
        items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const item of items) {
            const abs = path.join(dir, item.name);
            const rel = relative ? `${relative}/${item.name}` : item.name;
            if (item.isSymbolicLink()) continue;
            if (item.isDirectory()) await walk(abs, rel);
            else if (item.isFile()) {
                const stat = await fs.promises.stat(abs).catch(() => null);
                if (stat) files.push({ abs, rel, size: stat.size });
            }
        }
    }
    await walk(root, '');
    return files;
}

function backupStamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

// <origem>_<variante>_<ISO com : e . trocados por ->.zip
function backupFileName(origem, variante, date = new Date()) {
    return `${origem}_${variante}_${backupStamp(date)}.zip`;
}

function hostLabel() {
    return os.hostname();
}

// Grava o ZIP formato 2 em `output` (stream de arquivo ou a resposta HTTP). dbInfo é o
// resultado do db.snapshotTo (ou da backup-cli): { file, bytes, sha256, tabelas }.
// Resolve com { sha256, bytes, manifest } quando o último byte saiu.
// signal (AbortSignal, opcional): o desligamento do servidor interrompe o ZIP no meio
// (quem chama apaga o .parcial); a promessa rejeita com code 'ICLASS_BACKUP_ABORTED'.
async function writeBackupZip(output, { dbInfo, variante = 'completo', origem = 'manual', now = new Date(), signal = null }) {
    if (variante !== 'dados' && variante !== 'completo') throw new TypeError(`Variante de backup desconhecida: ${variante}`);
    const archiver = require('archiver');
    const excluded = excludedDirs();
    const folders = [];
    for (const source of folderSources()) {
        if (source.completoOnly && variante !== 'completo') continue;
        folders.push({ ...source, files: await listFolderFiles(source.dir, excluded) });
    }
    const manifest = {
        type: MANIFEST_TYPE,
        formato: BACKUP_FORMAT,
        versaoApp: appVersion(),
        variante,
        origem,
        geradoEm: now.toISOString(),
        computador: hostLabel(),
        inclui: folders.map(folder => folder.prefix),
        arquivos: {
            quantidade: folders.reduce((sum, folder) => sum + folder.files.length, 0),
            bytes: folders.reduce((sum, folder) => sum + folder.files.reduce((total, file) => total + file.size, 0), 0),
        },
        banco: { arquivo: DB_ENTRY, bytes: dbInfo.bytes, sha256: dbInfo.sha256, tabelas: dbInfo.tabelas },
    };
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const tap = new Transform({
        transform(chunk, encoding, callback) {
            hash.update(chunk);
            bytes += chunk.length;
            callback(null, chunk);
        },
    });
    await new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 6 } });
        let settled = false;
        const fail = error => {
            if (settled) return;
            settled = true;
            archive.abort();
            // Arquivo em gravação (o .parcial): fechado aqui, para quem chama conseguir
            // apagá-lo (no Windows, arquivo aberto não sai). A resposta HTTP fica com a rota.
            if (output instanceof fs.WriteStream) output.destroy();
            reject(error);
        };
        archive.on('warning', error => {
            // Arquivo apagado entre a listagem e a leitura (material removido durante o
            // backup): fica de fora. O resto é falha.
            if (error && error.code === 'ENOENT') return;
            fail(error);
        });
        archive.on('error', fail);
        output.once('error', fail);
        if (signal) {
            const onAbort = () => fail(backupAbortedError());
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
        const done = () => { if (!settled) { settled = true; resolve(); } };
        output.once('finish', done);
        // Saída fechada antes do último byte (o navegador desistiu do download): falha, não
        // um backup completo.
        output.once('close', () => {
            if (output.writableFinished) return done();
            fail(Object.assign(new Error('A saída do backup foi fechada antes do fim.'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
        });
        archive.pipe(tap).pipe(output);
        archive.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_ENTRY });
        archive.file(dbInfo.file, { name: DB_ENTRY });
        folders.forEach(folder => {
            folder.files.forEach(file => {
                archive.file(file.abs, { name: `${folder.prefix}/${file.rel}`, store: STORED_EXTENSIONS.test(file.rel) });
            });
        });
        archive.finalize().catch(fail);
    });
    return { sha256: hash.digest('hex'), bytes, manifest };
}

function backupAbortedError() {
    return Object.assign(new Error('O backup foi interrompido porque o servidor está sendo desligado.'), { code: 'ICLASS_BACKUP_ABORTED' });
}

// Bytes aproximados de um backup da variante (banco + pastas), para conferir o espaço
// livre do destino antes de gravar (H4b). O ZIP costuma ser menor (deflate).
async function estimateBackupBytes(variante, dbBytes = 0) {
    const excluded = excludedDirs();
    let total = Number(dbBytes) || 0;
    for (const source of folderSources()) {
        if (source.completoOnly && variante !== 'completo') continue;
        (await listFolderFiles(source.dir, excluded)).forEach(file => { total += file.size; });
    }
    return total;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// rename com novas tentativas no Windows (antivírus ou OneDrive segurando o arquivo).
async function renameWithRetry(from, to) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fs.promises.rename(from, to);
            return;
        } catch (err) {
            if (attempt >= RENAME_RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
            await sleep(RENAME_RETRY_MS);
        }
    }
}

// Espera o arquivo em gravação fechar (até 2 s) antes de apagá-lo.
function closeStream(stream) {
    if (!stream || stream.closed) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        stream.once('close', () => { clearTimeout(timer); resolve(); });
        stream.destroy();
    });
}

async function fsyncFile(file) {
    const handle = await fs.promises.open(file, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
}

// Grava o texto em <arquivo>.tmp e renomeia (nunca fica pela metade).
async function writeFileAtomic(file, text) {
    const temporary = `${file}.tmp`;
    await fs.promises.writeFile(temporary, text);
    await renameWithRetry(temporary, file);
}

// Grava o ZIP em <pasta>/<nome>: primeiro <nome>.parcial (fsync e rename), depois o
// <nome>.sha256 no formato do sha256sum e, por fim, a conferência do diretório central
// (manifesto e banco presentes; checkDbCrc: CRC do banco relido). Devolve
// { file, name, bytes, sha256, manifest }. Falha da conferência (err.backupStage
// 'verificacao') apaga o ZIP e o .sha256: um backup que não confere não fica como se
// valesse (antes ficava, e a retenção podia apagar os bons por causa dele). Interrompido
// (signal) ou com falha na gravação: o .parcial sai.
async function saveBackupZip({ dir, name, dbInfo, variante, origem, now = new Date(), checkDbCrc = true, signal = null }) {
    await fs.promises.mkdir(dir, { recursive: true });
    const finalFile = path.join(dir, name);
    const partial = `${finalFile}.parcial`;
    await fs.promises.rm(partial, { force: true });
    let result;
    let output = null;
    try {
        output = fs.createWriteStream(partial);
        result = await writeBackupZip(output, { dbInfo, variante, origem, now, signal });
        await fsyncFile(partial);
        if (signal && signal.aborted) throw backupAbortedError();
        await renameWithRetry(partial, finalFile);
        await writeFileAtomic(`${finalFile}.sha256`, `${result.sha256}  ${name}\n`);
    } catch (err) {
        await closeStream(output);
        await fs.promises.rm(partial, { force: true }).catch(() => {});
        throw err;
    }
    try {
        await verifyBackupZip(finalFile, { checkDbCrc });
    } catch (err) {
        await fs.promises.rm(finalFile, { force: true }).catch(() => {});
        await fs.promises.rm(`${finalFile}.sha256`, { force: true }).catch(() => {});
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { backupStage: 'verificacao' });
    }
    return { file: finalFile, name, bytes: result.bytes, sha256: result.sha256, manifest: result.manifest };
}

// CRC-32 e bytes reais de uma entrada, conferidos enquanto ela é lida.
function entryChecker(entry, { onBytes } = {}) {
    let crc = 0;
    let size = 0;
    return new Transform({
        transform(chunk, encoding, callback) {
            size += chunk.length;
            if (size > entry.size) {
                return callback(backupRefusal(`Backup inválido: a entrada ${entry.name} descompacta mais bytes do que declara (arquivo adulterado).`));
            }
            if (onBytes) {
                const problem = onBytes(chunk.length);
                if (problem) return callback(problem);
            }
            crc = zlib.crc32(chunk, crc);
            callback(null, chunk);
        },
        flush(callback) {
            if (size !== entry.size) return callback(backupRefusal(`Backup inválido: a entrada ${entry.name} está incompleta (${size} de ${entry.size} bytes).`));
            if ((crc >>> 0) !== (entry.crc32 >>> 0)) return callback(backupRefusal(`Backup inválido: a entrada ${entry.name} está corrompida (CRC diferente do gravado).`));
            callback();
        },
    });
}

// Falha de leitura do ZIP (inflate com dados inválidos) é arquivo corrompido, não disco.
function asZipRefusal(err, entry) {
    if (!err || err.status) return err;
    if (/^Z_/.test(String(err.code || '')) || err.errno === -3 || /invalid|incorrect|unexpected end/i.test(String(err.message || ''))) {
        return backupRefusal(`O arquivo ZIP do backup está corrompido ou incompleto (entrada ${entry.name}).`);
    }
    return err;
}

async function withZip(file, fn) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const stat = await handle.stat();
        const source = zipInspect.fileSource(file, handle, stat.size);
        const directory = await zipInspect.readZipDirectory(source);
        if (!directory) throw backupRefusal('O arquivo ZIP do backup está corrompido ou incompleto e não pôde ser aberto.');
        return await fn(source, directory);
    } finally {
        await handle.close();
    }
}

async function readEntryText(source, directory, entry, maxBytes) {
    if (entry.size > maxBytes) throw backupRefusal(`Backup inválido: a entrada ${entry.name} é grande demais.`);
    const stream = await zipInspect.openEntryStream(source, directory, entry);
    if (!stream) throw backupRefusal(`Backup inválido: a entrada ${entry.name} usa um formato de compressão que o IClass não lê.`);
    const parts = [];
    await new Promise((resolve, reject) => {
        const checker = entryChecker(entry);
        checker.on('data', chunk => parts.push(chunk));
        pipeline(stream, checker, err => (err ? reject(asZipRefusal(err, entry)) : resolve()));
    });
    return Buffer.concat(parts).toString('utf8');
}

// Confere um ZIP formato 2 gravado: manifesto e banco presentes e, com checkDbCrc, o
// banco relido inteiro com o CRC conferido. Devolve o manifesto.
async function verifyBackupZip(file, { checkDbCrc = false } = {}) {
    return withZip(file, async (source, directory) => {
        const manifestEntry = directory.entries.find(entry => entry.name === MANIFEST_ENTRY);
        const dbEntry = directory.entries.find(entry => entry.name === DB_ENTRY);
        if (!manifestEntry || !dbEntry) throw new Error(`O ZIP gravado está incompleto (${!manifestEntry ? MANIFEST_ENTRY : DB_ENTRY} ausente): ${file}`);
        const manifest = JSON.parse(await readEntryText(source, directory, manifestEntry, 16 * 1024 * 1024));
        if (checkDbCrc) {
            const stream = await zipInspect.openEntryStream(source, directory, dbEntry);
            if (!stream) throw new Error(`O ZIP gravado não pôde ser relido: ${file}`);
            await new Promise((resolve, reject) => {
                const checker = entryChecker(dbEntry);
                checker.resume();
                pipeline(stream, checker, err => (err ? reject(err) : resolve()));
            });
        }
        return manifest;
    });
}

// Manifesto de um ZIP formato 2 (lista e backup-cli); null quando não é formato 2.
async function readBackupManifest(file) {
    try {
        return await withZip(file, async (source, directory) => {
            const entry = directory.entries.find(item => item.name === MANIFEST_ENTRY);
            if (!entry) return null;
            return JSON.parse(await readEntryText(source, directory, entry, 16 * 1024 * 1024));
        });
    } catch (e) {
        return null;
    }
}

// Regras de cada entrada do ZIP enviado para restaurar. Devolve o leiaute:
// 'zip-2' (manifesto), 'zip-1' (backup-data.json) ou 'launcher' (a pasta inteira do
// IClass da opção [7] do launcher, com <raiz>/data/database.db).
function classifyEntries(entries) {
    const seen = new Set();
    let hasManifest = false;
    let hasLegacyData = false;
    let hasDb = false;
    const launcherRoot = entries.map(entry => /^([^/]+)\/data\/database\.db$/.exec(entry.name)).find(Boolean);
    for (const entry of entries) {
        const name = String(entry.name || '');
        if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw backupRefusal(`Caminho inseguro no ZIP: ${name}`);
        const normalized = path.posix.normalize(name);
        if (normalized.replace(/\/$/, '') !== name.replace(/\/$/, '')) throw backupRefusal(`Caminho não normalizado no ZIP: ${name}`);
        const key = normalized.replace(/\/$/, '').toLowerCase();
        if (seen.has(key)) throw backupRefusal(`Entrada duplicada no ZIP: ${name}`);
        seen.add(key);
        if (zipInspect.isSymlinkEntry(entry)) throw backupRefusal(`Link simbólico não permitido no ZIP: ${name}`);
        if (name === MANIFEST_ENTRY) hasManifest = true;
        if (name === LEGACY_DATA_ENTRY) hasLegacyData = true;
        if (name === DB_ENTRY) hasDb = true;
    }
    if (!hasManifest && !hasLegacyData && launcherRoot) return 'launcher';
    if (hasManifest && hasLegacyData) throw backupRefusal('ZIP inválido: traz ao mesmo tempo iclass-backup.json e backup-data.json.');
    if (hasManifest && !hasDb) throw backupRefusal('ZIP inválido: data/database.db ausente.');
    if (!hasManifest && !hasLegacyData) throw backupRefusal('ZIP inválido: backup-data.json ausente.');
    const folderPattern = /^(content|data\/uploads|data\/alunos|cursos_arquivados)(\/|$)/;
    for (const entry of entries) {
        const name = entry.name;
        if (name === MANIFEST_ENTRY || name === LEGACY_DATA_ENTRY) continue;
        if (name === DB_ENTRY && hasManifest) continue;
        if (entry.isDirectory && name === 'data/') continue;
        // O formato 1 não trazia cursos_arquivados: o caminho só vale no formato 2.
        if (folderPattern.test(name) && (hasManifest || !name.startsWith('cursos_arquivados'))) {
            if (!entry.isDirectory && (entry.encrypted || (entry.method !== 0 && entry.method !== 8))) {
                throw backupRefusal(`Backup inválido: a entrada ${name} está cifrada ou usa uma compressão que o IClass não lê.`);
            }
            continue;
        }
        throw backupRefusal(`Destino não permitido no ZIP: ${name}`);
    }
    for (const entry of entries) {
        if ((entry.name === MANIFEST_ENTRY || entry.name === LEGACY_DATA_ENTRY || entry.name === DB_ENTRY)
            && (entry.encrypted || (entry.method !== 0 && entry.method !== 8))) {
            throw backupRefusal(`Backup inválido: a entrada ${entry.name} está cifrada ou usa uma compressão que o IClass não lê.`);
        }
    }
    return hasManifest ? 'zip-2' : 'zip-1';
}

const LAUNCHER_ZIP_MESSAGE = 'Este ZIP é a cópia da pasta inteira do IClass feita pela opção [7] do launcher. '
    + 'A restauração dele pela tela ainda não existe: para usá-lo, descompacte a pasta no computador do IClass com o servidor parado.';

async function freeBytesAt(dir) {
    try {
        const stat = await fs.promises.statfs(dir);
        return Number(stat.bavail) * Number(stat.bsize);
    } catch (e) {
        return null;
    }
}

// Extrai o ZIP enviado em stagingDir, entrada por entrada, sem carregar o ZIP na memória:
// cada entrada passa pela conferência de bytes reais e CRC-32 (bomba de descompressão com
// tamanho declarado falso, entrada trocada) e respeita a contrapressão do disco. Antes de
// começar, a pasta precisa ter livre o total declarado mais 512 MB. Devolve
// { layout, entries, bytes, prefixes } (prefixes: as pastas que o ZIP traz).
async function extractBackupZip(file, stagingDir, { maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
    return withZip(file, async (source, directory) => {
        const layout = classifyEntries(directory.entries);
        if (layout === 'launcher') throw backupRefusal(LAUNCHER_ZIP_MESSAGE);
        const files = directory.entries.filter(entry => !entry.isDirectory);
        const declared = files.reduce((sum, entry) => sum + entry.size, 0);
        if (declared > maxTotalBytes) throw backupRefusal('O ZIP do backup passa do limite de 16 GB descompactado.');
        await fs.promises.mkdir(stagingDir, { recursive: true });
        const free = await freeBytesAt(stagingDir);
        if (free !== null && free < declared + FREE_SPACE_MARGIN_BYTES) {
            throw backupRefusal(`Espaço insuficiente no disco para conferir o backup: são necessários ${Math.ceil((declared + FREE_SPACE_MARGIN_BYTES) / 1048576)} MB livres e há ${Math.floor(free / 1048576)} MB.`);
        }
        let total = 0;
        const onBytes = count => {
            total += count;
            return total > maxTotalBytes ? backupRefusal('O ZIP do backup passa do limite de 16 GB descompactado.') : null;
        };
        const prefixes = new Set();
        for (const entry of directory.entries) {
            const prefix = FOLDER_PREFIXES.find(item => entry.name === `${item}/` || entry.name.startsWith(`${item}/`) || entry.name === item);
            if (prefix) prefixes.add(prefix);
            const target = resolveInside(stagingDir, entry.name.replace(/\/$/, ''));
            if (entry.isDirectory) {
                await fs.promises.mkdir(target, { recursive: true });
                continue;
            }
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            const stream = await zipInspect.openEntryStream(source, directory, entry);
            if (!stream) throw backupRefusal(`O arquivo ZIP do backup está corrompido ou incompleto (entrada ${entry.name}).`);
            await new Promise((resolve, reject) => {
                pipeline(stream, entryChecker(entry, { onBytes }), fs.createWriteStream(target), err => (err ? reject(asZipRefusal(err, entry)) : resolve()));
            });
        }
        return { layout, entries: directory.entries.length, bytes: total, prefixes: FOLDER_PREFIXES.filter(prefix => prefixes.has(prefix)) };
    });
}

// JSON de dados (formato 1 ou o .json enviado), até 1 GiB.
async function readJsonFile(file, parse) {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_JSON_BYTES) throw backupRefusal('O arquivo JSON do backup passa de 1 GB e não pode ser lido.');
    const text = await fs.promises.readFile(file, 'utf8');
    return parse(text.replace(/^﻿/, ''));
}

module.exports = {
    DB_ENTRY,
    FOLDER_PREFIXES,
    LAUNCHER_ZIP_MESSAGE,
    LEGACY_DATA_ENTRY,
    MANIFEST_ENTRY,
    MANIFEST_TYPE,
    MAX_TOTAL_BYTES,
    backupFileName,
    backupStamp,
    backupAbortedError,
    classifyEntries,
    estimateBackupBytes,
    excludedDirs,
    extractBackupZip,
    folderSources,
    listFolderFiles,
    readBackupManifest,
    readJsonFile,
    renameWithRetry,
    saveBackupZip,
    verifyBackupZip,
    writeBackupZip,
};
