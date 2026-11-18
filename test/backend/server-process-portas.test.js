// Portas dos testes que sobem o servidor num processo próprio (fixtures/server-process.js).
// Antes, freePort() devolvia a porta 0 do sistema já fechada: com os arquivos rodando em
// paralelo, o sistema entregava a mesma porta a outro processo (supertest, fetch, outro
// freePort) antes de o filho abrir, e a suíte falhava ao acaso (login no servidor de outro
// arquivo, CLI dizendo "O IClass está ligado").
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proc = require('./fixtures/server-process.js');

const fixture = path.join(__dirname, 'fixtures', 'server-process.js');
const portDir = path.join(os.tmpdir(), 'iclass-test-ports');

// Processo à parte que reserva `count` portas, imprime e espera um sinal para sair.
function reserveElsewhere(count) {
    const code = `
        const proc = require(${JSON.stringify(fixture)});
        (async () => {
            const ports = [];
            for (let i = 0; i < ${count}; i += 1) ports.push(await proc.freePort());
            process.stdout.write(JSON.stringify(ports) + '\\n');
            process.stdin.once('data', () => process.exit(0));
        })();
    `;
    const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
    const ports = new Promise((resolve, reject) => {
        let output = '';
        child.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('\n')) resolve(JSON.parse(output));
        });
        child.once('exit', code => reject(new Error(`saiu antes de reservar (código ${code})`)));
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    return { child, ports, exited };
}

test('a porta do servidor de teste fica fora da faixa que o sistema entrega sozinho', async () => {
    const ports = [];
    for (let i = 0; i < 20; i += 1) ports.push(await proc.freePort());
    ports.forEach(port => {
        // Faixa automática do Linux: 32768-60999; do Windows e do macOS: 49152-65535.
        assert.ok(port >= 1024 && port < 32768, `porta ${port} fora da faixa reservada`);
    });
    assert.equal(new Set(ports).size, ports.length, 'o mesmo processo não recebe a mesma porta duas vezes');
    ports.forEach(port => assert.equal(fs.readFileSync(path.join(portDir, String(port)), 'utf8'), String(process.pid)));
});

test('dois processos de teste nunca recebem a mesma porta, e a reserva sai com o processo', async () => {
    const mine = [];
    for (let i = 0; i < 50; i += 1) mine.push(await proc.freePort());
    const other = reserveElsewhere(50);
    const theirs = await other.ports;
    assert.equal(theirs.length, 50);
    assert.deepEqual(theirs.filter(port => mine.includes(port)), [], 'nenhuma porta repetida entre os processos');
    theirs.forEach(port => assert.ok(fs.existsSync(path.join(portDir, String(port)))));

    other.child.stdin.write('fim\n');
    await other.exited;
    theirs.forEach(port => assert.equal(fs.existsSync(path.join(portDir, String(port))), false, `reserva da porta ${port} solta na saída`));
});

test('reserva de processo que morreu sem soltar (kill -9) volta a ficar disponível', async () => {
    fs.mkdirSync(portDir, { recursive: true });
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise(resolve => dead.once('exit', resolve));
    // Todas as portas da faixa "reservadas" por um processo que já saiu: freePort retoma uma.
    const stale = [];
    for (let port = 21000; port < 30000; port += 1) {
        const file = path.join(portDir, String(port));
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, String(dead.pid));
            stale.push(file);
        }
    }
    try {
        const port = await proc.freePort();
        assert.equal(fs.readFileSync(path.join(portDir, String(port)), 'utf8'), String(process.pid));
    } finally {
        stale.forEach(file => {
            try {
                if (fs.readFileSync(file, 'utf8') === String(dead.pid)) fs.unlinkSync(file);
            } catch (e) { /* já retomada */ }
        });
    }
});
