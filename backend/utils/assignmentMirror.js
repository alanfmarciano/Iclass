// ---------------------------------------------------------------------------
// Espelho dos arquivos das entregas no destino externo e o cartão Armazenamento (fase 3,
// C11 / P1-i; FUN-01, decisões D3 e D4 do P1, P-ALAN-1 'A', contrato C7 do P1 e
// ordem_no_createApp.timers do plano).
//
// data/entregas fica fora de todo ZIP de backup (D3: dezenas de GB por semestre). A
// proteção dos arquivos é este espelho, no mesmo pendrive ou HD do backup:
// <destino>/IClass-<computador>/entregas/, com a mesma árvore de data/entregas (as
// tarefas e data/entregas/_cursos_arquivados; .recebendo nunca) e o espelho.json da
// última conferência (tamanho e SHA-256 de cada arquivo copiado).
// - Roda dentro do runBackupJob (backup diário e "Fazer backup agora"), depois da cópia
//   externa e com a mesma trava do backup; a falha dele nunca derruba o backup (estado
//   próprio 'espelho' em data/backups/estado.json, alerta na fila do administrador).
// - Incremental: copia só o arquivo que o destino ainda não tem (arquivo de entrega nunca
//   muda: cada reenvio é versão nova). Cada cópia vai para <nome>.iclass-parcial, é relida
//   do destino e conferida pelo SHA-256 da origem antes de ganhar o nome final; o
//   espelho.json guarda tamanho, SHA-256 e a data de gravação da cópia no destino. Cópia
//   com o mesmo tamanho e a mesma data de gravação do espelho.json não é relida, a não ser
//   pela releitura de rodízio (até 256 MB por espelhamento, as conferidas há mais tempo
//   primeiro). A que foi mexida no destino (outra data de gravação) ou que não está no
//   espelho.json (perdido, outro computador) é conferida pelo SHA-256 do registro. A que
//   não confere (pendrive tirado no meio, byte trocado) é refeita, mas só com um arquivo
//   daqui que confere com o registro (D3: o espelho nunca troca a cópia boa).
// - O registro manda: o arquivo daqui que não confere com o SHA-256 do registro (disco
//   estragado, programa que regravou, ransomware) nunca vai para o destino, nem por cima
//   de uma cópia que lá existe. Ele é percebido pelo tamanho diferente do registro, ao
//   copiar (a cópia não ganha o nome final) e na releitura de rodízio (que relê também o
//   daqui); fica em estado.json -> espelho.diferentes, no cartão e na fila. Sem SHA-256 no
//   registro (arquivo sem registro), vale o arquivo daqui, o único que há.
// - Espaço: antes de copiar, o livre no destino precisa caber o que falta copiar mais uma
//   folga; sem espaço, nada é copiado e o motivo vai para o estado.
// - Remoção só por ordem explícita (D4): o arquivo com lápide (assignmentFileTombstones:
//   anonimizar, apagar de vez, excluir a tarefa ou o pacote do curso) sai do destino, nos
//   dois caminhos da lápide (storedRel e archivedRel), e não é copiado de novo. A lápide
//   não vale para um caminho (a cópia fica e a lápide espera) quando o arquivo está neste
//   computador naquele caminho e um registro vivo aponta para ele, nem, na lápide do
//   pacote de curso excluído, quando uma entrega viva do banco registra aquele caminho,
//   esteja o arquivo aqui ou não (curso restaurado cujo pacote que sobrou foi excluído
//   depois). Arquivo sem registro (depois de restaurar um backup antigo) é copiado e nunca
//   apagado.
// - Recuperar (POST /api/admin/backup/entregas/recuperar, só administrador): traz de
//   volta para data/entregas os arquivos registrados que faltam aqui, conferindo o SHA-256
//   do registro; procura na pasta deste computador e, no computador trocado, nas pastas
//   IClass-* de outros computadores no mesmo destino; nunca traz arquivo com lápide e só
//   substitui o arquivo daqui que não confere com o registro (ele vai para a lixeira).
// - Cartão Armazenamento (GET /api/admin/storage): tamanho e quantidade dos arquivos,
//   os sem registro, os registrados que faltam aqui, os daqui diferentes do registro e a
//   situação do espelho. Fila do administrador: trabalhos sem cópia fora deste
//   computador, arquivo daqui diferente do registro, falha do espelho e pouco espaço no
//   disco para receber entregas.
// - Prévia da restauração: as tarefas e entregas de hoje que o backup não tem.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const runtimePaths = require('../runtimePaths.js');
const store = require('./backupStore.js');
const settingsUtil = require('./settings.js');
const { renameWithRetry } = require('./backupArchive.js');
const { resolveInside, assertInside } = require('./safePath.js');
const { logError } = require('./errorLog.js');
const assignmentLifecycle = require('./assignmentLifecycle.js');
const fileStore = require('./storage.js');

const MB = 1024 * 1024;
const MIRROR_SEGMENT = 'entregas';
const MANIFEST_FILE = 'espelho.json';
const PARTIAL_SUFFIX = '.iclass-parcial';
const RECEIVING_SEGMENT = path.basename(runtimePaths.ASSIGNMENT_RECEIVING_DIR);
// Folga no destino além do que falta copiar (a mesma da cópia externa do backup).
const FREE_MARGIN_BYTES = 64 * MB;
// O espelho.json é regravado a cada tantos arquivos copiados (pendrive tirado no meio não
// perde a conta do que já foi).
const MANIFEST_FLUSH_EVERY = 100;
// Releitura de rodízio: quanto das cópias já conferidas é relido do destino a cada
// espelhamento (as conferidas há mais tempo primeiro). ~10 s num pendrive USB 2.0.
const ROLLING_VERIFY_BYTES = 256 * MB;
// Profundidade da árvore: _cursos_arquivados/<pasta>/<tarefa>/<entrega>/<arquivo>.
const MAX_DEPTH = 6;
// Resumo dos arquivos deste computador guardado para a fila (que pergunta a cada visita
// ao Dashboard); o cartão Armazenamento sempre lê de novo.
const LOCAL_SUMMARY_MAX_AGE_MS = 60 * 1000;
const UNREACHABLE_MESSAGE = 'O destino externo não está acessível (pendrive ou HD desconectado, ou pasta removida).';

function list(value) {
    return Array.isArray(value) ? value : [];
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Tamanho para as mensagens: 1 KB, 640 KB, 12,4 MB, 3,2 GB (nunca "1 MB" para 272 bytes).
function sizeText(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    const decimal = n => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    if (Math.round(value / 1024) < 1000) return `${Math.max(1, Math.round(value / 1024)).toLocaleString('pt-BR')} KB`;
    if (Math.round((value / MB) * 10) / 10 < 1000) return `${decimal(value / MB)} MB`;
    return `${decimal(value / (1024 * MB))} GB`;
}

function plural(count, one, many) {
    return `${count.toLocaleString('pt-BR')} ${count === 1 ? one : many}`;
}

function abortError() {
    return Object.assign(new Error('O espelho das entregas foi interrompido porque o servidor está sendo desligado.'), { code: 'ICLASS_BACKUP_ABORTED' });
}

function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
}

// 'entregas/a/b/c.pdf' (registro, com '/') -> 'a/b/c.pdf' (relativo a data/entregas e ao
// espelho). Caminho fora de entregas/ ou com '..' -> ''.
function relFromStored(storedRel) {
    const rel = String(storedRel || '').split('\\').join('/');
    if (!rel.startsWith(`${MIRROR_SEGMENT}/`)) return '';
    const inner = rel.slice(MIRROR_SEGMENT.length + 1);
    const parts = inner.split('/');
    if (!inner || parts.some(part => !part || part === '.' || part === '..')) return '';
    if (parts[0] === RECEIVING_SEGMENT) return '';
    return inner;
}

function localAbs(rel) {
    const abs = resolveInside(runtimePaths.ASSIGNMENT_FILES_DIR, rel.split('/').join(path.sep));
    return assertInside(runtimePaths.ASSIGNMENT_FILES_DIR, abs);
}

function mirrorAbs(mirrorDir, rel) {
    const abs = resolveInside(mirrorDir, rel.split('/').join(path.sep));
    return assertInside(mirrorDir, abs);
}

// Pasta do espelho no destino: <destino>/IClass-<computador>/entregas.
function mirrorDirFor(destino) {
    return path.join(store.externalDir(destino), MIRROR_SEGMENT);
}

async function destinationReachable(destino) {
    if (!destino) return false;
    try {
        return (await fs.promises.stat(destino)).isDirectory();
    } catch (e) {
        return false;
    }
}

// ------------------------------------------------------------ o que há aqui
// Arquivos de data/entregas: [{ rel, size }], sem .recebendo, sem link simbólico.
async function listLocalFiles(root = runtimePaths.ASSIGNMENT_FILES_DIR) {
    const out = [];
    async function walk(dir, prefix, depth) {
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
            if (!prefix && entry.name === RECEIVING_SEGMENT) continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < MAX_DEPTH) await walk(abs, rel, depth + 1);
            } else if (entry.isFile()) {
                try {
                    const stat = await fs.promises.stat(abs);
                    out.push({ rel, size: stat.size });
                } catch (e) { /* sumiu no meio */ }
            }
        }
    }
    await walk(root, '', 1);
    return out;
}

// Arquivos que algum registro guarda: as entregas do banco (menos o arquivo tirado na
// anonimização) e as dos pacotes de curso excluído (no caminho do pacote e no de antes,
// onde fica o que o arquivamento não conseguiu mover). Map rel -> { fileId, sha256, size }.
function registeredFiles(memory) {
    const out = new Map();
    list(memory && memory.assignmentSubmissions).forEach(sub => {
        list(sub && sub.versions).forEach(version => {
            list(version && version.files).forEach(file => {
                if (!isObject(file) || file.removedAt) return;
                const rel = relFromStored(file.storedRel);
                if (!rel) return;
                out.set(rel, {
                    fileId: typeof file.id === 'string' ? file.id : '',
                    sha256: /^[0-9a-f]{64}$/.test(String(file.sha256 || '')) ? file.sha256 : '',
                    size: Math.max(0, Math.floor(Number(file.size)) || 0),
                    origem: 'banco',
                });
            });
        });
    });
    let bundled = [];
    try { bundled = assignmentLifecycle.archivedBundleFileRefs(); } catch (error) {
        logError('espelho das entregas: leitura dos pacotes de curso excluído', error);
    }
    bundled.forEach(ref => {
        const info = { fileId: ref.fileId, sha256: ref.sha256, size: ref.size, origem: 'pacote' };
        const archived = relFromStored(ref.archivedRel);
        if (archived && !out.has(archived)) out.set(archived, info);
        const stored = relFromStored(ref.storedRel);
        if (stored && !out.has(stored)) out.set(stored, info);
    });
    return out;
}

// A lápide vale para este caminho? Não vale (a cópia no destino fica, o arquivo conta como
// registrado no cartão e "Trazer arquivos" o traz de volta):
// - quando o arquivo está aqui naquele caminho e um registro vivo aponta para ele;
// - quando a lápide é do pacote de um curso excluído ('excluir_curso') e uma entrega viva
//   do banco registra o caminho, esteja o arquivo aqui ou não. É o curso restaurado cujo
//   pacote que sobrou foi excluído depois (ou um backup de antes da exclusão restaurado):
//   a entrega continua no banco, e a cópia externa pode ser a única que sobrou dela.
// As outras lápides (anonimizar, apagar o aluno, excluir a tarefa) valem mesmo com o
// registro de volta por um backup antigo (D4: a lápide em 'merge' sobrevive a ele).
function tombApplies(rel, tomb, registered, localSet) {
    if (!isObject(tomb)) return false;
    const info = registered.get(rel);
    if (info && localSet.has(rel)) return false;
    if (tomb.reason === 'excluir_curso' && info && info.origem === 'banco') return false;
    return true;
}

// Caminhos (storedRel e archivedRel) em que alguma lápide vale: Set de rel.
function tombstonedRels(memory, registered, localSet) {
    const out = new Set();
    list(memory && memory.assignmentFileTombstones).forEach(item => {
        if (!isObject(item)) return;
        [item.storedRel, item.archivedRel].forEach(value => {
            const rel = relFromStored(value);
            if (rel && tombApplies(rel, item, registered, localSet)) out.add(rel);
        });
    });
    return out;
}

// O que o espelho copia: os arquivos daqui, menos os que têm lápide que vale.
function filesToMirror(localFiles, tombs) {
    return localFiles.filter(item => !tombs.has(item.rel));
}

// ------------------------------------------------------------ espelho.json
function emptyManifest() {
    return { versao: 1, computador: store.hostFolderName(), atualizadoEm: null, arquivos: {} };
}

async function readManifest(mirrorDir) {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(path.join(mirrorDir, MANIFEST_FILE), 'utf8'));
        if (!isObject(parsed) || !isObject(parsed.arquivos)) return emptyManifest();
        const arquivos = {};
        Object.entries(parsed.arquivos).forEach(([rel, info]) => {
            if (!isObject(info) || relFromStored(`${MIRROR_SEGMENT}/${rel}`) !== rel) return;
            arquivos[rel] = {
                tamanho: Math.max(0, Math.floor(Number(info.tamanho)) || 0),
                sha256: /^[0-9a-f]{64}$/.test(String(info.sha256 || '')) ? info.sha256 : '',
                copiadoEm: typeof info.copiadoEm === 'string' ? info.copiadoEm : null,
                conferidoEm: typeof info.conferidoEm === 'string' ? info.conferidoEm : null,
                // Data de gravação da cópia no destino (ms, inteiro): mudou, a cópia é relida.
                mtimeMs: Number.isFinite(Number(info.mtimeMs)) && info.mtimeMs !== null ? Math.floor(Number(info.mtimeMs)) : null,
            };
        });
        return { ...emptyManifest(), ...parsed, arquivos };
    } catch (e) {
        return emptyManifest();
    }
}

async function writeManifest(mirrorDir, manifest, now = new Date()) {
    const file = path.join(mirrorDir, MANIFEST_FILE);
    const temporary = `${file}.tmp`;
    const next = { ...manifest, versao: 1, computador: store.hostFolderName(), atualizadoEm: now.toISOString() };
    await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2));
    await renameWithRetry(temporary, file);
    return next;
}

// ------------------------------------------------------------ cópia conferida
async function hashFile(file, signal) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); size += chunk.length; done(); } });
    await pipeline(fs.createReadStream(file), tap, signal ? { signal } : {});
    return { sha256: hash.digest('hex'), size };
}

function sourceGone(abs) {
    try { return !fs.statSync(abs).isFile(); } catch (e) { return true; }
}

// Copia from -> to passando por <to>.iclass-parcial: o SHA-256 é tirado da origem durante
// a cópia e a cópia é relida do destino e conferida antes de ganhar o nome final.
// Devolve { sha256, size }. Lança com code 'EMIRROR_VERIFY' quando a releitura não bate.
// expectedSha256 (o do registro da entrega): a origem que não bate com ele não ganha o
// nome final (code 'EMIRROR_SOURCE_MISMATCH'), e o que já estava em `to` fica como estava.
async function copyVerified(from, to, { signal, expectedSha256 = '' } = {}) {
    const temporary = `${to}${PARTIAL_SUFFIX}`;
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
    try {
        await pipeline(fs.createReadStream(from), tap, fs.createWriteStream(temporary), signal ? { signal } : {});
        const sha256 = hash.digest('hex');
        if (expectedSha256 && sha256 !== expectedSha256) {
            throw Object.assign(new Error('O arquivo de origem não confere com o SHA-256 do registro da entrega.'), { code: 'EMIRROR_SOURCE_MISMATCH', sha256, size });
        }
        const copy = await hashFile(temporary, signal);
        if (copy.sha256 !== sha256 || copy.size !== size) {
            throw Object.assign(new Error('A cópia gravada não conferiu com o arquivo de origem (SHA-256 diferente).'), { code: 'EMIRROR_VERIFY' });
        }
        await renameWithRetry(temporary, to);
        return { sha256, size };
    } catch (err) {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw abortError();
        throw err;
    }
}

async function removeEmptyParents(dir, stopAt) {
    const stop = path.resolve(stopAt);
    let current = path.resolve(dir);
    while (current.startsWith(stop + path.sep)) {
        try {
            if ((await fs.promises.readdir(current)).length) return;
            await fs.promises.rmdir(current);
        } catch (e) { return; }
        current = path.dirname(current);
    }
}

// ------------------------------------------------------------ espelhar
// Espelha data/entregas em <destino>/IClass-<computador>/entregas. Não grava o banco nem
// o estado: devolve { resumo, lapidesFeitas } (fileIds das lápides que já valem neste
// destino; quem chama marca mirroredRemovalAt e grava). Lança com a mensagem para o
// estado (status 400 nas previstas: destino fora, sem espaço).
async function mirrorAssignmentFiles({ destino, memory, signal = null, now = new Date() } = {}) {
    if (!(await destinationReachable(destino))) throw Object.assign(new Error(UNREACHABLE_MESSAGE), { status: 400, code: 'destination_unavailable' });
    const mirrorDir = mirrorDirFor(destino);
    const localFiles = await listLocalFiles();
    const registered = registeredFiles(memory);
    const localSet = new Set(localFiles.map(item => item.rel));
    const tombs = tombstonedRels(memory, registered, localSet);
    const mirrorExists = fs.existsSync(mirrorDir);
    const resumo = { copiados: 0, bytes: 0, removidosPorLapide: 0, corrigidos: 0, conferidos: 0, diferentesDoRegistro: 0, diferentes: [], sumiram: 0, arquivos: 0, bytesTotal: 0 };
    const lapidesFeitas = new Set();
    // Nada aqui e nada a tirar de lá: não cria a pasta no destino.
    if (!localFiles.length && !mirrorExists) {
        list(memory && memory.assignmentFileTombstones).forEach(item => { if (isObject(item) && item.fileId) lapidesFeitas.add(String(item.fileId)); });
        return { resumo, lapidesFeitas: [...lapidesFeitas], pasta: mirrorDir };
    }
    await fs.promises.mkdir(mirrorDir, { recursive: true });
    const manifest = await readManifest(mirrorDir);

    // 1. Lápides (D4): primeiro, para liberar espaço.
    const byTomb = new Map();
    list(memory && memory.assignmentFileTombstones).forEach(item => {
        if (!isObject(item) || !item.fileId) return;
        const rels = [item.storedRel, item.archivedRel].map(relFromStored).filter(Boolean);
        byTomb.set(String(item.fileId), { item, rels });
    });
    for (const [fileId, { item: tomb, rels }] of byTomb) {
        throwIfAborted(signal);
        let waiting = false;
        for (const rel of rels) {
            // Caminho de uma entrega viva: a lápide espera (não apaga a cópia).
            if (!tombApplies(rel, tomb, registered, localSet)) { waiting = true; continue; }
            const target = mirrorAbs(mirrorDir, rel);
            let existed = false;
            try { existed = (await fs.promises.stat(target)).isFile(); } catch (e) { existed = false; }
            if (existed) {
                await fs.promises.rm(target, { force: true });
                resumo.removidosPorLapide += 1;
                await removeEmptyParents(path.dirname(target), mirrorDir);
            }
            await fs.promises.rm(`${target}${PARTIAL_SUFFIX}`, { force: true }).catch(() => {});
            delete manifest.arquivos[rel];
        }
        if (!waiting) lapidesFeitas.add(fileId);
    }

    // 2. O que falta copiar (ou refazer) e o que já está lá. A cópia anotada no
    // espelho.json com a mesma data de gravação e o mesmo tamanho no destino (e, com
    // registro, o SHA-256 do registro) é dada como boa, a não ser pela releitura de
    // rodízio; a que foi mexida no destino (outra data de gravação), a de outro tamanho e
    // a que não está no espelho.json são conferidas pelo SHA-256.
    // O registro da entrega manda (D3: o espelho nunca troca uma cópia boa): com SHA-256
    // no registro, a cópia do destino que confere com ele fica, mesmo que o arquivo daqui
    // tenha mudado (disco estragado, programa que regravou, ransomware); o arquivo daqui
    // que não confere com o registro nunca vai para o destino e aparece no cartão e na
    // fila como diferente do registro ("Trazer arquivos" o troca pela cópia boa).
    const wanted = filesToMirror(localFiles, tombs);
    const plan = [];
    const settled = [];
    const differs = new Set();
    for (const item of wanted) {
        throwIfAborted(signal);
        const target = mirrorAbs(mirrorDir, item.rel);
        const reg = registered.get(item.rel);
        const regSha = (reg && reg.sha256) || '';
        // Tamanho daqui diferente do registro: o arquivo daqui não é o que o aluno enviou.
        if (regSha && reg.size && item.size !== reg.size) differs.add(item.rel);
        let stat = null;
        try { stat = await fs.promises.stat(target); } catch (e) { stat = null; }
        const isFile = !!(stat && stat.isFile());
        const known = manifest.arquivos[item.rel];
        const sameSize = isFile && stat.size === item.size;
        const knownOk = isFile && known && known.sha256 && known.mtimeMs !== null && Math.floor(stat.mtimeMs) === known.mtimeMs
            && stat.size === known.tamanho && (regSha ? known.sha256 === regSha : known.tamanho === item.size);
        if (knownOk) {
            settled.push({ ...item, target, known, regSha });
            continue;
        }
        plan.push({ ...item, target, exists: isFile, sameSize, known, regSha });
    }
    // Releitura de rodízio: a cada espelhamento, até ROLLING_VERIFY_BYTES das cópias
    // conferidas há mais tempo são relidas do destino (pendrive que estraga aos poucos) e,
    // com registro, o arquivo daqui também (o que mudou aqui com o mesmo tamanho).
    settled.sort((a, b) => String(a.known.conferidoEm || a.known.copiadoEm || '').localeCompare(String(b.known.conferidoEm || b.known.copiadoEm || '')) || a.rel.localeCompare(b.rel));
    let rollingBudget = ROLLING_VERIFY_BYTES;
    for (const item of settled) {
        if (rollingBudget > 0) {
            rollingBudget -= Math.max(1, item.size);
            plan.push({ ...item, exists: true, sameSize: item.size === item.known.tamanho, rolling: true });
            continue;
        }
        resumo.arquivos += 1;
        resumo.bytesTotal += item.size;
    }
    // Cópia que já está lá: confere pelo SHA-256 do registro (sem registro e com o mesmo
    // tamanho, o do espelho.json ou, sem ele, o do arquivo daqui; sem registro e com outro
    // tamanho, é refeita com o arquivo daqui, o único que há).
    const toCopy = [];
    for (const item of plan) {
        throwIfAborted(signal);
        if (item.rolling && item.regSha && !differs.has(item.rel)) {
            try {
                if ((await hashFile(localAbs(item.rel), signal)).sha256 !== item.regSha) differs.add(item.rel);
            } catch (err) {
                if (err && err.code === 'ICLASS_BACKUP_ABORTED') throw err;
                if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw abortError();
            }
        }
        // O arquivo daqui já se sabe diferente do registro (tamanho): não vai para lá.
        if (!item.exists) { if (!(item.regSha && differs.has(item.rel))) toCopy.push(item); continue; }
        if (!item.regSha && !item.sameSize) { toCopy.push(item); continue; }
        let expected = item.regSha || (item.known && item.known.sha256) || '';
        try {
            if (!expected) expected = (await hashFile(localAbs(item.rel), signal)).sha256;
            const there = await hashFile(item.target, signal);
            if (there.sha256 === expected) {
                const stat = await fs.promises.stat(item.target);
                manifest.arquivos[item.rel] = {
                    tamanho: there.size, sha256: expected,
                    copiadoEm: (item.known && item.known.copiadoEm) || now.toISOString(),
                    conferidoEm: now.toISOString(), mtimeMs: Math.floor(stat.mtimeMs),
                };
                resumo.conferidos += 1;
                resumo.arquivos += 1;
                resumo.bytesTotal += there.size;
                continue;
            }
        } catch (err) {
            if (err && err.code === 'ICLASS_BACKUP_ABORTED') throw err;
            if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw abortError();
            if (sourceGone(localAbs(item.rel))) { resumo.sumiram += 1; continue; }
        }
        // O arquivo daqui já se sabe diferente do registro: a cópia do destino (mesmo a que
        // não conferiu) não é trocada por ele.
        if (item.regSha && differs.has(item.rel)) continue;
        toCopy.push(item);
    }

    // 3. Espaço: só pelo que falta copiar.
    const needed = toCopy.reduce((sum, item) => sum + item.size, 0);
    if (toCopy.length) {
        const free = await store.freeBytesAt(mirrorDir);
        if (free !== null && free < needed + FREE_MARGIN_BYTES) {
            await writeManifest(mirrorDir, manifest, now).catch(() => {});
            throw Object.assign(new Error(`Espaço insuficiente no destino externo para a cópia dos trabalhos dos alunos: faltam copiar cerca de ${sizeText(needed)} (${plural(toCopy.length, 'arquivo', 'arquivos')}), o destino precisa ficar com uma folga de ${sizeText(FREE_MARGIN_BYTES)} e há ${sizeText(free)} livres. Nada foi apagado por isso; libere espaço no pendrive ou HD.`), { status: 400, code: 'ENOSPC_DESTINO', diferentes: [...differs] });
        }
    }

    // 4. Cópias, uma por vez, conferidas (com registro, pelo SHA-256 dele: o arquivo daqui
    // que não confere não ganha o nome final e o que estava no destino fica).
    let sinceFlush = 0;
    try {
        for (const item of toCopy) {
            throwIfAborted(signal);
            const source = localAbs(item.rel);
            let copied;
            try {
                copied = await copyVerified(source, item.target, { signal, expectedSha256: item.regSha });
            } catch (err) {
                if (err && err.code === 'ICLASS_BACKUP_ABORTED') throw err;
                if (err && err.code === 'EMIRROR_SOURCE_MISMATCH') { differs.add(item.rel); continue; }
                // O arquivo saiu daqui no meio (foi para a lixeira): não é falha do destino.
                if (sourceGone(source)) { resumo.sumiram += 1; continue; }
                throw err;
            }
            let mtimeMs = null;
            try { mtimeMs = Math.floor((await fs.promises.stat(item.target)).mtimeMs); } catch (e) { mtimeMs = null; }
            manifest.arquivos[item.rel] = { tamanho: copied.size, sha256: copied.sha256, copiadoEm: now.toISOString(), conferidoEm: now.toISOString(), mtimeMs };
            if (item.exists) resumo.corrigidos += 1;
            else resumo.copiados += 1;
            resumo.bytes += copied.size;
            resumo.arquivos += 1;
            resumo.bytesTotal += copied.size;
            sinceFlush += 1;
            if (sinceFlush >= MANIFEST_FLUSH_EVERY) {
                sinceFlush = 0;
                await writeManifest(mirrorDir, manifest, now);
            }
        }
    } finally {
        // Interrompido ou com falha: o que já foi copiado fica anotado.
        await writeManifest(mirrorDir, manifest, now).catch(error => logError('espelho das entregas: gravação do espelho.json', error));
    }
    resumo.diferentesDoRegistro = differs.size;
    resumo.diferentes = [...differs].sort();
    if (differs.size) {
        logError(`espelho das entregas: ${differs.size} arquivo(s) deste computador não conferem com o SHA-256 do registro e não foram copiados para o destino (a cópia de lá foi mantida): ${resumo.diferentes.slice(0, 5).join(', ')}`, new Error('SHA-256 diferente do registro'));
    }
    return { resumo, lapidesFeitas: [...lapidesFeitas], pasta: mirrorDir };
}

// ------------------------------------------------------------ estado e auditoria
// Falha do espelho que ainda vale: sem sucesso depois dela, no mesmo destino.
function openMirrorFailure(espelho, destino) {
    const failure = espelho && espelho.ultimaFalha;
    if (!failure || !destino || failure.destino !== destino) return null;
    const at = Date.parse(String(failure.em || ''));
    if (!Number.isFinite(at)) return null;
    const okAt = Date.parse(String((espelho.destino === destino && espelho.ultimoSucesso) || ''));
    return Number.isFinite(okAt) && okAt >= at ? null : failure;
}

// Arquivos deste computador que o último espelhamento achou diferentes do registro (o
// cartão e a fila mostram; "Trazer arquivos" tira da lista o que trocou).
const MAX_DIFFERENT_LISTED = 500;
function differentState(rels, now = new Date()) {
    const arquivos = list(rels).map(String).filter(Boolean).slice(0, MAX_DIFFERENT_LISTED);
    return { em: now.toISOString(), arquivos };
}

function differentListed(state) {
    const espelho = isObject(state && state.espelho) ? state.espelho : {};
    return new Set(list(isObject(espelho.diferentes) ? espelho.diferentes.arquivos : []).map(String));
}

// A etapa 'espelho' do runBackupJob. Nunca lança (o backup já está gravado e vale), a
// não ser a interrupção pelo desligamento, que quem chama trata como a da cópia externa.
// failureMessage: a mesma frase das falhas do backup (contrato H9a: sem caminho nem texto
// cru do erro). Devolve { ok, resumo } ou { ok: false, mensagem }.
async function runMirrorStep({ job = null, destino, memory, now = new Date(), failureMessage, onChanged } = {}) {
    const signal = job && job.controller ? job.controller.signal : null;
    try {
        const outcome = await mirrorAssignmentFiles({ destino, memory, signal, now });
        await store.updateState(state => ({
            ...state,
            espelho: {
                destino,
                pasta: outcome.pasta,
                ultimoSucesso: now.toISOString(),
                copiados: outcome.resumo.copiados + outcome.resumo.corrigidos,
                bytes: outcome.resumo.bytes,
                removidosPorLapide: outcome.resumo.removidosPorLapide,
                arquivos: outcome.resumo.arquivos,
                bytesTotal: outcome.resumo.bytesTotal,
                diferentes: differentState(outcome.resumo.diferentes, now),
                ultimaFalha: null,
            },
        })).catch(e => logError('espelho das entregas: gravação do estado', e));
        localSummaryCache = null;
        if (typeof onChanged === 'function') await onChanged(outcome);
        return { ok: true, resumo: outcome.resumo, lapidesFeitas: outcome.lapidesFeitas };
    } catch (err) {
        if (err && err.code === 'ICLASS_BACKUP_ABORTED') return { ok: false, interrompido: true, mensagem: 'A cópia dos trabalhos no destino externo foi interrompida porque o servidor está sendo desligado; ela continua no próximo backup.' };
        const mensagem = typeof failureMessage === 'function' ? failureMessage(err) : String((err && err.message) || 'Falha desconhecida.');
        if (!(err && err.status && err.status < 500)) logError('espelho das entregas no destino externo', err);
        await store.updateState(state => {
            const previous = isObject(state.espelho) ? state.espelho : {};
            return {
                ...state,
                espelho: {
                    ...previous,
                    ...(err && Array.isArray(err.diferentes) ? { diferentes: differentState(err.diferentes, now) } : {}),
                    ultimaFalha: { em: now.toISOString(), mensagem, destino },
                },
            };
        }).catch(e => logError('espelho das entregas: gravação do estado', e));
        localSummaryCache = null;
        return { ok: false, mensagem, destinoFora: Boolean(err && err.code === 'destination_unavailable') };
    }
}

// Marca as lápides que já valem neste destino (mirroredRemovalAt), na memória atual.
// Devolve os fileIds alterados (para db.save({ changed })).
function markTombstonesMirrored(memory, fileIds, at = Date.now()) {
    const ids = new Set(list(fileIds).map(String));
    const changed = [];
    list(memory && memory.assignmentFileTombstones).forEach(item => {
        if (!isObject(item) || !ids.has(String(item.fileId)) || item.mirroredRemovalAt) return;
        item.mirroredRemovalAt = at;
        changed.push(String(item.fileId));
    });
    return changed;
}

// ------------------------------------------------------------ recuperar
// Pastas de espelho no destino: a deste computador primeiro e depois as de outros
// computadores (<destino>/IClass-*/entregas, a atualizada há menos tempo primeiro). No
// computador trocado (no Windows, cada máquina tem outro nome, DESKTOP-XXXX), a cópia dos
// trabalhos está na pasta do computador de antes. [{ dir, propria }]
const MAX_OTHER_MIRRORS = 20;
const HOST_FOLDER = /^IClass-[A-Za-z0-9_-]{1,40}$/;
async function mirrorSources(destino) {
    const own = mirrorDirFor(destino);
    const out = [{ dir: own, propria: true }];
    let entries = [];
    try { entries = await fs.promises.readdir(destino, { withFileTypes: true }); } catch (e) { entries = []; }
    const others = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !HOST_FOLDER.test(entry.name)) continue;
        const dir = path.join(destino, entry.name, MIRROR_SEGMENT);
        if (path.resolve(dir) === path.resolve(own)) continue;
        try { if (!(await fs.promises.lstat(dir)).isDirectory()) continue; } catch (e) { continue; }
        const manifest = await readManifest(dir);
        others.push({ dir, propria: false, at: Date.parse(String(manifest.atualizadoEm || '')) || 0, name: entry.name });
    }
    others.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
    return out.concat(others.slice(0, MAX_OTHER_MIRRORS).map(({ dir, propria }) => ({ dir, propria })));
}

// Traz de volta do espelho os arquivos registrados que faltam em data/entregas, conferindo
// o SHA-256 do registro (sem SHA-256 no registro, o tamanho, e só da pasta deste
// computador). Procura primeiro na pasta deste computador e depois nas de outros
// computadores no mesmo destino. Nunca traz arquivo com lápide nem arquivo sem registro.
// O arquivo daqui só é trocado quando não confere com o SHA-256 do registro (disco
// estragado, programa que regravou, ransomware: o espelho mantém a cópia boa no destino e
// lista o daqui como diferente): ele vai antes para a lixeira de arquivos (só do
// administrador; deletedBy: quem pediu) e a cópia conferida toma o lugar. Devolve
// { copiados, trocados, deOutroComputador, conferidos, faltando, divergentes,
//   naoTrocados, bytes }.
async function recoverAssignmentFiles({ destino, memory, signal = null, actor = '' } = {}) {
    if (!(await destinationReachable(destino))) throw Object.assign(new Error(UNREACHABLE_MESSAGE), { status: 409, code: 'destination_unavailable' });
    const sources = await mirrorSources(destino);
    const registered = registeredFiles(memory);
    const localFiles = await listLocalFiles();
    const localSet = new Set(localFiles.map(item => item.rel));
    const localSize = new Map(localFiles.map(item => [item.rel, item.size]));
    const tombs = tombstonedRels(memory, registered, localSet);
    const listed = differentListed(store.readState());
    const settledRels = new Set();
    const out = { copiados: 0, trocados: 0, deOutroComputador: 0, conferidos: 0, faltando: 0, divergentes: 0, naoTrocados: 0, bytes: 0 };
    const wanted = [];
    for (const [rel, info] of registered) {
        throwIfAborted(signal);
        if (tombs.has(rel)) continue;
        let abs;
        try { abs = localAbs(rel); } catch (e) { continue; }
        if (fs.existsSync(abs)) {
            const suspect = info.sha256 && (listed.has(rel) || (info.size > 0 && localSize.has(rel) && localSize.get(rel) !== info.size));
            if (suspect) {
                let here = '';
                try { here = (await hashFile(abs, signal)).sha256; } catch (err) {
                    if (err && (err.code === 'ICLASS_BACKUP_ABORTED' || err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw abortError();
                    here = '';
                }
                if (here && here !== info.sha256) { wanted.push({ rel, info, abs, replace: true }); continue; }
                if (here) settledRels.add(rel);
            }
            out.conferidos += 1;
            continue;
        }
        // O arquivo do pacote de curso excluído conta uma vez: no caminho do pacote.
        if (info.origem === 'pacote' && !rel.startsWith(`${assignmentLifecycle.COURSE_ARCHIVE_SEGMENT}/`)) continue;
        wanted.push({ rel, info, abs, replace: false });
    }
    const available = [];
    for (const item of wanted) {
        const candidates = [];
        for (const source of sources) {
            // Pasta de outro computador: só com o SHA-256 do registro para conferir.
            if (!source.propria && !item.info.sha256) continue;
            let file;
            try { file = mirrorAbs(source.dir, item.rel); } catch (e) { continue; }
            let stat = null;
            try { stat = await fs.promises.stat(file); } catch (e) { stat = null; }
            if (!stat || !stat.isFile()) continue;
            if (item.info.size && stat.size !== item.info.size) { candidates.push({ file, size: stat.size, propria: source.propria, wrongSize: true }); continue; }
            candidates.push({ file, size: stat.size, propria: source.propria });
        }
        if (!candidates.length) {
            if (item.replace) out.naoTrocados += 1;
            else out.faltando += 1;
            continue;
        }
        // As de tamanho certo primeiro (a de tamanho errado só conta como divergente).
        candidates.sort((a, b) => Number(!!a.wrongSize) - Number(!!b.wrongSize));
        available.push({ ...item, candidates });
    }
    if (available.length) {
        const needed = available.reduce((sum, item) => sum + item.candidates[0].size, 0);
        const minFree = settingsUtil.entregasSettings().discoLivreMinimoMb * MB;
        const free = await store.freeBytesAt(fs.existsSync(runtimePaths.ASSIGNMENT_FILES_DIR) ? runtimePaths.ASSIGNMENT_FILES_DIR : runtimePaths.DATA_DIR);
        if (free !== null && free - needed < minFree) {
            throw Object.assign(new Error(`Sem espaço neste computador para trazer os arquivos: são cerca de ${sizeText(needed)}, e o disco precisa ficar com pelo menos ${sizeText(minFree)} livres para os envios dos alunos.`), { status: 409, code: 'disk_full' });
        }
    }
    await fs.promises.mkdir(runtimePaths.ASSIGNMENT_RECEIVING_DIR, { recursive: true });
    try {
        for (const item of available) {
            let done = false;
            for (const candidate of item.candidates) {
                throwIfAborted(signal);
                if (candidate.wrongSize) continue;
                const temporary = path.join(runtimePaths.ASSIGNMENT_RECEIVING_DIR, `recuperar_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.part`);
                try {
                    const copied = await copyVerified(candidate.file, temporary, { signal });
                    const ok = item.info.sha256 ? copied.sha256 === item.info.sha256 : (!item.info.size || copied.size === item.info.size);
                    if (!ok) {
                        await fs.promises.rm(temporary, { force: true }).catch(() => {});
                        continue;
                    }
                    await fs.promises.mkdir(path.dirname(item.abs), { recursive: true });
                    if (item.replace) {
                        // O arquivo daqui, diferente do registro, vai para a lixeira (nada é
                        // apagado); sem conseguir tirá-lo, ele fica e a cópia é descartada.
                        if (fs.existsSync(item.abs) && !fileStore.moveToTrash(item.abs, { deletedBy: actor })) {
                            await fs.promises.rm(temporary, { force: true }).catch(() => {});
                            logError(`espelho das entregas: o arquivo ${item.rel} diferente do registro não foi para a lixeira e não foi trocado`, new Error('lixeira recusou'));
                            out.naoTrocados += 1;
                            done = true;
                            break;
                        }
                    } else if (fs.existsSync(item.abs)) {
                        // Chegou outro no meio (a restauração do curso, por exemplo): o daqui fica.
                        out.conferidos += 1;
                        await fs.promises.rm(temporary, { force: true }).catch(() => {});
                        done = true;
                        break;
                    }
                    await renameWithRetry(temporary, item.abs);
                    if (item.replace) { out.trocados += 1; settledRels.add(item.rel); } else out.copiados += 1;
                    if (!candidate.propria && !item.replace) out.deOutroComputador += 1;
                    out.bytes += copied.size;
                    done = true;
                    break;
                } catch (err) {
                    await fs.promises.rm(temporary, { force: true }).catch(() => {});
                    throw err;
                }
            }
            if (!done) {
                if (item.replace) out.naoTrocados += 1;
                else out.divergentes += 1;
            }
        }
    } finally {
        // O que já confere com o registro sai da lista de diferentes do cartão e da fila.
        if (settledRels.size) {
            await store.updateState(state => {
                const espelho = isObject(state.espelho) ? state.espelho : null;
                if (!espelho || !isObject(espelho.diferentes)) return state;
                const arquivos = list(espelho.diferentes.arquivos).filter(rel => !settledRels.has(String(rel)));
                return { ...state, espelho: { ...espelho, diferentes: { ...espelho.diferentes, arquivos } } };
            }).catch(e => logError('espelho das entregas: gravação do estado', e));
        }
        localSummaryCache = null;
    }
    return out;
}

// ------------------------------------------------------------ cartão e fila
let localSummaryCache = null;

// O que muda o resumo pelo lado dos registros (envio novo, anonimizar, restaurar): a
// conta guardada para a fila só vale com a mesma assinatura.
function recordsSignature(memory) {
    let files = 0;
    list(memory && memory.assignmentSubmissions).forEach(sub => list(sub && sub.versions).forEach(version => { files += list(version && version.files).length; }));
    return `${list(memory && memory.assignmentSubmissions).length}:${files}:${list(memory && memory.assignmentFileTombstones).length}`;
}

// Arquivos daqui que não conferem com o registro da entrega (com SHA-256 no registro): os
// que o último espelhamento achou (lista no estado) e os de tamanho diferente do registro
// (conta barata, sem ler o arquivo). [rel]
function differentLocalFiles(files, registered, tombs) {
    let listed = new Set();
    try { listed = differentListed(store.readState()); } catch (e) { listed = new Set(); }
    return list(files).filter(item => {
        const info = registered.get(item.rel);
        if (!info || !info.sha256 || tombs.has(item.rel)) return false;
        return listed.has(item.rel) || (info.size > 0 && item.size !== info.size);
    }).map(item => item.rel);
}

// Arquivos daqui: { arquivos, bytes, semRegistro, semRegistroBytes, faltando, diferentes, files }.
async function localSummary(memory, { fresh = true, now = Date.now() } = {}) {
    const signature = recordsSignature(memory);
    if (!fresh && localSummaryCache && localSummaryCache.signature === signature && now - localSummaryCache.at < LOCAL_SUMMARY_MAX_AGE_MS) return localSummaryCache.value;
    const files = await listLocalFiles();
    const registered = registeredFiles(memory);
    const here = new Set(files.map(item => item.rel));
    const tombs = tombstonedRels(memory, registered, here);
    let bytes = 0;
    let semRegistro = 0;
    let semRegistroBytes = 0;
    files.forEach(item => {
        bytes += item.size;
        if (!registered.has(item.rel)) { semRegistro += 1; semRegistroBytes += item.size; }
    });
    let faltando = 0;
    registered.forEach((info, rel) => {
        if (here.has(rel) || tombs.has(rel)) return;
        if (info.origem === 'pacote' && !rel.startsWith(`${assignmentLifecycle.COURSE_ARCHIVE_SEGMENT}/`)) return;
        faltando += 1;
    });
    const diferentes = differentLocalFiles(files, registered, tombs);
    const value = { arquivos: files.length, bytes, semRegistro, semRegistroBytes, faltando, diferentes: diferentes.length, diferentesRels: new Set(diferentes), files, registered, tombs };
    localSummaryCache = { at: now, signature, value };
    return value;
}

// Bloco 'entregas' do GET /api/admin/storage. full: o administrador (pode trazer do
// destino). Sem o caminho do destino (o cartão Backup mostra ao administrador).
async function storageSummary(memory, { full = false } = {}) {
    const local = await localSummary(memory, { fresh: true });
    const { destino } = settingsUtil.backupSettings();
    const state = store.readState();
    const espelhoState = isObject(state.espelho) ? state.espelho : {};
    const sameDestination = !!destino && espelhoState.destino === destino;
    const acessivel = await destinationReachable(destino);
    let pendentes = null;
    if (destino && acessivel) {
        const mirrorDir = mirrorDirFor(destino);
        const manifest = await readManifest(mirrorDir);
        // O arquivo daqui diferente do registro não espera cópia: ele não vai para lá.
        pendentes = filesToMirror(local.files, local.tombs)
            .filter(item => !local.diferentesRels.has(item.rel))
            .filter(item => !(manifest.arquivos[item.rel] && manifest.arquivos[item.rel].tamanho === item.size)).length;
    }
    const failure = openMirrorFailure(espelhoState, destino);
    return {
        bytes: local.bytes,
        arquivos: local.arquivos,
        semRegistro: local.semRegistro,
        semRegistroBytes: local.semRegistroBytes,
        faltando: local.faltando,
        // Arquivos daqui diferentes do registro (o espelho não os copia; a cópia boa do
        // destino fica e "Trazer arquivos" troca o daqui por ela).
        diferentes: local.diferentes,
        espelho: {
            configurado: !!destino,
            acessivel,
            ultimoSucesso: sameDestination ? espelhoState.ultimoSucesso || null : null,
            arquivos: sameDestination && Number.isFinite(Number(espelhoState.arquivos)) ? Number(espelhoState.arquivos) : null,
            pendentes,
            ultimaFalha: failure ? { em: failure.em, mensagem: failure.mensagem } : null,
        },
        podeRecuperar: !!full && !!destino,
    };
}

// Alertas da fila "Precisa de você" (só administrador; quem chama filtra e desliga em
// TEST_MODE): semCopia (há trabalhos e nenhum destino externo), diferentes (arquivos daqui
// que não conferem com o registro da entrega), espelhoFalhou (a última
// cópia dos trabalhos falhou e a do backup não está falhando pelo mesmo destino) e
// discoBaixo (livre abaixo do dobro do mínimo das entregas; recusando: abaixo do mínimo).
async function queueAlerts(memory, { backupFailingExternal = false, now = Date.now(), statfs = fs.promises.statfs } = {}) {
    const alerts = { semCopia: null, espelhoFalhou: null, discoBaixo: null, diferentes: null };
    const { destino } = settingsUtil.backupSettings();
    const local = await localSummary(memory, { fresh: false, now });
    if (!destino && local.arquivos > 0) alerts.semCopia = { arquivos: local.arquivos, bytes: local.bytes };
    if (local.diferentes > 0) alerts.diferentes = { arquivos: local.diferentes, podeTrazer: !!destino };
    if (destino && !backupFailingExternal) {
        const state = store.readState();
        const failure = openMirrorFailure(isObject(state.espelho) ? state.espelho : {}, destino);
        if (failure) alerts.espelhoFalhou = { em: failure.em, mensagem: failure.mensagem };
    }
    const minFreeBytes = settingsUtil.entregasSettings().discoLivreMinimoMb * MB;
    if (minFreeBytes > 0) {
        const dir = fs.existsSync(runtimePaths.ASSIGNMENT_FILES_DIR) ? runtimePaths.ASSIGNMENT_FILES_DIR : runtimePaths.DATA_DIR;
        let free = null;
        try {
            const stat = await statfs(dir);
            free = Number(stat.bavail) * Number(stat.bsize);
            if (!Number.isFinite(free)) free = null;
        } catch (e) { free = null; }
        if (free !== null && free < minFreeBytes * 2) alerts.discoBaixo = { freeBytes: free, minFreeBytes, recusando: free < minFreeBytes };
    }
    return alerts;
}

// ------------------------------------------------------------ prévia da restauração
// As tarefas e entregas de hoje que o backup não tem (os registros saem com a
// restauração; os arquivos ficam em data/entregas, sem registro). Backup sem as coleções
// (de antes das tarefas): elas ficam como estão (missing 'keep'), nada a avisar aqui.
function restorePreviewNotice(backupData, memory) {
    const data = isObject(backupData) ? backupData : {};
    if (!Array.isArray(data.assignments) && !Array.isArray(data.assignmentSubmissions)) return null;
    const backupTasks = new Set(list(data.assignments).filter(isObject).map(item => String(item.id)));
    const backupSubs = new Map(list(data.assignmentSubmissions).filter(isObject).map(item => [String(item.id), item]));
    const tarefas = Array.isArray(data.assignments)
        ? list(memory && memory.assignments).filter(item => isObject(item) && !backupTasks.has(String(item.id))).length
        : 0;
    let entregas = 0;
    let envios = 0;
    if (Array.isArray(data.assignmentSubmissions)) {
        list(memory && memory.assignmentSubmissions).forEach(sub => {
            if (!isObject(sub)) return;
            const versions = list(sub.versions).length;
            const delivered = versions > 0 || isObject(sub.manualEntry);
            const inBackup = backupSubs.get(String(sub.id));
            if (!inBackup) { if (delivered) entregas += 1; return; }
            envios += Math.max(0, versions - list(inBackup.versions).length);
        });
    }
    if (!tarefas && !entregas && !envios) return null;
    const parts = [];
    if (tarefas) parts.push(plural(tarefas, 'tarefa', 'tarefas'));
    if (entregas) parts.push(plural(entregas, 'entrega de aluno', 'entregas de alunos'));
    let aviso = parts.length ? `Hoje há ${parts.join(' e ')} que não ${tarefas + entregas === 1 ? 'está' : 'estão'} neste backup` : '';
    if (envios) aviso += `${aviso ? ', e ' : 'Hoje há '}${plural(envios, 'envio feito', 'envios feitos')} depois dele em entregas que ele já tem`;
    aviso += ': esses registros saem com a restauração. Os arquivos enviados pelos alunos continuam neste computador (não fazem parte do backup) e aparecem como "sem registro" no cartão Armazenamento.';
    return { tarefas, entregas, envios, aviso };
}

module.exports = {
    MIRROR_SEGMENT,
    MANIFEST_FILE,
    PARTIAL_SUFFIX,
    UNREACHABLE_MESSAGE,
    mirrorDirFor,
    relFromStored,
    listLocalFiles,
    registeredFiles,
    mirrorAssignmentFiles,
    runMirrorStep,
    markTombstonesMirrored,
    openMirrorFailure,
    recoverAssignmentFiles,
    storageSummary,
    queueAlerts,
    restorePreviewNotice,
    readManifest,
};
