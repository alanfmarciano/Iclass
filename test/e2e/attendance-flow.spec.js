const { test, expect } = require('@playwright/test');

async function loginAdmin(page) {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Administrador', exact: true }).click();
    // Seed + login assíncronos podem passar dos 5s padrão sob carga (ver visual-layout).
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
}

async function loginAdminAndEnterWorkspace(page) {
    await loginAdmin(page);
    const gate = page.getByRole('heading', { name: 'Selecione o curso e a turma' });
    if (await gate.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: /Entrar em .+, turma/ }).first().click();
    }
}

test.beforeEach(async ({ request }) => {
    await request.post('/api/test/seed');
});

test('[UC-PRESENCA-001] administrador consulta disciplinas e edita a grade da turma', async ({ page }) => {
    test.setTimeout(60000);
    await loginAdmin(page);
    await page.getByRole('link', { name: 'Cursos e turmas', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Cursos e turmas', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Disciplinas', exact: true }).click();
    const disciplinas = page.getByRole('dialog', { name: 'Disciplinas do curso' });
    await expect(disciplinas.getByLabel('Nome da disciplina')).toHaveCount(3);
    await expect(disciplinas.getByLabel('Nome da disciplina').first()).toHaveValue('Fundamentos de TI');
    await disciplinas.getByRole('button', { name: 'Cancelar', exact: true }).click();

    await page.getByRole('button', { name: 'Editar turma 1DES', exact: true }).click();
    const turma = page.getByRole('dialog', { name: 'Editar turma' });
    await expect(turma.getByRole('heading', { name: 'Presença e grade horária' })).toBeVisible();
    await expect(turma.getByLabel('Tolerância de atraso (min)')).toHaveValue('15');
    await expect(turma.getByLabel('Limiar de risco (%)')).toHaveValue('75');
    await expect(turma.getByLabel('Início da 1ª aula de Segunda')).toHaveValue('08:00');
    await expect(turma.getByLabel('Disciplina da 1ª aula de Segunda')).toHaveValue('FUTEC');
});

test('[UC-PRESENCA-002] chamada por aula salva justificativa abonada e a restaura', async ({ page }) => {
    await loginAdminAndEnterWorkspace(page);
    await page.getByRole('link', { name: 'Chamada', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chamada', exact: true })).toBeVisible();

    await page.getByLabel('Data').fill('2026-07-13');
    await expect(page.getByText('Aulas do dia:')).toBeVisible();
    await expect(page.getByText('Fundamentos de TI', { exact: false }).first()).toBeVisible();

    // A linha do aluno é o bloco que contém o grupo de status dele (independe do espaçamento da lista).
    const alice = page.locator('div.flex.flex-col.gap-2').filter({ has: page.getByRole('radiogroup', { name: 'Status de Alice Aluna' }) });
    await expect(alice).toHaveCount(1);
    // UI atual: status é um grupo de rádios; "abonar" é um botão que alterna o texto.
    await alice.getByRole('radio', { name: 'Justificado' }).click();
    await alice.getByPlaceholder('Justificativa, motivo, observações…').fill('Atestado conferido pela secretaria');
    await alice.getByRole('button', { name: 'Não abona falta' }).click();
    await expect(alice.getByRole('button', { name: 'Abona falta', exact: true })).toBeVisible();

    const saved = page.waitForResponse(response => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/admin/attendance/bulk'
    ));
    // UI atual: "Concluir chamada" abre um resumo e confirma no diálogo.
    await page.getByRole('button', { name: 'Concluir chamada', exact: true }).click();
    const conclusao = page.getByRole('dialog', { name: 'Concluir chamada?' });
    await expect(conclusao).toBeVisible();
    await conclusao.getByRole('button', { name: 'Concluir chamada', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect((await response.json()).saved).toBeGreaterThanOrEqual(12);

    await expect(alice.getByPlaceholder('Justificativa, motivo, observações…')).toHaveValue('Atestado conferido pela secretaria');
    await expect(alice.getByRole('button', { name: 'Abona falta', exact: true })).toBeVisible();
    await expect(alice.getByRole('radio', { name: 'Justificado' })).toHaveAttribute('aria-checked', 'true');
});
