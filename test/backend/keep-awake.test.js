// O computador não dorme durante a prova (A17 / P6-S5, OPS-01, D13 do P6). Antes: nada
// impedia o Windows de suspender o notebook do professor no meio da prova (30 min sem
// mexer, na bateria), e o servidor parava para todos os alunos. Agora o servidor abre um
// PowerShell oculto que pede SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
// na primeira aplicação em andamento e fecha o pedido depois da última. Aqui o processo
// é falso (spawn injetado): nenhum PowerShell é aberto.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const keepAwakeModule = require('../../backend/utils/keepAwake.js');
const {
    ES_KEEP_AWAKE,
    ES_CONTINUOUS,
    CONFIRM_TIMEOUT_MS,
    POWERSHELL_SCRIPT,
    RETRY_AFTER_MS,
    RESTART_AFTER_EXIT_MS,
    activeApplicationCount,
    createKeepAwake,
    powershellPath,
    spawnPowerShell,
} = keepAwakeModule;

const REPO = path.resolve(__dirname, '..', '..');

function fakeChild() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.ended = false;
    child.killed = 0;
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    // O PowerShell de verdade escreve "ok" depois que o Windows aceita o pedido.
    child.confirm = () => child.stdout.emit('data', Buffer.from('ok\r\n'));
    child.stdin.end = () => { child.ended = true; };
    child.kill = () => { child.killed += 1; };
    return child;
}

function world({ platform = 'win32', spawn } = {}) {
    const w = { clock: 1_000_000, children: [], warns: [], logs: [] };
    w.spawn = spawn || (() => { const child = fakeChild(); w.children.push(child); return child; });
    w.keep = createKeepAwake({
        platform,
        spawn: () => w.spawn(),
        now: () => w.clock,
        log: { warn: line => w.warns.push(line), log: line => w.logs.push(line) },
    });
    return w;
}

const memoryWith = (...statuses) => ({ examApplications: statuses.map((status, index) => ({ id: `a${index}`, status })) });

test('[UC-INSTALACAO-003] o pedido abre só na primeira prova em andamento e fecha depois da última', () => {
    const w = world();
    assert.equal(w.keep.sync(memoryWith('finished', 'draft')), false);
    assert.equal(w.children.length, 0, 'sem prova em andamento, nada abre');
    assert.equal(w.keep.status().ativo, false);

    assert.equal(w.keep.sync(memoryWith('waiting')), true);
    assert.equal(w.children.length, 1);
    // Aberto, mas o Windows ainda não aceitou: não promete nada.
    assert.equal(w.keep.status().ativo, false);
    assert.equal(w.logs.length, 0);
    w.children[0].confirm();
    assert.equal(w.keep.status().ativo, true);
    assert.equal(w.keep.status().desde, w.clock);
    assert.match(w.logs.at(-1), /o computador não vai dormir até ela terminar/);

    // Mais provas, a mesma prova pausada: o mesmo processo continua (um só pedido).
    for (const memory of [memoryWith('running', 'paused'), memoryWith('paused'), memoryWith('running', 'running', 'finished')]) {
        assert.equal(w.keep.sync(memory), true);
    }
    assert.equal(w.children.length, 1, 'um processo só, aberto uma vez');
    assert.equal(w.children[0].ended, false);

    // A última terminou: a entrada do PowerShell fecha (ele sai e o Windows esquece o pedido).
    assert.equal(w.keep.sync(memoryWith('finished')), false);
    assert.equal(w.children[0].ended, true);
    assert.equal(w.keep.status().ativo, false);
    assert.match(w.logs.at(-1), /o computador já pode dormir de novo/);

    // Nova prova depois: abre de novo.
    assert.equal(w.keep.update(1), true);
    assert.equal(w.children.length, 2);
    w.children[1].confirm();
    // Desligamento do servidor: fecha na hora, sem esperar a próxima volta do timer.
    assert.equal(w.keep.stop({ immediate: true }), true);
    assert.equal(w.children[1].ended, true);
    assert.equal(w.children[1].killed, 1);
    assert.equal(w.keep.status().ativo, false);
    // A saída tardia do processo já encerrado não reabre nada nem muda o estado.
    w.children[1].emit('exit', 0, null);
    assert.equal(w.keep.update(0), false);
    assert.equal(w.children.length, 2);
});

test('[UC-INSTALACAO-003] fora do Windows não faz nada (nuvem, Linux dos testes)', () => {
    const w = world({ platform: 'linux' });
    assert.equal(w.keep.sync(memoryWith('running')), false);
    assert.equal(w.keep.update(3), false);
    assert.equal(w.children.length, 0);
    assert.equal(w.keep.status().suportado, false);
    assert.equal(w.keep.stop(), false);
    // A instância do servidor nos testes (Linux) também nunca abre processo.
    assert.equal(keepAwakeModule.keepAwake.sync(memoryWith('running')), false);
    assert.equal(keepAwakeModule.keepAwake.status().ativo, false);
});

test('[UC-INSTALACAO-003] PowerShell que não abre: um aviso só e nova tentativa depois de 10 min, nunca a cada volta do timer', () => {
    let attempts = 0;
    const w = world({ spawn: () => { attempts += 1; throw new Error('spawn powershell.exe ENOENT'); } });
    assert.equal(w.keep.update(1), false);
    assert.equal(attempts, 1);
    assert.equal(w.warns.length, 1);
    assert.match(w.warns[0], /Não foi possível impedir o computador de dormir durante a prova \(spawn powershell\.exe ENOENT\)\. Deixe o notebook na tomada/);
    assert.equal(w.keep.status().erro, 'spawn powershell.exe ENOENT');
    for (let i = 0; i < 30; i += 1) { w.clock += 10_000; w.keep.update(1); }
    assert.equal(attempts, 1, 'sem nova tentativa antes do prazo');
    w.clock += RETRY_AFTER_MS;
    w.keep.update(1);
    assert.equal(attempts, 2);
    assert.equal(w.warns.length, 1, 'o aviso não se repete');
    // Acabou a prova: na próxima, tenta logo e avisa de novo se falhar.
    w.keep.update(0);
    w.keep.update(1);
    assert.equal(attempts, 3);
    assert.equal(w.warns.length, 2);

    // Erro assíncrono do processo (o 'error' do spawn): mesmo tratamento.
    const w2 = world();
    w2.keep.update(1);
    w2.children[0].emit('error', new Error('acesso negado'));
    assert.equal(w2.keep.status().ativo, false);
    assert.equal(w2.warns.length, 1);
    w2.clock += 10_000;
    w2.keep.update(1);
    assert.equal(w2.children.length, 1);
    w2.clock += RETRY_AFTER_MS;
    w2.keep.update(1);
    assert.equal(w2.children.length, 2);
});

test('[UC-INSTALACAO-003] o processo saiu sozinho com prova em andamento: abre de novo depois de 1 min', () => {
    const w = world();
    w.keep.update(1);
    w.children[0].confirm();
    w.children[0].emit('exit', 1, null);
    assert.equal(w.keep.status().ativo, false);
    assert.match(w.keep.status().erro, /saiu sozinho/);
    w.clock += 10_000;
    w.keep.update(1);
    assert.equal(w.children.length, 1);
    w.clock += RESTART_AFTER_EXIT_MS;
    assert.equal(w.keep.update(1), true);
    assert.equal(w.children.length, 2);
    w.children[1].confirm();
    assert.equal(w.keep.status().ativo, true);
    // O "☕ Prova em andamento" saiu uma vez só nesta prova, não a cada reabertura.
    assert.equal(w.logs.filter(line => /não vai dormir/.test(line)).length, 1);
    assert.equal(w.warns.length, 0);
});

// Rodada de ajuste 1: o PowerShell que abre e sai sem fazer o pedido (Add-Type bloqueado
// pelo AppLocker ou pelo modo de linguagem restrito, SetThreadExecutionState devolvendo 0)
// contava como "saiu sozinho": nova tentativa a cada minuto, nenhum aviso e, a cada
// minuto, "o computador não vai dormir" no console, com o computador podendo dormir.
test('[UC-INSTALACAO-003] PowerShell que abre e sai sem o "ok": conta como falha (um aviso, nova tentativa em 10 min, nada prometido)', () => {
    for (const [code, reason] of [[1, /saiu sem fazer o pedido ao Windows, código 1; ele pode estar bloqueado pela política/], [3, /o Windows recusou o pedido/]]) {
        const w = world();
        for (let tick = 0; tick <= 60; tick += 1) {
            w.keep.update(1);
            const child = w.children.at(-1);
            if (child && child.exitCode === null && !child.done) {
                child.done = true;
                child.exitCode = code;
                child.emit('exit', code, null);
            }
            w.clock += 10_000;
        }
        // 10 min de prova com o timer de 10 s: uma tentativa no começo e outra depois de 10 min.
        assert.equal(w.children.length, 2, `código ${code}`);
        assert.equal(w.warns.length, 1, `código ${code}: um aviso só`);
        assert.match(w.warns[0], reason);
        assert.match(w.warns[0], /Deixe o notebook na tomada/);
        assert.equal(w.logs.filter(line => /não vai dormir/.test(line)).length, 0, 'nunca promete o que não fez');
        assert.equal(w.keep.status().ativo, false);
        assert.match(w.keep.status().erro, reason);
    }
});

test('[UC-INSTALACAO-003] PowerShell aberto que não responde em 1 min: encerrado, um aviso e nova tentativa em 10 min', () => {
    const w = world();
    w.keep.update(1);
    w.clock += CONFIRM_TIMEOUT_MS - 1;
    assert.equal(w.keep.update(1), true);
    assert.equal(w.children[0].killed, 0);
    w.clock += 1;
    assert.equal(w.keep.update(1), false);
    assert.equal(w.children[0].killed, 1);
    assert.equal(w.warns.length, 1);
    assert.match(w.warns[0], /o PowerShell não respondeu/);
    // O "ok" atrasado do processo encerrado e a saída dele não mudam nada.
    w.children[0].confirm();
    w.children[0].emit('exit', null, 'SIGTERM');
    assert.equal(w.keep.status().ativo, false);
    w.clock += 10_000;
    w.keep.update(1);
    assert.equal(w.children.length, 1);
    w.clock += RETRY_AFTER_MS;
    w.keep.update(1);
    assert.equal(w.children.length, 2);
    // O "ok" pode chegar em pedaços.
    w.children[1].stdout.emit('data', 'o');
    assert.equal(w.keep.status().ativo, false);
    w.children[1].stdout.emit('data', 'k\n');
    assert.equal(w.keep.status().ativo, true);
    assert.equal(w.logs.filter(line => /não vai dormir/.test(line)).length, 1);
    // Fim da prova: o "já pode dormir" só sai porque o pedido tinha sido feito.
    w.keep.update(0);
    assert.match(w.logs.at(-1), /já pode dormir de novo/);
});

test('[UC-INSTALACAO-003] conta como prova em andamento a sala de espera, em andamento e pausada', () => {
    assert.equal(activeApplicationCount(memoryWith('waiting', 'running', 'paused', 'finished', 'draft', 'scheduled', 'cancelled')), 3);
    assert.equal(activeApplicationCount({}), 0);
    assert.equal(activeApplicationCount(null), 0);
    assert.equal(activeApplicationCount({ examApplications: [null, { status: 'running' }] }), 1);
});

test('[UC-INSTALACAO-003] o PowerShell: pedido com o número em decimal, fica lendo a entrada e sai oculto', () => {
    assert.equal(ES_KEEP_AWAKE, 0x80000001);
    assert.equal(ES_CONTINUOUS, 0x80000000);
    // No PowerShell 5.1 o literal 0x80000001 vira Int32 negativo: o script usa o decimal.
    assert.ok(POWERSHELL_SCRIPT.includes('SetThreadExecutionState([uint32]2147483649)'));
    assert.ok(!/0x8000000/.test(POWERSHELL_SCRIPT));
    assert.ok(POWERSHELL_SCRIPT.includes('[Console]::In.ReadLine()'));
    // O "ok" vem depois do pedido aceito e antes de ficar esperando a entrada.
    const okAt = POWERSHELL_SCRIPT.indexOf("[Console]::Out.WriteLine('ok')");
    assert.ok(okAt > POWERSHELL_SCRIPT.indexOf('exit 3') && okAt < POWERSHELL_SCRIPT.indexOf('[Console]::In.ReadLine()'));
    assert.ok(POWERSHELL_SCRIPT.includes('SetThreadExecutionState([uint32]2147483648)'), 'devolve o estado ao sair');
    assert.equal(powershellPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(powershellPath({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');

    const original = childProcess.spawn;
    let call = null;
    childProcess.spawn = (file, args, options) => { call = { file, args, options }; return fakeChild(); };
    try {
        spawnPowerShell({ env: { SystemRoot: 'C:\\Windows' } });
    } finally {
        childProcess.spawn = original;
    }
    assert.equal(call.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'ignore']);
    assert.ok(call.args.includes('-NoProfile') && call.args.includes('-NonInteractive'));
    const encoded = call.args[call.args.indexOf('-EncodedCommand') + 1];
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), POWERSHELL_SCRIPT);
});

test('[UC-INSTALACAO-003] o servidor sincroniza o pedido na varredura de 10 s e fecha no desligamento; o status de controle mostra', () => {
    const server = fs.readFileSync(path.join(REPO, 'backend', 'server.js'), 'utf8');
    const sweep = server.slice(server.indexOf('function sweepExpiredAttempts()'), server.indexOf("registerTimer('exam-deadline-sweep'"));
    assert.ok(sweep.includes('keepAwake.sync(db.memory)'), 'sync dentro da varredura do timer exam-deadline-sweep');
    const shutdown = server.slice(server.indexOf('async function performShutdown('));
    const body = shutdown.slice(0, shutdown.indexOf('\n}\n'));
    assert.ok(body.includes('keepAwake.stop()'), 'stop no desligamento ordenado');
    const health = fs.readFileSync(path.join(REPO, 'backend', 'routes', 'systemHealth.js'), 'utf8');
    assert.ok(health.includes('computadorAcordado: keepAwakeActive()'));
});
