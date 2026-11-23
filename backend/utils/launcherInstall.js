// Instalar, atualizar, voltar de versão e desinstalar o IClass do pacote (fase 3, A17 /
// P6-S5; OPS-01, OPS-02; D10, D12, D13 e D24 do P6). As ações ficam aqui, em Node e com
// teste no Linux; o instalar.ps1 do pacote só faz o que é do Windows (escolher a pasta,
// desbloquear os arquivos, atalhos, firewall e o registro de desinstalação) e chama estas.
//
// Layout instalado (D10), com a raiz escolhida no instalador (padrão C:\IClass):
//   <raiz>\IClass.cmd                    o lançador fino (acha a versão atual)
//   <raiz>\desinstalar.ps1               a desinstalação (o atalho do Menu Iniciar)
//   <raiz>\iclass-instalacao.json        { versaoAtual, versaoAnterior, versoes, ... }
//   <raiz>\programa\versao-atual.txt     a versão que vale agora (o IClass.cmd lê)
//   <raiz>\programa\<versão>\            o pacote, com node\ e o iclass-pastas.json
//   <raiz>\dados\  <raiz>\conteudo\  <raiz>\cursos-arquivados\
//
// - instalar (e atualizar): copia o pacote (só os arquivos do release-manifest.json,
//   conferidos pelo SHA-256 depois da cópia) para programa\<versão> por uma pasta
//   provisória renomeada no fim, grava o iclass-pastas.json dela, troca o ponteiro e guarda
//   só as duas últimas versões. Com prova em andamento, recusa. A mesma versão de novo não
//   muda nada. Nunca apaga nem move dados, conteudo ou cursos-arquivados (contrato C2).
// - trazer de uma pasta antiga (D24, a pasta do git do Alan): desliga o IClass antigo pela
//   rota de controle (com prova em andamento, recusa; o 281029f não tem a rota de situação,
//   então as provas vêm do banco dele, só leitura), copia data\ (sem runtime\, logs\, .backup-trabalho\,
//   .restauracao\ e quarentena\, mas com tls\ e backups\), content\ e cursos_arquivados\
//   para uma pasta provisória, confere a quantidade e o tamanho dos arquivos e abre o banco
//   copiado (quick_check); só então põe nas pastas da instalação. A pasta antiga fica como
//   estava: voltar é usar o ligarIclassV3.bat antigo.
// - voltar para a versão anterior (X7 do plano): backup de agora, restaurar o backup
//   'pre-atualizacao' daquela atualização com a backup-cli da versão anterior, trocar o
//   ponteiro e ligar. Atualização que não mudou o formato dos dados (nenhuma migração), ou
//   versão atual que nunca abriu os dados (schemaMeta.versaoApp do banco é outra), não
//   precisa restaurar: a versão anterior abre os dados de agora.
// - ligar junto com o Windows (D13): atalho na pasta Inicializar do usuário para
//   "IClass.cmd iniciar --minimizado --sem-navegador".
// - desinstalar: desliga, tira o atalho do Inicializar e o iclass-instalacao.json; os
//   dados ficam, a não ser que a pessoa digite APAGAR.
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtimePaths = require('../runtimePaths.js');
const launcherCore = require('./launcherCore.js');

const { EXIT } = launcherCore;

const MANIFEST_FILE = 'release-manifest.json';
const INSTALL_INFO_FILE = 'iclass-instalacao.json';
const POINTER_FILE = 'versao-atual.txt';
const PROGRAM_DIR = 'programa';
const FOLDERS_FILE = runtimePaths.FOLDERS_FILE_NAME;
const UPDATES_FILE = 'atualizacoes.json';
const STARTUP_SHORTCUT = 'IClass.lnk';
const STARTUP_ARGS = 'iniciar --minimizado --sem-navegador';
// Arquivos da raiz do pacote que vão também para a raiz da instalação.
const ROOT_LAUNCHERS = ['IClass.cmd', 'desinstalar.ps1'];
// Pastas de trabalho do próprio IClass na pasta de dados: não vão na cópia da pasta antiga
// (D24). tls\ vai (os aparelhos não precisam instalar o certificado de novo).
const SKIPPED_DATA_DIRS = new Set(['runtime', 'logs', '.backup-trabalho', '.restauracao', 'quarentena']);
// O -shm é refeito pelo SQLite; o -wal e o -journal vão (têm gravações).
const SKIPPED_DATA_FILES = new Set(['database.db-shm']);
const SKIPPED_NESTED = [['entregas', '.recebendo']];
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const STAGING_PREFIX = '.instalando-';
const REPLACED_PREFIX = '.substituindo-';
const BRING_STAGING = '.iclass-trazendo';

// --- versões ----------------------------------------------------------------------------

function parseVersion(text) {
    const match = VERSION_PATTERN.exec(String(text || '').trim());
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] };
}

// SemVer: -1, 0 ou 1. Versão de teste (3.1.1-teste) vem antes da 3.1.1.
function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) throw new TypeError(`Versão inválida: ${!left ? a : b}`);
    for (const key of ['major', 'minor', 'patch']) {
        if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
    }
    if (!left.pre.length || !right.pre.length) {
        if (left.pre.length === right.pre.length) return 0;
        return left.pre.length ? -1 : 1;
    }
    for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
        const x = left.pre[index];
        const y = right.pre[index];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
        if (nx !== ny) return nx ? -1 : 1;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

// --- arquivos ---------------------------------------------------------------------------

// Texto em UTF-8 (com ou sem BOM) ou UTF-16 LE com BOM (PowerShell e Bloco de Notas).
function decodeText(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.slice(2).toString('utf16le');
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.slice(3).toString('utf8');
    return buffer.toString('utf8');
}

function readJsonFile(file) {
    let raw;
    try { raw = fs.readFileSync(file); } catch (err) { return { found: false, value: null }; }
    try {
        const value = JSON.parse(decodeText(raw));
        return { found: true, value: value && typeof value === 'object' && !Array.isArray(value) ? value : null };
    } catch (err) {
        return { found: true, value: null };
    }
}

// Grava só se o conteúdo mudou, por um .tmp renomeado (nunca um arquivo pela metade).
function writeFileIfChanged(file, content) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    try {
        if (fs.readFileSync(file).equals(data)) return false;
    } catch (e) { /* não existe */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
    return true;
}

function writeJsonIfChanged(file, value) {
    return writeFileIfChanged(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let read;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function isInside(child, parent) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameOrNested(a, b) {
    return isInside(a, b) || isInside(b, a);
}

function isDirectory(dir) {
    try { return fs.statSync(dir).isDirectory(); } catch (e) { return false; }
}

function isEmptyOrMissing(dir) {
    if (!fs.existsSync(dir)) return true;
    try { return isDirectory(dir) && fs.readdirSync(dir).length === 0; } catch (e) { return false; }
}

// Caminho relativo do manifesto (sempre com "/") sem nada que saia da pasta.
function safeRelative(relative) {
    const text = String(relative || '');
    if (!text || text.includes('\0') || text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return null;
    const parts = text.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return null;
    return parts;
}

// O release-manifest.json do pacote (scripts/release/montar-pacote.js).
function readReleaseManifest(dir) {
    const { found, value } = readJsonFile(path.join(dir, MANIFEST_FILE));
    if (!found) return { ok: false, motivo: 'sem-manifesto' };
    if (!value || value.produto !== 'IClass' || !parseVersion(value.versao) || !value.arquivos || typeof value.arquivos !== 'object') {
        return { ok: false, motivo: 'manifesto-invalido' };
    }
    const files = Object.keys(value.arquivos);
    if (files.some(relative => !safeRelative(relative) || !/^[0-9a-f]{64}$/.test(String(value.arquivos[relative])))) return { ok: false, motivo: 'manifesto-invalido' };
    return { ok: true, manifest: value, versao: value.versao, files };
}

// Cada arquivo do manifesto existe em dir com o mesmo SHA-256? Devolve os problemas.
function checkAgainstManifest(dir, manifest, { limit = 20 } = {}) {
    const problems = [];
    for (const relative of Object.keys(manifest.arquivos)) {
        const file = path.join(dir, ...safeRelative(relative));
        let ok = false;
        try { ok = fs.statSync(file).isFile() && sha256File(file) === manifest.arquivos[relative]; } catch (e) { ok = false; }
        if (!ok) {
            problems.push(`${relative} (${fs.existsSync(file) ? 'alterado' : 'faltando'})`);
            if (problems.length >= limit) break;
        }
    }
    return problems;
}

function copyFilePreserving(source, target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    try {
        const stat = fs.statSync(source);
        fs.utimesSync(target, stat.atime, stat.mtime);
    } catch (e) { /* data do arquivo não é essencial */ }
}

// Lista { relativo: tamanho } de uma árvore, sem links simbólicos e com o filtro.
function listTree(dir, { skip = () => false } = {}) {
    const files = new Map();
    const walk = (current, relative) => {
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (e) { return; }
        entries.forEach(entry => {
            const rel = relative ? `${relative}/${entry.name}` : entry.name;
            if (skip(rel, entry)) return;
            const full = path.join(current, entry.name);
            if (entry.isSymbolicLink()) return;
            if (entry.isDirectory()) walk(full, rel);
            else if (entry.isFile()) {
                try { files.set(rel, fs.statSync(full).size); } catch (e) { /* sumiu no meio */ }
            }
        });
    };
    if (isDirectory(dir)) walk(dir, '');
    return files;
}

function copyTree(source, target, options = {}) {
    const files = listTree(source, options);
    fs.mkdirSync(target, { recursive: true });
    files.forEach((size, relative) => copyFilePreserving(path.join(source, ...relative.split('/')), path.join(target, ...relative.split('/'))));
    return files;
}

function sameListing(a, b) {
    if (a.size !== b.size) return false;
    for (const [relative, size] of a) if (b.get(relative) !== size) return false;
    return true;
}

function totalBytes(listing) {
    let total = 0;
    listing.forEach(size => { total += size; });
    return total;
}

function skipOldData(relative) {
    const parts = relative.split('/');
    if (parts.length === 1 && SKIPPED_DATA_FILES.has(parts[0])) return true;
    if (SKIPPED_DATA_DIRS.has(parts[0])) return true;
    return SKIPPED_NESTED.some(prefix => prefix.every((name, index) => parts[index] === name));
}

function megabytes(bytes) {
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',');
}

function dateText(ms) {
    if (!Number.isFinite(Number(ms))) return '';
    try {
        return new Date(Number(ms)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) {
        return new Date(Number(ms)).toISOString();
    }
}

// --- padrões injetáveis -----------------------------------------------------------------

function powershellPath(env = process.env) {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Atalho (.lnk) pelo WScript.Shell, com os caminhos nas variáveis de ambiente (nada de
// caminho com acento ou espaço passando pelo interpretador). Janela minimizada.
function createWindowsShortcut({ file, target, args = '', workdir = '', description = '' }) {
    const script = [
        '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:ICLASS_LNK)',
        '$s.TargetPath = $env:ICLASS_ALVO',
        '$s.Arguments = $env:ICLASS_ARGS',
        '$s.WorkingDirectory = $env:ICLASS_PASTA',
        '$s.Description = $env:ICLASS_DESCRICAO',
        '$s.WindowStyle = 7',
        '$s.Save()',
    ].join('; ');
    const result = childProcess.spawnSync(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        env: { ...process.env, ICLASS_LNK: file, ICLASS_ALVO: target, ICLASS_ARGS: args, ICLASS_PASTA: workdir, ICLASS_DESCRICAO: description },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !fs.existsSync(file)) throw new Error(String(result.stderr || '').trim() || `PowerShell saiu com ${result.status}`);
    return true;
}

// Abre o banco copiado (leitura e escrita: o -wal que veio junto é aplicado na cópia, nunca
// no original), roda o quick_check e conta as linhas de cada tabela.
async function inspectCopiedDatabase(file) {
    const dbFile = require('./dbFile.js');
    const connection = await dbFile.openDatabaseFile(file, { readOnly: false });
    try {
        await new Promise((resolve, reject) => connection.run('PRAGMA wal_checkpoint(TRUNCATE)', err => (err ? reject(err) : resolve())));
        await dbFile.quickCheck(connection, { file });
        return { tabelas: await dbFile.tableCounts(connection) };
    } finally {
        await dbFile.closeDatabaseFile(connection);
    }
}

// schema_meta do banco (só leitura), para decidir a volta de versão: a versão que abriu os
// dados por último e o histórico das atualizações. Banco sem schema_meta (dados da 281029f
// que nenhuma versão 3.x abriu ainda): { aplicadas: [], atualizacoes: [] }, sem versaoApp.
// Linha ilegível: null (não dá para decidir pelo banco).
async function readDataSchema(file) {
    const schemaMigrations = require('./schemaMigrations.js');
    const stored = await schemaMigrations.readSchemaMetaFile(file);
    if (!stored || stored.unreadable) return null;
    return stored.value || { aplicadas: [], atualizacoes: [] };
}

// Provas em andamento lidas direto do banco (só leitura; com o WAL, dá para ler com o
// servidor ligado): para o servidor de uma versão anterior (281029f), que não tem a rota
// de situação, e para o banco de um IClass desligado no meio da prova. Aplicações em sala
// de espera, em andamento ou pausadas (a mesma regra do servidor) e, de bancos mais
// antigos, a prova ativa guardada na turma sem aplicação correspondente. Devolve a lista
// no formato do control/status ({ titulo, turma, situacao }); erro de leitura sobe.
async function readDataExams(file) {
    const dbFile = require('./dbFile.js');
    const { ACTIVE_APPLICATION_STATUSES } = require('./examApplications.js');
    const connection = await dbFile.openDatabaseFile(file, { readOnly: true });
    try {
        const tables = new Set(await dbFile.tableNames(connection));
        const parse = text => { try { return JSON.parse(text); } catch (e) { return null; } };
        const applications = tables.has('exam_applications')
            ? (await dbFile.allOn(connection, 'SELECT value FROM exam_applications')).map(row => parse(row.value)).filter(item => item && typeof item === 'object')
            : [];
        const known = new Set(applications.map(item => item.id).filter(Boolean));
        const provas = applications
            .filter(item => ACTIVE_APPLICATION_STATUSES.has(item.status))
            .map(item => ({ titulo: String(item.title || item.examKey || 'Prova'), turma: item.studentClass || null, situacao: item.status }));
        if (tables.has('classes')) {
            (await dbFile.allOn(connection, 'SELECT value FROM classes')).forEach(row => {
                const cls = parse(row.value);
                const configs = cls && cls.onlineExamConfigs && typeof cls.onlineExamConfigs === 'object' ? cls.onlineExamConfigs : {};
                Object.entries(configs).forEach(([examKey, cfg]) => {
                    if (!cfg || (cfg.applicationId && known.has(cfg.applicationId))) return;
                    const status = ACTIVE_APPLICATION_STATUSES.has(cfg.status) ? cfg.status : (cfg.onlineActive === true && !cfg.status ? 'running' : null);
                    if (status) provas.push({ titulo: String(cfg.title || examKey || 'Prova'), turma: cls.name || null, situacao: status });
                });
            });
        }
        return provas;
    } finally {
        await dbFile.closeDatabaseFile(connection);
    }
}

// --- as ações ---------------------------------------------------------------------------

// ctx (de launcherCore.createLauncher): options (as injeções), projectRoot, platform,
// baseEnv, out, ask, confirm, run, now, defaultPort, version e createLauncher.
function createInstallActions(ctx) {
    const { options, projectRoot, platform, baseEnv, out, ask, confirm, run, now } = ctx;
    const nodeFor = options.nodeFor || (programDir => {
        const bundled = path.join(programDir, 'node', platform === 'win32' ? 'node.exe' : 'node');
        return fs.existsSync(bundled) ? bundled : process.execPath;
    });
    const inspectDatabase = options.inspectDatabase || inspectCopiedDatabase;
    const readSchema = options.readDataSchema || readDataSchema;
    const readExams = options.readDataExams || readDataExams;
    const shortcut = options.shortcut || {
        create: params => createWindowsShortcut(params),
        remove: file => { fs.rmSync(file, { force: true }); return true; },
        exists: file => fs.existsSync(file),
    };
    const isoNow = () => new Date(now()).toISOString();

    function defaultRoot() {
        if (platform === 'win32') return `${(baseEnv.SystemDrive || 'C:').replace(/\\$/, '')}\\IClass`;
        return path.join(os.homedir(), 'IClass');
    }

    function programDirOf(root, versao) {
        return path.join(root, PROGRAM_DIR, versao);
    }

    function readPointer(root) {
        try {
            const value = String(fs.readFileSync(path.join(root, PROGRAM_DIR, POINTER_FILE), 'utf8')).trim();
            return parseVersion(value) ? value : null;
        } catch (e) {
            return null;
        }
    }

    // A instalação em root: { info, versaoAtual, ... } ou null. O iclass-instalacao.json
    // vale; sem ele, o versao-atual.txt (instalação de antes de o arquivo existir).
    function readInstallation(root) {
        const { found, value } = readJsonFile(path.join(root, INSTALL_INFO_FILE));
        const info = value || {};
        let versaoAtual = parseVersion(info.versaoAtual) ? info.versaoAtual : readPointer(root);
        if (versaoAtual && !fs.existsSync(path.join(programDirOf(root, versaoAtual), MANIFEST_FILE))) versaoAtual = null;
        if (!versaoAtual && !found) return null;
        return { root, info, versaoAtual, unreadable: found && !value };
    }

    // Esta pasta de programa é uma versão instalada? { root, programDir, versao } ou null.
    function installationContext(programDir = projectRoot) {
        const dir = path.resolve(programDir);
        if (path.basename(path.dirname(dir)) !== PROGRAM_DIR) return null;
        const root = path.dirname(path.dirname(dir));
        if (!fs.existsSync(path.join(root, INSTALL_INFO_FILE))) return null;
        const installation = readInstallation(root);
        if (!installation) return null;
        return { ...installation, programDir: dir, versao: path.basename(dir) };
    }

    function foldersOfInstallation(root, installation) {
        const fromProgram = installation && installation.versaoAtual
            ? runtimePaths.readFoldersFile(programDirOf(root, installation.versaoAtual)).values
            : {};
        const fromInfo = installation && installation.info && installation.info.pastas && typeof installation.info.pastas === 'object' ? installation.info.pastas : {};
        const pick = (field, fallback) => {
            const value = fromProgram[field] || (typeof fromInfo[field] === 'string' && fromInfo[field].trim() ? path.resolve(root, fromInfo[field]) : null);
            return value || path.join(root, fallback);
        };
        return { dados: pick('dados', 'dados'), conteudo: pick('conteudo', 'conteudo'), cursosArquivados: pick('cursosArquivados', 'cursos-arquivados') };
    }

    // O iclass-pastas.json da versão: pastas dentro da raiz em caminho relativo (com /),
    // para a instalação continuar achando os dados se a pasta inteira for movida ou
    // renomeada (C:\IClass para D:\IClass); pasta fora da raiz, caminho completo.
    function foldersFileFor(programDir, root, pastas) {
        const write = dir => (isInside(dir, root) ? path.relative(programDir, dir).split(path.sep).join('/') : dir);
        return { dados: write(pastas.dados), conteudo: write(pastas.conteudo), cursosArquivados: write(pastas.cursosArquivados) };
    }

    function runtimeFoldersOf(pastas) {
        return {
            DATA_DIR: pastas.dados,
            CONTENT_DIR: pastas.conteudo,
            ARCHIVE_DIR: pastas.cursosArquivados,
            origem: { DATA_DIR: 'arquivo', CONTENT_DIR: 'arquivo', ARCHIVE_DIR: 'arquivo' },
        };
    }

    // O launcher de outra pasta de programa (a versão instalada, a anterior, a pasta
    // antiga do git), com as mesmas injeções (processos, HTTP, perguntas) deste.
    function launcherFor(programDir, { folders, port } = {}) {
        const versionInfo = readJsonFile(path.join(programDir, 'package.json')).value || {};
        return ctx.createLauncher({
            ...options,
            projectRoot: programDir,
            nodePath: nodeFor(programDir),
            supervisorScript: undefined,
            backupCliScript: undefined,
            resetPasswordScript: undefined,
            folders: folders || runtimePaths.resolveRuntimeFolders({ projectRoot: programDir, env: baseEnv }),
            version: versionInfo.version || '',
            port: port || options.port,
        });
    }

    // As provas em andamento de um IClass ligado: pela rota de situação e, quando ela não
    // diz (servidor de uma versão anterior, como o 281029f do ligarIclassV3.bat, ou rota
    // sem a contagem), pelo banco, só leitura. { provas, unknown }.
    async function examsOf(found, dataFile) {
        if (!launcherCore.examsUnknown(found)) {
            return { provas: found.status && Array.isArray(found.status.provas) ? found.status.provas : [], unknown: false };
        }
        if (dataFile && fs.existsSync(dataFile)) {
            try {
                return { provas: await readExams(dataFile), unknown: false, doBanco: true };
            } catch (err) { /* não deu para ler: fica desconhecido */ }
        }
        return { provas: [], unknown: true };
    }

    // O IClass desta pasta de dados está ligado? Com prova em andamento (pela rota de
    // controle ou, no servidor antigo, pelo banco), recusa. Sem como saber das provas,
    // avisa e só desliga se a pessoa disser que sim (o padrão é não; com --sim, recusa).
    // Ligado sem prova, pergunta (ou --sim) e desliga pela rota de controle.
    // dataFile: o database.db dessa pasta de dados. Devolve { ok, wasRunning, code }.
    async function stopForInstall(launcher, { sim, oQue, pergunta, nomeAntigo = null, dataFile = null }) {
        const found = await launcher.locate();
        if (found.state === 'desligado') {
            if (found.portBusy) out(`Atenção: a porta ${found.port} está sendo usada por outro programa.`);
            return { ok: true, wasRunning: false };
        }
        const { provas, unknown } = await examsOf(found, dataFile);
        if (provas.length) {
            const sentence = launcherCore.examsSentence(provas);
            const where = nomeAntigo ? `${sentence.replace(/\.$/, '')} ${nomeAntigo}.` : sentence;
            out(`${where} ${oQue} depois que ${provas.length === 1 ? 'ela terminar' : 'elas terminarem'}.`);
            return { ok: false, wasRunning: true, code: EXIT.ERROR, refused: true };
        }
        if (unknown) {
            out(`Não deu para conferir se há prova em andamento${nomeAntigo ? ` ${nomeAntigo}` : ''}${found.legacy ? ' (o servidor é de uma versão anterior do IClass)' : ''}. Desligar agora encerra a prova para os alunos.`);
            if (sim) {
                out('Com --sim, o IClass não desliga um servidor sem conferir as provas. Desligue ele quando não houver prova (ou rode sem --sim e confirme) e tente de novo. Nada foi feito.');
                return { ok: false, wasRunning: true, code: EXIT.ERROR, refused: true };
            }
            if (!(await confirm(`${pergunta} Só responda sim se não houver prova em andamento.`, { defaultYes: false }))) {
                out('Nada foi feito.');
                return { ok: false, wasRunning: true, code: EXIT.ERROR, cancelled: true };
            }
        } else if (!sim && !(await confirm(pergunta, { defaultYes: true }))) {
            out('Nada foi feito.');
            return { ok: false, wasRunning: true, code: EXIT.ERROR, cancelled: true };
        }
        const stopped = await launcher.parar({ sim: true, jaConfirmado: true });
        if (stopped.code !== EXIT.OK) {
            out('Não foi possível desligar o IClass. Nada foi feito.');
            return { ok: false, wasRunning: true, code: stopped.code || EXIT.ERROR };
        }
        return { ok: true, wasRunning: true };
    }

    // --- trazer os dados de uma pasta antiga (D24) -----------------------------------

    function bringChecks(oldRoot, root, pastas) {
        if (!isDirectory(oldRoot)) return `A pasta ${oldRoot} não existe.`;
        if (sameOrNested(oldRoot, root)) return `A pasta antiga (${oldRoot}) e a pasta da instalação (${root}) não podem ficar uma dentro da outra.`;
        const oldFolders = runtimePaths.resolveRuntimeFolders({ projectRoot: oldRoot, env: {} });
        if (!fs.existsSync(path.join(oldFolders.DATA_DIR, 'database.db'))) return `Não encontrei os dados do IClass em ${oldRoot} (falta ${path.join(oldFolders.DATA_DIR, 'database.db')}).`;
        const old = [oldFolders.DATA_DIR, oldFolders.CONTENT_DIR, oldFolders.ARCHIVE_DIR];
        const target = [pastas.dados, pastas.conteudo, pastas.cursosArquivados];
        if (target.some(dir => old.some(item => sameOrNested(dir, item)))) return 'As pastas da instalação não podem ficar dentro das pastas antigas (nem o contrário).';
        const busy = target.filter(dir => !isEmptyOrMissing(dir));
        if (busy.length) return `Já há arquivos em ${busy.join(', ')}: o IClass nunca copia por cima de dados que já existem. Para trazer os dados da pasta antiga, instale numa pasta nova (ou vazia).`;
        const undo = path.join(oldFolders.DATA_DIR, '.restauracao', 'desfazer', 'marcador.json');
        if (fs.existsSync(undo) && !fs.existsSync(path.join(oldFolders.DATA_DIR, '.restauracao', 'desfazer', 'concluida'))) {
            return 'Há uma restauração de backup interrompida na pasta antiga. Ligue o IClass antigo uma vez (ele desfaz a restauração sozinho), desligue e tente de novo.';
        }
        return { oldFolders };
    }

    async function bringData({ oldRoot, root, pastas, sim }) {
        const checked = bringChecks(oldRoot, root, pastas);
        if (typeof checked === 'string') {
            out(checked);
            return { ok: false, code: EXIT.ERROR };
        }
        const { oldFolders } = checked;
        // O IClass antigo (281029f, pelo ligarIclassV3.bat) desligado pela rota de controle.
        const oldLauncher = ctx.createLauncher({ ...options, projectRoot: oldRoot, folders: oldFolders, supervisorScript: undefined, backupCliScript: undefined, resetPasswordScript: undefined });
        const stopped = await stopForInstall(oldLauncher, {
            sim,
            oQue: 'Traga os dados',
            nomeAntigo: `no IClass de ${oldRoot}`,
            dataFile: path.join(oldFolders.DATA_DIR, 'database.db'),
            pergunta: `O IClass de ${oldRoot} está ligado. Para trazer os dados, ele precisa ser desligado (os dados dele ficam como estão). Desligar agora?`,
        });
        if (!stopped.ok) {
            out(`Nada foi copiado de ${oldRoot}.`);
            return { ok: false, code: stopped.code || EXIT.ERROR };
        }
        const staging = path.join(root, BRING_STAGING);
        fs.rmSync(staging, { recursive: true, force: true });
        const plan = [
            { from: oldFolders.DATA_DIR, to: pastas.dados, staged: path.join(staging, 'dados'), skip: skipOldData, nome: 'dados' },
            { from: oldFolders.CONTENT_DIR, to: pastas.conteudo, staged: path.join(staging, 'conteudo'), skip: () => false, nome: 'conteúdo' },
            { from: oldFolders.ARCHIVE_DIR, to: pastas.cursosArquivados, staged: path.join(staging, 'cursos-arquivados'), skip: () => false, nome: 'cursos arquivados' },
        ];
        out(`Copiando os dados de ${oldRoot} (a pasta antiga fica como está)...`);
        let files = 0;
        let bytes = 0;
        let tables = null;
        try {
            for (const item of plan) {
                if (!isDirectory(item.from)) continue;
                const copied = copyTree(item.from, item.staged, { skip: item.skip });
                const check = listTree(item.staged);
                if (!sameListing(copied, check) || !sameListing(copied, listTree(item.from, { skip: item.skip }))) {
                    throw new launcherCore.LauncherError(`A cópia de ${item.from} não bateu com o original (quantidade ou tamanho dos arquivos). Nada foi copiado.`);
                }
                files += copied.size;
                bytes += totalBytes(copied);
            }
            try {
                tables = (await inspectDatabase(path.join(staging, 'dados', 'database.db'))).tabelas;
            } catch (err) {
                throw new launcherCore.LauncherError(`O banco de dados de ${oldRoot} não passou na conferência (${(err && err.message) || err}). Nada foi copiado: restaure um backup no IClass antigo e tente de novo.`);
            }
            // Tudo conferido: só agora vai para as pastas da instalação.
            for (const item of plan) {
                if (!fs.existsSync(item.staged)) continue;
                fs.mkdirSync(path.dirname(item.to), { recursive: true });
                if (fs.existsSync(item.to)) fs.rmdirSync(item.to);
                fs.renameSync(item.staged, item.to);
            }
        } catch (err) {
            fs.rmSync(staging, { recursive: true, force: true });
            out(err instanceof launcherCore.LauncherError ? err.message : `Não foi possível copiar os dados de ${oldRoot}: ${(err && err.message) || err}. Nada foi copiado.`);
            return { ok: false, code: EXIT.ERROR };
        }
        fs.rmSync(staging, { recursive: true, force: true });
        const count = name => (tables && Number.isInteger(tables[name]) ? tables[name] : null);
        const parts = [`${files} arquivo${files === 1 ? '' : 's'} (${megabytes(bytes)} MB)`];
        if (count('students') !== null) parts.push(`${count('students')} aluno${count('students') === 1 ? '' : 's'} no banco`);
        out(`Dados trazidos e conferidos: ${parts.join(', ')}. O banco abriu sem problemas.`);
        if (stopped.wasRunning) out(`O IClass de ${oldRoot} ficou desligado. Se precisar voltar a ele, use o ligarIclassV3.bat daquela pasta: os dados dele estão como estavam.`);
        return { ok: true, files, bytes, tabelas: tables, oldRoot: path.resolve(oldRoot) };
    }

    // --- instalar e atualizar ---------------------------------------------------------

    function copyProgram(source, manifest, target) {
        const programa = path.dirname(target);
        const staging = path.join(programa, `${STAGING_PREFIX}${path.basename(target)}`);
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        try {
            Object.keys(manifest.arquivos).forEach(relative => {
                const parts = safeRelative(relative);
                copyFilePreserving(path.join(source, ...parts), path.join(staging, ...parts));
            });
            copyFilePreserving(path.join(source, MANIFEST_FILE), path.join(staging, MANIFEST_FILE));
            const problems = checkAgainstManifest(staging, manifest);
            if (problems.length) throw new launcherCore.LauncherError(`A cópia do programa não conferiu com o release-manifest.json: ${problems.join(', ')}. Nada foi trocado.`);
            if (fs.existsSync(target)) {
                const replaced = path.join(programa, `${REPLACED_PREFIX}${path.basename(target)}-${now()}`);
                fs.renameSync(target, replaced);
                fs.renameSync(staging, target);
                fs.rmSync(replaced, { recursive: true, force: true });
            } else {
                fs.renameSync(staging, target);
            }
        } catch (err) {
            fs.rmSync(staging, { recursive: true, force: true });
            throw err;
        }
    }

    // Guarda só as versões de keep (a atual e a anterior) e apaga as sobras de cópias
    // interrompidas. Só pasta de versão (com release-manifest.json) dentro de programa\.
    function pruneVersions(root, keep, { running = null } = {}) {
        const programa = path.join(root, PROGRAM_DIR);
        const removed = [];
        let entries = [];
        try { entries = fs.readdirSync(programa, { withFileTypes: true }); } catch (e) { return removed; }
        entries.forEach(entry => {
            if (!entry.isDirectory()) return;
            const dir = path.join(programa, entry.name);
            if (running && path.resolve(dir) === path.resolve(running)) return;
            if (entry.name.startsWith(STAGING_PREFIX) || entry.name.startsWith(REPLACED_PREFIX)) {
                fs.rmSync(dir, { recursive: true, force: true });
                return;
            }
            if (keep.includes(entry.name) || !parseVersion(entry.name) || !fs.existsSync(path.join(dir, MANIFEST_FILE))) return;
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                removed.push(entry.name);
            } catch (err) {
                out(`Não foi possível apagar a versão antiga ${entry.name} (${(err && err.code) || err}); ela fica em ${dir}.`);
            }
        });
        return removed;
    }

    function copyRootLaunchers(source, root) {
        ROOT_LAUNCHERS.forEach(name => {
            const file = path.join(source, name);
            if (fs.existsSync(file)) writeFileIfChanged(path.join(root, name), fs.readFileSync(file));
        });
    }

    // firewall: o que o instalar.ps1 conseguiu ('liberado' | 'recusado'), guardado no
    // iclass-instalacao.json para o suporte.
    async function instalar({ destino = null, trazerDe = null, sim = false, semIniciar = false, abrirNavegador = true, soAtualizar = false, firewall = null } = {}) {
        const source = path.resolve(projectRoot);
        const release = readReleaseManifest(source);
        if (!release.ok) {
            out(release.motivo === 'sem-manifesto'
                ? 'Este comando só funciona a partir da pasta do pacote do IClass (falta o release-manifest.json). Baixe o pacote do IClass, extraia o ZIP e rode "Instalar IClass.cmd".'
                : 'O release-manifest.json deste pacote está ilegível. Baixe o pacote do IClass de novo.');
            return { code: EXIT.CONFIG };
        }
        const versao = release.versao;
        const here = installationContext(source);
        if (here) {
            out(`Esta é a versão ${versao} já instalada em ${here.root}. Para atualizar, rode "Instalar IClass.cmd" da pasta do pacote novo.`);
            return { code: soAtualizar ? EXIT.ERROR : EXIT.OK, already: true };
        }
        const broken = checkAgainstManifest(source, release.manifest);
        if (broken.length) {
            out(`O pacote está incompleto ou foi alterado: ${broken.join(', ')}. Extraia o ZIP do IClass de novo (o antivírus pode ter apagado algum arquivo) e tente outra vez.`);
            return { code: EXIT.CONFIG };
        }
        const root = path.resolve(destino || defaultRoot());
        if (isInside(root, source)) {
            out(`A pasta da instalação (${root}) não pode ficar dentro da pasta do pacote baixado (${source}). Escolha outra pasta, como ${defaultRoot()}.`);
            return { code: EXIT.ERROR };
        }
        const target = programDirOf(root, versao);
        if (sameOrNested(target, source)) {
            out(`A pasta do pacote (${source}) não pode ficar dentro de ${path.join(root, PROGRAM_DIR)}. Extraia o ZIP em outra pasta (como Downloads) e rode de novo.`);
            return { code: EXIT.ERROR };
        }
        const installation = readInstallation(root);
        if (installation && installation.unreadable) out(`Atenção: o ${INSTALL_INFO_FILE} de ${root} está ilegível; ele vai ser refeito.`);
        const existing = installation ? installation.versaoAtual : null;
        if (soAtualizar && !existing) {
            out(`Não há IClass instalado em ${root}. Para instalar, rode "Instalar IClass.cmd" (ou o comando instalar).`);
            return { code: EXIT.ERROR };
        }
        const pastas = foldersOfInstallation(root, installation);
        if ([pastas.dados, pastas.conteudo, pastas.cursosArquivados].some(dir => isInside(dir, path.join(root, PROGRAM_DIR)) || isInside(dir, source))) {
            out('As pastas de dados não podem ficar dentro da pasta do programa (ela é trocada a cada atualização). Nada foi feito.');
            return { code: EXIT.ERROR };
        }
        if (existing && compareVersions(versao, existing) < 0) {
            out(`A versão instalada em ${root} (${existing}) é mais nova que este pacote (${versao}). Nada foi feito. Para voltar de versão, use a opção [V] (Voltar para a versão anterior) do menu do IClass.`);
            return { code: EXIT.ERROR, refused: true };
        }
        if (trazerDe && (existing || fs.existsSync(path.join(pastas.dados, 'database.db')))) {
            out(`Já há um IClass com dados em ${root}: os dados da pasta antiga só vêm numa instalação nova. Nada foi feito.`);
            return { code: EXIT.ERROR, refused: true };
        }
        const same = existing === versao;
        const needsCopy = !same || checkAgainstManifest(target, release.manifest, { limit: 1 }).length > 0;
        const kind = !existing ? 'nova' : (same ? 'mesma' : 'atualizacao');

        // O IClass instalado precisa estar desligado para trocar o programa.
        let wasRunning = false;
        if (existing && needsCopy) {
            const current = launcherFor(programDirOf(root, existing), { folders: runtimeFoldersOf(pastas) });
            const stopped = await stopForInstall(current, {
                sim,
                dataFile: path.join(pastas.dados, 'database.db'),
                oQue: same ? 'Repare a instalação' : 'Atualize',
                pergunta: same
                    ? `Os arquivos do IClass ${versao} instalado estão incompletos e vão ser copiados de novo. Para isso o IClass fica desligado por alguns instantes. Continuar?`
                    : `Atualizar o IClass de ${existing} para ${versao}? Ele fica desligado por alguns instantes e liga de novo na versão nova (os dados ficam onde estão, e antes de atualizar os dados o IClass faz um backup deles).`,
            });
            if (!stopped.ok) return { code: stopped.code || EXIT.ERROR, refused: stopped.refused === true, cancelled: stopped.cancelled === true };
            wasRunning = stopped.wasRunning;
        } else if (!existing && fs.existsSync(path.join(pastas.dados, 'database.db'))) {
            out(`Os dados que já estavam em ${pastas.dados} continuam valendo (nada é apagado nem copiado por cima).`);
        }

        let brought = null;
        if (trazerDe) {
            brought = await bringData({ oldRoot: path.resolve(trazerDe), root, pastas, sim });
            if (!brought.ok) return { code: brought.code || EXIT.ERROR };
        }

        try {
            if (needsCopy) {
                out(kind === 'atualizacao' ? `Copiando o IClass ${versao} para ${target}...` : `Instalando o IClass ${versao} em ${root}...`);
                copyProgram(source, release.manifest, target);
            }
            writeJsonIfChanged(path.join(target, FOLDERS_FILE), foldersFileFor(target, root, pastas));
            [pastas.dados, pastas.conteudo, pastas.cursosArquivados].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
            writeFileIfChanged(path.join(root, PROGRAM_DIR, POINTER_FILE), versao);
            copyRootLaunchers(source, root);
        } catch (err) {
            out(err instanceof launcherCore.LauncherError ? err.message : `Não foi possível copiar o IClass para ${root}: ${(err && err.message) || err}. Os dados não foram tocados.`);
            if (wasRunning && existing) {
                out(`Ligando de novo o IClass ${existing}...`);
                await launcherFor(programDirOf(root, existing), { folders: runtimeFoldersOf(pastas) }).iniciar({ abrirNavegador: false });
            }
            return { code: EXIT.ERROR };
        }

        const previous = kind === 'atualizacao' ? existing : ((installation && installation.info && parseVersion(installation.info.versaoAnterior) && installation.info.versaoAnterior !== versao) ? installation.info.versaoAnterior : null);
        const keep = [previous, versao].filter(Boolean).filter(item => fs.existsSync(programDirOf(root, item)));
        const removed = pruneVersions(root, keep);
        const oldInfo = (installation && installation.info) || {};
        const info = {
            produto: 'IClass',
            formato: 1,
            raiz: root,
            versaoAtual: versao,
            versaoAnterior: keep.includes(previous) ? previous : null,
            versoes: keep,
            instaladoEm: oldInfo.instaladoEm || isoNow(),
            atualizadoEm: kind === 'atualizacao' ? isoNow() : (oldInfo.atualizadoEm || null),
            ligarComWindows: oldInfo.ligarComWindows === true,
            firewall: firewallInfo(oldInfo.firewall, firewall, versao),
            pastas,
            ...(oldInfo.trazidoDe ? { trazidoDe: oldInfo.trazidoDe } : {}),
            ...(brought ? { trazidoDe: { pasta: brought.oldRoot, em: isoNow(), arquivos: brought.files, bytes: brought.bytes } } : {}),
            // A última volta de versão fica no registro (também depois de atualizar de novo):
            // o [V] não usa o registro de uma atualização que essa volta já desfez.
            ...(oldInfo.voltouEm ? { voltouEm: oldInfo.voltouEm } : {}),
        };
        const infoChanged = writeJsonIfChanged(path.join(root, INSTALL_INFO_FILE), info);
        if (removed.length) out(`Versões antigas apagadas (ficam só as duas últimas): ${removed.join(', ')}.`);

        if (kind === 'mesma' && !needsCopy && !infoChanged) out(`O IClass ${versao} já está instalado em ${root}. Nada mudou.`);
        else if (kind === 'mesma') out(`IClass ${versao} conferido em ${root}.`);
        else if (kind === 'atualizacao') out(`IClass atualizado de ${existing} para ${versao}. A versão ${existing} fica guardada: para voltar a ela, use a opção [V] do menu.`);
        else out(`IClass ${versao} instalado em ${root}. Os dados ficam em ${pastas.dados}.`);

        const result = { code: EXIT.OK, kind, root, versao, previous: info.versaoAnterior, changed: needsCopy || infoChanged, removed, trazido: brought };
        if (semIniciar && !wasRunning) return result;
        const installed = launcherFor(target, { folders: runtimeFoldersOf(pastas) });
        if (kind === 'atualizacao') out('Na primeira vez, a versão nova faz um backup dos dados e depois atualiza os dados para esta versão: pode levar alguns minutos.');
        const started = await startOfferingSkip(installed, { abrirNavegador: abrirNavegador && !semIniciar, pastas });
        return { ...result, code: started.code, started };
    }

    // Liga a versão instalada. Se o backup de antes de atualizar os dados falhou (sem
    // espaço, disco com problema), oferece atualizar sem ele, só com a pessoa dizendo que
    // sim (D4 do P6: ICLASS_ATUALIZAR_SEM_BACKUP=1, registrado na auditoria). O --sim não
    // responde esta pergunta.
    async function startOfferingSkip(launcher, { abrirNavegador, minimizado = false, pastas }) {
        const logFile = path.join(pastas.dados, 'logs', 'servidor.log');
        let offset = 0;
        try { offset = fs.statSync(logFile).size; } catch (e) { offset = 0; }
        const started = await launcher.iniciar({ abrirNavegador, minimizado });
        // Ligado junto com o Windows (janela minimizada): ninguém está olhando para
        // responder; o aviso e o próximo passo já ficaram na janela.
        if (minimizado) return started;
        if (started.code !== EXIT.CONFIG) return started;
        const tail = launcherCore.readLogTail(logFile, offset, 60).join('\n');
        if (!/backup antes de atualizar os dados/i.test(tail)) return started;
        out('');
        out('O IClass não conseguiu fazer o backup dos dados antes de atualizar, e nada foi alterado.');
        out('O melhor é liberar espaço no disco e ligar de novo. Atualizar sem o backup funciona, mas aí não há como voltar para a versão anterior com os dados de antes.');
        const answer = await ask('Atualizar os dados SEM o backup de antes? Digite SIM para continuar (Enter: não): ');
        if (String(answer || '').trim().toUpperCase() !== 'SIM') {
            out('Nada foi alterado. Libere espaço e ligue o IClass de novo.');
            return started;
        }
        return launcher.iniciar({ abrirNavegador, extraEnv: { ICLASS_ATUALIZAR_SEM_BACKUP: '1' } });
    }

    // O "Ligar" do menu e o comando iniciar: o mesmo ligar, com a mesma oferta de
    // atualizar sem o backup quando ele falhou (o instalar.ps1 liga por aqui no fim).
    function iniciarOferecendo(launcher, { abrirNavegador = true, minimizado = false } = {}) {
        return startOfferingSkip(launcher, { abrirNavegador, minimizado, pastas: { dados: launcher.folders.DATA_DIR } });
    }

    function firewallInfo(previous, estado, versao) {
        const old = previous && typeof previous === 'object' ? previous : null;
        if (!estado || !['liberado', 'recusado'].includes(estado)) return old;
        const porta = Number(ctx.defaultPort) || launcherCore.DEFAULT_PORT;
        if (old && old.estado === estado && old.porta === porta && old.versao === versao) return old;
        return { estado, porta, versao, em: isoNow() };
    }

    async function atualizar(params = {}) {
        return instalar({ ...params, soAtualizar: true });
    }

    // --- voltar para a versão anterior (X7) -------------------------------------------

    function readUpdates(dataDir) {
        const { value } = readJsonFile(path.join(dataDir, 'backups', UPDATES_FILE));
        return value && Array.isArray(value.atualizacoes) ? value.atualizacoes.filter(item => item && typeof item === 'object') : null;
    }

    // A atualização mais recente para versao, entre as das listas, feita depois de since (ms).
    function lastUpdateTo(lists, versao, since = 0) {
        const matches = lists
            .flatMap(list => (Array.isArray(list) ? list : []))
            .filter(item => item && item.para === versao && !(since && Number(item.em) <= since));
        if (!matches.length) return null;
        return matches.reduce((best, item) => (Number(item.em) >= Number(best.em) ? item : best));
    }

    // Como voltar: { mode: 'restaurar', entry, file } | { mode: 'ponteiro', entry, motivo }
    // | { refuse: texto } | { unknown: true } (sem o banco lido: decidir com ele parado).
    // meta: o schemaMeta do banco (a fonte que vale); updates: o atualizacoes.json (cópia
    // que o servidor grava depois do boot; pode ter ficado para trás, e o histórico de uma
    // atualização desfeita fica nos dois depois da volta). since: a última volta de versão
    // (iclass-instalacao.json voltouEm): registro de antes dela é de atualização desfeita.
    // Rodada de ajuste 1: antes, a última entrada "para a versão atual" do atualizacoes.json
    // bastava. Depois de uma volta, de uma nova atualização e de a versão nova nunca abrir
    // os dados (backup de antes que falhou, IClass não ligado), o [V] restaurava o backup da
    // primeira atualização e jogava fora o que foi feito na versão anterior desde a volta.
    function rollbackPlan({ updates, meta, current, previous, dataDir, since = 0 }) {
        if (meta) {
            // A versão que abriu estes dados por último é a que vale: se não é a atual, a
            // atual nunca chegou a abrir estes dados (ou o que ela fez já foi desfeito).
            if (meta.versaoApp !== current) {
                if (parseVersion(meta.versaoApp) && compareVersions(meta.versaoApp, previous) > 0) {
                    return { refuse: `Os dados foram abertos por último pela versão ${meta.versaoApp}, mais nova que a ${previous} guardada. Nada foi feito.` };
                }
                return { mode: 'ponteiro', entry: null, motivo: 'nunca-abriu' };
            }
        }
        const entry = lastUpdateTo(meta ? [meta.atualizacoes, updates] : [updates], current, since);
        if (!entry) {
            if (meta) return { refuse: `Não encontrei o registro da atualização para a versão ${current} nos dados. Para voltar, restaure um backup pela opção [5] (Restaurar um backup).` };
            return { unknown: true };
        }
        if (entry.instalacaoNova) return { refuse: `Os dados foram criados pela versão ${current} (instalação nova): não há dados de uma versão anterior para voltar.` };
        if (entry.de && parseVersion(entry.de) && compareVersions(entry.de, previous) > 0) {
            return { refuse: `A atualização para a versão ${current} veio da versão ${entry.de}, mais nova que a ${previous} guardada. Nada foi feito.` };
        }
        const migrated = Array.isArray(entry.migracoes) && entry.migracoes.length > 0;
        if (!migrated && !entry.backup) return { mode: 'ponteiro', entry, motivo: 'sem-migracao' };
        if (entry.semBackup || !entry.backup) {
            return { refuse: `A atualização para a versão ${current} foi feita sem o backup de antes, então não há como voltar com os dados daquele momento. Para voltar, restaure um backup feito antes da atualização pela opção [5] (Restaurar um backup).` };
        }
        const name = path.basename(String(entry.backup));
        const file = path.join(dataDir, 'backups', name);
        if (!fs.existsSync(file)) {
            return { refuse: `O backup de antes da atualização (${name}) não está mais em ${path.join(dataDir, 'backups')}. Copie ele de volta para essa pasta (ou do destino externo do backup) e tente de novo, ou restaure outro backup pela opção [5].` };
        }
        return { mode: 'restaurar', entry, file };
    }

    function describePlan(plan, { current, previous }) {
        if (plan.mode === 'restaurar') {
            const when = dateText(plan.entry.em);
            return [
                `Voltar para a versão ${previous}: o IClass faz um backup de agora, restaura o backup de antes da atualização (${path.basename(plan.file)}${when ? `, de ${when}` : ''}) e liga na versão ${previous}.`,
                `O que foi feito depois da atualização para a ${current} (notas, presença, provas) não fica nos dados restaurados: só no backup de agora.`,
            ];
        }
        if (plan.motivo === 'nunca-abriu') {
            return [`Voltar para a versão ${previous}: a versão ${current} ainda não abriu estes dados (a atualização não chegou a ligar), então a versão ${previous} abre os dados de agora, sem restaurar nada (antes, o IClass faz um backup de agora).`];
        }
        return [`Voltar para a versão ${previous}: a versão ${current} não mudou o formato dos dados, então a versão ${previous} abre os dados de agora, sem restaurar nada (antes, o IClass faz um backup de agora).`];
    }

    async function voltarVersao({ sim = false, abrirNavegador = true } = {}) {
        const here = installationContext(projectRoot);
        if (!here) {
            out('Voltar para a versão anterior só existe na instalação pelo pacote do IClass. Na pasta do git, use o backup de antes da atualização (Sistema > Backup) com a versão antiga.');
            return { code: EXIT.ERROR };
        }
        const { root, info } = here;
        const current = here.versaoAtual || here.versao;
        const previous = parseVersion(info.versaoAnterior) ? info.versaoAnterior : null;
        const previousDir = previous ? programDirOf(root, previous) : null;
        if (!previous || !fs.existsSync(path.join(previousDir, 'backend', 'scripts', 'backup-cli.js'))) {
            out('Não há uma versão anterior guardada nesta instalação. Nada foi feito.');
            return { code: EXIT.ERROR, refused: true };
        }
        if (compareVersions(previous, current) >= 0) {
            out(`A outra versão guardada (${previous}) não é anterior à atual (${current}). Para usar a versão ${previous}, rode "Instalar IClass.cmd" do pacote dela.`);
            return { code: EXIT.ERROR, refused: true };
        }
        const pastas = foldersOfInstallation(root, here);
        const folders = runtimeFoldersOf(pastas);
        const currentLauncher = launcherFor(programDirOf(root, current), { folders });
        const previousLauncher = launcherFor(previousDir, { folders });
        const dataDir = pastas.dados;
        const dataFile = path.join(dataDir, 'database.db');
        const updates = readUpdates(dataDir);
        const since = Date.parse(info.voltouEm || '') || 0;
        // O banco (só leitura: dá com o servidor ligado) diz qual versão abriu os dados por
        // último; sem ele agora, a decisão fica para depois de desligar.
        const readMeta = async () => { try { return await readSchema(dataFile); } catch (err) { return null; } };
        let meta = await readMeta();
        let plan = rollbackPlan({ updates, meta, current, previous, dataDir, since });

        const found = await currentLauncher.locate();
        const wasRunning = found.state !== 'desligado';
        const exams = wasRunning ? await examsOf(found, dataFile) : await (async () => {
            // Desligado, mas o banco com prova em andamento (a janela fechada no meio da
            // prova): restaurar jogaria fora as respostas dela.
            try { return { provas: await readExams(dataFile), unknown: false, doBanco: true }; } catch (err) { return { provas: [], unknown: false }; }
        })();
        if (exams.provas.length) {
            out(`${launcherCore.examsSentence(exams.provas)} Volte de versão depois que ${exams.provas.length === 1 ? 'ela terminar' : 'elas terminarem'}.`);
            if (!wasRunning) {
                out(exams.provas.length === 1
                    ? 'O IClass está desligado, mas a prova ficou em andamento nos dados (ele foi fechado no meio dela). Ligue o IClass, encerre a prova pelo painel e tente de novo.'
                    : 'O IClass está desligado, mas as provas ficaram em andamento nos dados (ele foi fechado no meio delas). Ligue o IClass, encerre as provas pelo painel e tente de novo.');
            }
            return { code: EXIT.ERROR, refused: true };
        }
        if (plan.refuse) {
            out(plan.refuse);
            return { code: EXIT.ERROR, refused: true };
        }
        if (!plan.unknown) describePlan(plan, { current, previous }).forEach(line => out(line));
        else out(`Voltar para a versão ${previous}: o IClass desliga, confere os dados e diz o que precisa fazer antes de mudar qualquer coisa.`);
        if (exams.unknown) {
            out('Não deu para conferir se há prova em andamento. Desligar agora encerra a prova para os alunos.');
            if (sim) {
                out('Com --sim, o IClass não volta de versão sem conferir as provas. Tente de novo quando não houver prova (ou rode sem --sim e confirme). Nada foi feito.');
                return { code: EXIT.ERROR, refused: true };
            }
        }
        if (!sim && !(await confirm(exams.unknown ? 'Continuar? Só responda sim se não houver prova em andamento.' : 'Continuar?'))) {
            out('Nada foi feito.');
            return { code: EXIT.ERROR, cancelled: true };
        }
        if (wasRunning) {
            const stopped = await currentLauncher.parar({ sim: true, jaConfirmado: true });
            if (stopped.code !== EXIT.OK) {
                out('Não foi possível desligar o IClass. Nada foi feito.');
                return { code: stopped.code || EXIT.ERROR };
            }
        }
        const restartCurrent = async () => {
            if (!wasRunning) return;
            out(`Ligando de novo o IClass ${current}...`);
            await currentLauncher.iniciar({ abrirNavegador: false });
        };
        if (plan.unknown) {
            meta = await readMeta();
            plan = meta ? rollbackPlan({ updates, meta, current, previous, dataDir, since }) : { refuse: 'Não deu para ler a versão dos dados. Para voltar, restaure um backup pela opção [5] (Restaurar um backup).' };
            if (plan.refuse) {
                out(plan.refuse);
                await restartCurrent();
                return { code: EXIT.ERROR, refused: true };
            }
            describePlan(plan, { current, previous }).forEach(line => out(line));
        } else if (wasRunning) {
            // Com o servidor desligado, o banco lido de novo tem que dizer a mesma coisa (o
            // boot de uma versão que estava ligando pode ter mudado os dados no meio).
            const freshMeta = (await readMeta()) || meta;
            const fresh = rollbackPlan({ updates: readUpdates(dataDir), meta: freshMeta, current, previous, dataDir, since });
            if (fresh.refuse || fresh.mode !== plan.mode || fresh.file !== plan.file) {
                out(fresh.refuse || 'Os dados mudaram enquanto o IClass desligava. Nada foi trocado: confira e tente de novo.');
                await restartCurrent();
                return { code: EXIT.ERROR, refused: true };
            }
        }
        out('Fazendo o backup de agora (com o que foi feito até aqui)...');
        const backupCode = await run({ nodePath: nodeFor(programDirOf(root, current)), script: path.join(programDirOf(root, current), 'backend', 'scripts', 'backup-cli.js'), args: ['criar'], cwd: programDirOf(root, current), env: envFor(pastas) });
        if (backupCode !== EXIT.OK) {
            out('Não foi possível fazer o backup de agora. Nada foi trocado.');
            await restartCurrent();
            return { code: EXIT.ERROR };
        }
        if (plan.mode === 'restaurar') {
            out(`Restaurando o backup de antes da atualização com a versão ${previous}...`);
            const restoreCode = await run({ nodePath: nodeFor(previousDir), script: path.join(previousDir, 'backend', 'scripts', 'backup-cli.js'), args: ['restaurar', plan.file, '--sim'], cwd: previousDir, env: envFor(pastas) });
            if (restoreCode !== EXIT.OK) {
                out(`A restauração não deu certo. Nada foi trocado: o IClass continua na versão ${current}, com os dados de agora.`);
                await restartCurrent();
                return { code: EXIT.ERROR };
            }
        }
        writeFileIfChanged(path.join(root, PROGRAM_DIR, POINTER_FILE), previous);
        writeJsonIfChanged(path.join(root, INSTALL_INFO_FILE), { ...info, versaoAtual: previous, versaoAnterior: current, voltouEm: isoNow() });
        out(`Pronto: o IClass voltou para a versão ${previous}. A versão ${current} fica guardada.`);
        const started = await previousLauncher.iniciar({ abrirNavegador: abrirNavegador && !sim });
        return { code: started.code, mode: plan.mode, previous, current, started };
    }

    function envFor(pastas) {
        const env = { ...baseEnv, ICLASS_DATA_DIR: pastas.dados, ICLASS_CONTENT_DIR: pastas.conteudo, ICLASS_ARCHIVE_DIR: pastas.cursosArquivados };
        if (ctx.defaultPort) env.PORT = String(ctx.defaultPort);
        return env;
    }

    // --- ligar junto com o Windows (D13) ----------------------------------------------

    function startupShortcutFile() {
        const appData = baseEnv.APPDATA;
        if (!appData) return null;
        return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', STARTUP_SHORTCUT);
    }

    function startupState() {
        const here = installationContext(projectRoot);
        if (!here || platform !== 'win32') return { disponivel: false, ligado: false };
        const file = startupShortcutFile();
        return { disponivel: !!file, ligado: !!file && shortcut.exists(file), file, root: here.root };
    }

    async function ligarComWindows({ ligar = true } = {}) {
        if (platform !== 'win32') {
            out('Ligar junto com o Windows só existe no Windows.');
            return { code: EXIT.ERROR };
        }
        const here = installationContext(projectRoot);
        if (!here) {
            out('Ligar junto com o Windows só existe na instalação pelo pacote do IClass.');
            return { code: EXIT.ERROR };
        }
        const file = startupShortcutFile();
        if (!file) {
            out('Não encontrei a pasta Inicializar do Windows (falta a variável APPDATA).');
            return { code: EXIT.ERROR };
        }
        try {
            if (ligar) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                shortcut.create({ file, target: path.join(here.root, 'IClass.cmd'), args: STARTUP_ARGS, workdir: here.root, description: 'Liga o IClass junto com o Windows' });
            } else {
                shortcut.remove(file);
            }
        } catch (err) {
            out(`Não foi possível ${ligar ? 'criar' : 'apagar'} o atalho em ${path.dirname(file)}: ${(err && err.message) || err}`);
            return { code: EXIT.ERROR };
        }
        writeJsonIfChanged(path.join(here.root, INSTALL_INFO_FILE), { ...here.info, ligarComWindows: ligar });
        out(ligar
            ? 'Pronto: o IClass liga sozinho (minimizado, sem abrir o navegador) quando você entrar no Windows.'
            : 'Pronto: o IClass não liga mais junto com o Windows.');
        return { code: EXIT.OK, ligado: ligar, file };
    }

    // --- desinstalar ------------------------------------------------------------------

    // Desliga (com prova em andamento, recusa), tira o atalho do Inicializar e pergunta pelos
    // dados: ficam, a não ser que a pessoa digite APAGAR (e só as pastas de dados dentro da
    // raiz). O programa sai aqui fora do Windows; no Windows, pelo desinstalar.ps1, junto
    // com os atalhos, o firewall e o registro.
    async function desinstalar({ sim = false } = {}) {
        const here = installationContext(projectRoot);
        if (!here) {
            out('Desinstalar só existe na instalação pelo pacote do IClass.');
            return { code: EXIT.ERROR };
        }
        const { root } = here;
        const pastas = foldersOfInstallation(root, here);
        const current = launcherFor(projectRoot, { folders: runtimeFoldersOf(pastas) });
        const stopped = await stopForInstall(current, { sim, dataFile: path.join(pastas.dados, 'database.db'), oQue: 'Desinstale', pergunta: `Desinstalar o IClass de ${root}? Ele vai ser desligado.` });
        if (!stopped.ok) return { code: stopped.code || EXIT.ERROR };
        if (!stopped.wasRunning && !sim && !(await confirm(`Desinstalar o IClass de ${root}?`))) {
            out('Nada foi feito.');
            return { code: EXIT.ERROR, cancelled: true };
        }
        const inside = [pastas.dados, pastas.conteudo, pastas.cursosArquivados].filter(dir => isInside(dir, root) && path.resolve(dir) !== path.resolve(root));
        const outside = [pastas.dados, pastas.conteudo, pastas.cursosArquivados].filter(dir => !inside.includes(dir));
        out(`Os dados do IClass (alunos, provas, notas, apostilas e backups) ficam em: ${[pastas.dados, pastas.conteudo, pastas.cursosArquivados].join(', ')}.`);
        out('Para instalar de novo depois e continuar com eles, instale na mesma pasta.');
        let apagarDados = false;
        if (!sim) {
            const answer = await ask('Para apagar TAMBÉM os dados (sem volta), digite APAGAR. Para manter os dados, só Enter: ');
            apagarDados = String(answer || '').trim() === 'APAGAR';
        }
        if (platform === 'win32') {
            const file = startupShortcutFile();
            if (file && shortcut.exists(file)) {
                try { shortcut.remove(file); } catch (err) { out(`Não foi possível apagar o atalho ${file}: ${(err && err.message) || err}`); }
            }
        }
        const removedData = [];
        if (apagarDados) {
            inside.forEach(dir => {
                fs.rmSync(dir, { recursive: true, force: true });
                removedData.push(dir);
            });
            if (outside.length) out(`Estas pastas ficam fora de ${root} e não foram apagadas: ${outside.join(', ')}.`);
        }
        // No Windows, o desinstalar.ps1 apaga o programa, o iclass-instalacao.json e os
        // lançadores depois que este Node sai (a pasta do node.exe em uso fica travada até
        // lá, e o .ps1 ainda lê o versao-atual.txt para achar este launcher). Nos outros
        // sistemas sai tudo aqui.
        if (platform !== 'win32') {
            const programa = path.join(root, PROGRAM_DIR);
            let entries = [];
            try { entries = fs.readdirSync(programa, { withFileTypes: true }); } catch (e) { entries = []; }
            entries.forEach(entry => {
                const dir = path.join(programa, entry.name);
                if (entry.isDirectory() && (parseVersion(entry.name) || entry.name.startsWith(STAGING_PREFIX) || entry.name.startsWith(REPLACED_PREFIX))) fs.rmSync(dir, { recursive: true, force: true });
            });
            fs.rmSync(path.join(programa, POINTER_FILE), { force: true });
            try { if (fs.readdirSync(programa).length === 0) fs.rmdirSync(programa); } catch (e) { /* já saiu */ }
            fs.rmSync(path.join(root, INSTALL_INFO_FILE), { force: true });
            ROOT_LAUNCHERS.forEach(name => fs.rmSync(path.join(root, name), { force: true }));
        }
        out(apagarDados ? 'IClass desinstalado, com os dados apagados.' : `IClass desinstalado. Os dados continuam em ${root}.`);
        return { code: EXIT.OK, root, apagouDados: apagarDados, removedData, kept: apagarDados ? outside : [pastas.dados, pastas.conteudo, pastas.cursosArquivados] };
    }

    return {
        atualizar,
        desinstalar,
        iniciarOferecendo,
        installationContext,
        instalar,
        ligarComWindows,
        startupState,
        voltarVersao,
        defaultRoot,
    };
}

module.exports = {
    INSTALL_INFO_FILE,
    MANIFEST_FILE,
    POINTER_FILE,
    PROGRAM_DIR,
    SKIPPED_DATA_DIRS,
    STARTUP_ARGS,
    checkAgainstManifest,
    compareVersions,
    createInstallActions,
    createWindowsShortcut,
    inspectCopiedDatabase,
    listTree,
    parseVersion,
    readDataExams,
    readReleaseManifest,
    skipOldData,
};
