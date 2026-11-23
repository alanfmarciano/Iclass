const { test, expect } = require('@playwright/test');

async function loginAdmin(page) {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Administrador', exact: true }).click();
    // Seed + login assíncronos podem passar dos 5s padrão sob carga (ver visual-layout).
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3132\/$/, { timeout: 15000 });
}

async function loginAdminAndEnterWorkspace(page) {
    await loginAdmin(page);
    // A escolha de curso e turma aparece depois que a lista de cursos chega: espera ela
    // ou o menu da turma antes de decidir (olhar uma vez só dependia do tempo do login).
    const gate = page.getByRole('heading', { name: 'Selecione o curso e a turma' });
    await expect(gate.or(page.getByRole('link', { name: 'Chamada', exact: true }))).toBeVisible({ timeout: 15000 });
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

// Dia não letivo pela tela (B7 / P2-S6, FUN-15): o professor cadastra um feriado para
// hoje no Calendário; o Dashboard deixa de cobrar a chamada e diz que hoje não tem aula, e
// a Chamada mostra a faixa no lugar da grade. A seed tem grade de segunda a sexta: no fim
// de semana a cobrança da chamada não existe antes, então só o "antes" muda de assert.
test('[UC-PRESENCA-005] feriado cadastrado hoje some do "Precisa de você" e a Chamada mostra a faixa', async ({ page, request }) => {
    test.setTimeout(90000);
    const { today } = await (await request.get('/api/settings/public')).json();
    const weekday = new Date(`${today}T12:00:00`).getDay();
    const diaDeAula = weekday >= 1 && weekday <= 5;

    await loginAdminAndEnterWorkspace(page);
    const pendente = page.getByText('Chamada de hoje não lançada');
    if (diaDeAula) await expect(pendente).toBeVisible({ timeout: 15000 });

    await page.getByRole('link', { name: 'Calendário', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Calendário', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Dia não letivo', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Novo dia não letivo' });
    await dialog.getByLabel('Nome').fill('Feriado municipal de teste');
    await dialog.getByLabel('Data (ou início)').fill(today);
    await expect(dialog.getByLabel('Para quem vale')).toHaveValue('turma');
    const saved = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/admin/calendar/non-school-days/create');
    await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(dialog).toBeHidden();
    const lista = page.getByRole('list', { name: 'Feriados e recessos deste mês' });
    await expect(lista.getByText('Feriado municipal de teste')).toBeVisible();
    await expect(page.locator(`[data-date="${today}"]`)).toHaveAttribute('data-sem-aula', 'true');

    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Agora' }).getByText(/Hoje não tem aula: Feriado municipal de teste/)).toBeVisible({ timeout: 15000 });
    await expect(pendente).toHaveCount(0);

    await page.getByRole('link', { name: 'Chamada', exact: true }).click();
    await expect(page.getByLabel('Data')).toHaveValue(today);
    await expect(page.getByText('Não há aula neste dia: Feriado municipal de teste')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Concluir chamada', exact: true })).toHaveCount(0);
    if (diaDeAula) await expect(page.getByRole('button', { name: 'Fazer a chamada mesmo assim' })).toBeVisible();

    // No celular (375 px) o Calendário vira lista por dia e a página não rola para o lado.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/calendario');
    await expect(page.getByRole('list', { name: /^Dias de / })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('list', { name: /^Dias de / }).getByText('Sem aula').first()).toBeVisible();
    const scroll = await page.evaluate(() => document.scrollingElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(375);
});
