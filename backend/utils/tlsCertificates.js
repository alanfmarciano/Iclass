// ---------------------------------------------------------------------------
// Conexão segura (https) na rede da sala: CA própria e certificado do servidor (H6c,
// SEG-03, OPS-08).
//
// Sem internet e sem pacote novo, a única forma de ter https na rede da escola é uma CA
// (autoridade certificadora) criada por esta instalação. Cada aparelho que vai usar o
// painel do professor por https instala o certificado da CA uma vez (guia /certificado);
// o certificado do servidor é refeito sozinho quando o IP da máquina muda, sem precisar
// instalar nada de novo.
//
// Gerado só com o crypto do Node 20 (ECDSA P-256 com SHA-256) e o DER montado à mão:
// - CA: 10 anos, basicConstraints crítico (CA, pathlen 0), keyUsage crítico (keyCertSign,
//   cRLSign) e nameConstraints crítico que só permite os nomes 'local' e 'localhost' e os
//   IPs privados e de loopback (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16). Se a
//   chave vazar, ela não serve para se passar por google.com nem por um IP da internet.
// - Servidor: 397 dias no total (limite da Apple), começando 1 dia antes de agora
//   (relógio atrasado de um celular), EKU serverAuth, SAN com 'localhost', 127.0.0.1 e os IPv4
//   privados atuais dos adaptadores de rede de verdade (sem os virtuais). IP fora das
//   faixas da CA (rede em 100.64/10, por exemplo) fica de fora: o aparelho recusaria.
//   O nome '<nome>.local' entra quando o H6d (mDNS) chegar: o parâmetro dnsNames já
//   existe, e a CA já permite '.local'.
//
// Arquivos em DATA_DIR/tls/ (contrato dos arquivos fora do banco: nunca entram em backup
// nem em restauração): ca.key.pem, ca.crt.pem, servidor.key.pem e servidor.crt.pem,
// gravados de forma atômica (arquivo temporário + rename), chaves com modo 0600.
// - A CA só é criada quando falta, está ilegível ou venceu. Nunca é trocada se válida:
//   trocar a CA obriga a reinstalar em todos os aparelhos.
// - Arquivo ilegível nunca é apagado: vira '<nome>.invalido-<AAAAMMDDhhmmss>'. Quando
//   uma CA que existia é recriada, ca-recriada.json guarda quando e por quê, e a tela
//   Sistema avisa para instalar de novo nos aparelhos.
// - O certificado do servidor é refeito quando falta, não é desta CA, vence em menos de
//   30 dias ou muda o conjunto de nomes e IPs.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILES = Object.freeze({
    caKey: 'ca.key.pem',
    caCert: 'ca.crt.pem',
    serverKey: 'servidor.key.pem',
    serverCert: 'servidor.crt.pem',
    caRecreated: 'ca-recriada.json',
});
const DAY_MS = 24 * 3600 * 1000;
const CA_DAYS = 3650;
const SERVER_DAYS = 397;
const SERVER_RENEW_BEFORE_MS = 30 * DAY_MS;
const ORGANIZATION = 'IClass (rede local)';

// Faixas que a CA permite (e só elas entram no SAN por IP).
const PERMITTED_IP_RANGES = Object.freeze([
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
]);
const PERMITTED_DNS = Object.freeze(['local', 'localhost']);

// ---- DER (o mínimo do X.509 que usamos) -----------------------------------------------
function derLength(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, content) {
    const body = Buffer.isBuffer(content) ? content : Buffer.concat(content);
    return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const sequence = (...items) => tlv(0x30, items);
const set = (...items) => tlv(0x31, items);
function objectId(dotted) {
    const parts = dotted.split('.').map(Number);
    const out = [40 * parts[0] + parts[1]];
    for (const value of parts.slice(2)) {
        const chunk = [value & 0x7f];
        let rest = value >> 7;
        while (rest > 0) { chunk.unshift((rest & 0x7f) | 0x80); rest >>= 7; }
        out.push(...chunk);
    }
    return tlv(0x06, Buffer.from(out));
}
function integer(buf) {
    let bytes = buf;
    while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80)) bytes = bytes.subarray(1);
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return tlv(0x02, bytes);
}
const utf8String = text => tlv(0x0c, Buffer.from(text, 'utf8'));
const boolean = value => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const octetString = buf => tlv(0x04, buf);
const bitString = buf => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
// [n] implícito: primitivo (0x80 | n) ou construído (0xa0 | n).
const contextTag = (n, content, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, content);
function derTime(date) {
    const pad = n => String(n).padStart(2, '0');
    const year = date.getUTCFullYear();
    const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
    // UTCTime até 2049; GeneralizedTime a partir de 2050 (RFC 5280, 4.1.2.5).
    return year < 2050 ? tlv(0x17, Buffer.from(String(year).slice(2) + rest)) : tlv(0x18, Buffer.from(`${year}${rest}`));
}
function distinguishedName(commonName) {
    return sequence(
        set(sequence(objectId('2.5.4.3'), utf8String(commonName))),
        set(sequence(objectId('2.5.4.10'), utf8String(ORGANIZATION))),
    );
}
function extension(oid, critical, value) {
    return critical ? sequence(objectId(oid), boolean(true), octetString(value)) : sequence(objectId(oid), octetString(value));
}
function ipv4Bytes(ip) {
    return Buffer.from(String(ip).split('.').map(Number));
}
function maskBytes(bits) {
    const out = Buffer.alloc(4);
    for (let i = 0; i < 4; i += 1) {
        const take = Math.max(0, Math.min(8, bits - i * 8));
        out[i] = take ? (0xff << (8 - take)) & 0xff : 0;
    }
    return out;
}
function keyIdentifier(spkiDer) {
    return crypto.createHash('sha1').update(spkiDer).digest();
}
const ECDSA_WITH_SHA256 = sequence(objectId('1.2.840.10045.4.3.2'));

function serialNumber() {
    const serial = crypto.randomBytes(16);
    // Positivo e sem zero à esquerda (codificação mínima).
    serial[0] = (serial[0] & 0x7f) | 0x40;
    return serial;
}

function toPem(der) {
    return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

function buildCertificate({ subjectCN, issuerCN, publicKey, signingKey, issuerSpki, notBefore, notAfter, isCA, dnsNames = [], ips = [] }) {
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const extensions = [];
    if (isCA) {
        extensions.push(extension('2.5.29.19', true, sequence(boolean(true), integer(Buffer.from([0])))));
        // keyUsage: keyCertSign (bit 5) e cRLSign (bit 6) = 0x06, 1 bit sobrando.
        extensions.push(extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x01, 0x06]))));
        const permitted = [
            ...PERMITTED_DNS.map(name => sequence(contextTag(2, Buffer.from(name, 'ascii'), false))),
            ...PERMITTED_IP_RANGES.map(([base, bits]) => sequence(contextTag(7, Buffer.concat([ipv4Bytes(base), maskBytes(bits)]), false))),
        ];
        extensions.push(extension('2.5.29.30', true, sequence(contextTag(0, permitted))));
    } else {
        extensions.push(extension('2.5.29.19', true, sequence()));
        // keyUsage: digitalSignature (bit 0) = 0x80, 7 bits sobrando.
        extensions.push(extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))));
        extensions.push(extension('2.5.29.37', false, sequence(objectId('1.3.6.1.5.5.7.3.1'))));
        const names = [
            ...dnsNames.map(name => contextTag(2, Buffer.from(name, 'ascii'), false)),
            ...ips.map(ip => contextTag(7, ipv4Bytes(ip), false)),
        ];
        extensions.push(extension('2.5.29.17', false, sequence(...names)));
        extensions.push(extension('2.5.29.35', false, sequence(contextTag(0, keyIdentifier(issuerSpki), false))));
    }
    extensions.push(extension('2.5.29.14', false, octetString(keyIdentifier(spki))));
    const tbs = sequence(
        contextTag(0, integer(Buffer.from([2]))),
        integer(serialNumber()),
        ECDSA_WITH_SHA256,
        distinguishedName(issuerCN),
        sequence(derTime(notBefore), derTime(notAfter)),
        distinguishedName(subjectCN),
        spki,
        contextTag(3, sequence(...extensions)),
    );
    const signature = crypto.sign('sha256', tbs, signingKey);
    return sequence(tbs, ECDSA_WITH_SHA256, bitString(signature));
}

// ---- Regras de nomes e IPs ----------------------------------------------------------
function ipv4ToNumber(ip) {
    const parts = String(ip || '').split('.');
    if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
    return parts.reduce((acc, part) => (acc * 256) + Number(part), 0);
}

function isPermittedIp(ip) {
    const value = ipv4ToNumber(ip);
    if (value === null) return false;
    return PERMITTED_IP_RANGES.some(([base, bits]) => {
        const size = 2 ** (32 - bits);
        const start = ipv4ToNumber(base);
        return value >= start && value < start + size;
    });
}

function sortIps(list) {
    return [...list].sort((a, b) => ipv4ToNumber(a) - ipv4ToNumber(b));
}

// Nomes e IPs do certificado do servidor a partir do retrato da rede
// (utils/networkAddresses.js): só adaptadores 'rede' (os virtuais e o link-local, não)
// com IP dentro das faixas da CA, mais localhost e 127.0.0.1. dnsNames extras (o
// '<nome>.local' do H6d) passam pelo mesmo filtro da CA.
function serverSubjectNames({ addresses = [], dnsNames = [] } = {}) {
    const ips = new Set(['127.0.0.1']);
    (Array.isArray(addresses) ? addresses : []).forEach(item => {
        if (item && item.kind === 'rede' && isPermittedIp(item.address)) ips.add(String(item.address));
    });
    const names = new Set(['localhost']);
    (Array.isArray(dnsNames) ? dnsNames : []).forEach(name => {
        const value = String(name || '').trim().toLowerCase();
        if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value)
            && (value === 'localhost' || value.endsWith('.local'))) names.add(value);
    });
    return { names: [...names].sort(), ips: sortIps(ips) };
}

// Lê o SAN de um certificado ("DNS:localhost, IP Address:127.0.0.1").
function parseSubjectAltName(text) {
    const names = [];
    const ips = [];
    String(text || '').split(',').map(part => part.trim()).forEach(part => {
        if (part.startsWith('DNS:')) names.push(part.slice(4).toLowerCase());
        else if (part.startsWith('IP Address:')) ips.push(part.slice(11));
    });
    return { names: [...new Set(names)].sort(), ips: sortIps(new Set(ips)) };
}

function sameNames(a, b) {
    return JSON.stringify(a.names) === JSON.stringify(b.names) && JSON.stringify(a.ips) === JSON.stringify(b.ips);
}

// ---- Arquivos ---------------------------------------------------------------------
function timestampSuffix(now) {
    const d = new Date(now);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function writeAtomic(file, content, mode) {
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
    try {
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch (e) { /* sobra temporária */ }
        throw error;
    }
    // Arquivo já existente mantém o modo antigo no rename de alguns sistemas: confirma.
    if (mode) { try { fs.chmodSync(file, mode); } catch (e) { /* Windows não tem 0600 */ } }
}

// Nunca apaga: o arquivo ilegível vira '<nome>.invalido-<data>' (outro sufixo se já houver).
function setAside(file, now) {
    if (!fs.existsSync(file)) return null;
    const base = `${file}.invalido-${timestampSuffix(now)}`;
    let target = base;
    for (let i = 2; fs.existsSync(target); i += 1) target = `${base}-${i}`;
    fs.renameSync(file, target);
    return path.basename(target);
}

function readOptional(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
    }
}

function loadPair(keyFile, certFile) {
    const keyPem = readOptional(keyFile);
    const certPem = readOptional(certFile);
    if (keyPem === null && certPem === null) return { missing: true };
    try {
        if (keyPem === null || certPem === null) throw new Error('par incompleto');
        const privateKey = crypto.createPrivateKey(keyPem);
        const cert = new crypto.X509Certificate(certPem);
        if (!cert.checkPrivateKey(privateKey)) throw new Error('a chave não é deste certificado');
        return { keyPem, certPem, privateKey, cert };
    } catch (error) {
        return { invalid: true, reason: error && error.message ? error.message : String(error) };
    }
}

function certDates(cert) {
    return { validFrom: new Date(cert.validFrom).toISOString(), validTo: new Date(cert.validTo).toISOString() };
}

function caCommonName() {
    let host = '';
    try { host = String(os.hostname() || '').trim(); } catch (e) { host = ''; }
    // CN tem no máximo 64 caracteres (RFC 5280).
    const prefix = 'IClass – CA local';
    const full = host ? `${prefix} (${host})` : prefix;
    return full.length <= 64 ? full : `${full.slice(0, 63)})`;
}

function readCaRecreated(dir) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, FILES.caRecreated), 'utf8'));
        return data && typeof data.at === 'string' ? { at: data.at, reason: typeof data.reason === 'string' ? data.reason : '' } : null;
    } catch (e) {
        return null;
    }
}

function createCa(dir, now) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const cn = caCommonName();
    const der = buildCertificate({
        subjectCN: cn,
        issuerCN: cn,
        publicKey,
        signingKey: privateKey,
        issuerSpki: spki,
        notBefore: new Date(now - DAY_MS),
        notAfter: new Date(now + CA_DAYS * DAY_MS),
        isCA: true,
    });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const certPem = toPem(der);
    // A chave primeiro: certificado sem a chave é recusado na próxima leitura.
    writeAtomic(path.join(dir, FILES.caKey), keyPem, 0o600);
    writeAtomic(path.join(dir, FILES.caCert), certPem);
    return { keyPem, certPem, privateKey, cert: new crypto.X509Certificate(certPem) };
}

function createServerCertificate(dir, ca, subject, now) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = buildCertificate({
        subjectCN: 'IClass – servidor da sala',
        issuerCN: ca.cert.subject.split('\n').find(line => line.startsWith('CN='))?.slice(3) || caCommonName(),
        publicKey,
        signingKey: ca.privateKey,
        issuerSpki: ca.cert.publicKey.export({ type: 'spki', format: 'der' }),
        // A validade inteira (de notBefore a notAfter) fica em 397 dias.
        notBefore: new Date(now - DAY_MS),
        notAfter: new Date(now - DAY_MS + SERVER_DAYS * DAY_MS),
        isCA: false,
        dnsNames: subject.names,
        ips: subject.ips,
    });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const certPem = toPem(der);
    writeAtomic(path.join(dir, FILES.serverKey), keyPem, 0o600);
    writeAtomic(path.join(dir, FILES.serverCert), certPem);
    return { keyPem, certPem, privateKey, cert: new crypto.X509Certificate(certPem) };
}

// Garante a CA e o certificado do servidor em `dir` para os nomes e IPs de agora.
// Devolve { key, cert, ca: { certPem, der, fingerprintSha256, validFrom, validTo,
// recreatedAt, recreatedReason }, server: { validFrom, validTo, names, ips },
// changed: { ca, server }, setAside: [arquivos renomeados] }. Lança se a pasta não puder
// ser criada ou gravada (o servidor sobe só em http: ver server.js).
function ensureTlsMaterial({ dir, addresses = [], dnsNames = [], now = Date.now() } = {}) {
    if (!dir) throw new Error('pasta do certificado não informada');
    fs.mkdirSync(dir, { recursive: true });
    const renamed = [];
    const changed = { ca: false, server: false };

    // 1) CA: só é criada quando falta, está ilegível ou venceu.
    let ca = loadPair(path.join(dir, FILES.caKey), path.join(dir, FILES.caCert));
    let recreateReason = null;
    if (ca.invalid) recreateReason = `arquivo ilegível (${ca.reason})`;
    else if (!ca.missing && (!ca.cert.ca || Date.parse(ca.cert.validTo) <= now)) recreateReason = !ca.cert.ca ? 'o arquivo não é de uma CA' : 'a CA venceu';
    if (ca.missing || recreateReason) {
        if (recreateReason) {
            [FILES.caKey, FILES.caCert, FILES.serverKey, FILES.serverCert].forEach(name => {
                const aside = setAside(path.join(dir, name), now);
                if (aside) renamed.push(aside);
            });
        }
        ca = createCa(dir, now);
        changed.ca = true;
        if (recreateReason) {
            writeAtomic(path.join(dir, FILES.caRecreated), JSON.stringify({ at: new Date(now).toISOString(), reason: recreateReason }, null, 2));
        }
    }

    // 2) Servidor: refeito quando falta, não é desta CA, vence em menos de 30 dias ou os
    // nomes e IPs mudaram.
    const wanted = serverSubjectNames({ addresses, dnsNames });
    let server = changed.ca ? { missing: true } : loadPair(path.join(dir, FILES.serverKey), path.join(dir, FILES.serverCert));
    let redo = !!server.missing;
    if (server.invalid) {
        [FILES.serverKey, FILES.serverCert].forEach(name => {
            const aside = setAside(path.join(dir, name), now);
            if (aside) renamed.push(aside);
        });
        redo = true;
    } else if (!redo) {
        const issuedByCa = server.cert.checkIssued(ca.cert) && server.cert.verify(ca.cert.publicKey);
        const expiresSoon = Date.parse(server.cert.validTo) - now < SERVER_RENEW_BEFORE_MS;
        const notYet = Date.parse(server.cert.validFrom) > now;
        const current = parseSubjectAltName(server.cert.subjectAltName);
        redo = !issuedByCa || expiresSoon || notYet || !sameNames(current, wanted);
    }
    if (redo) {
        server = createServerCertificate(dir, ca, wanted, now);
        changed.server = true;
    }

    const recreated = readCaRecreated(dir);
    const caDates = certDates(ca.cert);
    const serverNames = parseSubjectAltName(server.cert.subjectAltName);
    return {
        key: server.keyPem,
        cert: server.certPem,
        ca: {
            certPem: ca.certPem,
            der: ca.cert.raw,
            fingerprintSha256: ca.cert.fingerprint256,
            ...caDates,
            recreatedAt: recreated ? recreated.at : null,
            recreatedReason: recreated ? recreated.reason : null,
        },
        server: { ...certDates(server.cert), names: serverNames.names, ips: serverNames.ips },
        changed,
        setAside: renamed,
    };
}

module.exports = {
    CA_DAYS,
    FILES,
    PERMITTED_IP_RANGES,
    SERVER_DAYS,
    SERVER_RENEW_BEFORE_MS,
    ensureTlsMaterial,
    isPermittedIp,
    parseSubjectAltName,
    serverSubjectNames,
};
