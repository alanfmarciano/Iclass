// Acesso a apostilas (arquivos Markdown da pasta de conteúdo).
// Regra: o caminho pedido nunca vira nome de arquivo direto. A chave é comparada,
// sem diferenciar maiúsculas/minúsculas (o NTFS do Windows e o APFS do macOS não
// diferenciam), com uma lista do que PODE ser servido, e o arquivo é aberto pelo nome
// canônico dessa lista. Avaliações (Avaliacao_*, inclusive as cópias *_JOYA e
// *_COPIA) e gabaritos nunca entram nessa lista.
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const runtimePaths = require('../runtimePaths.js');
const { effectiveStructure } = require('./classContent.js');

const SAFE_CONTENT_KEY = /^[a-zA-Z0-9_-]+$/;

function isCourseDeleted(course) {
    return !!course && (course.deleted === true || course.status === 'deleted' || course.status === 'inactive' || !!course.deletedAt);
}

// Chaves que nunca podem ser servidas como material, em qualquer grafia.
function isRestrictedContentKey(key) {
    const normalized = String(key || '').trim().toLowerCase();
    return normalized.startsWith('avaliacao_') || normalized.startsWith('gabarito_');
}

// Gabarito do professor que por engano foi parar numa apostila: sai do texto servido ao
// aluno pelas regras fixas de answerKey.js (B-gabarito). Defesa extra: o material do aluno
// nunca carrega o gabarito do professor.
const { stripAnswerKeyBlocks } = require('./answerKey.js');

function classStructure(cls) {
    return effectiveStructure(cls?.courseId, cls?.name)?.structure || db.memory.courseStructure || [];
}

function structureApostilaKeys(structure) {
    const keys = [];
    (Array.isArray(structure) ? structure : []).forEach(mod => {
        (mod?.units || mod?.items || []).forEach(unit => {
            const key = String(unit?.apostilaKey || '').trim();
            if (key && SAFE_CONTENT_KEY.test(key) && !isRestrictedContentKey(key)) keys.push(key);
        });
    });
    return keys;
}

// Apostilas liberadas para o aluno numa turma (estrutura efetiva + liberação da turma).
// getReleasedItems é injetado para evitar dependência circular com middlewares.js.
function releasedApostilaKeysForClass(cls, studentEmail, getReleasedItems) {
    if (!cls) return [];
    const course = (db.memory.courses || []).find(item => String(item.id) === String(cls.courseId));
    if (cls.courseId && (!course || isCourseDeleted(course))) return [];
    const released = getReleasedItems(cls, studentEmail) || {};
    return structureApostilaKeys(classStructure(cls)).filter(key => released[key] === true);
}

// Nome canônico do arquivo .md na pasta de conteúdo (comparação sem diferenciar
// maiúsculas). Devolve null se o arquivo não existir.
async function findContentFile(key) {
    if (!SAFE_CONTENT_KEY.test(String(key || ''))) return null;
    let files;
    try {
        files = await fs.promises.readdir(runtimePaths.CONTENT_DIR);
    } catch (error) {
        return null;
    }
    const wanted = `${key}.md`;
    const exact = files.find(file => file === wanted);
    const match = exact || files.find(file => file.toLowerCase() === wanted.toLowerCase());
    return match ? path.join(runtimePaths.CONTENT_DIR, match) : null;
}

// Host do próprio servidor: o app roda na máquina do professor e é aberto pela rede
// da sala (localhost, IP da rede local, nome da máquina sem domínio ou .local), além
// dos hosts informados (o Host da requisição). Site externo (drive.example.com) não é.
const LOCAL_NETWORK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|::1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[a-z0-9-]+|[a-z0-9.-]+\.local)$/i;

function hostWithoutPort(value) {
    const host = String(value || '').trim().toLowerCase();
    if (host.startsWith('[')) return host.slice(1, host.indexOf(']') > 0 ? host.indexOf(']') : undefined);
    return host.replace(/:\d+$/, '');
}

function isOwnHost(host, ownHosts) {
    const bare = hostWithoutPort(host);
    if (!bare) return false;
    return LOCAL_NETWORK_HOST.test(bare) || (ownHosts || []).some(item => hostWithoutPort(item) === bare);
}

// Remove ?access=<sessão> de links /uploads e /imagens do PRÓPRIO site (o editor
// antigo gravava a sessão do instrutor na apostila): caminho que começa em /uploads/
// ou /imagens/, caminho relativo (uploads/, ./uploads/, ../uploads/) ou com a origem
// do próprio servidor (rede da sala, nome da máquina ou o Host da requisição). Link
// externo que por acaso tem /uploads/ no caminho
// (https://drive.example.com/uploads/doc.pdf?access=X) fica intacto, a não ser que o
// access= seja uma sessão de instrutor ainda válida: essa nunca sai para o aluno,
// qualquer que seja o endereço gravado. contentMedia.js reexporta para o editor.
const STORED_FILE_LINK = /(^|[\s("'<>=\[,])(?:((?:https?:)?\/\/([^\s/)"'<>?#]+))(\/(?:uploads|imagens)\/[^\s)"'<>?#]+)|((?:\.{1,2}\/)*\/?(?:uploads|imagens)\/[^\s)"'<>?#]+))\?([^\s)"'<>#]*)/gi;

function liveInstructorSessionTokens() {
    return new Set(Object.keys((db.memory && db.memory.adminSessions) || {}).filter(Boolean));
}

function decodedParamValue(part) {
    const value = part.slice(part.indexOf('=') + 1);
    try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch (error) { return value; }
}

// "/uploads/..." dentro da query de outro endereço
// (https://drive.example.com/view?u=/uploads/doc.pdf?access=X) é parte do link externo.
function insideOtherUrl(text, offset) {
    let start = offset;
    while (start > 0 && !/[\s"'<>()[\]]/.test(text[start - 1])) start -= 1;
    return /\?|&|:\/\//.test(text.slice(start, offset));
}

function stripStoredAccessTokens(markdown, { ownHosts = [], sessionTokens = liveInstructorSessionTokens() } = {}) {
    return String(markdown || '').replace(STORED_FILE_LINK, (match, lead, origin, host, absolutePath, relativePath, query, offset, whole) => {
        const filePath = absolutePath || relativePath;
        const parts = query.split(/&(?:amp;)?/);
        const isAccess = part => /^access=/i.test(part);
        const external = origin ? !isOwnHost(host, ownHosts) : insideOtherUrl(whole, offset + lead.length);
        const drop = external
            ? part => isAccess(part) && sessionTokens.has(decodedParamValue(part))
            : isAccess;
        if (!parts.some(part => part && drop(part))) return match;
        const kept = parts.filter(part => part && !drop(part));
        return `${lead}${origin || ''}${filePath}${kept.length ? `?${kept.join('&')}` : ''}`;
    });
}

// ownHosts: o Host da requisição do aluno, para links gravados com o nome do próprio
// servidor (https://iclass.escola.com.br/uploads/x.png?access=...).
async function readApostila(key, { ownHosts = [] } = {}) {
    const filePath = await findContentFile(key);
    if (!filePath) return null;
    try {
        // O BOM do início do arquivo sai antes da remoção do gabarito (stripAnswerKeyBlocks).
        const raw = (await fs.promises.readFile(filePath, 'utf8')).replace(/^\uFEFF+/, '');
        return stripStoredAccessTokens(stripAnswerKeyBlocks(raw), { ownHosts });
    } catch (error) {
        return null;
    }
}

module.exports = {
    SAFE_CONTENT_KEY,
    classStructure,
    findContentFile,
    isCourseDeleted,
    isRestrictedContentKey,
    readApostila,
    releasedApostilaKeysForClass,
    stripAnswerKeyBlocks,
    stripStoredAccessTokens,
    structureApostilaKeys,
};
