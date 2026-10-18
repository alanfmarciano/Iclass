const { test, expect } = require('@playwright/test');

// Cabeçalho da prova com zoom de 200% num celular de 390 px: a tela tem 195 px CSS
// (UXA-03, ACS-16). Antes o Enviar e o cronômetro passavam da borda da tela (cortados)
// e a contagem "0/4 respondidas" ficava embaixo dos botões Sair e Mensagens.
const ADMIN = { Authorization: 'admin@teste.local:teste' };
const CLASS = '1DES';
const COURSE = 'curso_legacy_01';
const EXAM = 'Avaliacao_FUTEC_5';

async function startPerAttemptApplication(request) {
    const apps = await (await request.get('/api/admin/exam-applications', { headers: ADMIN })).json();
    const seed = apps.applications.find(item => item.historyId === 'seed_history_futec_5');
    const snapshot = seed.versionSnapshots[0];
    const history = await request.post('/api/admin/exam-history/add', {
        headers: ADMIN,
        data: {
            studentClass: CLASS, courseId: COURSE, examKey: EXAM, type: 'online', label: 'Zoom 200%',
            questionNumbers: snapshot.questions.map(question => question.originalNumber),
            printSnapshot: [{ version: 'A', questions: snapshot.questions }],
            durationMinutes: 40, waitingRoomMinutes: 0, maxAttempts: 1,
        },
    });
    expect(history.status()).toBe(200);
    const created = await request.post('/api/admin/exam-applications', {
        headers: ADMIN,
        data: {
            studentClass: CLASS, courseId: COURSE, examKey: EXAM, historyId: (await history.json()).entry.id,
            applicationOptions: { timerMode: 'per_attempt', durationMinutes: 40, maxAttempts: 1, waitingRoomDuration: 0, tokenEnabled: false },
        },
    });
    expect(created.status()).toBe(201);
    const applicationId = (await created.json()).application.id;
    const started = await request.post(`/api/admin/exam-applications/${applicationId}/control`, { headers: ADMIN, data: { action: 'start' } });
    expect(started.status()).toBe(200);
    return applicationId;
}

test('[UC-PROVA-003] cabeçalho da prova com zoom de 200% num celular de 390 px (195 px CSS): Enviar e cronômetro inteiros, nada sobreposto', async ({ browser, request }) => {
    test.setTimeout(60000);
    await request.post('/api/test/seed');
    const applicationId = await startPerAttemptApplication(request);
    const context = await browser.newContext({ viewport: { width: 195, height: 422 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
        await page.goto('/login');
        await page.getByLabel('E-mail').fill('aluno@teste.local');
        await page.getByLabel('Senha').fill('teste');
        await page.getByRole('button', { name: 'Entrar como aluno' }).click();
        await expect(page).toHaveURL(/\/aluno/, { timeout: 15000 });
        await page.goto(`/aluno/prova/${EXAM}?applicationId=${applicationId}`);
        await page.getByLabel('Li as instruções e estou pronto para iniciar esta tentativa.').check();
        await page.getByRole('button', { name: 'Iniciar prova' }).click();
        const send = page.getByRole('button', { name: 'Enviar', exact: true });
        await expect(send).toBeVisible();

        const layout = await page.evaluate(() => {
            const width = document.documentElement.clientWidth;
            const header = document.querySelector('.sticky.top-0');
            const box = element => element.getBoundingClientRect();
            const timer = header.querySelector('[title="Tempo restante"]');
            const counter = [...header.querySelectorAll('p')].find(element => /respondidas/.test(element.textContent));
            const items = [
                ['título', header.querySelector('h1')],
                ['contagem', counter],
                ['cronômetro', timer],
                ...[...header.querySelectorAll('button')].map(button => [button.getAttribute('aria-label') || button.textContent.trim(), button]),
            ];
            const outside = items.filter(([, element]) => box(element).left < 0 || box(element).right > width + 0.5).map(([name]) => name);
            const overlaps = [];
            items.forEach(([nameA, a], index) => items.slice(index + 1).forEach(([nameB, b]) => {
                const A = box(a); const B = box(b);
                if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) overlaps.push(`${nameA} x ${nameB}`);
            }));
            const alternativesOutside = [...document.querySelectorAll('button[aria-pressed]')].filter(button => {
                const card = button.closest('.space-y-2').parentElement;
                return box(button).right > box(card).right + 0.5 || box(button).left < box(card).left - 0.5;
            }).length;
            return {
                width,
                pageScroll: document.documentElement.scrollWidth,
                outside,
                overlaps,
                timerCut: timer.scrollWidth > timer.clientWidth + 1,
                timerText: timer.textContent.trim(),
                alternatives: document.querySelectorAll('button[aria-pressed]').length,
                alternativesOutside,
            };
        });
        expect(layout.width).toBe(195);
        expect(layout.pageScroll).toBeLessThanOrEqual(195);
        expect(layout.outside, 'nada do cabeçalho passa da borda da tela').toEqual([]);
        expect(layout.overlaps, 'nada sobreposto no cabeçalho').toEqual([]);
        expect(layout.timerCut).toBe(false);
        expect(layout.timerText).toMatch(/^\d{1,2}:\d{2}(:\d{2})?$/);
        expect(layout.alternatives).toBeGreaterThan(0);
        expect(layout.alternativesOutside, 'alternativas dentro do cartão').toBe(0);
    } finally {
        await context.close();
        await request.post(`/api/admin/exam-applications/${applicationId}/control`, { headers: ADMIN, data: { action: 'finish', inProgressPolicy: 'discard' } });
    }
});
