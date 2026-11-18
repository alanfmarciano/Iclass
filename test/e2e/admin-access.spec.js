const { test, expect } = require('@playwright/test');

async function loginQuick(page, profile) {
  await page.goto('/login');
  await page.getByRole('button', { name: profile, exact: true }).click();
  // Seed + login assíncronos podem passar dos 5s padrão sob carga (ver visual-layout).
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
}

async function enterFirstWorkspaceWhenRequired(page) {
  // A escolha de curso e turma aparece depois que a lista de cursos chega: espera ela ou
  // o painel já dentro de uma turma (o menu "Provas") antes de decidir.
  const gate = page.getByRole('heading', { name: 'Selecione o curso e a turma' });
  await expect(gate.or(page.getByRole('link', { name: 'Provas', exact: true }))).toBeVisible({ timeout: 15000 });
  if (await gate.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /Entrar em .+, turma/ }).first().click();
  }
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/test/seed');
});

test('[UC-ADMIN-001] administrador acessa a gestão de contas', async ({ page }) => {
  await loginQuick(page, 'Administrador');
  await expect(page.getByRole('link', { name: 'Administradores', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Administradores', exact: true }).click();
  await expect(page).toHaveURL(/\/admins$/);
  await expect(page.getByRole('heading', { name: 'Contas de acesso', exact: true })).toBeVisible();
});

test('[UC-ADMIN-001] professor não vê nem acessa gestão de contas', async ({ page }) => {
  await loginQuick(page, 'Professor');
  await enterFirstWorkspaceWhenRequired(page);
  await expect(page.getByRole('link', { name: 'Administradores', exact: true })).toHaveCount(0);

  const apiStatus = await page.evaluate(async () => {
    const auth = JSON.parse(localStorage.getItem('iclass-v3-auth') || '{}');
    // Só o token da sessão: o cabeçalho com e-mail e senha não autentica mais (SEG-03).
    const response = await fetch('/api/admin/accounts', {
      headers: { 'x-admin-session': auth.adminSession || '' },
    });
    return response.status;
  });
  expect(apiStatus).toBe(403);

  await page.goto('/admins');
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/);
  await expect(page.getByRole('heading', { name: 'Contas de acesso', exact: true })).toHaveCount(0);
});

// H6b (SEG-03): pela tela de login, a senha do instrutor vai uma vez, no corpo do POST
// /api/session/admin-login. Nenhum pedido leva o cabeçalho com e-mail e senha, e o
// navegador guarda só o token da sessão.
test('[UC-AUTH-001] login do instrutor pela tela: senha só no POST de login, nenhum pedido com Authorization', async ({ page }) => {
  const seen = [];
  page.on('request', (req) => { if (new URL(req.url()).pathname.startsWith('/api/')) seen.push(req); });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Instrutor', exact: true }).click();
  await page.getByLabel('E-mail').fill('admin@teste.local');
  await page.getByLabel('Senha').fill('teste');
  await page.getByRole('button', { name: /Entrar como instrutor/ }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
  await enterFirstWorkspaceWhenRequired(page);
  await page.waitForLoadState('networkidle');
  // allHeaders(): os cabeçalhos que o navegador mandou de fato (headers() pode trazer só os provisórios).
  const requests = await Promise.all(seen.map(async (req) => ({ method: req.method(), path: new URL(req.url()).pathname, headers: await req.allHeaders(), body: req.postData() || '' })));

  const logins = requests.filter((r) => r.path === '/api/session/admin-login');
  expect(logins).toHaveLength(1);
  expect(logins[0].method).toBe('POST');
  expect(JSON.parse(logins[0].body)).toEqual({ email: 'admin@teste.local', password: 'teste' });
  expect(requests.filter((r) => r.headers.authorization !== undefined)).toEqual([]);
  // Fora do login, a senha não aparece em nenhum pedido.
  expect(requests.filter((r) => r.path !== '/api/session/admin-login' && r.body.includes('"teste"'))).toEqual([]);
  expect(requests.some((r) => r.headers['x-admin-session'])).toBe(true);
  const stored = await page.evaluate(() => localStorage.getItem('iclass-v3-auth') || '');
  expect(stored).not.toContain('"teste"');
  expect(JSON.parse(stored).adminSession).toBeTruthy();
});
