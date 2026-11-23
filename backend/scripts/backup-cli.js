#!/usr/bin/env node
// Backup pela linha de comando, com o servidor PARADO (H4a, OPS-05): o caminho de volta
// quando o painel não abre (banco danificado: o boot sai com o código 3 e manda para cá).
//
//   node backend/scripts/backup-cli.js listar
//   node backend/scripts/backup-cli.js criar [--dados] [--destino <pasta>]
//
// listar mostra os de data/backups e os da pasta deste computador no destino externo
// configurado na tela Sistema (H4b); criar grava, sem --destino, nessa pasta do destino
// externo (ou em data/backups, sem destino ou com ele desconectado).
//   node backend/scripts/backup-cli.js verificar <arquivo.zip>
//   node backend/scripts/backup-cli.js restaurar (<arquivo.zip> | --ultimo) [--sim]
//
// Só o ZIP formato 2 (manifesto iclass-backup.json + data/database.db). Os backups antigos
// (JSON e ZIP com backup-data.json) continuam restaurando pela tela Sistema.
//
// Códigos de saída: 0 deu certo; 1 falhou ou foi recusado (nada mudou); 2 o servidor está
// ligado (criar e restaurar só com ele parado: a memória dele ficaria fora da cópia ou
// gravaria por cima do banco restaurado).
//
// Fase 3 (A0): o restaurar segue a mesma regra da tela Sistema para as coleções das funções
// novas (missing 'keep' no registro de tabelas): a que o backup não traz (backup de antes
// da função) é copiada do banco de antes, que vai para a quarentena, e o resumo antes de
// confirmar diz quais ficam como estão. Os arquivos de data/entregas nunca saem do lugar.
// Backup feito por uma versão mais nova do IClass é recusado; o de versão anterior sai
// com os dados atualizados para esta versão (gancho 'schemaMigrations').
//
// Este processo não abre o banco pelo database.js (que cria e trava o arquivo ao ser
// carregado e grava tudo ao fechar): lê e copia pelo utils/dbFile.js. As conferências que
// precisam do database.js (estrutura das coleções; ganchos pós-restauração) rodam num
// processo filho (modos internos __conferir e __depois-de-restaurar).
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const readline = require('readline');
const { spawnSync } = require('child_process');
const runtimePaths = require('../runtimePaths.js');
const archive = require('../utils/backupArchive.js');
const schema = require('../utils/backupSchema.js');
const dbFile = require('../utils/dbFile.js');
const store = require('../utils/backupStore.js');
const schemaMigrations = require('../utils/schemaMigrations.js');
const { isFullAdmin } = require('../utils/adminRoles.js');

const EXIT = { OK: 0, FAILED: 1, SERVER_RUNNING: 2 };
const DATA_DIR = runtimePaths.DATA_DIR;
const BACKUPS_DIR = runtimePaths.BACKUPS_DIR;
const DB_FILE = path.join(DATA_DIR, 'database.db');
const DB_SIDE_FILES = ['-wal', '-shm', '-journal'];
const QUARANTINE_DIR = path.join(DATA_DIR, 'quarentena');
const CLI_WORK_DIR = path.join(DATA_DIR, '.restauracao');
// Marcador de restauração interrompida (backup.js recoverInterruptedRestore): o próximo
// boot do servidor desfaz a restauração que caiu no meio. Fica em .restauracao/desfazer;
// com o arquivo "concluida" ao lado, ou com o estado 'concluida' dentro do marcador, não há
// nada a desfazer.
const UNDO_DIR = path.join(CLI_WORK_DIR, 'desfazer');
const INTERRUPTED_RESTORE_NOTE = 'Há uma restauração pela tela Sistema interrompida no meio (data/.restauracao/desfazer); o IClass a desfaz ao ligar.';
// Decisões §12 (sobra do H4b): o mesmo texto da tela Sistema (backup.js).
const RESTORE_UNDO_PENDING_MESSAGE = 'Uma restauração anterior foi interrompida e ainda não foi desfeita. Feche e abra o IClass de novo para terminar de desfazer antes de restaurar outro backup.';

function undoPending() {
    const markerFile = path.join(UNDO_DIR, 'marcador.json');
    if (!fs.existsSync(markerFile) || fs.existsSync(path.join(UNDO_DIR, 'concluida'))) return false;
    try {
        return JSON.parse(fs.readFileSync(markerFile, 'utf8')).estado !== 'concluida';
    } catch (e) {
        return true;
    }
}

class CliError extends Error {
    constructor(message, exitCode = EXIT.FAILED) {
        super(message);
        this.exitCode = exitCode;
    }
}

function say(line = '') {
    process.stdout.write(`${line}\n`);
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} bytes`;
}

function formatDate(value) {
    const time = Date.parse(String(value || ''));
    if (!Number.isFinite(time)) return 'data desconhecida';
    return new Date(time).toLocaleString('pt-BR');
}

// Servidor ligado nesta porta: qualquer resposta HTTP conta (o /api/ping sem sessão
// responde 401), e também a conexão aceita sem resposta (servidor travado continua ligado).
function serverIsRunning(port = Number(process.env.PORT) || 3000) {
    return new Promise(resolve => {
        let connected = false;
        const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, res => {
            res.resume();
            resolve(true);
        });
        req.on('socket', socket => socket.once('connect', () => { connected = true; }));
        req.on('timeout', () => { req.destroy(); resolve(connected); });
        req.on('error', () => resolve(connected));
    });
}

async function ensureServerStopped() {
    if (await serverIsRunning()) {
        throw new CliError('O IClass está ligado. Feche o IClass (ou pare o servidor) e rode o comando de novo.', EXIT.SERVER_RUNNING);
    }
}

// --- listar -----------------------------------------------------------------------

async function listBackups(dir = BACKUPS_DIR) {
    if (!fs.existsSync(dir)) return [];
    const items = [];
    for (const name of fs.readdirSync(dir)) {
        if (!/\.(zip|json)$/i.test(name)) continue;
        // JSON só com o nome de backup do IClass: o data/backups/estado.json (situação do
        // backup, H4b) e outros .json da pasta não são backup. ZIP com outro nome continua
        // (o ZIP do launcher, por exemplo, pode ter sido copiado para cá).
        if (/\.json$/i.test(name) && !store.isBackupName(name)) continue;
        const file = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(file); } catch (e) { continue; }
        if (!stat.isFile()) continue;
        const manifest = /\.zip$/i.test(name) ? await archive.readBackupManifest(file) : null;
        const formato2 = !!(manifest && manifest.type === archive.MANIFEST_TYPE);
        items.push({
            name,
            file,
            bytes: stat.size,
            mtimeMs: stat.mtimeMs,
            formato2,
            variante: formato2 ? manifest.variante : null,
            geradoEm: formato2 ? manifest.geradoEm : new Date(stat.mtimeMs).toISOString(),
        });
    }
    return items.sort((a, b) => (Date.parse(b.geradoEm) || b.mtimeMs) - (Date.parse(a.geradoEm) || a.mtimeMs));
}

// Destino externo configurado na tela Sistema (settings.backup.destino), lido do banco
// parado só para leitura; sem banco legível, o do estado.json (último externo gravado).
async function configuredDestination() {
    if (fs.existsSync(DB_FILE)) {
        let connection = null;
        try {
            connection = await dbFile.openDatabaseFile(DB_FILE, { readOnly: true });
            const row = await dbFile.getOn(connection, "SELECT value FROM config WHERE key = 'app_config'");
            const config = row && row.value ? JSON.parse(row.value) : null;
            const destino = config && config.settings && config.settings.backup && typeof config.settings.backup.destino === 'string' ? config.settings.backup.destino.trim() : '';
            if (destino) return destino;
        } catch (e) {
            // Banco ilegível: cai no estado.json.
        } finally {
            if (connection) await dbFile.closeDatabaseFile(connection).catch(() => {});
        }
    }
    const state = store.readState();
    return state.externo && typeof state.externo.destino === 'string' ? state.externo.destino : '';
}

// Pastas onde os backups ficam: data/backups e a pasta deste computador no destino
// externo (quando configurado e acessível agora).
async function backupFolders() {
    const folders = [{ label: 'neste computador', dir: BACKUPS_DIR, local: 'servidor' }];
    const destino = await configuredDestination();
    if (destino) {
        const dir = store.externalDir(destino);
        let accessible = false;
        try { accessible = fs.statSync(destino).isDirectory(); } catch (e) { accessible = false; }
        folders.push({ label: 'no destino externo', dir, local: 'externo', destino, accessible });
    }
    return folders;
}

async function commandList() {
    const folders = await backupFolders();
    for (const folder of folders) {
        if (folder.local === 'externo' && !folder.accessible) {
            say(`Destino externo ${folder.destino}: não está acessível agora (pendrive ou HD desconectado?).`);
            continue;
        }
        const items = await listBackups(folder.dir);
        if (!items.length) {
            say(`Nenhum backup em ${folder.dir}.`);
            continue;
        }
        say(`Backups ${folder.label}, em ${folder.dir} (o mais recente primeiro):`);
        items.forEach((item, index) => {
            const kind = item.formato2 ? `formato 2, ${item.variante === 'completo' ? 'completo' : 'só os dados'}` : 'formato antigo (restaure pela tela Sistema)';
            say(`  ${String(index + 1).padStart(2)}. ${item.name}  ${formatDate(item.geradoEm)}  ${formatBytes(item.bytes)}  [${kind}]`);
        });
    }
    return EXIT.OK;
}

// --- criar ------------------------------------------------------------------------

// Cópia consistente do banco parado por uma conexão só de leitura, conferida pelo
// quick_check. Fora do db.runExclusive de propósito: aqui não há servidor nem fila de
// gravação (ensureServerStopped), e o VACUUM INTO lê uma foto só do arquivo.
async function snapshotDatabase(target) {
    if (!fs.existsSync(DB_FILE)) throw new CliError(`Banco de dados não encontrado em ${DB_FILE}.`);
    const connection = await dbFile.openDatabaseFile(DB_FILE, { readOnly: true });
    try {
        await dbFile.quickCheck(connection, { file: DB_FILE });
        await new Promise((resolve, reject) => connection.run('VACUUM INTO ?', [target], err => (err ? reject(err) : resolve())));
    } finally {
        await dbFile.closeDatabaseFile(connection);
    }
    // As sessões (tabelas fora do backup no registro) não vão para o ZIP, como no backup
    // pela tela (db.snapshotTo). A lista vem do backupSchema.js, igual à do registro: o
    // database.js abriria o banco parado em leitura e escrita só por ser carregado.
    await dbFile.clearTablesInCopy(target, schema.TABLES_OUTSIDE_BACKUP);
    return dbFile.inspectDatabaseFile(target);
}

async function commandCreate(options) {
    // Com o servidor ligado, o que está só na memória dele ficaria de fora da cópia: o
    // backup com o IClass ligado é o "Fazer backup agora" da tela Sistema.
    await ensureServerStopped();
    const variante = options.dados ? 'dados' : 'completo';
    // Sem --destino: a pasta deste computador no destino externo da tela Sistema (o
    // pendrive); sem destino ou com ele desconectado, data/backups.
    let dir = options.destino ? path.resolve(options.destino) : BACKUPS_DIR;
    const managed = !options.destino;
    if (undoPending()) say(`${INTERRUPTED_RESTORE_NOTE} Este backup sai com os dados como estão agora, pela metade; prefira ligar e desligar o IClass uma vez antes.`);
    if (!options.destino) {
        const external = (await backupFolders()).find(folder => folder.local === 'externo');
        if (external && external.accessible) dir = external.dir;
        else if (external) say(`O destino externo ${external.destino} não está acessível; o backup vai para ${BACKUPS_DIR}.`);
    }
    await fs.promises.mkdir(CLI_WORK_DIR, { recursive: true });
    const workDir = await fs.promises.mkdtemp(path.join(CLI_WORK_DIR, 'cli-criar-'));
    try {
        const dbInfo = await snapshotDatabase(path.join(workDir, 'database.db'));
        const now = new Date();
        const saved = await archive.saveBackupZip({ dir, name: archive.backupFileName('manual', variante, now), dbInfo, variante, origem: 'cli', now });
        // Retenção do grupo manual (20) só nas pastas do IClass, nunca numa pasta escolhida
        // no --destino.
        if (managed) store.applyRetention(dir, { scope: dir === BACKUPS_DIR ? 'local' : 'externo', protect: [saved.name] });
        say(`Backup criado: ${saved.file} (${formatBytes(saved.bytes)}).`);
        say(`Soma de verificação (SHA-256): ${saved.sha256}`);
        return EXIT.OK;
    } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

// --- conferência (verificar e restaurar) ------------------------------------------

// Estrutura das coleções no banco extraído, num processo filho com uma pasta de dados
// descartável (o database.js abre o banco dela, não o de verdade).
// liveDb: o banco de agora (para contar o que fica como está, A0).
function checkDatabaseSchema(file, liveDb = '') {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-cli-'));
    try {
        const result = spawnSync(process.execPath, [__filename, '__conferir', file, liveDb || ''], {
            env: {
                ...process.env,
                ICLASS_DATA_DIR: scratch,
                ICLASS_CONTENT_DIR: path.join(scratch, 'content'),
                ICLASS_ARCHIVE_DIR: path.join(scratch, 'cursos_arquivados'),
                TEST_MODE: '',
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        });
        const marker = String(result.stdout || '').lastIndexOf('@@');
        if (marker < 0) throw new CliError(`Não foi possível conferir o banco do backup.${result.stderr ? ` ${String(result.stderr).trim().split('\n').pop()}` : ''}`);
        const parsed = JSON.parse(String(result.stdout).slice(marker + 2));
        if (!parsed.ok) throw new CliError(parsed.error);
        return parsed;
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

// Confere o ZIP inteiro (CRC e bytes de cada entrada ao extrair, manifesto, quick_check,
// SHA-256 e contagens do banco, estrutura das coleções e o .sha256 ao lado, se houver).
// Devolve o que foi extraído em stagingDir.
async function verifyArchive(file, stagingDir) {
    if (!fs.existsSync(file)) throw new CliError(`Arquivo não encontrado: ${file}`);
    const sidecar = `${file}.sha256`;
    if (fs.existsSync(sidecar)) {
        const expected = String(fs.readFileSync(sidecar, 'utf8')).trim().split(/\s+/)[0].toLowerCase();
        const actual = await dbFile.fileSha256(file);
        if (expected && expected !== actual) throw new CliError('O arquivo não confere com a soma de verificação gravada ao lado dele (.sha256): está alterado ou corrompido.');
    }
    let extracted;
    try {
        extracted = await archive.extractBackupZip(file, stagingDir);
    } catch (err) {
        if (err && err.status === 400) throw new CliError(err.message);
        throw err;
    }
    if (extracted.layout !== 'zip-2') {
        throw new CliError('Este backup é de um formato antigo (sem o manifesto iclass-backup.json). Restaure-o pela tela Sistema do IClass, com o servidor ligado.');
    }
    let manifest;
    try {
        manifest = schema.validateManifest(JSON.parse(fs.readFileSync(path.join(stagingDir, archive.MANIFEST_ENTRY), 'utf8')));
    } catch (err) {
        throw new CliError(err instanceof SyntaxError ? 'Backup inválido: o manifesto iclass-backup.json está ilegível.' : err.message);
    }
    const dbPath = path.join(stagingDir, ...archive.DB_ENTRY.split('/'));
    let info;
    try {
        info = await dbFile.inspectDatabaseFile(dbPath);
    } catch (err) {
        if (err && err.code === 'ICLASS_DB_CORRUPT') throw new CliError('Backup inválido: o banco de dados dentro do ZIP está danificado.');
        throw err;
    }
    try {
        schema.compareManifestWithDatabase(manifest, info);
    } catch (err) {
        throw new CliError(err.message);
    }
    const content = checkDatabaseSchema(dbPath, fs.existsSync(DB_FILE) ? DB_FILE : '');
    return { manifest, dbPath, info, content, inclui: (manifest.inclui || []).filter(prefix => archive.FOLDER_PREFIXES.includes(prefix)) };
}

function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}

// Versão dos dados do backup (A0): base 281029f, ou quantas etapas já tem, e quantas a
// restauração aplica.
function schemaLine(content) {
    const esquema = content.esquema || { aplicadas: [], pendentes: [] };
    const applied = (esquema.aplicadas || []).length;
    const pending = (esquema.pendentes || []).length;
    const base = applied ? `${plural(applied, 'etapa aplicada', 'etapas aplicadas')}` : 'base (de antes das atualizações automáticas dos dados)';
    return `Versão dos dados: ${base}${pending ? `; ao restaurar, os dados são atualizados para esta versão (${plural(pending, 'etapa', 'etapas')})` : ''}.`;
}

function keptLine(kept) {
    if (!kept || !kept.length) return '';
    return `Ficam como estão (o backup é de antes desta função): ${kept.map(item => `${item.rotulo} (${item.atual})`).join(', ')}.`;
}

function printSummary(file, verified) {
    const { manifest, content } = verified;
    say(`Arquivo: ${file}`);
    say(`Gerado em: ${formatDate(manifest.geradoEm)}${manifest.computador ? ` no computador ${manifest.computador}` : ''} (IClass ${manifest.versaoApp || '?'})`);
    say(`Tipo: ${manifest.variante === 'completo' ? 'completo (com a biblioteca)' : 'só os dados'}`);
    say(`Alunos: ${content.counts.students || 0}  Turmas: ${content.counts.classes || 0}  Entregas: ${content.counts.submissions || 0}  Contas de acesso: ${content.counts.admins || 0}`);
    say(`Pastas: ${verified.inclui.length ? verified.inclui.join(', ') : 'nenhuma'}`);
    say(schemaLine(content));
    const kept = keptLine(content.kept);
    if (kept) say(kept);
    // Os arquivos das entregas de tarefa ficam fora de todo backup (D3 do P1) e a
    // restauração nunca toca data/entregas (contrato C7 do P1); a proteção deles é o
    // espelho no destino externo (C11).
    say(ASSIGNMENT_FILES_LINE);
    if (content.entregas) say(`Aviso: ${content.entregas}`);
    (content.warnings || []).forEach(warning => say(`Aviso: ${warning}`));
}

const ASSIGNMENT_FILES_LINE = 'Arquivos dos trabalhos dos alunos (data/entregas): não fazem parte do backup e a restauração não mexe neles; a cópia deles fica em <destino>/IClass-<computador>/entregas.';

async function newStagingDir(label) {
    await fs.promises.mkdir(CLI_WORK_DIR, { recursive: true });
    return fs.promises.mkdtemp(path.join(CLI_WORK_DIR, `cli-${label}-`));
}

async function commandVerify(file) {
    if (!file) throw new CliError('Informe o arquivo: node backend/scripts/backup-cli.js verificar <arquivo.zip>');
    const absolute = path.resolve(file);
    const stagingDir = await newStagingDir('verificar');
    try {
        const verified = await verifyArchive(absolute, stagingDir);
        printSummary(absolute, verified);
        say('Backup íntegro: soma de verificação (SHA-256), integridade do banco, contagens e estrutura conferidas.');
        return EXIT.OK;
    } finally {
        await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
}

// --- restaurar --------------------------------------------------------------------

function folderTarget(prefix) {
    if (prefix === 'content') return runtimePaths.CONTENT_DIR;
    if (prefix === 'data/uploads') return runtimePaths.UPLOADS_DIR;
    if (prefix === 'data/alunos') return runtimePaths.STUDENTS_DIR;
    if (prefix === 'cursos_arquivados') return runtimePaths.ARCHIVE_DIR;
    throw new CliError(`Pasta de backup desconhecida: ${prefix}`);
}

async function moveWithFallback(from, to) {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    try {
        await archive.renameWithRetry(from, to);
    } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await copyRecursive(from, to);
        await fs.promises.rm(from, { recursive: true, force: true });
    }
}

// Cópia de arquivo ou pasta (quando o rename não serve: outro disco, EXDEV).
async function copyRecursive(from, to) {
    const stat = await fs.promises.lstat(from);
    if (stat.isFile()) return fs.promises.copyFile(from, to);
    if (!stat.isDirectory()) return undefined;
    await fs.promises.mkdir(to, { recursive: true });
    for (const item of await fs.promises.readdir(from)) await copyRecursive(path.join(from, item), path.join(to, item));
    return undefined;
}

async function askConfirmation() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
        rl.question('Para restaurar, digite RESTAURAR e Enter (qualquer outra coisa cancela): ', resolve);
        rl.once('close', () => resolve(''));
    });
    rl.close();
    return String(answer || '').trim().toUpperCase() === 'RESTAURAR';
}

// O mais recente entre data/backups e o destino externo acessível.
async function latestBackup() {
    const candidates = [];
    for (const folder of await backupFolders()) {
        if (folder.local === 'externo' && !folder.accessible) continue;
        candidates.push(...(await listBackups(folder.dir)).filter(item => item.formato2));
    }
    candidates.sort((a, b) => (Date.parse(b.geradoEm) || b.mtimeMs) - (Date.parse(a.geradoEm) || a.mtimeMs));
    if (!candidates.length) throw new CliError(`Nenhum backup ZIP formato 2 em ${BACKUPS_DIR} nem no destino externo.`);
    return candidates[0].file;
}

// Ganchos pós-restauração no banco que acabou de entrar (processo filho com a pasta de
// dados de verdade): sessões zeradas, senhas antigas protegidas e, se o banco de antes
// pôde ser lido, a regra de rede e a configuração protegida dele (decisões §7).
function runAfterRestoreHooks(previousDb) {
    const result = spawnSync(process.execPath, [__filename, '__depois-de-restaurar', previousDb || ''], {
        env: { ...process.env, TEST_MODE: '' },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    const marker = String(result.stdout || '').lastIndexOf('@@');
    if (marker < 0) {
        throw new Error(`Os ajustes depois da restauração falharam.${result.stderr ? ` ${String(result.stderr).trim().split('\n').pop()}` : ''}`);
    }
    const parsed = JSON.parse(String(result.stdout).slice(marker + 2));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed;
}

async function commandRestore(target, options) {
    if (!target && !options.ultimo) throw new CliError('Informe o arquivo ou --ultimo: node backend/scripts/backup-cli.js restaurar <arquivo.zip>');
    await ensureServerStopped();
    // Restauração pela tela ainda a desfazer: esta apagaria o que o boot usa para desfazê-la
    // (o marcador e a cópia do banco de antes). Nada muda.
    if (undoPending()) throw new CliError(RESTORE_UNDO_PENDING_MESSAGE);
    const file = path.resolve(target === '--ultimo' || options.ultimo ? await latestBackup() : target);
    const stagingDir = await newStagingDir('restaurar');
    try {
        const verified = await verifyArchive(file, stagingDir);
        printSummary(file, verified);
        say('');
        say('Restaurar troca o banco de dados atual pelo do backup. O banco e as pastas de agora vão para data/quarentena (nada é apagado).');
        if (!options.sim && !(await askConfirmation())) {
            say('Restauração cancelada. Nada foi alterado.');
            return EXIT.FAILED;
        }
        // O servidor pode ter sido ligado enquanto a pessoa lia o resumo.
        await ensureServerStopped();

        const quarantine = path.join(QUARANTINE_DIR, `antes-restauracao_${archive.backupStamp()}`);
        await fs.promises.mkdir(quarantine, { recursive: true });
        const moved = [];
        const placed = [];
        const addedArchives = [];
        try {
            // 1. O banco de agora (com os arquivos -wal/-shm/-journal) e as pastas que o
            //    backup traz vão para a quarentena.
            for (const suffix of ['', ...DB_SIDE_FILES]) {
                const source = `${DB_FILE}${suffix}`;
                if (!fs.existsSync(source)) continue;
                const destination = path.join(quarantine, 'data', `database.db${suffix}`);
                await moveWithFallback(source, destination);
                moved.push({ from: source, to: destination });
            }
            for (const prefix of verified.inclui) {
                if (prefix === 'cursos_arquivados') continue;
                const source = folderTarget(prefix);
                if (!fs.existsSync(source)) continue;
                const destination = path.join(quarantine, ...prefix.split('/'));
                await moveWithFallback(source, destination);
                moved.push({ from: source, to: destination });
            }
            // Sobra de uma restauração pela tela que terminou (marcador 'concluida' que não
            // saiu): vai para a quarentena junto com o banco de antes, senão o boot anotaria
            // na Auditoria deste banco uma restauração que é do outro. A interrompida (a
            // desfazer) já foi recusada acima.
            if (fs.existsSync(UNDO_DIR) && !undoPending()) {
                const destination = path.join(quarantine, 'restauracao-anterior');
                await moveWithFallback(UNDO_DIR, destination);
                moved.push({ from: UNDO_DIR, to: destination });
            }
            // 2. Os arquivos do backup no lugar.
            await moveWithFallback(verified.dbPath, DB_FILE);
            placed.push(DB_FILE);
            for (const prefix of verified.inclui) {
                if (prefix === 'cursos_arquivados') continue;
                const staged = path.join(stagingDir, ...prefix.split('/'));
                const destination = folderTarget(prefix);
                if (fs.existsSync(staged)) await moveWithFallback(staged, destination);
                else await fs.promises.mkdir(destination, { recursive: true });
                placed.push(destination);
            }
            // 3. Cursos arquivados: só acrescenta os que não existem (histórico).
            const stagedArchives = path.join(stagingDir, 'cursos_arquivados');
            if (verified.inclui.includes('cursos_arquivados') && fs.existsSync(stagedArchives)) {
                for (const item of await fs.promises.readdir(stagedArchives, { withFileTypes: true })) {
                    if (!item.isDirectory()) continue;
                    const destination = path.join(runtimePaths.ARCHIVE_DIR, item.name);
                    if (fs.existsSync(destination)) continue;
                    await moveWithFallback(path.join(stagedArchives, item.name), destination);
                    addedArchives.push(destination);
                }
            }
            // 4. Ganchos pós-restauração no banco novo.
            const previousDb = moved.find(item => item.from === DB_FILE);
            const hooks = runAfterRestoreHooks(previousDb ? previousDb.to : '');
            say('');
            say('Backup restaurado.');
            say(`O banco e as pastas de antes estão em ${quarantine}.`);
            if (!hooks.networkKept) say('A regra de rede do painel voltou à do backup (o banco de antes não pôde ser lido).');
            if (hooks.kept && hooks.kept.length) say(`Ficaram como estavam (o backup é de antes desta função): ${hooks.kept.map(item => `${item.rotulo} (${item.atual})`).join(', ')}.`);
            if (hooks.migrated && hooks.migrated.length) say(`Os dados do backup foram atualizados para esta versão (${plural(hooks.migrated.length, 'etapa', 'etapas')}).`);
            if (hooks.adminEmails.length) say(`Contas de administrador deste backup: ${hooks.adminEmails.join(', ')}`);
            say('Todos precisarão entrar de novo. Se não souber a senha, use "Redefinir a senha do administrador" no menu do IClass (opção [7]; no ligarIclassV3.bat, opção [S]).');
            say('Agora abra o IClass de novo.');
            return EXIT.OK;
        } catch (err) {
            // Falha no meio: o que entrou sai e o que foi para a quarentena volta.
            for (const destination of placed.reverse()) await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => {});
            for (const added of addedArchives) await fs.promises.rm(added, { recursive: true, force: true }).catch(() => {});
            for (const item of moved.reverse()) await moveWithFallback(item.to, item.from).catch(() => {});
            await fs.promises.rm(quarantine, { recursive: true, force: true }).catch(() => {});
            throw new CliError(`A restauração falhou e tudo voltou ao que era: ${err.message}`);
        }
    } finally {
        await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
}

// --- modos internos (processo filho) ----------------------------------------------

// Coleções que ficam como estão (A0): as que o backup não traz e que a regra da
// restauração mantém (backupSchema.missingCollectionOutcome 'keep'), menos a versão dos
// dados (o gancho 'schemaMigrations' cuida dela). Só as de uma função nova (missing
// 'keep') aparecem no resumo; as outras (configuração, identidade visual) também são
// mantidas, como na tela.
function keptCollections(db, absent) {
    return db.COLLECTION_TABLES.filter(entry => entry.backup !== false && entry.kind !== 'derived' && entry.kind !== 'store'
        && entry.collection !== schemaMigrations.SCHEMA_COLLECTION
        && absent.has(entry.collection)
        && schema.missingCollectionOutcome(entry) === 'keep');
}

async function liveRowCounts(liveDb) {
    if (!liveDb || !fs.existsSync(liveDb)) return null;
    let connection = null;
    try {
        connection = await dbFile.openDatabaseFile(liveDb, { readOnly: true });
        return await dbFile.tableCounts(connection);
    } catch (e) {
        return null;
    } finally {
        if (connection) await dbFile.closeDatabaseFile(connection).catch(() => {});
    }
}

async function internalCheck(file, liveDb) {
    const db = require('../database.js');
    const { COLLECTION_LABELS } = require('../utils/backup.js');
    const tables = db.COLLECTION_TABLES.filter(entry => entry.backup !== false && entry.kind !== 'derived');
    const connection = await dbFile.openDatabaseFile(file, { readOnly: true });
    try {
        const stored = await db.readStoredData(connection);
        const data = {};
        Object.entries(stored.memory).forEach(([collection, value]) => {
            if (!stored.absent.has(collection)) data[collection] = value;
        });
        // Recusa a versão dos dados mais nova que esta (schemaMeta do banco do backup).
        const { warnings } = schema.validateBackupData(data, tables);
        let unreadable = 0;
        stored.unreadable.forEach(keys => { unreadable += keys.length; });
        if (unreadable) warnings.push(`${unreadable} registro(s) ilegível(is) no banco do backup.`);
        const counts = {};
        ['students', 'classes', 'submissions', 'admins'].forEach(key => { counts[key] = Array.isArray(data[key]) ? data[key].length : 0; });
        const plan = schemaMigrations.planSchema(data.schemaMeta);
        const esquema = { aplicadas: plan.applied, pendentes: plan.pending.filter(row => row.tipo === 'memoria').map(row => row.id) };
        const live = await liveRowCounts(liveDb);
        const kept = live ? keptCollections(db, stored.absent)
            .filter(entry => entry.missing === 'keep')
            .map(entry => ({ colecao: entry.collection, rotulo: COLLECTION_LABELS[entry.collection] || entry.collection, atual: Number(live[entry.table]) || 0 }))
            .filter(item => item.atual > 0) : [];
        const entregas = await liveAssignmentsNotice(db, data, liveDb);
        return { ok: true, warnings, counts, esquema, kept, ...(entregas ? { entregas } : {}) };
    } finally {
        await dbFile.closeDatabaseFile(connection);
    }
}

// As tarefas e entregas de hoje que o backup não tem (o mesmo aviso da prévia da tela
// Sistema, assignmentMirror.restorePreviewNotice): lê do banco atual só as duas coleções.
async function liveAssignmentsNotice(db, data, liveDb) {
    if (!liveDb || !fs.existsSync(liveDb)) return null;
    let connection = null;
    try {
        connection = await dbFile.openDatabaseFile(liveDb, { readOnly: true });
        const existing = new Set(await dbFile.tableNames(connection));
        const memory = {};
        for (const collection of ['assignments', 'assignmentSubmissions']) {
            const entry = db.COLLECTION_TABLES.find(item => item.collection === collection);
            memory[collection] = [];
            if (!entry || !existing.has(entry.table)) continue;
            const rows = await dbFile.allOn(connection, `SELECT value FROM ${entry.table}`);
            rows.forEach(row => { try { memory[collection].push(JSON.parse(row.value)); } catch (e) { /* ilegível: fora da conta */ } });
        }
        const notice = require('../utils/assignmentMirror.js').restorePreviewNotice(data, memory);
        return notice ? notice.aviso : null;
    } catch (e) {
        return null;
    } finally {
        if (connection) await dbFile.closeDatabaseFile(connection).catch(() => {});
    }
}

// Depois da troca do banco (o do backup já está em data/database.db): o banco de antes (na
// quarentena) é lido só para leitura, e o deste backup também, antes do init, para saber
// o que ele não traz e de que versão dos dados ele é. O init não roda as migrações
// (schema 'restore'): as coleções 'keep' ausentes vêm do banco de antes e só depois o
// gancho 'schemaMigrations' (o primeiro de db.afterRestore) roda as que faltam ao backup,
// com o id de cada aluno de antes (previousStudentIds), como na tela.
async function internalAfterRestore(previousDb) {
    const db = require('../database.js');
    const { COLLECTION_LABELS } = require('../utils/backup.js');
    let previous = null;
    let previousAbsent = new Set();
    if (previousDb && fs.existsSync(previousDb)) {
        try {
            const connection = await dbFile.openDatabaseFile(previousDb, { readOnly: true });
            try {
                const stored = await db.readStoredData(connection);
                if (!stored.absent.has('config')) {
                    previous = stored.memory;
                    previousAbsent = stored.absent;
                }
            } finally {
                await dbFile.closeDatabaseFile(connection);
            }
        } catch (e) {
            previous = null;
        }
    }
    const restored = await dbFile.openDatabaseFile(db.dbPath, { readOnly: true }).then(async connection => {
        try {
            const stored = await db.readStoredData(connection);
            return { absent: stored.absent, schemaMeta: stored.absent.has(schemaMigrations.SCHEMA_COLLECTION) ? undefined : stored.memory.schemaMeta };
        } finally {
            await dbFile.closeDatabaseFile(connection);
        }
    });
    await db.init({ schema: 'restore' });
    const kept = [];
    if (previous) {
        keptCollections(db, restored.absent).forEach(entry => {
            if (previousAbsent.has(entry.collection) || previous[entry.collection] === undefined) return;
            db.memory[entry.collection] = previous[entry.collection];
            const value = previous[entry.collection];
            const count = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? Object.keys(value).length : 0);
            if (entry.missing === 'keep' && count > 0) kept.push({ colecao: entry.collection, rotulo: COLLECTION_LABELS[entry.collection] || entry.collection, atual: count });
        });
    }
    const before = (db.memory.auditLogs || []).length;
    await db.runAfterRestore(db.memory, {
        keepNetwork: !!previous,
        previousNetwork: previous ? db.currentNetworkSettings(previous) : undefined,
        keepProtectedConfig: !!previous,
        previousProtectedConfig: previous ? db.currentProtectedConfig(previous) : undefined,
        backupSchema: restored.schemaMeta,
        previousSchemaMeta: previous && !previousAbsent.has(schemaMigrations.SCHEMA_COLLECTION) ? previous.schemaMeta : undefined,
        previousStudentIds: previous ? db.currentStudentIds(previous) : new Map(),
    });
    const migratedEntry = (db.memory.auditLogs || []).slice(before).find(entry => entry && entry.action === 'schema_migrated_on_restore');
    await db.save();
    await db.syncSchemaUserVersion();
    const adminEmails = (db.memory.admins || []).filter(account => account && account.email && isFullAdmin(account)).map(account => account.email);
    await db.close();
    return { ok: true, networkKept: !!previous, adminEmails, kept, migrated: migratedEntry && migratedEntry.details ? migratedEntry.details.migracoes || [] : [] };
}

function parseOptions(args) {
    const options = { positional: [] };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--dados') options.dados = true;
        else if (arg === '--sim') options.sim = true;
        else if (arg === '--ultimo') options.ultimo = true;
        else if (arg === '--destino') { options.destino = args[index + 1]; index += 1; }
        else if (arg.startsWith('--destino=')) options.destino = arg.slice('--destino='.length);
        else options.positional.push(arg);
    }
    return options;
}

const USAGE = [
    'Uso (com o IClass parado):',
    '  node backend/scripts/backup-cli.js listar',
    '  node backend/scripts/backup-cli.js criar [--dados] [--destino <pasta>]',
    '  node backend/scripts/backup-cli.js verificar <arquivo.zip>',
    '  node backend/scripts/backup-cli.js restaurar (<arquivo.zip> | --ultimo) [--sim]',
].join('\n');

async function main(argv = process.argv.slice(2)) {
    const [command, ...rest] = argv;
    if (command === '__conferir' || command === '__depois-de-restaurar') {
        try {
            const result = command === '__conferir' ? await internalCheck(rest[0], rest[1]) : await internalAfterRestore(rest[0]);
            process.stdout.write(`@@${JSON.stringify(result)}`);
        } catch (err) {
            process.stdout.write(`@@${JSON.stringify({ ok: false, error: String((err && err.message) || err) })}`);
        }
        // A conexão do database.js aberta no filho não segura o processo.
        process.exit(EXIT.OK);
    }
    const options = parseOptions(rest);
    try {
        if (command === 'listar') return await commandList();
        if (command === 'criar') return await commandCreate(options);
        if (command === 'verificar') return await commandVerify(options.positional[0]);
        if (command === 'restaurar') return await commandRestore(options.ultimo ? '--ultimo' : options.positional[0], options);
        say(USAGE);
        return command ? EXIT.FAILED : EXIT.OK;
    } catch (err) {
        process.stderr.write(`Erro: ${(err && err.message) || err}\n`);
        if (!(err instanceof CliError) && err && err.stack) process.stderr.write(`${err.stack}\n`);
        return err instanceof CliError ? err.exitCode : EXIT.FAILED;
    }
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; });
}

module.exports = { main, EXIT, listBackups, serverIsRunning };
