// ---------------------------------------------------------------------------
// QR code do endereço da sala (H6a, OPS-10), gerado no servidor, sem pacote.
//
// Baseado na estrutura do "QR Code generator library" de Project Nayuki
// (https://www.nayuki.io/page/qr-code-generator-library), licença MIT:
//   Copyright (c) Project Nayuki. (MIT License)
//   Permission is hereby granted, free of charge, to any person obtaining a copy of
//   this software and associated documentation files (the "Software"), to deal in the
//   Software without restriction, including without limitation the rights to use, copy,
//   modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
//   and to permit persons to whom the Software is furnished to do so, subject to the
//   following conditions:
//   - The above copyright notice and this permission notice shall be included in all
//     copies or substantial portions of the Software.
//   - The Software is provided "as is", without warranty of any kind, express or
//     implied, including but not limited to the warranties of merchantability, fitness
//     for a particular purpose and noninfringement. In no event shall the authors or
//     copyright holders be liable for any claim, damages or other liability, whether in
//     an action of contract, tort or otherwise, arising from, out of or in connection
//     with the Software or the use or other dealings in the Software.
//
// Recorte usado pelo IClass: só o modo byte (UTF-8), só a correção M (aguenta ~15% do
// código riscado ou fora de foco, o bastante para a tela projetada) e as versões 1 a 10
// (até 213 bytes; o endereço da sala tem uns 30). Sem "aumentar a correção" quando sobra
// espaço: o resultado é o mesmo de segno 1.6 com error='m', boost_error=False e
// mode='byte' (test/backend/qr-code.test.js compara com matrizes geradas por ele).
//
// encodeQr(text, { mask }) → { version, mask, size, rows }, com rows[y][x] = '1' para
// módulo escuro e '0' para claro, sem a margem (quem desenha põe 4 módulos claros em
// volta). mask (0 a 7) força a máscara; sem ela, vale a de menor penalidade (N1 a N4).
// ---------------------------------------------------------------------------

const MIN_VERSION = 1;
const MAX_VERSION = 10;
// Correção M: bits de formato 00 (L=01, M=00, Q=11, H=10).
const ECC_M_FORMAT_BITS = 0;
// Índice = versão (posição 0 sem uso).
const ECC_CODEWORDS_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_ERROR_CORRECTION_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

class QrTooLongError extends Error {
    constructor(byteLength) {
        super(`Texto longo demais para o QR code (${byteLength} bytes; o máximo é ${maxDataBytes(MAX_VERSION)}).`);
        this.name = 'QrTooLongError';
        this.code = 'QR_TOO_LONG';
        this.byteLength = byteLength;
    }
}

function getBit(value, index) {
    return ((value >>> index) & 1) !== 0;
}

function numRawDataModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const numAlign = Math.floor(version / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (version >= 7) result -= 36;
    }
    return result;
}

function numDataCodewords(version) {
    return Math.floor(numRawDataModules(version) / 8)
        - ECC_CODEWORDS_PER_BLOCK_M[version] * NUM_ERROR_CORRECTION_BLOCKS_M[version];
}

// Bits do contador de caracteres do modo byte: 8 até a versão 9, 16 da 10 em diante.
function byteCountBits(version) {
    return version <= 9 ? 8 : 16;
}

function maxDataBytes(version) {
    return Math.floor((numDataCodewords(version) * 8 - 4 - byteCountBits(version)) / 8);
}

// --- Reed-Solomon em GF(2^8), polinômio 0x11d ---

function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z;
}

function reedSolomonDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function reedSolomonRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
    }
    return result;
}

// --- Montagem dos dados ---

function encodeDataCodewords(bytes, version) {
    const bits = [];
    const append = (value, length) => {
        for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    append(0x4, 4); // modo byte
    append(bytes.length, byteCountBits(version));
    bytes.forEach(b => append(b, 8));
    const capacityBits = numDataCodewords(version) * 8;
    append(0, Math.min(4, capacityBits - bits.length)); // terminador
    append(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);
    const codewords = new Array(bits.length / 8).fill(0);
    bits.forEach((bit, i) => { codewords[i >>> 3] |= bit << (7 - (i & 7)); });
    return codewords;
}

function addEccAndInterleave(data, version) {
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK_M[version];
    const rawCodewords = Math.floor(numRawDataModules(version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const divisor = reedSolomonDivisor(blockEccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
        k += dat.length;
        const ecc = reedSolomonRemainder(dat, divisor);
        if (i < numShortBlocks) dat.push(0);
        blocks.push(dat.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
            if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
        });
    }
    return result;
}

// --- Matriz ---

function alignmentPositions(version, size) {
    if (version === 1) return [];
    const numAlign = Math.floor(version / 7) + 2;
    const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
}

function createMatrix(version) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFunction = (x, y, dark) => {
        modules[y][x] = dark;
        isFunction[y][x] = true;
    };

    // Linhas de sincronismo.
    for (let i = 0; i < size; i++) {
        setFunction(6, i, i % 2 === 0);
        setFunction(i, 6, i % 2 === 0);
    }
    // Três padrões de localização (com a borda clara).
    const finder = (x, y) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                const xx = x + dx;
                const yy = y + dy;
                if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunction(xx, yy, dist !== 2 && dist !== 4);
            }
        }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    // Padrões de alinhamento (fora dos cantos dos localizadores).
    const positions = alignmentPositions(version, size);
    const numAlign = positions.length;
    for (let i = 0; i < numAlign; i++) {
        for (let j = 0; j < numAlign; j++) {
            if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0)) continue;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    setFunction(positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }
        }
    }
    const matrix = { version, size, modules, isFunction, setFunction };
    drawFormatBits(matrix, 0); // reserva a área; os bits certos entram com a máscara
    drawVersion(matrix);
    return matrix;
}

// Formato (correção + máscara) com BCH (0x537) e a máscara fixa 0x5412.
function drawFormatBits(matrix, mask) {
    const { size, setFunction } = matrix;
    const data = (ECC_M_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i));
    setFunction(8, 7, getBit(bits, 6));
    setFunction(8, 8, getBit(bits, 7));
    setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(bits, i));
    setFunction(8, size - 8, true); // o módulo escuro fixo
}

// Versão (a partir da 7) com BCH (0x1f25).
function drawVersion(matrix) {
    const { version, size, setFunction } = matrix;
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
        const bit = getBit(bits, i);
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunction(a, b, bit);
        setFunction(b, a, bit);
    }
}

function drawCodewords(matrix, data) {
    const { size, modules, isFunction } = matrix;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!isFunction[y][x] && i < data.length * 8) {
                    modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
                    i++;
                }
            }
        }
    }
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// Aplica (ou desfaz: é um XOR) a máscara nos módulos de dados.
function applyMask(matrix, mask) {
    const { size, modules, isFunction } = matrix;
    const invert = MASKS[mask];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (!isFunction[y][x] && invert(x, y)) modules[y][x] = !modules[y][x];
        }
    }
}

// --- Penalidades (N1 a N4) para escolher a máscara ---

function penaltyScore(matrix) {
    const { size, modules } = matrix;
    let result = 0;

    const addHistory = (runLength, history) => {
        if (history[0] === 0) runLength += size; // a borda clara conta antes da primeira corrida
        history.pop();
        history.unshift(runLength);
    };
    const countPatterns = history => {
        const n = history[1];
        const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
        return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0)
            + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
    };
    const terminateAndCount = (runColor, runLength, history) => {
        if (runColor) {
            addHistory(runLength, history);
            runLength = 0;
        }
        runLength += size; // a borda clara depois da última corrida
        addHistory(runLength, history);
        return countPatterns(history);
    };
    const scanLine = get => {
        let runColor = false;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let i = 0; i < size; i++) {
            const color = get(i);
            if (color === runColor) {
                run++;
                if (run === 5) result += PENALTY_N1;
                else if (run > 5) result++;
            } else {
                addHistory(run, history);
                if (!runColor) result += countPatterns(history) * PENALTY_N3;
                runColor = color;
                run = 1;
            }
        }
        result += terminateAndCount(runColor, run, history) * PENALTY_N3;
    };
    for (let y = 0; y < size; y++) scanLine(x => modules[y][x]);
    for (let x = 0; x < size; x++) scanLine(y => modules[y][x]);

    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const color = modules[y][x];
            if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) result += PENALTY_N2;
        }
    }

    let dark = 0;
    modules.forEach(row => row.forEach(cell => { if (cell) dark++; }));
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
}

function chooseVersion(byteLength) {
    for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
        if (byteLength <= maxDataBytes(version)) return version;
    }
    return null;
}

function encodeQr(text, { mask } = {}) {
    const bytes = Array.from(Buffer.from(String(text == null ? '' : text), 'utf8'));
    const version = chooseVersion(bytes.length);
    if (!version) throw new QrTooLongError(bytes.length);
    if (mask !== undefined && mask !== null && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) {
        throw new RangeError('A máscara do QR code vai de 0 a 7.');
    }
    const matrix = createMatrix(version);
    drawCodewords(matrix, addEccAndInterleave(encodeDataCodewords(bytes, version), version));

    let chosen = Number.isInteger(mask) ? mask : null;
    if (chosen === null) {
        let best = Infinity;
        for (let candidate = 0; candidate < 8; candidate++) {
            applyMask(matrix, candidate);
            drawFormatBits(matrix, candidate);
            const score = penaltyScore(matrix);
            if (score < best) {
                best = score;
                chosen = candidate;
            }
            applyMask(matrix, candidate); // desfaz
        }
    }
    applyMask(matrix, chosen);
    drawFormatBits(matrix, chosen);

    return {
        version,
        mask: chosen,
        size: matrix.size,
        rows: matrix.modules.map(row => row.map(cell => (cell ? '1' : '0')).join('')),
    };
}

// Só para os testes: a penalidade de uma matriz pronta (rows de encodeQr).
function penaltyOfRows(rows) {
    const size = rows.length;
    return penaltyScore({ size, modules: rows.map(row => Array.from(row, c => c === '1')) });
}

module.exports = {
    MAX_BYTES: maxDataBytes(MAX_VERSION),
    QrTooLongError,
    encodeQr,
    penaltyOfRows,
};
