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
//   do destino e conferida pelo SHA-256 da origem antes de ganhar o nome final. Cópia
//   que já está lá com o mesmo tamanho e o mesmo SHA-256 do espelho.json não é relida;
//   sem o espelho.json (perdido, outro computador), é conferida uma vez pelo SHA-256.
//   A de tamanho ou SHA-256 diferente (pendrive tirado no meio) é refeita.
// - Espaço: antes de copiar, o livre no destino precisa caber o que falta copiar mais uma
//   folga; sem espaço, nada é copiado e o motivo vai para o estado.
// - Remoção só por ordem explícita (D4): o arquivo com lápide (assignmentFileTombstones:
//   anonimizar, apagar de vez, excluir o pacote do curso) sai do destino, nos dois
//   caminhos da lápide (storedRel e archivedRel), e não é copiado de novo. A cópia de um
//   caminho só não sai quando o arquivo está neste computador naquele caminho e uma
//   entrega viva ainda aponta para ele (lápide de um pacote excluído depois que o curso
//   foi restaurado): a lápide fica esperando. Arquivo sem registro (depois de restaurar um
//   backup antigo) é copiado e nunca apagado.
// - Recuperar (POST /api/admin/backup/entregas/recuperar, só administrador): traz de
//   volta para data/entregas os arquivos registrados que faltam aqui, conferindo o SHA-256
//   do registro; nunca substitui arquivo existente e nunca traz arquivo com lápide.
// - Cartão Armazenamento (GET /api/admin/storage): tamanho e quantidade dos arquivos,
//   os sem registro, os registrados que faltam aqui e a situação do espelho. Fila do
//   administrador: trabalhos sem cópia fora deste computador, falha do espelho e pouco
//   espaço no disco para receber entregas.
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

function megabytes(bytes) {
    return Math.max(1, Math.ceil((Number(bytes) || 0) / MB));
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

// Lápides por caminho: Map rel -> lápide (storedRel e archivedRel).
function tombstonesByRel(memory) {
    const out = new Map();
    list(memory && memory.assignmentFileTombstones).forEach(item => {
        if (!isObject(item)) return;
        [item.storedRel, item.archivedRel].forEach(value => {
            const rel = relFromStored(value);
            if (rel && !out.has(rel)) out.set(rel, item);
        });
    });
    return out;
}

// Uma entrega viva aponta para este caminho e o arquivo está aqui: a lápide dele não vale
// (ainda) para este caminho.
function liveHere(rel, registered, localSet) {
    return registered.has(rel) && localSet.has(rel);
}

// O que o espelho copia: os arquivos daqui, menos os que têm lápide (a não ser os vivos).
function filesToMirror(localFiles, registered, tombs) {
    const localSet = new Set(localFiles.map(item => item.rel));
    return localFiles.filter(item => !tombs.has(item.rel) || liveHere(item.rel, registered, localSet));
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
async function copyVerified(from, to, { signal } = {}) {
    const temporary = `${to}${PARTIAL_SUFFIX}`;
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
    try {
        await pipeline(fs.createReadStream(from), tap, fs.createWriteStream(temporary), signal ? { signal } : {});
        const sha256 = hash.digest('hex');
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
    const tombs = tombstonesByRel(memory);
    const localSet = new Set(localFiles.map(item => item.rel));
    const mirrorExists = fs.existsSync(mirrorDir);
    const resumo = { copiados: 0, bytes: 0, removidosPorLapide: 0, corrigidos: 0, conferidos: 0, origemDiferente: 0, sumiram: 0, arquivos: 0, bytesTotal: 0 };
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
        byTomb.set(String(item.fileId), rels);
    });
    for (const [fileId, rels] of byTomb) {
        throwIfAborted(signal);
        let waiting = false;
        for (const rel of rels) {
            if (liveHere(rel, registered, localSet)) { waiting = true; continue; }
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

    // 2. O que falta copiar (ou refazer) e o que já está lá.
    const wanted = filesToMirror(localFiles, registered, tombs);
    const plan = [];
    for (const item of wanted) {
        throwIfAborted(signal);
        const target = mirrorAbs(mirrorDir, item.rel);
        let stat = null;
        try { stat = await fs.promises.stat(target); } catch (e) { stat = null; }
        const known = manifest.arquivos[item.rel];
        if (stat && stat.isFile() && stat.size === item.size && known && known.tamanho === item.size && known.sha256) {
            resumo.arquivos += 1;
            resumo.bytesTotal += item.size;
            continue;
        }
        plan.push({ ...item, target, exists: !!(stat && stat.isFile()), sameSize: !!(stat && stat.isFile() && stat.size === item.size) });
    }
    // Cópia que já está lá com o mesmo tamanho, mas fora do espelho.json: confere uma vez.
    const toCopy = [];
    for (const item of plan) {
        throwIfAborted(signal);
        if (!item.sameSize) { toCopy.push(item); continue; }
        let expected = registered.get(item.rel) && registered.get(item.rel).sha256;
        try {
            if (!expected) expected = (await hashFile(localAbs(item.rel), signal)).sha256;
            const there = await hashFile(item.target, signal);
            if (there.sha256 === expected) {
                manifest.arquivos[item.rel] = { tamanho: item.size, sha256: expected, copiadoEm: manifest.arquivos[item.rel]?.copiadoEm || now.toISOString() };
                resumo.conferidos += 1;
                resumo.arquivos += 1;
                resumo.bytesTotal += item.size;
                continue;
            }
        } catch (err) {
            if (err && err.code === 'ICLASS_BACKUP_ABORTED') throw err;
            if (sourceGone(localAbs(item.rel))) { resumo.sumiram += 1; continue; }
        }
        toCopy.push(item);
    }

    // 3. Espaço: só pelo que falta copiar.
    const needed = toCopy.reduce((sum, item) => sum + item.size, 0);
    if (toCopy.length) {
        const free = await store.freeBytesAt(mirrorDir);
        if (free !== null && free < needed + FREE_MARGIN_BYTES) {
            await writeManifest(mirrorDir, manifest, now).catch(() => {});
            throw Object.assign(new Error(`Espaço insuficiente no destino externo para a cópia dos trabalhos dos alunos: faltam copiar cerca de ${megabytes(needed + FREE_MARGIN_BYTES)} MB e há ${Math.floor(free / MB)} MB livres. Nada foi apagado por isso; libere espaço no pendrive ou HD.`), { status: 400, code: 'ENOSPC_DESTINO' });
        }
    }

    // 4. Cópias, uma por vez, conferidas.
    let sinceFlush = 0;
    try {
        for (const item of toCopy) {
            throwIfAborted(signal);
            const source = localAbs(item.rel);
            let copied;
            try {
                copied = await copyVerified(source, item.target, { signal });
            } catch (err) {
                if (err && err.code === 'ICLASS_BACKUP_ABORTED') throw err;
                // O arquivo saiu daqui no meio (foi para a lixeira): não é falha do destino.
                if (sourceGone(source)) { resumo.sumiram += 1; continue; }
                throw err;
            }
            const expected = registered.get(item.rel) && registered.get(item.rel).sha256;
            if (expected && expected !== copied.sha256) {
                resumo.origemDiferente += 1;
                logError(`espelho das entregas: o arquivo ${item.rel} deste computador não bate com o SHA-256 do registro (copiado assim mesmo)`, new Error('SHA-256 diferente do registro'));
            }
            manifest.arquivos[item.rel] = { tamanho: copied.size, sha256: copied.sha256, copiadoEm: now.toISOString() };
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
                ultimaFalha: null,
            },
        })).catch(e => logError('espelho das entregas: gravação do estado', e));
        if (typeof onChanged === 'function') await onChanged(outcome);
        return { ok: true, resumo: outcome.resumo, lapidesFeitas: outcome.lapidesFeitas };
    } catch (err) {
        if (err && err.code === 'ICLASS_BACKUP_ABORTED') return { ok: false, interrompido: true, mensagem: 'A cópia dos trabalhos no destino externo foi interrompida porque o servidor está sendo desligado; ela continua no próximo backup.' };
        const mensagem = typeof failureMessage === 'function' ? failureMessage(err) : String((err && err.message) || 'Falha desconhecida.');
        if (!(err && err.status && err.status < 500)) logError('espelho das entregas no destino externo', err);
        await store.updateState(state => ({
            ...state,
            espelho: { ...(isObject(state.espelho) ? state.espelho : {}), ultimaFalha: { em: now.toISOString(), mensagem, destino } },
        })).catch(e => logError('espelho das entregas: gravação do estado', e));
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
// Traz de volta do espelho os arquivos registrados que faltam em data/entregas, conferindo
// o SHA-256 do registro (sem SHA-256 no registro, o tamanho). Nunca substitui arquivo
// existente; nunca traz arquivo com lápide nem arquivo sem registro. Devolve
// { copiados, conferidos, faltando, divergentes, bytes }.
async function recoverAssignmentFiles({ destino, memory, signal = null } = {}) {
    if (!(await destinationReachable(destino))) throw Object.assign(new Error(UNREACHABLE_MESSAGE), { status: 409, code: 'destination_unavailable' });
    const mirrorDir = mirrorDirFor(destino);
    const registered = registeredFiles(memory);
    const tombs = tombstonesByRel(memory);
    const out = { copiados: 0, conferidos: 0, faltando: 0, divergentes: 0, bytes: 0 };
    const missing = [];
    for (const [rel, info] of registered) {
        if (tombs.has(rel)) continue;
        let abs;
        try { abs = localAbs(rel); } catch (e) { continue; }
        if (fs.existsSync(abs)) { out.conferidos += 1; continue; }
        // O arquivo do pacote de curso excluído conta uma vez: no caminho do pacote.
        if (info.origem === 'pacote' && !rel.startsWith(`${assignmentLifecycle.COURSE_ARCHIVE_SEGMENT}/`)) continue;
        missing.push({ rel, info, abs });
    }
    const available = [];
    for (const item of missing) {
        let source;
        try { source = mirrorAbs(mirrorDir, item.rel); } catch (e) { out.faltando += 1; continue; }
        let stat = null;
        try { stat = await fs.promises.stat(source); } catch (e) { stat = null; }
        if (!stat || !stat.isFile()) { out.faltando += 1; continue; }
        available.push({ ...item, source, size: stat.size });
    }
    if (available.length) {
        const needed = available.reduce((sum, item) => sum + item.size, 0);
        const minFree = settingsUtil.entregasSettings().discoLivreMinimoMb * MB;
        const free = await store.freeBytesAt(fs.existsSync(runtimePaths.ASSIGNMENT_FILES_DIR) ? runtimePaths.ASSIGNMENT_FILES_DIR : runtimePaths.DATA_DIR);
        if (free !== null && free - needed < minFree) {
            throw Object.assign(new Error(`Sem espaço neste computador para trazer os arquivos: são cerca de ${megabytes(needed)} MB, e o disco precisa ficar com pelo menos ${megabytes(minFree)} MB livres para os envios dos alunos.`), { status: 409, code: 'disk_full' });
        }
    }
    await fs.promises.mkdir(runtimePaths.ASSIGNMENT_RECEIVING_DIR, { recursive: true });
    for (const item of available) {
        throwIfAborted(signal);
        const temporary = path.join(runtimePaths.ASSIGNMENT_RECEIVING_DIR, `recuperar_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.part`);
        try {
            const copied = await copyVerified(item.source, temporary, { signal });
            const ok = item.info.sha256 ? copied.sha256 === item.info.sha256 : (!item.info.size || copied.size === item.info.size);
            if (!ok) {
                out.divergentes += 1;
                await fs.promises.rm(temporary, { force: true }).catch(() => {});
                continue;
            }
            await fs.promises.mkdir(path.dirname(item.abs), { recursive: true });
            // Chegou outro no meio (a restauração do curso, por exemplo): o daqui fica.
            if (fs.existsSync(item.abs)) {
                out.conferidos += 1;
                await fs.promises.rm(temporary, { force: true }).catch(() => {});
                continue;
            }
            await renameWithRetry(temporary, item.abs);
            out.copiados += 1;
            out.bytes += copied.size;
        } catch (err) {
            await fs.promises.rm(temporary, { force: true }).catch(() => {});
            if (err && err.code === 'ICLASS_BACKUP_ABORTED') throw err;
            throw err;
        }
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

// Arquivos daqui: { arquivos, bytes, semRegistro, semRegistroBytes, faltando, files }.
async function localSummary(memory, { fresh = true, now = Date.now() } = {}) {
    const signature = recordsSignature(memory);
    if (!fresh && localSummaryCache && localSummaryCache.signature === signature && now - localSummaryCache.at < LOCAL_SUMMARY_MAX_AGE_MS) return localSummaryCache.value;
    const files = await listLocalFiles();
    const registered = registeredFiles(memory);
    const tombs = tombstonesByRel(memory);
    const here = new Set(files.map(item => item.rel));
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
    const value = { arquivos: files.length, bytes, semRegistro, semRegistroBytes, faltando, files, registered, tombs };
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
        pendentes = filesToMirror(local.files, local.registered, local.tombs)
            .filter(item => !(manifest.arquivos[item.rel] && manifest.arquivos[item.rel].tamanho === item.size)).length;
    }
    const failure = openMirrorFailure(espelhoState, destino);
    return {
        bytes: local.bytes,
        arquivos: local.arquivos,
        semRegistro: local.semRegistro,
        semRegistroBytes: local.semRegistroBytes,
        faltando: local.faltando,
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
// TEST_MODE): semCopia (há trabalhos e nenhum destino externo), espelhoFalhou (a última
// cópia dos trabalhos falhou e a do backup não está falhando pelo mesmo destino) e
// discoBaixo (livre abaixo do dobro do mínimo das entregas; recusando: abaixo do mínimo).
async function queueAlerts(memory, { backupFailingExternal = false, now = Date.now(), statfs = fs.promises.statfs } = {}) {
    const alerts = { semCopia: null, espelhoFalhou: null, discoBaixo: null };
    const { destino } = settingsUtil.backupSettings();
    const local = await localSummary(memory, { fresh: false, now });
    if (!destino && local.arquivos > 0) alerts.semCopia = { arquivos: local.arquivos, bytes: local.bytes };
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
