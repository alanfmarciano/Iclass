// ---------------------------------------------------------------------------
// Ciclo de vida das entregas de tarefa (fase 3, C10 / P1-h; FUN-01, D4 e D14 do P1;
// contratos ciclo_de_vida_do_aluno e studentDataHandlers do plano).
//
// Registra o handler de 'assignmentSubmissions' em utils/studentDataHandlers.js, que
// studentLifecycle.applyCascade (anonimizar e apagar de vez), a troca de e-mail
// (renameStudentEmailEverywhere), Meus dados (buildStudentDataExport), Cadastros
// encerrados (contagem), a mesclagem (C22) e o religar depois de restaurar
// (ensureStudentIds) percorrem:
// - anonimizar: a linha da entrega fica, com o pseudônimo, a situação, as datas, o
//   atraso, os tamanhos e a nota; saem o texto e o link do aluno, o IP e o aparelho do
//   envio, o comentário do professor, a nota da entrega em mãos, o motivo da prorrogação
//   e o nome original dos arquivos (fica 'arquivo-1.pdf'). Os arquivos vão para a lixeira
//   de arquivos (só o administrador vê; a pasta da entrega tem nome de id, sem nada da
//   pessoa) e cada um ganha uma lápide (assignmentFileTombstones, reason 'anonimizar'),
//   que o espelho no destino externo (C11) usa para apagar a cópia de lá. Na auditoria,
//   as entradas das entregas dele perdem o mesmo texto livre (comentário, observação da
//   entrega em mãos e motivos; scrubSubmissionAuditText);
// - apagar de vez: a linha sai; arquivos para a lixeira com lápide ('apagar_aluno'); a
//   auditoria perde o texto livre como no anonimizar;
// - curso excluído de vez: anonimizar e apagar alcançam também as entregas dele que estão
//   no pacote do curso (curso.json regravado) e os arquivos delas em _cursos_arquivados
//   (lixeira e lápide com archivedRel), para restaurar o curso não trazer nada de volta;
// - trocar o e-mail: studentEmail das entregas acompanha;
// - Meus dados: seção 'tarefas'. O aluno vê o que vê no portal (versões com nome, tamanho,
//   data, atraso e comprovante; nota e comentário só depois de devolvida); o
//   administrador vê tudo, inclusive a correção ainda não devolvida e o IP do envio;
// - contagem 'Trabalhos entregues' (entregas com envio, entrega em mãos ou nota).
// Os arquivos só saem do lugar (e o pacote só é regravado) depois que todos os handlers
// do passo deram certo e a gravação do banco terminou (efeito devolvido ao applyCascade):
// falha de um handler ou da gravação não deixa arquivo na lixeira com o registro intacto.
// Se a gravação falhou, o efeito roda depois do COMMIT da regravação em segundo plano
// (db.afterNextCommit), em vez de se perder. A regravação do pacote lê o curso.json de
// novo e troca só as linhas do aluno, pelo id (dois anonimizar ao mesmo tempo não
// desfazem um ao outro); restaurar o curso antes dela já traz a entrega como ficaria.
//
// Curso excluído de vez (adminArchive.js, D14): as tarefas e as entregas vão para o pacote
// do curso (cursos_arquivados/<pasta>/curso.json, que vai nos backups) e os arquivos
// saem de data/entregas/<tarefa> para data/entregas/_cursos_arquivados/<pasta>/<tarefa>
// (continuam fora do ZIP de backup, D3, e dentro da árvore que o espelho copia).
// Restaurar o curso traz os registros e os arquivos de volta; excluir o pacote manda os
// arquivos para a lixeira, com lápide ('excluir_curso').
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtimePaths.js');
const assignments = require('./assignments.js');
const assignmentFiles = require('./assignmentFiles.js');
const fileStore = require('./storage.js');
const { renameWithRetry } = require('./backupArchive.js');
const { logError } = require('./errorLog.js');
const { assertSafeId, assertInside, resolveInside } = require('./safePath.js');
const { normalizeEmail } = require('./students.js');
const { registerStudentDataHandler, relinkRecordsByEmail, mergeOwnedRecords } = require('./studentDataHandlers.js');

const COLLECTION = 'assignmentSubmissions';
const TOMBSTONE_REASONS = Object.freeze(['anonimizar', 'apagar_aluno', 'excluir_tarefa', 'excluir_curso']);
// Pasta dos arquivos de curso excluído de vez, dentro de data/entregas.
const COURSE_ARCHIVE_SEGMENT = '_cursos_arquivados';
const COURSE_ARCHIVE_DIR = path.join(runtimePaths.ASSIGNMENT_FILES_DIR, COURSE_ARCHIVE_SEGMENT);

const STUDENT_STATUS_LABELS = Object.freeze({
    devolvida: 'Devolvida',
    refazer: 'Refazer',
    enviada: 'Enviada',
    atrasada: 'Enviada com atraso',
    entregue_em_maos: 'Entregue em mãos',
    sem_envio: 'Sem envio',
});
const ADMIN_STATUS_LABELS = Object.freeze({
    nao_entregue: 'Não entregue',
    para_corrigir: 'Para corrigir',
    corrigida: 'Corrigida (não devolvida)',
    refazer: 'Refazer (esperando o aluno)',
    devolvida: 'Devolvida',
});

function list(value) {
    return Array.isArray(value) ? value : [];
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function iso(ms) {
    return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// A entrega é do aluno? (contrato C2: os donos pela submissionOwners, nunca supondo um
// e-mail por linha.)
function ownedBy(aluno) {
    return sub => isObject(sub) && assignments.submissionOwners(sub).some(email => aluno.owns(email, sub, 'renamed'));
}

// Arquivos (gravados) de uma linha crua de entrega: [{ id, storedRel }].
function submissionFiles(raw) {
    const out = [];
    list(raw && raw.versions).forEach(version => {
        list(version && version.files).forEach(file => {
            if (!isObject(file)) return;
            out.push({ id: typeof file.id === 'string' ? file.id : '', storedRel: typeof file.storedRel === 'string' ? file.storedRel : '' });
        });
    });
    return out;
}

// ------------------------------------------------------------ lápides (D4)
// Acrescenta uma lápide por arquivo que ainda não tem (a chave do registro é fileId, e o
// backup recusa chave repetida). extra: campos a mais (archivedRel do curso excluído).
// Devolve quantas entraram.
function addFileTombstones(memory, files, { reason, at = Date.now(), extra = () => ({}) } = {}) {
    if (!TOMBSTONE_REASONS.includes(reason)) throw new TypeError(`assignmentLifecycle: motivo de lápide desconhecido (${reason}).`);
    if (!Array.isArray(memory.assignmentFileTombstones)) memory.assignmentFileTombstones = [];
    const known = new Set(memory.assignmentFileTombstones.filter(isObject).map(item => String(item.fileId)));
    let added = 0;
    list(files).forEach(file => {
        const fileId = file && typeof file.id === 'string' ? file.id : '';
        if (!fileId || known.has(fileId)) return;
        known.add(fileId);
        memory.assignmentFileTombstones.push({
            fileId,
            storedRel: String(file.storedRel || ''),
            reason,
            at,
            mirroredRemovalAt: null,
            ...extra(file),
        });
        added += 1;
    });
    return added;
}

// ------------------------------------------------------------ lixeira (disco)
// Apaga a pasta se estiver vazia (e a de cima, até data/entregas, sem passar dela).
function removeEmptyDirs(dir, stopAt = runtimePaths.ASSIGNMENT_FILES_DIR) {
    const stop = path.resolve(stopAt);
    let current = path.resolve(dir);
    while (current.startsWith(stop + path.sep)) {
        try {
            if (fs.readdirSync(current).length) return;
            fs.rmdirSync(current);
        } catch (e) { return; }
        current = path.dirname(current);
    }
}

// Manda os arquivos da lista para a lixeira de arquivos (só do administrador:
// storage.isAdminOnlyTrashEntry cobre entregas/). A pasta da entrega cujos arquivos são
// todos da lista vai inteira (um item na lixeira por entrega, com o nome de id dela);
// se houver nela arquivo de fora da lista, vão só os da lista. Nada aqui lança: o que
// não sai fica no lugar (e o registro já não aponta para ele com nome da pessoa).
// resolve(file) dá o caminho no disco (padrão: o de data/entregas pelo storedRel; o do
// pacote de curso excluído usa archivedAbsFor). Devolve quantos arquivos foram.
function moveFilesToTrash(files, { deletedBy, resolve = file => assignmentFiles.absFromStoredRel(file && file.storedRel) } = {}) {
    const byDir = new Map();
    list(files).forEach(file => {
        let abs;
        try { abs = resolve(file); } catch (e) { return; }
        const dir = path.dirname(abs);
        if (!byDir.has(dir)) byDir.set(dir, new Set());
        byDir.get(dir).add(abs);
    });
    let moved = 0;
    byDir.forEach((targets, dir) => {
        try {
            const present = [...targets].filter(target => fs.existsSync(target));
            if (!present.length) return;
            const entries = fs.readdirSync(dir).map(name => path.join(dir, name));
            const onlyOurs = entries.length > 0 && entries.every(entry => targets.has(entry));
            if (onlyOurs && path.resolve(dir) !== path.resolve(runtimePaths.ASSIGNMENT_FILES_DIR)) {
                if (fileStore.moveDirToTrash(dir, { deletedBy })) moved += present.length;
            } else {
                present.forEach(target => { if (fileStore.moveToTrash(target, { deletedBy })) moved += 1; });
            }
            removeEmptyDirs(path.dirname(dir));
            removeEmptyDirs(dir);
        } catch (error) {
            logError('assignmentLifecycle: arquivo de entrega não foi para a lixeira', error);
        }
    });
    return moved;
}

// ------------------------------------------------------------ anonimizar
// Nome neutro do arquivo: 'arquivo-<n><ext>' (a extensão fica: diz o tipo, não a pessoa).
function neutralFileName(index, ext) {
    const extension = assignmentFiles.normalizeExtension(ext) || '';
    return `arquivo-${index + 1}${extension}`;
}

function anonymizedVersion(version, at) {
    if (!isObject(version)) return version;
    return {
        ...version,
        text: '',
        link: '',
        ip: '',
        device: '',
        files: list(version.files).map((file, index) => (isObject(file)
            ? { ...file, originalName: neutralFileName(index, file.ext || path.extname(String(file.originalName || ''))), removedAt: at, removedReason: 'anonimizar' }
            : file)),
    };
}

// A linha da entrega com o pseudônimo e sem o que é dado pessoal (D14). studentId sai:
// o id era do cadastro de antes (o anonimizado ganha outro no próximo ensureStudentIds,
// e o relink religa a entrega pelo e-mail do pseudônimo).
function anonymizedSubmissionRow(raw, pseudonimo, at) {
    const next = {
        ...raw,
        studentEmail: normalizeEmail(pseudonimo && pseudonimo.email),
        studentId: null,
        versions: list(raw.versions).map(version => anonymizedVersion(version, at)),
        anonymized: true,
        anonymizedAt: at,
        updatedAt: at,
    };
    if (isObject(raw.grade)) next.grade = { ...raw.grade, comment: '' };
    if (isObject(raw.manualEntry)) next.manualEntry = { ...raw.manualEntry, note: '' };
    if (isObject(raw.extension)) next.extension = { ...raw.extension, reason: '' };
    if (Array.isArray(raw.mergedFrom)) {
        next.mergedFrom = raw.mergedFrom.map(item => (isObject(item) ? { ...item, studentEmail: null, studentId: null } : item));
    }
    return next;
}

// ------------------------------------------------------------ auditoria (D14)
// O texto livre que as rotas das tarefas guardam na auditoria sobre a entrega do aluno: o
// comentário do professor (assignment_grade_changed só do comentário, até 300
// caracteres), a observação da entrega em mãos (assignment_manual_entry details.note) e
// o motivo (prorrogação, nota alterada depois de devolvida, pedido para refazer). No
// anonimizar e no apagar de vez ele sai das entradas das entregas do aluno (pelo id da
// entrega: o e-mail delas já foi trocado por anonymizeStudentAuditTrail); a entrada fica, com
// a ação, a data, quem fez, as notas e os prazos. Devolve quantas entradas mudaram.
const AUDIT_TEXT_REMOVED = '(texto removido)';
function scrubSubmissionAuditText(memory, submissionIds) {
    const ids = new Set(list(submissionIds).filter(id => typeof id === 'string' && id));
    if (!ids.size || !Array.isArray(memory.auditLogs)) return 0;
    let changed = 0;
    memory.auditLogs.forEach((entry, index) => {
        if (!isObject(entry) || !ids.has(entry.submissionId) || !/^assignment_/.test(String(entry.action || ''))) return;
        const next = { ...entry };
        if (next.reason !== undefined) delete next.reason;
        if (next.field === 'Comentário da tarefa') {
            if (next.oldValue !== undefined) next.oldValue = AUDIT_TEXT_REMOVED;
            if (next.newValue !== undefined) next.newValue = AUDIT_TEXT_REMOVED;
        }
        if (isObject(next.details) && typeof next.details.note === 'string' && next.details.note) {
            next.details = { ...next.details, note: AUDIT_TEXT_REMOVED };
        }
        if (JSON.stringify(next) === JSON.stringify(entry)) return;
        memory.auditLogs[index] = next;
        changed += 1;
    });
    return changed;
}

// ------------------------------------------------------------ pacotes de curso excluído
// Entregas do aluno nos pacotes dos cursos excluídos de vez (cursos_arquivados/<pasta>/
// curso.json, desde o C10) e os arquivos delas em data/entregas/_cursos_arquivados/<pasta>.
// Sem isto, anonimizar ou apagar o aluno com o curso excluído deixava o texto, o link, o
// e-mail e os nomes dos arquivos no pacote (e restaurar o curso trazia tudo de volta), e
// os arquivos fora da lixeira e sem lápide (o espelho os guardaria para sempre).
// Leitura no passo da memória, para achar as entregas dele (o pacote ilegível fica de
// fora, com o erro no crash.log); a regravação do pacote e os arquivos saem depois de
// gravar o banco (efeito devolvido). Só o pacote que tem entregas é lido inteiro: o
// manifesto (pequeno) diz quantas são; pacote de antes do C10 (sem a contagem) não tem.
function bundleMayHaveSubmissions(folder) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(runtimePaths.ARCHIVE_DIR, folder, 'manifesto.json'), 'utf8')); } catch (e) { return true; }
    const counts = isObject(manifest) && isObject(manifest.counts) ? manifest.counts : null;
    if (!counts) return true;
    if (typeof counts.entregas === 'number') return counts.entregas > 0;
    // Manifesto de antes do C10: o pacote não levava tarefas nem entregas.
    return counts.tarefas !== undefined;
}

function readArchivedBundles() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(runtimePaths.ARCHIVE_DIR, { withFileTypes: true }); } catch (e) { return out; }
    entries.forEach(entry => {
        if (!entry.isDirectory()) return;
        let folder;
        try { folder = assertSafeId(entry.name); } catch (e) { return; }
        const file = path.join(runtimePaths.ARCHIVE_DIR, folder, 'curso.json');
        if (!fs.existsSync(file) || !bundleMayHaveSubmissions(folder)) return;
        let bundle;
        try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
            logError(`assignmentLifecycle: pacote de curso excluído ilegível (${folder})`, error);
            return;
        }
        if (!isObject(bundle) || !Array.isArray(bundle.assignmentSubmissions) || !bundle.assignmentSubmissions.length) return;
        out.push({ folder, file, bundle });
    });
    return out;
}

// Arquivos que os pacotes de curso excluído ainda guardam (o espelho das entregas, C11:
// eles ficam em data/entregas/_cursos_arquivados e o registro deles está no curso.json,
// não no banco). [{ folder, fileId, storedRel, archivedRel, sha256, size }]; o arquivo
// tirado na anonimização (removedAt) fica de fora. O pacote só é relido quando o
// curso.json muda (tamanho ou data de modificação): o cartão Armazenamento e a fila
// perguntam a cada visita, e o pacote de um curso grande pesa.
const bundleRefsCache = new Map();

function archivedBundleFileRefs() {
    const out = [];
    const seen = new Set();
    let entries = [];
    try { entries = fs.readdirSync(runtimePaths.ARCHIVE_DIR, { withFileTypes: true }); } catch (e) { entries = []; }
    entries.forEach(entry => {
        if (!entry.isDirectory()) return;
        let folder;
        try { folder = assertSafeId(entry.name); } catch (e) { return; }
        const file = path.join(runtimePaths.ARCHIVE_DIR, folder, 'curso.json');
        let stat;
        try { stat = fs.statSync(file); } catch (e) { return; }
        seen.add(file);
        const stamp = `${stat.size}:${stat.mtimeMs}`;
        const cached = bundleRefsCache.get(file);
        if (cached && cached.stamp === stamp) { out.push(...cached.refs); return; }
        const refs = [];
        if (bundleMayHaveSubmissions(folder)) {
            let bundle = null;
            try { bundle = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
                logError(`assignmentLifecycle: pacote de curso excluído ilegível (${folder})`, error);
            }
            list(bundle && bundle.assignmentSubmissions).forEach(sub => {
                list(sub && sub.versions).forEach(version => {
                    list(version && version.files).forEach(item => {
                        if (!isObject(item) || item.removedAt || typeof item.storedRel !== 'string') return;
                        const archivedRel = archivedRelFor(folder, item.storedRel);
                        if (!archivedRel) return;
                        refs.push({
                            folder,
                            fileId: typeof item.id === 'string' ? item.id : '',
                            storedRel: item.storedRel,
                            archivedRel,
                            sha256: /^[0-9a-f]{64}$/.test(String(item.sha256 || '')) ? item.sha256 : '',
                            size: Math.max(0, Math.floor(Number(item.size)) || 0),
                        });
                    });
                });
            });
        }
        bundleRefsCache.set(file, { stamp, refs });
        out.push(...refs);
    });
    [...bundleRefsCache.keys()].forEach(file => { if (!seen.has(file)) bundleRefsCache.delete(file); });
    return out;
}

// O caminho do arquivo de uma entrega dentro do pacote: 'entregas/<tarefa>/<entrega>/<id>'
// vira data/entregas/_cursos_arquivados/<pasta>/<tarefa>/<entrega>/<id> (relativo a data,
// para a lápide: archivedRel; absoluto, para a lixeira: archivedAbsFor).
function archivedRelFor(folderName, storedRel) {
    const rel = String(storedRel || '').split('\\').join('/');
    return rel.startsWith('entregas/') ? `entregas/${COURSE_ARCHIVE_SEGMENT}/${folderName}/${rel.slice('entregas/'.length).split('/').slice(0, 3).join('/')}` : '';
}

function archivedAbsFor(folderName, storedRel) {
    const rel = archivedRelFor(folderName, storedRel);
    if (!rel) throw new Error('Caminho de arquivo de entrega inválido.');
    const abs = resolveInside(runtimePaths.DATA_DIR, rel.split('/').join(path.sep));
    return assertInside(courseArchiveFolder(folderName), abs);
}

// Regrava o curso.json do pacote (arquivo temporário e troca; se a troca falhar, por
// cima). Lança se não conseguir (quem chama registra no crash.log).
function writeBundle(file, bundle) {
    const text = JSON.stringify(bundle, null, 2);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporary, text);
        fs.renameSync(temporary, file);
    } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch (e) { /* já saiu */ }
        fs.writeFileSync(file, text);
    }
}

// Mudanças nas entregas de um pacote, por id da entrega: { mode, ids, pseudonimo, at }.
// mode 'anonymize' troca a linha pela anonimizada; 'purge' tira a linha. Aplicar de novo
// não muda nada (a linha anonimizada de novo fica igual).
function applyBundleChange(rows, change) {
    const out = [];
    list(rows).forEach(sub => {
        if (!isObject(sub) || typeof sub.id !== 'string' || !change.ids.has(sub.id)) { out.push(sub); return; }
        if (change.mode === 'anonymize') out.push(anonymizedSubmissionRow(sub, change.pseudonimo, change.at));
    });
    return out;
}

// O que já foi aceito (o passo do anonimizar/apagar deu certo) e ainda não foi regravado
// no pacote, por pasta: a regravação espera a gravação do banco (e, se ela falhou, a
// regravação em segundo plano). Restaurar o curso nesse meio-tempo aplica estas mudanças
// às entregas que voltam (pendingBundleChangesApplied), em vez de trazer do pacote ainda
// não regravado o texto e o e-mail de quem já saiu.
const pendingBundleChanges = new Map();

function addPendingBundleChange(folder, change) {
    if (!pendingBundleChanges.has(folder)) pendingBundleChanges.set(folder, []);
    pendingBundleChanges.get(folder).push(change);
}

function dropPendingBundleChange(folder, change) {
    const items = pendingBundleChanges.get(folder);
    if (!items) return;
    const index = items.indexOf(change);
    if (index >= 0) items.splice(index, 1);
    if (!items.length) pendingBundleChanges.delete(folder);
}

// As entregas do pacote (folder) com as mudanças que ainda esperam a regravação dele.
function pendingBundleChangesApplied(folder, rows) {
    return list(pendingBundleChanges.get(folder)).reduce((current, change) => applyBundleChange(current, change), list(rows));
}

// Regrava o pacote com uma mudança: lê o curso.json de novo na hora (outro anonimizar ou
// apagar pode tê-lo regravado depois do passo da memória deste) e troca ou tira só as
// linhas dela, pelo id. Leitura, troca e escrita sem pausa no meio (síncronas): duas
// regravações nunca se cruzam, e nenhuma devolve ao pacote o que a outra tirou. Pacote
// que já saiu (curso restaurado ou pacote excluído): nada a fazer.
function rewriteBundleWithChange(folder, file, change) {
    if (!fs.existsSync(file)) return false;
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObject(bundle) || !Array.isArray(bundle.assignmentSubmissions)) return false;
    const rows = applyBundleChange(bundle.assignmentSubmissions, change);
    if (JSON.stringify(rows) === JSON.stringify(bundle.assignmentSubmissions)) return false;
    writeBundle(file, { ...bundle, assignmentSubmissions: rows });
    return true;
}

// As entregas do aluno nos pacotes: grava as lápides na memória e devolve { ids, effect }:
// os ids das entregas (para limpar a auditoria) e o efeito ({ accepted, afterSave }, ou
// null sem nada a fazer). accepted() põe a mudança na lista do que espera a regravação;
// afterSave() regrava o pacote (rewriteBundleWithChange) e manda os arquivos do pacote (e
// os que ficaram em data/entregas) para a lixeira.
function archivedBundleChanges(memory, aluno, { mode, pseudonimo, at }) {
    const isHis = ownedBy(aluno);
    const reason = mode === 'anonymize' ? 'anonimizar' : 'apagar_aluno';
    const ids = [];
    const jobs = [];
    readArchivedBundles().forEach(({ folder, file, bundle }) => {
        const files = [];
        const changeIds = new Set();
        bundle.assignmentSubmissions.forEach(sub => {
            if (!isHis(sub)) return;
            if (typeof sub.id === 'string' && sub.id) { ids.push(sub.id); changeIds.add(sub.id); }
            files.push(...submissionFiles(sub));
        });
        if (!changeIds.size && !files.length) return;
        addFileTombstones(memory, files, { reason, at, extra: item => ({ archivedRel: archivedRelFor(folder, item.storedRel) }) });
        jobs.push({ folder, file, files, change: { mode, ids: changeIds, pseudonimo, at } });
    });
    if (!jobs.length) return { ids, effect: null };
    const accepted = () => jobs.forEach(job => addPendingBundleChange(job.folder, job.change));
    const afterSave = ({ deletedBy } = {}) => {
        jobs.forEach(job => {
            try {
                rewriteBundleWithChange(job.folder, job.file, job.change);
            } catch (error) {
                logError(`assignmentLifecycle: pacote do curso excluído não foi regravado (${job.folder})`, error);
            }
            dropPendingBundleChange(job.folder, job.change);
            moveFilesToTrash(job.files, { deletedBy, resolve: item => archivedAbsFor(job.folder, item.storedRel) });
            // O que ficou em data/entregas (o arquivamento não tinha conseguido mover, ou o
            // curso foi restaurado antes desta hora).
            moveFilesToTrash(job.files, { deletedBy });
        });
    };
    return { ids, effect: { accepted, afterSave } };
}

// ------------------------------------------------------------ Meus dados
function studentSituationLabel(sub) {
    if (assignments.isReturned(sub)) return STUDENT_STATUS_LABELS.devolvida;
    if (sub.status === 'refazer') return STUDENT_STATUS_LABELS.refazer;
    const last = sub.versions.length ? sub.versions[sub.versions.length - 1] : null;
    if (last) return last.late ? STUDENT_STATUS_LABELS.atrasada : STUDENT_STATUS_LABELS.enviada;
    if (sub.manualEntry) return STUDENT_STATUS_LABELS.entregue_em_maos;
    return STUDENT_STATUS_LABELS.sem_envio;
}

function exportVersion(sub, version, audience) {
    const out = {
        n: version.n,
        enviadaEm: iso(version.requestAt),
        recebidaEm: iso(version.receivedAt),
        atrasada: version.late === true,
        atrasoMinutos: version.late ? Math.ceil(version.lateMs / 60000) : 0,
        texto: version.text,
        link: version.link,
        comprovante: assignments.versionReceiptCode(sub, version),
        arquivos: version.files.map(file => {
            const item = {
                nome: file.originalName,
                tamanho: file.size,
                tipo: file.mime,
                comprovante: assignments.fileReceiptCode(file),
            };
            if (file.removedAt) item.removidoEm = iso(file.removedAt);
            if (audience === 'admin') {
                item.id = file.id;
                item.categoria = file.category;
                item.sha256 = file.sha256;
            }
            return item;
        }),
    };
    if (audience === 'admin') {
        out.ip = version.ip;
        out.aparelho = version.device;
    }
    return out;
}

function exportRow(memory, raw, audience) {
    const sub = assignments.normalizeSubmission(raw);
    const task = assignments.normalizeAssignment(assignments.findAssignment(memory, sub.assignmentId));
    const window = assignments.effectiveWindow(task || assignments.normalizeAssignment({}), sub);
    const last = sub.versions.length ? sub.versions[sub.versions.length - 1] : null;
    const returned = assignments.isReturned(sub);
    const showGrade = audience === 'admin' || returned;
    const grade = showGrade && sub.grade ? sub.grade : null;
    const row = {
        assignmentId: sub.assignmentId,
        tarefa: (task && task.title) || 'Tarefa removida',
        courseId: sub.courseId || null,
        turma: sub.studentClass || '',
        prazo: iso(window.dueAt),
        encerramento: iso(window.closeAt),
        situacao: audience === 'admin' ? (ADMIN_STATUS_LABELS[assignments.instructorStatus(sub)] || sub.status) : studentSituationLabel(sub),
        versoes: sub.versions.map(version => exportVersion(sub, version, audience)),
        ultimoEnvio: last ? iso(last.requestAt) : null,
        comAtraso: last ? (last.late ? 'Sim' : 'Não') : '',
        entregaEmMaos: sub.manualEntry ? { em: iso(sub.manualEntry.at), ...(audience === 'admin' ? { observacao: sub.manualEntry.note, por: sub.manualEntry.by } : {}) } : null,
        prazoIndividual: sub.extension ? {
            prazo: iso(sub.extension.dueAt),
            encerramento: iso(sub.extension.closeAt),
            ...(audience === 'admin' ? { motivo: sub.extension.reason, por: sub.extension.by, em: iso(sub.extension.at) } : {}),
        } : null,
        nota: grade ? grade.score : null,
        descontoPct: grade ? grade.penaltyPct : null,
        notaFinal: grade ? grade.finalScore : null,
        // O comentário do pedido para refazer o aluno já lê no portal (presentRedo de
        // studentAssignments.js); a nota continua escondida até a devolução.
        comentario: grade ? grade.comment : (sub.status === 'refazer' && sub.grade ? sub.grade.comment : ''),
        devolvidaEm: returned ? iso(sub.returnedAt) : null,
    };
    if (audience === 'admin') {
        Object.assign(row, {
            id: sub.id,
            status: sub.status,
            studentId: sub.studentId,
            correcao: sub.grade ? {
                versaoCorrigida: sub.grade.versionGraded,
                corrigidaPor: sub.grade.gradedBy,
                corrigidaEm: iso(sub.grade.gradedAt),
                descontoDispensado: sub.grade.penaltyWaived,
                devolvida: returned,
            } : null,
            devolvidaPor: returned ? sub.returnedBy : '',
            anonimizada: sub.anonymized,
            mergedFrom: Array.isArray(raw.mergedFrom) ? raw.mergedFrom : undefined,
            criadaEm: iso(sub.createdAt),
            alteradaEm: iso(sub.updatedAt),
        });
        if (row.mergedFrom === undefined) delete row.mergedFrom;
    }
    return row;
}

// ------------------------------------------------------------ mesclar (C22)
// Regra de colisão do plano: as versões do 'sai' entram antes das do 'fica' (por
// requestAt) e todas são renumeradas; a nota do 'fica' vale. Como a correção guarda o
// número da versão corrigida, ele acompanha a renumeração.
function mergeSubmissions(memory, fica, sai, { at = Date.now() } = {}) {
    const target = normalizeEmail(fica && fica.email);
    if (!target || !Array.isArray(memory.assignmentSubmissions)) return;
    const isFica = ownedBy(fica);
    const isSai = sub => !isFica(sub) && ownedBy(sai)(sub);
    // Por entrega dos dois, a versão de cada número de antes (a renumeração muda no lugar).
    const before = new Map();
    memory.assignmentSubmissions.forEach(sub => {
        if (!isFica(sub) && !isSai(sub)) return;
        const own = new Map();
        list(sub.versions).forEach(version => { if (isObject(version) && !own.has(version.n)) own.set(version.n, version); });
        before.set(sub, own);
    });
    const result = mergeOwnedRecords(memory.assignmentSubmissions, {
        isFica,
        isSai,
        keyOf: sub => (sub && sub.assignmentId ? String(sub.assignmentId) : null),
        reassign: sub => {
            sub.studentEmail = target;
            sub.studentId = fica.id || null;
            sub.updatedAt = at;
        },
        versions: { field: 'versions', orderBy: 'requestAt', number: 'n' },
        summary: sub => {
            const norm = assignments.normalizeSubmission(sub);
            return {
                status: norm.status,
                versoes: norm.versions.length,
                notaFinal: norm.grade ? norm.grade.finalScore : null,
                devolvidaEm: norm.returnedAt,
            };
        },
        origin: { studentEmail: sai && sai.email, studentId: sai && sai.id },
        at,
    });
    memory.assignmentSubmissions = result.records;
    memory.assignmentSubmissions.forEach(sub => {
        if (!isObject(sub) || !isObject(sub.grade) || !before.has(sub)) return;
        const graded = sub.grade.versionGraded;
        const version = before.get(sub).get(graded);
        if (version && version.n !== graded) sub.grade = { ...sub.grade, versionGraded: version.n };
    });
}

// ------------------------------------------------------------ o handler
registerStudentDataHandler({
    collection: COLLECTION,
    label: 'Trabalhos entregues',
    exportKey: 'tarefas',
    rename(memory, de, para) {
        list(memory.assignmentSubmissions).forEach(sub => {
            if (isObject(sub) && normalizeEmail(sub.studentEmail) === de) sub.studentEmail = para;
        });
    },
    anonymize(memory, aluno, pseudonimo) {
        const isHis = ownedBy(aluno);
        const at = Date.now();
        const files = [];
        const ids = [];
        memory.assignmentSubmissions = list(memory.assignmentSubmissions).map(sub => {
            if (!isHis(sub)) return sub;
            if (typeof sub.id === 'string') ids.push(sub.id);
            files.push(...submissionFiles(sub));
            return anonymizedSubmissionRow(sub, pseudonimo, at);
        });
        addFileTombstones(memory, files, { reason: 'anonimizar', at });
        const archived = archivedBundleChanges(memory, aluno, { mode: 'anonymize', pseudonimo, at });
        scrubSubmissionAuditText(memory, [...ids, ...archived.ids]);
        return [
            files.length ? ({ deletedBy } = {}) => moveFilesToTrash(files, { deletedBy }) : null,
            archived.effect,
        ];
    },
    purge(memory, aluno) {
        const isHis = ownedBy(aluno);
        const at = Date.now();
        const files = [];
        const ids = [];
        memory.assignmentSubmissions = list(memory.assignmentSubmissions).filter(sub => {
            if (!isHis(sub)) return true;
            if (typeof sub.id === 'string') ids.push(sub.id);
            files.push(...submissionFiles(sub));
            return false;
        });
        addFileTombstones(memory, files, { reason: 'apagar_aluno', at });
        const archived = archivedBundleChanges(memory, aluno, { mode: 'purge', at });
        scrubSubmissionAuditText(memory, [...ids, ...archived.ids]);
        return [
            files.length ? ({ deletedBy } = {}) => moveFilesToTrash(files, { deletedBy }) : null,
            archived.effect,
        ];
    },
    merge(memory, fica, sai) {
        mergeSubmissions(memory, fica, sai);
    },
    relink(memory, idsPorEmail) {
        return relinkRecordsByEmail(memory, list(memory.assignmentSubmissions), idsPorEmail);
    },
    // Trabalhos entregues: com envio, entrega em mãos ou nota (a linha que só guarda uma
    // prorrogação não conta).
    count(memory, aluno) {
        const isHis = ownedBy(aluno);
        return list(memory.assignmentSubmissions).filter(sub => {
            if (!isHis(sub)) return false;
            const norm = assignments.normalizeSubmission(sub);
            return assignments.hasDelivery(norm) || !!norm.grade;
        }).length;
    },
    exportSection(memory, aluno, audience) {
        const isHis = ownedBy(aluno);
        const rows = list(memory.assignmentSubmissions).filter(isHis).map(sub => exportRow(memory, sub, audience));
        return rows.length ? rows : undefined;
    },
    printColumns: [
        { field: 'tarefa', label: 'Tarefa', format: 'text' },
        { field: 'turma', label: 'Turma', format: 'text' },
        { field: 'situacao', label: 'Situação', format: 'text' },
        { field: 'versoes', label: 'Versões', format: 'count' },
        { field: 'ultimoEnvio', label: 'Último envio', format: 'datetime' },
        { field: 'comAtraso', label: 'Com atraso', format: 'text' },
        { field: 'notaFinal', label: 'Nota', format: 'grade' },
        { field: 'comentario', label: 'Comentário do professor', format: 'text' },
    ],
});

// ------------------------------------------------------------ curso excluído (D14)
// Tarefas e entregas do curso (linhas cruas): as da turma do curso e as que apontam para
// tarefa do curso.
function courseAssignmentRecords(memory, courseId) {
    const course = String(courseId || '');
    const tasks = list(memory.assignments).filter(item => isObject(item) && String(item.courseId || '') === course);
    const ids = new Set(tasks.map(item => String(item.id)));
    const subs = list(memory.assignmentSubmissions).filter(item => isObject(item) && (ids.has(String(item.assignmentId)) || String(item.courseId || '') === course));
    return { assignments: tasks, assignmentSubmissions: subs };
}

function courseArchiveFolder(folderName) {
    return path.join(COURSE_ARCHIVE_DIR, assertSafeId(folderName));
}

// Pasta de uma tarefa em data/entregas (id conferido como pedaço de caminho).
function assignmentDir(assignmentId) {
    const id = String(assignmentId || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
    return path.join(runtimePaths.ASSIGNMENT_FILES_DIR, id);
}

function countFiles(dir) {
    let files = 0;
    let bytes = 0;
    try {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const inner = countFiles(abs);
                files += inner.files;
                bytes += inner.bytes;
            } else if (entry.isFile()) {
                files += 1;
                try { bytes += fs.statSync(abs).size; } catch (e) { /* sumiu no meio */ }
            }
        });
    } catch (e) { /* pasta sumiu */ }
    return { files, bytes };
}

// Move a pasta (rename no mesmo disco). Destino existente: junta arquivo por arquivo, sem
// sobrescrever (o que já existe no destino fica; o que não mudou de lugar fica onde
// estava). Devolve quantos arquivos mudaram de lugar.
async function moveTree(source, target, rename) {
    if (!fs.existsSync(source)) return 0;
    if (!fs.existsSync(target)) {
        const { files } = countFiles(source);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await rename(source, target);
        return files;
    }
    let moved = 0;
    const entries = await fs.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isDirectory()) {
            moved += await moveTree(from, to, rename);
        } else if (!fs.existsSync(to)) {
            await rename(from, to);
            moved += 1;
        }
    }
    removeEmptyDirs(source, path.dirname(source));
    return moved;
}

// Depois de gravar o curso excluído: os arquivos das tarefas dele vão para
// data/entregas/_cursos_arquivados/<pasta>/<tarefa>. Nunca lança (o curso já saiu do
// banco e o pacote já foi escrito): o que não mudou de lugar fica em data/entregas e
// volta igual na restauração; a falha vai para o crash.log.
async function archiveCourseAssignmentFiles(assignmentIds, folderName, { rename = renameWithRetry } = {}) {
    const out = { arquivos: 0, falhas: 0 };
    let base;
    try { base = courseArchiveFolder(folderName); } catch (e) { return out; }
    for (const id of list(assignmentIds)) {
        const dir = assignmentDir(id);
        if (!dir || !fs.existsSync(dir)) continue;
        try {
            out.arquivos += await moveTree(dir, path.join(base, String(id)), rename);
        } catch (error) {
            out.falhas += 1;
            logError('assignmentLifecycle: arquivos de entrega do curso excluído ficaram no lugar', error);
        }
    }
    return out;
}

// Restaurar o curso: os arquivos voltam para data/entregas/<tarefa>, sem sobrescrever.
// Nunca lança. O que não voltou (troca de lugar recusada pelo sistema, ou já havia um
// arquivo com o mesmo nome no destino) não fica perdido em _cursos_arquivados depois que
// o pacote sai: a pasta que sobrou vai para a lixeira de arquivos (só do administrador),
// e o aviso para o crash.log. Devolve { arquivos, falhas, naLixeira }.
async function restoreCourseAssignmentFiles(folderName, { rename = renameWithRetry, deletedBy } = {}) {
    const out = { arquivos: 0, falhas: 0, naLixeira: 0 };
    let base;
    try { base = courseArchiveFolder(folderName); } catch (e) { return out; }
    if (!fs.existsSync(base)) return out;
    let entries = [];
    try { entries = await fs.promises.readdir(base, { withFileTypes: true }); } catch (e) { return out; }
    for (const entry of entries) {
        const dir = entry.isDirectory() ? assignmentDir(entry.name) : null;
        if (!dir) continue;
        try {
            out.arquivos += await moveTree(path.join(base, entry.name), dir, rename);
        } catch (error) {
            out.falhas += 1;
            logError('assignmentLifecycle: arquivos de entrega do curso restaurado não voltaram', error);
        }
    }
    removeEmptyDirs(base, COURSE_ARCHIVE_DIR);
    if (fs.existsSync(base)) {
        const { files: left } = countFiles(base);
        if (left && fileStore.moveDirToTrash(base, { deletedBy })) {
            out.naLixeira = left;
            logError(`assignmentLifecycle: ${left} arquivo(s) de entrega do curso restaurado não voltaram ao lugar e foram para a lixeira de arquivos (${folderName})`, new Error('arquivos de entrega fora do lugar'));
        }
    }
    removeEmptyDirs(COURSE_ARCHIVE_DIR, runtimePaths.ASSIGNMENT_FILES_DIR);
    return out;
}

// Excluir o pacote do curso de vez: os arquivos das entregas vão para a lixeira de
// arquivos (só do administrador; nada é apagado sozinho) e cada arquivo do pacote ganha
// uma lápide ('excluir_curso') com o caminho de antes (storedRel) e o do pacote
// (archivedRel), para o espelho apagar as duas cópias. O que ainda estava em
// data/entregas (o rename tinha falhado) também vai. Devolve { arquivos, lapides }.
function trashArchivedCourseAssignmentFiles(memory, folderName, bundleSubmissions, { deletedBy, at = Date.now() } = {}) {
    const out = { arquivos: 0, lapides: 0 };
    let base;
    try { base = courseArchiveFolder(folderName); } catch (e) { return out; }
    const files = [];
    list(bundleSubmissions).forEach(sub => { if (isObject(sub)) files.push(...submissionFiles(sub)); });
    out.lapides = addFileTombstones(memory, files, { reason: 'excluir_curso', at, extra: file => ({ archivedRel: archivedRelFor(folderName, file.storedRel) }) });
    if (fs.existsSync(base)) {
        const { files: count } = countFiles(base);
        if (fileStore.moveDirToTrash(base, { deletedBy })) out.arquivos += count;
        removeEmptyDirs(COURSE_ARCHIVE_DIR, runtimePaths.ASSIGNMENT_FILES_DIR);
    }
    // Ficou para trás em data/entregas (falha no rename do arquivamento): também vai.
    const leftovers = files.filter(file => {
        try { return fs.existsSync(assignmentFiles.absFromStoredRel(file.storedRel)); } catch (e) { return false; }
    });
    if (leftovers.length) out.arquivos += moveFilesToTrash(leftovers, { deletedBy });
    return out;
}

// Restaurar o curso: a entrega volta ligada ao aluno de hoje. relinkRecordsByEmail religa
// pelo e-mail o studentId que não resolve; aqui, a entrega cujo studentId é de um aluno
// que trocou de e-mail depois de o curso sair (a troca não alcança o pacote) passa para o
// e-mail atual dele, para ele continuar vendo a entrega no portal. Devolve quantas mudaram.
function followCurrentStudentEmails(memory, rows) {
    const byId = new Map(list(memory.students).filter(student => isObject(student) && typeof student.id === 'string' && student.id).map(student => [student.id, student]));
    let changed = 0;
    list(rows).forEach(sub => {
        if (!isObject(sub) || typeof sub.studentId !== 'string') return;
        const student = byId.get(sub.studentId);
        const email = normalizeEmail(student && student.email);
        if (!email || email === normalizeEmail(sub.studentEmail)) return;
        sub.studentEmail = email;
        changed += 1;
    });
    return changed;
}

module.exports = {
    COLLECTION,
    TOMBSTONE_REASONS,
    COURSE_ARCHIVE_SEGMENT,
    COURSE_ARCHIVE_DIR,
    addFileTombstones,
    moveFilesToTrash,
    anonymizedSubmissionRow,
    mergeSubmissions,
    scrubSubmissionAuditText,
    followCurrentStudentEmails,
    pendingBundleChangesApplied,
    courseAssignmentRecords,
    archivedBundleFileRefs,
    archiveCourseAssignmentFiles,
    restoreCourseAssignmentFiles,
    trashArchivedCourseAssignmentFiles,
};
