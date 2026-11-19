// ---------------------------------------------------------------------------
// Arquivos das entregas de tarefa (fase 3, P1-a; decisões D2, D3, D5, D6 e D17 do P1).
//
// - Pasta: data/entregas/<assignmentId>/<submissionId>/<fileId><ext>
//   (runtimePaths.ASSIGNMENT_FILES_DIR), fora de todo ZIP de backup e nunca tocada pela
//   restauração. O nome original fica só no registro (assignmentSubmissions); arquivo
//   gravado nunca muda (cada reenvio é uma versão nova).
// - Recebimento: o multer do envio (P1-c) grava em data/entregas/.recebendo (mesmo disco);
//   cada arquivo passa por validateReceivedFile (tipo da tarefa, executável barrado,
//   assinatura, tamanho, sha256 lido em streaming) e a versão só existe depois de todos
//   validados: commitReceivedFiles move todos com renameWithRetry (antivírus e OneDrive
//   no Windows) e, se um falhar, desfaz os que já foram. Arquivo recusado é apagado (não
//   vai para a lixeira: ainda não é de ninguém).
// - Catálogo de tipos próprio das entregas (ASSIGNMENT_FILE_TYPES), escolhido por tarefa,
//   mais os "formatos do curso" digitados pelo professor (.pkt, .fzz, .dwg...), aceitos só
//   pela extensão. Curso técnico entrega código e HTML, que a Biblioteca recusa porque
//   serve inline; aqui todo arquivo sai como download (downloadHeaders: attachment,
//   Content-Type da lista branca ou application/octet-stream, nosniff e CSP sandbox), e
//   só imagem raster e PDF podem abrir inline na prévia do painel. Executável é sempre
//   recusado, inclusive como formato do curso.
// - Espaço em disco: checkFreeSpace recusa o envio quando o livre fica abaixo de
//   settings.entregas.discoLivreMinimoMb (a rota responde 507).
// - Boot: cleanupReceivingDir apaga de .recebendo o que tiver mais de 1 h (envio que caiu
//   no meio, servidor desligado durante o upload).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtimePaths.js');
const { assertInside, resolveInside } = require('./safePath.js');
const { headSignatureMatches } = require('./uploadSecurity.js');
const { renameWithRetry } = require('./backupArchive.js');

const MB = 1024 * 1024;
// Quanto do começo do arquivo a validação olha (assinatura e texto).
const HEAD_BYTES = 8192;
const ORIGINAL_NAME_MAX = 120;
const EXTRA_EXTENSIONS_MAX = 10;
const EXTENSION_PATTERN = /^\.[a-z0-9]{1,8}$/;
const RECEIVING_MAX_AGE_MS = 60 * 60 * 1000;
const FILE_ID_PATTERN = /^f_[0-9a-f]{16}$/;

// Catálogo das entregas (D6). A ordem é a da tela.
const ASSIGNMENT_FILE_TYPES = Object.freeze({
    pdf: Object.freeze({ label: 'PDF', extensions: Object.freeze(['.pdf']) }),
    image: Object.freeze({ label: 'Imagem (foto)', extensions: Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']) }),
    doc: Object.freeze({ label: 'Documento de texto', extensions: Object.freeze(['.doc', '.docx', '.odt', '.rtf']) }),
    sheet: Object.freeze({ label: 'Planilha', extensions: Object.freeze(['.xls', '.xlsx', '.ods', '.csv']) }),
    slides: Object.freeze({ label: 'Apresentação', extensions: Object.freeze(['.ppt', '.pptx', '.odp']) }),
    archive: Object.freeze({ label: 'Compactado', extensions: Object.freeze(['.zip', '.7z', '.rar']) }),
    code: Object.freeze({
        label: 'Código e texto',
        extensions: Object.freeze(['.txt', '.md', '.json', '.xml', '.csv', '.html', '.css', '.js', '.ts', '.py', '.c', '.cpp', '.h', '.java', '.cs', '.php', '.sql', '.ino', '.sh']),
    }),
});
const FILE_TYPE_KEYS = Object.freeze(Object.keys(ASSIGNMENT_FILE_TYPES));
// Categoria dos formatos digitados pelo professor (só pela extensão).
const COURSE_FORMAT_CATEGORY = 'curso';

// Executáveis e atalhos: nunca, nem como formato do curso (a máquina é a do professor).
const BLOCKED_EXECUTABLES = Object.freeze([
    '.exe', '.com', '.bat', '.cmd', '.ps1', '.msi', '.scr', '.jar', '.vbs', '.vbe', '.lnk', '.dll',
    '.reg', '.hta', '.wsf', '.cpl', '.msc', '.appx', '.msix', '.apk', '.iso',
]);
const BLOCKED_SET = new Set(BLOCKED_EXECUTABLES);

// Content-Type de download (lista branca). Texto e código saem como text/plain (HTML
// entregue nunca sai como text/html); o que não está aqui sai como application/octet-stream.
const TEXT_PLAIN = 'text/plain; charset=utf-8';
const DOWNLOAD_MIME = Object.freeze({
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.rtf': 'application/rtf',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.odp': 'application/vnd.oasis.opendocument.presentation',
    '.zip': 'application/zip',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/vnd.rar',
    ...Object.fromEntries(ASSIGNMENT_FILE_TYPES.code.extensions.map(ext => [ext, TEXT_PLAIN])),
});
// Prévia no painel (D7): só imagem raster e PDF podem sair inline. HEIC não (o navegador
// do Windows não abre).
const INLINE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf']);

const TEXT_EXTENSIONS = new Set([...ASSIGNMENT_FILE_TYPES.code.extensions, '.csv']);

function list(value) {
    return Array.isArray(value) ? value : [];
}

// ------------------------------------------------------------ catálogo e regras da tarefa
// Tipos escolhidos na tarefa: só chaves do catálogo, sem repetição, na ordem do catálogo.
function normalizeFileTypes(value) {
    const wanted = new Set(list(value).map(item => String(item || '').trim().toLowerCase()));
    return FILE_TYPE_KEYS.filter(key => wanted.has(key));
}

// Extensão digitada pelo professor ('.pkt', 'PKT', ' .Fzz ') no formato gravado ('.pkt'),
// ou null quando não serve (formato inválido ou executável).
function normalizeExtension(value) {
    let text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (!text) return null;
    if (!text.startsWith('.')) text = `.${text}`;
    if (!EXTENSION_PATTERN.test(text) || BLOCKED_SET.has(text)) return null;
    return text;
}

// "Formatos do curso": até 10, sem repetição e sem executável. Com { strict: true } devolve
// { error } para a primeira inválida (a rota responde 400 com a mensagem).
function normalizeExtraExtensions(value, { strict = false } = {}) {
    const out = [];
    for (const item of list(value)) {
        const ext = normalizeExtension(item);
        if (!ext) {
            if (strict) {
                const shown = String(item === undefined || item === null ? '' : item).trim().slice(0, 20);
                const raw = shown.startsWith('.') ? shown.toLowerCase() : `.${shown.toLowerCase()}`;
                return {
                    error: BLOCKED_SET.has(raw)
                        ? `O formato ${raw} não pode ser aceito: arquivos executáveis são sempre recusados.`
                        : `Formato do curso inválido: "${shown}". Use o ponto e até 8 letras ou números (ex.: .pkt).`,
                };
            }
            continue;
        }
        if (!out.includes(ext)) out.push(ext);
    }
    if (out.length > EXTRA_EXTENSIONS_MAX) {
        if (strict) return { error: `Informe no máximo ${EXTRA_EXTENSIONS_MAX} formatos do curso.` };
        return out.slice(0, EXTRA_EXTENSIONS_MAX);
    }
    return strict ? { value: out } : out;
}

function catalogCategoryOf(ext) {
    // .csv está em planilha e em código: a primeira do catálogo (planilha) dá o nome.
    return FILE_TYPE_KEYS.find(key => ASSIGNMENT_FILE_TYPES[key].extensions.includes(ext)) || null;
}

// Extensões aceitas pela tarefa (tipos escolhidos + formatos do curso), sem repetição.
function acceptedExtensions({ types = [], extraExtensions = [] } = {}) {
    const out = [];
    normalizeFileTypes(types).forEach(key => ASSIGNMENT_FILE_TYPES[key].extensions.forEach(ext => { if (!out.includes(ext)) out.push(ext); }));
    normalizeExtraExtensions(extraExtensions).forEach(ext => { if (!out.includes(ext)) out.push(ext); });
    return out;
}

// Atributo accept do <input type=file> do aluno (D12): as extensões aceitas e, quando a
// tarefa aceita imagem, image/* (abre a câmera e a galeria no celular).
function acceptAttribute(rules = {}) {
    const extensions = acceptedExtensions(rules);
    const parts = [];
    if (normalizeFileTypes(rules.types).includes('image')) parts.push('image/*');
    if (normalizeFileTypes(rules.types).includes('pdf')) parts.push('application/pdf');
    return [...parts, ...extensions].join(',');
}

// Nome original como guardado no registro: sem caminho, sem caractere de controle nem os
// proibidos no Windows, até 120 caracteres mantendo a extensão.
function sanitizeOriginalName(value) {
    const base = String(value === undefined || value === null ? '' : value).split(/[\\/]/).pop();
    const clean = base
        .normalize('NFC')
        .replace(/[<>:"|?*\x00-\x1f\x7f]+/g, '')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/, '')
        .trim();
    if (clean.length <= ORIGINAL_NAME_MAX) return clean;
    const ext = path.extname(clean);
    const keep = ext.length < 12 ? ext : '';
    return clean.slice(0, ORIGINAL_NAME_MAX - keep.length).trimEnd() + keep;
}

function extensionOf(name) {
    return path.extname(String(name || '')).toLowerCase();
}

// Este nome de arquivo pode entrar na tarefa? { ok, ext, category } ou
// { ok: false, code, message } (mensagem em português, com o nome).
function classifyFileName(originalName, rules = {}) {
    const raw = String(originalName === undefined || originalName === null ? '' : originalName);
    const name = sanitizeOriginalName(raw);
    if (!name || raw.includes('\0')) return { ok: false, code: 'file_name', message: 'Arquivo sem nome. Renomeie o arquivo e envie de novo.' };
    const ext = extensionOf(name);
    if (!ext) return { ok: false, code: 'file_type', message: `O arquivo "${name}" não tem extensão (como .pdf ou .jpg). Renomeie e envie de novo.` };
    if (BLOCKED_SET.has(ext)) return { ok: false, code: 'file_blocked', message: `O arquivo "${name}" não pode ser enviado: arquivos executáveis (${ext}) são sempre recusados.` };
    const types = normalizeFileTypes(rules.types);
    const extras = normalizeExtraExtensions(rules.extraExtensions);
    const fromTypes = types.find(key => ASSIGNMENT_FILE_TYPES[key].extensions.includes(ext));
    if (fromTypes) return { ok: true, ext, category: fromTypes, name };
    if (extras.includes(ext)) {
        // Extensão que está no catálogo (o professor digitou .py sem marcar "Código"): vale a
        // categoria do catálogo, com a conferência dela.
        return { ok: true, ext, category: catalogCategoryOf(ext) || COURSE_FORMAT_CATEGORY, name };
    }
    const accepted = acceptedExtensions({ types, extraExtensions: extras });
    return {
        ok: false,
        code: 'file_type',
        message: `O arquivo "${name}" (${ext}) não é aceito nesta tarefa. Formatos aceitos: ${accepted.join(', ') || 'nenhum'}.`,
    };
}

// ------------------------------------------------------------ assinatura e conteúdo
function hasPrefix(buffer, bytes, offset = 0) {
    return buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

// Texto e código: sem byte nulo no começo e em UTF-8. Arquivo antigo do Windows em
// Latin-1/Windows-1252 (acentos de um .c ou .txt do Bloco de Notas antigo) também passa,
// desde que não tenha caractere de controle além de tabulação, quebra de linha e avanço
// de página: a conferência existe para recusar binário disfarçado, não texto com acento.
function looksLikeText(head) {
    if (!head.length) return true;
    if (head.includes(0)) return false;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
        return true;
    } catch (e) {
        for (const byte of head) {
            if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) return false;
            if (byte === 0x7f) return false;
        }
        return true;
    }
}

// O começo do arquivo confere com a extensão? Formato do curso (fora do catálogo) só pela
// extensão; o resto pela assinatura (a da Biblioteca, mais HEIC, 7z, RAR, RTF e as do
// OpenDocument) ou, em texto e código, por looksLikeText.
function contentMatchesExtension(head, ext, category) {
    const buffer = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
    if (category === COURSE_FORMAT_CATEGORY) return true;
    if (TEXT_EXTENSIONS.has(ext)) return looksLikeText(buffer);
    if (ext === '.heic' || ext === '.heif') {
        return buffer.subarray(4, 8).toString('latin1') === 'ftyp' && HEIF_BRANDS.has(buffer.subarray(8, 12).toString('latin1'));
    }
    if (ext === '.7z') return hasPrefix(buffer, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    if (ext === '.rar') return hasPrefix(buffer, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]);
    if (ext === '.rtf') return buffer.subarray(0, 5).toString('latin1') === '{\\rtf';
    if (ext === '.odp') return hasPrefix(buffer, [0x50, 0x4b]);
    return headSignatureMatches(buffer, ext);
}

// Lê o arquivo recebido uma vez, em streaming: tamanho, sha256 e os primeiros bytes.
function inspectFile(absPath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const chunks = [];
        let headLength = 0;
        let size = 0;
        const stream = fs.createReadStream(absPath);
        stream.on('data', chunk => {
            size += chunk.length;
            hash.update(chunk);
            if (headLength < HEAD_BYTES) {
                const piece = chunk.subarray(0, HEAD_BYTES - headLength);
                chunks.push(piece);
                headLength += piece.length;
            }
        });
        stream.on('error', reject);
        stream.on('end', () => resolve({ size, sha256: hash.digest('hex'), head: Buffer.concat(chunks, headLength) }));
    });
}

function formatMb(bytes) {
    const mb = bytes / MB;
    return `${(mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10).toString().replace('.', ',')} MB`;
}

// Confere um arquivo que o multer gravou em .recebendo (file.path, file.originalname,
// file.size) contra as regras da tarefa { types, extraExtensions, maxSizeMb }. Devolve
// { ok: true, file: { id, originalName, ext, category, mime, size, sha256 } } ou
// { ok: false, code, message }. Não move nem apaga nada (quem chama descarta o envio
// inteiro quando um arquivo falha).
async function validateReceivedFile(file, rules = {}) {
    if (!file || typeof file !== 'object' || !file.path) return { ok: false, code: 'file_missing', message: 'Arquivo não recebido. Envie de novo.' };
    const named = classifyFileName(file.originalname, rules);
    if (!named.ok) return named;
    let info;
    try {
        info = await inspectFile(assertInside(runtimePaths.ASSIGNMENT_RECEIVING_DIR, file.path));
    } catch (e) {
        return { ok: false, code: 'file_read', message: `Não foi possível ler o arquivo "${named.name}". Envie de novo.`, retryable: true };
    }
    if (!info.size) return { ok: false, code: 'file_empty', message: `O arquivo "${named.name}" está vazio.` };
    const maxSizeMb = Number(rules.maxSizeMb);
    if (Number.isFinite(maxSizeMb) && maxSizeMb > 0 && info.size > maxSizeMb * MB) {
        return { ok: false, code: 'file_too_large', status: 413, message: `O arquivo "${named.name}" tem ${formatMb(info.size)}; o limite desta tarefa é ${maxSizeMb} MB por arquivo.` };
    }
    if (!contentMatchesExtension(info.head, named.ext, named.category)) {
        return {
            ok: false,
            code: 'file_signature',
            message: TEXT_EXTENSIONS.has(named.ext)
                ? `O arquivo "${named.name}" não parece ser texto. Confira se o arquivo é mesmo ${named.ext}.`
                : `O conteúdo do arquivo "${named.name}" não confere com o formato ${named.ext}. Confira se o arquivo não está corrompido ou com a extensão trocada.`,
        };
    }
    return {
        ok: true,
        file: {
            id: newFileId(),
            originalName: named.name,
            ext: named.ext,
            category: named.category,
            mime: DOWNLOAD_MIME[named.ext] || 'application/octet-stream',
            size: info.size,
            sha256: info.sha256,
        },
    };
}

// ------------------------------------------------------------ pastas e caminhos
function newFileId() {
    return `f_${crypto.randomBytes(8).toString('hex')}`;
}

function isFileId(value) {
    return typeof value === 'string' && FILE_ID_PATTERN.test(value);
}

// Pedaço de caminho que vem de um id gravado: só letras, números, _ e -.
function safeSegment(value, label) {
    const text = String(value === undefined || value === null ? '' : value);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(text)) {
        const error = new Error(`Identificador inválido (${label}).`);
        error.code = 'INVALID_ID';
        throw error;
    }
    return text;
}

// 'entregas/<asg>/<asub>/<fileId><ext>' (relativo a DATA_DIR, com '/', como no registro).
function storedRelFor(assignmentId, submissionId, fileId, ext) {
    const extension = String(ext || '').toLowerCase();
    if (extension && !EXTENSION_PATTERN.test(extension)) {
        const error = new Error('Extensão inválida.');
        error.code = 'INVALID_ID';
        throw error;
    }
    return ['entregas', safeSegment(assignmentId, 'tarefa'), safeSegment(submissionId, 'entrega'), `${safeSegment(fileId, 'arquivo')}${extension}`].join('/');
}

// Caminho absoluto de um storedRel do registro, sempre dentro de data/entregas e nunca em
// .recebendo. Lança para caminho estranho (registro editado à mão, backup adulterado).
function absFromStoredRel(storedRel) {
    const rel = String(storedRel || '').split('\\').join('/');
    if (!/^entregas\//.test(rel)) {
        const error = new Error('Caminho de arquivo de entrega inválido.');
        error.code = 'INVALID_PATH';
        throw error;
    }
    const abs = resolveInside(runtimePaths.DATA_DIR, rel.split('/').join(path.sep));
    assertInside(runtimePaths.ASSIGNMENT_FILES_DIR, abs);
    const receiving = path.resolve(runtimePaths.ASSIGNMENT_RECEIVING_DIR);
    if (abs === receiving || abs.startsWith(receiving + path.sep)) {
        const error = new Error('Caminho de arquivo de entrega inválido.');
        error.code = 'INVALID_PATH';
        throw error;
    }
    return abs;
}

function ensureReceivingDir() {
    fs.mkdirSync(runtimePaths.ASSIGNMENT_RECEIVING_DIR, { recursive: true });
    return runtimePaths.ASSIGNMENT_RECEIVING_DIR;
}

// Nome do temporário em .recebendo (o multer usa este, nunca o nome do aluno).
function receivingFileName() {
    return `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.part`;
}

async function removeQuietly(absPath) {
    try { await fs.promises.rm(absPath, { force: true }); } catch (e) { /* já saiu ou está preso: a limpeza do boot pega */ }
}

// Apaga os temporários de um envio recusado (só o que está em .recebendo).
async function discardReceivedFiles(files) {
    const receiving = path.resolve(runtimePaths.ASSIGNMENT_RECEIVING_DIR);
    for (const file of list(files)) {
        const target = file && typeof file === 'object' ? file.path : file;
        if (!target) continue;
        const abs = path.resolve(String(target));
        if (abs.startsWith(receiving + path.sep)) await removeQuietly(abs);
    }
}

// Move os arquivos validados de .recebendo para o lugar final, todos ou nenhum.
// items: [{ tempPath, file: { id, ext } }]. Devolve [{ ...file, storedRel }] na mesma ordem.
// Falha no meio: os que já foram movidos são apagados (sem registro, não são de ninguém),
// os temporários também, e o erro sobe com retryable (a rota responde 503).
async function commitReceivedFiles(items, { assignmentId, submissionId, rename = renameWithRetry } = {}) {
    const moved = [];
    const out = [];
    try {
        for (const item of list(items)) {
            const storedRel = storedRelFor(assignmentId, submissionId, item.file.id, item.file.ext);
            const target = absFromStoredRel(storedRel);
            const source = assertInside(runtimePaths.ASSIGNMENT_RECEIVING_DIR, path.resolve(String(item.tempPath || '')));
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            if (fs.existsSync(target)) {
                const error = new Error('Já existe um arquivo com este identificador.');
                error.code = 'EEXIST';
                throw error;
            }
            await rename(source, target);
            moved.push(target);
            out.push({ ...item.file, storedRel });
        }
        return out;
    } catch (err) {
        for (const target of moved) await removeQuietly(target);
        await discardReceivedFiles(list(items).map(item => item && item.tempPath));
        const error = new Error('Não foi possível gravar os arquivos do envio. Tente de novo.');
        error.code = 'ASSIGNMENT_FILE_COMMIT';
        error.retryable = true;
        error.status = 503;
        error.cause = err;
        throw error;
    }
}

// Espaço livre na pasta das entregas (ou na de dados, se ela ainda não existe) contra o
// mínimo de settings.entregas e o tamanho do que está chegando. { ok, freeBytes,
// minFreeBytes }; sem como medir (statfs falhou), ok: o envio não é recusado por palpite.
async function checkFreeSpace({ minFreeMb = 0, incomingBytes = 0, statfs = fs.promises.statfs } = {}) {
    const dir = fs.existsSync(runtimePaths.ASSIGNMENT_FILES_DIR) ? runtimePaths.ASSIGNMENT_FILES_DIR : runtimePaths.DATA_DIR;
    let freeBytes = null;
    try {
        const stat = await statfs(dir);
        freeBytes = Number(stat.bavail) * Number(stat.bsize);
        if (!Number.isFinite(freeBytes)) freeBytes = null;
    } catch (e) {
        freeBytes = null;
    }
    const minFreeBytes = Math.max(0, Number(minFreeMb) || 0) * MB;
    if (freeBytes === null) return { ok: true, freeBytes: null, minFreeBytes };
    return { ok: freeBytes - Math.max(0, Number(incomingBytes) || 0) >= minFreeBytes, freeBytes, minFreeBytes };
}

const DISK_FULL_MESSAGE = 'O computador do professor está sem espaço para receber trabalhos; avise o professor.';

// Boot (prepareServer): apaga de .recebendo o que tiver mais de 1 h. Devolve quantos.
async function cleanupReceivingDir({ now = Date.now(), maxAgeMs = RECEIVING_MAX_AGE_MS } = {}) {
    const dir = runtimePaths.ASSIGNMENT_RECEIVING_DIR;
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
        if (e && e.code === 'ENOENT') return 0;
        throw e;
    }
    let removed = 0;
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        try {
            const stat = await fs.promises.lstat(abs);
            if (now - stat.mtimeMs <= maxAgeMs) continue;
            await fs.promises.rm(abs, { recursive: true, force: true });
            removed += 1;
        } catch (e) { /* preso (antivírus): fica para o próximo boot */ }
    }
    return removed;
}

// ------------------------------------------------------------ download
function asciiFallback(name) {
    const plain = String(name || 'arquivo').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return plain.trim() || 'arquivo';
}

// Cabeçalhos do download de um arquivo de entrega (D6 e D7): attachment com o nome
// original (acentos em filename*), Content-Type da lista branca ou octet-stream, nosniff
// e CSP sandbox. inline só para imagem raster e PDF (prévia do painel).
function downloadHeaders(file, { inline = false } = {}) {
    const ext = String((file && file.ext) || extensionOf(file && file.originalName)).toLowerCase();
    const name = sanitizeOriginalName((file && file.originalName) || `arquivo${ext}`) || `arquivo${ext}`;
    const canInline = inline && INLINE_EXTENSIONS.includes(ext);
    const type = DOWNLOAD_MIME[ext] || 'application/octet-stream';
    return {
        'Content-Type': type,
        'Content-Disposition': `${canInline ? 'inline' : 'attachment'}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
        'Cache-Control': 'private, no-store',
    };
}

module.exports = {
    ASSIGNMENT_FILE_TYPES,
    FILE_TYPE_KEYS,
    COURSE_FORMAT_CATEGORY,
    BLOCKED_EXECUTABLES,
    DOWNLOAD_MIME,
    INLINE_EXTENSIONS,
    EXTRA_EXTENSIONS_MAX,
    RECEIVING_MAX_AGE_MS,
    DISK_FULL_MESSAGE,
    MB,
    normalizeFileTypes,
    normalizeExtension,
    normalizeExtraExtensions,
    acceptedExtensions,
    acceptAttribute,
    sanitizeOriginalName,
    classifyFileName,
    contentMatchesExtension,
    looksLikeText,
    inspectFile,
    validateReceivedFile,
    newFileId,
    isFileId,
    storedRelFor,
    absFromStoredRel,
    ensureReceivingDir,
    receivingFileName,
    discardReceivedFiles,
    commitReceivedFiles,
    checkFreeSpace,
    cleanupReceivingDir,
    downloadHeaders,
};
