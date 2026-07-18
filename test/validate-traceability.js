const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const matrixPath = path.join(root, 'docs', 'qualidade', 'MATRIZ_DE_RASTREABILIDADE.md');
const testRoots = [path.join(root, 'test'), path.join(root, 'web', 'src')];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return /\.(?:js|jsx|mjs|cjs)$/.test(entry.name) ? [fullPath] : [];
  });
}

if (!fs.existsSync(matrixPath)) {
  console.error(`Matriz não encontrada: ${matrixPath}`);
  process.exit(1);
}

const matrix = fs.readFileSync(matrixPath, 'utf8');
const automatedIds = [...matrix.matchAll(/^\|\s*(UC-[A-Z]+-\d+)\s*\|\s*Automatizado\s*\|/gm)]
  .map(match => match[1]);
const sources = testRoots.flatMap(walk)
  .map(file => ({ file, content: fs.readFileSync(file, 'utf8') }));

const missing = automatedIds.filter(id => !sources.some(source => source.content.includes(`[${id}]`)));
if (missing.length) {
  console.error(`Casos marcados como automatizados sem ID em testes: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`Rastreabilidade aprovada: ${automatedIds.length} casos automatizados possuem testes identificados.`);
