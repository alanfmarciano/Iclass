const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('opção 5 mantém dados reais e usa acesso rápido local temporário', () => {
    const launcher = fs.readFileSync(path.join(__dirname, '..', '..', 'ligarIclassV3.bat'), 'latin1');
    const start = launcher.indexOf(':configurar');
    const end = launcher.indexOf(':testar', start);
    assert.ok(start >= 0 && end > start, 'Bloco :configurar não encontrado');
    const block = launcher.slice(start, end);

    assert.doesNotMatch(block, /set TEST_MODE=1/i);
    assert.match(block, /set TEST_MODE=&&/i);
    assert.match(block, /set ICLASS_DATA_DIR=&&/i);
    assert.match(block, /set ICLASS_CONTENT_DIR=&&/i);
    assert.match(block, /set ICLASS_ARCHIVE_DIR=&&/i);
    assert.match(block, /set ICLASS_ADMIN_SETUP_MODE=1/i);
    assert.match(block, /set ICLASS_ADMIN_SETUP_TOKEN=!SETUP_TOKEN!/i);
    assert.match(block, /127\.0\.0\.1:3000\/login\?mode=admin#local-quick=!SETUP_TOKEN!/i);
    assert.match(block, /localhost:3000\/login#local-quick=!SETUP_TOKEN!/i);
    assert.match(block, /set "OPEN_ISOLATED_WINDOWS=1"/i);
    assert.match(launcher, /--new-window "!SECONDARY_URL!"/i);
    assert.doesNotMatch(launcher, /--incognito|--inprivate|-private-window/i);
    assert.match(launcher, /Configuracao Inicial \/ Modo Administrativo/i);
});

// [UC-LAUNCHER-004] Os .cmd do pacote (fase 3, A16 / P6-S4): só ASCII (o cmd.exe lê na
// página de código do console, e acento vira lixo), toda linha com CRLF (o cmd.exe com LF
// pula rótulos e linhas), o .gitattributes mantém o CRLF no checkout, e nada de
// taskkill /f nem netstat (o launcher para pela rota de controle e acha o servidor pelo
// runtime/servidor.json, contrato C6).
test('[UC-LAUNCHER-004] .cmd do pacote: ASCII, CRLF, eol=crlf no git e sem taskkill /f nem netstat', () => {
    const { execFileSync } = require('node:child_process');
    const repo = path.join(__dirname, '..', '..');
    const folder = path.join(repo, 'scripts', 'release', 'modelos');
    const scripts = fs.readdirSync(folder).filter(name => name.toLowerCase().endsWith('.cmd'));
    assert.ok(scripts.includes('IClass.cmd'), 'IClass.cmd no modelo do pacote');
    for (const name of scripts) {
        const bytes = fs.readFileSync(path.join(folder, name));
        const nonAscii = [...bytes].findIndex(byte => byte > 0x7e || (byte < 0x20 && byte !== 0x0d && byte !== 0x0a && byte !== 0x09));
        assert.equal(nonAscii, -1, `${name}: caractere fora do ASCII na posição ${nonAscii}`);
        const text = bytes.toString('latin1');
        assert.ok(text.endsWith('\r\n'), `${name}: termina com CRLF`);
        const lines = text.split('\n').slice(0, -1);
        const bare = lines.findIndex(item => !item.endsWith('\r'));
        assert.equal(bare, -1, `${name}: linha ${bare + 1} sem CRLF`);
        assert.doesNotMatch(text, /taskkill[^\r\n]*\/f\b/i, `${name}: taskkill /f`);
        assert.doesNotMatch(text, /netstat/i, `${name}: netstat`);
        let attr = '';
        try {
            attr = execFileSync('git', ['check-attr', 'eol', '--', path.relative(repo, path.join(folder, name))], { cwd: repo, encoding: 'utf8' });
        } catch (e) {
            attr = '';
        }
        // Fora de um checkout do git (pacote, cópia) não há o que conferir.
        if (attr) assert.match(attr, /eol: crlf/, `${name}: .gitattributes com eol=crlf`);
    }
    const iclassCmd = fs.readFileSync(path.join(folder, 'IClass.cmd'), 'latin1');
    assert.match(iclassCmd, /backend\\scripts\\launcher\.js/i, 'chama o launcher.js do pacote');
    assert.match(iclassCmd, /%\*/, 'repassa os argumentos (iniciar, parar, backup...)');
});
