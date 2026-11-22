const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function configuredPath(envName, fallback) {
    const value = String(process.env[envName] || '').trim();
    return path.resolve(value || fallback);
}

const DATA_DIR = configuredPath('ICLASS_DATA_DIR', path.join(PROJECT_ROOT, 'data'));
const CONTENT_DIR = configuredPath('ICLASS_CONTENT_DIR', path.join(PROJECT_ROOT, 'content'));
const ARCHIVE_DIR = configuredPath('ICLASS_ARCHIVE_DIR', path.join(PROJECT_ROOT, 'cursos_arquivados'));
const WEB_DIST_DIR = path.join(PROJECT_ROOT, 'web', 'dist');
// Arquivos das entregas de tarefa (fase 3, P1): data/entregas/<tarefa>/<entrega>/<arquivo>,
// fora de todo ZIP de backup (a proteção é o espelho no destino externo) e nunca tocada
// pela restauração. Os envios chegam primeiro em .recebendo (mesmo disco: o rename final
// não cruza disco) e o que sobrar ali com mais de 1 h sai no boot.
const ASSIGNMENT_FILES_DIR = path.join(DATA_DIR, 'entregas');

module.exports = {
    PROJECT_ROOT,
    DATA_DIR,
    CONTENT_DIR,
    ARCHIVE_DIR,
    WEB_DIST_DIR,
    UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
    STUDENTS_DIR: path.join(DATA_DIR, 'alunos'),
    TRASH_DIR: path.join(DATA_DIR, 'lixeira'),
    BACKUPS_DIR: path.join(DATA_DIR, 'backups'),
    ASSIGNMENT_FILES_DIR,
    ASSIGNMENT_RECEIVING_DIR: path.join(ASSIGNMENT_FILES_DIR, '.recebendo'),
};
