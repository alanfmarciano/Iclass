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

module.exports = {
    EXAM_TOKEN_LENGTH,
    EXAM_TOKEN_PATTERN,
    normalizeExamToken,
    generateExamToken,
    ensureExamToken,
    hashExamToken,
    verifyExamToken,
};
