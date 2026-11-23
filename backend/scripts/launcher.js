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
//   node backend/scripts/launcher.js instalar [--destino <pasta>] [--trazer-de <pasta antiga>]
//        [--sem-iniciar] [--sem-navegador] [--sim]           (da pasta do pacote; A17)
//   node backend/scripts/launcher.js atualizar [--destino <pasta>] [--sim]   (idem)
//   node backend/scripts/launcher.js voltar-versao [--sim]
//   node backend/scripts/launcher.js ligar-com-windows liga|desliga
//   node backend/scripts/launcher.js desinstalar [--sim]
//
// No pacote, o IClass.cmd chama este arquivo com o Node do próprio pacote. As ações ficam em
// backend/utils/launcherCore.js (testadas no Linux); aqui só o menu (readline) e as opções.
// --sim responde "sim" às perguntas de confirmação (para scripts), menos a de forçar o
// encerramento de um servidor que não desliga: essa só com a pessoa na frente.
// Códigos de saída: 0 deu certo, 1 falhou ou foi cancelado, 2 configuração, 3 banco
// danificado (os mesmos do servidor e do supervisor).
const readline = require('readline');

const launcherCore = require('../utils/launcherCore.js');
const launcherInstall = require('../utils/launcherInstall.js');

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

// Só na instalação pelo pacote (A17 / P6-S5): [9] no Windows e [V] com uma versão anterior
// guardada. Entram antes do [0].
function menuItems(launcher) {
    const items = MENU.filter(item => item.key !== '0');
    let here = null;
    try { here = launcher.installationContext(); } catch (e) { here = null; }
    if (here) {
        const startup = launcher.startupState();
        if (startup.disponivel) items.push({ key: '9', label: `Ligar junto com o Windows: ${startup.ligado ? 'Sim' : 'Não'}`, ligado: startup.ligado });
        const previous = here.info && here.info.versaoAnterior;
        const current = here.versaoAtual || here.versao;
        let older = false;
        try { older = !!previous && launcherInstall.compareVersions(previous, current) < 0; } catch (e) { older = false; }
        if (older) items.push({ key: 'V', label: `Voltar para a versão anterior (${previous})` });
    }
    items.push(MENU.find(item => item.key === '0'));
    return items;
}

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
    '  instalar               instala ou atualiza a partir da pasta do pacote (--destino <pasta>,',
    '                         --trazer-de <pasta antiga>, --sem-iniciar, --sem-navegador, --sim)',
    '  atualizar              atualiza a instalação a partir da pasta do pacote novo (--destino, --sim)',
    '  voltar-versao          volta para a versão anterior guardada, com os dados de antes (--sim)',
    '  ligar-com-windows      liga | desliga: o IClass liga sozinho quando você entra no Windows',
    '  desinstalar            desinstala o programa (os dados ficam, a não ser que você digite APAGAR)',
].join('\n');

function parseArgs(argv) {
    const options = { command: null, positional: [], porta: null, semNavegador: false, minimizado: false, sim: false, dados: false, destino: null, ultimo: false, json: false, ajuda: false, trazerDe: null, semIniciar: false, firewall: null };
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
        else if (arg === '--trazer-de') {
            options.trazerDe = argv[index + 1] || null;
            index += 1;
            if (!options.trazerDe || options.trazerDe.startsWith('--')) throw new Error('A opção --trazer-de precisa da pasta antiga do IClass.');
        } else if (arg.startsWith('--trazer-de=')) options.trazerDe = arg.slice('--trazer-de='.length);
        else if (arg === '--sem-iniciar') options.semIniciar = true;
        else if (arg === '--firewall') {
            options.firewall = argv[index + 1] || null;
            index += 1;
        }
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
// A entrada acabou (entrada por pipe, como "echo s | launcher.js parar", ou o console
// fechado): o readline fecha sozinho, e um readline novo sobre a entrada que já acabou
// nunca responderia nem fecharia (a pergunta ficaria pendurada e o processo sairia com 0,
// sem mensagem). Daí em diante toda pergunta resolve null na hora, que vale "não".
function createConsoleIo({ input = process.stdin, output = process.stdout } = {}) {
    let rl = null;
    let closedByUser = false;
    let inputEnded = false;
    let suspending = false;
    function open() {
        if (rl) return rl;
        const current = readline.createInterface({ input, output });
        rl = current;
        current.on('SIGINT', () => {
            closedByUser = true;
            output.write('\n');
            current.close();
        });
        current.on('close', () => {
            if (!suspending) inputEnded = true;
            if (rl === current) rl = null;
        });
        return current;
    }
    return {
        ask(question) {
            if (closedByUser) return Promise.resolve(null);
            if (inputEnded || input.readableEnded) {
                // A pergunta aparece, para quem lê o registro saber o que ficou sem resposta.
                output.write(`${question}\n`);
                return Promise.resolve(null);
            }
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
                suspending = true;
                try { current.close(); } finally { suspending = false; }
            }
        },
        close() {
            this.suspend();
        },
        get closedByUser() { return closedByUser; },
        get inputEnded() { return inputEnded; },
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
        const items = menuItems(launcher);
        items.forEach(item => {
            const label = item.key === '8' && demoRunning ? 'Desligar a demonstração' : item.label;
            line(`  [${item.key}] ${label}`);
        });
        line('');
        const answer = await io.ask('Escolha uma opção: ');
        if (answer === null) return EXIT.OK;
        const choice = String(answer).trim().toUpperCase();
        line('');
        if (choice === '0') return EXIT.OK;
        if (choice === '1') await launcher.iniciarOferecendo();
        else if (choice === '2') await launcher.parar();
        else if (choice === '3') await launcher.reiniciar({ abrirNavegador: false });
        else if (choice === '4') await launcher.backup();
        else if (choice === '5') await launcher.restaurar({ perguntarArquivo: true });
        else if (choice === '6') await launcher.endereco();
        else if (choice === '7') await launcher.senha({ perguntarEmail: true });
        else if (choice === '8') await (demoRunning ? launcher.pararDemonstracao() : launcher.demonstracao());
        else if (choice === '9' && items.some(item => item.key === '9')) await launcher.ligarComWindows({ ligar: !items.find(item => item.key === '9').ligado });
        else if (choice === 'V' && items.some(item => item.key === 'V')) await launcher.voltarVersao();
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
        if (command === 'iniciar') result = await launcher.iniciarOferecendo({ abrirNavegador: !options.semNavegador, minimizado: options.minimizado });
        else if (command === 'parar') result = await launcher.parar({ sim: options.sim });
        else if (command === 'reiniciar') result = await launcher.reiniciar({ sim: options.sim });
        else if (command === 'backup') result = await launcher.backup({ sim: options.sim, dados: options.dados, destino: options.destino });
        else if (command === 'restaurar') result = await launcher.restaurar({ arquivo: options.positional[0] || null, ultimo: options.ultimo, sim: options.sim });
        else if (command === 'senha') result = await launcher.senha({ email: options.positional[0] || null, sim: options.sim });
        else if (command === 'endereco') result = await launcher.endereco({ abrirNavegador: !options.semNavegador });
        else if (command === 'status') result = await launcher.status({ json: options.json });
        else if (command === 'demonstracao') result = await launcher.demonstracao({ abrirNavegador: !options.semNavegador });
        else if (command === 'parar-demonstracao') result = await launcher.pararDemonstracao();
        else if (command === 'instalar' || command === 'atualizar') {
            const params = { destino: options.destino, trazerDe: options.trazerDe, sim: options.sim, semIniciar: options.semIniciar, abrirNavegador: !options.semNavegador, firewall: options.firewall };
            result = await (command === 'instalar' ? launcher.instalar(params) : launcher.atualizar(params));
        } else if (command === 'voltar-versao') result = await launcher.voltarVersao({ sim: options.sim, abrirNavegador: !options.semNavegador });
        else if (command === 'ligar-com-windows') {
            const what = String(options.positional[0] || '').toLowerCase();
            if (!['liga', 'desliga'].includes(what)) {
                process.stderr.write('Use: ligar-com-windows liga | desliga\n');
                return EXIT.ERROR;
            }
            result = await launcher.ligarComWindows({ ligar: what === 'liga' });
        } else if (command === 'desinstalar') result = await launcher.desinstalar({ sim: options.sim });
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

module.exports = { MENU, USAGE, createConsoleIo, main, menuItems, parseArgs };
