const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isBlockedUploadName, validateUploadedFile } = require('../../backend/utils/uploadSecurity.js');

test('[UC-SEC-001] bloqueia formatos executáveis e SVG', () => {
    ['ataque.html', 'script.js', 'vetor.svg', 'programa.exe', 'comando.ps1'].forEach(name => assert.equal(isBlockedUploadName(name), true));
});

test('rejeita extensão PNG com assinatura falsa', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-upload-test-'));
    const filePath = path.join(dir, 'fake.png');
    fs.writeFileSync(filePath, '<html>não é imagem</html>');
    const result = validateUploadedFile({ originalname: 'fake.png', path: filePath, mimetype: 'image/png' });
    assert.equal(result.valid, false);
    fs.rmSync(dir, { recursive: true, force: true });
});
