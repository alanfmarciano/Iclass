const { test, expect } = require('@playwright/test');
const axeSource = require('axe-core').source;

async function expectNoWcagViolations(page, context) {
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: axeSource });
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

test('[UC-AUTH-001] modo de teste autentica aluno sem tocar a base real e respeita WCAG AA', async ({ page, request }) => {
    const mode = await request.get('/api/test-mode');
    await expect(mode).toBeOK();
    expect((await mode.json()).enabled).toBe(true);

    await page.goto('/login');
    await expectNoWcagViolations(page, 'Login');
    await page.getByRole('button', { name: 'Aluno', exact: true }).first().click();
    await expect(page).toHaveURL(/\/aluno/);
    await expect(page.getByText('Portal do Aluno')).toBeVisible();
    await expectNoWcagViolations(page, 'Portal do aluno');
});

test('[UC-AUTH-001] atalho administrativo abre o login de instrutor', async ({ page }) => {
    await page.goto('/login?mode=admin');
    await expect(page.getByRole('button', { name: 'Entrar como instrutor' })).toBeVisible();
    await expectNoWcagViolations(page, 'Login administrativo');
});

test('[UC-AUTH-001] opção 5 isola professor e aluno em duas janelas normais por origem local', async ({ browser, request }) => {
    await request.post('/api/test/seed');
    const normalContext = await browser.newContext();
    const professorPage = await normalContext.newPage();
    const studentPage = await normalContext.newPage();
    const professorUrl = 'http://127.0.0.1:3132/login?mode=admin#local-quick=e2e-local-admin-token-32-characters';
    const studentUrl = 'http://localhost:3132/login#local-quick=e2e-local-admin-token-32-characters';

    await Promise.all([professorPage.goto(professorUrl), studentPage.goto(studentUrl)]);
    await expect(professorPage.getByText('Acesso rápido local')).toBeVisible();
    await expect(studentPage.getByText('Acesso rápido local')).toBeVisible();
    expect(await professorPage.evaluate(() => window.location.hash)).toBe('');
    expect(await studentPage.evaluate(() => window.location.hash)).toBe('');

    await professorPage.getByRole('button', { name: 'Professor', exact: true }).click();
    await studentPage.getByRole('button', { name: 'Aluno', exact: true }).first().click();
    await expect(professorPage).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/);
    await expect(studentPage).toHaveURL(/^http:\/\/localhost:3132\/aluno$/);

    const professorAuth = await professorPage.evaluate(() => JSON.parse(localStorage.getItem('iclass-v3-auth') || '{}'));
    const studentAuth = await studentPage.evaluate(() => JSON.parse(localStorage.getItem('iclass-v3-auth') || '{}'));
    expect(professorAuth.email).toBe('professor@teste.local');
    expect(professorAuth.accountRole).toBe('professor');
    expect(studentAuth.email).toBe('aluno@teste.local');
    expect(studentAuth.role).toBe('student');
    await expectNoWcagViolations(professorPage, 'Painel do professor em janela normal');
    await expectNoWcagViolations(studentPage, 'Painel do aluno em origem local isolada');

    await normalContext.close();
});
