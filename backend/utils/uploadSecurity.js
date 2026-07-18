const fs = require('fs');
const path = require('path');

const BLOCKED_EXTENSIONS = new Set([
    '.html', '.htm', '.xhtml', '.js', '.mjs', '.cjs', '.svg', '.exe', '.com', '.bat',
    '.cmd', '.ps1', '.msi', '.scr', '.jar', '.php', '.asp', '.aspx', '.sh'
]);

function isBlockedUploadName(name) {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized || normalized.includes('\0')) return true;
    return BLOCKED_EXTENSIONS.has(path.extname(normalized));
}

function hasPrefix(buffer, bytes, offset = 0) {
    return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function signatureMatches(filePath, extension) {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(32);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const head = buffer.subarray(0, length);
    const ext = String(extension || '').toLowerCase();

    if (ext === '.jpg' || ext === '.jpeg') return hasPrefix(head, [0xff, 0xd8, 0xff]);
    if (ext === '.png') return hasPrefix(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (ext === '.gif') return head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a';
    if (ext === '.webp') return head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP';
    if (ext === '.pdf') return head.subarray(0, 5).toString('ascii') === '%PDF-';
    if (['.zip', '.docx', '.xlsx', '.pptx', '.odt', '.ods'].includes(ext)) return hasPrefix(head, [0x50, 0x4b]);
    if (['.doc', '.xls', '.ppt'].includes(ext)) return hasPrefix(head, [0xd0, 0xcf, 0x11, 0xe0]);
    if (['.mp4', '.mov'].includes(ext)) return head.subarray(4, 8).toString('ascii') === 'ftyp';
    if (ext === '.webm') return hasPrefix(head, [0x1a, 0x45, 0xdf, 0xa3]);
    if (['.csv', '.txt', '.md', '.json'].includes(ext)) return !head.includes(0);
    return false;
}

function validateUploadedFile(file) {
    if (!file || isBlockedUploadName(file.originalname)) return { valid: false, reason: 'Tipo de arquivo bloqueado por segurança.' };
    const extension = path.extname(file.originalname).toLowerCase();
    if (!signatureMatches(file.path, extension)) return { valid: false, reason: 'A assinatura do arquivo não corresponde ao formato informado.' };
    const mime = String(file.mimetype || '').toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extension) && !mime.startsWith('image/')) {
        return { valid: false, reason: 'MIME de imagem inválido.' };
    }
    return { valid: true, extension };
}

module.exports = { BLOCKED_EXTENSIONS, isBlockedUploadName, validateUploadedFile };
