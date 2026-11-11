// Gera test/backend/fixtures/qr-code-matrizes.json, usada por qr-code.test.js como referência
// independente do codificador do IClass (backend/utils/qrCode.js). Usa a biblioteca
// "QRCode for JavaScript" (Kazuhiko Arase, MIT) que vem dentro do próprio npm
// (npm/node_modules/qrcode-terminal), sem instalar pacote. Rodar uma vez:
//   node test/backend/fixtures/gerar-qr-code-matrizes.js > test/backend/fixtures/qr-code-matrizes.json
// (Caminho do npm do Linux/macOS; no Windows o npm fica em <pasta do node>\node_modules\npm.)
const path = require('path');
const VENDOR = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'node_modules', 'qrcode-terminal', 'vendor', 'QRCode');
const QRCode = require(path.join(VENDOR, 'index.js'));
const ECL = require(path.join(VENDOR, 'QRErrorCorrectLevel.js'));
const texts = ['http://192.168.0.10:3000', 'https://iclass.local:3000', 'http://192.168.0.10:3000/' + 'a'.repeat(95)];
const cases = [];
for (const text of texts) for (let mask = 0; mask < 8; mask++) {
  const qr = new QRCode(-1, ECL.M); qr.addData(text); qr.make(); const version = qr.typeNumber; qr.makeImpl(false, mask);
  cases.push({ text, mask, version, rows: qr.modules.map(r => r.map(c => (c ? '1' : '0')).join('')) });
}
process.stdout.write(JSON.stringify({ gerador: 'qrcode-terminal 0.12 (QRCode for JavaScript, Kazuhiko Arase), correção M, modo 8bit, makeImpl(false, mask)', cases }, null, 0) + '\n');
