const crypto = require('crypto');

const EXAM_TOKEN_LENGTH = 5;
const EXAM_TOKEN_PATTERN = /^[A-Z]{5}$/;
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function normalizeExamToken(value) {
    const token = String(value || '').trim().toUpperCase();
    return EXAM_TOKEN_PATTERN.test(token) ? token : null;
}

function generateExamToken() {
    let token = '';
    for (let index = 0; index < EXAM_TOKEN_LENGTH; index += 1) {
        token += TOKEN_ALPHABET[crypto.randomInt(0, TOKEN_ALPHABET.length)];
    }
    return token;
}

function ensureExamToken(value) {
    return normalizeExamToken(value) || generateExamToken();
}

function hashExamToken(value) {
    const token = normalizeExamToken(value);
    return token ? crypto.createHash('sha256').update(token).digest('hex') : null;
}

function verifyExamToken(value, expectedHash) {
    const actual = hashExamToken(value);
    const expected = String(expectedHash || '').trim().toLowerCase();
    if (!actual || !/^[0-9a-f]{64}$/.test(expected)) return false;
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

// Token reexibível (fase 3, P3-S8: AVA-14; D19 do desenho do P3). Ao preparar a prova ou
// trocar o token, o servidor guarda, além do hash (que é o que confere o token do aluno),
// o token selado: AES-256-GCM com a chave derivada de config.examAnswerSecret por HKDF
// (rótulo 'exam-token') e o id da aplicação como dado autenticado (o selo de uma
// aplicação não abre noutra). O texto puro nunca vai para o banco; só o professor com o
// Monitor da turma lê o token de novo (GET /api/admin/exam-applications/:id/access-token).
// Sem segredo válido (menos de 32 caracteres) não há selo; selo de outro computador (o
// segredo de lá é outro: config fica como está ao restaurar) ou estragado não abre: null.
const SEAL_VERSION = 1;
const SEAL_INFO = 'exam-token';

function sealKey(secret) {
    if (typeof secret !== 'string' || secret.length < 32) return null;
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(SEAL_INFO, 'utf8'), 32));
}

function sealExamToken(value, { applicationId, secret } = {}) {
    const token = normalizeExamToken(value);
    const key = sealKey(secret);
    if (!token || !key || !applicationId) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(String(applicationId), 'utf8'));
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return {
        v: SEAL_VERSION,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
    };
}

function unsealExamToken(sealed, { applicationId, secret } = {}) {
    const key = sealKey(secret);
    if (!key || !applicationId || !sealed || typeof sealed !== 'object') return null;
    if (sealed.v !== undefined && sealed.v !== SEAL_VERSION) return null;
    try {
        const iv = Buffer.from(String(sealed.iv || ''), 'base64');
        const tag = Buffer.from(String(sealed.tag || ''), 'base64');
        const data = Buffer.from(String(sealed.data || ''), 'base64');
        if (iv.length !== 12 || tag.length !== 16 || !data.length) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(String(applicationId), 'utf8'));
        decipher.setAuthTag(tag);
        const token = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
        return normalizeExamToken(token);
    } catch (_) {
        return null;
    }
}

module.exports = {
    EXAM_TOKEN_LENGTH,
    EXAM_TOKEN_PATTERN,
    normalizeExamToken,
    generateExamToken,
    ensureExamToken,
    hashExamToken,
    verifyExamToken,
    sealExamToken,
    unsealExamToken,
};
