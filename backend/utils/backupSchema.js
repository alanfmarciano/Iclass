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
// - missingCollectionOutcome(entry): o que a restauração faz com a coleção que falta no
//   backup ('keep' ou 'empty'), nos dois caminhos (tela e backup-cli).
// Sem dependência de database.js: as entradas do registro (db.COLLECTION_TABLES) vêm de
// quem chama. A lista das migrações (para recusar backup de versão mais nova) vem do
// backend/migrations/index.js, que também não depende do banco.
const schemaMigrations = require('./schemaMigrations.js');

const BACKUP_FORMAT = 2;

// Tabelas que o registro deixa fora do backup (entradas com backup: false; hoje só as
// sessões). database.js calcula a mesma lista do registro (db.TABLES_OUTSIDE_BACKUP), e um
// teste confere que as duas são iguais. Ela fica repetida aqui para a backup-cli limpar a
// cópia do "criar" sem carregar o database.js, que ao ser carregado abre o banco de
// verdade em leitura e escrita (e o cria, se não existir).
const TABLES_OUTSIDE_BACKUP = Object.freeze(['auth_sessions']);

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
    assignments: 'tarefa',
    assignmentSubmissions: 'entrega de tarefa',
    assignmentFileTombstones: 'arquivo de entrega removido',
    academicTerms: 'período letivo',
    nonSchoolDays: 'dia não letivo',
    classDiary: 'registro do diário',
    classGroups: 'grupo de alunos',
    conversations: 'conversa',
    conversationMessages: 'mensagem de conversa',
    guardianContacts: 'contato com responsável',
};

function itemLabel(collection) {
    return ITEM_LABELS[collection] || 'registro';
}

// Campos que precisam ser texto não vazio e único na coleção (e-mail sem diferenciar
// maiúsculas de minúsculas).
// Coleções da fase 3 (fundação A0): a recusa é só pela chave do registro (o campo do
// tableEntry: id em todas, fileId nas lápides, que não têm id). Chaves compostas (entrega
// de tarefa por tarefa + aluno, diário por curso + turma + data) e a conversa de cada
// mensagem são só aviso na prévia: um backup bom não deixa de restaurar por elas (a
// mesclagem de alunos deixa a entrega do duplicado arquivada ao lado da do que fica).
// optional: o campo pode faltar (students.id: backup de antes do id estável do aluno),
// mas quando existe precisa ser único.
const UNIQUE_FIELDS = [
    { collection: 'students', field: 'email', label: 'e-mail', caseInsensitive: true },
    { collection: 'students', field: 'id', label: 'identificador', caseInsensitive: false, optional: true },
    { collection: 'admins', field: 'email', label: 'e-mail', caseInsensitive: true },
    { collection: 'courses', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'examApplications', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'assignments', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'assignmentSubmissions', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'assignmentFileTombstones', field: 'fileId', label: 'identificador do arquivo', caseInsensitive: false },
    { collection: 'academicTerms', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'nonSchoolDays', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'classDiary', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'classGroups', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'conversations', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'conversationMessages', field: 'id', label: 'identificador', caseInsensitive: false },
    { collection: 'guardianContacts', field: 'id', label: 'identificador', caseInsensitive: false },
];

// Chaves compostas que só avisam (nunca recusam).
const COMPOSITE_WARNINGS = [
    { collection: 'assignmentSubmissions', fields: ['assignmentId', 'studentEmail'], caseInsensitive: ['studentEmail'], text: n => `${n} ${n === 1 ? 'entrega de tarefa repetida' : 'entregas de tarefa repetidas'} para o mesmo aluno na mesma tarefa.` },
    { collection: 'classDiary', fields: ['courseId', 'studentClass', 'date'], caseInsensitive: [], text: n => `${n} ${n === 1 ? 'registro do diário repetido' : 'registros do diário repetidos'} na mesma turma e data.` },
];

function position(index) {
    return index + 1;
}

function checkUnique(data, { collection, field, label, caseInsensitive, optional = false }) {
    const list = data[collection];
    if (!Array.isArray(list)) return;
    const seen = new Map();
    list.forEach((item, index) => {
        const raw = item[field];
        if (optional && (raw === undefined || raw === null || raw === '')) return;
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
    COMPOSITE_WARNINGS.forEach(rule => {
        const list = data[rule.collection];
        if (!Array.isArray(list)) return;
        const seen = new Set();
        let repeated = 0;
        list.forEach(item => {
            const parts = rule.fields.map(field => {
                const value = String(item[field] === undefined || item[field] === null ? '' : item[field]).trim();
                return rule.caseInsensitive.includes(field) ? value.toLowerCase() : value;
            });
            if (parts.some(part => !part)) return;
            const key = parts.join('\u0000');
            if (seen.has(key)) repeated += 1;
            else seen.add(key);
        });
        if (repeated) warnings.push(rule.text(repeated));
    });
    if (Array.isArray(data.conversationMessages)) {
        const known = new Set((Array.isArray(data.conversations) ? data.conversations : []).map(item => String(item.id)));
        const orphan = data.conversationMessages.filter(item => item.conversationId && !known.has(String(item.conversationId))).length;
        if (orphan) warnings.push(`${orphan} ${orphan === 1 ? 'mensagem aponta' : 'mensagens apontam'} para uma conversa que não está no backup.`);
    }
    return warnings;
}

// O que acontece com a coleção que FALTA no backup (laço genérico por modo do registro,
// H4a, CONF-07): entry.missing ('keep' | 'empty', fase 3) vale primeiro; sem ele,
// 'replace' fica vazia (a restauração substitui tudo, como a tela promete; antes a atual
// ficava e misturava, por exemplo, as presenças antigas com as novas); 'keep' (config,
// identidade visual, estrutura antiga) e 'merge' (auditoria, Termos) ficam como estão.
// Exceções: as contas de acesso ficam (só mudam com replaceAccounts e se o backup as traz)
// e as aplicações de prova seguem o caminho de versão anterior (refeitas a partir das
// turmas do backup). Usado pela tela (backup.js applySnapshot) e pela backup-cli.
function missingCollectionOutcome(entry) {
    if (entry.missing === 'keep' || entry.missing === 'empty') return entry.missing;
    if (entry.collection === 'admins' || entry.collection === 'examApplications') return 'keep';
    if (entry.restore === 'keep' || entry.restore === 'merge') return 'keep';
    return 'empty';
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
    // Versão dos dados de uma versão mais nova do IClass: 400, nada muda (D6 do P6).
    if (data.schemaMeta !== undefined) schemaMigrations.assertBackupSchemaKnown(data.schemaMeta);
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
    // esquema { aplicadas: [ids], versaoApp } (fase 3, aditivo: o formato continua 2).
    // Sem o campo (todos os backups de antes): a base 281029f.
    if (manifest.esquema !== undefined) {
        if (!isPlainObject(manifest.esquema) || (manifest.esquema.aplicadas !== undefined && !Array.isArray(manifest.esquema.aplicadas))) {
            throw backupRefusal('Backup inválido: a versão dos dados do manifesto não foi reconhecida.');
        }
        schemaMigrations.assertBackupSchemaKnown(manifest.esquema);
    }
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
    TABLES_OUTSIDE_BACKUP,
    backupRefusal,
    compareManifestWithDatabase,
    UNIQUE_FIELDS,
    isPlainObject,
    missingCollectionOutcome,
    validateBackupData,
    validateManifest,
};
