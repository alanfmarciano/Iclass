const { test, expect } = require('@playwright/test');

async function loginQuick(page, profile) {
  await page.goto('/login');
  await page.getByRole('button', { name: profile, exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/);
}

async function enterFirstWorkspaceWhenRequired(page) {
  const gate = page.getByRole('heading', { name: 'Selecione o curso e a turma' });
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
    const response = await fetch('/api/admin/accounts', {
      headers: auth.adminSession
        ? { 'x-admin-session': auth.adminSession }
        : { Authorization: auth.adminAuth || '' },
    });
    return response.status;
  });
  expect(apiStatus).toBe(403);

  await page.goto('/admins');
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/);
  await expect(page.getByRole('heading', { name: 'Contas de acesso', exact: true })).toHaveCount(0);
});
