// Motor de gravação do banco (fase 2, H1-a: DES-01, CONF-04, CONF-05).
//
// O banco continua em memória (db.memory) e cada tabela do SQLite guarda uma linha por
// chave (key TEXT PRIMARY KEY, value JSON). Este módulo leva a memória para o disco:
// - lastWritten guarda, por tabela, o JSON de cada linha como está no disco. No boot ele
//   é semeado com o que foi lido (database.js), então a primeira gravação escreve só o
//   que mudou. Linha com JSON ilegível não entra no mapa e por isso nunca é apagada; se
//   a memória ganhar um valor com a mesma chave (o padrão de um singleton como config,
//   ou um aluno que volta a gravar a nota), a linha ilegível é copiada antes, na mesma
//   transação, para a chave '<chave>.ilegivel-<data>', que fica no arquivo.
// - Uma gravação por vez (ciclo), agendada com setImmediate, sem a espera fixa de 250 ms
//   de antes. Pedidos feitos durante um ciclo se juntam no seguinte.
// - O plano (texto de cada linha e comparação) é feito de uma vez no início do ciclo,
//   uma foto consistente da memória. Depois: BEGIN IMMEDIATE, os statements (cada run
//   com callback), o finalize de cada um e só então COMMIT, ou ROLLBACK se algo falhou.
//   lastWritten só muda depois do COMMIT; num ROLLBACK o disco continua igual a ele e as
//   coleções do ciclo voltam para a fila (regravação em segundo plano).
// - Falha vira DbWriteError (code 'ICLASS_DB_WRITE'), que a rota responde com 503
//   retryable (middlewares.js e utils/persistenceContext.js).
//
// Formas de pedir (db.save em database.js):
// - save() sem argumento: gravação completa, compara todas as coleções.
// - save({ only, changed, detached }): parcial. Só as rotas anotadas pelo H1-c usam.
//   Coleção sem `append` em only: compara a coleção inteira. Coleção com `append` em
//   only: grava só as chaves novas e apaga as que sumiram; linha que já existia só é
//   comparada se a chave estiver em changed. Coleção em changed entra em only.
//   Singletons (config, branding, courseStructure) só entram quando listados.
const { performance } = require('node:perf_hooks');

const DB_WRITE_CODE = 'ICLASS_DB_WRITE';
// Texto da resposta 503 (contrato da fase 2): o cliente mantém a sessão e tenta de novo.
const DB_WRITE_ERROR_MESSAGE = 'Não foi possível gravar os dados agora. Tente de novo em alguns segundos.';

// Regravação em segundo plano depois de uma falha: 2 s, 5 s, 10 s e, a partir daí, a
// cada 30 s até conseguir.
const RETRY_DELAYS_MS = [2000, 5000, 10000, 30000];
// Erro que não é trava (disco, arquivo preso por outro programa): uma nova tentativa
// depois de 500 ms antes de desistir do ciclo.
const IMMEDIATE_RETRY_MS = 500;
// Espera pela trava contada por pedido: quem já esperou um ciclo que falhou (ou um ciclo
// longo) não espera o busy_timeout inteiro de novo no ciclo seguinte. Antes, o pedido
// que chegava durante um ciclo travado recebia o 503 só depois de 2 x busy_timeout (10 s).
// Abaixo de 250 ms de espera o ciclo usa o busy_timeout inteiro; o mínimo é 100 ms.
const LOCK_WAIT_ADJUST_FROM_MS = 250;
const MIN_CYCLE_BUSY_MS = 100;
const COMMIT_SAMPLES = 200;
// No máximo uma linha por minuto no crash.log, para uma trava longa não encher o arquivo.
const CRASH_LOG_INTERVAL_MS = 60000;

// Tipos do registro que ficam na memória (db.memory[coleção]) e passam pelo diff.
const MEMORY_KINDS = new Set(['array', 'object', 'singleton']);
const DIFF_KINDS = new Set(['array', 'object', 'singleton', 'derived']);

class DbWriteError extends Error {
    constructor(message, { sqliteCode = null, cause } = {}) {
        super(message);
        this.name = 'DbWriteError';
        this.code = DB_WRITE_CODE;
        this.sqliteCode = sqliteCode;
        if (cause) this.cause = cause;
    }
}

function toDbWriteError(err) {
    if (err instanceof DbWriteError) return err;
    const sqliteCode = (err && err.code) || 'ERRO';
    const message = String((err && err.message) || err || 'falha desconhecida');
    // O código fica em sqliteCode (e a mensagem do SQLite já começa por ele).
    return new DbWriteError(`Falha ao gravar no banco: ${message}`, { sqliteCode, cause: err });
}

function isBusyError(err) {
    const code = err && err.code;
    return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

function isNoTransactionError(err) {
    return /no transaction is active/i.test(String((err && err.message) || ''));
}

function emptyScope() {
    return { full: false, only: new Set(), changed: new Map() };
}

function fullScope() {
    return { full: true, only: new Set(), changed: new Map() };
}

function mergeScope(target, source) {
    if (!source) return target;
    if (source.full) target.full = true;
    source.only.forEach(collection => target.only.add(collection));
    source.changed.forEach((keys, collection) => {
        let set = target.changed.get(collection);
        if (!set) {
            set = new Set();
            target.changed.set(collection, set);
        }
        keys.forEach(key => set.add(key));
    });
    return target;
}

function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return Math.round(sorted[index] * 10) / 10;
}

// Chave da linha de um item de coleção em lista. Item sem chave NUNCA é descartado (era
// isso que apagava notas: entregas sem 'id' eram puladas): ganha uma chave estável,
// gravada de volta no objeto quando a chave é um campo. `mutate: false` (verificador)
// só lê.
function arrayRowKey(entry, item, index, { mutate = true } = {}) {
    let keyValue = typeof entry.key === 'function' ? entry.key(item) : item[entry.key];
    if (keyValue === undefined || keyValue === null || keyValue === '') {
        if (!mutate) return `#${index}`;
        keyValue = `${entry.table}_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
        if (typeof entry.key === 'string') { try { item[entry.key] = keyValue; } catch (e) { /* objeto congelado */ } }
    }
    return String(keyValue);
}

function stringifyValue(value) {
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
}

// Todas as linhas de uma coleção como estão na memória: Map(chave -> JSON).
function collectionRows(entry, memory, options) {
    const rows = new Map();
    const value = memory[entry.collection];
    if (entry.kind === 'array') {
        (Array.isArray(value) ? value : []).forEach((item, index) => {
            if (!item) return;
            rows.set(arrayRowKey(entry, item, index, options), stringifyValue(item));
        });
    } else if (entry.kind === 'object') {
        const object = value && typeof value === 'object' ? value : {};
        for (const key in object) rows.set(String(key), stringifyValue(object[key]));
    } else if (entry.kind === 'singleton') {
        rows.set(String(entry.key), stringifyValue(value));
    } else if (entry.kind === 'derived' && typeof entry.rows === 'function') {
        for (const [key, row] of entry.rows(memory) || []) rows.set(String(key), stringifyValue(row));
    }
    return rows;
}

// Chave em que a linha ilegível fica guardada quando a memória ganha um valor com a
// mesma chave: '<chave>.ilegivel-2026-11-09T22-45-00-123Z'.
function unreadableCopyKey(key, stamp) {
    return `${key}.ilegivel-${stamp}`;
}

// createDbWriter({ connection, tables, getMemory, ready, beforeCycle, logFailure, busyTimeoutMs })
// - connection: sqlite3.Database;
// - tables: o registro COLLECTION_TABLES (database.js);
// - getMemory(): db.memory;
// - ready(): promessa das PRAGMAs e das tabelas, esperada antes do primeiro ciclo;
// - beforeCycle(): sincronizações que rodam no início de todo ciclo; devolve true se
//   mudaram 'admins';
// - logFailure(err, info): registro da falha (crash.log), no máximo uma vez por minuto;
// - busyTimeoutMs(): o busy_timeout da conexão (PRAGMA), para limitar a espera de cada
//   pedido pela trava a cerca de um busy_timeout.
function createDbWriter({ connection, tables, getMemory, ready = () => Promise.resolve(), beforeCycle = () => false, logFailure = () => {}, busyTimeoutMs = () => null }) {
    const entries = tables.filter(entry => DIFF_KINDS.has(entry.kind));
    const byCollection = new Map(tables.map(entry => [entry.collection, entry]));
    const lastWritten = new Map();
    // Por tabela, as chaves das linhas do disco com JSON ilegível (fora de lastWritten).
    const unreadableKeys = new Map();

    let pendingScope = null;
    let pendingWaiters = [];
    let running = false;
    let scheduled = false;
    let requestSeq = 0;
    let processedSeq = 0;
    const exclusiveQueue = [];
    const flushWaiters = [];
    let closed = false;
    let closePromise = null;

    let retryScope = null;
    let retryAttempt = 0;
    let retryTimer = null;
    let nextRetryAt = null;
    let lastWriteError = null;
    let lastFailureLogAt = 0;

    const commitSamples = [];
    let lastFullSaveAt = null;
    let lastFullSaveMs = null;
    let lastCycle = null;
    let cycles = 0;

    function exec(sql) {
        return new Promise((resolve, reject) => connection.exec(sql, err => (err ? reject(err) : resolve())));
    }

    async function rollbackQuietly() {
        try {
            await exec('ROLLBACK');
        } catch (err) {
            if (!isNoTransactionError(err)) console.error(`⚠️ [GRAVAÇÃO] ROLLBACK falhou: ${err.message || err}`);
        }
    }

    // Roda um statement preparado para cada linha e espera o finalize. Devolve o
    // primeiro erro (ou null): cada run tem callback, então nada vira evento 'error'.
    function runStatement(sql, rows) {
        return new Promise(resolve => {
            let firstError = null;
            const keep = err => { if (err && !firstError) firstError = err; };
            const statement = connection.prepare(sql, keep);
            rows.forEach(params => statement.run(params, keep));
            statement.finalize(err => resolve(firstError || err || null));
        });
    }

    function tableMap(table) {
        let map = lastWritten.get(table);
        if (!map) {
            map = new Map();
            lastWritten.set(table, map);
        }
        return map;
    }

    // Plano de uma coleção comparada inteira (gravação completa ou coleção sem append).
    function planWhole(entry, memory) {
        const previous = lastWritten.get(entry.table) || new Map();
        const next = collectionRows(entry, memory);
        const deletes = [];
        previous.forEach((_, key) => { if (!next.has(key)) deletes.push([key]); });
        const upserts = [];
        next.forEach((json, key) => { if (previous.get(key) !== json) upserts.push([key, json]); });
        return { entry, deletes, upserts, apply: () => lastWritten.set(entry.table, next) };
    }

    // Plano de coleção com append numa gravação parcial: só as chaves novas viram texto;
    // linha antiga só é comparada se a chave estiver em changed. A procura de remoções só
    // roda quando o número de chaves que casaram difere do tamanho anterior.
    function planAppend(entry, memory, changedKeys) {
        const previous = lastWritten.get(entry.table) || new Map();
        const items = Array.isArray(memory[entry.collection]) ? memory[entry.collection] : [];
        const matched = new Set();
        const present = new Map();
        const upserts = [];
        items.forEach((item, index) => {
            if (!item) return;
            const key = arrayRowKey(entry, item, index);
            if (previous.has(key)) {
                matched.add(key);
                if (changedKeys && changedKeys.has(key)) {
                    const json = stringifyValue(item);
                    if (json !== previous.get(key)) present.set(key, json);
                }
                return;
            }
            // Duas linhas novas com a mesma chave: vale a última, como na completa.
            present.set(key, stringifyValue(item));
        });
        present.forEach((json, key) => upserts.push([key, json]));
        const deletes = [];
        if (matched.size !== previous.size) {
            previous.forEach((_, key) => { if (!matched.has(key)) deletes.push([key]); });
        }
        return {
            entry,
            deletes,
            upserts,
            apply: () => {
                const map = tableMap(entry.table);
                deletes.forEach(([key]) => map.delete(key));
                upserts.forEach(([key, json]) => map.set(key, json));
            },
        };
    }

    function buildPlan(scope) {
        const memory = getMemory();
        const selected = scope.full
            ? entries
            : entries.filter(entry => scope.only.has(entry.collection) || scope.changed.has(entry.collection));
        return selected.map(entry => (!scope.full && entry.append && entry.kind === 'array'
            ? planAppend(entry, memory, scope.changed.get(entry.collection))
            : planWhole(entry, memory)));
    }

    // busy_timeout deste ciclo: o que falta do busy_timeout para o pedido que espera há
    // mais tempo (waitingSince), no mínimo 100 ms. null = o da conexão, sem mudar.
    function cycleBusyTimeout(waitingSince) {
        const full = Number(busyTimeoutMs());
        if (!Number.isFinite(full) || full <= 0 || !Number.isFinite(waitingSince)) return null;
        const waited = Date.now() - waitingSince;
        if (waited < LOCK_WAIT_ADJUST_FROM_MS) return null;
        const remaining = Math.max(Math.min(MIN_CYCLE_BUSY_MS, full), Math.round(full - waited));
        return remaining < full ? remaining : null;
    }

    // BEGIN IMMEDIATE com o busy_timeout do ciclo; a conexão volta ao valor normal logo
    // depois (a trava só é pedida no BEGIN, então só ele usa o valor encurtado).
    async function beginImmediate(waitingSince) {
        const shortened = cycleBusyTimeout(waitingSince);
        if (shortened === null) return exec('BEGIN IMMEDIATE');
        await exec(`PRAGMA busy_timeout = ${shortened}`);
        try {
            await exec('BEGIN IMMEDIATE');
        } finally {
            await exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs())}`).catch(err => {
                console.error(`⚠️ [GRAVAÇÃO] não foi possível restaurar o busy_timeout: ${(err && err.message) || err}`);
            });
        }
    }

    // Linhas ilegíveis do disco que este plano vai sobrescrever: [chave da cópia, chave].
    function unreadableToKeep(item, stamp) {
        const keys = unreadableKeys.get(item.entry.table);
        if (!keys || !keys.size) return [];
        return item.upserts.filter(([key]) => keys.has(key)).map(([key]) => [unreadableCopyKey(key, stamp), key]);
    }

    // Uma tentativa do ciclo. Devolve null (COMMIT feito) ou o erro (ROLLBACK feito).
    async function attemptCycle(scope, waitingSince = Infinity) {
        let plan;
        try {
            if (beforeCycle() && !scope.full) scope.only.add('admins');
            plan = buildPlan(scope);
        } catch (err) {
            return err;
        }
        const tablesWithRows = plan.filter(item => item.deletes.length || item.upserts.length);
        const rows = tablesWithRows.reduce((total, item) => total + item.deletes.length + item.upserts.length, 0);
        const started = performance.now();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const kept = [];
        if (tablesWithRows.length) {
            try {
                await beginImmediate(waitingSince);
            } catch (err) {
                await rollbackQuietly();
                return err;
            }
            let failure = null;
            for (const item of tablesWithRows) {
                if (item.deletes.length) failure = await runStatement(`DELETE FROM ${item.entry.table} WHERE key = ?`, item.deletes);
                // Linha ilegível que ia ser sobrescrita (o padrão de um singleton, uma chave
                // que volta a ser usada): o texto original fica numa chave própria.
                const keep = failure ? [] : unreadableToKeep(item, stamp);
                if (keep.length) {
                    failure = await runStatement(`INSERT OR IGNORE INTO ${item.entry.table} (key, value) SELECT ?, value FROM ${item.entry.table} WHERE key = ?`, keep);
                    if (!failure) keep.forEach(([copyKey, key]) => kept.push({ table: item.entry.table, key, copyKey }));
                }
                // UPSERT atualiza a linha no lugar (mantém o rowid): a ordem das linhas no
                // arquivo, que é a ordem da coleção no próximo boot, não muda quando uma
                // linha antiga é alterada (INSERT OR REPLACE a levava para o fim).
                if (!failure && item.upserts.length) failure = await runStatement(`INSERT INTO ${item.entry.table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, item.upserts);
                if (failure) break;
            }
            if (!failure) {
                try { await exec('COMMIT'); } catch (err) { failure = err; }
            }
            if (failure) {
                await rollbackQuietly();
                return failure;
            }
        }
        plan.forEach(item => item.apply());
        kept.forEach(({ table, key, copyKey }) => {
            const keys = unreadableKeys.get(table);
            if (keys) keys.delete(key);
            console.warn(`⚠️ [GRAVAÇÃO] A linha ilegível "${key}" da tabela ${table} foi guardada no arquivo como "${copyKey}" antes de receber o valor novo.`);
        });
        const elapsed = performance.now() - started;
        cycles += 1;
        lastCycle = { at: new Date().toISOString(), full: scope.full, rows, ms: Math.round(elapsed * 10) / 10 };
        if (tablesWithRows.length) {
            commitSamples.push(elapsed);
            if (commitSamples.length > COMMIT_SAMPLES) commitSamples.shift();
        }
        if (scope.full) {
            lastFullSaveAt = lastCycle.at;
            lastFullSaveMs = lastCycle.ms;
        }
        return null;
    }

    function scheduleRetry() {
        if (retryTimer || closed) return;
        const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
        retryAttempt += 1;
        nextRetryAt = Date.now() + delay;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            nextRetryAt = null;
            if (closed || !retryScope) return;
            // Ciclo sem quem espere: o escopo pendente (retryScope) entra no ciclo.
            if (!pendingScope) pendingScope = emptyScope();
            schedule();
        }, delay);
        if (typeof retryTimer.unref === 'function') retryTimer.unref();
    }

    function clearRetry() {
        retryScope = null;
        retryAttempt = 0;
        nextRetryAt = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
    }

    function recordFailure(err, scope) {
        const code = (err && (err.sqliteCode || err.code)) || 'ERRO';
        lastWriteError = { at: new Date().toISOString(), code: String(code), message: String((err && err.message) || err) };
        // As coleções do ciclo que falhou continuam pendentes até um COMMIT dar certo.
        retryScope = mergeScope(retryScope || emptyScope(), scope);
        scheduleRetry();
        const now = Date.now();
        if (now - lastFailureLogAt >= CRASH_LOG_INTERVAL_MS) {
            lastFailureLogAt = now;
            try { logFailure(err, { code: String(code) }); } catch (e) { /* o registro nunca derruba a gravação */ }
        }
    }

    async function runCycle() {
        running = true;
        const scope = mergeScope(mergeScope(emptyScope(), pendingScope), retryScope);
        const waiters = pendingWaiters;
        pendingScope = null;
        pendingWaiters = [];
        const throughSeq = requestSeq;
        // Desde quando o pedido mais antigo do ciclo espera (a regravação de fundo não tem
        // quem espere: usa o busy_timeout inteiro).
        const waitingSince = waiters.reduce((oldest, waiter) => Math.min(oldest, waiter.requestedAt), Infinity);
        let error = null;
        try {
            await ready();
        } catch (err) {
            error = err;
        }
        if (!error) {
            error = await attemptCycle(scope, waitingSince);
            // Trava (SQLITE_BUSY/LOCKED): o SQLite já esperou o busy_timeout, desiste agora.
            // Outro erro: uma nova tentativa depois de 500 ms.
            if (error && !isBusyError(error)) {
                await new Promise(resolve => setTimeout(resolve, IMMEDIATE_RETRY_MS));
                error = await attemptCycle(scope, waitingSince);
            }
        }
        processedSeq = throughSeq;
        if (error) {
            const writeError = toDbWriteError(error);
            recordFailure(writeError, scope);
            waiters.forEach(waiter => waiter.reject(writeError));
        } else {
            lastWriteError = null;
            clearRetry();
            waiters.forEach(waiter => waiter.resolve());
        }
        running = false;
        settleFlushWaiters();
        pump();
    }

    async function runExclusiveJob(job) {
        running = true;
        try {
            await ready();
            job.resolve(await job.fn(connection));
        } catch (err) {
            job.reject(err);
        }
        running = false;
        pump();
    }

    function settleFlushWaiters() {
        for (let index = flushWaiters.length - 1; index >= 0; index -= 1) {
            if (processedSeq >= flushWaiters[index].target) {
                flushWaiters[index].resolve();
                flushWaiters.splice(index, 1);
            }
        }
    }

    function pump() {
        scheduled = false;
        if (running) return;
        // Tarefa exclusiva (VACUUM) roda assim que as gravações pedidas antes dela passaram
        // por um ciclo (ver runExclusive).
        if (exclusiveQueue.length && exclusiveQueue[0].afterSeq <= processedSeq) {
            runExclusiveJob(exclusiveQueue.shift());
            return;
        }
        if (pendingScope) runCycle();
    }

    function schedule() {
        if (scheduled || running) return;
        scheduled = true;
        setImmediate(pump);
    }

    function closedError() {
        return new DbWriteError('Banco fechado: a gravação foi recusada.', { sqliteCode: 'CLOSED' });
    }

    // Pede uma gravação com o escopo dado. A promessa resolve depois do COMMIT do ciclo
    // que a incluir e rejeita com DbWriteError. Ela já sai marcada como tratada: um
    // db.save() sem await que falhe não vira unhandledRejection (a falha vai para o
    // crash.log uma vez por minuto e a rota responde 503 pelo persistenceContext).
    function request(scope) {
        if (closed) {
            const rejected = Promise.reject(closedError());
            rejected.catch(() => {});
            return rejected;
        }
        requestSeq += 1;
        pendingScope = mergeScope(pendingScope || emptyScope(), scope);
        const promise = new Promise((resolve, reject) => pendingWaiters.push({ resolve, reject, requestedAt: Date.now() }));
        promise.catch(() => {});
        schedule();
        return promise;
    }

    // Lê { only, changed } e devolve o escopo. Nome desconhecido lança TypeError na hora.
    function scopeFromOptions(options) {
        if (options === undefined || options === null) return fullScope();
        if (typeof options !== 'object' || Array.isArray(options)) throw new TypeError('db.save: as opções precisam ser um objeto { only, changed, detached }.');
        const { only, changed } = options;
        if (only === undefined && changed === undefined) return fullScope();
        const scope = emptyScope();
        const known = name => {
            const entry = byCollection.get(name);
            if (!entry || !DIFF_KINDS.has(entry.kind)) throw new TypeError(`db.save: coleção desconhecida "${String(name)}".`);
            return entry.collection;
        };
        if (only !== undefined) {
            if (!Array.isArray(only)) throw new TypeError('db.save: "only" precisa ser uma lista de coleções.');
            only.forEach(name => scope.only.add(known(name)));
        }
        if (changed !== undefined) {
            if (!changed || typeof changed !== 'object' || Array.isArray(changed)) throw new TypeError('db.save: "changed" precisa ser um objeto { coleção: [chaves] }.');
            Object.keys(changed).forEach(name => {
                const collection = known(name);
                const keys = changed[name];
                if (!Array.isArray(keys)) throw new TypeError(`db.save: "changed.${collection}" precisa ser uma lista de chaves.`);
                scope.only.add(collection);
                const set = scope.changed.get(collection) || new Set();
                keys.forEach(key => set.add(String(key)));
                scope.changed.set(collection, set);
            });
        }
        return scope;
    }

    // Resolve quando toda gravação pedida até agora terminou (com sucesso ou não).
    function flush() {
        const target = requestSeq;
        if (processedSeq >= target) return Promise.resolve();
        return new Promise(resolve => flushWaiters.push({ target, resolve }));
    }

    // Roda fn(conexão) com a fila parada: nenhum ciclo começa enquanto ela roda. As
    // gravações pedidas antes passam primeiro, num ciclo antes dela; uma gravação pedida
    // depois de runExclusive mas antes de esse ciclo começar vai junto nele (sai antes da
    // tarefa); as pedidas com o ciclo já rodando ou com a tarefa já começada esperam a
    // tarefa terminar. Para VACUUM e VACUUM INTO (fora de transação). fn não pode chamar
    // db.save e esperar (ficaria esperando a si mesma).
    function runExclusive(fn) {
        if (typeof fn !== 'function') return Promise.reject(new TypeError('runExclusive precisa de uma função.'));
        if (closed) return Promise.reject(closedError());
        return new Promise((resolve, reject) => {
            exclusiveQueue.push({ afterSeq: requestSeq, fn, resolve, reject });
            schedule();
        });
    }

    function idle() {
        if (!running && !pendingScope && !exclusiveQueue.length) return Promise.resolve();
        return new Promise(resolve => {
            const check = () => {
                if (!running && !pendingScope && !exclusiveQueue.length) return resolve();
                setTimeout(check, 10);
            };
            check();
        });
    }

    // Gravação completa, espera da fila e fechamento da conexão (o checkpoint aplica e
    // apaga o -wal). Depois disso, todo save rejeita com DbWriteError.
    function close() {
        if (closePromise) return closePromise;
        closePromise = (async () => {
            let saveError = null;
            try { await request(fullScope()); } catch (err) { saveError = err; }
            closed = true;
            clearRetry();
            await idle();
            await new Promise((resolve, reject) => connection.close(err => (err ? reject(err) : resolve())));
            if (saveError) throw saveError;
        })();
        return closePromise;
    }

    // Semeadura do boot: o JSON de cada linha exatamente como foi lido do disco, e as
    // chaves das linhas ilegíveis (ficam fora do mapa; ver unreadableToKeep).
    function seed(table, rows, unreadable = []) {
        lastWritten.set(table, rows instanceof Map ? rows : new Map(rows));
        const keys = new Set([...unreadable].map(key => String(key)));
        if (keys.size) unreadableKeys.set(table, keys);
        else unreadableKeys.delete(table);
    }

    // Foto da memória para o verificador de gravação parcial (só lê): Map(coleção ->
    // Map(chave -> JSON)), de todas as coleções ou só das dadas.
    function snapshotRows(collections = null) {
        const memory = getMemory();
        const snapshot = new Map();
        entries.forEach(entry => {
            if (collections && !collections.has(entry.collection)) return;
            try { snapshot.set(entry.collection, collectionRows(entry, memory, { mutate: false })); } catch (e) { /* sem foto desta coleção */ }
        });
        return snapshot;
    }

    // O que mudou desde a foto e não está coberto pelo escopo parcial: [{ collection, key, existed }].
    function uncoveredChanges(snapshot, scope) {
        if (!snapshot || scope.full) return [];
        const memory = getMemory();
        const problems = [];
        entries.forEach(entry => {
            const before = snapshot.get(entry.collection);
            if (!before) return;
            const listed = scope.only.has(entry.collection) || scope.changed.has(entry.collection);
            if (listed && !(entry.append && entry.kind === 'array')) return;
            const now = collectionRows(entry, memory, { mutate: false });
            const changedKeys = scope.changed.get(entry.collection);
            if (listed) {
                // Coleção com append listada: só as linhas que já existiam e mudaram sem changed.
                before.forEach((json, key) => {
                    if (now.has(key) && now.get(key) !== json && !(changedKeys && changedKeys.has(key))) {
                        problems.push({ collection: entry.collection, key, existed: true });
                    }
                });
                return;
            }
            now.forEach((json, key) => {
                if (before.get(key) !== json) problems.push({ collection: entry.collection, key, existed: before.has(key) });
            });
            before.forEach((_, key) => {
                if (!now.has(key)) problems.push({ collection: entry.collection, key, existed: true });
            });
        });
        return problems;
    }

    function status() {
        return {
            lastFullSaveAt,
            lastFullSaveMs,
            commitP95Ms: percentile(commitSamples, 0.95),
            lastWriteError: lastWriteError ? { ...lastWriteError } : null,
            pendingRetry: !!retryScope,
            nextRetryAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : null,
            cycles,
            lastCycle: lastCycle ? { ...lastCycle } : null,
            queued: !!pendingScope,
            closed,
        };
    }

    return {
        request,
        scopeFromOptions,
        flush,
        runExclusive,
        close,
        seed,
        snapshotRows,
        uncoveredChanges,
        status,
        isClosed: () => closed,
    };
}

module.exports = {
    DB_WRITE_CODE,
    DB_WRITE_ERROR_MESSAGE,
    DbWriteError,
    MEMORY_KINDS,
    createDbWriter,
    emptyScope,
    fullScope,
    isBusyError,
};
