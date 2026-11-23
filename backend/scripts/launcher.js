#!/usr/bin/env node
// Launcher do IClass (fase 3, A16 / P6-S4; D11 do P6): o menu do professor e os comandos.
//
//   node backend/scripts/launcher.js                 menu
//   node backend/scripts/launcher.js iniciar [--porta N] [--sem-navegador] [--minimizado]
//   node backend/scripts/launcher.js parar [--sim]
//   node backend/scripts/launcher.js reiniciar [--sim]
//   node backend/scripts/launcher.js backup [--sim] [--dados] [--destino <pasta>]
//   node backend/scripts/launcher.js restaurar (<arquivo.zip> | --ultimo) [--sim]
//   node backend/scripts/launcher.js senha [<e-mail>] [--sim]
//   node backend/scripts/launcher.js endereco [--sem-navegador]
//   node backend/scripts/launcher.js status [--json]
//   node backend/scripts/launcher.js demonstracao [--sem-navegador]
//   node backend/scripts/launcher.js parar-demonstracao
//
// No pacote, o IClass.cmd chama este arquivo com o Node do próprio pacote. As ações ficam em
// backend/utils/launcherCore.js (testadas no Linux); aqui só o menu (readline) e as opções.
// --sim responde "sim" às perguntas de confirmação (para scripts), menos a de forçar o
// encerramento de um servidor que não desliga: essa só com a pessoa na frente.
// Códigos de saída: 0 deu certo, 1 falhou ou foi cancelado, 2 configuração, 3 banco
// danificado (os mesmos do servidor e do supervisor).
const readline = require('readline');

const launcherCore = require('../utils/launcherCore.js');

const { EXIT } = launcherCore;

const MENU = Object.freeze([
    { key: '1', label: 'Ligar o IClass' },
    { key: '2', label: 'Desligar' },
    { key: '3', label: 'Reiniciar' },
    { key: '4', label: 'Fazer backup agora' },
    { key: '5', label: 'Restaurar um backup' },
    { key: '6', label: 'Endereço para os alunos' },
    { key: '7', label: 'Redefinir a senha do administrador' },
    { key: '8', label: `Modo demonstração (porta ${launcherCore.DEMO_PORT})` },
    { key: '0', label: 'Sair' },
]);

const USAGE = [
    'Uso: node backend/scripts/launcher.js [comando] [opções]',
    '  (sem comando)          abre o menu',
    '  iniciar                liga o IClass e abre o navegador (--porta N, --sem-navegador, --minimizado)',
    '  parar                  desliga o IClass gravando os dados (--sim: sem perguntar)',
    '  reiniciar              desliga e liga de novo (--sim)',
    '  backup                 faz um backup ZIP (--dados, --destino <pasta>, --sim)',
    '  restaurar              restaura um backup ZIP (<arquivo.zip> ou --ultimo, --sim)',
    '  senha                  redefine a senha de um administrador ([e-mail], --sim)',
    '  endereco               mostra o endereço dos alunos e abre a página com o QR',
    '  status                 diz se o IClass está ligado (--json)',
    '  demonstracao           liga a demonstração na porta 3100, com dados de mentira',
    '  parar-demonstracao     desliga a demonstração',
].join('\n');

function parseArgs(argv) {
    const options = { command: null, positional: [], porta: null, semNavegador: false, minimizado: false, sim: false, dados: false, destino: null, ultimo: false, json: false, ajuda: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--porta') {
            options.porta = Number(argv[index + 1]);
            index += 1;
        } else if (arg.startsWith('--porta=')) options.porta = Number(arg.slice('--porta='.length));
        else if (arg === '--sem-navegador') options.semNavegador = true;
        else if (arg === '--minimizado') options.minimizado = true;
        else if (arg === '--sim') options.sim = true;
        else if (arg === '--dados') options.dados = true;
        else if (arg === '--ultimo') options.ultimo = true;
        else if (arg === '--json') options.json = true;
        else if (arg === '--destino') {
            options.destino = argv[index + 1] || null;
            index += 1;
        } else if (arg.startsWith('--destino=')) options.destino = arg.slice('--destino='.length);
        else if (arg === '--ajuda' || arg === '-h' || arg === '--help') options.ajuda = true;
        else if (!options.command && !arg.startsWith('--')) options.command = arg;
        else if (!arg.startsWith('--')) options.positional.push(arg);
        else throw new Error(`Opção desconhecida: ${arg}`);
    }
    if (options.porta !== null && !(Number.isInteger(options.porta) && options.porta > 0 && options.porta < 65536)) {
        throw new Error('A porta precisa ser um número entre 1 e 65535.');
    }
    return options;
}

// Entrada pelo readline, que sai do caminho enquanto um script filho (backup-cli, redefinir
// senha) usa o mesmo console: o filho lê a confirmação dele sem disputar o teclado.
function createConsoleIo() {
    let rl = null;
    let closedByUser = false;
    function open() {
        if (rl) return rl;
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.on('SIGINT', () => {
            closedByUser = true;
            process.stdout.write('\n');
            rl.close();
        });
        rl.on('close', () => { rl = null; });
        return rl;
    }
    return {
        ask(question) {
            if (closedByUser) return Promise.resolve(null);
            const current = open();
            return new Promise(resolve => {
                const onClose = () => resolve(null);
                current.once('close', onClose);
                current.question(question, answer => {
                    current.off('close', onClose);
                    resolve(answer);
                });
            });
        },
        suspend() {
            if (rl) {
                const current = rl;
                rl = null;
                current.close();
            }
        },
        close() {
            this.suspend();
        },
        get closedByUser() { return closedByUser; },
    };
}

function line(text = '') {
    process.stdout.write(`${text}\n`);
}

async function showMenu(launcher, io) {
    const pause = async () => {
        const answer = await io.ask('\nPressione Enter para voltar ao menu.');
        return answer !== null;
    };
    for (;;) {
        const found = await launcher.locate();
        let demoRunning = false;
        try {
            demoRunning = (await launcher.locate(launcher.demoInstance())).state !== 'desligado';
        } catch (e) { demoRunning = false; }
        line('');
        line('======================================================');
        line(`  IClass ${launcher.version}`);
        line('======================================================');
        launcher.describeState(found).forEach(text => line(`  ${text}`));
        if (demoRunning) line(`  Demonstração ligada na porta ${launcherCore.DEMO_PORT}.`);
        line('');
        MENU.forEach(item => {
            const label = item.key === '8' && demoRunning ? 'Desligar a demonstração' : item.label;
            line(`  [${item.key}] ${label}`);
        });
        line('');
        const answer = await io.ask('Escolha uma opção: ');
        if (answer === null) return EXIT.OK;
        const choice = String(answer).trim().toUpperCase();
        line('');
        if (choice === '0') return EXIT.OK;
        if (choice === '1') await launcher.iniciar();
        else if (choice === '2') await launcher.parar();
        else if (choice === '3') await launcher.reiniciar({ abrirNavegador: false });
        else if (choice === '4') await launcher.backup();
        else if (choice === '5') await launcher.restaurar({ perguntarArquivo: true });
        else if (choice === '6') await launcher.endereco();
        else if (choice === '7') await launcher.senha({ perguntarEmail: true });
        else if (choice === '8') await (demoRunning ? launcher.pararDemonstracao() : launcher.demonstracao());
        else {
            line('Opção inválida.');
            continue;
        }
        if (!(await pause())) return EXIT.OK;
    }
}

async function main(argv = process.argv.slice(2)) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (err) {
        process.stderr.write(`${err.message}\n${USAGE}\n`);
        return EXIT.ERROR;
    }
    if (options.ajuda) {
        line(USAGE);
        return EXIT.OK;
    }
    const io = createConsoleIo();
    const launcher = launcherCore.createLauncher({
        port: options.porta || undefined,
        ask: question => io.ask(question),
        run: params => {
            io.suspend();
            return launcherCore.runScript(params);
        },
    });
    // Ctrl+C durante uma espera: o servidor (na janela dele) continua como estava.
    process.on('SIGINT', () => {
        line('\nLauncher fechado. O servidor do IClass, se estava ligado, continua na janela dele.');
        process.exit(EXIT.OK);
    });
    try {
        let result;
        const command = options.command || 'menu';
        if (command === 'menu') return await showMenu(launcher, io);
        if (command === 'iniciar') result = await launcher.iniciar({ abrirNavegador: !options.semNavegador, minimizado: options.minimizado });
        else if (command === 'parar') result = await launcher.parar({ sim: options.sim });
        else if (command === 'reiniciar') result = await launcher.reiniciar({ sim: options.sim });
        else if (command === 'backup') result = await launcher.backup({ sim: options.sim, dados: options.dados, destino: options.destino });
        else if (command === 'restaurar') result = await launcher.restaurar({ arquivo: options.positional[0] || null, ultimo: options.ultimo, sim: options.sim });
        else if (command === 'senha') result = await launcher.senha({ email: options.positional[0] || null, sim: options.sim });
        else if (command === 'endereco') result = await launcher.endereco({ abrirNavegador: !options.semNavegador });
        else if (command === 'status') result = await launcher.status({ json: options.json });
        else if (command === 'demonstracao') result = await launcher.demonstracao({ abrirNavegador: !options.semNavegador });
        else if (command === 'parar-demonstracao') result = await launcher.pararDemonstracao();
        else {
            process.stderr.write(`Comando desconhecido: ${command}\n${USAGE}\n`);
            return EXIT.ERROR;
        }
        return result && Number.isInteger(result.code) ? result.code : EXIT.ERROR;
    } finally {
        io.close();
    }
}

if (require.main === module) {
    main().then(code => {
        process.exitCode = code;
        // Timers e o stdin do readline não seguram o processo depois do fim.
        setImmediate(() => process.exit(code));
    }, err => {
        process.stderr.write(`Erro no launcher: ${(err && err.stack) || err}\n`);
        process.exit(EXIT.ERROR);
    });
}

module.exports = { MENU, USAGE, main, parseArgs };
