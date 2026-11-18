// Backup automático do boot com o /api/health consultado sem parar (decisões §12, sobra
// do H4b, MÉDIA). Antes, o backup do boot falhava às vezes com "SQLITE_ERROR: cannot
// VACUUM - SQL statements in progress": o launcher e o Reiniciar consultam o /api/health
// durante a subida, e o SELECT 1 do db.ping começava um instante antes do VACUUM INTO.
// Aqui o servidor de verdade (fixtures/server-main-child.js, sem TEST_MODE, como na
// máquina do Alan) sobe 10 vezes com o /api/health a cada 50 ms, e cada boot tem de
// gravar o backup automático sem falha.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proc = require('./fixtures/server-process.js');

const childScript = path.join(__dirname, 'fixtures', 'server-main-child.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-backup-boot-health-'));
const BOOTS = 10;

test.after(() => {
    proc.killAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('[UC-BACKUP-007] 10 boots com o /api/health a cada 50 ms: o backup automático do boot grava sempre, sem "SQL statements in progress"', { timeout: 240000 }, async () => {
    const backupsDir = path.join(dataDir, 'backups');
    const stateFile = path.join(backupsDir, 'estado.json');
    for (let round = 0; round < BOOTS; round += 1) {
        // Sem backup anterior: o boot sempre acha o backup devido.
        fs.rmSync(backupsDir, { recursive: true, force: true });
        const server = proc.launch(childScript, { dataDir, port: await proc.freePort(), env: { TEST_MODE: '0' } });
        let stop = false;
        let pings = 0;
        const poller = (async () => {
            while (!stop) {
                try { await proc.call(server.base, '/api/health'); pings += 1; } catch (e) { /* porta ainda fechada */ }
                await proc.sleep(50);
            }
        })();
        try {
            const state = await proc.waitFor(() => {
                const value = proc.readJson(stateFile);
                return value && ((value.local && value.local.ultimoSucesso) || value.ultimaFalha) ? value : null;
            }, { timeoutMs: 30000, intervalMs: 50, what: `estado do backup do boot ${round + 1}` });
            assert.equal(state.ultimaFalha, undefined, `boot ${round + 1}: ${JSON.stringify(state.ultimaFalha)}\n${server.output()}`);
            assert.ok(state.local.ultimoSucesso, `boot ${round + 1}`);
            assert.ok(fs.readdirSync(backupsDir).some(name => /^automatico_.*\.zip$/.test(name)), `boot ${round + 1}: o ZIP do backup automático existe`);
        } finally {
            stop = true;
            await poller;
            server.child.kill('SIGTERM');
            await server.exited;
        }
        assert.ok(pings > 0, `boot ${round + 1}: o /api/health foi consultado durante o boot`);
        assert.equal(/SQL statements in progress/i.test(server.output()), false, server.output());
    }
    const crashLog = path.join(dataDir, 'crash.log');
    const crash = fs.existsSync(crashLog) ? fs.readFileSync(crashLog, 'utf8') : '';
    assert.equal(/SQL statements in progress/i.test(crash), false, crash);
});
