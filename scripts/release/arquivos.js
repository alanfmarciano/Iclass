// Ajudantes de arquivo do pacote de release (fase 3, A15 / P6-S3). Sem pacote novo: SHA-256
// pelo crypto, .tar.gz pelo zlib com um leitor de tar pequeno (ustar, pax e nomes longos
// do GNU), download pelo curl (que já respeita o proxy e o certificado do ambiente) ou,
// sem ele, pelo fetch do Node.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        let read;
        while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read));
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

// Nome de entrada de arquivo compactado: relativo, com /, sem "..", sem letra de unidade.
function safeEntryName(name) {
    if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\')) return false;
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
    return name.replace(/\/+$/, '').split('/').every(part => part && part !== '..');
}

function tarString(block, start, length) {
    const raw = block.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
}

function tarNumber(block, start, length) {
    const raw = block.subarray(start, start + length);
    if (raw[0] & 0x80) {
        // base 256 (GNU) para tamanhos grandes
        let value = 0;
        for (let i = 1; i < raw.length; i += 1) value = value * 256 + raw[i];
        return value;
    }
    const text = raw.toString('ascii').replace(/\0.*$/, '').trim();
    return text ? parseInt(text, 8) : 0;
}

function parsePax(data) {
    const values = {};
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space < 0) break;
        const length = parseInt(data.subarray(offset, space).toString('ascii'), 10);
        if (!Number.isFinite(length) || length <= 0) break;
        const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
        const equals = record.indexOf('=');
        if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
        offset += length;
    }
    return values;
}

// Lê um tar (já descompactado) e devolve as entradas de arquivo comum:
// [{ name, mode, data }]. Com `wanted` (Set de nomes), guarda só os dados dessas.
// Entrada com nome perigoso ("..", caminho absoluto) faz a leitura falhar.
function readTar(buffer, { wanted = null } = {}) {
    const entries = [];
    let offset = 0;
    let nextName = null;
    while (offset + 512 <= buffer.length) {
        const header = buffer.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const size = tarNumber(header, 124, 12);
        const type = String.fromCharCode(header[156] || 48);
        const dataStart = offset + 512;
        const data = buffer.subarray(dataStart, dataStart + size);
        offset = dataStart + Math.ceil(size / 512) * 512;
        if (type === 'x') {
            const pax = parsePax(data);
            if (pax.path) nextName = pax.path;
            continue;
        }
        if (type === 'g' || type === 'K') continue;
        if (type === 'L') {
            nextName = data.toString('utf8').replace(/\0+$/, '');
            continue;
        }
        const prefix = tarString(header, 345, 155);
        const baseName = tarString(header, 0, 100);
        let name = nextName || (prefix ? `${prefix}/${baseName}` : baseName);
        nextName = null;
        name = name.replace(/^\.\//, '');
        if (!name) continue;
        if (!safeEntryName(name)) throw new Error(`Entrada perigosa no arquivo compactado: ${name}`);
        if (type !== '0' && type !== '\0' && type !== '7') continue;
        if (wanted && !wanted.has(name)) continue;
        entries.push({ name, mode: tarNumber(header, 100, 8), data: Buffer.from(data) });
    }
    return entries;
}

function readTarGz(file, options) {
    return readTar(zlib.gunzipSync(fs.readFileSync(file)), options);
}

// SHASUMS256.txt do nodejs.org: "<sha256>  <arquivo>" por linha.
function parseShasums(text) {
    const sums = {};
    String(text || '').split(/\r?\n/).forEach(line => {
        const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
        if (match) sums[match[2]] = match[1];
    });
    return sums;
}

function commandExists(command) {
    const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
    return !probe.error;
}

// Baixa `url` para `destination` (pasta criada). Primeiro num .parcial ao lado, que só vira
// o arquivo final quando o download terminou.
async function download(url, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const partial = `${destination}.parcial`;
    fs.rmSync(partial, { force: true });
    if (commandExists('curl')) {
        const result = spawnSync('curl', ['-fsSL', '--retry', '3', '--connect-timeout', '30', '-o', partial, url], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
        if (result.status !== 0) {
            fs.rmSync(partial, { force: true });
            throw new Error(`Não foi possível baixar ${url}: ${String(result.stderr || '').trim() || `curl saiu com ${result.status}`}`);
        }
    } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Não foi possível baixar ${url}: HTTP ${response.status}`);
        fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    }
    fs.renameSync(partial, destination);
    return destination;
}

// Arquivos de uma pasta, com caminho relativo em / e em ordem (links simbólicos ficam de
// fora: o pacote não leva link).
function listFiles(root) {
    const files = [];
    function walk(directory, relative) {
        fs.readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .forEach(entry => {
                const full = path.join(directory, entry.name);
                const rel = relative ? `${relative}/${entry.name}` : entry.name;
                if (entry.isDirectory()) walk(full, rel);
                else if (entry.isFile()) files.push(rel);
            });
    }
    walk(root, '');
    return files;
}

function copyDirectory(from, to) {
    fs.mkdirSync(to, { recursive: true });
    fs.readdirSync(from, { withFileTypes: true }).forEach(entry => {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) copyDirectory(source, target);
        else if (entry.isFile()) fs.copyFileSync(source, target);
    });
}

module.exports = {
    copyDirectory,
    download,
    listFiles,
    parseShasums,
    readTar,
    readTarGz,
    safeEntryName,
    sha256Buffer,
    sha256File,
};
