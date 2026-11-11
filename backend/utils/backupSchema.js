// Validação do backup antes de restaurar (H4a, CONF-08). Antes só o tipo, a versão "3." e
// se cada coleção era lista ou objeto eram conferidos: passavam aluno sem e-mail, turma
// sem nome e e-mails repetidos, e o arquivo editado à mão entrava no banco.
//
// - validateBackupData(data, tables): regras de estrutura das coleções; a recusa sai em
//   português com a coleção e a posição (status 400). Devolve os avisos, que não
//   bloqueiam e aparecem na prévia;
// - validateManifest(manifest): o manifesto do ZIP formato 2 (iclass-backup.json);
// - compareManifestWithDatabase(manifest, info): o banco extraído (tamanho, SHA-256 e
//   contagem de cada tabela) igual ao que o manifesto diz.
// Sem dependência de database.js: as entradas do registro (db.COLLECTION_TABLES) vêm de
// quem chama.

const BACKUP_FORMAT = 2;

// Recusa prevista do arquivo enviado para restaurar: status 400 e mensagem em português,
// que a rota devolve como está (sendRouteError).
function backupRefusal(message) {
    return Object.assign(new Error(message), { status: 400 });
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// Nome de cada registro na mensagem de recusa.
const ITEM_LABELS = {
    students: 'aluno',
    admins: 'conta de acesso',
    courses: 'curso',
    classes: 'turma',
    examApplications: 'aplicação de prova',
    submissions: 'entrega',
};

function itemLabel(collection) {
    return ITEM_LABELS[collection] || 'registro';
}

// Campos que precisam ser texto não vazio e único na coleção (e-mail sem diferenciar
// maiúsculas de minúsculas).
const UNIQUE_FIELDS = [
    { collection: 'students', field: 'email', label: 'e-mail', caseInsensitive: true },
    { collection: 'admins', field: 'email', label: 'e-mail', caseInsensitive: true },
    { collection: 'courses', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'examApplications', field: 'id', label: 'identificador', caseInsensitive: false },
];

function position(index) {
    return index + 1;
}

function checkUnique(data, { collection, field, label, caseInsensitive }) {
    const list = data[collection];
    if (!Array.isArray(list)) return;
    const seen = new Map();
    list.forEach((item, index) => {
        const raw = item[field];
        if (typeof raw !== 'string' || !raw.trim()) {
            throw backupRefusal(`Backup inválido: ${itemLabel(collection)} sem ${label} na posição ${position(index)} (${collection}).`);
        }
        const key = caseInsensitive ? raw.trim().toLowerCase() : raw.trim();
        if (seen.has(key)) {
            throw backupRefusal(`Backup inválido: ${label} repetido "${raw.trim()}" nas posições ${position(seen.get(key))} e ${position(index)} (${collection}).`);
        }
        seen.set(key, index);
    });
}

function checkClasses(data) {
    const list = data.classes;
    if (!Array.isArray(list)) return;
    const seen = new Map();
    list.forEach((item, index) => {
        if (typeof item.name !== 'string' || !item.name.trim()) {
            throw backupRefusal(`Backup inválido: turma sem nome na posição ${position(index)} (classes).`);
        }
        const key = `${String(item.courseId || '').trim()}::${item.name.trim()}`;
        if (seen.has(key)) {
            throw backupRefusal(`Backup inválido: turma repetida "${item.name.trim()}" no mesmo curso nas posições ${position(seen.get(key))} e ${position(index)} (classes).`);
        }
        seen.set(key, index);
    });
}

// Avisos que não bloqueiam: referências quebradas que o IClass já tolera.
function collectWarnings(data) {
    const warnings = [];
    if (Array.isArray(data.examApplications) && Array.isArray(data.submissions)) {
        const ids = new Set(data.examApplications.map(item => String(item.id)));
        const orphan = data.submissions.filter(item => item.applicationId && !ids.has(String(item.applicationId))).length;
        if (orphan) warnings.push(`${orphan} ${orphan === 1 ? 'entrega aponta' : 'entregas apontam'} para uma aplicação de prova que não está no backup.`);
    }
    if (Array.isArray(data.classes) && Array.isArray(data.students)) {
        const byName = new Set(data.classes.map(item => String(item.name || '').trim()));
        const byKey = new Set(data.classes.map(item => `${String(item.courseId || '').trim()}::${String(item.name || '').trim()}`));
        let missing = 0;
        data.students.forEach(student => {
            const memberships = Array.isArray(student.classes) ? student.classes : [];
            memberships.forEach(item => {
                const name = String(typeof item === 'string' ? item : (item && (item.name || item.className)) || '').trim();
                if (!name) return;
                const courseId = item && typeof item === 'object' ? String(item.courseId || '').trim() : '';
                const found = courseId ? byKey.has(`${courseId}::${name}`) : byName.has(name);
                if (!found) missing += 1;
            });
        });
        if (missing) warnings.push(`${missing} ${missing === 1 ? 'matrícula aponta' : 'matrículas apontam'} para uma turma que não está no backup.`);
    }
    return warnings;
}

// Regras de estrutura. tables: as entradas do registro com backup (kind 'array',
// 'object', 'singleton' ou 'store'). Coleção que falta não é conferida aqui (a restauração
// decide pelo modo dela).
function validateBackupData(data, tables) {
    if (!isPlainObject(data)) throw backupRefusal('Arquivo de backup inválido.');
    for (const entry of tables) {
        const value = data[entry.collection];
        if (value === undefined) continue;
        const name = entry.collection;
        if (entry.kind === 'array' || entry.kind === 'store') {
            if (!Array.isArray(value)) throw backupRefusal(`Backup inválido: a coleção ${name} precisa ser uma lista.`);
            const bad = value.findIndex(item => !isPlainObject(item));
            if (bad >= 0) throw backupRefusal(`Backup inválido: ${itemLabel(name)} que não é um registro na posição ${position(bad)} (${name}).`);
        } else if (entry.kind === 'object') {
            if (!isPlainObject(value)) throw backupRefusal(`Backup inválido: a coleção ${name} precisa ser um objeto.`);
        } else if (entry.kind === 'singleton') {
            const wantsArray = Array.isArray(entry.empty && entry.empty());
            if (wantsArray ? !Array.isArray(value) : !isPlainObject(value)) {
                throw backupRefusal(`Backup inválido: ${name} precisa ser ${wantsArray ? 'uma lista' : 'um objeto'}.`);
            }
        }
    }
    UNIQUE_FIELDS.forEach(rule => checkUnique(data, rule));
    checkClasses(data);
    return { warnings: collectWarnings(data) };
}

function validateManifest(manifest) {
    if (!isPlainObject(manifest) || manifest.type !== 'iclass-backup-manifest') {
        throw backupRefusal('Backup inválido: o manifesto iclass-backup.json não é de um backup do IClass.');
    }
    const format = Number(manifest.formato);
    if (!Number.isInteger(format) || format < 2) throw backupRefusal('Backup inválido: o formato do manifesto não foi reconhecido.');
    if (format > BACKUP_FORMAT) {
        throw backupRefusal(`Este backup é de uma versão mais nova do IClass (formato ${format}) e não pode ser restaurado nesta versão. Atualize o IClass antes de restaurar.`);
    }
    const bank = manifest.banco;
    if (!isPlainObject(bank) || typeof bank.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(bank.sha256)
        || !Number.isFinite(Number(bank.bytes)) || !isPlainObject(bank.tabelas)) {
        throw backupRefusal('Backup inválido: o manifesto não traz a soma de verificação do banco.');
    }
    if (manifest.inclui !== undefined && !Array.isArray(manifest.inclui)) throw backupRefusal('Backup inválido: a lista de pastas do manifesto não foi reconhecida.');
    return manifest;
}

// O banco extraído precisa ser o mesmo que foi gravado: tamanho, SHA-256 e contagens.
function compareManifestWithDatabase(manifest, info) {
    const bank = manifest.banco;
    if (Number(bank.bytes) !== Number(info.bytes) || String(bank.sha256).toLowerCase() !== String(info.sha256).toLowerCase()) {
        throw backupRefusal('Backup inválido: o banco de dados dentro do ZIP não confere com a soma de verificação do manifesto (arquivo alterado ou corrompido).');
    }
    for (const [table, count] of Object.entries(bank.tabelas)) {
        if (Number(info.tabelas[table]) !== Number(count)) {
            throw backupRefusal(`Backup inválido: a tabela ${table} tem ${Number(info.tabelas[table]) || 0} registro(s) no banco e ${Number(count) || 0} no manifesto.`);
        }
    }
}

module.exports = {
    BACKUP_FORMAT,
    backupRefusal,
    compareManifestWithDatabase,
    isPlainObject,
    validateBackupData,
    validateManifest,
};
