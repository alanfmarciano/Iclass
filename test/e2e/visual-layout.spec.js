const { test, expect } = require('@playwright/test');

const PRESETS = ['premium', 'lumen'];
const THEMES = ['light', 'dark'];
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

async function loginAdmin(page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Administrador', exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/);
}

async function setBranding(page, interfacePreset, themeMode) {
  const result = await page.evaluate(async ({ interfacePreset, themeMode }) => {
    const auth = JSON.parse(localStorage.getItem('iclass-v3-auth') || '{}');
    const headers = { 'Content-Type': 'application/json' };
    if (auth.adminSession) headers['x-admin-session'] = auth.adminSession;
    else if (auth.adminAuth) headers.Authorization = auth.adminAuth;
    const response = await fetch('/api/branding', {
      method: 'POST',
      headers,
      body: JSON.stringify({ interfacePreset, themeMode }),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }, { interfacePreset, themeMode });
  expect(result.ok, `Falha ao aplicar branding: ${result.status} ${result.body}`).toBe(true);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html')).toHaveAttribute('data-interface', interfacePreset);
  await expect(page.locator('html')).toHaveAttribute('data-theme', themeMode);
}

async function stabilizeVisuals(page) {
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      caret-color: transparent !important;
    }
  ` });
}

for (const preset of PRESETS) {
  for (const theme of THEMES) {
    for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
      test(`[UC-LAYOUT-001] ${preset} ${theme} ${viewportName} mantém seleção e dashboard estáveis`, async ({ page, request }) => {
        test.setTimeout(45000);
        await request.post('/api/test/seed');
        await page.setViewportSize(viewport);
        await loginAdmin(page);
        await setBranding(page, preset, theme);
        await stabilizeVisuals(page);

        await expect(page.getByRole('heading', { name: 'Selecione o curso e a turma', exact: true })).toBeVisible();
        await expect(page).toHaveScreenshot(`admin-course-gate-${preset}-${theme}-${viewportName}.png`, { fullPage: true });

        await page.getByRole('button', { name: /Entrar em .+, turma/ }).first().click();
        await expect(page.getByRole('heading', { name: /Dashboard|Visão geral/i })).toBeVisible();
        await stabilizeVisuals(page);
        await expect(page).toHaveScreenshot(`admin-dashboard-${preset}-${theme}-${viewportName}.png`, { fullPage: true });
      });
    }
  }
}
