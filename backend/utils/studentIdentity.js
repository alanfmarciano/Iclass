// Identidade do aluno (fase 3, C1 / P4-S3: CRIT-05; decisões D21, D22 e D23 do P4).
//
// O e-mail continua sendo a chave do aluno nas coleções de hoje (as 194 referências e a
// chave da tabela students ficam como estão, D21). Este módulo acrescenta:
// - students[].id estável: 'alu_' + 16 hex (crypto). Garantido por ensureStudentIds, que é
//   a migração '2026-11-p4-ids-alunos' do registro (backend/migrations/index.js) e também
//   uma normalização de TODO boot e de depois de TODA restauração (BOOT_NORMALIZATIONS):
//   a versão 281029f abre o banco migrado sem reclamar e pode criar aluno sem id. Ao
//   restaurar um backup sem ids, o aluno reaproveita o id que o mesmo e-mail tinha antes
//   (ctx.previousStudentIds, lido pelo gancho antes do laço) e só então ganha um novo; os
//   registros das coleções novas cujo studentId não resolve são religados pelo e-mail
//   (handler.relink de utils/studentDataHandlers.js), na mesma passada;
// - findStudentById / findStudentByEmail: o jeito de achar o aluno nas rotas
//   administrativas e nos módulos de dado (o portal lê req.studentAccount);
// - login por matrícula (D22): resolveStudentLogin troca a matrícula digitada pelo e-mail
//   da conta, antes do attemptPasswordLogin. Matrícula comparada sem espaços e sem
//   diferenciar maiúscula, só entre cadastros não anonimizados; nenhuma ou mais de uma
//   conta com ela dá o mesmo erro (e o mesmo tempo) de senha errada;
// - aluno sem e-mail (D23): o cadastro ganha o endereço interno estável
//   'aluno-<id>@sem-email.invalid' (.invalid nunca resolve, RFC 2606) e semEmail: true. O
//   endereço interno nunca aparece: publicStudentEmail(aluno) no servidor e
//   displayEmail/isPlaceholderEmail de web/src/lib/studentProfile.js na tela mostram
//   'sem e-mail'.
//
// Puro (sem database.js): o registro de migrações o carrega também na backup-cli.
const crypto = require('crypto');
const { normalizeEmail, isAnonymizedStudent } = require('./students.js');
const studentData = require('./studentDataHandlers.js');

const STUDENT_ID_PREFIX = 'alu_';
const STUDENT_ID_PATTERN = /^alu_[0-9a-f]{16}$/;
const PLACEHOLDER_DOMAIN = 'sem-email.invalid';
const PLACEHOLDER_PATTERN = /@sem-email\.invalid$/i;
// Endereço interno dentro de um texto (auditoria, CSV montado à mão): o que vem antes do @
// até um separador.
const PLACEHOLDER_IN_TEXT = /[^\s@;,"'<>()[\]{}]+@sem-email\.invalid\b/gi;
const NO_EMAIL_LABEL = 'sem e-mail';

function list(value) {
    return Array.isArray(value) ? value : [];
}

// ------------------------------------------------------------ id
function isStudentId(value) {
    return typeof value === 'string' && STUDENT_ID_PATTERN.test(value);
}

// Id que conta como dado: só o formato do contrato ('alu_' + 16 hex minúsculos). Id fora
// dele (banco editado à mão, 'foo', 'alu_ZZZ', número) é trocado por um novo, porque a
// tela abre a ficha pelo id (/diretorio/:id reconhece só esse formato); os registros das
// coleções novas que apontavam para o id velho são religados pelo e-mail na mesma passada.
function hasStoredId(student) {
    return !!student && isStudentId(student.id);
}

function newStudentId(taken = new Set()) {
    for (let round = 0; round < 64; round += 1) {
        const id = STUDENT_ID_PREFIX + crypto.randomBytes(8).toString('hex');
        if (!taken.has(id)) return id;
    }
    throw new Error('Não foi possível gerar um identificador de aluno único.');
}

function takenIds(memory) {
    return new Set(list(memory && memory.students).filter(hasStoredId).map(student => student.id));
}

// Dá id ao cadastro novo antes de ele entrar na lista (criação pelo painel, autocadastro,
// semente da demonstração, curso desarquivado). Não troca um id que já existe e não esteja
// em uso por outro aluno. Devolve o id.
function assignStudentId(memory, student) {
    if (!student || typeof student !== 'object') return null;
    const taken = takenIds(memory);
    const own = list(memory && memory.students).includes(student);
    if (hasStoredId(student) && (own || !taken.has(student.id))) return student.id;
    student.id = newStudentId(taken);
    return student.id;
}

// Mapa e-mail (minúsculo) -> id dos alunos de agora.
function studentIdsByEmail(memory) {
    const ids = new Map();
    list(memory && memory.students).forEach(student => {
        if (!hasStoredId(student)) return;
        const email = normalizeEmail(student.email);
        if (email && !ids.has(email)) ids.set(email, student.id);
    });
    return ids;
}

function previousIdsMap(value) {
    if (value instanceof Map) return value;
    const map = new Map();
    if (value && typeof value === 'object') {
        Object.entries(value).forEach(([email, id]) => map.set(normalizeEmail(email), id));
    }
    return map;
}

// Garante students[].id em todo aluno (inclusive anonimizado), idempotente. ctx (o da
// migração): { previousStudentIds } — Map e-mail -> id de antes da restauração (vazio no
// boot). Ordem para quem não tem id: o id que o mesmo e-mail tinha antes (se ninguém mais
// o usa), senão um novo. Id repetido entre dois cadastros (banco editado à mão): o
// primeiro fica e os outros ganham id novo, para o backup seguinte não ser recusado pela
// unicidade de students.id. Id fora do formato 'alu_' + 16 hex também é trocado. Depois religa pelo e-mail os registros das coleções novas
// (handler.relink). Devolve true se mudou alguma coisa.
function ensureStudentIds(memory, ctx = {}) {
    if (!memory || !Array.isArray(memory.students)) return false;
    const previous = previousIdsMap(ctx && ctx.previousStudentIds);
    const taken = new Set();
    const missing = [];
    let changed = false;
    memory.students.forEach(student => {
        if (!student || typeof student !== 'object') return;
        if (hasStoredId(student) && !taken.has(student.id)) {
            taken.add(student.id);
            return;
        }
        missing.push(student);
    });
    // Os ids que o backup não traz voltam primeiro (o de antes do mesmo e-mail), para um
    // aluno novo não pegar por acaso o id que outro já tinha.
    const reserved = new Set([...taken]);
    missing.forEach(student => {
        const prior = previous.get(normalizeEmail(student.email));
        if (isStudentId(prior) && !reserved.has(prior)) {
            student.id = prior;
            reserved.add(prior);
            changed = true;
        }
    });
    missing.forEach(student => {
        if (hasStoredId(student) && reserved.has(student.id) && !taken.has(student.id)) {
            taken.add(student.id);
            return;
        }
        const id = newStudentId(new Set([...reserved, ...previous.values()]));
        student.id = id;
        reserved.add(id);
        taken.add(id);
        changed = true;
    });
    if (studentData.relinkStudentData(memory, studentIdsByEmail(memory))) changed = true;
    return changed;
}

// O código de que o efeito de ensureStudentIds depende, na ordem: entra no hash da migração
// '2026-11-p4-ids-alunos' (migrationHash, dependencias), que é imutável depois de
// publicada. O teste de imutabilidade confere que toda função deste módulo chamada por
// ensureStudentIds (direta ou indiretamente) e toda constante usada estão aqui. O
// handler.relink de cada coleção fica de fora de propósito: coleção nova registra o seu.
const ENSURE_STUDENT_IDS_DEPENDENCIES = Object.freeze([
    ensureStudentIds,
    list,
    isStudentId,
    hasStoredId,
    newStudentId,
    previousIdsMap,
    studentIdsByEmail,
    Object.freeze({ STUDENT_ID_PREFIX, STUDENT_ID_PATTERN }),
    normalizeEmail,
    studentData.relinkStudentData,
]);

// ------------------------------------------------------------ busca
function findStudentById(memory, id) {
    const wanted = typeof id === 'string' ? id.trim() : '';
    if (!wanted) return null;
    return list(memory && memory.students).find(student => student && student.id === wanted) || null;
}

function findStudentByEmail(memory, email) {
    const wanted = normalizeEmail(email);
    if (!wanted) return null;
    return list(memory && memory.students).find(student => student && normalizeEmail(student.email) === wanted) || null;
}

// ------------------------------------------------------------ matrícula
// Matrícula como o login a compara: sem espaços e em minúsculas.
function normalizeMatricula(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, '').toLowerCase();
}

// Cadastros que entram no login por matrícula: com matrícula e não anonimizados.
function matriculaCandidates(memory) {
    return list(memory && memory.students).filter(student => student && !isAnonymizedStudent(student) && normalizeMatricula(student.matricula));
}

// Mapa matrícula normalizada -> cadastros com ela.
function matriculaIndex(memory) {
    const index = new Map();
    matriculaCandidates(memory).forEach(student => {
        const key = normalizeMatricula(student.matricula);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(student);
    });
    return index;
}

// Matrículas repetidas (dados antigos, de antes da checagem): o login por matrícula fica
// indisponível para esses cadastros e o Diretório avisa. Devolve Set de matrículas
// normalizadas.
function duplicateMatriculas(memory) {
    const out = new Set();
    matriculaIndex(memory).forEach((students, key) => { if (students.length > 1) out.add(key); });
    return out;
}

// O texto do campo 'E-mail ou matrícula' vira o e-mail que o attemptPasswordLogin confere.
// - com '@': é o e-mail (como sempre foi);
// - sem '@': a matrícula. Uma conta só com ela: o e-mail dela. Nenhuma ou mais de uma: o
//   próprio texto (nenhuma conta tem esse e-mail; o login dá o mesmo erro e gasta o mesmo
//   tempo da senha errada, sem dizer quais matrículas existem).
// Devolve { login, via: 'email' | 'matricula', student (ou null) }.
function resolveStudentLogin(memory, text) {
    const raw = String(text === undefined || text === null ? '' : text).trim();
    if (!raw || raw.includes('@')) return { login: raw, via: 'email', student: null };
    const key = normalizeMatricula(raw);
    const found = key ? (matriculaIndex(memory).get(key) || []) : [];
    if (found.length === 1 && normalizeEmail(found[0].email)) {
        return { login: normalizeEmail(found[0].email), via: 'matricula', student: found[0] };
    }
    return { login: raw, via: 'matricula', student: null };
}

// ------------------------------------------------------------ aluno sem e-mail
function placeholderEmail(id) {
    const value = String(id || '').trim().toLowerCase();
    if (!value) throw new TypeError('placeholderEmail: o aluno precisa de id.');
    return `aluno-${value}@${PLACEHOLDER_DOMAIN}`;
}

function isPlaceholderEmail(value) {
    return typeof value === 'string' && PLACEHOLDER_PATTERN.test(value.trim());
}

function hasPlaceholderEmail(student) {
    return !!student && isPlaceholderEmail(student.email);
}

// O e-mail que pode aparecer na tela, no CSV, no boletim e em Meus dados: o endereço
// interno vira 'sem e-mail'. Aceita o cadastro ou o próprio e-mail.
function publicStudentEmail(studentOrEmail) {
    const email = typeof studentOrEmail === 'string'
        ? studentOrEmail
        : (studentOrEmail && typeof studentOrEmail === 'object' ? studentOrEmail.email : '');
    if (isPlaceholderEmail(email)) return NO_EMAIL_LABEL;
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Troca o endereço interno por 'sem e-mail' dentro de um texto livre (linhas de auditoria,
// células de CSV).
function maskPlaceholderEmails(text) {
    if (typeof text !== 'string' || !text.toLowerCase().includes(`@${PLACEHOLDER_DOMAIN}`)) return text;
    return text.replace(PLACEHOLDER_IN_TEXT, NO_EMAIL_LABEL);
}

// Cópia com todo texto mascarado (Meus dados, respostas montadas para impressão). Chave de
// objeto que é o endereço interno também vira 'sem e-mail'.
function maskPlaceholderEmailsDeep(value, depth = 0) {
    if (typeof value === 'string') return maskPlaceholderEmails(value);
    if (!value || typeof value !== 'object' || depth > 40) return value;
    if (Array.isArray(value)) return value.map(item => maskPlaceholderEmailsDeep(item, depth + 1));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
    const out = {};
    Object.keys(value).forEach(key => { out[maskPlaceholderEmails(key)] = maskPlaceholderEmailsDeep(value[key], depth + 1); });
    return out;
}

module.exports = {
    STUDENT_ID_PATTERN,
    ENSURE_STUDENT_IDS_DEPENDENCIES,
    PLACEHOLDER_DOMAIN,
    NO_EMAIL_LABEL,
    isStudentId,
    newStudentId,
    assignStudentId,
    studentIdsByEmail,
    ensureStudentIds,
    findStudentById,
    findStudentByEmail,
    normalizeMatricula,
    matriculaIndex,
    duplicateMatriculas,
    resolveStudentLogin,
    placeholderEmail,
    isPlaceholderEmail,
    hasPlaceholderEmail,
    publicStudentEmail,
    maskPlaceholderEmails,
    maskPlaceholderEmailsDeep,
};
