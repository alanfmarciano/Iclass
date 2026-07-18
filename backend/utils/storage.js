// ---------------------------------------------------------------------------
// Armazenamento organizado + LIXEIRA com manifesto (restaurável).
//  - data/alunos/<matricula - nome>/<categoria>/<data>_<arquivo>   (privado)
//  - data/lixeira/<id>__<nome>  + data/lixeira/_index.json          (excluídos)
//  - data/uploads/                                                  (público)
// Nada de exclusão física direta: moveToTrash preserva e registra a origem,
// permitindo restaurar. purgeTrash conta o prazo pela DATA DA EXCLUSÃO.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtimePaths.js');
const { assertInside, resolveInside, assertSafeId } = require('./safePath.js');

const DATA = runtimePaths.DATA_DIR;
const ALUNOS_DIR = runtimePaths.STUDENTS_DIR;
const LIXEIRA_DIR = runtimePaths.TRASH_DIR;
const UPLOADS_DIR = runtimePaths.UPLOADS_DIR;
const TRASH_INDEX = path.join(LIXEIRA_DIR, '_index.json');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function safeName(s) {
    return String(s || '')
        .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/, '')
        .trim()
        .slice(0, 120);
}

function studentFolderName(student) {
    const mat = safeName(student && student.matricula || '');
    const nome = safeName((student && ((student.nomeSocial && student.nomeSocial.trim()) || student.name)) || (student && student.email) || 'aluno');
    return ((mat ? mat + ' - ' : '') + (nome || safeName(student && student.email) || 'aluno'));
}

function studentDir(student) {
    const d = path.join(ALUNOS_DIR, studentFolderName(student));
    ensureDir(d);
    return d;
}

function storeStudentFile(student, category, originalName, tempAbsPath) {
    const catDir = path.join(studentDir(student), safeName(category || 'documentos'));
    ensureDir(catDir);
    const ext = path.extname(originalName || '') || '';
    const base = safeName(path.basename(originalName || 'arquivo', ext)) || 'arquivo';
    const stamp = new Date().toISOString().slice(0, 10);
    let target = path.join(catDir, `${stamp}_${base}${ext}`);
    let i = 1;
    while (fs.existsSync(target)) { target = path.join(catDir, `${stamp}_${base} (${i})${ext}`); i++; }
    fs.renameSync(tempAbsPath, target);
    return relFromData(target);
}

function relFromData(absPath) { return path.relative(DATA, absPath).split(path.sep).join('/'); }
function absFromData(rel) { return path.join(DATA, String(rel || '').split('/').join(path.sep)); }
function isInsideStudents(rel) {
    const target = path.resolve(absFromData(rel));
    const base = path.resolve(ALUNOS_DIR);
    return target === base || target.startsWith(base + path.sep);
}

// ----- LIXEIRA (manifesto) --------------------------------------------------
function readIndex() {
    try { return JSON.parse(fs.readFileSync(TRASH_INDEX, 'utf8')) || []; } catch (e) { return []; }
}
function writeIndex(arr) {
    ensureDir(LIXEIRA_DIR);
    try { fs.writeFileSync(TRASH_INDEX, JSON.stringify(arr, null, 2)); } catch (e) {}
}

function uniquePath(target, isDir) {
    if (!fs.existsSync(target)) return target;
    const dir = path.dirname(target);
    const ext = isDir ? '' : path.extname(target);
    const base = isDir ? path.basename(target) : path.basename(target, ext);
    let i = 1, p;
    do { p = path.join(dir, `${base} (restaurado${i > 1 ? ' ' + i : ''})${ext}`); i++; } while (fs.existsSync(p));
    return p;
}

// Move um arquivo/pasta (abs) para a lixeira, registrando a origem para restaurar.
function moveToTrash(absPath) {
    try {
        if (!absPath || !fs.existsSync(absPath)) return null;
        absPath = assertInside(DATA, absPath);
        ensureDir(LIXEIRA_DIR);
        const originalRel = relFromData(absPath);
        const isDir = fs.statSync(absPath).isDirectory();
        const id = 'trash_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const stored = id + '__' + safeName(path.basename(absPath));
        const dest = path.join(LIXEIRA_DIR, stored);
        fs.renameSync(absPath, dest);
        const idx = readIndex();
        idx.push({ id: stored, name: path.basename(originalRel), originalRel, isDir, deletedAt: Date.now() });
        writeIndex(idx);
        return stored;
    } catch (e) { return null; }
}
function moveDirToTrash(absDir) { return moveToTrash(absDir); }

function dirSize(p) {
    let total = 0;
    try {
        for (const n of fs.readdirSync(p)) {
            const fp = path.join(p, n);
            const st = fs.statSync(fp);
            total += st.isDirectory() ? dirSize(fp) : st.size;
        }
    } catch (e) {}
    return total;
}

// Lista os itens da lixeira (só os que ainda existem em disco).
function listTrash() {
    const idx = readIndex();
    const out = [];
    let changed = false;
    idx.forEach(e => {
        const abs = path.join(LIXEIRA_DIR, e.id);
        if (!fs.existsSync(abs)) { changed = true; return; }
        let size = 0;
        try { const st = fs.statSync(abs); size = st.isDirectory() ? dirSize(abs) : st.size; } catch (e2) {}
        out.push({ id: e.id, name: e.name, originalRel: e.originalRel, isDir: !!e.isDir, deletedAt: e.deletedAt, size });
    });
    if (changed) writeIndex(idx.filter(e => fs.existsSync(path.join(LIXEIRA_DIR, e.id))));
    return out.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

// Restaura um item para o caminho original (sem sobrescrever).
function restoreTrash(id) {
    const idx = readIndex();
    try { id = assertSafeId(id); } catch (e) { return { ok: false, error: e.message }; }
    const e = idx.find(x => x.id === id);
    if (!e) return { ok: false, error: 'Item não encontrado na lixeira.' };
    let src;
    let target;
    try {
        src = resolveInside(LIXEIRA_DIR, e.id);
        target = resolveInside(DATA, e.originalRel);
    } catch (error) {
        return { ok: false, error: 'Manifesto da lixeira contém caminho inválido.' };
    }
    if (!fs.existsSync(src)) { writeIndex(idx.filter(x => x.id !== id)); return { ok: false, error: 'Arquivo não existe mais.' }; }
    ensureDir(path.dirname(target));
    target = uniquePath(target, e.isDir);
    fs.renameSync(src, target);
    writeIndex(idx.filter(x => x.id !== id));
    return { ok: true, restoredTo: relFromData(target) };
}

// Exclui definitivamente um item da lixeira.
function deleteTrashItem(id) {
    const idx = readIndex();
    id = assertSafeId(id);
    const entry = idx.find(x => x.id === id);
    if (!entry) return false;
    const abs = resolveInside(LIXEIRA_DIR, entry.id);
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    writeIndex(idx.filter(x => x.id !== id));
    return true;
}

// Esvazia a lixeira inteira.
function emptyTrash() {
    const idx = readIndex();
    let n = 0;
    idx.forEach(e => { try { const abs = resolveInside(LIXEIRA_DIR, assertSafeId(e.id)); if (fs.existsSync(abs)) { fs.rmSync(abs, { recursive: true, force: true }); n++; } } catch (e2) {} });
    writeIndex([]);
    return n;
}

// Remove da lixeira o que passou de N dias DESDE A EXCLUSÃO (0 = nunca).
function purgeTrash(days) {
    if (!days || days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    const idx = readIndex();
    const keep = [];
    let n = 0;
    idx.forEach(e => {
        if ((e.deletedAt || 0) < cutoff) {
            try { const abs = resolveInside(LIXEIRA_DIR, assertSafeId(e.id)); if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true }); } catch (e2) {}
            n++;
        } else keep.push(e);
    });
    if (n) writeIndex(keep);
    return n;
}

module.exports = {
    DATA, ALUNOS_DIR, LIXEIRA_DIR, UPLOADS_DIR,
    safeName, studentFolderName, studentDir, storeStudentFile,
    moveToTrash, moveDirToTrash, purgeTrash, listTrash, restoreTrash, deleteTrashItem, emptyTrash,
    relFromData, absFromData, isInsideStudents, ensureDir,
};
