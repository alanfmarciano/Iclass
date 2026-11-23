#!/usr/bin/env node
// Avisos de terceiros do IClass (fase 3, A15 / P6-S3; OPS-21 e CRIT-12). Uso:
//   node scripts/release/licencas.js [--saida <arquivo>]   (npm run licencas)
// Gera o THIRD_PARTY_NOTICES.txt com a licença de cada pacote que vai para a escola: as
// dependências de produção do servidor (package-lock.json da raiz, sem as de
// desenvolvimento e sem as opcionais, como o pacote instala) e as da interface que entram
// no bundle (web/package-lock.json, sem as de desenvolvimento). O texto vem do arquivo de
// licença do pacote (LICENSE, LICENCE, COPYING...), da seção "License" do README, ou de
// scripts/release/licencas-extras.json (por nome@versão, conferido à mão). Pacote sem
// nenhum dos três faz o script falhar: o pacote de release não sai sem o aviso.
// O NOTICE do pacote (Apache-2.0) vai junto.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXTRAS_FILE = path.join(__dirname, 'licencas-extras.json');
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|unlicense)(?:[-_.][\w.-]*)?$/i;
const NOTICE_FILE_PATTERN = /^notice(?:\.[\w]+)?$/i;

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function licenseName(pkg) {
    if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
    if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string') return pkg.license.type;
    if (Array.isArray(pkg.licenses)) {
        const names = pkg.licenses.map(item => (item && typeof item === 'object' ? item.type : item)).filter(item => typeof item === 'string' && item);
        if (names.length) return names.length > 1 ? `(${names.join(' OR ')})` : names[0];
    }
    return 'sem licença declarada';
}

// Seção "License"/"Licença" do README (até o próximo título do mesmo nível ou maior),
// só quando tem texto de verdade (mais que o nome da licença).
function readmeLicenseSection(directory, files) {
    const readme = files.find(name => /^readme(?:\.(?:md|markdown|txt))?$/i.test(name));
    if (!readme) return '';
    const lines = fs.readFileSync(path.join(directory, readme), 'utf8').split(/\r?\n/);
    const start = lines.findIndex(line => /^#{1,6}\s+licen[cs]e\b|^#{1,6}\s+licença\b/i.test(line.trim()));
    if (start < 0) return '';
    const level = /^(#+)/.exec(lines[start].trim())[1].length;
    const body = [];
    for (let i = start + 1; i < lines.length; i += 1) {
        const heading = /^(#+)\s/.exec(lines[i].trim());
        if (heading && heading[1].length <= level) break;
        body.push(lines[i]);
    }
    const text = body.join('\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    return text.length >= 200 ? text : '';
}

// Pacotes de um package-lock.json (formato 2 ou 3) que vão para a escola. `omitOptional`:
// o servidor é instalado com --omit=optional (sem node-gyp); o bundle da interface só leva
// o que não é de desenvolvimento.
function lockPackages(lockFile, { omitOptional = false } = {}) {
    const lock = readJson(lockFile);
    if (!lock.packages || typeof lock.packages !== 'object') {
        throw new Error(`${lockFile} não tem a lista "packages" (precisa de um package-lock.json do npm 7 ou mais novo).`);
    }
    return Object.entries(lock.packages)
        .filter(([key, info]) => key && info && typeof info === 'object')
        .filter(([, info]) => !info.dev && !info.devOptional && !info.link && !(omitOptional && info.optional))
        .map(([key, info]) => ({ key, info }));
}

// Lê nome, versão, licença e o texto de cada pacote. `baseDir` é a pasta que tem o
// node_modules desse lock. Devolve { packages, missing } (missing: sem texto de licença).
function collectLicenses(baseDir, lockFile, { omitOptional = false, extras = {}, origem = '' } = {}) {
    const packages = [];
    const missing = [];
    lockPackages(lockFile, { omitOptional }).forEach(({ key, info }) => {
        const directory = path.join(baseDir, ...key.split('/'));
        let pkg;
        try {
            pkg = readJson(path.join(directory, 'package.json'));
        } catch (err) {
            // Opcional que não foi instalado nesta plataforma (fsevents fora do Mac): não vai.
            if (info.optional) return;
            missing.push({ nome: key.replace(/^.*node_modules\//, ''), versao: info.version || '?', motivo: 'pacote não instalado (rode npm ci)', origem });
            return;
        }
        const name = pkg.name || key.replace(/^.*node_modules\//, '');
        const version = pkg.version || info.version || '?';
        const files = fs.readdirSync(directory);
        const licenseFiles = files.filter(file => LICENSE_FILE_PATTERN.test(file) && fs.statSync(path.join(directory, file)).isFile()).sort();
        const noticeFiles = files.filter(file => NOTICE_FILE_PATTERN.test(file) && fs.statSync(path.join(directory, file)).isFile()).sort();
        let text = licenseFiles.map(file => fs.readFileSync(path.join(directory, file), 'utf8').trim()).filter(Boolean).join('\n\n');
        let fonte = licenseFiles.join(', ');
        if (!text) {
            text = readmeLicenseSection(directory, files);
            fonte = text ? 'README' : '';
        }
        const extra = extras[`${name}@${version}`];
        if (!text && extra && typeof extra.texto === 'string' && extra.texto.trim()) {
            text = extra.texto.trim();
            fonte = 'licencas-extras.json';
        }
        if (!text) {
            missing.push({ nome: name, versao: version, motivo: `licença "${licenseName(pkg)}" sem o texto`, origem });
            return;
        }
        const notice = noticeFiles.map(file => fs.readFileSync(path.join(directory, file), 'utf8').trim()).filter(Boolean).join('\n\n');
        packages.push({ nome: name, versao: version, licenca: licenseName(pkg), texto: text, aviso: notice, fonte, origem });
    });
    return { packages, missing };
}

function readExtras(file = EXTRAS_FILE) {
    if (!fs.existsSync(file)) return {};
    const parsed = readJson(file);
    return parsed && typeof parsed.pacotes === 'object' && parsed.pacotes ? parsed.pacotes : {};
}

// Junta os pacotes do servidor e da interface (o mesmo nome@versão uma vez só), em ordem.
function mergePackages(lists) {
    const byKey = new Map();
    lists.flat().forEach(item => {
        const key = `${item.nome}@${item.versao}`;
        const current = byKey.get(key);
        if (current) {
            if (!current.origem.includes(item.origem)) current.origem = `${current.origem} e ${item.origem}`;
            return;
        }
        byKey.set(key, { ...item });
    });
    return [...byKey.values()].sort((a, b) => (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : a.versao < b.versao ? -1 : 1));
}

const SQLITE_NOTE = 'O módulo sqlite3 traz dentro dele o SQLite (https://sqlite.org), que é de domínio público:\n'
    + '"The author disclaims copyright to this source code. In place of a legal notice, here is a blessing:\n'
    + 'May you do good and not evil. May you find forgiveness for yourself and forgive others.\n'
    + 'May you share freely, never taking more than you give."';

// Texto final. `node`: { versao, texto } do Node que vai no pacote (a licença do Node lista
// também as bibliotecas que vêm dentro dele).
function buildNotices({ version = '', packages, node = null }) {
    const lines = [];
    lines.push(`AVISOS DE TERCEIROS DO ICLASS${version ? ` ${version}` : ''}`);
    lines.push('');
    lines.push('O IClass usa os programas de código aberto abaixo. Cada um continua com a licença do seu autor,');
    lines.push('reproduzida aqui como as licenças pedem. A licença do próprio IClass está em LICENSE.txt.');
    lines.push('');
    lines.push(`Pacotes: ${packages.length}${node ? ' e o Node.js' : ''}.`);
    lines.push('');
    if (node && node.texto) {
        lines.push('='.repeat(78));
        lines.push(`Node.js ${node.versao || ''}`.trim());
        lines.push('Vai no pacote do IClass (pasta node). Licença MIT, com as licenças das bibliotecas que o Node traz dentro dele:');
        lines.push('='.repeat(78));
        lines.push('');
        lines.push(node.texto.trim());
        lines.push('');
    }
    packages.forEach(item => {
        lines.push('='.repeat(78));
        lines.push(`${item.nome} ${item.versao} (${item.licenca})${item.origem ? ` - ${item.origem}` : ''}`);
        lines.push('='.repeat(78));
        lines.push('');
        lines.push(item.texto);
        if (item.aviso) {
            lines.push('');
            lines.push(`--- NOTICE de ${item.nome} ---`);
            lines.push(item.aviso);
        }
        if (item.nome === 'sqlite3') {
            lines.push('');
            lines.push(SQLITE_NOTE);
        }
        lines.push('');
    });
    return lines.join('\n').replace(/\r\n/g, '\n');
}

function missingError(missing) {
    const list = missing.map(item => `  - ${item.nome} ${item.versao}${item.origem ? ` (${item.origem})` : ''}: ${item.motivo}`).join('\n');
    const err = new Error(`Pacotes sem o texto da licença (o pacote de release não sai sem o aviso):\n${list}\n`
        + 'Confira a licença de cada um e, se for o caso, ponha o texto em scripts/release/licencas-extras.json (chave nome@versão).');
    err.code = 'ICLASS_LICENSE_MISSING';
    err.missing = missing;
    return err;
}

// Avisos de uma pasta do IClass: o servidor (node_modules da raiz) e a interface
// (web/node_modules). `serverDir` e `webDir` podem ser pastas diferentes (no release, o
// servidor é o node_modules do pacote e a interface, o da cópia que compilou o bundle).
function noticesFor({ serverDir = ROOT, webDir = path.join(ROOT, 'web'), version, node = null, extras = readExtras() } = {}) {
    const server = collectLicenses(serverDir, path.join(serverDir, 'package-lock.json'), { omitOptional: true, extras, origem: 'servidor' });
    const web = collectLicenses(webDir, path.join(webDir, 'package-lock.json'), { omitOptional: false, extras, origem: 'interface' });
    const missing = [...server.missing, ...web.missing];
    if (missing.length) throw missingError(missing);
    const packages = mergePackages([server.packages, web.packages]);
    const pkgVersion = version || (() => { try { return readJson(path.join(serverDir, 'package.json')).version; } catch (e) { return ''; } })();
    return { text: buildNotices({ version: pkgVersion, packages, node }), packages };
}

function main(argv = process.argv.slice(2)) {
    let output = path.join(ROOT, 'THIRD_PARTY_NOTICES.txt');
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--saida' && argv[i + 1]) output = path.resolve(argv[(i += 1)]);
        else if (argv[i] === '--ajuda' || argv[i] === '-h') {
            console.log('Uso: node scripts/release/licencas.js [--saida <arquivo>]');
            return 0;
        } else {
            console.error(`Opção desconhecida: ${argv[i]}`);
            return 1;
        }
    }
    try {
        const { text, packages } = noticesFor();
        fs.writeFileSync(output, text);
        console.log(`Avisos de terceiros gravados em ${output} (${packages.length} pacotes).`);
        return 0;
    } catch (err) {
        console.error(err && err.message ? err.message : String(err));
        return 1;
    }
}

if (require.main === module) process.exitCode = main();

module.exports = {
    LICENSE_FILE_PATTERN,
    buildNotices,
    collectLicenses,
    lockPackages,
    main,
    mergePackages,
    missingError,
    noticesFor,
    readExtras,
    readmeLicenseSection,
};
