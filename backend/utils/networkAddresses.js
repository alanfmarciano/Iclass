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
// estiver desligada (studentsHttps, padrão; H6c), o esquema é http.
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
function networkAddresses({ port, scheme = 'http', now } = {}) {
    const adapters = readAdapters(now === undefined ? Date.now() : now);
    const recommended = pickRecommended(adapters);
    const addresses = adapters.map(item => ({
        name: item.name,
        address: item.address,
        kind: item.kind,
        recommended: !!recommended && item.name === recommended.name && item.address === recommended.address,
        url: addressUrl(item.address, port, scheme),
    }));
    return {
        port: Number(port),
        scheme: scheme === 'https' ? 'https' : 'http',
        recommended: recommended
            ? { name: recommended.name, address: recommended.address, kind: recommended.kind, url: addressUrl(recommended.address, port, scheme) }
            : null,
        addresses,
    };
}

const PANEL_LINES = {
    'rede-sem-https': port => `Painel do professor: neste computador (http://localhost:${port}) e também nos outros aparelhos da rede, sem conexão segura.`,
    local: port => `Painel do professor: só neste computador (http://localhost:${port}).`,
    rede: port => `Painel do professor: neste computador (http://localhost:${port}) e na rede só pelo endereço seguro.`,
};

// Linhas do banner do console (o printBanner do server.js, H3c, chama esta função). link
// recebe a url e devolve o texto clicável (OSC 8) ou a própria url.
function consoleLines({ port, scheme = 'http', adminAccess = 'rede-sem-https', link = url => url, now } = {}) {
    const snapshot = networkAddresses({ port, scheme, now });
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
    lines.push((PANEL_LINES[adminAccess] || PANEL_LINES['rede-sem-https'])(snapshot.port));
    lines.push(`⚠️ IMPORTANTE: se os alunos não conseguirem abrir, libere a porta TCP ${snapshot.port} no Firewall do Windows.`);
    return lines;
}

function snapshotKey(snapshot) {
    return JSON.stringify({
        recommended: snapshot.recommended ? snapshot.recommended.url : null,
        addresses: snapshot.addresses.map(item => item.address).sort(),
    });
}

// Vigia da troca de rede: compara o retrato a cada chamada de check() e avisa no console
// quando o recomendado ou o conjunto de IPs mudou. onChange(atual, anterior) é o gancho
// para quem precisar refazer algo com o endereço novo (certificado do H6c, mDNS do H6d).
function createAddressWatcher({ port, scheme = 'http', log = console.log, onChange } = {}) {
    const read = () => networkAddresses({ port, scheme: typeof scheme === 'function' ? scheme() : scheme });
    let previous = read();
    let previousKey = snapshotKey(previous);
    return {
        current: () => previous,
        check() {
            const current = read();
            const key = snapshotKey(current);
            if (key === previousKey) return false;
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
    setInterfaceProvider,
};
