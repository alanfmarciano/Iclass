// ---------------------------------------------------------------------------
// Endereços desta máquina na rede da sala (H6a, OPS-10).
//
// Substitui o detectIP de middlewares.js, que lia os adaptadores uma vez só, ao subir: se
// o notebook trocava de Wi-Fi ou o roteador mudava o IP, a tela e o console ficavam com o
// endereço velho. Agora os adaptadores são relidos a cada pedido, com cache de 2 s.
//
// Só IPv4 que não é interno (o loopback fica de fora). Cada adaptador é classificado:
// - 'virtual': o nome é de máquina virtual, VPN ou ponte (VirtualBox, Hyper-V/vEthernet,
//   WSL, Docker, VMware, Tailscale, ZeroTier, Hamachi, WireGuard, TAP/TUN, Bluetooth...)
//   ou o IP é da rede "host-only" do VirtualBox (192.168.56.0/24). O aluno não alcança;
// - 'link-local': 169.254.0.0/16 (o Windows inventa esse IP quando o Wi-Fi não entregou
//   um endereço). Só é recomendado se for o único;
// - 'rede': os demais.
//
// O recomendado para os alunos, em ordem: 'rede' com IP privado e nome de Wi-Fi/Ethernet;
// qualquer 'rede' privado; qualquer 'rede'; um virtual; por último o link-local.
//
// O endereço que os alunos digitam é sempre esquema + IP + porta (http://IP:3000): sem a
// porta o celular cai na 80 e a página não abre. Enquanto a conexão segura para os alunos
// estiver desligada (studentsHttps, padrão; H6c), o esquema é http; ligada, https.
//
// Testes: setInterfaceProvider(fn) troca a fonte dos adaptadores. Com TEST_MODE=1,
// ICLASS_TEST_INTERFACES_FILE aponta para um JSON no formato de os.networkInterfaces(),
// relido a cada 2 s (conferência ao vivo da troca de rede); fora de TEST_MODE é ignorado.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');

const CACHE_MS = 2000;
// Intervalo do vigia que avisa no console quando o endereço muda (registrado no
// serverLifecycle pelo startServer).
const WATCH_INTERVAL_MS = 30000;

const VIRTUAL_NAME = /virtualbox|vbox|vmware|vmnet|hyper-v|vethernet|wsl|docker|^br-|^veth|^virbr|tailscale|zerotier|hamachi|wireguard|^wg\d|(?:^|[^a-z])(?:tap|tun|utun)(?:\d|[^a-z]|$)|vpn|npcap|bluetooth|loopback pseudo/i;
const PHYSICAL_NAME = /wi-?fi|wlan|wireless|sem fio|ethernet|^eth|^en[a-z]?\d|conex[aã]o local|local area connection/i;

// "Conexão Local* 10" / "Local Area Connection* 2" (com asterisco) é o adaptador do
// hotspot ou do Wi-Fi Direct do Windows: vale como rede, mas não passa à frente do Wi-Fi.
function isPhysicalName(name) {
    const text = String(name || '');
    return PHYSICAL_NAME.test(text) && !text.includes('*');
}

let interfaceProvider = null;
let cache = { at: 0, list: null };

function defaultProvider() {
    if (process.env.TEST_MODE === '1' && process.env.ICLASS_TEST_INTERFACES_FILE) {
        try {
            return JSON.parse(fs.readFileSync(process.env.ICLASS_TEST_INTERFACES_FILE, 'utf8'));
        } catch (error) { /* arquivo de teste ilegível: segue com os adaptadores reais */ }
    }
    return os.networkInterfaces();
}

// Só nos testes: fonte própria dos adaptadores (null volta à real). Zera o cache.
function setInterfaceProvider(fn) {
    interfaceProvider = typeof fn === 'function' ? fn : null;
    cache = { at: 0, list: null };
}

function ipv4Octets(address) {
    const parts = String(address || '').split('.');
    if (parts.length !== 4) return null;
    const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
    return octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

function isPrivateIpv4(address) {
    const o = ipv4Octets(address);
    if (!o) return false;
    return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

function classifyAdapter(name, address) {
    const o = ipv4Octets(address);
    if (o && o[0] === 169 && o[1] === 254) return 'link-local';
    if (VIRTUAL_NAME.test(String(name || ''))) return 'virtual';
    if (o && o[0] === 192 && o[1] === 168 && o[2] === 56) return 'virtual';
    return 'rede';
}

function isIpv4Family(family) {
    // Node 18.0-18.3 devolvia family como número (4); os demais, 'IPv4'.
    return family === 'IPv4' || family === 4;
}

// Adaptadores IPv4 não internos, na ordem do sistema: [{ name, address, kind, private }].
function readAdapters(now = Date.now()) {
    if (cache.list && now - cache.at >= 0 && now - cache.at < CACHE_MS) return cache.list;
    let raw = {};
    try {
        raw = (interfaceProvider || defaultProvider)() || {};
    } catch (error) { raw = {}; }
    const list = [];
    const seen = new Set();
    Object.keys(raw).forEach(name => {
        const entries = Array.isArray(raw[name]) ? raw[name] : [];
        entries.forEach(entry => {
            if (!entry || !isIpv4Family(entry.family) || entry.internal) return;
            const address = String(entry.address || '').trim();
            if (!ipv4Octets(address) || address.startsWith('127.')) return;
            const key = `${name}|${address}`;
            if (seen.has(key)) return;
            seen.add(key);
            list.push({ name: String(name), address, kind: classifyAdapter(name, address), private: isPrivateIpv4(address) });
        });
    });
    cache = { at: now, list };
    return list;
}

function pickRecommended(adapters) {
    const rede = adapters.filter(item => item.kind === 'rede');
    return rede.find(item => item.private && isPhysicalName(item.name))
        || rede.find(item => item.private)
        || rede[0]
        || adapters.find(item => item.kind === 'virtual')
        || adapters.find(item => item.kind === 'link-local')
        || null;
}

function addressUrl(address, port, scheme = 'http') {
    return `${scheme === 'https' ? 'https' : 'http'}://${address}:${port}`;
}

// Retrato da rede para a tela e o console. recommended é null quando o computador não
// está em rede nenhuma (só o loopback).
// { port, scheme, recommended: { name, address, kind, url } | null,
//   addresses: [{ name, address, kind, recommended, url }] }
// httpsIps (H6c): os IPs do certificado do servidor. Com scheme 'https', só esses
// endereços ganham https na url; os outros (adaptador virtual, IP fora das faixas da CA)
// ficam em http, porque por https o certificado não valeria neles (por http, a página
// leva o aluno ao endereço seguro certo). Sem httpsIps, vale o scheme para todos.
function networkAddresses({ port, scheme = 'http', httpsIps, now } = {}) {
    const adapters = readAdapters(now === undefined ? Date.now() : now);
    const recommended = pickRecommended(adapters);
    const covered = Array.isArray(httpsIps) ? new Set(httpsIps) : null;
    const schemeFor = address => (scheme === 'https' && (!covered || covered.has(address)) ? 'https' : 'http');
    const addresses = adapters.map(item => ({
        name: item.name,
        address: item.address,
        kind: item.kind,
        recommended: !!recommended && item.name === recommended.name && item.address === recommended.address,
        url: addressUrl(item.address, port, schemeFor(item.address)),
    }));
    return {
        port: Number(port),
        scheme: scheme === 'https' ? 'https' : 'http',
        recommended: recommended
            ? { name: recommended.name, address: recommended.address, kind: recommended.kind, url: addressUrl(recommended.address, port, schemeFor(recommended.address)) }
            : null,
        addresses,
    };
}

// Endereço seguro para os outros aparelhos (H6c): o IP recomendado, desde que esteja no
// certificado do servidor (ips, o SAN). Só IPs de rede local entram no certificado (a CA
// do IClass não permite outros): numa rede da escola em faixa pública ou em 100.64/10, o
// https pelo IP não valida em aparelho nenhum, nem com o certificado instalado, e a tela
// não pode dizer que funciona. O nome '<nome>.local' (H6d) resolve esse caso depois.
// Devolve { usable, address, reason }, com reason em português quando não dá.
function secureAddressStatus(recommended, ips) {
    const covered = new Set(Array.isArray(ips) ? ips : []);
    if (!recommended || !recommended.address) {
        return { usable: false, address: null, reason: 'Este computador não está ligado a nenhuma rede agora: os outros aparelhos não têm como chegar ao endereço seguro. Conecte ao Wi-Fi ou ao cabo da sala.' };
    }
    const address = recommended.address;
    if (covered.has(address)) return { usable: true, address, reason: null };
    let reason;
    if (recommended.kind === 'virtual') {
        reason = `O endereço recomendado (${address}) é de um adaptador virtual e não entra no certificado do IClass. Conecte o computador ao Wi-Fi ou ao cabo da sala.`;
    } else if (recommended.kind === 'link-local') {
        reason = `O computador está sem endereço da rede (${address}) e esse endereço não entra no certificado do IClass. Confira a conexão com o Wi-Fi ou o cabo da sala.`;
    } else if (!isPrivateIpv4(address)) {
        reason = `O endereço desta rede (${address}) não é de uma faixa de rede local (10.x, 172.16 a 172.31 ou 192.168.x) e não pode entrar no certificado do IClass: por ele, a conexão segura não funcionaria em nenhum aparelho.`;
    } else {
        reason = `O certificado do IClass ainda não inclui o endereço ${address}. Ele é refeito sozinho em até 30 segundos depois que o endereço muda.`;
    }
    return { usable: false, address: null, reason };
}

const PANEL_LINES = {
    'rede-sem-https': port => `Painel do professor: neste computador (http://localhost:${port}) e também nos outros aparelhos da rede, sem conexão segura.`,
    local: port => `Painel do professor: só neste computador (http://localhost:${port}).`,
    rede: port => `Painel do professor: neste computador (http://localhost:${port}) e na rede só pelo endereço seguro.`,
};

// Linhas do banner do console (o printBanner do server.js, H3c, chama esta função). link
// recebe a url e devolve o texto clicável (OSC 8) ou a própria url. secure (H6c):
// { available, studentsHttps, error, ips } da conexão segura (ips: os IPs do certificado
// do servidor); sem ele, a linha não sai.
function consoleLines({ port, scheme = 'http', adminAccess = 'rede-sem-https', secure = null, link = url => url, now } = {}) {
    const httpsIps = secure && secure.available && Array.isArray(secure.ips) ? secure.ips : undefined;
    const snapshot = networkAddresses({ port, scheme, httpsIps, now });
    const lines = [];
    if (snapshot.recommended) {
        lines.push(`Para os alunos: ${link(snapshot.recommended.url)}  (✅ ${snapshot.recommended.name})`);
    } else {
        lines.push('Para os alunos: este computador não está ligado a nenhuma rede. Conecte ao Wi-Fi da sala; o endereço aparece aqui e em Sistema → Rede.');
    }
    const others = snapshot.addresses.filter(item => !item.recommended);
    if (others.length) {
        lines.push('Outros adaptadores:');
        others.forEach(item => {
            const note = item.kind === 'virtual'
                ? '⚠️ virtual, não use'
                : item.kind === 'link-local'
                    ? '⚠️ sem endereço da rede, não use'
                    : item.name;
            lines.push(` -> ${link(item.url)}  (${note}${item.kind === 'rede' ? '' : `: ${item.name}`})`);
        });
    }
    if (secure && secure.available) {
        // Só um IP que está no certificado vira endereço seguro (secureAddressStatus).
        const status = secureAddressStatus(snapshot.recommended, secure.ips);
        if (status.usable) {
            lines.push(`Endereço seguro: ${link(addressUrl(status.address, snapshot.port, 'https'))}  (${secure.studentsHttps ? 'ligado para os alunos' : 'disponível; os alunos entram por http'}). Cada aparelho instala o certificado uma vez: veja /certificado.`);
        } else {
            lines.push(`⚠️ Conexão segura só neste computador (${link(addressUrl('localhost', snapshot.port, 'https'))}): ${status.reason}`);
        }
    } else if (secure) {
        lines.push(`⚠️ ${secure.error || 'Conexão segura indisponível.'}`);
    }
    lines.push((PANEL_LINES[adminAccess] || PANEL_LINES['rede-sem-https'])(snapshot.port));
    lines.push(`⚠️ IMPORTANTE: se os alunos não conseguirem abrir, libere a porta TCP ${snapshot.port} no Firewall do Windows.`);
    return lines;
}

// Retrato da rede para o vigia: o IP recomendado e o conjunto de IPs (sem o esquema: ligar
// a conexão segura para os alunos troca http por https sem a rede ter mudado).
function snapshotKey(snapshot) {
    return JSON.stringify({
        recommended: snapshot.recommended ? snapshot.recommended.address : null,
        addresses: snapshot.addresses.map(item => item.address).sort(),
    });
}

// Vigia da troca de rede: compara o retrato a cada chamada de check() e avisa no console
// quando o recomendado ou o conjunto de IPs mudou. onChange(atual, anterior) é o gancho
// para quem precisar refazer algo com o endereço novo (certificado do H6c, mDNS do H6d).
// Quando só o esquema muda (conexão segura dos alunos ligada ou desligada em Sistema →
// Rede, H6c), o console diz o endereço novo dos alunos, sem chamar onChange.
function createAddressWatcher({ port, scheme = 'http', log = console.log, onChange } = {}) {
    const read = () => networkAddresses({ port, scheme: typeof scheme === 'function' ? scheme() : scheme });
    let previous = read();
    let previousKey = snapshotKey(previous);
    const urlOf = snapshot => (snapshot.recommended ? snapshot.recommended.url : null);
    return {
        current: () => previous,
        check() {
            const current = read();
            const key = snapshotKey(current);
            if (key === previousKey) {
                const before = previous;
                previous = current;
                if (urlOf(current) && urlOf(before) && urlOf(current) !== urlOf(before)) {
                    try {
                        log(`🔄 Endereço para os alunos agora é ${urlOf(current)} (antes: ${urlOf(before)}).`);
                    } catch (error) { /* console indisponível não para o vigia */ }
                }
                return false;
            }
            const before = previous;
            previous = current;
            previousKey = key;
            const novo = current.recommended ? current.recommended.url : 'sem rede';
            const antes = before.recommended ? before.recommended.url : 'sem rede';
            try {
                log(`🔄 Endereço da rede mudou: ${novo} (antes: ${antes}). Para os alunos: ${current.recommended ? current.recommended.url : 'conecte o computador ao Wi-Fi da sala'}`);
            } catch (error) { /* console indisponível não para o vigia */ }
            if (typeof onChange === 'function') {
                try { onChange(current, before); } catch (error) { /* gancho com falha não para o vigia */ }
            }
            return true;
        },
    };
}

module.exports = {
    CACHE_MS,
    WATCH_INTERVAL_MS,
    addressUrl,
    classifyAdapter,
    consoleLines,
    createAddressWatcher,
    isPrivateIpv4,
    networkAddresses,
    secureAddressStatus,
    setInterfaceProvider,
};
