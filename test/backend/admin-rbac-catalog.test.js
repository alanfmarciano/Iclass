const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveAdminApiPermission } = require('../../backend/utils/adminPermissions.js');

test('toda rota /api/admin possui uma decisão RBAC explícita', () => {
    const routesDir = path.join(__dirname, '..', '..', 'backend', 'routes');
    const missing = [];
    for (const filename of fs.readdirSync(routesDir).filter(name => name.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(routesDir, filename), 'utf8');
        const routePattern = /router\.(get|post|put|delete)\(\s*['"](\/api\/admin[^'"]*)['"]/g;
        let match;
        while ((match = routePattern.exec(source))) {
            const method = match[1].toUpperCase();
            const route = match[2].replace('/api/admin', '') || '/';
            const example = route.replace(/:[^/]+/g, 'example');
            if (resolveAdminApiPermission(method, example) === undefined) missing.push(`${method} ${route} (${filename})`);
        }
    }
    assert.deepEqual(missing, [], `Rotas sem RBAC:\n${missing.join('\n')}`);
});

test('rotas extraídas ficam nos módulos administrativos dedicados', () => {
    const routesDir = path.join(__dirname, '..', '..', 'backend', 'routes');
    const adminSource = fs.readFileSync(path.join(routesDir, 'admin.js'), 'utf8');
    const recoverySource = fs.readFileSync(path.join(routesDir, 'adminRecovery.js'), 'utf8');
    const archiveSource = fs.readFileSync(path.join(routesDir, 'adminArchive.js'), 'utf8');
    const systemSource = fs.readFileSync(path.join(routesDir, 'adminSystem.js'), 'utf8');
    const accountsSource = fs.readFileSync(path.join(routesDir, 'adminAccounts.js'), 'utf8');
    const examConfigSource = fs.readFileSync(path.join(routesDir, 'adminExamConfig.js'), 'utf8');

    ['/api/admin/trash', '/api/admin/backup/data', '/api/admin/backup/full', '/api/admin/backup/restore'].forEach(route => {
        assert.equal(adminSource.includes(`'${route}'`), false, `${route} ainda está no router monolítico`);
        assert.equal(recoverySource.includes(`'${route}'`), true, `${route} não foi extraída para adminRecovery`);
    });
    ['/api/admin/courses/:id/purge', '/api/admin/archived-courses'].forEach(route => {
        assert.equal(adminSource.includes(`'${route}'`), false, `${route} ainda está no router monolítico`);
        assert.equal(archiveSource.includes(`'${route}'`), true, `${route} não foi extraída para adminArchive`);
    });
    ['/api/admin/config', '/api/admin/flush-exam-state', '/api/admin/server/restart', '/api/admin/reset', '/api/admin/settings'].forEach(route => {
        assert.equal(adminSource.includes(`'${route}'`), false, `${route} ainda está no router monolítico`);
        assert.equal(systemSource.includes(`'${route}'`), true, `${route} não foi extraída para adminSystem`);
    });
    ['/api/admin/accounts', '/api/admin/whoami', '/api/admin/change-password', '/api/admin/preferences', '/api/session/logout'].forEach(route => {
        assert.equal(adminSource.includes(`'${route}'`), false, `${route} ainda está no router monolítico`);
        assert.equal(accountsSource.includes(`'${route}'`), true, `${route} não foi extraída para adminAccounts`);
    });
    ['/api/admin/exam-config', '/api/admin/online-exam-config', '/api/admin/release-item', '/api/admin/exam-history'].forEach(route => {
        assert.equal(adminSource.includes(`'${route}'`), false, `${route} ainda está no router monolítico`);
        assert.equal(examConfigSource.includes(`'${route}'`), true, `${route} não foi extraída para adminExamConfig`);
    });
});
