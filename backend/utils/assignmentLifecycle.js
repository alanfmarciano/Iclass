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
//   que o espelho no destino externo (C11) usa para apagar a cópia de lá;
// - apagar de vez: a linha sai; arquivos para a lixeira com lápide ('apagar_aluno');
// - trocar o e-mail: studentEmail das entregas acompanha;
// - Meus dados: seção 'tarefas'. O aluno vê o que vê no portal (versões com nome, tamanho,
//   data, atraso e comprovante; nota e comentário só depois de devolvida); o
//   administrador vê tudo, inclusive a correção ainda não devolvida e o IP do envio;
// - contagem 'Trabalhos entregues' (entregas com envio, entrega em mãos ou nota).
// Os arquivos só saem do lugar depois que todos os handlers do passo deram certo
// (efeito devolvido ao applyCascade): falha de um handler não deixa arquivo na lixeira
// com o registro intacto.
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
const { assertSafeId } = require('./safePath.js');
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
// Devolve quantos arquivos foram para a lixeira.
function moveFilesToTrash(files, { deletedBy } = {}) {
    const byDir = new Map();
    list(files).forEach(file => {
        let abs;
        try { abs = assignmentFiles.absFromStoredRel(file && file.storedRel); } catch (e) { return; }
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
        comentario: grade ? grade.comment : '',
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
        memory.assignmentSubmissions = list(memory.assignmentSubmissions).map(sub => {
            if (!isHis(sub)) return sub;
            files.push(...submissionFiles(sub));
            return anonymizedSubmissionRow(sub, pseudonimo, at);
        });
        addFileTombstones(memory, files, { reason: 'anonimizar', at });
        return files.length ? ({ deletedBy } = {}) => moveFilesToTrash(files, { deletedBy }) : undefined;
    },
    purge(memory, aluno) {
        const isHis = ownedBy(aluno);
        const at = Date.now();
        const files = [];
        memory.assignmentSubmissions = list(memory.assignmentSubmissions).filter(sub => {
            if (!isHis(sub)) return true;
            files.push(...submissionFiles(sub));
            return false;
        });
        addFileTombstones(memory, files, { reason: 'apagar_aluno', at });
        return files.length ? ({ deletedBy } = {}) => moveFilesToTrash(files, { deletedBy }) : undefined;
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
// Nunca lança; o que não voltou fica em _cursos_arquivados (crash.log).
async function restoreCourseAssignmentFiles(folderName, { rename = renameWithRetry } = {}) {
    const out = { arquivos: 0, falhas: 0 };
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
    const archivedRel = storedRel => {
        const rel = String(storedRel || '').split('\\').join('/');
        return rel.startsWith('entregas/') ? `entregas/${COURSE_ARCHIVE_SEGMENT}/${folderName}/${rel.slice('entregas/'.length).split('/').slice(0, 3).join('/')}` : '';
    };
    out.lapides = addFileTombstones(memory, files, { reason: 'excluir_curso', at, extra: file => ({ archivedRel: archivedRel(file.storedRel) }) });
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

module.exports = {
    COLLECTION,
    TOMBSTONE_REASONS,
    COURSE_ARCHIVE_SEGMENT,
    COURSE_ARCHIVE_DIR,
    addFileTombstones,
    moveFilesToTrash,
    anonymizedSubmissionRow,
    mergeSubmissions,
    courseAssignmentRecords,
    archiveCourseAssignmentFiles,
    restoreCourseAssignmentFiles,
    trashArchivedCourseAssignmentFiles,
};
