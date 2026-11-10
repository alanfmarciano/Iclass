const { test, expect } = require('@playwright/test');

// Prova com "Cronômetro ativo" desligado: o servidor manda o tempo restante sem valor e a
// tela lia isso como zero. A prova era enviada sozinha ("Tempo esgotado") assim que o
// aluno clicava em Iniciar ou reabria a tela. Com prazo, o envio automático no fim do
// tempo continua igual.
const ADMIN_LOGIN = { Authorization: 'admin@teste.local:teste' };
const CLASS = '1DES';
const COURSE = 'curso_legacy_01';
const EXAM = 'Avaliacao_FUTEC_5';

// Uma conferência de senha por teste (whoami) e depois a sessão: cada chamada com
// e-mail:senha conta no limite de logins por minuto e derrubava o spec seguinte (429).
async function adminSession(request) {
    const who = await request.get('/api/admin/whoami', { headers: ADMIN_LOGIN });
    expect(who.status()).toBe(200);
    return { 'x-admin-session': (await who.json()).sessionToken };
}

async function startApplication(request, admin, { label, timerEnabled, durationMinutes = 40, maxAttempts = 1 }) {
    const apps = await (await request.get('/api/admin/exam-applications', { headers: admin })).json();
    const seed = apps.applications.find(item => item.historyId === 'seed_history_futec_5');
    const snapshot = seed.versionSnapshots[0];
    const history = await request.post('/api/admin/exam-history/add', {
        headers: admin,
        data: {
            studentClass: CLASS, courseId: COURSE, examKey: EXAM, type: 'online', label,
            questionNumbers: snapshot.questions.slice(0, 3).map(question => question.originalNumber),
            printSnapshot: [{ version: 'A', questions: snapshot.questions.slice(0, 3) }],
            durationMinutes, waitingRoomMinutes: 0, maxAttempts, timerEnabled,
        },
    });
    expect(history.status()).toBe(200);
    const created = await request.post('/api/admin/exam-applications', {
        headers: admin,
        data: {
            studentClass: CLASS, courseId: COURSE, examKey: EXAM, historyId: (await history.json()).entry.id,
            applicationOptions: { timerMode: 'per_attempt', durationMinutes, maxAttempts, waitingRoomDuration: 0, tokenEnabled: false, timerEnabled },
        },
    });
    expect(created.status()).toBe(201);
    const applicationId = (await created.json()).application.id;
    const started = await request.post(`/api/admin/exam-applications/${applicationId}/control`, { headers: admin, data: { action: 'start' } });
    expect(started.status()).toBe(200);
    return applicationId;
}

async function finishApplication(request, admin, applicationId) {
    await request.post(`/api/admin/exam-applications/${applicationId}/control`, { headers: admin, data: { action: 'finish', inProgressPolicy: 'discard' } });
}

async function monitorRow(request, admin, applicationId, email) {
    const response = await request.get(`/api/admin/monitor-status/${CLASS}/${EXAM}?courseId=${COURSE}&applicationId=${applicationId}`, { headers: admin });
    expect(response.status()).toBe(200);
    return (await response.json()).find(row => row.email === email);
}

async function studentPage(browser, { email, password = 'teste' }) {
    const context = await browser.newContext();
    // O Chromium sem interface não garante a API de tela cheia: só essa fronteira do
    // navegador é emulada (como em exam-flow.spec.js).
    await context.addInitScript(() => {
        let fullscreenElement = null;
        const emitChange = () => document.dispatchEvent(new Event('fullscreenchange'));
        Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
        Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: async function requestFullscreen() { fullscreenElement = this; emitChange(); } });
        Object.defineProperty(Document.prototype, 'exitFullscreen', { configurable: true, value: async function exitFullscreen() { fullscreenElement = null; emitChange(); } });
    });
    const page = await context.newPage();
    const submits = [];
    page.on('request', req => {
        if (new URL(req.url()).pathname === '/api/student/submit') submits.push(JSON.parse(req.postData() || '{}'));
    });
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill(password);
    await page.getByRole('button', { name: 'Entrar como aluno' }).click();
    await expect(page).toHaveURL(/\/aluno/, { timeout: 15000 });
    return { context, page, submits };
}

test('[UC-TENTATIVA-002] prova com "Cronômetro ativo" desligado fica aberta, sem cronômetro, e o envio é do aluno', async ({ browser, request }) => {
    test.setTimeout(90000);
    await request.post('/api/test/seed');
    const admin = await adminSession(request);
    const applicationId = await startApplication(request, admin, { label: 'Sem cronômetro', timerEnabled: false });
    const { context, page, submits } = await studentPage(browser, { email: 'aluno@teste.local' });
    try {
        await page.goto(`/aluno/prova/${EXAM}?applicationId=${applicationId}`);
        await expect(page.getByRole('heading', { name: 'Instruções da prova' })).toBeVisible();
        await expect(page.getByText('Sem tempo limite', { exact: true })).toBeVisible();
        await expect(page.getByText('Desligado', { exact: true })).toBeVisible();
        await page.getByLabel('Li as instruções e estou pronto para iniciar esta tentativa.').check();
        await page.getByRole('button', { name: 'Iniciar prova' }).click();
        await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible();

        // Pelo menos 10 s aberta (mais de duas sincronizações), sem cronômetro e sem envio.
        await page.waitForTimeout(10500);
        expect(submits, 'nada foi enviado sozinho depois de Iniciar').toEqual([]);
        await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible();
        await expect(page.locator('[title="Tempo restante"]')).toHaveCount(0);
        await expect(page.getByText('Tempo esgotado')).toHaveCount(0);

        // Reabrir a tela com a tentativa já iniciada (o caso do revisor) também não envia.
        await page.reload();
        await expect(page.getByRole('button', { name: /^(Enviar|Voltar à tela cheia)$/ }).first()).toBeVisible({ timeout: 15000 });
        const resume = page.getByRole('button', { name: 'Voltar à tela cheia', exact: true });
        if (await resume.isVisible().catch(() => false)) await resume.click();
        await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(5000);
        expect(submits, 'nada foi enviado sozinho depois de reabrir a tela').toEqual([]);
        await expect(page.locator('[title="Tempo restante"]')).toHaveCount(0);

        const groups = page.locator('div.space-y-2.pl-9');
        const count = await groups.count();
        expect(count).toBeGreaterThan(0);
        for (let index = 0; index < count; index += 1) await groups.nth(index).getByRole('button').first().click();
        await expect(page.getByText(`${count}/${count} respondidas`)).toBeVisible();
        await page.getByRole('button', { name: 'Enviar', exact: true }).click();
        await page.getByRole('button', { name: 'Enviar prova', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Prova enviada!' })).toBeVisible();
        await expect(page.getByText(/O tempo acabou/)).toHaveCount(0);
        expect(submits).toHaveLength(1);
        expect(submits[0].auto).toBe(false);

        const row = await monitorRow(request, admin, applicationId, 'aluno@teste.local');
        expect(row.status).toBe('finished');
        expect(row.submissionSource, 'o motivo gravado é o envio do aluno').toBe('student');
    } finally {
        await context.close();
        await finishApplication(request, admin, applicationId);
    }
});

test('[UC-TENTATIVA-002] com prazo curto o envio automático no fim do tempo continua', async ({ browser, request }) => {
    test.setTimeout(90000);
    await request.post('/api/test/seed');
    const admin = await adminSession(request);
    const applicationId = await startApplication(request, admin, { label: 'Prazo curto', timerEnabled: true, durationMinutes: 1 });
    // 1 min de prova e -0,75 min para este aluno antes de ele começar: 15 s de prazo.
    const adjusted = await request.post('/api/admin/adjust-student-time', {
        headers: admin,
        data: { studentClass: CLASS, courseId: COURSE, examKey: EXAM, applicationId, targetEmail: 'bruno.souza@teste.local', adjustmentMinutes: -0.75 },
    });
    expect(adjusted.status()).toBe(200);
    const { context, page, submits } = await studentPage(browser, { email: 'bruno.souza@teste.local' });
    try {
        await page.goto(`/aluno/prova/${EXAM}?applicationId=${applicationId}`);
        await page.getByLabel('Li as instruções e estou pronto para iniciar esta tentativa.').check();
        await page.getByRole('button', { name: 'Iniciar prova' }).click();
        await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeVisible();
        await expect(page.locator('[title="Tempo restante"]')).toHaveText(/00:1\d|00:0\d/);
        await page.locator('div.space-y-2.pl-9').first().getByRole('button').first().click();
        expect(submits, 'antes do fim do tempo nada é enviado').toEqual([]);

        await expect(page.getByRole('heading', { name: 'Prova enviada!' })).toBeVisible({ timeout: 30000 });
        await expect(page.getByText(/O tempo acabou e suas respostas foram enviadas automaticamente/)).toBeVisible();
        expect(submits.filter(body => body.auto === true)).toHaveLength(1);
        const row = await monitorRow(request, admin, applicationId, 'bruno.souza@teste.local');
        expect(row.submissionSource).toBe('timer_auto_submit');
    } finally {
        await context.close();
        await finishApplication(request, admin, applicationId);
    }
});
