const { test, expect } = require('@playwright/test');

// Fase 3, C16 (P5-S2; CRIT-07): a lupa do portal busca nas apostilas liberadas sem acento,
// o resultado abre a unidade pelo endereço com o termo marcado, e o endereço da unidade
// sobrevive à recarga. No celular (375 px), sem rolagem para o lado.
test.use({ viewport: { width: 375, height: 812 } });

test('[UC-BUSCA-003] busca do aluno abre a apostila no trecho achado', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Aluno', exact: true }).first().click();
    await expect(page).toHaveURL(/\/aluno/, { timeout: 15000 });

    await page.getByRole('link', { name: 'Buscar' }).click();
    await expect(page).toHaveURL(/\/aluno\/busca/);
    // "pratica" (sem acento) acha "Praticar" nas apostilas de demonstração.
    await page.getByRole('searchbox', { name: 'Buscar' }).fill('pratica');
    const apostilas = page.getByRole('region', { name: 'Apostilas' });
    await expect(apostilas.locator('mark').first()).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\?q=pratica/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    await apostilas.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/aluno\/modulos\?unidade=[^&]+&busca=pratica/);
    const current = page.locator('article mark.busca-marca-atual');
    await expect(current).toBeVisible();
    await expect(current).toBeInViewport();
    await expect(page.getByText(/Destacando “pratica” nesta unidade/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    await page.getByRole('button', { name: 'Tirar destaque' }).click();
    await expect(page.locator('article mark')).toHaveCount(0);
    await expect(page).not.toHaveURL(/busca=/);

    // O endereço da unidade sobrevive à recarga; "Voltar aos módulos" volta para a lista.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Voltar aos módulos' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Voltar aos módulos' }).click();
    await expect(page).toHaveURL(/\/aluno\/modulos$/);

    // Link de unidade que não existe: aviso e a lista.
    await page.goto('/aluno/modulos?unidade=Apostila_NAO_EXISTE_9');
    await expect(page.getByRole('alert')).toContainText('não está liberada para a sua turma');
});
