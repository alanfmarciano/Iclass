// O computador não dorme durante a prova (fase 3, A17 / P6-S5; OPS-01, D13 do P6).
//
// No notebook do professor, a suspensão do Windows (30 min sem mexer, na bateria) derruba o
// servidor no meio da prova: os alunos ficam sem resposta até alguém mexer no computador, e
// o tempo parado só volta depois. Enquanto houver aplicação de prova em andamento (sala de
// espera, em andamento ou pausada, a mesma regra do launcher e do backup), o servidor abre
// um PowerShell oculto que pede ao Windows SetThreadExecutionState(ES_CONTINUOUS |
// ES_SYSTEM_REQUIRED), o mesmo pedido que aparece em "powercfg /requests", e encerra esse
// processo quando a última prova termina ou o servidor desliga. Não muda as configurações
// de energia do computador (a tela ainda apaga; só o computador não dorme).
//
// - O PowerShell fica lendo a entrada padrão: quando o servidor fecha a entrada (stop) ou
//   cai de vez (o pipe fecha junto), ele sai, e o Windows esquece o pedido. Nada fica
//   preso no computador depois que o IClass desliga.
// - Fora do Windows não faz nada (o Linux da nuvem e dos testes).
// - Falha ao abrir (PowerShell bloqueado por política, ausente): um aviso no console, e a
//   próxima tentativa só depois de um tempo (RETRY_AFTER_MS), nunca a cada volta do timer.
//
// O servidor chama sync(memory) a cada volta do timer 'exam-deadline-sweep' (10 s) e no
// boot (a primeira varredura), e stop() no desligamento ordenado.
const childProcess = require('child_process');
const path = require('path');

// ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001), em decimal: no PowerShell
// 5.1 o literal 0x80000001 vira um Int32 negativo, que não converte para uint32.
const ES_KEEP_AWAKE = 2147483649;
const ES_CONTINUOUS = 2147483648;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const RESTART_AFTER_EXIT_MS = 60 * 1000;
const STOP_GRACE_MS = 3000;

const POWERSHELL_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace IClass -Name Energia -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    `if ([IClass.Energia]::SetThreadExecutionState([uint32]${ES_KEEP_AWAKE}) -eq 0) { exit 3 }`,
    // Fica aqui (na mesma thread do pedido) até o servidor fechar a entrada.
    'while ($null -ne [Console]::In.ReadLine()) { }',
    `[void][IClass.Energia]::SetThreadExecutionState([uint32]${ES_CONTINUOUS})`,
].join('\n');

function powershellPath(env = process.env) {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// O processo de verdade: PowerShell oculto, com o script em -EncodedCommand (UTF-16LE em
// base64: nenhuma aspa do script passa pelo interpretador de comandos).
function spawnPowerShell({ env = process.env } = {}) {
    const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
    return childProcess.spawn(powershellPath(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
    });
}

// Quantas aplicações estão em andamento agora (sala de espera, em andamento ou pausada).
function activeApplicationCount(memory) {
    const { ACTIVE_APPLICATION_STATUSES } = require('./examApplications.js');
    const list = memory && Array.isArray(memory.examApplications) ? memory.examApplications : [];
    return list.filter(item => item && ACTIVE_APPLICATION_STATUSES.has(item.status)).length;
}

function createKeepAwake({ platform = process.platform, spawn = spawnPowerShell, now = Date.now, log = console } = {}) {
    const state = {
        child: null,
        wanted: false,
        retryAt: 0,
        warned: false,
        startedAt: null,
        lastError: null,
    };

    function onExit(child) {
        if (state.child !== child) return;
        state.child = null;
        state.startedAt = null;
        // Saiu sozinho enquanto ainda havia prova: tenta de novo depois de um tempo.
        if (state.wanted) {
            state.retryAt = now() + RESTART_AFTER_EXIT_MS;
            state.lastError = 'o processo que mantinha o computador acordado saiu sozinho';
        }
    }

    function start() {
        let child;
        try {
            child = spawn();
        } catch (err) {
            child = null;
            state.lastError = (err && err.message) || String(err);
        }
        if (!child) {
            state.retryAt = now() + RETRY_AFTER_MS;
            if (!state.warned) {
                state.warned = true;
                log.warn(`⚠️ Não foi possível impedir o computador de dormir durante a prova (${state.lastError || 'PowerShell indisponível'}). Deixe o notebook na tomada e com a tampa aberta.`);
            }
            return false;
        }
        state.child = child;
        state.startedAt = now();
        state.lastError = null;
        if (typeof child.on === 'function') {
            child.on('error', err => {
                state.lastError = (err && err.message) || String(err);
                if (!state.warned) {
                    state.warned = true;
                    log.warn(`⚠️ Não foi possível impedir o computador de dormir durante a prova (${state.lastError}). Deixe o notebook na tomada e com a tampa aberta.`);
                }
                state.retryAt = now() + RETRY_AFTER_MS;
                onExit(child);
            });
            child.on('exit', () => onExit(child));
        }
        // A entrada fechada do lado de lá (processo que já saiu) não pode derrubar o servidor.
        if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', () => {});
        log.log('☕ Prova em andamento: o computador não vai dormir até ela terminar.');
        return true;
    }

    function release({ quiet = false, immediate = false } = {}) {
        const child = state.child;
        state.child = null;
        state.startedAt = null;
        if (!child) return false;
        try { if (child.stdin && typeof child.stdin.end === 'function') child.stdin.end(); } catch (e) { /* já fechada */ }
        if (immediate) {
            try { child.kill(); } catch (e) { /* já saiu */ }
            return true;
        }
        // Se em alguns segundos o PowerShell não saiu sozinho, encerra.
        const timer = setTimeout(() => {
            try { if (child.exitCode === null || child.exitCode === undefined) child.kill(); } catch (e) { /* já saiu */ }
        }, STOP_GRACE_MS);
        if (typeof timer.unref === 'function') timer.unref();
        if (!quiet) log.log('☕ Nenhuma prova em andamento: o computador já pode dormir de novo.');
        return true;
    }

    // Quantas aplicações estão em andamento agora: abre o pedido na primeira, fecha depois
    // da última. Devolve se o pedido está aberto.
    function update(activeCount) {
        const wanted = Number(activeCount) > 0;
        state.wanted = wanted;
        if (platform !== 'win32') return false;
        if (!wanted) {
            state.warned = false;
            state.retryAt = 0;
            release();
            return false;
        }
        if (state.child) return true;
        if (state.retryAt && now() < state.retryAt) return false;
        return start();
    }

    function sync(memory) {
        return update(activeApplicationCount(memory));
    }

    // Desligamento do servidor: fecha o pedido sem esperar a próxima volta do timer.
    // immediate: na saída do processo, sem esperar o PowerShell sair sozinho.
    function stop({ immediate = false } = {}) {
        state.wanted = false;
        return release({ quiet: true, immediate });
    }

    function status() {
        return {
            suportado: platform === 'win32',
            ativo: !!state.child,
            desde: state.startedAt,
            erro: state.lastError,
        };
    }

    return { update, sync, stop, status };
}

// A instância do servidor. Na saída do processo (inclusive por erro), o PowerShell é
// encerrado na hora; a entrada fechada já bastaria, mas sem esperar.
const keepAwake = createKeepAwake();
process.once('exit', () => {
    try { keepAwake.stop({ immediate: true }); } catch (e) { /* saindo */ }
});

module.exports = {
    ES_CONTINUOUS,
    ES_KEEP_AWAKE,
    POWERSHELL_SCRIPT,
    RESTART_AFTER_EXIT_MS,
    RETRY_AFTER_MS,
    activeApplicationCount,
    createKeepAwake,
    keepAwake,
    powershellPath,
    spawnPowerShell,
};
