const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Pastas de dados do pacote de release (fase 3, A15 / P6-S3, D10 do P6). No pacote
// instalado, cada pasta de versão (C:\IClass\programa\<versão>) recebe um
// iclass-pastas.json com os três caminhos de fora dela:
//   { "dados": "C:\\IClass\\dados", "conteudo": "C:\\IClass\\conteudo",
//     "cursosArquivados": "C:\\IClass\\cursos-arquivados" }
// Toda porta de entrada (servidor, supervisor, backup-cli, redefinir senha) lê o mesmo
// arquivo, então todas acham os dados certos, e não só o launcher. A pasta da versão é
// trocada a cada atualização: os dados nunca podem ficar dentro dela (contrato C2).
// Ordem de cada pasta: a variável de ambiente (os testes e o modo demonstração usam),
// depois o arquivo, depois o padrão de hoje (<pasta do programa>/data, content e
// cursos_arquivados, o que a instalação pelo git usa). Arquivo ilegível ou caminho inválido
// não derruba nada: vale o padrão, com o aviso no console.
const FOLDERS_FILE_NAME = 'iclass-pastas.json';
const FOLDERS = Object.freeze([
    { key: 'DATA_DIR', env: 'ICLASS_DATA_DIR', field: 'dados', fallback: 'data' },
    { key: 'CONTENT_DIR', env: 'ICLASS_CONTENT_DIR', field: 'conteudo', fallback: 'content' },
    { key: 'ARCHIVE_DIR', env: 'ICLASS_ARCHIVE_DIR', field: 'cursosArquivados', fallback: 'cursos_arquivados' },
]);

// Texto do arquivo: UTF-8 com ou sem BOM, ou UTF-16 LE com BOM (o que o Bloco de Notas e o
// PowerShell do Windows gravam quando alguém edita o arquivo à mão).
function decodeText(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.slice(2).toString('utf16le');
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.slice(3).toString('utf8');
    return buffer.toString('utf8');
}

// Lê <projectRoot>/iclass-pastas.json. Devolve { file, found, values: { campo: caminho }, warnings }.
// Caminho relativo vale a partir da pasta do arquivo (o launcher grava sempre absoluto).
function readFoldersFile(projectRoot = PROJECT_ROOT) {
    const file = path.join(projectRoot, FOLDERS_FILE_NAME);
    const result = { file, found: false, values: {}, warnings: [] };
    let raw;
    try {
        raw = fs.readFileSync(file);
    } catch (err) {
        if (err && err.code === 'ENOENT') return result;
        result.found = true;
        result.warnings.push(`Não foi possível ler ${file} (${err && err.code ? err.code : err}): o IClass usa as pastas padrão.`);
        return result;
    }
    result.found = true;
    let parsed;
    try {
        parsed = JSON.parse(decodeText(raw));
    } catch (err) {
        result.warnings.push(`O arquivo ${file} está ilegível (não é um JSON válido): o IClass usa as pastas padrão.`);
        return result;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        result.warnings.push(`O arquivo ${file} não tem as pastas no formato esperado: o IClass usa as pastas padrão.`);
        return result;
    }
    FOLDERS.forEach(({ field }) => {
        if (!Object.prototype.hasOwnProperty.call(parsed, field)) return;
        const value = parsed[field];
        if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
            result.warnings.push(`O campo "${field}" de ${file} não é um caminho de pasta: vale a pasta padrão.`);
            return;
        }
        result.values[field] = path.resolve(path.dirname(file), value.trim());
    });
    return result;
}

// As três pastas, pela ordem variável > arquivo > padrão. Função pura (o ambiente e a pasta
// do programa vêm de fora) para os testes; o módulo usa o processo de agora.
function resolveRuntimeFolders({ projectRoot = PROJECT_ROOT, env = process.env } = {}) {
    const fromFile = readFoldersFile(projectRoot);
    const folders = { origem: {}, arquivo: fromFile.found ? fromFile.file : null, avisos: fromFile.warnings.slice() };
    FOLDERS.forEach(({ key, env: envName, field, fallback }) => {
        const fromEnv = String((env && env[envName]) || '').trim();
        if (fromEnv) {
            folders[key] = path.resolve(fromEnv);
            folders.origem[key] = 'variavel';
        } else if (fromFile.values[field]) {
            folders[key] = fromFile.values[field];
            folders.origem[key] = 'arquivo';
        } else {
            folders[key] = path.resolve(path.join(projectRoot, fallback));
            folders.origem[key] = 'padrao';
        }
    });
    return folders;
}

const folders = resolveRuntimeFolders();
folders.avisos.forEach(text => console.warn(`⚠️ ${text}`));

const DATA_DIR = folders.DATA_DIR;
const CONTENT_DIR = folders.CONTENT_DIR;
const ARCHIVE_DIR = folders.ARCHIVE_DIR;
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
    // De onde veio cada pasta ('variavel' | 'arquivo' | 'padrao') e o iclass-pastas.json lido.
    FOLDERS_FILE_NAME,
    FOLDERS_FILE: folders.arquivo,
    FOLDERS_SOURCE: Object.freeze({ ...folders.origem }),
    FOLDERS_WARNINGS: Object.freeze(folders.avisos.slice()),
    readFoldersFile,
    resolveRuntimeFolders,
};
