// ---------------------------------------------------------------------------
// "Baixar entregas" de uma tarefa em ZIP (fase 3, C6 / P1-d; FUN-01, D2, D3 e D16 do P1).
//
// O ZIP é a cópia manual que o professor leva para corrigir fora ou guardar (os arquivos
// de data/entregas não vão no backup, D3). Dentro dele:
// - uma pasta por aluno que mandou algo, '<Nome> - <matrícula>' (sem matrícula, só o
//   nome; nome repetido ganha ' (2)'), com os arquivos como 'v<n>_<nome original>', a
//   resposta em texto como 'v<n>_resposta.txt' e o link como 'v<n>_link.txt';
//   versoes 'ultima' (padrão) leva só a última versão de cada aluno, 'todas' leva todas;
// - lista.csv (separador ';', BOM UTF-8, csvSafe contra fórmula: nome, texto e link são do
//   aluno) com todos os alunos da tarefa (os da turma e quem já tem registro), a situação
//   para o professor, as datas no relógio da escola, o atraso, a nota (também a correção
//   salva e ainda não devolvida: o ZIP é do professor), a pasta e os arquivos que faltam.
//
// Nomes seguros para o Windows (Explorador): sem \ / : * ? " < > |, sem caractere de
// controle, sem ponto ou espaço no fim, sem nome reservado (CON, PRN, AUX, NUL, COM1...),
// até 80 caracteres por pasta e 120 por arquivo, únicos dentro da pasta sem diferenciar
// maiúsculas. O arquivo que sumiu de data/entregas (backup antigo restaurado, cópia
// apagada à mão) fica fora do ZIP e aparece em "Arquivos que faltam" na lista.csv; nada
// aqui grava ou apaga em data/entregas.
//
// buildExportPlan é puro (lê a memória e confere se cada arquivo existe); writeExportZip
// grava o plano num stream (a resposta HTTP) com o archiver, como o backup.
// ---------------------------------------------------------------------------
const path = require('path');
const assignments = require('./assignments.js');
const assignmentFiles = require('./assignmentFiles.js');
const schoolTime = require('./schoolTime.js');
const { buildCsv, formatGradeBR } = require('./gradebook.js');
const { displayName } = require('./students.js');
const { publicStudentEmail } = require('./studentIdentity.js');

const EXPORT_VERSIONS = Object.freeze(['ultima', 'todas']);
const DAY_MS = 24 * 60 * 60 * 1000;
const FOLDER_MAX = 80;
const FILE_MAX = 120;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// Já comprimidos: entram no ZIP sem compressão de novo (mais rápido, mesmo tamanho).
const STORED_EXTENSIONS = /\.(jpe?g|png|gif|webp|heic|heif|zip|7z|rar|docx|xlsx|pptx|odt|ods|odp|pdf)$/i;

const STATUS_LABELS = Object.freeze({
    nao_entregue: 'Não entregue',
    para_corrigir: 'Para corrigir',
    corrigida: 'Corrigida (não devolvida)',
    refazer: 'Refazer (esperando o aluno)',
    devolvida: 'Devolvida',
});

const CSV_HEADER = Object.freeze([
    'Aluno', 'Matrícula', 'E-mail', 'Situação', 'Versões', 'Versão no ZIP', 'Enviada em', 'Atrasada', 'Dias de atraso',
    'Entrega em mãos', 'Nota', 'Desconto (%)', 'Nota final', 'Devolvida em', 'Pasta no ZIP', 'Arquivos no ZIP',
    'Arquivos que faltam', 'Link',
]);

// Um pedaço de caminho do ZIP que o Explorador do Windows abre.
function safeZipSegment(value, fallback, max = FOLDER_MAX) {
    let clean = String(value === undefined || value === null ? '' : value)
        .normalize('NFC')
        .replace(/[\\/<>:"|?*\x00-\x1f\x7f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '');
    if (clean.length > max) {
        const ext = path.extname(clean);
        const keep = ext.length > 1 && ext.length < 12 ? ext : '';
        clean = (clean.slice(0, max - keep.length).replace(/[. ]+$/, '') + keep).trim();
    }
    if (!clean) return fallback;
    const stem = clean.split('.')[0].trim();
    return WINDOWS_RESERVED.test(stem) ? `_${clean}` : clean;
}

// Nome único dentro de um conjunto (sem diferenciar maiúsculas, como o Windows): o
// repetido ganha ' (2)', ' (3)'... antes da extensão.
function uniqueName(name, used) {
    const ext = path.extname(name);
    const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
    let candidate = name;
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
        candidate = `${base} (${index})${ext}`;
        index += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

// 'DD/MM/AAAA HH:MM' no relógio da escola ('' sem instante).
function schoolDateTime(ms, timezone) {
    const parts = ms === null || ms === undefined ? null : schoolTime.localParts(ms, timezone);
    if (!parts) return '';
    const [year, month, day] = parts.date.split('-');
    return `${day}/${month}/${year} ${parts.time}`;
}

function gradeText(score) {
    return score === null || score === undefined ? '' : formatGradeBR(score);
}

// O plano do ZIP: { fileName, entries [{ kind 'file', abs, name, size, store } |
// { kind 'text', name, content }], csv, stats { alunos, comEnvio, versoes, arquivos,
// bytes, faltando } }. versoes: 'ultima' ou 'todas'.
function buildExportPlan(memory, assignment, { versoes = 'ultima', timezone } = {}) {
    const task = assignments.normalizeAssignment(assignment);
    const mode = EXPORT_VERSIONS.includes(versoes) ? versoes : 'ultima';
    const entries = [];
    const rows = [CSV_HEADER.slice()];
    const usedFolders = new Set(['lista.csv']);
    const stats = { alunos: 0, comEnvio: 0, versoes: 0, arquivos: 0, bytes: 0, faltando: 0 };

    assignments.assignmentRoster(memory, task).forEach(row => {
        stats.alunos += 1;
        const sub = row.submission ? assignments.normalizeSubmission(row.submission) : null;
        const student = row.student;
        const name = student ? displayName(student) : '';
        const matricula = student ? String(student.matricula || '').trim() : '';
        const email = publicStudentEmail(row.studentEmail);
        const versions = sub ? (mode === 'todas' ? sub.versions : sub.versions.slice(-1)) : [];
        let folder = '';
        const included = [];
        const missing = [];
        if (versions.some(version => version.files.length || version.text || version.link)) {
            const label = [name || (email && email.includes('@') ? email.split('@')[0] : '') || 'Aluno', matricula].filter(Boolean).join(' - ');
            folder = uniqueName(safeZipSegment(label, 'Aluno'), usedFolders);
            stats.comEnvio += 1;
            const usedFiles = new Set();
            versions.forEach(version => {
                stats.versoes += 1;
                version.files.forEach(file => {
                    const original = assignmentFiles.sanitizeOriginalName(file.originalName) || `arquivo${file.ext || ''}`;
                    if (!assignmentFiles.storedFileExists(file)) {
                        missing.push(`v${version.n}_${original}`);
                        stats.faltando += 1;
                        return;
                    }
                    const fileName = uniqueName(safeZipSegment(`v${version.n}_${original}`, `v${version.n}_arquivo`, FILE_MAX), usedFiles);
                    entries.push({
                        kind: 'file',
                        abs: assignmentFiles.absFromStoredRel(file.storedRel),
                        name: `${folder}/${fileName}`,
                        size: file.size,
                        store: STORED_EXTENSIONS.test(fileName),
                    });
                    included.push(fileName);
                    stats.arquivos += 1;
                    stats.bytes += file.size;
                });
                if (version.text) {
                    const fileName = uniqueName(`v${version.n}_resposta.txt`, usedFiles);
                    entries.push({ kind: 'text', name: `${folder}/${fileName}`, content: version.text.replace(/\r?\n/g, '\r\n') });
                    included.push(fileName);
                }
                if (version.link) {
                    const fileName = uniqueName(`v${version.n}_link.txt`, usedFiles);
                    entries.push({ kind: 'text', name: `${folder}/${fileName}`, content: `${version.link}\r\n` });
                    included.push(fileName);
                }
            });
        }
        const last = sub && sub.versions.length ? sub.versions[sub.versions.length - 1] : null;
        const grade = sub && sub.grade ? sub.grade : null;
        rows.push([
            name,
            matricula,
            email,
            STATUS_LABELS[assignments.instructorStatus(sub)] || '',
            sub ? sub.versions.length : 0,
            versions.length ? (mode === 'todas' ? 'todas' : `v${versions[versions.length - 1].n}`) : '',
            last ? schoolDateTime(last.requestAt, timezone) : '',
            last ? (last.late ? 'Sim' : 'Não') : '',
            last && last.late ? Math.ceil(last.lateMs / DAY_MS) : '',
            sub && sub.manualEntry ? [schoolDateTime(sub.manualEntry.at, timezone), sub.manualEntry.note].filter(Boolean).join(' · ') : '',
            grade ? gradeText(grade.score) : '',
            grade && grade.score !== null ? grade.penaltyPct : '',
            grade ? gradeText(grade.finalScore) : '',
            sub && sub.status === 'devolvida' ? schoolDateTime(sub.returnedAt, timezone) : '',
            folder,
            included.join(' | '),
            missing.join(' | '),
            versions.map(version => version.link).filter(Boolean).join(' | '),
        ]);
    });

    const title = safeZipSegment(task.title, 'Tarefa', 60);
    const cls = safeZipSegment(task.studentClass, 'turma', 40);
    return {
        fileName: `Entregas - ${title} - ${cls}.zip`,
        versoes: mode,
        entries,
        csv: buildCsv(rows),
        stats,
    };
}

// Grava o plano em output (a resposta HTTP). Resolve quando o último byte saiu; rejeita
// quando o archiver falha ou a saída fecha antes do fim (o navegador desistiu: code
// 'ERR_STREAM_PREMATURE_CLOSE'). Arquivo que sumiu entre o plano e a leitura fica de fora
// (aviso ENOENT do archiver), como no backup.
function writeExportZip(output, plan) {
    const archiver = require('archiver');
    return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 6 } });
        let settled = false;
        const fail = error => {
            if (settled) return;
            settled = true;
            archive.abort();
            reject(error);
        };
        archive.on('warning', error => {
            if (error && error.code === 'ENOENT') return;
            fail(error);
        });
        archive.on('error', fail);
        output.once('error', fail);
        output.once('finish', () => { if (!settled) { settled = true; resolve(); } });
        output.once('close', () => {
            if (output.writableFinished) {
                if (!settled) { settled = true; resolve(); }
                return;
            }
            fail(Object.assign(new Error('O download das entregas foi interrompido antes do fim.'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
        });
        archive.pipe(output);
        archive.append(plan.csv, { name: 'lista.csv' });
        plan.entries.forEach(entry => {
            if (entry.kind === 'text') archive.append(entry.content, { name: entry.name });
            // archive.file abre o arquivo só na hora de ler (sem um descritor por arquivo).
            else archive.file(entry.abs, { name: entry.name, store: entry.store });
        });
        archive.finalize().catch(fail);
    });
}

module.exports = {
    EXPORT_VERSIONS,
    STATUS_LABELS,
    safeZipSegment,
    uniqueName,
    buildExportPlan,
    writeExportZip,
};
