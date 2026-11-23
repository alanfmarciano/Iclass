// Pacote de curso (fase 3, P4-S14: CRIT-06; decisões D25 a D27 do desenho P4; contratos
// C9 e C12 do P4 e coursePackage dos shared_contracts do plano).
//
// Leva um curso de uma instalação do IClass para outra num ZIP (.iclass-curso.zip,
// formato 'iclass-curso', versão 1):
//   manifest.json            o curso (só os campos de COURSE_PACKAGE_FIELDS), as avaliações
//                            com os gabaritos, os itens da biblioteca do curso, as questões
//                            do banco que vieram das avaliações do curso, os modelos de
//                            turma (nome, período e grade, sem alunos) e a lista de arquivos
//                            com o tamanho e o sha256 de cada um;
//   conteudo/<chave>.md      apostilas e avaliações em Markdown;
//   midia/uploads/<nome>     arquivos de /uploads citados (imagens do editor, arquivos das
//                            unidades e da biblioteca, logo do curso);
//   midia/imagens/<caminho>  imagens de content/imagens citadas nas apostilas.
// Nenhum dado pessoal: sem alunos, notas, presença, entregas, aplicações, e-mails de autor
// nem quem exportou (isso fica na auditoria).
//
// Importar (importCoursePackage) confere o ZIP inteiro antes de gravar (caminhos, link
// simbólico, cifra, tamanho declarado e real, sha256 de cada arquivo, versão do formato),
// gera o código do curso pedido, mantém as chaves que não existem aqui e renomeia as que
// colidem pela mesma regra do "Duplicar" ('<chave>_<código>'), renomeia imagem e arquivo
// com o mesmo nome e conteúdo diferente, reescreve as referências e grava tudo ou nada:
// os arquivos entram por link (nunca por cima de um que já existe) a partir de uma pasta
// temporária no mesmo disco, e undo() os tira de novo se a gravação do banco falhar.
//
// remapCourseKeys é o remapeamento de chaves do "Duplicar curso" (admin.js), extraído
// para as duas rotas usarem o mesmo código. Campo novo do curso que deve viajar entra em
// COURSE_PACKAGE_FIELDS com teste de ida e volta; se guarda chave de apostila, avaliação,
// módulo ou disciplina, entra também em remapCourseKeys (contrato do plano: o dono do
// campo faz isso no mesmo PR).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zipInspect = require('./zipInspect.js');
const { referencedUploads, safeImageSegments } = require('./contentMedia.js');
const { isInheritedKey } = require('./ownEntry.js');
const { headSignatureMatches, isBlockedUploadName } = require('./uploadSecurity.js');
const attendanceUtil = require('./attendance.js');
const { extractBranding } = require('./branding.js');
const { schoolDateOf } = require('./schoolTime.js');

const COURSE_PACKAGE_FORMAT = 'iclass-curso';
const COURSE_PACKAGE_VERSION = 1;
const COURSE_PACKAGE_EXTENSION = '.iclass-curso.zip';

// Campos do curso que viajam no pacote (lista permitida, contrato C9). Ficam de fora o
// código (a importação escolhe), a escola (é desta instalação), a situação e a lixeira,
// e a origem do "Duplicar".
const COURSE_PACKAGE_FIELDS = Object.freeze(['name', 'description', 'structure', 'disciplinas', 'gradeTemplates', 'branding']);

const PACKAGE_LIMITS = Object.freeze({
    maxBytes: 200 * 1024 * 1024, // o arquivo .zip (envio e exportação)
    maxEntries: 5000,
    maxTotalBytes: 512 * 1024 * 1024, // soma descompactada (bomba de descompressão)
    maxEntryBytes: 200 * 1024 * 1024,
    maxManifestBytes: 32 * 1024 * 1024,
    maxModules: 200,
    maxUnits: 2000,
    maxLibrary: 2000,
    maxQuestions: 10000,
    maxClasses: 100,
    maxEvaluationQuestions: 500,
});

const MANIFEST_ENTRY = 'manifest.json';
const PREFIX = Object.freeze({ conteudo: 'conteudo/', upload: 'midia/uploads/', imagem: 'midia/imagens/' });
const SAFE_CONTENT_KEY = /^[a-zA-Z0-9_-]{1,200}$/;
const SAFE_UPLOAD_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
// Arquivo de /uploads só com assinatura conhecida (a mesma conferência do envio pelo
// painel, utils/uploadSecurity.js): o que o painel aceitou volta a ser aceito aqui.
const UPLOAD_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.zip', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.doc', '.xls', '.ppt', '.mp4', '.mov', '.webm', '.csv', '.txt', '.md', '.json']);
const BACKUP_LIKE_EXTENSIONS = new Set(['.json', '.zip']);
// Campos de autoria ou de pessoa que nunca entram no pacote (o pacote não tem e-mail).
const PERSONAL_FIELDS = new Set(['author', 'createdBy', 'updatedBy', 'archivedBy', 'deletedBy', 'publishedBy', 'reviewedBy', 'gradedBy', 'importedBy', 'restoredBy']);

class CoursePackageError extends Error {
    constructor(message, { status = 400, code = 'invalid_package', field } = {}) {
        super(message);
        this.name = 'CoursePackageError';
        this.status = status;
        this.code = code;
        if (field) this.field = field;
    }

    // Corpo da resposta da recusa: o texto é sempre um destes, fixos e em português
    // (nunca a mensagem de uma falha inesperada), com o código e o campo para a tela.
    toResponse() {
        return { success: false, error: this.message, code: this.code, ...(this.field ? { field: this.field } : {}) };
    }
}

const refuse = (message, options) => new CoursePackageError(message, options);
const INVALID = message => refuse(`Pacote de curso inválido: ${message}`);

function deepCopy(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Cópia de um valor vindo do pacote (JSON de outra instalação): sem chave herdada de
// Object.prototype ('__proto__', 'constructor', 'prototype') e sem os campos de autoria.
function cleanValue(value, depth = 0) {
    if (depth > 40) throw INVALID('dados aninhados demais.');
    if (Array.isArray(value)) return value.map(item => cleanValue(item, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (isInheritedKey(key) || key === 'prototype' || PERSONAL_FIELDS.has(key)) continue;
            out[key] = cleanValue(item, depth + 1);
        }
        return out;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
}

// ------------------------------------------------------------------ remapCourseKeys

function unitsOf(module) {
    if (!module || typeof module !== 'object') return [];
    if (Array.isArray(module.units)) return module.units;
    return Array.isArray(module.items) ? module.items : [];
}

function readOverrides(cls) {
    const raw = cls && isPlainObject(cls.contentOverrides) ? cls.contentOverrides : {};
    return {
        materials: isPlainObject(raw.materials) ? raw.materials : {},
        evaluations: isPlainObject(raw.evaluations) ? raw.evaluations : {},
        unitNames: isPlainObject(raw.unitNames) ? raw.unitNames : {},
        extraUnits: Array.isArray(raw.extraUnits) ? raw.extraUnits : [],
        structure: Array.isArray(raw.structure) ? raw.structure : null,
    };
}

// Troca as chaves de apostila e de avaliação de um curso e das turmas dele por
// mapKey(chave, 'material' | 'evaluation'), sem mexer nos originais. Devolve cópias:
// { course (estrutura remapeada), classes (variantes, nomes de unidade, unidades extras,
// estrutura própria, releasedItems e releaseSchedule remapeados, courseId novo),
// materialKeys e evaluationKeys (Map chave antiga -> nova, na ordem em que apareceram) e
// mapItemKey (chave de item liberável, com o prefixo Gabarito_) }.
// A ordem dos passos é a do "Duplicar curso" de antes da extração: o nome de unidade de
// uma turma usa só as chaves vistas até ali. Quem grava arquivo e avaliação é quem chama.
// Campos novos com chave de módulo, item ou disciplina (disciplinas[].modulos e
// classes[].avaliacao.itens do P2, contrato C6) entram aqui pelo dono do campo.
function remapCourseKeys({ course = null, classes = [], newCourseId, mapKey }) {
    const materialKeys = new Map();
    const evaluationKeys = new Map();
    const materialKey = oldKey => {
        if (!oldKey) return oldKey;
        if (!materialKeys.has(oldKey)) materialKeys.set(oldKey, mapKey(oldKey, 'material'));
        return materialKeys.get(oldKey);
    };
    const evaluationKey = oldKey => {
        if (!oldKey) return oldKey;
        if (!evaluationKeys.has(oldKey)) evaluationKeys.set(oldKey, mapKey(oldKey, 'evaluation'));
        return evaluationKeys.get(oldKey);
    };
    const remapModule = module => {
        const copy = deepCopy(module);
        unitsOf(copy).forEach(unit => {
            if (unit.apostilaKey) unit.apostilaKey = materialKey(unit.apostilaKey);
            if (unit.avaliacaoKey) unit.avaliacaoKey = evaluationKey(unit.avaliacaoKey);
        });
        return copy;
    };
    const mappedItemKey = key => materialKeys.get(key) || evaluationKeys.get(key) || key;
    const mapItemKey = key => (String(key).startsWith('Gabarito_')
        ? `Gabarito_${evaluationKey(String(key).slice('Gabarito_'.length))}`
        : mappedItemKey(key));

    let newCourse = null;
    if (course) {
        newCourse = deepCopy(course);
        newCourse.structure = (Array.isArray(course.structure) ? course.structure : []).map(remapModule);
    }

    const newClasses = (classes || []).map(sourceClass => {
        const cloned = deepCopy(sourceClass);
        if (newCourseId !== undefined) cloned.courseId = newCourseId;
        const sourceOverrides = readOverrides(sourceClass);
        const materials = {};
        Object.entries(sourceOverrides.materials).forEach(([baseKey, entry]) => {
            const variantKey = entry?.key || entry;
            materials[materialKey(baseKey)] = { ...(typeof entry === 'object' ? entry : {}), key: materialKey(variantKey) };
        });
        const evaluations = {};
        Object.entries(sourceOverrides.evaluations).forEach(([baseKey, entry]) => {
            const variantKey = entry?.key || entry;
            evaluations[evaluationKey(baseKey)] = { ...(typeof entry === 'object' ? entry : {}), key: evaluationKey(variantKey) };
        });
        const unitNames = {};
        Object.entries(sourceOverrides.unitNames || {}).forEach(([key, value]) => {
            unitNames[evaluationKeys.get(key) || materialKeys.get(key) || key] = value;
        });
        cloned.contentOverrides = {
            materials,
            evaluations,
            unitNames,
            structure: Array.isArray(sourceOverrides.structure) ? sourceOverrides.structure.map(remapModule) : null,
            extraUnits: (sourceOverrides.extraUnits || []).map(extra => ({
                ...deepCopy(extra),
                unit: {
                    ...deepCopy(extra.unit || {}),
                    apostilaKey: extra.unit?.apostilaKey ? materialKey(extra.unit.apostilaKey) : undefined,
                    avaliacaoKey: extra.unit?.avaliacaoKey ? evaluationKey(extra.unit.avaliacaoKey) : undefined,
                },
            })),
        };
        cloned.releasedItems = Object.fromEntries(Object.entries(sourceClass.releasedItems || {}).map(([key, value]) => {
            if (key.startsWith('Gabarito_')) return [`Gabarito_${evaluationKey(key.slice('Gabarito_'.length))}`, value];
            return [mappedItemKey(key), value];
        }));
        // Liberação agendada (P3-S12, D27): as chaves seguem as do curso novo, como
        // releasedItems. O adiamento era da aplicação do curso de origem e não vem junto.
        if (isPlainObject(sourceClass.releaseSchedule)) {
            cloned.releaseSchedule = Object.fromEntries(Object.entries(sourceClass.releaseSchedule).map(([key, entry]) => {
                const { adiadoEm, ...rest } = isPlainObject(entry) ? entry : {};
                const clonedKey = key.startsWith('Gabarito_')
                    ? `Gabarito_${evaluationKey(key.slice('Gabarito_'.length))}`
                    : mappedItemKey(key);
                return [clonedKey, deepCopy(rest)];
            }));
        }
        return cloned;
    });

    return { course: newCourse, classes: newClasses, materialKeys, evaluationKeys, mapItemKey };
}

// ------------------------------------------------------------------ o que o curso leva

function courseUnitKeys(course) {
    const materials = [];
    const evaluations = [];
    (Array.isArray(course?.structure) ? course.structure : []).forEach(module => unitsOf(module).forEach(unit => {
        if (unit && typeof unit.apostilaKey === 'string' && unit.apostilaKey && !materials.includes(unit.apostilaKey)) materials.push(unit.apostilaKey);
        if (unit && typeof unit.avaliacaoKey === 'string' && unit.avaliacaoKey && !evaluations.includes(unit.avaliacaoKey)) evaluations.push(unit.avaliacaoKey);
    }));
    return { materials, evaluations };
}

// Questões do banco que são do curso (contrato C12): as que vieram de uma avaliação do
// curso (sourceExamKey). Se o banco ganhar courseId ou categoria por curso, o seletor
// passa a usar o campo novo aqui.
function coursePackageQuestions(memory, course) {
    const keys = new Set(courseUnitKeys(course).evaluations);
    return (Array.isArray(memory?.questionBank) ? memory.questionBank : [])
        .filter(item => item && typeof item.sourceExamKey === 'string' && keys.has(item.sourceExamKey));
}

// Itens da biblioteca do curso (os de turma são variantes da turma e ficam).
function courseLibraryEntries(memory, course) {
    return (Array.isArray(memory?.library) ? memory.library : [])
        .filter(entry => entry && String(entry.courseId || '') === String(course.id) && !entry.studentClass);
}

const LIBRARY_FIELDS = ['kind', 'moduleId', 'name', 'originalName', 'filename', 'url', 'type', 'ext', 'size', 'description', 'tags', 'hidden'];
function libraryForPackage(entry) {
    const out = {};
    LIBRARY_FIELDS.forEach(field => { if (entry[field] !== undefined) out[field] = deepCopy(entry[field]); });
    return out;
}

// Imagens de content/imagens citadas num texto (Markdown ou HTML): 'imagens/a/b.svg' ou
// '/imagens/a/b.svg'.
const IMAGE_REFERENCE = /(^|[^A-Za-z0-9_.\/-])(\/?imagens\/)([^\s)"'<>?#\\]+)/g;
function referencedContentImages(text) {
    const found = new Set();
    String(text || '').replace(IMAGE_REFERENCE, (match, before, prefix, rel) => {
        const segments = safeImageSegments(rel.split('/'));
        if (segments && IMAGE_EXTENSIONS.has(path.extname(rel).toLowerCase())) found.add(segments.join('/'));
        return match;
    });
    return found;
}

// Reescreve as referências de /uploads e de content/imagens com os nomes novos.
const UPLOAD_REWRITE = /(\/?uploads\/)([A-Za-z0-9._-]+)/g;
function rewriteReferences(text, { uploads, images }) {
    let out = String(text);
    if (uploads && uploads.size) out = out.replace(UPLOAD_REWRITE, (match, prefix, name) => (uploads.has(name) ? `${prefix}${uploads.get(name)}` : match));
    if (images && images.size) {
        out = out.replace(IMAGE_REFERENCE, (match, before, prefix, rel) => (images.has(rel) ? `${before}${prefix}${images.get(rel)}` : match));
    }
    return out;
}

function rewriteValue(value, maps) {
    if (value === undefined) return value;
    return JSON.parse(rewriteReferences(JSON.stringify(value), maps));
}

function listContentFiles(contentDir) {
    try {
        return fs.readdirSync(contentDir).filter(name => name.toLowerCase().endsWith('.md'));
    } catch (error) {
        return [];
    }
}

function findContentFileSync(files, contentDir, key) {
    if (!SAFE_CONTENT_KEY.test(String(key || ''))) return null;
    const wanted = `${key}.md`;
    const match = files.find(file => file === wanted) || files.find(file => file.toLowerCase() === wanted.toLowerCase());
    return match ? path.join(contentDir, match) : null;
}

function regularFile(filePath) {
    try {
        const stat = fs.lstatSync(filePath);
        return stat.isFile() ? stat : null;
    } catch (error) {
        return null;
    }
}

function readHead(filePath, length = 32) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(fd, buffer, 0, length, 0);
        return buffer.subarray(0, read);
    } finally {
        fs.closeSync(fd);
    }
}

function svgLooksLikeText(head) {
    return head.length > 0 && !head.includes(0);
}

function imageSignatureOk(ext, head) {
    if (ext === '.svg') return svgLooksLikeText(head);
    return headSignatureMatches(head, ext);
}

function uploadSignatureOk(name, head) {
    const ext = path.extname(name).toLowerCase();
    if (isBlockedUploadName(name) || !UPLOAD_EXTENSIONS.has(ext)) return false;
    return headSignatureMatches(head, ext);
}

// .json/.zip que parece um backup do IClass (o banco inteiro, com os hashes de senha,
// SEG-X1) nunca entra no pacote nem sai dele.
// `name` é o nome original quando o arquivo está numa área temporária sem extensão.
async function looksLikeBackup(filePath, name = filePath) {
    if (!BACKUP_LIKE_EXTENSIONS.has(path.extname(name).toLowerCase())) return false;
    try {
        // Carregado aqui para o módulo não depender do banco na carga.
        return await require('./backup.js').fileLooksLikeBackup(filePath);
    } catch (error) {
        return true;
    }
}

function appVersion() {
    try { return String(require('../../package.json').version || ''); } catch (error) { return ''; }
}

function contentDirs(options = {}) {
    const runtimePaths = require('../runtimePaths.js');
    const contentDir = options.contentDir || runtimePaths.CONTENT_DIR;
    return {
        contentDir,
        uploadsDir: options.uploadsDir || runtimePaths.UPLOADS_DIR,
        imagesDir: options.imagesDir || path.join(contentDir, 'imagens'),
    };
}

function packageFileName(course, now) {
    const date = schoolDateOf(now) || new Date(now).toISOString().slice(0, 10);
    return `curso_${String(course.id).replace(/[^A-Za-z0-9_-]/g, '_')}_${date}${COURSE_PACKAGE_EXTENSION}`;
}

// Monta o pacote de um curso. Devolve { buffer, fileName, manifest, contagens, bytes,
// arquivos, foraDoPacote }. Recusa: curso inexistente (404) e pacote acima do limite (413).
async function exportCoursePackage(memory, courseId, options = {}) {
    const now = options.now || Date.now();
    const { contentDir, uploadsDir, imagesDir } = contentDirs(options);
    const course = (Array.isArray(memory?.courses) ? memory.courses : []).find(item => item && String(item.id) === String(courseId));
    if (!course) throw refuse('Curso não encontrado.', { status: 404, code: 'course_not_found' });

    const curso = { codigo: String(course.id) };
    COURSE_PACKAGE_FIELDS.forEach(field => {
        if (course[field] !== undefined) curso[field] = cleanValue(deepCopy(course[field]));
    });
    if (!Array.isArray(curso.structure)) curso.structure = [];

    const { materials, evaluations } = courseUnitKeys(course);
    const evaluationSet = new Set(evaluations);
    const avaliacoes = {};
    evaluations.forEach(key => {
        const evaluation = memory?.evaluations && Object.prototype.hasOwnProperty.call(memory.evaluations, key) ? memory.evaluations[key] : null;
        if (isPlainObject(evaluation)) avaliacoes[key] = cleanValue(deepCopy(evaluation));
    });

    // Questões do banco: sem a chave (a importação gera outra) e com uma referência
    // própria do pacote ('q1', 'q2'...), para a questão da avaliação que veio do banco
    // (bankKey) continuar ligada a ela na outra instalação.
    const bankRefs = new Map();
    const questoes = coursePackageQuestions(memory, course).map((item, index) => {
        const ref = `q${index + 1}`;
        bankRefs.set(item.key, ref);
        const { key, ...rest } = cleanValue(deepCopy(item));
        return { ...rest, ref };
    });
    Object.values(avaliacoes).forEach(evaluation => {
        (Array.isArray(evaluation.questions) ? evaluation.questions : []).forEach(question => {
            if (!question || typeof question !== 'object' || question.bankKey === undefined) return;
            if (bankRefs.has(question.bankKey)) question.bankKey = bankRefs.get(question.bankKey);
            else delete question.bankKey;
        });
    });

    const biblioteca = courseLibraryEntries(memory, course).map(entry => cleanValue(libraryForPackage(entry)));
    const turmasModelo = (Array.isArray(memory?.classes) ? memory.classes : [])
        .filter(cls => cls && String(cls.courseId) === String(course.id) && typeof cls.name === 'string' && cls.name.trim())
        .map(cls => ({ name: cls.name, ...(cls.period ? { period: cls.period } : {}), attendanceConfig: deepCopy(attendanceUtil.effectiveAttendanceConfig(cls)) }));

    // Arquivos: as apostilas e avaliações (.md) e o que elas e os dados citam.
    const files = listContentFiles(contentDir);
    const conteudo = [];
    const texts = [];
    [...materials, ...evaluations].forEach(key => {
        if (conteudo.some(item => item.chave === key)) return;
        const filePath = findContentFileSync(files, contentDir, key);
        if (!filePath || !regularFile(filePath)) return;
        const buffer = fs.readFileSync(filePath);
        conteudo.push({ chave: key, buffer });
        texts.push(buffer.toString('utf8'));
    });
    const dataText = JSON.stringify([curso, avaliacoes, biblioteca, questoes]);
    texts.push(dataText);

    const foraDoPacote = [];
    const uploadNames = new Set();
    texts.forEach(text => referencedUploads(text).forEach(name => uploadNames.add(name)));
    biblioteca.forEach(entry => { if (entry.kind !== 'link' && typeof entry.filename === 'string') uploadNames.add(entry.filename); });
    const uploads = [];
    for (const name of [...uploadNames].sort()) {
        if (!SAFE_UPLOAD_NAME.test(name)) continue;
        const filePath = path.join(uploadsDir, name);
        const stat = regularFile(filePath);
        if (!stat) { foraDoPacote.push({ arquivo: `uploads/${name}`, motivo: 'não encontrado nesta instalação' }); continue; }
        if (!uploadSignatureOk(name, readHead(filePath)) || await looksLikeBackup(filePath)) {
            foraDoPacote.push({ arquivo: `uploads/${name}`, motivo: 'tipo de arquivo não aceito no pacote' });
            continue;
        }
        uploads.push({ name, filePath, size: stat.size });
    }
    const imagePaths = new Set();
    texts.forEach(text => referencedContentImages(text).forEach(rel => imagePaths.add(rel)));
    const imagens = [];
    for (const rel of [...imagePaths].sort()) {
        const filePath = path.join(imagesDir, ...rel.split('/'));
        const stat = regularFile(filePath);
        if (!stat) { foraDoPacote.push({ arquivo: `imagens/${rel}`, motivo: 'não encontrado nesta instalação' }); continue; }
        if (!imageSignatureOk(path.extname(rel).toLowerCase(), readHead(filePath))) {
            foraDoPacote.push({ arquivo: `imagens/${rel}`, motivo: 'tipo de arquivo não aceito no pacote' });
            continue;
        }
        imagens.push({ rel, filePath, size: stat.size });
    }

    const declared = conteudo.reduce((sum, item) => sum + item.buffer.length, 0)
        + uploads.reduce((sum, item) => sum + item.size, 0)
        + imagens.reduce((sum, item) => sum + item.size, 0);
    const limit = options.maxBytes || PACKAGE_LIMITS.maxBytes;
    if (declared > limit) {
        throw refuse(`O curso tem ${formatMb(declared)} em arquivos, mais que o limite do pacote (${formatMb(limit)}). Tire da biblioteca do curso os arquivos grandes (vídeos, por exemplo) e exporte de novo.`, { status: 413, code: 'package_too_large' });
    }

    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    const arquivos = [];
    const add = (caminho, tipo, buffer, extra = {}) => {
        zip.addFile(caminho, buffer);
        arquivos.push({ caminho, tipo, ...extra, bytes: buffer.length, sha256: sha256(buffer) });
    };
    conteudo.forEach(item => add(`${PREFIX.conteudo}${item.chave}.md`, 'conteudo', item.buffer, { chave: item.chave }));
    uploads.forEach(item => add(`${PREFIX.upload}${item.name}`, 'upload', fs.readFileSync(item.filePath)));
    imagens.forEach(item => add(`${PREFIX.imagem}${item.rel}`, 'imagem', fs.readFileSync(item.filePath)));

    const contagens = {
        modulos: curso.structure.length,
        unidades: curso.structure.reduce((sum, module) => sum + unitsOf(module).length, 0),
        apostilas: materials.length,
        avaliacoes: Object.keys(avaliacoes).length,
        questoesNasAvaliacoes: Object.values(avaliacoes).reduce((sum, evaluation) => sum + (Array.isArray(evaluation.questions) ? evaluation.questions.length : 0), 0),
        conteudos: conteudo.length,
        arquivos: uploads.length,
        imagens: imagens.length,
        biblioteca: biblioteca.length,
        questoesBanco: questoes.length,
        turmasModelo: turmasModelo.length,
    };
    const manifest = {
        formato: COURSE_PACKAGE_FORMAT,
        versao: COURSE_PACKAGE_VERSION,
        versaoApp: options.appVersion || appVersion(),
        exportadoEm: now,
        curso,
        avaliacoes,
        biblioteca,
        questoes,
        turmasModelo,
        contagens,
        foraDoPacote,
        arquivos,
    };
    zip.addFile(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    const buffer = zip.toBuffer();
    if (buffer.length > limit) {
        throw refuse(`O pacote do curso passou de ${formatMb(limit)}. Tire da biblioteca do curso os arquivos grandes e exporte de novo.`, { status: 413, code: 'package_too_large' });
    }
    return { buffer, fileName: packageFileName(course, now), manifest, contagens, bytes: buffer.length, arquivos: arquivos.length, foraDoPacote };
}

function formatMb(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1).replace('.', ',')} MB`;
}

// ------------------------------------------------------------------ leitura e conferência

async function openSource(input) {
    if (Buffer.isBuffer(input)) return { source: zipInspect.bufferSource(input), close: async () => {}, size: input.length, hash: async () => sha256(input) };
    const filePath = input && typeof input === 'object' ? input.path : null;
    if (!filePath) throw refuse('Envie o arquivo do pacote de curso (.iclass-curso.zip).', { code: 'package_missing' });
    const handle = await fs.promises.open(filePath, 'r');
    const { size } = await handle.stat();
    return {
        source: zipInspect.fileSource(filePath, handle, size),
        close: () => handle.close().catch(() => {}),
        size,
        hash: () => new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            fs.createReadStream(filePath).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
        }),
    };
}

function entryKind(name) {
    if (name.startsWith(PREFIX.conteudo)) return 'conteudo';
    if (name.startsWith(PREFIX.upload)) return 'upload';
    if (name.startsWith(PREFIX.imagem)) return 'imagem';
    return null;
}

const ALLOWED_DIRECTORIES = new Set(['conteudo/', 'midia/', 'midia/uploads/', 'midia/imagens/']);

// Regras de cada entrada do ZIP: caminho relativo normalizado, sem '..', sem caminho
// absoluto nem letra de unidade, sem barra invertida, sem repetição (sem diferença de
// maiúsculas), sem link simbólico, sem cifra e com compressão que o IClass lê; só
// manifest.json, conteudo/ e midia/ (uploads e imagens).
function checkEntries(entries) {
    const seen = new Set();
    for (const entry of entries) {
        const name = String(entry.name || '');
        const raw = String(entry.rawName || name);
        if (!name || raw.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || /[\x00-\x1f]/.test(name)) {
            throw INVALID(`caminho inseguro no ZIP (${name.slice(0, 200)}).`);
        }
        if (path.posix.normalize(name).replace(/\/$/, '') !== name.replace(/\/$/, '')) throw INVALID(`caminho não normalizado no ZIP (${name.slice(0, 200)}).`);
        const key = name.replace(/\/$/, '').toLowerCase();
        if (seen.has(key)) throw INVALID(`entrada repetida no ZIP (${name.slice(0, 200)}).`);
        seen.add(key);
        if (zipInspect.isSymlinkEntry(entry)) throw INVALID(`link simbólico no ZIP (${name.slice(0, 200)}).`);
        if (entry.isDirectory) {
            if (!ALLOWED_DIRECTORIES.has(name) && !(name.startsWith(PREFIX.imagem) && safeImageSegments(name.slice(PREFIX.imagem.length, -1).split('/')))) {
                throw INVALID(`pasta que não é do pacote de curso (${name.slice(0, 200)}).`);
            }
            continue;
        }
        if (name !== MANIFEST_ENTRY && !entryKind(name)) throw INVALID(`arquivo fora das pastas do pacote de curso (${name.slice(0, 200)}).`);
        if (entry.encrypted || (entry.method !== 0 && entry.method !== 8)) throw INVALID(`o arquivo ${name.slice(0, 200)} está cifrado ou usa uma compressão que o IClass não lê.`);
        if (entry.size > PACKAGE_LIMITS.maxEntryBytes) throw INVALID(`o arquivo ${name.slice(0, 200)} é grande demais.`);
    }
}

// Caminho de cada arquivo listado no manifesto, pelo tipo.
function checkListedPath(item) {
    const caminho = item.caminho;
    if (item.tipo === 'conteudo') {
        const match = /^conteudo\/([a-zA-Z0-9_-]{1,200})\.md$/.exec(caminho);
        if (!match || item.chave !== match[1]) throw INVALID(`arquivo de conteúdo com nome inválido (${caminho.slice(0, 200)}).`);
        return { chave: match[1] };
    }
    if (item.tipo === 'upload') {
        const name = caminho.slice(PREFIX.upload.length);
        if (!caminho.startsWith(PREFIX.upload) || !SAFE_UPLOAD_NAME.test(name)) throw INVALID(`arquivo com nome inválido (${caminho.slice(0, 200)}).`);
        const ext = path.extname(name).toLowerCase();
        if (isBlockedUploadName(name) || !UPLOAD_EXTENSIONS.has(ext)) throw INVALID(`tipo de arquivo não aceito (${name}).`);
        return { name };
    }
    if (item.tipo === 'imagem') {
        const rel = caminho.slice(PREFIX.imagem.length);
        const segments = caminho.startsWith(PREFIX.imagem) ? safeImageSegments(rel.split('/')) : null;
        if (!segments || !IMAGE_EXTENSIONS.has(path.extname(rel).toLowerCase())) throw INVALID(`imagem com nome inválido (${caminho.slice(0, 200)}).`);
        return { rel: segments.join('/') };
    }
    throw INVALID(`tipo de arquivo desconhecido no manifesto (${String(item.tipo).slice(0, 40)}).`);
}

async function readManifest(source, directory, entry) {
    if (entry.size > PACKAGE_LIMITS.maxManifestBytes) throw INVALID('manifest.json grande demais.');
    const buffer = await zipInspect.readZipEntryBuffer(source, directory, entry, entry.size);
    if (!buffer || buffer.length !== entry.size) throw INVALID('manifest.json ilegível.');
    let manifest;
    try {
        manifest = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
    } catch (error) {
        throw INVALID('manifest.json não é um JSON válido.');
    }
    if (!isPlainObject(manifest) || manifest.formato !== COURSE_PACKAGE_FORMAT) {
        throw refuse('Este arquivo não é um pacote de curso do IClass. Use o arquivo .iclass-curso.zip baixado em "Exportar curso". (Um backup do IClass se restaura em Sistema > Backup.)', { code: 'not_course_package' });
    }
    if (!Number.isInteger(manifest.versao) || manifest.versao < 1) throw INVALID('versão do formato inválida.');
    if (manifest.versao > COURSE_PACKAGE_VERSION) {
        throw refuse(`Este pacote foi feito por uma versão mais nova do IClass (${String(manifest.versaoApp || 'formato ' + manifest.versao).slice(0, 40)}). Atualize o IClass deste computador para importá-lo.`, { code: 'package_too_new' });
    }
    return manifest;
}

// Abre e confere o pacote. Com verifyFiles, relê cada arquivo e confere tamanho real,
// sha256 e assinatura; com stageFile(item, info) => caminho, grava cada um nesse caminho
// enquanto confere. Devolve { sha256, manifest, files: [{ ...item listado, chave|name|rel,
// staged }] }.
async function readCoursePackage(input, { verifyFiles = true, stageFile = null, limits = PACKAGE_LIMITS } = {}) {
    const opened = await openSource(input);
    try {
        if (opened.size > limits.maxBytes) {
            throw refuse(`O pacote passa do limite de ${formatMb(limits.maxBytes)}.`, { status: 413, code: 'package_too_large' });
        }
        const packageSha = await opened.hash();
        let directory = null;
        try { directory = await zipInspect.readZipDirectory(opened.source); } catch (error) { directory = null; }
        if (!directory) throw refuse('Este arquivo não é um pacote de curso do IClass (o ZIP não pôde ser lido).', { code: 'invalid_zip' });
        if (directory.entries.length > limits.maxEntries) throw INVALID(`arquivos demais no ZIP (mais de ${limits.maxEntries}).`);
        checkEntries(directory.entries);
        const manifestEntry = directory.entries.find(entry => entry.name === MANIFEST_ENTRY);
        if (!manifestEntry) {
            throw refuse('Este arquivo não é um pacote de curso do IClass (falta o manifest.json). Use o arquivo .iclass-curso.zip baixado em "Exportar curso".', { code: 'not_course_package' });
        }
        const manifest = await readManifest(opened.source, directory, manifestEntry);
        if (!Array.isArray(manifest.arquivos)) throw INVALID('lista de arquivos ausente no manifesto.');
        const byName = new Map(directory.entries.filter(entry => !entry.isDirectory && entry.name !== MANIFEST_ENTRY).map(entry => [entry.name, entry]));
        const listed = new Set();
        let total = 0;
        const files = manifest.arquivos.map(raw => {
            if (!isPlainObject(raw) || typeof raw.caminho !== 'string' || typeof raw.tipo !== 'string') throw INVALID('arquivo mal descrito no manifesto.');
            if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 0 || typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) throw INVALID(`tamanho ou sha256 inválido para ${raw.caminho.slice(0, 200)}.`);
            if (listed.has(raw.caminho)) throw INVALID(`arquivo listado duas vezes no manifesto (${raw.caminho.slice(0, 200)}).`);
            listed.add(raw.caminho);
            const entry = byName.get(raw.caminho);
            if (!entry) throw INVALID(`o arquivo ${raw.caminho.slice(0, 200)} está no manifesto e não está no ZIP.`);
            if (entry.size !== raw.bytes) throw INVALID(`o tamanho de ${raw.caminho.slice(0, 200)} não confere com o manifesto.`);
            if (entryKind(raw.caminho) !== raw.tipo) throw INVALID(`o arquivo ${raw.caminho.slice(0, 200)} está na pasta errada para o tipo.`);
            total += raw.bytes;
            return { caminho: raw.caminho, tipo: raw.tipo, chave: typeof raw.chave === 'string' ? raw.chave : undefined, bytes: raw.bytes, sha256: raw.sha256, entry, ...checkListedPath(raw) };
        });
        const extra = [...byName.keys()].find(name => !listed.has(name));
        if (extra) throw INVALID(`o arquivo ${extra.slice(0, 200)} está no ZIP e não está no manifesto.`);
        if (total > limits.maxTotalBytes) throw INVALID(`os arquivos descompactados passam de ${formatMb(limits.maxTotalBytes)}.`);
        if (verifyFiles || stageFile) {
            for (const file of files) {
                const target = stageFile ? stageFile(file) : null;
                const result = await readEntry(opened.source, directory, file, target);
                if (result.bytes !== file.bytes || result.sha256 !== file.sha256) {
                    throw INVALID(`o conteúdo de ${file.caminho.slice(0, 200)} não confere com o manifesto (arquivo corrompido ou alterado).`);
                }
                if (!headOk(file, result.head)) throw INVALID(`o arquivo ${file.caminho.slice(0, 200)} não é do tipo que o nome diz.`);
                if (target) file.staged = target;
            }
        }
        return { sha256: packageSha, manifest, files };
    } finally {
        await opened.close();
    }
}

function headOk(file, head) {
    if (file.tipo === 'conteudo') return !head.includes(0);
    if (file.tipo === 'upload') return uploadSignatureOk(file.name, head);
    return imageSignatureOk(path.extname(file.rel).toLowerCase(), head);
}

// Lê uma entrada em pedaços (no máximo o tamanho declarado mais um byte: a bomba de
// descompressão com tamanho falso para ali), com o sha256 e os primeiros bytes; com
// target, grava no arquivo ao mesmo tempo.
async function readEntry(source, directory, file, target) {
    const hash = crypto.createHash('sha256');
    const headParts = [];
    let headLength = 0;
    let bytes = 0;
    let fd = null;
    if (target) fd = fs.openSync(target, 'wx');
    try {
        const stream = await zipInspect.openEntryStream(source, directory, file.entry);
        if (!stream) throw INVALID(`o arquivo ${file.caminho.slice(0, 200)} não pôde ser lido.`);
        const result = await zipInspect.scanStream(stream, chunk => {
            bytes += chunk.length;
            if (bytes > file.bytes) return true; // maior que o declarado: para já
            hash.update(chunk);
            if (headLength < 32) { headParts.push(chunk); headLength += chunk.length; }
            if (fd !== null) fs.writeSync(fd, chunk);
            return false;
        }, { maxBytes: file.bytes + 1 });
        if (result === null) throw INVALID(`o arquivo ${file.caminho.slice(0, 200)} está corrompido.`);
    } finally {
        if (fd !== null) fs.closeSync(fd);
    }
    return { bytes, sha256: hash.digest('hex'), head: Buffer.concat(headParts).subarray(0, 32) };
}

// ------------------------------------------------------------------ dados do manifesto

function requireString(value, label, max) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw INVALID(`${label} precisa ser texto.`);
    if (value.length > max) throw INVALID(`${label} passa de ${max} caracteres.`);
    return value;
}

function validateStructure(structure) {
    if (!Array.isArray(structure)) throw INVALID('a estrutura do curso não é uma lista de módulos.');
    if (structure.length > PACKAGE_LIMITS.maxModules) throw INVALID(`módulos demais (mais de ${PACKAGE_LIMITS.maxModules}).`);
    let units = 0;
    structure.forEach((module, index) => {
        if (!isPlainObject(module)) throw INVALID(`o módulo ${index + 1} está mal formado.`);
        const list = module.units !== undefined ? module.units : module.items;
        if (list !== undefined && !Array.isArray(list)) throw INVALID(`as unidades do módulo ${index + 1} não são uma lista.`);
        (list || []).forEach((unit, unitIndex) => {
            units += 1;
            if (!isPlainObject(unit)) throw INVALID(`a unidade ${unitIndex + 1} do módulo ${index + 1} está mal formada.`);
            ['apostilaKey', 'avaliacaoKey'].forEach(field => {
                if (unit[field] === undefined || unit[field] === null || unit[field] === '') return;
                if (typeof unit[field] !== 'string' || !SAFE_CONTENT_KEY.test(unit[field])) throw INVALID(`chave de conteúdo inválida na unidade ${unitIndex + 1} do módulo ${index + 1}.`);
            });
            if (unit.files !== undefined && !Array.isArray(unit.files)) throw INVALID(`os arquivos da unidade ${unitIndex + 1} do módulo ${index + 1} não são uma lista.`);
        });
    });
    if (units > PACKAGE_LIMITS.maxUnits) throw INVALID(`unidades demais (mais de ${PACKAGE_LIMITS.maxUnits}).`);
}

// Confere e limpa os dados do manifesto. Devolve o pacote no formato que a importação usa.
function packageData(manifest) {
    const curso = isPlainObject(manifest.curso) ? cleanValue(manifest.curso) : null;
    if (!curso) throw INVALID('o curso não está no manifesto.');
    const codigo = requireString(curso.codigo, 'o código do curso', 64);
    const nome = requireString(curso.name, 'o nome do curso', 120).trim();
    const descricao = requireString(curso.description, 'a descrição do curso', 2000).trim();
    const structure = curso.structure === undefined ? [] : curso.structure;
    validateStructure(structure);
    let disciplinas;
    if (curso.disciplinas !== undefined) {
        disciplinas = attendanceUtil.sanitizeDisciplinas(curso.disciplinas);
        if (!disciplinas) throw INVALID('a lista de disciplinas está mal formada.');
    }
    let gradeTemplates;
    if (curso.gradeTemplates !== undefined) {
        gradeTemplates = attendanceUtil.sanitizeGradeTemplates(curso.gradeTemplates);
        if (!gradeTemplates) throw INVALID('os modelos de grade estão mal formados.');
    }
    const avisos = [];
    let branding;
    if (curso.branding !== undefined) {
        try {
            branding = isPlainObject(curso.branding) ? extractBranding(curso.branding) : undefined;
        } catch (error) {
            branding = undefined;
        }
        if (!branding) avisos.push('A identidade visual do curso no pacote está num formato que o IClass não reconhece e ficou de fora.');
    }
    // Campos de curso que esta versão não conhece (de versão mais nova do mesmo formato)
    // ficam de fora; só os de COURSE_PACKAGE_FIELDS entram.
    const avaliacoes = isPlainObject(manifest.avaliacoes) ? cleanValue(manifest.avaliacoes) : {};
    Object.entries(avaliacoes).forEach(([key, evaluation]) => {
        if (!SAFE_CONTENT_KEY.test(key)) throw INVALID(`avaliação com chave inválida (${key.slice(0, 200)}).`);
        if (!isPlainObject(evaluation)) throw INVALID(`a avaliação ${key} está mal formada.`);
        if (evaluation.questions !== undefined && !Array.isArray(evaluation.questions)) throw INVALID(`as questões da avaliação ${key} não são uma lista.`);
        if ((evaluation.questions || []).length > PACKAGE_LIMITS.maxEvaluationQuestions) throw INVALID(`a avaliação ${key} tem questões demais.`);
        (evaluation.questions || []).forEach((question, index) => {
            if (!isPlainObject(question)) throw INVALID(`a questão ${index + 1} da avaliação ${key} está mal formada.`);
        });
    });
    const biblioteca = Array.isArray(manifest.biblioteca) ? cleanValue(manifest.biblioteca) : [];
    if (biblioteca.length > PACKAGE_LIMITS.maxLibrary) throw INVALID('itens demais na biblioteca.');
    biblioteca.forEach((entry, index) => {
        if (!isPlainObject(entry) || !['file', 'link'].includes(entry.kind)) throw INVALID(`o item ${index + 1} da biblioteca está mal formado.`);
        if (entry.kind === 'link' && (typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url) || entry.url.length > 1000)) throw INVALID(`o link do item ${index + 1} da biblioteca é inválido.`);
        if (entry.kind === 'file' && (typeof entry.filename !== 'string' || !SAFE_UPLOAD_NAME.test(entry.filename))) throw INVALID(`o arquivo do item ${index + 1} da biblioteca é inválido.`);
        requireString(entry.name, `o nome do item ${index + 1} da biblioteca`, 200);
        requireString(entry.description, `a descrição do item ${index + 1} da biblioteca`, 500);
    });
    const questoes = Array.isArray(manifest.questoes) ? cleanValue(manifest.questoes) : [];
    if (questoes.length > PACKAGE_LIMITS.maxQuestions) throw INVALID('questões demais no banco.');
    questoes.forEach((item, index) => {
        if (!isPlainObject(item)) throw INVALID(`a questão ${index + 1} do banco está mal formada.`);
        if (item.ref !== undefined && (typeof item.ref !== 'string' || item.ref.length > 40)) throw INVALID(`a referência da questão ${index + 1} do banco é inválida.`);
    });
    const turmasModelo = Array.isArray(manifest.turmasModelo) ? cleanValue(manifest.turmasModelo) : [];
    if (turmasModelo.length > PACKAGE_LIMITS.maxClasses) throw INVALID('turmas modelo demais.');
    const turmas = [];
    turmasModelo.forEach((cls, index) => {
        if (!isPlainObject(cls)) throw INVALID(`a turma modelo ${index + 1} está mal formada.`);
        const name = requireString(cls.name, `o nome da turma modelo ${index + 1}`, 60).trim().toUpperCase();
        if (!name || turmas.some(item => item.name === name)) return;
        turmas.push({ name, period: typeof cls.period === 'string' ? cls.period.slice(0, 20) : '', attendanceConfig: cls.attendanceConfig });
    });
    return {
        codigo, nome, descricao, structure, disciplinas, gradeTemplates, branding,
        avaliacoes, biblioteca, questoes, turmasModelo: turmas, avisos,
        exportadoEm: Number.isFinite(manifest.exportadoEm) ? manifest.exportadoEm : null,
        versaoApp: typeof manifest.versaoApp === 'string' ? manifest.versaoApp.slice(0, 40) : '',
        versao: manifest.versao,
        foraDoPacote: Array.isArray(manifest.foraDoPacote) ? manifest.foraDoPacote.length : 0,
    };
}

// ------------------------------------------------------------------ plano da importação

// Chaves de conteúdo já usadas nesta instalação (sem diferença de maiúsculas, como a
// leitura do .md): avaliações gravadas, arquivos .md, estruturas dos cursos e das turmas,
// questões do banco, entregas e aplicações de prova.
function usedContentKeys(memory, contentDir) {
    const used = new Set();
    const add = key => { if (typeof key === 'string' && key) used.add(key.toLowerCase()); };
    Object.keys(memory?.evaluations || {}).forEach(add);
    listContentFiles(contentDir).forEach(name => add(name.replace(/\.md$/i, '')));
    const addStructure = structure => (Array.isArray(structure) ? structure : []).forEach(module => unitsOf(module).forEach(unit => { add(unit?.apostilaKey); add(unit?.avaliacaoKey); }));
    (memory?.courses || []).forEach(course => addStructure(course?.structure));
    addStructure(memory?.courseStructure);
    (memory?.classes || []).forEach(cls => {
        const overrides = readOverrides(cls);
        ['materials', 'evaluations'].forEach(kind => Object.entries(overrides[kind]).forEach(([base, entry]) => { add(base); add(entry?.key || entry); }));
        addStructure(overrides.structure);
        overrides.extraUnits.forEach(extra => { add(extra?.unit?.apostilaKey); add(extra?.unit?.avaliacaoKey); });
    });
    (memory?.questionBank || []).forEach(item => add(item?.sourceExamKey));
    (memory?.submissions || []).forEach(item => add(item?.examKey));
    (memory?.examApplications || []).forEach(item => add(item?.examKey));
    return used;
}

function fileSha256(filePath) {
    return sha256(fs.readFileSync(filePath));
}

function withSuffix(fileName, suffix) {
    const ext = path.posix.extname(fileName);
    return `${fileName.slice(0, fileName.length - ext.length)}-${suffix}${ext}`;
}

// Decide o destino de cada chave e de cada arquivo. Nada é gravado.
function planImport(memory, data, files, { newId, contentDir, uploadsDir, imagesDir }) {
    const used = usedContentKeys(memory, contentDir);
    const assigned = new Set();
    const renamedKeys = [];
    const pick = (oldKey) => {
        let candidate = oldKey;
        if (used.has(candidate.toLowerCase()) || assigned.has(candidate.toLowerCase())) {
            candidate = `${oldKey}_${newId}`;
            let index = 2;
            while (used.has(candidate.toLowerCase()) || assigned.has(candidate.toLowerCase())) candidate = `${oldKey}_${newId}_${index++}`;
            renamedKeys.push({ de: oldKey, para: candidate });
        }
        assigned.add(candidate.toLowerCase());
        return candidate;
    };
    const remapped = remapCourseKeys({ course: { structure: data.structure }, classes: [], mapKey: pick });
    const keyFor = key => remapped.materialKeys.get(key) || remapped.evaluationKeys.get(key) || null;

    // Arquivos: o mesmo nome com o mesmo conteúdo é reaproveitado; com conteúdo diferente,
    // ganha um nome novo e as referências mudam.
    const uploads = new Map();
    const images = new Map();
    const writes = [];
    const takenUploads = new Set();
    const takenImages = new Set();
    let reaproveitados = 0;
    files.forEach(file => {
        if (file.tipo === 'conteudo') {
            const key = keyFor(file.chave);
            if (!key) return; // .md de uma chave que a estrutura não usa: fica de fora
            writes.push({ file, dest: path.join(contentDir, `${key}.md`), kind: 'conteudo', key, rewrite: true });
            return;
        }
        if (file.tipo === 'upload') {
            let name = file.name;
            const existing = path.join(uploadsDir, name);
            if (regularFile(existing) && fileSha256(existing) === file.sha256) { uploads.set(file.name, name); reaproveitados += 1; return; }
            let index = 1;
            while (regularFile(path.join(uploadsDir, name)) || fs.existsSync(path.join(uploadsDir, name)) || takenUploads.has(name.toLowerCase())) {
                name = withSuffix(file.name, index === 1 ? newId : `${newId}-${index}`);
                index += 1;
            }
            takenUploads.add(name.toLowerCase());
            if (name !== file.name) uploads.set(file.name, name);
            writes.push({ file, dest: path.join(uploadsDir, name), kind: 'upload', name, renamed: name !== file.name });
            return;
        }
        let rel = file.rel;
        const existing = path.join(imagesDir, ...rel.split('/'));
        if (regularFile(existing) && fileSha256(existing) === file.sha256) { reaproveitados += 1; return; }
        let index = 1;
        while (fs.existsSync(path.join(imagesDir, ...rel.split('/'))) || takenImages.has(rel.toLowerCase())) {
            rel = withSuffix(file.rel, index === 1 ? newId : `${newId}-${index}`);
            index += 1;
        }
        takenImages.add(rel.toLowerCase());
        if (rel !== file.rel) images.set(file.rel, rel);
        writes.push({ file, dest: path.join(imagesDir, ...rel.split('/')), kind: 'imagem', rel, renamed: rel !== file.rel });
    });
    return {
        remapped,
        keyFor,
        renamedKeys,
        maps: { uploads, images },
        writes,
        reaproveitados,
        renamedFiles: writes.filter(item => item.renamed).map(item => ({ de: item.kind === 'upload' ? `uploads/${item.file.name}` : `imagens/${item.file.rel}`, para: item.kind === 'upload' ? `uploads/${item.name}` : `imagens/${item.rel}` })),
    };
}

function countsOf(data, files) {
    return {
        modulos: data.structure.length,
        unidades: data.structure.reduce((sum, module) => sum + unitsOf(module).length, 0),
        apostilas: courseUnitKeys({ structure: data.structure }).materials.length,
        avaliacoes: Object.keys(data.avaliacoes).length,
        questoesNasAvaliacoes: Object.values(data.avaliacoes).reduce((sum, evaluation) => sum + (Array.isArray(evaluation.questions) ? evaluation.questions.length : 0), 0),
        conteudos: files.filter(file => file.tipo === 'conteudo').length,
        arquivos: files.filter(file => file.tipo === 'upload').length,
        imagens: files.filter(file => file.tipo === 'imagem').length,
        biblioteca: data.biblioteca.length,
        questoesBanco: data.questoes.length,
        turmasModelo: data.turmasModelo.length,
    };
}

// Código sugerido: o do pacote, ou com 2, 3... no fim quando ele já existe aqui.
function suggestCourseId(memory, codigo) {
    const base = /^[A-Za-z0-9_-]{1,60}$/.test(codigo) ? codigo.toUpperCase() : 'CURSO_IMPORTADO';
    const exists = id => (memory?.courses || []).some(course => course && String(course.id).toLowerCase() === id.toLowerCase());
    if (!exists(base)) return base;
    let index = 2;
    while (exists(`${base}${index}`)) index += 1;
    return `${base}${index}`;
}

// Prévia: confere o pacote inteiro (cada arquivo com o sha256) sem gravar nada e diz o
// que a importação faria com o código sugerido.
async function previewCoursePackage(input, options = {}) {
    const memory = options.memory || require('../database.js').memory;
    const dirs = contentDirs(options);
    const pkg = await readCoursePackage(input, { verifyFiles: true });
    const data = packageData(pkg.manifest);
    const suggestedId = suggestCourseId(memory, data.codigo);
    const plan = planImport(memory, data, pkg.files, { newId: suggestedId, ...dirs });
    const cursoExiste = (memory?.courses || []).some(course => course && String(course.id).toLowerCase() === String(data.codigo).toLowerCase());
    const avisos = [...data.avisos];
    if (data.foraDoPacote) avisos.push(`${data.foraDoPacote} arquivo(s) citado(s) no curso não estava(m) na instalação de origem e não veio(vieram) no pacote.`);
    return {
        sha256: pkg.sha256,
        versaoFormato: data.versao,
        resumo: { codigo: data.codigo, nome: data.nome, descricao: data.descricao, exportadoEm: data.exportadoEm, versaoApp: data.versaoApp },
        contagens: countsOf(data, pkg.files),
        conflitos: {
            cursoExiste,
            chavesRenomeadas: plan.renamedKeys.length,
            arquivosRenomeados: plan.renamedFiles.length,
            arquivosReaproveitados: plan.reaproveitados,
            exemplos: plan.renamedKeys.slice(0, 10),
        },
        sugestao: { newId: suggestedId, newName: data.nome || suggestedId },
        turmasModelo: data.turmasModelo.map(cls => cls.name),
        avisos,
    };
}

// ------------------------------------------------------------------ importação

function stagingDir(baseDir, importId) {
    return path.join(baseDir, `.pacote-${importId}`);
}

// Pastas temporárias de importações interrompidas (queda no meio) com mais de 1 hora.
function cleanStaleStaging(dirs, now = Date.now()) {
    [dirs.contentDir, dirs.uploadsDir].forEach(base => {
        let names = [];
        try { names = fs.readdirSync(base); } catch (error) { return; }
        names.filter(name => /^\.pacote-[a-f0-9]{16}$/.test(name)).forEach(name => {
            const full = path.join(base, name);
            try {
                if (now - fs.statSync(full).mtimeMs > 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true });
            } catch (error) { /* fica para a próxima */ }
        });
    });
}

function linkNoOverwrite(source, dest) {
    try {
        fs.linkSync(source, dest);
    } catch (error) {
        if (error.code === 'EEXIST') throw refuse('Outro arquivo com o mesmo nome apareceu durante a importação. Tente de novo.', { status: 409, code: 'import_conflict' });
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS', 'EACCES'].includes(error.code)) throw error;
        // Sem link no sistema de arquivos: cópia que recusa destino existente.
        fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
    }
}

function newLibraryId(index) {
    return `lib_${Date.now()}_${index}_${crypto.randomBytes(3).toString('hex')}`;
}

function newBankKey(index) {
    return `qb_${Date.now()}_pac${index}_${crypto.randomBytes(3).toString('hex')}`;
}

// Importa o pacote: { memory, newId, newName, schoolId, incluirTurmasModelo, actorEmail,
// expectedSha256, contentDir, uploadsDir, now }. Confere tudo, grava os arquivos (link
// a partir da pasta temporária, nunca por cima) e acrescenta à memória o curso, as
// turmas modelo, as avaliações, a biblioteca e as questões. Quem chama grava o banco e,
// se a gravação falhar, chama undo() (tira da memória e apaga os arquivos novos).
// Devolve { course, classes, contagens, renomeadas, arquivosRenomeados,
// arquivosReaproveitados, origem, avisos, sha256, undo }.
async function importCoursePackage(input, options = {}) {
    const memory = options.memory || require('../database.js').memory;
    const dirs = contentDirs(options);
    const now = options.now || Date.now();
    const newId = String(options.newId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(newId) || isInheritedKey(newId)) {
        throw refuse('O código do curso aceita só letras sem acento, números, "-" e "_", com até 64 caracteres.', { field: 'newId' });
    }
    const newName = String(options.newName || '').trim();
    if (!newName || newName.length > 120) throw refuse('O nome do curso precisa ter de 1 a 120 caracteres.', { field: 'newName' });
    const courseExists = () => (memory.courses || []).some(course => course && String(course.id).toLowerCase() === newId.toLowerCase());
    if (courseExists()) throw refuse('Já existe um curso com esse código.', { field: 'newId', code: 'course_exists' });

    cleanStaleStaging(dirs, now);
    const importId = crypto.randomBytes(8).toString('hex');
    const contentStage = stagingDir(dirs.contentDir, importId);
    const uploadStage = stagingDir(dirs.uploadsDir, importId);
    const created = [];
    const createdDirs = [];
    const removeCreated = () => {
        created.splice(0).reverse().forEach(file => { try { fs.rmSync(file, { force: true }); } catch (error) { /* segue */ } });
        createdDirs.splice(0).reverse().forEach(dir => { try { fs.rmdirSync(dir); } catch (error) { /* não está vazia */ } });
    };
    try {
        fs.mkdirSync(contentStage, { recursive: true });
        fs.mkdirSync(uploadStage, { recursive: true });
        let counter = 0;
        const pkg = await readCoursePackage(input, {
            stageFile: file => path.join(file.tipo === 'upload' ? uploadStage : contentStage, `${counter++}`),
        });
        if (options.expectedSha256 && String(options.expectedSha256).toLowerCase() !== pkg.sha256) {
            throw refuse('O arquivo não é o mesmo da prévia. Escolha o arquivo de novo e veja a prévia antes de importar.', { status: 409, code: 'import_changed' });
        }
        for (const file of pkg.files) {
            if (file.tipo === 'upload' && await looksLikeBackup(file.staged, file.name)) {
                throw INVALID(`o arquivo ${file.name} parece um backup do IClass, que não pode vir num pacote de curso.`);
            }
        }
        const data = packageData(pkg.manifest);

        // Daqui até o fim tudo é síncrono: o plano vale para a memória que vai ser alterada.
        if (courseExists()) throw refuse('Já existe um curso com esse código.', { field: 'newId', code: 'course_exists' });
        const plan = planImport(memory, data, pkg.files, { newId, ...dirs });

        // Arquivos: o .md com as referências reescritas; o resto como veio.
        for (const write of plan.writes) {
            const dir = path.dirname(write.dest);
            if (!fs.existsSync(dir)) {
                let missing = dir;
                const chain = [];
                while (!fs.existsSync(missing)) { chain.unshift(missing); missing = path.dirname(missing); }
                fs.mkdirSync(dir, { recursive: true });
                createdDirs.push(...chain);
            }
            if (write.kind === 'conteudo') {
                const text = rewriteReferences(fs.readFileSync(write.file.staged, 'utf8'), plan.maps);
                fs.writeFileSync(write.file.staged, text, 'utf8');
            }
            linkNoOverwrite(write.file.staged, write.dest);
            created.push(write.dest);
        }

        const { remapped, keyFor } = plan;
        const maps = plan.maps;
        const course = {
            id: newId,
            name: newName,
            description: data.descricao,
            schoolId: options.schoolId || 'escola_default',
            structure: rewriteValue(remapped.course.structure, maps),
            status: 'active',
            deleted: false,
            deletedAt: null,
            importedFrom: { codigo: data.codigo, nome: data.nome, exportadoEm: data.exportadoEm, versaoApp: data.versaoApp, importadoEm: now },
        };
        if (data.disciplinas) course.disciplinas = data.disciplinas;
        if (data.gradeTemplates) course.gradeTemplates = data.gradeTemplates;
        if (data.branding) course.branding = rewriteValue(data.branding, maps);

        // Questões do banco: chave nova; a da avaliação que veio do banco (bankKey com a
        // referência do pacote) passa a apontar para ela.
        const actor = options.actorEmail || 'Administrador';
        const nowIso = new Date(now).toISOString();
        const refToKey = new Map();
        const existingBankKeys = new Set((memory.questionBank || []).filter(Boolean).map(item => item.key));
        const questions = data.questoes.map((raw, index) => {
            const { ref, ...item } = raw;
            let key = newBankKey(index);
            while (existingBankKeys.has(key)) key = newBankKey(index);
            existingBankKeys.add(key);
            if (ref) refToKey.set(ref, key);
            const sourceExamKey = typeof item.sourceExamKey === 'string' ? keyFor(item.sourceExamKey) : null;
            return rewriteValue({ ...item, key, sourceExamKey: sourceExamKey || null, author: actor, updatedBy: actor, createdAt: nowIso, updatedAt: nowIso }, maps);
        });

        const evaluations = {};
        Object.entries(data.avaliacoes).forEach(([oldKey, evaluation]) => {
            const key = remapped.evaluationKeys.get(oldKey);
            if (!key) return; // avaliação que a estrutura não usa: fica de fora
            const copy = rewriteValue(evaluation, maps);
            copy.key = key;
            if (typeof copy.sourceEvaluationKey === 'string') {
                const mapped = keyFor(copy.sourceEvaluationKey);
                if (mapped) copy.sourceEvaluationKey = mapped; else delete copy.sourceEvaluationKey;
            }
            (copy.questions || []).forEach(question => {
                if (question.bankKey === undefined) return;
                if (refToKey.has(question.bankKey)) question.bankKey = refToKey.get(question.bankKey);
                else delete question.bankKey;
            });
            evaluations[key] = copy;
        });

        const library = data.biblioteca.map((entry, index) => {
            const copy = rewriteValue(entry, maps);
            const out = {
                id: newLibraryId(index),
                kind: copy.kind,
                courseId: newId,
                studentClass: '',
                moduleId: typeof copy.moduleId === 'string' ? copy.moduleId.slice(0, 200) : '',
                name: String(copy.name || copy.originalName || copy.filename || copy.url || 'Material').slice(0, 200),
                description: typeof copy.description === 'string' ? copy.description.slice(0, 500) : '',
                tags: Array.isArray(copy.tags) ? copy.tags.filter(tag => typeof tag === 'string').map(tag => tag.slice(0, 60)).slice(0, 30) : [],
                type: typeof copy.type === 'string' ? copy.type.slice(0, 20) : (copy.kind === 'link' ? 'link' : 'file'),
                size: Number.isSafeInteger(copy.size) && copy.size >= 0 ? copy.size : 0,
                author: actor,
                createdAt: now,
                updatedAt: now,
            };
            if (copy.kind === 'link') {
                out.url = copy.url;
            } else {
                const name = maps.uploads.get(entry.filename) || entry.filename;
                out.filename = name;
                out.url = `/uploads/${name}`;
                out.originalName = typeof copy.originalName === 'string' ? copy.originalName.slice(0, 255) : name;
                out.ext = path.extname(name).toLowerCase();
            }
            if (copy.hidden === true) out.hidden = true;
            return out;
        });

        // Turmas modelo (opcional): nome, período e grade, sem alunos; a liberação começa
        // como numa turma nova (apostilas liberadas, avaliações e gabaritos fechados).
        const classes = [];
        if (options.incluirTurmasModelo) {
            const disciplinaIds = new Set((course.disciplinas || []).map(item => item.id));
            const releasedItems = {};
            course.structure.forEach(module => unitsOf(module).forEach(unit => {
                if (unit.apostilaKey) releasedItems[unit.apostilaKey] = true;
                if (unit.avaliacaoKey) {
                    releasedItems[unit.avaliacaoKey] = false;
                    releasedItems[`Gabarito_${unit.avaliacaoKey}`] = false;
                }
            }));
            data.turmasModelo.forEach(model => {
                classes.push({
                    name: model.name,
                    period: ['Manhã', 'Tarde', 'Noite'].includes(model.period) ? model.period : 'Manhã',
                    courseId: newId,
                    registrationEnabled: true,
                    examConfigs: {},
                    releasedItems: { ...releasedItems },
                    attendanceConfig: attendanceUtil.sanitizeAttendanceConfig(model.attendanceConfig, disciplinaIds) || attendanceUtil.configDefault(),
                    contentOverrides: { materials: {}, evaluations: {}, unitNames: {}, extraUnits: [], structure: null },
                });
            });
        }

        // Memória (uma vez, sem await no meio).
        if (!Array.isArray(memory.courses)) memory.courses = [];
        if (!Array.isArray(memory.classes)) memory.classes = [];
        if (!memory.evaluations || typeof memory.evaluations !== 'object') memory.evaluations = {};
        if (!Array.isArray(memory.library)) memory.library = [];
        if (!Array.isArray(memory.questionBank)) memory.questionBank = [];
        memory.courses.push(course);
        memory.classes.push(...classes);
        Object.assign(memory.evaluations, evaluations);
        memory.library.push(...library);
        memory.questionBank.push(...questions);

        const createdFiles = created.splice(0);
        const createdFolders = createdDirs.splice(0);
        const undo = () => {
            memory.courses = memory.courses.filter(item => item !== course);
            memory.classes = memory.classes.filter(item => !classes.includes(item));
            Object.keys(evaluations).forEach(key => { if (memory.evaluations[key] === evaluations[key]) delete memory.evaluations[key]; });
            memory.library = memory.library.filter(item => !library.includes(item));
            memory.questionBank = memory.questionBank.filter(item => !questions.includes(item));
            created.push(...createdFiles);
            createdDirs.push(...createdFolders);
            removeCreated();
        };
        const contagens = { ...countsOf(data, pkg.files), turmasModelo: classes.length };
        return {
            course,
            classes,
            contagens,
            renomeadas: plan.renamedKeys,
            arquivosRenomeados: plan.renamedFiles,
            arquivosReaproveitados: plan.reaproveitados,
            origem: { codigo: data.codigo, nome: data.nome, versaoFormato: data.versao, versaoApp: data.versaoApp },
            avisos: data.avisos,
            sha256: pkg.sha256,
            undo,
        };
    } catch (error) {
        removeCreated();
        throw error;
    } finally {
        fs.rmSync(contentStage, { recursive: true, force: true });
        fs.rmSync(uploadStage, { recursive: true, force: true });
    }
}

module.exports = {
    COURSE_PACKAGE_EXTENSION,
    COURSE_PACKAGE_FIELDS,
    COURSE_PACKAGE_FORMAT,
    COURSE_PACKAGE_VERSION,
    CoursePackageError,
    PACKAGE_LIMITS,
    coursePackageQuestions,
    exportCoursePackage,
    importCoursePackage,
    previewCoursePackage,
    readCoursePackage,
    referencedContentImages,
    remapCourseKeys,
    rewriteReferences,
};
