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
