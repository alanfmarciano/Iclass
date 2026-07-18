const path = require('path');

function isInside(basePath, targetPath, allowBase = false) {
    const base = path.resolve(basePath);
    const target = path.resolve(targetPath);
    if (target === base) return allowBase;
    return target.startsWith(base + path.sep);
}

function assertInside(basePath, targetPath, options = {}) {
    const target = path.resolve(targetPath);
    if (!isInside(basePath, target, options.allowBase === true)) {
        const error = new Error('Caminho fora da área permitida.');
        error.code = 'PATH_OUTSIDE_BASE';
        throw error;
    }
    return target;
}

function resolveInside(basePath, relativePath, options = {}) {
    const value = String(relativePath || '').trim();
    if (!value || path.isAbsolute(value)) {
        const error = new Error('Caminho inválido.');
        error.code = 'INVALID_PATH';
        throw error;
    }
    return assertInside(basePath, path.resolve(basePath, value), options);
}

function assertSafeId(value) {
    const id = String(value || '').trim();
    if (!id || id === '.' || id === '..' || /[\\/\x00-\x1f]/.test(id)) {
        const error = new Error('Identificador inválido.');
        error.code = 'INVALID_ID';
        throw error;
    }
    return id;
}

module.exports = { isInside, assertInside, resolveInside, assertSafeId };
