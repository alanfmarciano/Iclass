// Imagens das apostilas para o aluno (UXA-09, UXA-X2).
// - Imagens que vêm com o produto ficam em content/imagens, em subpastas
//   (imagens/fecop/cap1/x.svg). O aluno com matrícula aprovada pode carregá-las.
// - Imagens inseridas pelo editor vão para /uploads sem item de biblioteca. O aluno
//   só recebe uma delas quando ela aparece numa apostila liberada para uma turma em
//   que está matriculado; assim um upload solto continua fechado e uma imagem de
//   outro curso não vaza.
const fs = require('fs');
const db = require('../database.js');
const { releasedApostilaKeysForClass, findContentFile, stripStoredAccessTokens } = require('./contentAccess.js');

// Cada segmento de /imagens/<a>/<b>/<arquivo>: nada de '..', barra invertida,
// caracteres de controle ou segmento vazio.
function safeImageSegments(segments) {
    const list = Array.isArray(segments) ? segments : String(segments || '').split('/');
    if (!list.length) return null;
    for (const segment of list) {
        const value = String(segment || '');
        if (!value || value === '.' || value === '..' || /[\\/\x00-\x1f:]/.test(value)) return null;
    }
    return list.map(String);
}

// Nomes de arquivos de /uploads citados no texto da apostila (Markdown ou HTML).
const UPLOAD_REFERENCE = /\/?uploads\/([A-Za-z0-9._-]+)/g;
function referencedUploads(markdown) {
    const names = new Set();
    String(markdown || '').replace(UPLOAD_REFERENCE, (match, name) => { names.add(name); return match; });
    return names;
}

// Cache por arquivo (caminho + data de modificação): várias imagens da mesma página
// não releem as apostilas a cada pedido.
const referenceCache = new Map();
async function uploadsReferencedBy(filePath) {
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch (error) { return new Set(); }
    const cached = referenceCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.names;
    let content = '';
    try { content = await fs.promises.readFile(filePath, 'utf8'); } catch (error) { return new Set(); }
    const names = referencedUploads(content);
    referenceCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, names });
    if (referenceCache.size > 500) referenceCache.delete(referenceCache.keys().next().value);
    return names;
}

function studentClasses(student, studentBelongsToClass) {
    return (db.memory.classes || []).filter(cls => studentBelongsToClass(student, cls));
}

// Aluno com ao menos uma matrícula aprovada (autocadastro pendente não vê conteúdo).
function studentHasApprovedClass(student, studentBelongsToClass) {
    return !!student && studentClasses(student, studentBelongsToClass).length > 0;
}

// A imagem enviada pelo editor aparece em alguma apostila liberada para o aluno?
async function uploadReferencedInReleasedContent({ student, studentEmail, filename, studentBelongsToClass, getReleasedItemsForClass }) {
    if (!student || !filename) return false;
    const keys = new Set();
    studentClasses(student, studentBelongsToClass).forEach(cls => {
        releasedApostilaKeysForClass(cls, studentEmail, getReleasedItemsForClass).forEach(key => keys.add(key));
    });
    for (const key of keys) {
        const filePath = await findContentFile(key);
        if (!filePath) continue;
        if ((await uploadsReferencedBy(filePath)).has(filename)) return true;
    }
    return false;
}

module.exports = {
    safeImageSegments,
    referencedUploads,
    uploadReferencedInReleasedContent,
    studentHasApprovedClass,
    // O editor antigo gravava a sessão do instrutor nos links de imagem.
    stripFileAccessTokens: stripStoredAccessTokens,
};
