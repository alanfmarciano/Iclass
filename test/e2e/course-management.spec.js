const { test, expect } = require('@playwright/test');

const LEGACY_COURSE = 'Curso Técnico em TI (Legado)';
const FUTURE_COURSE = 'Curso Herança E2E';
const FUTURE_CLASS = '3DES E2E';

async function saveAssignments(page, dialog) {
    const saved = page.waitForResponse(response => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/admin/teacher-assignments'
    ), { timeout: 60000 });
    await dialog.getByRole('button', { name: 'Salvar atribuições', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(dialog).toBeHidden({ timeout: 15000 });
}

test('[UC-CURSO-001] central gerencia heranças por escola e curso sem perder a turma específica', async ({ page, browser, request }) => {
    test.setTimeout(180000);
    await request.post('/api/test/seed');

    await page.goto('/login');
    await page.getByRole('button', { name: 'Administrador', exact: true }).click();
    // Seed + login assíncronos podem passar dos 5s padrão sob carga (ver visual-layout).
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
    await page.getByRole('link', { name: 'Cursos e turmas', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Cursos e turmas', exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('Buscar curso ou turma')).toBeVisible();
    await expect(page.getByLabel('Filtrar por escola')).toBeVisible();
    await expect(page.getByLabel('Filtrar por professor')).toBeVisible();
    await expect(page.getByLabel('Filtrar por status')).toBeVisible();
    await expect(page.getByLabel('Somente sem professor')).toBeVisible();

    // Atribuição ampla pela escola e herança em um curso criado depois do vínculo.
    await page.getByRole('button', { name: /Paulo Professor.*Turma específica/ }).click();
    let assignmentDialog = page.getByRole('dialog', { name: 'Atribuir professor' });
    await assignmentDialog.getByRole('checkbox', { name: /Escola inteira/ }).check();
    await saveAssignments(page, assignmentDialog);
    await expect(page.getByRole('button', { name: /Paulo Professor.*Escola.*Turma específica/ })).toBeVisible();

    await page.getByRole('button', { name: 'Novo curso', exact: true }).click();
    let courseDialog = page.getByRole('dialog', { name: 'Novo curso' });
    await courseDialog.getByLabel('Código do curso').fill('HERANCA_E2E');
    await courseDialog.getByLabel('Nome').fill(FUTURE_COURSE);
    await courseDialog.getByLabel('Descrição').fill('Curso temporário para validar herança por escola.');
    await courseDialog.getByLabel('Escola').selectOption({ label: 'IClass' });
    await courseDialog.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(courseDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: FUTURE_COURSE, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Paulo Professor.*Escola/ })).toBeVisible();

    // Remover o vínculo da escola não remove a atribuição específica existente em 1DES.
    await page.getByRole('button', { name: /Paulo Professor.*Escola/ }).click();
    assignmentDialog = page.getByRole('dialog', { name: 'Atribuir professor' });
    await assignmentDialog.getByRole('checkbox', { name: /Escola inteira/ }).uncheck();
    await saveAssignments(page, assignmentDialog);
    await expect(page.getByText('Nenhum professor atribuído.', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Excluir', exact: true }).click();
    let confirmDialog = page.getByRole('dialog', { name: 'Excluir curso?' });
    await confirmDialog.getByRole('button', { name: 'Excluir', exact: true }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: LEGACY_COURSE, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Paulo Professor.*Turma específica/ })).toBeVisible();

    // Atribuição pelo curso é herdada por turma criada depois do vínculo.
    await page.getByRole('button', { name: /Paulo Professor.*Turma específica/ }).click();
    assignmentDialog = page.getByRole('dialog', { name: 'Atribuir professor' });
    await assignmentDialog.getByRole('checkbox', { name: /Curso inteiro/ }).check();
    await saveAssignments(page, assignmentDialog);

    await page.getByRole('button', { name: 'Nova turma', exact: true }).click();
    const classDialog = page.getByRole('dialog', { name: 'Nova turma' });
    await classDialog.getByLabel('Nome da turma').fill(FUTURE_CLASS);
    await classDialog.getByLabel('Período').selectOption('Noite');
    await classDialog.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(classDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: FUTURE_CLASS, exact: true })).toBeVisible();
    await expect(page.getByText('· Curso', { exact: true })).toHaveCount(3);

    await page.getByRole('button', { name: /Paulo Professor.*Curso.*Turma específica/ }).click();
    assignmentDialog = page.getByRole('dialog', { name: 'Atribuir professor' });
    await assignmentDialog.getByRole('checkbox', { name: /Curso inteiro/ }).uncheck();
    await saveAssignments(page, assignmentDialog);
    await expect(page.getByText('· Turma específica', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Sem professor', { exact: true })).toHaveCount(2);

    // Um curso com duas turmas gera dois contextos independentes e o card inteiro entra na turma.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Selecione o curso e a turma', exact: true })).toBeVisible();
    const firstClassCards = page.getByRole('button', { name: `Entrar em ${LEGACY_COURSE}, turma 1DES`, exact: true });
    const futureClassCards = page.getByRole('button', { name: `Entrar em ${LEGACY_COURSE}, turma ${FUTURE_CLASS}`, exact: true });
    // Espera os cartões: eles chegam depois do título quando a máquina está carregada.
    await expect(firstClassCards.first()).toBeVisible();
    await expect(futureClassCards.first()).toBeVisible();
    // O gate atual também pode repetir um contexto na seção "Recentes".
    await futureClassCards.last().click();
    await expect(page.getByTitle('Trocar curso ou turma')).toContainText(FUTURE_CLASS);

    await page.goto('/turmas');
    await page.getByRole('button', { name: `Excluir turma ${FUTURE_CLASS}`, exact: true }).click();
    confirmDialog = page.getByRole('dialog', { name: 'Excluir turma?' });
    await confirmDialog.getByRole('button', { name: 'Excluir', exact: true }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: FUTURE_CLASS, exact: true })).toHaveCount(0);

    // Em outra sessão, o professor continua vendo somente o curso da sua turma específica.
    const professorContext = await browser.newContext();
    const professorPage = await professorContext.newPage();
    await professorPage.goto('/login');
    await professorPage.getByRole('button', { name: 'Professor', exact: true }).click();
    await expect(professorPage.getByRole('heading', { name: 'Selecione o curso e a turma', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(professorPage.getByRole('heading', { name: LEGACY_COURSE, exact: true })).toBeVisible();
    await expect(professorPage.getByRole('button', { name: `Entrar em ${LEGACY_COURSE}, turma 1DES`, exact: true })).toHaveCount(1);
    await professorPage.goto('/turmas');
    await expect(professorPage.getByRole('heading', { name: 'Cursos e turmas', exact: true })).toBeVisible();
    await expect(professorPage.getByRole('button', { name: 'Novo curso', exact: true })).toHaveCount(0);
    await expect(professorPage.getByRole('button', { name: 'Atribuir professor', exact: true })).toHaveCount(0);
    await professorContext.close();
});
