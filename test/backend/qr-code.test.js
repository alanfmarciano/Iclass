// QR code do endereço da sala (H6a, OPS-10): backend/utils/qrCode.js, sem pacote.
//
// Duas conferências independentes do codificador:
// 1. as matrizes com a máscara forçada (0 a 7) são iguais às de outra implementação, a
//    "QRCode for JavaScript" de Kazuhiko Arase, que vem dentro do próprio npm
//    (qrcode-terminal). As matrizes estão em fixtures/qr-code-matrizes.json, geradas uma
//    vez por fixtures/gerar-qr-code-matrizes.js (o cabeçalho dele diz como rodar);
// 2. um leitor escrito aqui, à parte (tabela de alinhamento da norma, campo finito por
//    tabelas de log/exp, síndromes de Reed-Solomon), lê de volta o formato, os dados e a
//    correção de erros e devolve o texto.
// Antes do H6a o módulo não existia: a tela mostrava só o IP, sem QR.
const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/qr-code-matrizes.json');
const { encodeQr, penaltyOfRows, QrTooLongError, MAX_BYTES } = require('../../backend/utils/qrCode.js');

// --- Leitor independente (só correção M, modo byte, versões 1 a 10) ---

// Posições dos padrões de alinhamento (ISO/IEC 18004, anexo E).
const ALIGNMENT = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
// Blocos da correção M: [quantidade, palavras de dados, palavras de correção] por grupo.
const BLOCKS_M = {
    1: [[1, 16, 10]], 2: [[1, 28, 16]], 3: [[1, 44, 26]], 4: [[2, 32, 18]], 5: [[2, 43, 24]],
    6: [[4, 27, 16]], 7: [[4, 31, 18]], 8: [[2, 38, 22], [2, 39, 22]], 9: [[3, 36, 22], [2, 37, 22]], 10: [[4, 43, 26], [1, 44, 26]],
};

const EXP = new Array(512);
const LOG = new Array(256);
(() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function bchFormat(data) {
    let value = data << 10;
    for (let bit = 14; bit >= 10; bit--) if (value & (1 << bit)) value ^= 0x537 << (bit - 10);
    return ((data << 10) | value) ^ 0x5412;
}

function functionMap(version, size) {
    const map = Array.from({ length: size }, () => new Array(size).fill(false));
    const mark = (r, c) => { if (r >= 0 && r < size && c >= 0 && c < size) map[r][c] = true; };
    // Localizadores com separadores (8x8 em três cantos).
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { mark(r, c); mark(r, size - 1 - c); mark(size - 1 - r, c); }
    for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
    const pos = ALIGNMENT[version];
    pos.forEach(r => pos.forEach(c => {
        if ((r < 9 && c < 9) || (r < 9 && c > size - 10) || (r > size - 10 && c < 9)) return;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }));
    // Formato (as duas cópias) e o módulo escuro.
    for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
    for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
    if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i); }
    return map;
}

const MASK_RULES = [
    (r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function decodeQr(rows) {
    const size = rows.length;
    const version = (size - 17) / 4;
    assert.ok(Number.isInteger(version) && version >= 1 && version <= 10, `tamanho inesperado ${size}`);
    const dark = (r, c) => rows[r][c] === '1';
    // Formato, cópia 1: bits 14..9 na linha 8 (colunas 0-5), 8 em (8,7), 7 em (8,8),
    // 6 em (7,8) e 5..0 na coluna 8 (linhas 5..0).
    let word = 0;
    const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    first.forEach(([r, c]) => { word = (word << 1) | (dark(r, c) ? 1 : 0); });
    // Cópia 2: bits 14..8 na coluna 8 de baixo para cima, 7..0 na linha 8 da direita.
    let second = 0;
    for (let i = 0; i < 7; i++) second = (second << 1) | (dark(size - 1 - i, 8) ? 1 : 0);
    for (let i = 0; i < 8; i++) second = (second << 1) | (dark(8, size - 8 + i) ? 1 : 0);
    assert.equal(second, word, 'as duas cópias do formato batem');
    assert.equal(dark(size - 8, 8), true, 'módulo escuro fixo');
    const formatData = [...Array(32).keys()].find(data => bchFormat(data) === word);
    assert.notEqual(formatData, undefined, 'formato com BCH válido');
    assert.equal(formatData >> 3, 0, 'correção M (bits 00)');
    const mask = formatData & 7;
    // Versão (7 a 10): 18 bits com BCH 0x1f25 nos dois blocos 6x3.
    if (version >= 7) {
        let v = 0;
        for (let i = 17; i >= 0; i--) v = (v << 1) | (dark(Math.floor(i / 3), size - 11 + (i % 3)) ? 1 : 0);
        assert.equal(v >> 12, version, 'bloco de versão');
    }
    // Leitura em zigue-zague, de baixo para cima, colunas de duas em duas da direita.
    const map = functionMap(version, size);
    const bits = [];
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col -= 1;
        for (let i = 0; i < size; i++) {
            const r = upward ? size - 1 - i : i;
            for (const c of [col, col - 1]) {
                if (map[r][c]) continue;
                bits.push((dark(r, c) ? 1 : 0) ^ (MASK_RULES[mask](r, c) ? 1 : 0));
            }
        }
        upward = !upward;
    }
    const codewords = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    // Desentrelaça os blocos.
    const groups = BLOCKS_M[version];
    const blocks = [];
    groups.forEach(([count, dataLen, eccLen]) => { for (let i = 0; i < count; i++) blocks.push({ dataLen, eccLen, data: [], ecc: [] }); });
    const maxData = Math.max(...blocks.map(b => b.dataLen));
    let k = 0;
    for (let i = 0; i < maxData; i++) blocks.forEach(b => { if (i < b.dataLen) b.data.push(codewords[k++]); });
    for (let i = 0; i < blocks[0].eccLen; i++) blocks.forEach(b => b.ecc.push(codewords[k++]));
    // Síndromes zero = palavra de Reed-Solomon válida.
    blocks.forEach((b, index) => {
        const all = b.data.concat(b.ecc);
        for (let s = 0; s < b.eccLen; s++) {
            let acc = 0;
            for (const cw of all) acc = gmul(acc, EXP[s]) ^ cw;
            assert.equal(acc, 0, `síndrome ${s} do bloco ${index}`);
        }
    });
    const data = blocks.flatMap(b => b.data);
    const dataBits = data.flatMap(byte => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (byte >> i) & 1));
    const read = (offset, length) => dataBits.slice(offset, offset + length).reduce((a, b) => (a << 1) | b, 0);
    assert.equal(read(0, 4), 0b0100, 'modo byte');
    const countBits = version <= 9 ? 8 : 16;
    const length = read(4, countBits);
    const bytes = [];
    for (let i = 0; i < length; i++) bytes.push(read(4 + countBits + i * 8, 8));
    return { version, mask, text: Buffer.from(bytes).toString('utf8') };
}

// --- Casos ---

test('[UC-REDE-002] máscara forçada 0 a 7: matriz igual à de outra implementação (Arase, que vem no npm)', () => {
    assert.equal(fixtures.cases.length, 24);
    fixtures.cases.forEach(({ text, mask, version, rows }) => {
        const qr = encodeQr(text, { mask });
        assert.equal(qr.version, version, `versão de ${text.length} bytes`);
        assert.equal(qr.mask, mask);
        assert.equal(qr.size, rows.length);
        assert.deepEqual(qr.rows, rows, `matriz de ${text.slice(0, 30)}… com máscara ${mask}`);
    });
});

test('[UC-REDE-002] o leitor independente lê o formato, a correção e o texto de volta', () => {
    const texts = [
        'http://192.168.0.10:3000',
        'https://iclass.local:3000',
        'http://10.0.0.5:3000/' + 'x'.repeat(100),
        'Sala 3 · Laboratório de informática', // UTF-8 com acento e ponto médio
        'a'.repeat(14), 'a'.repeat(15), // limite da versão 1
        'b'.repeat(MAX_BYTES), // versão 10, com o contador de 16 bits
    ];
    texts.forEach(text => {
        for (let mask = 0; mask < 8; mask++) {
            const decoded = decodeQr(encodeQr(text, { mask }).rows);
            assert.equal(decoded.text, text);
            assert.equal(decoded.mask, mask);
        }
        const auto = encodeQr(text);
        assert.equal(decodeQr(auto.rows).text, text);
    });
    assert.equal(encodeQr('a'.repeat(14)).version, 1);
    assert.equal(encodeQr('a'.repeat(15)).version, 2);
    assert.equal(encodeQr('b'.repeat(MAX_BYTES)).version, 10);
});

test('[UC-REDE-002] sem máscara forçada, vale a de menor penalidade (N1 a N4)', () => {
    ['http://192.168.0.10:3000', 'https://iclass.local:3000', 'http://172.16.20.30:3000'].forEach(text => {
        const auto = encodeQr(text);
        const scores = [...Array(8).keys()].map(mask => penaltyOfRows(encodeQr(text, { mask }).rows));
        const best = Math.min(...scores);
        assert.equal(scores[auto.mask], best);
        assert.equal(scores.indexOf(best), auto.mask, 'empate fica com a menor máscara');
        assert.deepEqual(auto.rows, encodeQr(text, { mask: auto.mask }).rows);
    });
});

test('[UC-REDE-002] texto acima de 213 bytes é recusado com QrTooLongError', () => {
    assert.equal(MAX_BYTES, 213);
    assert.throws(() => encodeQr('c'.repeat(214)), error => error instanceof QrTooLongError && error.code === 'QR_TOO_LONG' && error.byteLength === 214);
    // Conta bytes em UTF-8, não caracteres: 107 "é" são 214 bytes.
    assert.throws(() => encodeQr('é'.repeat(107)), QrTooLongError);
    assert.throws(() => encodeQr('x', { mask: 8 }), RangeError);
});
