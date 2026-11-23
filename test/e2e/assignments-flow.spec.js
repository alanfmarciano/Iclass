// Atividades no celular do aluno (fase 3, C9 / P1-g; FUN-01, D12 do P1): o professor
// publica uma tarefa (pela rota da tela dele), o aluno num celular (375 x 812, toque)
// abre "Atividades", escolhe um PDF e uma foto, envia com a barra de progresso e vê o
// comprovante; o professor devolve com nota e o aluno vê a nota e o comentário. Sem
// rolagem para o lado e sem violação WCAG AA nas telas novas.
const { test, expect } = require('@playwright/test');
const axeSource = require('axe-core').source;

const COURSE = 'curso_legacy_01';
const CLASS = '1DES';
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4096, 0x20), Buffer.from('\n%%EOF\n')]);
// PNG pequeno de verdade (1 x 1, branco).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');

async function expectNoWcagViolations(page, context) {
    await page.waitForLoadState('networkidle');
    if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(axeSource);
    const results = await page.evaluate(async () => window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    }));
    const violations = results.violations.map(violation => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        targets: violation.nodes.map(node => node.target.join(' ')),
    }));
    expect(violations, `${context}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

async function expectNoHorizontalScroll(page, context) {
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(widths.scroll, `${context}: rolagem para o lado`).toBeLessThanOrEqual(widths.client);
}

async function professorToken(request) {
    const res = await request.post('/api/session/admin-login', { data: { email: 'professor@teste.local', password: 'teste' } });
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()).sessionToken;
}

function futureDate(days) {
    const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

test.beforeEach(async ({ request }) => {
    await request.post('/api/test/seed');
});

test('aluno no celular envia PDF e foto da atividade, vê o comprovante e depois a nota devolvida', async ({ browser, request }) => {
    test.setTimeout(90000);
    const token = await professorToken(request);
    const headers = { 'x-admin-session': token };
    const created = await request.post('/api/admin/assignments', {
        headers,
        data: {
            courseId: COURSE,
            studentClass: CLASS,
            title: 'Relatório da prática de redes',
            instructions: 'Envie o **relatório** em PDF e a foto do cabeamento.',
            moduleId: null,
            unitKey: null,
            libraryIds: [],
            response: { files: true, text: true, link: false },
            files: { maxFiles: 3, maxSizeMb: 10, types: ['pdf', 'image'], extraExtensions: [] },
            opensDate: null,
            opensTime: null,
            dueDate: futureDate(3),
            dueTime: '23:00',
            closeDate: null,
            closeTime: null,
            latePolicy: { mode: 'aceitar', penaltyPerDayPct: 0, penaltyMaxPct: 0 },
            countsInAverage: true,
            publish: true,
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    const assignment = (await created.json()).assignment;

    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    // Login pelo formulário: o acesso rápido refaz a semente e apagaria a tarefa criada acima.
    await page.goto('/login');
    await page.getByLabel('E-mail ou matrícula').fill('aluno@teste.local');
    await page.getByLabel('Senha', { exact: true }).fill('teste');
    await page.getByRole('button', { name: 'Entrar como aluno' }).click();
    await expect(page).toHaveURL(/\/aluno/, { timeout: 15000 });

    // Início: a atividade a fazer, com o link.
    await expect(page.getByRole('heading', { name: /Atividades a fazer/ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Relatório da prática de redes').first()).toBeVisible();

    // Menu do celular: "Atividades".
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('link', { name: 'Atividades', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Atividades', exact: true })).toBeVisible();
    const todo = page.getByRole('region', { name: /^A fazer/ });
    await expect(todo.getByText('A fazer', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page, 'Lista de atividades');
    await expectNoWcagViolations(page, 'Lista de atividades');

    await todo.getByRole('link', { name: /Relatório da prática de redes/ }).click();
    await expect(page).toHaveURL(new RegExp(`/aluno/atividades/${assignment.id}$`));
    await expect(page.getByRole('heading', { name: 'Relatório da prática de redes' })).toBeVisible();
    await expect(page.getByText('Até 3 arquivos de até 10 MB cada', { exact: false })).toBeVisible();
    await expectNoHorizontalScroll(page, 'Atividade');
    await expectNoWcagViolations(page, 'Atividade antes do envio');

    await page.getByLabel('Escolher arquivo ou tirar foto').setInputFiles([
        { name: 'Relatório final.pdf', mimeType: 'application/pdf', buffer: PDF },
        { name: 'cabeamento.png', mimeType: 'image/png', buffer: PNG },
    ]);
    const chosen = page.getByRole('list', { name: 'Arquivos escolhidos' });
    await expect(chosen.getByText('Relatório final.pdf')).toBeVisible();
    await expect(chosen.getByText('cabeamento.png')).toBeVisible();
    await page.getByLabel('Resposta em texto').fill('Medições na tabela da página 2.');
    await expectNoHorizontalScroll(page, 'Atividade com arquivos escolhidos');

    const sent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/student/assignments/${assignment.id}/submit`);
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    expect((await sent).status()).toBe(201);
    const receipt = page.getByRole('status').filter({ hasText: 'Envio recebido.' });
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText(/Recebido às \d{2}:\d{2} de \d{2}\/\d{2} — versão 1 — 2 arquivos \(.+\) — resposta em texto — código [0-9A-F]{8}/);
    await expect(receipt).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Versões enviadas (1)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Baixar Relatório final.pdf' })).toBeVisible();
    await expectNoHorizontalScroll(page, 'Atividade com o comprovante');
    await expectNoWcagViolations(page, 'Atividade com o comprovante');

    // O professor devolve com nota e comentário (a rota da tela dele).
    const graded = await request.post(`/api/admin/assignments/${assignment.id}/grade`, {
        headers,
        data: { studentEmail: 'aluno@teste.local', action: 'devolver', grade: '8,5', comment: 'Bom relatório. Revise a conclusão.', waivePenalty: false, version: 1 },
    });
    expect(graded.ok(), await graded.text()).toBeTruthy();

    await page.reload();
    await expect(page.getByText('Devolvida pelo professor')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('8,5', { exact: true })).toBeVisible();
    await expect(page.getByText('Bom relatório. Revise a conclusão.')).toBeVisible();
    await expect(page.getByLabel('Escolher arquivo ou tirar foto')).toHaveCount(0);
    await expectNoHorizontalScroll(page, 'Atividade devolvida');
    await expectNoWcagViolations(page, 'Atividade devolvida');

    await page.goto('/aluno/atividades');
    const returned = page.getByRole('region', { name: /^Devolvidas/ });
    await expect(returned.getByText('Nota 8,5')).toBeVisible();
    await context.close();
});
