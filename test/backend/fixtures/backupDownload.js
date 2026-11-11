// Download de backup nos testes (H4b, decisões §3 SEG-15): baixar pede a senha do
// administrador de novo. O bilhete sai de POST /api/admin/backup/download-ticket (uso
// único, 2 min, preso à conta e ao arquivo) e vai no ?ticket= do download.
const request = require('supertest');

// O alvo do bilhete pelo endereço do download: /backup/data -> json; /backup/full ->
// completo ou dados (?variante=); /backup/file -> arquivo (local e nome).
function ticketTargetFor(url) {
    const parsed = new URL(url, 'http://local');
    if (parsed.pathname.endsWith('/backup/data')) return { tipo: 'json' };
    if (parsed.pathname.endsWith('/backup/file')) return { tipo: 'arquivo', local: parsed.searchParams.get('local'), nome: parsed.searchParams.get('nome') };
    return { tipo: parsed.searchParams.get('variante') === 'dados' ? 'dados' : 'completo' };
}

async function downloadTicket(app, sessionToken, password, target) {
    const res = await request(app).post('/api/admin/backup/download-ticket').set('x-admin-session', sessionToken).send({ ...target, password });
    if (res.status !== 200 || !res.body.ticket) throw new Error(`bilhete de download recusado (${res.status}): ${res.body && res.body.error}`);
    return res.body.ticket;
}

// O endereço com o bilhete, pronto para o GET.
async function ticketUrl(app, sessionToken, password, url) {
    const ticket = await downloadTicket(app, sessionToken, password, ticketTargetFor(url));
    return `${url}${url.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`;
}

module.exports = { downloadTicket, ticketUrl, ticketTargetFor };
