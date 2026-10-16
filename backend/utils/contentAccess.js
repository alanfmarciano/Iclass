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

const DETAILS_BLOCK = /<details[^>]*>\s*<summary[^>]*>((?:(?!<\/summary>)[\s\S])*)<\/summary>[\s\S]*?(?:<\/details>|$)/gi;

// Título de bloco que marca o gabarito do professor, nos formatos dos arquivos de
// avaliação: "GABARITO EXCLUSIVO DO PROFESSOR", "GABARITO OFICIAL" ou só "GABARITO".
// Um bloco de autocorreção escrito para o aluno ("Gabarito dos exercícios",
// "Ver resposta") não casa e continua na apostila.
function isTeacherAnswerKeySummary(summaryHtml) {
    const text = String(summaryHtml || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (!text.includes('gabarito')) return false;
    return text === 'gabarito' || text.includes('gabarito oficial') || text.includes('professor');
}

// Remove blocos de gabarito do professor (<details><summary>GABARITO ...</summary>...) que
// por engano tenham ido parar numa apostila. Defesa extra: o material do aluno nunca
// carrega o bloco "GABARITO EXCLUSIVO DO PROFESSOR".
function stripAnswerKeyBlocks(markdown) {
    return String(markdown || '')
        .replace(DETAILS_BLOCK, (block, summary) => (isTeacherAnswerKeySummary(summary) ? '' : block));
}

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

async function readApostila(key) {
    const filePath = await findContentFile(key);
    if (!filePath) return null;
    try {
        return stripAnswerKeyBlocks(await fs.promises.readFile(filePath, 'utf8'));
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
    structureApostilaKeys,
};
