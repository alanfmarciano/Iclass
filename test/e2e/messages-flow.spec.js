// Mensagens no celular e no computador (fase 3, C14 / P5-S7b; FUN-14, D8 a D15 do P5): a
// conversa do seed na 1DES (a da Alice, com a última mensagem do professor ainda não lida).
// A aluna, num celular (375 x 812, toque), vê o número no menu, abre a conversa, lê e
// responde; o professor, no computador, vê a resposta como nova no menu, abre, responde e
// encerra com motivo; a aluna vê a conversa encerrada, sem o campo de resposta. Sem
// rolagem para o lado e sem violação WCAG AA nas telas novas.
const { test, expect } = require('@playwright/test');
const axeSource = require('axe-core').source;

const READ_NOTICE = 'O administrador da escola pode ler estas mensagens.';

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

async function loginStudent(page) {
    // Login pelo formulário: o acesso rápido refaz a semente.
    await page.goto('/login');
    await page.getByLabel('E-mail ou matrícula').fill('aluno@teste.local');
    await page.getByLabel('Senha', { exact: true }).fill('teste');
    await page.getByRole('button', { name: 'Entrar como aluno' }).click();
    await expect(page).toHaveURL(/\/aluno/, { timeout: 15000 });
}

async function loginProfessor(page) {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Instrutor', exact: true }).click();
    await page.getByLabel('E-mail').fill('professor@teste.local');
    await page.getByLabel('Senha').fill('teste');
    await page.getByRole('button', { name: /Entrar como instrutor/ }).click();
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
    const gate = page.getByRole('heading', { name: 'Selecione o curso e a turma' });
    await expect(gate.or(page.getByRole('link', { name: 'Provas', exact: true }))).toBeVisible({ timeout: 15000 });
    if (await gate.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: /Entrar em .+, turma 1DES$/ }).first().click();
    }
}

test.beforeEach(async ({ request }) => {
    await request.post('/api/test/seed');
});

test('[UC-MENSAGEM-006] aluna no celular lê e responde; o professor responde e encerra; a aluna vê encerrada', async ({ browser }) => {
    test.setTimeout(120000);
    const studentContext = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    const student = await studentContext.newPage();
    await loginStudent(student);

    // Menu do celular: "Mensagens" com o número que o sino trouxe.
    await student.getByRole('button', { name: 'Menu' }).click();
    const menuItem = student.getByRole('link', { name: /^Mensagens/ });
    await expect(menuItem).toContainText('1 conversa com mensagem nova', { timeout: 15000 });
    await menuItem.click();
    await expect(student).toHaveURL(/\/aluno\/mensagens$/);
    await expect(student.getByRole('heading', { name: 'Mensagens', level: 1 })).toBeVisible();
    await expect(student.getByText(READ_NOTICE)).toBeVisible();
    const row = student.getByRole('link', { name: /Revisão da prova/ });
    await expect(row).toBeVisible();
    await expectNoHorizontalScroll(student, 'Lista de conversas do aluno');
    await expectNoWcagViolations(student, 'Lista de conversas do aluno');

    const read = student.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/student/conversations/seed_conv_alice/read');
    await row.click();
    await expect(student).toHaveURL(/\/aluno\/mensagens\?c=seed_conv_alice$/);
    expect((await read).status()).toBe(200);
    const field = student.getByLabel('Responder');
    await expect(field).toBeVisible();
    await expectNoHorizontalScroll(student, 'Conversa do aluno');
    await expectNoWcagViolations(student, 'Conversa do aluno');
    await field.fill('Obrigada, professor! Vou revisar a questão 4.');
    const sent = student.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/student/conversations/seed_conv_alice/messages');
    await student.getByRole('button', { name: 'Enviar', exact: true }).click();
    expect((await sent).status()).toBe(201);
    await expect(student.getByText('Obrigada, professor! Vou revisar a questão 4.')).toBeVisible();
    await expect(field).toHaveValue('');
    // Lida e respondida: o número do menu some (o sino consulta na hora).
    await student.getByRole('button', { name: 'Menu' }).click();
    await expect(student.getByRole('link', { name: /^Mensagens/ })).not.toContainText('conversa', { timeout: 15000 });
    await student.keyboard.press('Escape');

    const teacherContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const teacher = await teacherContext.newPage();
    await loginProfessor(teacher);
    const teacherItem = teacher.getByRole('link', { name: /^Mensagens/ });
    await expect(teacherItem).toContainText('1 conversa com mensagem nova', { timeout: 15000 });
    await teacherItem.click();
    await expect(teacher).toHaveURL(/\/mensagens$/);
    await expect(teacher.getByText(READ_NOTICE)).toBeVisible();
    const alice = teacher.getByRole('link', { name: /Alice Aluna/ });
    await expect(alice).toContainText('1 mensagem nova');
    await expectNoWcagViolations(teacher, 'Lista de conversas do professor');
    await alice.click();
    await expect(teacher.getByText('Obrigada, professor! Vou revisar a questão 4.')).toBeVisible();
    await teacher.getByLabel('Responder').fill('Combinado. Qualquer dúvida, me escreva.');
    await teacher.getByLabel('Responder').press('Control+Enter');
    await expect(teacher.getByText('Combinado. Qualquer dúvida, me escreva.')).toBeVisible();
    await expectNoWcagViolations(teacher, 'Conversa do professor');

    await teacher.getByRole('button', { name: 'Encerrar conversa' }).click();
    const dialog = teacher.getByRole('dialog', { name: 'Encerrar a conversa?' });
    await dialog.getByLabel('Motivo (opcional)').fill('Assunto resolvido');
    await dialog.getByRole('button', { name: 'Encerrar conversa' }).click();
    await expect(teacher.getByText('Motivo: Assunto resolvido')).toBeVisible();
    await expect(teacher.getByRole('button', { name: 'Reabrir' })).toBeVisible();
    await expectNoWcagViolations(teacher, 'Conversa encerrada (professor)');

    // O professor no celular também cabe na tela.
    await teacher.setViewportSize({ width: 375, height: 812 });
    await teacher.reload();
    await expect(teacher.getByText('Combinado. Qualquer dúvida, me escreva.')).toBeVisible({ timeout: 15000 });
    await expectNoHorizontalScroll(teacher, 'Conversa do professor no celular');
    await teacher.getByRole('button', { name: 'Voltar para as conversas' }).first().click();
    await expect(teacher).toHaveURL(/\/mensagens$/);
    await expectNoHorizontalScroll(teacher, 'Lista do professor no celular');

    // A aluna vê a resposta e a conversa encerrada (a consulta da conversa aberta é de 10 s).
    await expect(student.getByText('Combinado. Qualquer dúvida, me escreva.')).toBeVisible({ timeout: 25000 });
    await expect(student.getByText(/O professor encerrou esta conversa/)).toBeVisible({ timeout: 15000 });
    await expect(student.getByLabel('Responder')).toHaveCount(0);
    await expectNoHorizontalScroll(student, 'Conversa encerrada (aluno)');
    await expectNoWcagViolations(student, 'Conversa encerrada (aluno)');

    await teacherContext.close();
    await studentContext.close();
});
