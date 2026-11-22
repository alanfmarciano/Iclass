const { test, expect } = require('@playwright/test');
const axeSource = require('axe-core').source;

// Ajuda e versão (fase 3, A1 / P6-S2 e P6-S9: OPS-02, OPS-13, ENG-10). A Ajuda do aluno
// abre sem login (quem não consegue entrar é quem procura), no celular de 375 px sem
// rolagem para o lado; o painel mostra a versão e "Conectado" no rodapé do menu, a Ajuda
// no menu e o cartão "Sobre o IClass" com as Novidades em Sistema.

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

test.beforeEach(async ({ request }) => {
  await request.post('/api/test/seed');
});

test('[UC-AJUDA-002] Ajuda do aluno abre sem login pelo "Problemas para entrar?", a 375 px, sem rolagem lateral', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 740 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('link', { name: 'Problemas para entrar?' }).click();
  await expect(page).toHaveURL(/\/ajuda\/aluno$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const topic = page.locator('details#esqueci-a-senha');
  await expect(topic).toBeVisible();
  await topic.locator('summary').click();
  await expect(topic).toHaveAttribute('open', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoWcagViolations(page, 'Ajuda do aluno');

  // A âncora abre o tema direto.
  await page.goto('/ajuda/aluno#prova-e-conexao');
  await expect(page.locator('details#prova-e-conexao')).toHaveAttribute('open', '');
  await expect(page.getByRole('link', { name: 'Voltar para a entrada' })).toBeVisible();
  await context.close();
});

test('[UC-AJUDA-002] painel mostra versão e "Conectado", a Ajuda no menu e Sobre o IClass com as Novidades', async ({ page, request }) => {
  const version = require('../../package.json').version;
  await page.goto('/login');
  await page.getByRole('button', { name: 'Administrador', exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
  await expect(page.getByTestId('connection-status').first()).toContainText('Conectado');
  await expect(page.getByTestId('app-version').first()).toHaveText(`v${version}`);

  await page.getByRole('link', { name: 'Ajuda', exact: true }).first().click();
  await expect(page).toHaveURL(/\/ajuda$/);
  await expect(page.getByRole('heading', { name: 'Ajuda', exact: true })).toBeVisible();
  await page.getByLabel('Buscar na ajuda').fill('monitor');
  await expect(page.getByRole('region', { name: 'Resultado da busca' }).getByRole('link').first()).toBeVisible();
  await expectNoWcagViolations(page, 'Ajuda do painel');

  await page.goto('/sistema');
  await expect(page.getByText('Sobre o IClass')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Novidades' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novidades do IClass' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Não publicado' })).toBeVisible();

  const about = await request.get('/api/admin/system/about');
  expect(about.status()).toBe(401);
});
