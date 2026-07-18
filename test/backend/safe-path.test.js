const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveInside, assertSafeId } = require('../../backend/utils/safePath.js');

test('[UC-SEC-001] resolveInside rejeita traversal, caminhos absolutos e a própria raiz', () => {
    const base = path.join(os.tmpdir(), 'iclass-safe-path-base');
    assert.throws(() => resolveInside(base, '..'), /fora da área permitida/);
    assert.throws(() => resolveInside(base, '../database.db'), /fora da área permitida/);
    assert.throws(() => resolveInside(base, path.resolve(base, 'file.txt')), /Caminho inválido/);
    assert.equal(resolveInside(base, 'nested/file.txt'), path.join(base, 'nested', 'file.txt'));
});

test('assertSafeId rejeita separadores e segmentos especiais', () => {
    for (const value of ['', '.', '..', '../x', '..\\x', 'folder/name']) {
        assert.throws(() => assertSafeId(value), /Identificador inválido/);
    }
    assert.equal(assertSafeId('trash_123__arquivo.pdf'), 'trash_123__arquivo.pdf');
});

test('deleteTrashItem só remove IDs existentes no manifesto e nunca escapa da lixeira', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-storage-test-'));
    process.env.ICLASS_DATA_DIR = temp;
    const storage = require('../../backend/utils/storage.js');

    fs.mkdirSync(storage.LIXEIRA_DIR, { recursive: true });
    const protectedFile = path.join(temp, 'database.db');
    fs.writeFileSync(protectedFile, 'preservar');

    assert.throws(() => storage.deleteTrashItem('../database.db'), /Identificador inválido/);
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'preservar');

    const id = 'trash_1__arquivo.txt';
    fs.writeFileSync(path.join(storage.LIXEIRA_DIR, id), 'apagar');
    fs.writeFileSync(path.join(storage.LIXEIRA_DIR, '_index.json'), JSON.stringify([
        { id, name: 'arquivo.txt', originalRel: 'uploads/arquivo.txt', isDir: false, deletedAt: Date.now() }
    ]));

    assert.equal(storage.deleteTrashItem(id), true);
    assert.equal(fs.existsSync(path.join(storage.LIXEIRA_DIR, id)), false);
    assert.equal(fs.existsSync(protectedFile), true);
    fs.rmSync(temp, { recursive: true, force: true });
});
