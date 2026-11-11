// Backups guardados no servidor e no destino externo (H4b: OPS-03, CONF-11, OPS-X2).
//
// - Nomes: <grupo>[_<variante>]_<carimbo>.(zip|json), com o carimbo ISO de backupStamp
//   (":" e "." trocados por "-"). Os .json antigos (automatico_<carimbo>.json, da versão de
//   antes do H4a) e os .zip novos do mesmo grupo contam juntos na retenção, então saem aos
//   poucos, sem uma limpeza em massa no primeiro boot.
// - Retenção por grupo (retentionRules): o backup mais recente de cada grupo nunca sai, nem
//   o que quem chama protege (o bem-sucedido agora); arquivo fora do padrão nunca é tocado,
//   e nada fora de data/backups ou de <destino>/IClass-<computador>. Os .bak gravados a cada
//   edição de apostila ou avaliação (admin.js makeBackup) ficam nos 30 mais recentes por
//   chave. Os .parcial (gravação interrompida: pendrive retirado, processo parado) com mais
//   de 1 h saem.
// - Estado (data/backups/estado.json): último sucesso local e externo, última falha (com a
//   etapa) e o adiamento por prova em andamento. Gravado em .tmp e renomeado. Não entra em
//   backup nem é restaurado (data/backups fica fora do ZIP). Sem ele (versão de antes), o
//   último sucesso local é o automatico* mais novo da pasta, pelo mtime.
// - Destino externo: a pasta escolhida em Sistema → Backup, conferida aqui (caminho
//   absoluto, pasta existente, fora da pasta do IClass) com um teste de escrita. Cada
//   computador grava na própria subpasta IClass-<computador>, para dois computadores
//   usarem o mesmo pendrive sem a retenção de um apagar os backups do outro.
//
// Este módulo não depende de database.js: a backup-cli lista e lê o estado com o servidor
// parado.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const runtimePaths = require('../runtimePaths.js');
const { resolveInside } = require('./safePath.js');

const STAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
const BACKUP_ORIGINS = Object.freeze(['automatico', 'manual', 'seguranca-restauracao', 'seguranca-completa', 'antes-limpeza-prova', 'antes-resetar-sala']);
const BACKUP_NAME = new RegExp(`^(${BACKUP_ORIGINS.join('|')})(?:_(dados|completo))?_(${STAMP})\\.(zip|json)$`);
// .bak das edições: <chave>_<carimbo>.(md|json).bak (admin.js makeBackup).
const EDIT_BACKUP_NAME = new RegExp(`^(.+)_(${STAMP})\\.(md|json)\\.bak$`);
const EDIT_BACKUPS_KEPT = 30;
// Gravação interrompida: <nome>.parcial (o ZIP) e <arquivo>.tmp (o .sha256 e o estado).
const LEFTOVER_NAME = /\.(parcial|tmp)$/;
const LEFTOVER_MAX_AGE_MS = 60 * 60 * 1000;
const STATE_FILE = 'estado.json';
const SIDECAR_SUFFIX = '.sha256';

// Quantos ficam por grupo. externo 'guardarExterno': o número escolhido na tela (1 a 90).
const RETENTION_RULES = Object.freeze([
    { grupo: 'automatico', origens: ['automatico'], local: 14, externo: 'guardarExterno' },
    { grupo: 'manual', origens: ['manual'], local: 20, externo: 20 },
    { grupo: 'seguranca', origens: ['seguranca-restauracao', 'seguranca-completa'], local: 5, externo: 5 },
    { grupo: 'antes-limpeza-prova', origens: ['antes-limpeza-prova'], local: 10, externo: 10 },
    { grupo: 'antes-resetar-sala', origens: ['antes-resetar-sala'], local: 10, externo: 10 },
]);

const FOREIGN_FOLDER_MESSAGE = 'Escolha uma pasta fora da pasta do IClass (pendrive, HD externo ou pasta de rede).';

function backupsDir() {
    return runtimePaths.BACKUPS_DIR;
}

// --- nomes --------------------------------------------------------------------------

function stampToIso(stamp) {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(String(stamp || ''));
    return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : null;
}

// { origem, variante, carimbo, extensao, criadoEm, formato } ou null (fora do padrão).
// formato pelo nome: o .zip com variante é o formato 2 (H4a); o .zip sem variante é o
// antigo (backup-data.json, seguranca-completa_*.zip); o .json é o JSON de dados.
function parseBackupName(name) {
    const match = BACKUP_NAME.exec(String(name || ''));
    if (!match) return null;
    const [, origem, variante, carimbo, extensao] = match;
    return {
        origem,
        variante: variante || (extensao === 'json' ? 'dados' : 'completo'),
        carimbo,
        extensao,
        criadoEm: stampToIso(carimbo),
        formato: extensao === 'json' ? 'json' : (variante ? 'zip-2' : 'zip-1'),
    };
}

function isBackupName(name) {
    return BACKUP_NAME.test(String(name || ''));
}

// Subpasta deste computador no destino externo: IClass-<nome do computador>, só com
// letras, números, "_" e "-" (até 40 caracteres).
function hostFolderName(host = os.hostname()) {
    const clean = String(host || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    return `IClass-${clean || 'computador'}`;
}

function externalDir(destino, host) {
    return path.join(String(destino || ''), hostFolderName(host));
}

// --- retenção -----------------------------------------------------------------------

function readNames(dir) {
    try { return fs.readdirSync(dir); } catch (e) { return []; }
}

function removeBackupFile(dir, name) {
    fs.rmSync(path.join(dir, name), { force: true });
    fs.rmSync(path.join(dir, `${name}${SIDECAR_SUFFIX}`), { force: true });
}

// Aplica a retenção de cada grupo em `dir` (scope 'local' = data/backups; 'externo' =
// <destino>/IClass-<computador>). protect: nomes que nunca saem (o backup que acabou de
// dar certo). Devolve os nomes apagados. Falha ao apagar um arquivo (preso pelo
// antivírus) não interrompe os outros.
function applyRetention(dir, { scope = 'local', guardarExterno = 14, protect = [] } = {}) {
    const keepNames = new Set((protect || []).filter(Boolean));
    const byGroup = new Map();
    readNames(dir).forEach(name => {
        const parsed = parseBackupName(name);
        if (!parsed) return;
        const rule = RETENTION_RULES.find(item => item.origens.includes(parsed.origem));
        if (!rule) return;
        if (!byGroup.has(rule)) byGroup.set(rule, []);
        byGroup.get(rule).push({ name, carimbo: parsed.carimbo });
    });
    const removed = [];
    byGroup.forEach((items, rule) => {
        const configured = scope === 'externo' ? (rule.externo === 'guardarExterno' ? guardarExterno : rule.externo) : rule.local;
        const limit = Math.max(1, Math.floor(Number(configured)) || 1);
        items.sort((a, b) => (a.carimbo < b.carimbo ? 1 : a.carimbo > b.carimbo ? -1 : a.name < b.name ? 1 : -1));
        items.slice(limit).forEach(item => {
            if (keepNames.has(item.name)) return;
            try {
                removeBackupFile(dir, item.name);
                removed.push(item.name);
            } catch (e) { /* fica para a próxima vez */ }
        });
    });
    return removed;
}

// .bak das edições de apostila e avaliação: os 30 mais recentes de cada chave.
function pruneEditBackups(dir = backupsDir(), keep = EDIT_BACKUPS_KEPT) {
    const groups = new Map();
    readNames(dir).forEach(name => {
        const match = EDIT_BACKUP_NAME.exec(name);
        if (!match) return;
        const key = `${match[1]}.${match[3]}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ name, carimbo: match[2] });
    });
    const removed = [];
    groups.forEach(items => {
        items.sort((a, b) => (a.carimbo < b.carimbo ? 1 : a.carimbo > b.carimbo ? -1 : 0));
        items.slice(Math.max(1, keep)).forEach(item => {
            try {
                fs.rmSync(path.join(dir, item.name), { force: true });
                removed.push(item.name);
            } catch (e) { /* fica para a próxima vez */ }
        });
    });
    return removed;
}

// Sobras de gravação interrompida (<nome>.parcial e os .tmp do .sha256 e do estado) com
// mais de olderThanMs. Só arquivos de backup ou do estado: o resto da pasta não é tocado.
function cleanLeftovers(dir, { olderThanMs = LEFTOVER_MAX_AGE_MS, now = Date.now() } = {}) {
    const removed = [];
    readNames(dir).forEach(name => {
        if (!LEFTOVER_NAME.test(name)) return;
        const base = name.replace(LEFTOVER_NAME, '');
        const owner = base.endsWith(SIDECAR_SUFFIX) ? base.slice(0, -SIDECAR_SUFFIX.length) : base;
        if (!isBackupName(owner) && owner !== STATE_FILE) return;
        const file = path.join(dir, name);
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || now - stat.mtimeMs < olderThanMs) return;
            fs.rmSync(file, { force: true });
            removed.push(name);
        } catch (e) { /* fica para a próxima vez */ }
    });
    return removed;
}

// --- estado -------------------------------------------------------------------------

function statePath(dir = backupsDir()) {
    return path.join(dir, STATE_FILE);
}

function readState(dir = backupsDir()) {
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

// Gravações do estado uma depois da outra (duas atualizações seguidas não se perdem).
let stateChain = Promise.resolve();

function updateState(mutate, dir = backupsDir()) {
    const run = async () => {
        const state = readState(dir);
        const next = mutate(state) || state;
        await fs.promises.mkdir(dir, { recursive: true });
        const file = statePath(dir);
        const temporary = `${file}.tmp`;
        await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2));
        await fs.promises.rename(temporary, file);
        return next;
    };
    const result = stateChain.then(run, run);
    stateChain = result.catch(() => {});
    return result;
}

// Último backup local bem-sucedido (ms): o do estado ou, sem ele, o automatico* mais
// novo da pasta pelo mtime (o .json da versão de antes também conta).
function lastLocalSuccessMs(state = readState(), dir = backupsDir()) {
    const fromState = Date.parse(String((state.local && state.local.ultimoSucesso) || ''));
    if (Number.isFinite(fromState)) return fromState;
    let newest = null;
    readNames(dir).forEach(name => {
        const parsed = parseBackupName(name);
        if (!parsed || parsed.origem !== 'automatico') return;
        try {
            const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
            if (newest === null || mtime > newest) newest = mtime;
        } catch (e) { /* sumiu entre a leitura e o stat */ }
    });
    return newest;
}

// --- lista e soma de verificação ------------------------------------------------------

function fileSha256(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
    });
}

function readSidecar(file) {
    try {
        const first = fs.readFileSync(`${file}${SIDECAR_SUFFIX}`, 'utf8').trim().split(/\s+/)[0];
        return /^[0-9a-f]{64}$/i.test(first) ? first.toLowerCase() : null;
    } catch (e) {
        return null;
    }
}

// Resultado da conferência por arquivo (caminho + mtime + tamanho): a lista mostra o que
// a prévia já conferiu, sem recalcular nada.
const checksumCache = new Map();

function checksumKey(file, stat) {
    return `${file}|${stat.mtimeMs}|${stat.size}`;
}

// 'ok' | 'diferente' | 'sem-arquivo' (sem o .sha256: backup antigo ou de outro programa).
async function verifyChecksum(file) {
    const expected = readSidecar(file);
    if (!expected) return 'sem-arquivo';
    const stat = await fs.promises.stat(file);
    const key = checksumKey(file, stat);
    if (checksumCache.has(key)) return checksumCache.get(key);
    const result = (await fileSha256(file)) === expected ? 'ok' : 'diferente';
    if (checksumCache.size > 500) checksumCache.clear();
    checksumCache.set(key, result);
    return result;
}

// Itens de backup de uma pasta, o mais novo primeiro. local: 'servidor' | 'externo'.
// sha256: 'sem-arquivo' sem o .sha256; com ele, o resultado de uma conferência já feita
// ('ok' | 'diferente') ou 'nao-conferido' (a prévia confere sob demanda).
function listBackupDir(dir, local) {
    const items = [];
    readNames(dir).forEach(name => {
        const parsed = parseBackupName(name);
        if (!parsed) return;
        const file = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(file); } catch (e) { return; }
        if (!stat.isFile()) return;
        const hasSidecar = !!readSidecar(file);
        const cached = hasSidecar ? checksumCache.get(checksumKey(file, stat)) : null;
        items.push({
            local,
            nome: name,
            origem: parsed.origem,
            variante: parsed.variante,
            formato: parsed.formato,
            bytes: stat.size,
            criadoEm: parsed.criadoEm || new Date(stat.mtimeMs).toISOString(),
            sha256: hasSidecar ? (cached || 'nao-conferido') : 'sem-arquivo',
        });
    });
    return items.sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : a.criadoEm > b.criadoEm ? -1 : 0));
}

// Caminho de um backup pedido pelo nome (lista, download e prévia): o nome precisa casar
// com o padrão e ficar dentro da pasta. null quando não existe ou não vale.
function resolveBackupFile(dir, nome) {
    const name = typeof nome === 'string' ? nome : '';
    if (!dir || !isBackupName(name)) return null;
    let file;
    try { file = resolveInside(dir, name); } catch (e) { return null; }
    try {
        const stat = fs.lstatSync(file);
        return stat.isFile() ? file : null;
    } catch (e) {
        return null;
    }
}

// --- destino externo ------------------------------------------------------------------

function destinationRefusal(message) {
    return Object.assign(new Error(message), { status: 400, field: 'destino' });
}

function samePathOrInside(child, parent) {
    const normalize = value => (process.platform === 'win32' ? value.toLowerCase() : value);
    const relative = path.relative(normalize(parent), normalize(child));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function realOrResolved(value) {
    try { return fs.realpathSync.native(value); } catch (e) { return path.resolve(value); }
}

// Pastas do IClass onde o destino não pode ficar: um backup "externo" dentro delas não
// protege de nada e ainda entraria no próprio backup (content, cursos arquivados).
function foreignRoots() {
    return [runtimePaths.PROJECT_ROOT, runtimePaths.DATA_DIR, runtimePaths.CONTENT_DIR, runtimePaths.ARCHIVE_DIR]
        .filter(Boolean)
        .map(realOrResolved);
}

async function freeBytesAt(dir) {
    try {
        const stat = await fs.promises.statfs(dir);
        return Number(stat.bavail) * Number(stat.bsize);
    } catch (e) {
        return null;
    }
}

function sameDevice(a, b) {
    try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch (e) { return false; }
}

// Confere o destino escolhido e testa a gravação: cria <destino>/IClass-<computador> e
// grava, relê e apaga um arquivo de teste. Devolve { destino, pasta, livreBytes,
// mesmoDisco }; recusa (status 400, field 'destino') com a mensagem para a tela. Destino
// vazio desliga a cópia externa ({ destino: '' }).
async function checkDestination(input, { host } = {}) {
    if (input !== undefined && input !== null && typeof input !== 'string') throw destinationRefusal('Informe o caminho da pasta em texto.');
    const raw = String(input || '').trim();
    if (!raw) return { destino: '', pasta: '', livreBytes: null, mesmoDisco: false };
    if (raw.length > 1024 || raw.includes('\0')) throw destinationRefusal('Caminho de pasta inválido.');
    if (!path.isAbsolute(raw)) throw destinationRefusal('Informe o caminho completo da pasta (por exemplo, E:\\Backups ou \\\\servidor\\pasta).');
    const destino = path.resolve(raw);
    let stat;
    try { stat = await fs.promises.stat(destino); } catch (e) {
        throw destinationRefusal(`A pasta ${destino} não existe ou não está acessível. Confira se o pendrive ou o HD está conectado.`);
    }
    if (!stat.isDirectory()) throw destinationRefusal(`${destino} não é uma pasta.`);
    const real = realOrResolved(destino);
    if (foreignRoots().some(root => samePathOrInside(real, root))) throw destinationRefusal(FOREIGN_FOLDER_MESSAGE);
    const pasta = externalDir(destino, host);
    const probe = path.join(pasta, `.iclass-teste-${crypto.randomBytes(6).toString('hex')}`);
    const content = `IClass ${new Date().toISOString()} ${crypto.randomBytes(8).toString('hex')}`;
    try {
        await fs.promises.mkdir(pasta, { recursive: true });
        await fs.promises.writeFile(probe, content);
        const back = await fs.promises.readFile(probe, 'utf8');
        if (back !== content) throw Object.assign(new Error('conteúdo diferente'), { code: 'EIO' });
    } catch (err) {
        throw destinationRefusal(`Não foi possível gravar na pasta ${destino}${err && err.code ? ` (${err.code})` : ''}. Confira se o pendrive está conectado e se a pasta permite gravação.`);
    } finally {
        await fs.promises.rm(probe, { force: true }).catch(() => {});
    }
    return {
        destino,
        pasta,
        livreBytes: await freeBytesAt(pasta),
        mesmoDisco: sameDevice(destino, runtimePaths.DATA_DIR),
    };
}

// Sugestão de destino na tela: a primeira linha do backup_path.txt do launcher, quando é
// um caminho absoluto fora da pasta do IClass (o padrão do launcher fica dentro dela).
function launcherPathSuggestion() {
    try {
        const first = fs.readFileSync(path.join(runtimePaths.PROJECT_ROOT, 'backup_path.txt'), 'utf8')
            .replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim().replace(/^"|"$/g, '');
        if (!first || !path.isAbsolute(first)) return '';
        const real = realOrResolved(first);
        return foreignRoots().some(root => samePathOrInside(real, root)) ? '' : path.resolve(first);
    } catch (e) {
        return '';
    }
}

module.exports = {
    BACKUP_NAME,
    BACKUP_ORIGINS,
    EDIT_BACKUPS_KEPT,
    FOREIGN_FOLDER_MESSAGE,
    LEFTOVER_MAX_AGE_MS,
    RETENTION_RULES,
    STATE_FILE,
    applyRetention,
    checkDestination,
    checksumCache,
    cleanLeftovers,
    externalDir,
    fileSha256,
    freeBytesAt,
    hostFolderName,
    isBackupName,
    lastLocalSuccessMs,
    launcherPathSuggestion,
    listBackupDir,
    parseBackupName,
    pruneEditBackups,
    readSidecar,
    readState,
    resolveBackupFile,
    sameDevice,
    statePath,
    updateState,
    verifyChecksum,
};
