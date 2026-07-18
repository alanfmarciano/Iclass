const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './test/e2e',
    timeout: 30000,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    // Os cenários usam o mesmo servidor e a mesma base temporária; não podem alterar o seed em paralelo.
    workers: 1,
    outputDir: 'test-results/playwright',
    reporter: [
        ['line'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ],
    expect: {
        toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 },
    },
    use: {
        baseURL: 'http://127.0.0.1:3132',
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    webServer: {
        command: 'node test/e2e/start-test-server.js',
        url: 'http://127.0.0.1:3132/api/test-mode',
        reuseExistingServer: false,
        timeout: 60000,
    },
});
