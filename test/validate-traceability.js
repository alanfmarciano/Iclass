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
// Valor de um atributo JSX: "x", 'x', {"x"}, {'x'} ou {`x`} (sem ${}) dão o texto; outra
// expressão ({topico}, {cond ? 'a' : 'b'}) dá null, e a conferência recusa: a âncora
// precisa estar escrita na tela para o test:docs conferir.
function jsxAttribute(source, name) {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|\\{\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`$]*)\`)\\s*\\}|(\\{))`).exec(source);
  if (!match) return undefined;
  if (match[6]) return null;
  return [1, 2, 3, 4, 5].map(index => match[index]).find(value => value !== undefined);
}

// O PageHeader repassa o helpTopic da tela ao HelpLink (topic={helpTopic}): é o único que
// pode usar uma expressão.
const HELP_FORWARDERS = new Set(['web/src/components/ui/PageHeader.jsx', 'web/src/components/ui/HelpLink.jsx']);
const screenSources = walk(path.join(root, 'web', 'src')).filter(file => /\.jsx$/.test(file) && !/\.test\.jsx$/.test(file)
  && !HELP_FORWARDERS.has(path.relative(root, file).replace(/\\/g, '/')));
const helpTopicsByFile = new Map();
screenSources.forEach(file => {
  // Comentários ficam de fora (o exemplo helpTopic="<âncora>" dos comentários não é uso).
  const content = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const relative = path.relative(root, file).replace(/\\/g, '/');
  const topics = [];
  for (const match of content.matchAll(/\bhelpTopic=[^\s>]*/g)) {
    const topic = jsxAttribute(content.slice(match.index), 'helpTopic');
    if (topic === null || topic === undefined) { docProblems.push(`${relative}: helpTopic precisa ser um texto escrito na tela (helpTopic="ancora"), para o test:docs conferir a âncora.`); continue; }
    topics.push(topic);
    if (!(helpAnchors.instrutor || new Set()).has(topic)) docProblems.push(`${relative}: helpTopic="${topic}" não existe em instrutor.md.`);
  }
  for (const match of content.matchAll(/<HelpLink\b([^>]*)>/g)) {
    const topic = jsxAttribute(match[1], 'topic');
    const doc = jsxAttribute(match[1], 'doc');
    if (topic === null || doc === null) { docProblems.push(`${relative}: <HelpLink> precisa de topic e doc escritos na tela (topic="ancora"), para o test:docs conferir a âncora.`); continue; }
    if (topic === undefined) continue;
    const docId = doc || 'instrutor';
    if (docId === 'instrutor') topics.push(topic);
    if (!(helpAnchors[docId] || new Set()).has(topic)) docProblems.push(`${relative}: <HelpLink topic="${topic}"${docId !== 'instrutor' ? ` doc="${docId}"` : ''}> aponta para uma âncora que não existe em ${docId}.md.`);
  }
  if (topics.length) helpTopicsByFile.set(relative, topics);
});

// As cinco telas com o botão "?" da D20 do P6 (UC-AJUDA-001). Chamada e Turmas são da
// trilha B até a J2 (order_notes do plano): ficam como pendentes, com dono, e o test:docs
// pede para tirar a marca quando o botão entrar. Uma tela pendente que já tem o botão, ou
// uma tela sem marca e sem o botão, reprova.
const HELP_LINK_SCREENS = [
  { arquivo: 'web/src/features/admin/ProvasPage.jsx', tema: 'provas' },
  { arquivo: 'web/src/features/admin/MonitorPage.jsx', tema: 'monitor' },
  { arquivo: 'web/src/features/admin/ChamadaPage.jsx', tema: 'chamada', pendente: 'A22 (P6-S9b), depois da J2: a ChamadaPage é da trilha B até lá' },
  { arquivo: 'web/src/features/admin/SistemaPage.jsx', tema: 'sistema' },
  { arquivo: 'web/src/features/admin/TurmasPage.jsx', tema: 'turmas', pendente: 'A22 (P6-S9b), depois da J2: a TurmasPage é da trilha B até lá (título próprio, sem PageHeader: <HelpLink topic="turmas" />)' },
];
const pendingHelpLinks = [];
HELP_LINK_SCREENS.forEach(screen => {
  if (!(helpAnchors.instrutor || new Set()).has(screen.tema)) docProblems.push(`instrutor.md: falta o tema {#${screen.tema}} da tela ${screen.arquivo}.`);
  const has = (helpTopicsByFile.get(screen.arquivo) || []).includes(screen.tema);
  if (screen.pendente && has) docProblems.push(`${screen.arquivo} já tem o botão de ajuda "${screen.tema}": tire a marca "pendente" dela em HELP_LINK_SCREENS (test/validate-traceability.js).`);
  if (!screen.pendente && !has) docProblems.push(`${screen.arquivo}: falta helpTopic="${screen.tema}" (ou <HelpLink topic="${screen.tema}" />), o botão "?" da D20.`);
  if (screen.pendente && !has) pendingHelpLinks.push(`${screen.arquivo.replace(/^.*\//, '')} (${screen.pendente})`);
});

// --- docs/README.md (fase 3, A1 / P6-S9: D20 do P6; [UC-AJUDA-003]) ---------------------
// O "Início rápido (Windows)" só cita opção do menu que existe, com o rótulo de lá, e o
// README leva ao manual (a Ajuda). Os rótulos vêm do menu do ligarIclassV3.bat (o launcher
// de hoje); quando o launcher em Node (A16, backend/scripts/launcher.js) virar o menu, esta
// conferência passa a ler os rótulos de lá.
const readmePath = path.join(root, 'docs', 'README.md');
const launcherPath = path.join(root, 'ligarIclassV3.bat');
const plainWords = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];
if (!fs.existsSync(readmePath) || !fs.existsSync(launcherPath)) {
  docProblems.push('docs/README.md ou ligarIclassV3.bat não existe.');
} else {
  const menu = new Map();
  fs.readFileSync(launcherPath, 'utf8').split(/\r?\n/).forEach(line => {
    const match = /^\s*echo\s+(?:![A-Z]+!)?\[([0-9A-Z])\](?:![A-Z]+!)?\s+-\s+(.+)$/.exec(line);
    if (match) menu.set(match[1], new Set(plainWords(match[2].replace(/![A-Z]+!/g, ' '))));
  });
  const readme = fs.readFileSync(readmePath, 'utf8');
  const quick = /^## Início rápido \(Windows\)\s*$([\s\S]*?)(?=^## )/m.exec(readme);
  if (!menu.size) docProblems.push('ligarIclassV3.bat: não achei as opções do menu ("echo [N] - Rótulo").');
  if (!quick) {
    docProblems.push('docs/README.md: falta a seção "## Início rápido (Windows)" com o menu do ligarIclassV3.bat.');
  } else {
    for (const match of quick[1].matchAll(/\[([0-9A-Z])\][*`]*\s*([^,.;*`\u2014\n(]*)/g)) {
      const label = menu.get(match[1]);
      if (!label) { docProblems.push(`docs/README.md cita a opção [${match[1]}], que não existe no menu do ligarIclassV3.bat.`); continue; }
      const missing = plainWords(match[2]).filter(word => word.length >= 3 && !label.has(word));
      if (missing.length) docProblems.push(`docs/README.md: a opção [${match[1]}] "${match[2].trim()}" não confere com o menu do ligarIclassV3.bat (${[...label].join(' ')}).`);
    }
  }
  if (!readme.includes('../web/src/features/help/conteudo/')) docProblems.push('docs/README.md: falta o link para o manual de uso (../web/src/features/help/conteudo/, a Ajuda dentro do IClass).');
}

if (docProblems.length) {
  console.error(`Documentação da versão e da ajuda com problemas:\n- ${docProblems.join('\n- ')}`);
  process.exit(1);
}

console.log(`Rastreabilidade aprovada: ${automatedIds.length} casos automatizados possuem testes identificados.`);
console.log(`Versão ${rootPackage.version} no CHANGELOG.md e ajuda com ${helpFiles.length} textos e ${Object.values(helpAnchors).reduce((total, ids) => total + ids.size, 0)} temas conferidos.`);
if (pendingHelpLinks.length) console.log(`Botão de ajuda ainda pendente: ${pendingHelpLinks.join('; ')}.`);
