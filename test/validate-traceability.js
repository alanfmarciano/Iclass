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

// --- Versão e Novidades (fase 3, A1 / P6-S2: ENG-10; [UC-VERSAO-004]) ------------------
// O CHANGELOG.md começa por "## Não publicado" (o que cada grupo acrescenta) e a primeira
// versão abaixo dela é a do package.json da raiz (a fonte única, D7 do P6); o
// web/package.json tem a mesma versão.
const docProblems = [];
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const webPackage = JSON.parse(fs.readFileSync(path.join(root, 'web', 'package.json'), 'utf8'));
if (webPackage.version !== rootPackage.version) docProblems.push(`web/package.json tem a versão ${webPackage.version} e o package.json da raiz, ${rootPackage.version}: as duas precisam ser iguais.`);
const changelogPath = path.join(root, 'CHANGELOG.md');
if (!fs.existsSync(changelogPath)) {
  docProblems.push('CHANGELOG.md não existe na raiz.');
} else {
  const headings = [...fs.readFileSync(changelogPath, 'utf8').matchAll(/^##\s+(.+?)\s*$/gm)].map(match => match[1]);
  if (headings[0] !== 'Não publicado') docProblems.push(`CHANGELOG.md precisa começar pela seção "## Não publicado" (achei "${headings[0] || 'nada'}").`);
  const released = headings.map(text => /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(text)).filter(Boolean).map(match => match[1]);
  if (released[0] !== rootPackage.version) docProblems.push(`A primeira versão do CHANGELOG.md (${released[0] || 'nenhuma'}) não é a do package.json (${rootPackage.version}).`);
}

// --- Ajuda (fase 3, A1 / P6-S9: OPS-13; [UC-AJUDA-003]) ----------------------------------
// Só os cinco arquivos da D20 em conteudo/; âncoras {#id} bem formadas e sem repetição; e
// cada âncora que uma tela usa (helpTopic="..." no PageHeader, <HelpLink topic="..." />)
// existe no manual certo (instrutor.md, ou aluno.md com doc="aluno").
const helpDir = path.join(root, 'web', 'src', 'features', 'help', 'conteudo');
const HELP_FILES = ['aluno.md', 'instalacao-e-rede.md', 'instrutor.md', 'perguntas-frequentes.md', 'problemas.md'];
const helpFiles = fs.existsSync(helpDir) ? fs.readdirSync(helpDir).sort() : [];
if (JSON.stringify(helpFiles) !== JSON.stringify(HELP_FILES)) docProblems.push(`web/src/features/help/conteudo/ tem ${helpFiles.join(', ') || 'nada'}; precisam ser só os cinco: ${HELP_FILES.join(', ')} (escreva debaixo do título do seu tema em instrutor.md ou aluno.md).`);
const helpAnchors = {};
helpFiles.filter(name => HELP_FILES.includes(name)).forEach(name => {
  const text = fs.readFileSync(path.join(helpDir, name), 'utf8');
  const ids = [];
  text.split(/\r?\n/).forEach(line => {
    if (!/^##\s/.test(line)) return;
    const match = /\{#([^}]*)\}\s*$/.exec(line);
    if (!match) { if (name === 'instrutor.md' || name === 'aluno.md') docProblems.push(`${name}: o título "${line}" não tem âncora {#id}.`); return; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(match[1])) docProblems.push(`${name}: âncora {#${match[1]}} fora do formato (minúsculas sem acento, números e hífen).`);
    if (ids.includes(match[1])) docProblems.push(`${name}: âncora {#${match[1]}} repetida.`);
    ids.push(match[1]);
  });
  helpAnchors[name.replace(/\.md$/, '')] = new Set(ids);
});
const screenSources = walk(path.join(root, 'web', 'src')).filter(file => /\.jsx$/.test(file) && !/\.test\.jsx$/.test(file));
screenSources.forEach(file => {
  // Comentários ficam de fora (o exemplo helpTopic="<âncora>" dos comentários não é uso).
  const content = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const relative = path.relative(root, file).replace(/\\/g, '/');
  for (const match of content.matchAll(/helpTopic=["']([^"']+)["']/g)) {
    if (!(helpAnchors.instrutor || new Set()).has(match[1])) docProblems.push(`${relative}: helpTopic="${match[1]}" não existe em instrutor.md.`);
  }
  for (const match of content.matchAll(/<HelpLink\b([^>]*)>/g)) {
    const topic = /topic=["']([^"']+)["']/.exec(match[1]);
    if (!topic) continue;
    const doc = (/doc=["']([^"']+)["']/.exec(match[1]) || [null, 'instrutor'])[1];
    if (!(helpAnchors[doc] || new Set()).has(topic[1])) docProblems.push(`${relative}: <HelpLink topic="${topic[1]}"${doc !== 'instrutor' ? ` doc="${doc}"` : ''}> aponta para uma âncora que não existe em ${doc}.md.`);
  }
});

if (docProblems.length) {
  console.error(`Documentação da versão e da ajuda com problemas:\n- ${docProblems.join('\n- ')}`);
  process.exit(1);
}

console.log(`Rastreabilidade aprovada: ${automatedIds.length} casos automatizados possuem testes identificados.`);
console.log(`Versão ${rootPackage.version} no CHANGELOG.md e ajuda com ${helpFiles.length} textos e ${Object.values(helpAnchors).reduce((total, ids) => total + ids.size, 0)} temas conferidos.`);
