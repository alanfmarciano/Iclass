// Histórico de digitação da prova em tabela própria (fase 2, H1-b: DES-02, CONF-06).
//
// As teclas eram a maior coleção da memória (cerca de 150 mil linhas num ano de 10
// turmas): carregadas inteiras no boot, regravadas no diff de toda gravação e
// percorridas inteiras a cada lote (teto de 20 mil), a cada consulta da digitação ao
// vivo e a cada aluno do Monitor. Agora ficam só na tabela exam_keystroke_events, uma
// linha por evento, com colunas e índices, fora de db.memory. Na memória ficam só os
// contadores por aplicação, prova, aluno e turma (total, suspeitas, última tecla),
// montados no boot com um GROUP BY e atualizados a cada gravação.
//
// Toda escrita (append, deleteRows, deleteWhere, renameEmail, importRows) entra numa
// fila e é feita no próximo ciclo do motor de gravação (utils/dbWriter.js), na mesma
// transação das coleções da memória: a promessa resolve depois do COMMIT e, dentro de um
// pedido, a resposta espera por ela (utils/persistenceContext.js). Num ROLLBACK as
// operações continuam na fila e entram na regravação em segundo plano. Os contadores só
// mudam depois do COMMIT.
//
// O cursor da digitação ao vivo é o row_id (AUTOINCREMENT: nunca reaproveitado, mesmo
// depois de apagar as últimas linhas). O seq do navegador recomeça quando a página
// recarrega e não serve de cursor.
//
// Maiúsculas: a prova e a turma são comparadas sem diferenciar maiúsculas só nas letras
// sem acento (A-Z), igual ao COLLATE NOCASE e ao lower() do SQLite, para os contadores e
// as consultas darem sempre o mesmo resultado. O e-mail é gravado em minúsculas.
const crypto = require('crypto');

// Nome da coleção no registro único de tabelas (database.js) e no backup.
const KEYSTROKE_COLLECTION = 'examKeystrokes';
const KEYSTROKE_TABLE = 'exam_keystroke_events';
// Tabela antiga (chave-valor com o JSON de cada tecla, até a fase 1). Continua sendo
// criada: as linhas que não puderam ser migradas (JSON ilegível) ficam nela, e o código
// anterior continua abrindo o banco.
const LEGACY_KEYSTROKE_TABLE = 'exam_keystrokes';

const KEYSTROKE_SCHEMA = Object.freeze([
    `CREATE TABLE IF NOT EXISTS ${KEYSTROKE_TABLE} (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        student_email TEXT NOT NULL,
        student_class TEXT,
        course_id TEXT,
        exam_key TEXT NOT NULL,
        application_id TEXT,
        attempt_id TEXT,
        seq INTEGER,
        client_ts INTEGER,
        server_ts INTEGER NOT NULL,
        key TEXT,
        code TEXT,
        mods TEXT,
        kind TEXT,
        question TEXT,
        blocked INTEGER NOT NULL DEFAULT 0,
        suspicious INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_keystroke_events_application ON ${KEYSTROKE_TABLE} (application_id, student_email, seq)`,
    `CREATE INDEX IF NOT EXISTS idx_keystroke_events_exam ON ${KEYSTROKE_TABLE} (exam_key COLLATE NOCASE, student_email, seq)`,
    `CREATE TABLE IF NOT EXISTS ${LEGACY_KEYSTROKE_TABLE} (key TEXT PRIMARY KEY, value TEXT)`,
]);

// Teto por aluno e aplicação (ou aluno e prova, sem aplicação): ICLASS_KEYSTROKE_CAP ou
// 20 mil. Quem passa dele perde as teclas mais antigas, no mesmo ciclo da gravação.
const DEFAULT_KEYSTROKE_CAP = 20000;
function configuredKeystrokeCap() {
    const raw = String(process.env.ICLASS_KEYSTROKE_CAP || '').trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 1) return DEFAULT_KEYSTROKE_CAP;
    return Math.min(Math.floor(value), 10000000);
}

// Tamanho máximo de cada campo gravado. A rota log-keystrokes aplica os mesmos cortes
// (key, code, mods, kind e question são os de antes); aqui eles valem de novo para o
// que vier por importRows (backup).
const FIELD_LIMITS = Object.freeze({
    id: 200,
    studentEmail: 320,
    studentClass: 200,
    courseId: 200,
    examKey: 200,
    applicationId: 200,
    attemptId: 200,
    key: 40,
    code: 40,
    mods: 16,
    kind: 24,
    question: 12,
});

const COLUMNS = ['id', 'student_email', 'student_class', 'course_id', 'exam_key', 'application_id', 'attempt_id',
    'seq', 'client_ts', 'server_ts', 'key', 'code', 'mods', 'kind', 'question', 'blocked', 'suspicious'];
const INSERT_SQL = `INSERT OR IGNORE INTO ${KEYSTROKE_TABLE} (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`;
// Lote de parâmetros por consulta (IN (...)): bem abaixo do limite de variáveis do SQLite.
const CHUNK = 500;
const MAX_FILTER_IDS = 30000;

// Contagem por grupo (aplicação, aluno, prova e turma), do arquivo inteiro ou de um aluno
// numa aplicação. O GROUP BY usa lower() do SQLite (só A-Z), igual a asciiLower.
const GROUP_COLUMNS = `application_id, student_email, MIN(exam_key) AS exam_key, MIN(student_class) AS student_class,
    MIN(course_id) AS course_id, COUNT(*) AS total,
    SUM(CASE WHEN suspicious <> 0 OR blocked <> 0 THEN 1 ELSE 0 END) AS suspicious,
    MAX(server_ts) AS last_at, MAX(seq) AS max_seq`;
const GROUP_ALL_SQL = `SELECT ${GROUP_COLUMNS} FROM ${KEYSTROKE_TABLE}
    GROUP BY application_id, student_email, lower(exam_key), lower(COALESCE(student_class, ''))`;
const GROUP_UNIT_SQL = `SELECT ${GROUP_COLUMNS} FROM ${KEYSTROKE_TABLE}
    WHERE application_id IS ? AND student_email = ?
    GROUP BY lower(exam_key), lower(COALESCE(student_class, ''))`;

// Migração da tabela antiga: só as linhas com JSON válido, com e-mail e prova. A chave da
// linha antiga (o id da tecla) vira o id; o e-mail vai em minúsculas.
const LEGACY_MIGRATABLE = `json_valid(value) AND json_type(value) = 'object'
    AND json_type(value, '$.studentEmail') = 'text' AND trim(json_extract(value, '$.studentEmail')) <> ''
    AND json_type(value, '$.examKey') = 'text' AND trim(json_extract(value, '$.examKey')) <> ''`;
function legacySelectSql(source) {
    const text = (field, max) => `substr(CAST(json_extract(value, '$.${field}') AS TEXT), 1, ${max})`;
    const integer = field => `CASE WHEN json_type(value, '$.${field}') IN ('integer', 'real') THEN CAST(json_extract(value, '$.${field}') AS INTEGER) END`;
    const flag = field => `CASE WHEN json_extract(value, '$.${field}') = 1 THEN 1 ELSE 0 END`;
    return `SELECT substr(key, 1, ${FIELD_LIMITS.id}),
        substr(lower(trim(json_extract(value, '$.studentEmail'))), 1, ${FIELD_LIMITS.studentEmail}),
        ${text('studentClass', FIELD_LIMITS.studentClass)},
        ${text('courseId', FIELD_LIMITS.courseId)},
        substr(trim(json_extract(value, '$.examKey')), 1, ${FIELD_LIMITS.examKey}),
        NULLIF(${text('applicationId', FIELD_LIMITS.applicationId)}, ''),
        NULLIF(${text('attemptId', FIELD_LIMITS.attemptId)}, ''),
        ${integer('seq')},
        ${integer('clientTs')},
        COALESCE(${integer('serverTs')}, 0),
        ${text('key', FIELD_LIMITS.key)},
        ${text('code', FIELD_LIMITS.code)},
        ${text('mods', FIELD_LIMITS.mods)},
        ${text('kind', FIELD_LIMITS.kind)},
        ${text('question', FIELD_LIMITS.question)},
        ${flag('blocked')},
        ${flag('suspicious')}
    FROM ${source} WHERE ${LEGACY_MIGRATABLE} ORDER BY rowid`;
}

function asciiLower(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[A-Z]+/g, letters => letters.toLowerCase());
}

function normalizedEmail(value) {
    return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function cleanText(value, max) {
    if (value === undefined || value === null) return null;
    return String(value).slice(0, max);
}

function cleanInteger(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Math.trunc(Number(value));
    return Number.isSafeInteger(number) ? number : null;
}

function cleanFlag(value) {
    return value === true || value === 1 || value === '1' ? 1 : 0;
}

// Tecla no formato da API (o mesmo de antes, quando as teclas ficavam na memória) para a
// linha da tabela. Sem e-mail ou sem prova não é gravada.
function normalizeEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const studentEmail = normalizedEmail(event.studentEmail).slice(0, FIELD_LIMITS.studentEmail);
    const examKey = String(event.examKey === undefined || event.examKey === null ? '' : event.examKey).trim().slice(0, FIELD_LIMITS.examKey);
    if (!studentEmail || !examKey) return null;
    const id = String(event.id === undefined || event.id === null ? '' : event.id).trim().slice(0, FIELD_LIMITS.id) || crypto.randomUUID();
    const optional = (value, max) => (value === undefined || value === null || value === '' ? null : String(value).slice(0, max));
    return {
        id,
        studentEmail,
        studentClass: cleanText(event.studentClass, FIELD_LIMITS.studentClass),
        courseId: cleanText(event.courseId, FIELD_LIMITS.courseId),
        examKey,
        applicationId: optional(event.applicationId, FIELD_LIMITS.applicationId),
        attemptId: optional(event.attemptId, FIELD_LIMITS.attemptId),
        seq: cleanInteger(event.seq),
        clientTs: cleanInteger(event.clientTs),
        serverTs: cleanInteger(event.serverTs) ?? Date.now(),
        key: cleanText(event.key, FIELD_LIMITS.key),
        code: cleanText(event.code, FIELD_LIMITS.code),
        mods: cleanText(event.mods, FIELD_LIMITS.mods),
        kind: cleanText(event.kind, FIELD_LIMITS.kind),
        question: cleanText(event.question, FIELD_LIMITS.question),
        blocked: cleanFlag(event.blocked),
        suspicious: cleanFlag(event.suspicious),
    };
}

function rowParams(row) {
    return [row.id, row.studentEmail, row.studentClass, row.courseId, row.examKey, row.applicationId, row.attemptId,
        row.seq, row.clientTs, row.serverTs, row.key, row.code, row.mods, row.kind, row.question, row.blocked, row.suspicious];
}

// Linha da tabela (ou linha normalizada ainda na fila) no formato da API.
function toEvent(row) {
    if (row.student_email !== undefined) {
        return {
            id: row.id,
            studentEmail: row.student_email,
            studentClass: row.student_class,
            courseId: row.course_id,
            examKey: row.exam_key,
            applicationId: row.application_id,
            attemptId: row.attempt_id,
            seq: row.seq,
            clientTs: row.client_ts,
            serverTs: row.server_ts,
            key: row.key,
            code: row.code,
            mods: row.mods,
            kind: row.kind,
            question: row.question,
            blocked: Number(row.blocked) !== 0,
            suspicious: Number(row.suspicious) !== 0,
        };
    }
    return { ...row, blocked: row.blocked !== 0, suspicious: row.suspicious !== 0 };
}

function chunks(list, size = CHUNK) {
    const out = [];
    for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
    return out;
}

function placeholders(count) {
    return new Array(count).fill('?').join(', ');
}

// Grupo dos contadores: aplicação, prova, aluno e turma.
function counterKey({ applicationId, examKey, studentEmail, studentClass }) {
    return [applicationId || '', asciiLower(examKey), studentEmail, asciiLower(studentClass)].join('\u0000');
}

// Unidade de recontagem: um aluno numa aplicação (ou sem aplicação).
function unitKey(applicationId, studentEmail) {
    return `${applicationId || ''}\u0000${studentEmail}`;
}

// createKeystrokeStore({ connection, requestWrite, runExclusive, flush, cap, log })
// - connection: a mesma sqlite3.Database do motor de gravação;
// - requestWrite(result): pede um ciclo de gravação com esta tabela; devolve a promessa
//   que resolve com result() depois do COMMIT (database.js; dentro de um pedido, a
//   resposta espera por ela);
// - runExclusive(fn): roda fn com a fila de gravação parada (migração, cópia de arquivo);
// - flush(): espera as gravações já pedidas;
// - cap(): teto de teclas por aluno e aplicação (ou prova).
// - trackStatement(run): conta a leitura como "em andamento" até o sqlite responder
//   (database.js; o VACUUM INTO do backup espera essas leituras, decisões §12).
function createKeystrokeStore({ connection, requestWrite, runExclusive, flush = () => Promise.resolve(), cap = configuredKeystrokeCap, log = console, trackStatement = run => run(() => {}) }) {
    // Operações pedidas e ainda sem COMMIT, na ordem em que foram pedidas.
    const queue = [];
    // Contadores: Map(grupo -> { studentEmail, studentClass, courseId, examKey,
    // applicationId, total, suspicious, lastAt, maxSeq }) e, por e-mail, os grupos dele.
    const counters = new Map();
    const byEmail = new Map();
    let countersReady = false;

    function sqlRun(sql, params = []) {
        return new Promise((resolve, reject) => connection.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ changes: this.changes, lastID: this.lastID });
        }));
    }

    function sqlAll(sql, params = []) {
        return new Promise((resolve, reject) => trackStatement(end => connection.all(sql, params, (err, rows) => {
            end();
            return err ? reject(err) : resolve(rows);
        })));
    }

    function sqlGet(sql, params = []) {
        return new Promise((resolve, reject) => trackStatement(end => connection.get(sql, params, (err, row) => {
            end();
            return err ? reject(err) : resolve(row);
        })));
    }

    function sqlExec(sql) {
        return new Promise((resolve, reject) => connection.exec(sql, err => (err ? reject(err) : resolve())));
    }

    async function rollbackQuietly() {
        try { await sqlExec('ROLLBACK'); } catch (e) { /* sem transação aberta */ }
    }

    // Insere as linhas (INSERT OR IGNORE: id repetido ou campo obrigatório vazio nunca
    // derruba o ciclo) e devolve as que entraram, com o row_id.
    function insertRows(rows) {
        return new Promise(resolve => {
            let firstError = null;
            const inserted = [];
            const keep = err => { if (err && !firstError) firstError = err; };
            const statement = connection.prepare(INSERT_SQL, keep);
            rows.forEach(row => statement.run(rowParams(row), function onRun(err) {
                if (err) return keep(err);
                if (this.changes) inserted.push({ ...row, rowId: this.lastID });
                return undefined;
            }));
            statement.finalize(err => resolve({ error: firstError || err || null, inserted }));
        });
    }

    // ---------------------------------------------------------------- contadores

    function indexCounter(key, entry) {
        counters.set(key, entry);
        let keys = byEmail.get(entry.studentEmail);
        if (!keys) {
            keys = new Set();
            byEmail.set(entry.studentEmail, keys);
        }
        keys.add(key);
    }

    function dropCounter(key) {
        const entry = counters.get(key);
        if (!entry) return;
        counters.delete(key);
        const keys = byEmail.get(entry.studentEmail);
        if (keys) {
            keys.delete(key);
            if (!keys.size) byEmail.delete(entry.studentEmail);
        }
    }

    function addEventToCounters(row) {
        const key = counterKey(row);
        let entry = counters.get(key);
        if (!entry) {
            entry = {
                studentEmail: row.studentEmail,
                studentClass: row.studentClass,
                courseId: row.courseId,
                examKey: row.examKey,
                applicationId: row.applicationId || null,
                total: 0,
                suspicious: 0,
                lastAt: null,
                maxSeq: null,
            };
            indexCounter(key, entry);
        }
        entry.total += 1;
        if (row.suspicious || row.blocked) entry.suspicious += 1;
        const at = Number(row.serverTs);
        if (Number.isFinite(at) && (entry.lastAt === null || at > entry.lastAt)) entry.lastAt = at;
        if (row.seq !== null && row.seq !== undefined && (entry.maxSeq === null || row.seq > entry.maxSeq)) entry.maxSeq = row.seq;
    }

    // Linha do GROUP BY para os contadores. Dois grupos do SQLite que caem no mesmo grupo
    // aqui são somados.
    function addGroupToCounters(group) {
        const entry = {
            studentEmail: group.student_email,
            studentClass: group.student_class,
            courseId: group.course_id,
            examKey: group.exam_key,
            applicationId: group.application_id || null,
            total: Number(group.total) || 0,
            suspicious: Number(group.suspicious) || 0,
            lastAt: group.last_at === null || group.last_at === undefined ? null : Number(group.last_at),
            maxSeq: group.max_seq === null || group.max_seq === undefined ? null : Number(group.max_seq),
        };
        if (!entry.total) return;
        const key = counterKey(entry);
        const existing = counters.get(key);
        if (!existing) {
            indexCounter(key, entry);
            return;
        }
        existing.total += entry.total;
        existing.suspicious += entry.suspicious;
        if (entry.lastAt !== null && (existing.lastAt === null || entry.lastAt > existing.lastAt)) existing.lastAt = entry.lastAt;
        if (entry.maxSeq !== null && (existing.maxSeq === null || entry.maxSeq > existing.maxSeq)) existing.maxSeq = entry.maxSeq;
    }

    function replaceAllCounters(groups) {
        counters.clear();
        byEmail.clear();
        groups.forEach(addGroupToCounters);
        countersReady = true;
    }

    function dropUnit(applicationId, studentEmail) {
        const keys = byEmail.get(studentEmail);
        if (!keys) return;
        [...keys].forEach(key => {
            const entry = counters.get(key);
            if (entry && (entry.applicationId || null) === (applicationId || null)) dropCounter(key);
        });
    }

    // Contadores que casam com o filtro (e-mail, prova sem diferenciar maiúsculas e,
    // quando dada, a aplicação).
    function matchingCounters({ email, examKey, applicationId } = {}) {
        const wantedEmail = email === undefined || email === null || email === '' ? null : normalizedEmail(email);
        const wantedExam = examKey === undefined || examKey === null || examKey === '' ? null : asciiLower(String(examKey).trim());
        const wantedApplication = applicationId === undefined || applicationId === null || applicationId === '' ? null : String(applicationId);
        const pool = wantedEmail === null
            ? counters.values()
            : [...(byEmail.get(wantedEmail) || [])].map(key => counters.get(key)).filter(Boolean);
        const out = [];
        for (const entry of pool) {
            if (wantedExam !== null && asciiLower(entry.examKey) !== wantedExam) continue;
            if (wantedApplication !== null && entry.applicationId !== wantedApplication) continue;
            out.push(entry);
        }
        return out;
    }

    // Soma dos contadores gravados (sem a fila) para o teto: aluno e aplicação, ou aluno e
    // prova sem aplicação (todas as aplicações dela, como antes).
    function committedScopeCount(scope) {
        return matchingCounters(scope.applicationId
            ? { email: scope.email, applicationId: scope.applicationId }
            : { email: scope.email, examKey: scope.examKey })
            .reduce((total, entry) => total + entry.total, 0);
    }

    // ---------------------------------------------------------------- ciclo de gravação

    function capScopeOf(row) {
        return row.applicationId
            ? { id: `a\u0000${row.applicationId}\u0000${row.studentEmail}`, email: row.studentEmail, applicationId: row.applicationId }
            : { id: `e\u0000${asciiLower(row.examKey)}\u0000${row.studentEmail}`, email: row.studentEmail, examKey: row.examKey };
    }

    async function addUnitsFrom(effects, sql, params) {
        const rows = await sqlAll(sql, params);
        rows.forEach(row => effects.units.set(unitKey(row.application_id, row.student_email), [row.application_id || null, row.student_email]));
    }

    // Apaga as mais antigas de quem passou do teto (mesmo escopo de antes: aluno e
    // aplicação, ou aluno e prova sem aplicação). Ficam as `limit` mais recentes.
    async function trimScope(scope, limit, effects) {
        if (scope.applicationId) {
            effects.units.set(unitKey(scope.applicationId, scope.email), [scope.applicationId, scope.email]);
            await sqlRun(`DELETE FROM ${KEYSTROKE_TABLE} WHERE row_id IN (
                SELECT row_id FROM ${KEYSTROKE_TABLE} WHERE application_id = ? AND student_email = ?
                ORDER BY server_ts DESC, row_id DESC LIMIT -1 OFFSET ?)`, [scope.applicationId, scope.email, limit]);
            return;
        }
        await addUnitsFrom(effects, `SELECT DISTINCT application_id, student_email FROM ${KEYSTROKE_TABLE}
            WHERE exam_key = ? COLLATE NOCASE AND student_email = ?`, [scope.examKey, scope.email]);
        await sqlRun(`DELETE FROM ${KEYSTROKE_TABLE} WHERE row_id IN (
            SELECT row_id FROM ${KEYSTROKE_TABLE} WHERE exam_key = ? COLLATE NOCASE AND student_email = ?
            ORDER BY server_ts DESC, row_id DESC LIMIT -1 OFFSET ?)`, [scope.examKey, scope.email, limit]);
    }

    async function runInsert(op, effects) {
        const { error, inserted } = await insertRows(op.rows);
        if (error) throw error;
        effects.inserted.push(...inserted);
        effects.results.set(op, { inserted: inserted.length });
        const limit = cap();
        const scopes = new Map();
        inserted.forEach(row => {
            const scope = capScopeOf(row);
            if (!scopes.has(scope.id)) scopes.set(scope.id, scope);
        });
        for (const scope of scopes.values()) {
            const insertedInRun = effects.inserted.reduce((total, row) => total + (capScopeOf(row).id === scope.id ? 1 : 0), 0);
            if (committedScopeCount(scope) + insertedInRun > limit) await trimScope(scope, limit, effects);
        }
    }

    async function runDeleteIds(op, effects) {
        let deleted = 0;
        for (const part of chunks(op.ids)) {
            await addUnitsFrom(effects, `SELECT DISTINCT application_id, student_email FROM ${KEYSTROKE_TABLE} WHERE id IN (${placeholders(part.length)})`, part);
            deleted += (await sqlRun(`DELETE FROM ${KEYSTROKE_TABLE} WHERE id IN (${placeholders(part.length)})`, part)).changes;
        }
        effects.results.set(op, { deleted });
    }

    // Condição de deleteWhere e countWhere: aplicações dadas (withoutApplication = também
    // as teclas sem aplicação) e/ou gravadas antes de `before`.
    function filterCondition(op) {
        const where = [];
        const params = [];
        if (op.applicationIds) {
            const any = [];
            if (op.applicationIds.length) {
                any.push(`application_id IN (${placeholders(op.applicationIds.length)})`);
                params.push(...op.applicationIds);
            }
            if (op.withoutApplication) any.push('application_id IS NULL');
            where.push(any.length > 1 ? `(${any.join(' OR ')})` : any[0]);
        }
        if (op.before !== null) {
            where.push('server_ts < ?');
            params.push(op.before);
        }
        return { condition: where.join(' AND '), params };
    }

    async function runDeleteWhere(op, effects) {
        const { condition, params } = filterCondition(op);
        await addUnitsFrom(effects, `SELECT DISTINCT application_id, student_email FROM ${KEYSTROKE_TABLE} WHERE ${condition}`, params);
        const limited = op.max !== null
            ? `row_id IN (SELECT row_id FROM ${KEYSTROKE_TABLE} WHERE ${condition} ORDER BY server_ts, row_id LIMIT ?)`
            : condition;
        const result = await sqlRun(`DELETE FROM ${KEYSTROKE_TABLE} WHERE ${limited}`, op.max !== null ? [...params, op.max] : params);
        effects.results.set(op, { deleted: result.changes });
    }

    async function runRename(op, effects) {
        const rows = await sqlAll(`SELECT DISTINCT application_id, student_email FROM ${KEYSTROKE_TABLE} WHERE student_email IN (?, ?)`, [op.from, op.to]);
        rows.forEach(row => {
            effects.units.set(unitKey(row.application_id, row.student_email), [row.application_id || null, row.student_email]);
            effects.units.set(unitKey(row.application_id, op.to), [row.application_id || null, op.to]);
        });
        const result = await sqlRun(`UPDATE ${KEYSTROKE_TABLE} SET student_email = ? WHERE student_email = ?`, [op.to, op.from]);
        effects.results.set(op, { renamed: result.changes });
    }

    async function runImport(op, effects) {
        if (op.replace) await sqlRun(`DELETE FROM ${KEYSTROKE_TABLE}`);
        const { error, inserted } = await insertRows(op.rows);
        if (error) throw error;
        effects.all = true;
        effects.results.set(op, { imported: inserted.length });
    }

    const RUNNERS = { insert: runInsert, deleteIds: runDeleteIds, deleteWhere: runDeleteWhere, rename: runRename, import: runImport };

    // Parte desta tabela no ciclo do motor de gravação (utils/dbWriter.js): as operações da
    // fila no momento do plano. run() roda dentro da transação do ciclo (BEGIN IMMEDIATE já
    // feito) e devolve o erro ou null; apply() roda depois do COMMIT. Cada tentativa do
    // ciclo pede um plano novo; num ROLLBACK, nada sai da fila.
    function plan() {
        if (!queue.length) return null;
        const batch = queue.slice();
        let effects = null;
        return {
            rows: batch.reduce((total, op) => total + op.weight, 0),
            async run() {
                effects = { inserted: [], units: new Map(), all: false, results: new Map(), groups: null, unitGroups: [] };
                try {
                    for (const op of batch) await RUNNERS[op.type](op, effects);
                    // Recontagem no fim, quando a transação já tem o estado final.
                    if (effects.all) {
                        effects.groups = await sqlAll(GROUP_ALL_SQL);
                    } else {
                        for (const [applicationId, studentEmail] of effects.units.values()) {
                            effects.unitGroups.push({ applicationId, studentEmail, groups: await sqlAll(GROUP_UNIT_SQL, [applicationId, studentEmail]) });
                        }
                    }
                    return null;
                } catch (err) {
                    return err;
                }
            },
            apply() {
                queue.splice(0, batch.length);
                try {
                    if (effects.all) {
                        replaceAllCounters(effects.groups);
                    } else {
                        effects.inserted.forEach(addEventToCounters);
                        effects.unitGroups.forEach(({ applicationId, studentEmail, groups }) => {
                            dropUnit(applicationId, studentEmail);
                            groups.forEach(addGroupToCounters);
                        });
                    }
                } catch (err) {
                    // Gravado no disco; só os contadores ficaram para trás: refaz pelo arquivo.
                    log.error(`⚠️ [TECLAS] contadores refeitos depois de uma falha: ${(err && err.message) || err}`);
                    loadCounters().catch(() => {});
                }
                batch.forEach(op => { op.result = effects.results.get(op) || {}; });
            },
        };
    }

    function enqueue(op) {
        queue.push(op);
        return requestWrite(() => op.result || {});
    }

    // ---------------------------------------------------------------- boot

    // Contadores pelo arquivo (boot, restauração por cópia).
    async function loadCounters() {
        replaceAllCounters(await sqlAll(GROUP_ALL_SQL));
    }

    // Leva as teclas da tabela antiga para a nova numa transação única, com a fila de
    // gravação parada. Idempotente: a segunda vez não acha nada para migrar. Linhas com
    // JSON ilegível (ou sem e-mail ou prova) ficam na tabela antiga.
    function migrateLegacy() {
        return runExclusive(async () => {
            const pending = (await sqlGet(`SELECT COUNT(*) AS n FROM ${LEGACY_KEYSTROKE_TABLE} WHERE ${LEGACY_MIGRATABLE}`)).n;
            let migrated = 0;
            if (pending > 0) {
                const started = Date.now();
                log.log(`Migrando histórico de digitação (${pending} registros)...`);
                await sqlExec('BEGIN IMMEDIATE');
                try {
                    migrated = (await sqlRun(`INSERT OR IGNORE INTO ${KEYSTROKE_TABLE} (${COLUMNS.join(', ')}) ${legacySelectSql(LEGACY_KEYSTROKE_TABLE)}`)).changes;
                    // Sai da tabela antiga só a linha legível que já está na nova (o id é a
                    // chave antiga, cortada no tamanho do campo).
                    await sqlRun(`DELETE FROM ${LEGACY_KEYSTROKE_TABLE} WHERE ${LEGACY_MIGRATABLE}
                        AND substr(key, 1, ${FIELD_LIMITS.id}) IN (SELECT id FROM ${KEYSTROKE_TABLE})`);
                    await sqlExec('COMMIT');
                } catch (err) {
                    await rollbackQuietly();
                    throw err;
                }
                log.log(`Histórico de digitação migrado (${migrated} registros) em ${((Date.now() - started) / 1000).toFixed(1)} s.`);
            }
            const leftover = (await sqlGet(`SELECT COUNT(*) AS n FROM ${LEGACY_KEYSTROKE_TABLE}`)).n;
            if (leftover > 0) {
                log.warn(`⚠️ ${leftover} registro(s) do histórico de digitação antigo não puderam ser migrados (JSON ilegível ou sem aluno e prova) e continuam na tabela ${LEGACY_KEYSTROKE_TABLE}.`);
            }
            return { migrated, leftover };
        });
    }

    // ---------------------------------------------------------------- API (db.keystrokes)

    // Grava as teclas no próximo ciclo. Resolve com { inserted } depois do COMMIT.
    function append(rows) {
        const normalized = (Array.isArray(rows) ? rows : []).map(normalizeEvent).filter(Boolean);
        if (!normalized.length) return Promise.resolve({ inserted: 0 });
        return enqueue({ type: 'insert', rows: normalized, weight: normalized.length });
    }

    // Teclas de um aluno numa prova (e, quando dada, numa aplicação), em ordem de chegada
    // (row_id). Com `after` (cursor): as primeiras `limit` depois dele, com hasMore. Sem
    // `after`: as últimas `limit` (com sinceSeq, o filtro antigo pelo seq do navegador).
    // total = todas as que casam com aluno, prova, aplicação e sinceSeq.
    async function query({ email, examKey, applicationId, after, sinceSeq, limit } = {}) {
        const wantedEmail = normalizedEmail(email);
        const wantedExam = String(examKey === undefined || examKey === null ? '' : examKey).trim();
        const size = Math.max(1, Math.min(Math.floor(Number(limit)) || 2000, 5000));
        if (!wantedEmail || !wantedExam) return { events: [], total: 0, cursor: 0, hasMore: false };
        const where = ['student_email = ?', 'exam_key = ? COLLATE NOCASE'];
        const params = [wantedEmail, wantedExam];
        if (applicationId !== undefined && applicationId !== null && applicationId !== '') {
            where.push('application_id = ?');
            params.push(String(applicationId));
        }
        const useAfter = after !== undefined && after !== null && after !== '';
        const since = Number(sinceSeq) || 0;
        if (!useAfter && since > 0) {
            where.push('COALESCE(seq, 0) > ?');
            params.push(since);
        }
        const condition = where.join(' AND ');
        const total = (await sqlGet(`SELECT COUNT(*) AS n FROM ${KEYSTROKE_TABLE} WHERE ${condition}`, params)).n;
        if (useAfter) {
            const from = Math.max(0, Math.floor(Number(after)) || 0);
            const rows = await sqlAll(`SELECT * FROM ${KEYSTROKE_TABLE} WHERE ${condition} AND row_id > ? ORDER BY row_id LIMIT ?`, [...params, from, size + 1]);
            const hasMore = rows.length > size;
            const page = hasMore ? rows.slice(0, size) : rows;
            return { events: page.map(toEvent), total, cursor: page.length ? page[page.length - 1].row_id : from, hasMore };
        }
        const rows = (await sqlAll(`SELECT * FROM ${KEYSTROKE_TABLE} WHERE ${condition} ORDER BY row_id DESC LIMIT ?`, [...params, size])).reverse();
        return { events: rows.map(toEvent), total, cursor: rows.length ? rows[rows.length - 1].row_id : 0, hasMore: false };
    }

    // Contadores (síncrono): sem aplicação, soma todas as do mesmo aluno e prova, como o
    // Monitor sempre fez. suspicious conta as suspeitas e as bloqueadas.
    function stats({ email, examKey, applicationId } = {}) {
        let total = 0;
        let suspicious = 0;
        let lastAt = null;
        let maxSeq = null;
        matchingCounters({ email, examKey, applicationId }).forEach(entry => {
            total += entry.total;
            suspicious += entry.suspicious;
            if (entry.lastAt !== null && (lastAt === null || entry.lastAt > lastAt)) lastAt = entry.lastAt;
            if (entry.maxSeq !== null && (maxSeq === null || entry.maxSeq > maxSeq)) maxSeq = entry.maxSeq;
        });
        return { total, suspicious, lastAt: total ? lastAt : null, maxSeq };
    }

    // Cópia dos contadores (todos, ou os que casam com o filtro), para quem soma por
    // escopo próprio (manutenção, Monitor numa passada).
    function statsEntries(filter = {}) {
        return matchingCounters(filter).map(entry => ({ ...entry }));
    }

    // Teclas de qualquer um dos e-mails (gravadas e ainda na fila), para excluir ou
    // anonimizar o aluno.
    async function findByEmails(emails) {
        const wanted = [...new Set((Array.isArray(emails) ? emails : [emails]).map(normalizedEmail).filter(Boolean))];
        if (!wanted.length) return [];
        const found = new Map();
        for (const part of chunks(wanted)) {
            const rows = await sqlAll(`SELECT * FROM ${KEYSTROKE_TABLE} WHERE student_email IN (${placeholders(part.length)}) ORDER BY row_id`, part);
            rows.forEach(row => found.set(row.id, toEvent(row)));
        }
        const set = new Set(wanted);
        queue.forEach(op => {
            if (op.type !== 'insert' && op.type !== 'import') return;
            op.rows.forEach(row => { if (set.has(row.studentEmail) && !found.has(row.id)) found.set(row.id, toEvent(row)); });
        });
        return [...found.values()];
    }

    function uniqueIds(ids) {
        return [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id === undefined || id === null ? '' : id)).filter(Boolean))];
    }

    // Apaga as teclas pelos ids. Resolve com { deleted } depois do COMMIT.
    function deleteRows(ids) {
        const list = uniqueIds(ids);
        if (!list.length) return Promise.resolve({ deleted: 0 });
        return enqueue({ type: 'deleteIds', ids: list, weight: list.length });
    }

    // Filtro de deleteWhere e countWhere, conferido. Em applicationIds, null quer dizer
    // "sem aplicação" (teclas de prova sem aplicação, de antes das aplicações): a
    // retenção do H8b apaga essas pela própria data, junto com as de aplicação que não
    // existe mais.
    function parseFilter(name, { applicationIds, before, max } = {}) {
        const list = applicationIds === undefined || applicationIds === null ? null : (Array.isArray(applicationIds) ? applicationIds : [applicationIds]);
        const ids = list ? uniqueIds(list) : null;
        const withoutApplication = !!list && list.some(id => id === null);
        if (ids && ids.length > MAX_FILTER_IDS) throw new TypeError(`keystrokes.${name}: no máximo ${MAX_FILTER_IDS} aplicações por chamada.`);
        const limitBefore = before === undefined || before === null ? null : Number(before);
        if (limitBefore !== null && !Number.isFinite(limitBefore)) throw new TypeError(`keystrokes.${name}: "before" precisa ser uma data em milissegundos.`);
        const limitMax = max === undefined || max === null ? null : Math.floor(Number(max));
        if (limitMax !== null && !(limitMax >= 0)) throw new TypeError(`keystrokes.${name}: "max" precisa ser um número positivo.`);
        if (!ids && limitBefore === null) throw new TypeError(`keystrokes.${name}: informe applicationIds ou before.`);
        const empty = (!!ids && !ids.length && !withoutApplication) || limitMax === 0;
        return { applicationIds: ids, withoutApplication, before: limitBefore, max: limitMax, empty };
    }

    // Retenção (H8): apaga as teclas das aplicações dadas e/ou gravadas antes de `before`
    // (ms), das mais antigas para as mais novas, no máximo `max`. Sem aplicação e sem
    // data é recusado (nunca apaga tudo por engano). Resolve com { deleted }.
    function deleteWhere(filter = {}) {
        const op = parseFilter('deleteWhere', filter);
        if (op.empty) return Promise.resolve({ deleted: 0 });
        return enqueue({ type: 'deleteWhere', applicationIds: op.applicationIds, withoutApplication: op.withoutApplication, before: op.before, max: op.max, weight: 1 });
    }

    // Quantas teclas gravadas casam com o filtro de deleteWhere (sem max): a prévia da
    // retenção (H8b). Não conta o que ainda está na fila.
    async function countWhere(filter = {}) {
        const op = parseFilter('countWhere', { ...filter, max: null });
        if (op.empty) return 0;
        const { condition, params } = filterCondition(op);
        return Number((await sqlGet(`SELECT COUNT(*) AS n FROM ${KEYSTROKE_TABLE} WHERE ${condition}`, params)).n) || 0;
    }

    // Troca de e-mail do aluno: as teclas acompanham. Resolve com { renamed }.
    function renameEmail(oldEmail, newEmail) {
        const from = normalizedEmail(oldEmail);
        const to = normalizedEmail(newEmail).slice(0, FIELD_LIMITS.studentEmail);
        if (!from || !to || from === to) return Promise.resolve({ renamed: 0 });
        return enqueue({ type: 'rename', from, to, weight: 1 });
    }

    // Todas as teclas no formato da API, em ordem de chegada (backup do H4).
    async function exportRows() {
        await flush();
        const rows = await sqlAll(`SELECT * FROM ${KEYSTROKE_TABLE} ORDER BY row_id`);
        return rows.map(toEvent);
    }

    // Restauração (H4): grava as teclas do backup no próximo ciclo, na mesma transação das
    // coleções. replace: true apaga as atuais antes. Id repetido é ignorado; sem teto.
    // Resolve com { imported }.
    function importRows(rows, { replace = false } = {}) {
        const normalized = (Array.isArray(rows) ? rows : []).map(normalizeEvent).filter(Boolean);
        if (!normalized.length && !replace) return Promise.resolve({ imported: 0 });
        return enqueue({ type: 'import', rows: normalized, replace: replace === true, weight: Math.max(1, normalized.length) });
    }

    // Restauração do ZIP formato 2 (H4): copia as teclas de outro arquivo de banco (a nova
    // tabela e, num banco antigo, as linhas da tabela antiga) com a fila de gravação parada.
    // replace: true apaga as atuais antes. Resolve com { copied }.
    function copyFromAttached(file, { replace = false } = {}) {
        if (typeof file !== 'string' || !file.trim()) return Promise.reject(new TypeError('keystrokes.copyFromAttached: informe o arquivo do banco.'));
        return runExclusive(async () => {
            await sqlRun('ATTACH DATABASE ? AS iclass_origem', [file]);
            let copied = 0;
            try {
                const tables = new Set((await sqlAll("SELECT name FROM iclass_origem.sqlite_master WHERE type = 'table'")).map(row => row.name));
                await sqlExec('BEGIN IMMEDIATE');
                try {
                    if (replace) await sqlRun(`DELETE FROM main.${KEYSTROKE_TABLE}`);
                    if (tables.has(KEYSTROKE_TABLE)) {
                        copied += (await sqlRun(`INSERT OR IGNORE INTO main.${KEYSTROKE_TABLE} (${COLUMNS.join(', ')})
                            SELECT ${COLUMNS.join(', ')} FROM iclass_origem.${KEYSTROKE_TABLE} ORDER BY row_id`)).changes;
                    }
                    if (tables.has(LEGACY_KEYSTROKE_TABLE)) {
                        copied += (await sqlRun(`INSERT OR IGNORE INTO main.${KEYSTROKE_TABLE} (${COLUMNS.join(', ')})
                            ${legacySelectSql(`iclass_origem.${LEGACY_KEYSTROKE_TABLE}`)}`)).changes;
                    }
                    await sqlExec('COMMIT');
                } catch (err) {
                    await rollbackQuietly();
                    throw err;
                }
            } finally {
                await sqlRun('DETACH DATABASE iclass_origem').catch(() => {});
            }
            await loadCounters();
            return { copied };
        });
    }

    // Total de teclas gravadas (cartão Armazenamento).
    function total() {
        let sum = 0;
        counters.forEach(entry => { sum += entry.total; });
        return sum;
    }

    return {
        // motor de gravação e boot (database.js)
        plan,
        migrateLegacy,
        loadCounters,
        isReady: () => countersReady,
        pendingOperations: () => queue.length,
        // API pública: db.keystrokes
        api: Object.freeze({
            append,
            query,
            stats,
            statsEntries,
            findByEmails,
            deleteRows,
            deleteWhere,
            countWhere,
            renameEmail,
            exportRows,
            importRows,
            copyFromAttached,
            total,
        }),
    };
}

module.exports = {
    DEFAULT_KEYSTROKE_CAP,
    FIELD_LIMITS,
    KEYSTROKE_COLLECTION,
    KEYSTROKE_SCHEMA,
    KEYSTROKE_TABLE,
    LEGACY_KEYSTROKE_TABLE,
    asciiLower,
    configuredKeystrokeCap,
    createKeystrokeStore,
    normalizeEvent,
};
