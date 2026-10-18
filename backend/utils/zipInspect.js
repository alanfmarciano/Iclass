// Leitura assíncrona e parcial de arquivos ZIP: só o diretório central e as entradas
// pedidas, em pedaços. Serve para conferir o conteúdo de um arquivo antes de servi-lo
// sem carregar o ZIP inteiro na memória nem travar o servidor (o adm-zip lê o arquivo
// todo de forma síncrona, e o limite de envio pode chegar a 1 GB).
const fs = require('fs');
const zlib = require('zlib');
const { Readable, pipeline } = require('stream');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const EOCD_MIN_LENGTH = 22;
const EOCD_SEARCH_LENGTH = EOCD_MIN_LENGTH + 0xFFFF; // registro final + comentário máximo
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const STREAM_CHUNK = 64 * 1024;
const ZIP_MAGIC = ['PK\x03\x04', 'PK\x05\x06', 'PK\x07\x08'];

// Fonte de bytes: arquivo em disco (handle aberto) ou buffer (ZIP dentro de ZIP).
function fileSource(filePath, handle, size) {
    return {
        size,
        async read(start, length) {
            const wanted = Math.max(0, Math.min(length, size - start));
            if (!wanted || start < 0) return Buffer.alloc(0);
            const buffer = Buffer.alloc(wanted);
            const { bytesRead } = await handle.read(buffer, 0, wanted, start);
            return buffer.subarray(0, bytesRead);
        },
        stream(start, length) {
            if (length <= 0) return Readable.from([], { objectMode: false });
            return fs.createReadStream(filePath, { start, end: start + length - 1, highWaterMark: STREAM_CHUNK });
        },
    };
}

function bufferSource(buffer) {
    return {
        size: buffer.length,
        async read(start, length) {
            if (start < 0) return Buffer.alloc(0);
            return buffer.subarray(start, Math.min(buffer.length, start + length));
        },
        stream(start, length) {
            const slice = buffer.subarray(Math.max(0, start), Math.min(buffer.length, start + Math.max(0, length)));
            const chunks = [];
            for (let offset = 0; offset < slice.length; offset += STREAM_CHUNK) chunks.push(slice.subarray(offset, offset + STREAM_CHUNK));
            return Readable.from(chunks, { objectMode: false });
        },
    };
}

function hasZipMagic(head) {
    return !!head && head.length >= 4 && ZIP_MAGIC.includes(head.toString('latin1', 0, 4));
}

// Campos ZIP64 (extra 0x0001) para tamanhos/deslocamento que não cabem em 32 bits.
function applyZip64Extra(entry, extra) {
    let offset = 0;
    while (offset + 4 <= extra.length) {
        const id = extra.readUInt16LE(offset);
        const length = extra.readUInt16LE(offset + 2);
        const data = extra.subarray(offset + 4, offset + 4 + length);
        if (id === 0x0001) {
            let cursor = 0;
            const next = () => { const value = cursor + 8 <= data.length ? Number(data.readBigUInt64LE(cursor)) : null; cursor += 8; return value; };
            if (entry.size === 0xFFFFFFFF) entry.size = next() ?? entry.size;
            if (entry.compressedSize === 0xFFFFFFFF) entry.compressedSize = next() ?? entry.compressedSize;
            if (entry.localOffset === 0xFFFFFFFF) entry.localOffset = next() ?? entry.localOffset;
            return;
        }
        offset += 4 + length;
    }
}

// Lê o diretório central. Devolve null quando a fonte não é um ZIP legível.
async function readZipDirectory(source) {
    if (!source || source.size < EOCD_MIN_LENGTH) return null;
    const tailLength = Math.min(source.size, EOCD_SEARCH_LENGTH);
    const tailStart = source.size - tailLength;
    const tail = await source.read(tailStart, tailLength);
    let eocd = -1;
    for (let index = tail.length - EOCD_MIN_LENGTH; index >= 0; index -= 1) {
        if (tail.readUInt32LE(index) === EOCD_SIGNATURE) { eocd = index; break; }
    }
    if (eocd < 0) return null;
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    let delta = 0;
    if (count === 0xFFFF || directorySize === 0xFFFFFFFF || directoryOffset === 0xFFFFFFFF) {
        const locator = eocd - 20;
        if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) return null;
        const record = await source.read(Number(tail.readBigUInt64LE(locator + 8)), 56);
        if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) return null;
        count = Number(record.readBigUInt64LE(32));
        directorySize = Number(record.readBigUInt64LE(40));
        directoryOffset = Number(record.readBigUInt64LE(48));
    } else {
        // Bytes antes do ZIP (autoextraível): os deslocamentos gravados não os contam.
        delta = Math.max(0, (tailStart + eocd - directorySize) - directoryOffset);
    }
    if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + delta + directorySize > source.size) return null;
    const directory = await source.read(directoryOffset + delta, directorySize);
    if (directory.length < directorySize) return null;
    const entries = [];
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
        if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null;
        const flags = directory.readUInt16LE(cursor + 8);
        const nameLength = directory.readUInt16LE(cursor + 28);
        const extraLength = directory.readUInt16LE(cursor + 30);
        const commentLength = directory.readUInt16LE(cursor + 32);
        const nameStart = cursor + 46;
        const entry = {
            name: directory.toString(flags & 0x800 ? 'utf8' : 'latin1', nameStart, nameStart + nameLength).replace(/\\/g, '/'),
            method: directory.readUInt16LE(cursor + 10),
            encrypted: (flags & 0x1) === 0x1,
            compressedSize: directory.readUInt32LE(cursor + 20),
            size: directory.readUInt32LE(cursor + 24),
            localOffset: directory.readUInt32LE(cursor + 42),
        };
        applyZip64Extra(entry, directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength));
        entry.isDirectory = entry.name.endsWith('/');
        entries.push(entry);
        cursor = nameStart + nameLength + extraLength + commentLength;
    }
    return { entries, delta };
}

// Bytes descomprimidos de uma entrada, em pedaços. null: método não suportado,
// entrada cifrada ou cabeçalho local inválido (não dá para conferir).
async function openEntryStream(source, directory, entry) {
    if (entry.encrypted || (entry.method !== 0 && entry.method !== 8)) return null;
    const localStart = entry.localOffset + directory.delta;
    const header = await source.read(localStart, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) return null;
    const dataStart = localStart + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = source.stream(dataStart, entry.compressedSize);
    if (entry.method === 0) return raw;
    const inflate = zlib.createInflateRaw({ chunkSize: STREAM_CHUNK });
    pipeline(raw, inflate, () => {});
    return inflate;
}

// Passa os pedaços da entrada para `onChunk` até ele devolver true (achou), o fim ou
// `maxBytes`. Devolve 'found', 'done', 'limit' ou null (não deu para ler).
async function scanZipEntry(source, directory, entry, onChunk, { maxBytes = Infinity } = {}) {
    let stream;
    try { stream = await openEntryStream(source, directory, entry); } catch (error) { return null; }
    if (!stream) return null;
    let total = 0;
    try {
        for await (const chunk of stream) {
            total += chunk.length;
            if (onChunk(chunk)) { stream.destroy(); return 'found'; }
            if (total > maxBytes) { stream.destroy(); return 'limit'; }
        }
        return 'done';
    } catch (error) {
        stream.destroy();
        return null;
    }
}

// Primeiros `length` bytes descomprimidos (para reconhecer o tipo pelo conteúdo).
async function readZipEntryHead(source, directory, entry, length = 16) {
    const parts = [];
    let total = 0;
    const result = await scanZipEntry(source, directory, entry, chunk => {
        parts.push(chunk);
        total += chunk.length;
        return total >= length;
    });
    if (result === null) return null;
    return Buffer.concat(parts).subarray(0, length);
}

// Entrada inteira na memória (ZIP dentro de ZIP); null se passar de maxBytes.
async function readZipEntryBuffer(source, directory, entry, maxBytes) {
    const parts = [];
    const result = await scanZipEntry(source, directory, entry, chunk => { parts.push(chunk); return false; }, { maxBytes });
    if (result !== 'done') return null;
    return Buffer.concat(parts);
}

module.exports = {
    bufferSource,
    fileSource,
    hasZipMagic,
    readZipDirectory,
    readZipEntryBuffer,
    readZipEntryHead,
    scanZipEntry,
};
