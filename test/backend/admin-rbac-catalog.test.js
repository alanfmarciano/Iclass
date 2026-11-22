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
    // Endereço da sala (H6a): network-info saiu de common.js e room-address nasceu ali.
    const commonSource = fs.readFileSync(path.join(routesDir, 'common.js'), 'utf8');
    ['/api/admin/network-info', '/api/admin/room-address'].forEach(route => {
        assert.equal(commonSource.includes(`'${route}'`), false, `${route} ainda está em common.js`);
        assert.equal(systemSource.includes(`'${route}'`), true, `${route} não está em adminSystem`);
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
    // Banco de questões (fase 3, P3-S9a): router próprio, montado depois do de cursos.
    const questionBankSource = fs.readFileSync(path.join(routesDir, 'adminQuestionBank.js'), 'utf8');
    ['/api/admin/question-bank', '/api/admin/question-bank/create', '/api/admin/question-bank/update', '/api/admin/question-bank/archive', '/api/admin/question-bank/import-evaluation', '/api/admin/question-bank/delete'].forEach(route => {
        assert.equal(adminSource.includes(`'${route}'`), false, `${route} ainda está no router monolítico`);
        assert.equal(questionBankSource.includes(`'${route}'`), true, `${route} não foi extraída para adminQuestionBank`);
    });
    assert.ok(adminSource.indexOf('router.use(createAdminQuestionBankRouter())') > adminSource.indexOf('router.use(createAdminCoursesRouter())'), 'o banco vem depois do router de cursos (ordem_no_createApp)');
    // Tarefas (fase 3, C4 / P1-b): router próprio, nunca no admin.js.
    const assignmentsSource = fs.readFileSync(path.join(routesDir, 'adminAssignments.js'), 'utf8');
    ['/api/admin/assignments', '/api/admin/assignments/:id', '/api/admin/assignments/:id/copy'].forEach(route => {
        assert.equal(adminSource.includes(`'${route}'`), false, `${route} está no router monolítico`);
        assert.equal(assignmentsSource.includes(`'${route}'`), true, `${route} não está em adminAssignments`);
    });
});

// ---------------------------------------------------------------- fase 3 (B0b)
// Permissões e regras das rotas novas da fase 3 (seção rbac do plano), que entram antes
// das rotas. Cada linha: método, um caminho de exemplo e a permissão que o guarda pede.
// As que já caem numa regra de antes (diário, importar notas, correção da entrega,
// agenda e participantes da prova, banco de questões, recuperar entregas) ficam na
// tabela para provar que a regra de antes decide o certo.
const {
    ADMIN_PERMISSION_VALUES,
    PROFESSOR_DEFAULT_PERMISSIONS,
    rolePermissionDefaults,
    roleGrantablePermissions,
    canAccessAdminPermission,
    parseAdditionalPermissions,
    resolveAdminApiExtraPermission,
} = require('../../backend/utils/adminPermissions.js');

const PHASE3_ROUTES = [
    // P1 Tarefas
    ['GET', '/assignments', 'page.assignments'],
    ['POST', '/assignments', 'page.assignments'],
    ['GET', '/assignments/asg_1_abcdef', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/update', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/publish', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/archive', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/unarchive', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/delete', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/copy', 'page.assignments'],
    ['GET', '/assignments/asg_1_abcdef/submissions/asub_1_abcdef', 'page.assignments'],
    ['GET', '/assignments/asg_1_abcdef/files/arq_1', 'page.assignments'],
    ['GET', '/assignments/asg_1_abcdef/export', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/grade', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/return-all', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/extension', 'page.assignments'],
    ['POST', '/assignments/asg_1_abcdef/manual-entry', 'page.assignments'],
    ['POST', '/backup/entregas/recuperar', 'system.manage'],
    // P2 Notas e calendário
    ['GET', '/grading/criteria', 'page.results'],
    ['POST', '/grading/criteria', 'course.manage'],
    ['POST', '/grading/preview', 'page.results'],
    ['GET', '/grading/plan', 'page.results'],
    ['POST', '/grading/plan', 'page.results'],
    ['POST', '/grading/manual-items/create', 'page.results'],
    ['POST', '/grading/manual-items/update', 'page.results'],
    ['POST', '/grading/manual-items/archive', 'page.results'],
    ['POST', '/grading/manual-items/restore', 'page.results'],
    ['GET', '/academic/terms', 'page.dashboard'],
    ['POST', '/academic/terms/create', 'classes.manage'],
    ['POST', '/academic/terms/update', 'classes.manage'],
    ['POST', '/academic/terms/close', 'classes.manage'],
    ['POST', '/academic/terms/reopen', 'classes.manage'],
    ['POST', '/class/close', 'classes.manage'],
    ['POST', '/class/reopen', 'classes.manage'],
    ['GET', '/calendar/non-school-days', 'page.forum'],
    ['POST', '/calendar/non-school-days/create', 'page.forum'],
    ['POST', '/calendar/non-school-days/update', 'page.forum'],
    ['POST', '/calendar/non-school-days/delete', 'page.forum'],
    ['POST', '/calendar/non-school-days/national-holidays', 'page.forum'],
    ['GET', '/calendar/ics', 'page.forum'],
    // P3 Correção, Monitor e agenda
    ['GET', '/corrections', 'page.results'],
    ['GET', '/submissions/sub_1/correction', 'page.results'],
    ['POST', '/submissions/sub_1/correction', 'page.results'],
    ['POST', '/submissions/sub_1/review-requests/rev_1_abcdef/answer', 'page.results'],
    ['POST', '/exam-applications/app_1/attempt-action', 'page.monitor'],
    ['GET', '/exam-applications/app_1/access-token', 'page.monitor'],
    // Recorrige as notas: page.results (o professor auxiliar não muda nota).
    ['POST', '/exam-applications/app_1/answer-key-correction', 'page.results'],
    ['POST', '/exam-applications/app_1/schedule', 'page.exams'],
    ['POST', '/exam-applications/app_1/participants', 'page.exams'],
    ['GET', '/exam-applications/participant-candidates', 'page.exams'],
    ['POST', '/question-bank/archive', 'page.exams'],
    ['POST', '/question-bank/import/preview', 'page.exams'],
    ['POST', '/question-bank/import', 'page.exams'],
    ['GET', '/question-bank/export', 'page.exams'],
    // P4 Secretaria
    ['GET', '/attendance/diary', 'page.students'],
    ['POST', '/attendance/diary', 'page.students'],
    ['GET', '/attendance/diary/month', 'page.students'],
    ['GET', '/reports', 'reports.view'],
    ['GET', '/reports/frequencia-turma', 'reports.view'],
    ['GET', '/reports/report-cards', 'reports.view'],
    ['GET', '/reports/responsaveis-a-avisar', 'reports.view'],
    ['GET', '/students/import/template', 'students.import'],
    ['POST', '/students/import', 'students.import'],
    ['POST', '/submissions/import', 'page.results'],
    ['GET', '/certificates', 'students.certificates'],
    ['POST', '/certificates/issue', 'students.certificates'],
    ['POST', '/certificates/issue-batch', 'students.certificates'],
    ['POST', '/certificates/revoke', 'students.certificates'],
    ['GET', '/certificates/cert_1/document', 'students.certificates'],
    ['POST', '/account/profile', 'page.dashboard'],
    ['POST', '/account/end-other-sessions', 'page.dashboard'],
    ['POST', '/accounts/reset-password', 'accounts.manage'],
    ['GET', '/students/by-id/alu_0123456789abcdef', 'page.students'],
    ['POST', '/students/merge/preview', 'students.merge'],
    ['POST', '/students/merge', 'students.merge'],
    ['GET', '/courses/curso_a/package', 'course.manage'],
    ['POST', '/course-packages/preview', 'course.manage'],
    ['POST', '/course-packages/import', 'course.manage'],
    // P5 Alunos e comunicação
    ['GET', '/class-groups', 'page.students'],
    ['POST', '/class-groups', 'page.students'],
    ['POST', '/class-groups/grp_1_abcdef/update', 'page.students'],
    ['POST', '/class-groups/grp_1_abcdef/archive', 'page.students'],
    ['POST', '/class-groups/grp_1_abcdef/restore', 'page.students'],
    ['POST', '/class-groups/draw', 'page.students'],
    ['POST', '/preview-sessions', ['page.materials', 'page.classes']],
    ['POST', '/preview-sessions/end', ['page.materials', 'page.classes']],
    ['GET', '/conversations', 'page.messages'],
    ['POST', '/conversations', 'page.messages'],
    ['GET', '/conversations/conv_1_abcdef/messages', 'page.messages'],
    ['POST', '/conversations/conv_1_abcdef/messages', 'page.messages'],
    ['POST', '/conversations/conv_1_abcdef/read', 'page.messages'],
    ['POST', '/conversations/conv_1_abcdef/close', 'page.messages'],
    ['POST', '/conversations/conv_1_abcdef/reopen', 'page.messages'],
    ['POST', '/conversations/conv_1_abcdef/admin-open', 'messages.readAll'],
    ['GET', '/guardian-notices/student', 'page.students'],
    ['GET', '/guardian-notices/class', 'page.students'],
    ['GET', '/guardian-contacts', 'page.students'],
    ['POST', '/guardian-contacts', 'page.students'],
    ['POST', '/guardian-contacts/batch', 'page.students'],
    // P6 Instalação
    ['GET', '/system/about', 'page.system'],
    ['GET', '/setup/checklist', 'page.dashboard'],
    ['POST', '/setup/wizard', 'system.manage'],
    ['POST', '/setup/example-course', 'course.manage'],
];

test('fase 3: toda rota nova já desenhada tem a decisão RBAC do plano, também com outra caixa e barra no fim', () => {
    const wrong = [];
    for (const [method, route, expected] of PHASE3_ROUTES) {
        for (const variant of [route, `${route}/`, route.toUpperCase(), `${route}?courseId=curso_a`]) {
            const got = resolveAdminApiPermission(method, variant);
            try { assert.deepEqual(got, expected); } catch (e) { wrong.push(`${method} ${variant}: ${JSON.stringify(got)} (esperado ${JSON.stringify(expected)})`); }
        }
    }
    assert.deepEqual(wrong, [], wrong.join('\n'));
});

test('fase 3: regra específica vem antes da genérica (as regras de antes não mudaram)', () => {
    // Vizinhas das regras novas: continuam decidindo o mesmo que antes do B0b.
    const unchanged = [
        ['POST', '/exam-applications/app_1/access-token', ['page.monitor', 'page.exams']],
        ['GET', '/exam-applications/app_1/audit', 'page.results'],
        ['GET', '/exam-applications/app_1', 'page.exams'],
        ['POST', '/exam-applications/app_1/finish', 'page.exams'],
        ['POST', '/exam-applications', 'page.exams'],
        ['GET', '/students', 'page.students'],
        ['GET', '/students/closed', 'students.destroy'],
        ['POST', '/students/anonymize', 'students.destroy'],
        ['POST', '/student/update', 'students.edit'],
        ['POST', '/student/certificates/issue', 'students.certificates'],
        ['GET', '/accounts', 'page.accounts'],
        ['POST', '/accounts/create', 'accounts.manage'],
        ['POST', '/class/create', 'classes.manage'],
        ['POST', '/class/toggle-registration', 'classes.manage'],
        ['GET', '/courses/curso_a/structure', 'page.editor'],
        ['PUT', '/courses/curso_a', 'course.manage'],
        ['GET', '/announcements/calendar', 'page.forum'],
        ['GET', '/system/health', 'page.system'],
        ['GET', '/attendance/roster', 'page.students'],
        ['GET', '/submissions', 'page.results'],
    ];
    for (const [method, route, expected] of unchanged) assert.deepEqual(resolveAdminApiPermission(method, route), expected, `${method} ${route}`);
    // Sem regra continua sem regra (só o administrador pleno passa): caminhos parecidos
    // com os novos que nenhum desenho pediu.
    for (const [method, route] of [
        ['DELETE', '/assignments/asg_1'],
        ['GET', '/students/merge-extra'],
        ['POST', '/account/delete'],
        ['POST', '/course-packages/export'],
        ['GET', '/courses/curso_a/package/extra'],
        ['POST', '/setup/checklist'],
        ['POST', '/system/about'],
        ['GET', '/accounts/reset-password'],
        ['POST', '/class/archive'],
        ['POST', '/guardian-notices/student'],
    ]) assert.equal(resolveAdminApiPermission(method, route), undefined, `${method} ${route}`);
});

test('fase 3: valores novos de permissão e quem recebe cada um pelo papel', () => {
    const novos = ['page.assignments', 'page.messages', 'messages.readAll', 'reports.view', 'students.import', 'enrollments.approve', 'students.merge'];
    for (const value of novos) assert.ok(ADMIN_PERMISSION_VALUES.includes(value), value);
    assert.equal(new Set(ADMIN_PERMISSION_VALUES).size, ADMIN_PERMISSION_VALUES.length, 'sem valor repetido');
    // Os de antes continuam na mesma ordem, no começo da lista (a ordem da sessão não muda).
    assert.deepEqual(ADMIN_PERMISSION_VALUES.slice(0, 25), [
        'page.dashboard', 'page.exams', 'page.monitor', 'page.results', 'page.materials', 'page.editor', 'page.classes',
        'page.students', 'page.accounts', 'page.forum', 'page.branding', 'page.system', 'course.manage', 'classes.manage',
        'accounts.manage', 'branding.manage', 'system.manage', 'students.destroy', 'students.certificates',
        'students.security', 'schools.scope', 'course.purge', 'forum.purge', 'audit.view', 'students.edit',
    ]);
    const has = (role, permission) => rolePermissionDefaults(role).includes(permission);
    // Professor: ganha Tarefas, Mensagens, Relatórios e importar alunos sem migração.
    for (const permission of ['page.assignments', 'page.messages', 'reports.view', 'students.edit', 'students.import']) {
        assert.ok(PROFESSOR_DEFAULT_PERMISSIONS.includes(permission), `professor sem ${permission}`);
    }
    for (const permission of ['messages.readAll', 'students.merge', 'enrollments.approve', 'students.certificates']) {
        assert.equal(has('professor', permission), false, `professor com ${permission}`);
        assert.equal(roleGrantablePermissions('professor').includes(permission), false, `${permission} concedível ao professor`);
    }
    // Secretaria: importa, aprova matrícula, emite certificado e tira relatório; não lê
    // mensagens nem mescla.
    for (const permission of ['students.import', 'enrollments.approve', 'students.certificates', 'reports.view']) assert.ok(has('secretaria', permission), `secretaria sem ${permission}`);
    for (const permission of ['page.messages', 'messages.readAll', 'students.merge', 'page.assignments']) assert.equal(has('secretaria', permission), false, `secretaria com ${permission}`);
    // Coordenação: vê tarefas e relatórios; não tem mensagens.
    for (const permission of ['page.assignments', 'reports.view']) assert.ok(has('coordenacao', permission), `coordenação sem ${permission}`);
    for (const permission of ['page.messages', 'messages.readAll', 'students.import', 'enrollments.approve', 'students.merge']) assert.equal(has('coordenacao', permission), false, `coordenação com ${permission}`);
    // Professor auxiliar: nenhuma das novas.
    for (const permission of novos) assert.equal(has('monitor', permission), false, `professor auxiliar com ${permission}`);
    // Só o administrador pleno: ler todas as conversas e mesclar cadastros (nenhum papel
    // recebe nem pode receber).
    for (const role of ['professor', 'monitor', 'secretaria', 'coordenacao']) {
        for (const permission of ['messages.readAll', 'students.merge']) {
            assert.equal(has(role, permission), false, `${role} com ${permission}`);
            assert.equal(roleGrantablePermissions(role).includes(permission), false, `${permission} concedível a ${role}`);
        }
    }
    for (const permission of novos) assert.ok(has('admin', permission), `administrador sem ${permission}`);
    // Pedir uma exclusiva como extra continua recusado.
    assert.equal(parseAdditionalPermissions(['students.merge'], 'professor').ok, false);
    assert.equal(parseAdditionalPermissions(['messages.readAll'], 'secretaria').ok, false);
    assert.equal(parseAdditionalPermissions(['page.assignments'], 'professor').ok, true);
});

// Só a permissão: o escopo da turma ou da escola e o somente leitura da coordenação (403
// read_only_account em POST) vêm depois, no mesmo guarda, e a matriz de papéis os confere.
test('fase 3: quem passa no guarda em cada rota nova, por papel (sem escopo)', () => {
    const accounts = {
        admin: { email: 'admin@rbac.local', role: 'admin' },
        legado: { email: 'legado@rbac.local' },
        professor: { email: 'prof@rbac.local', role: 'professor', additionalPermissions: [] },
        monitor: { email: 'monitor@rbac.local', role: 'monitor' },
        secretaria: { email: 'sec@rbac.local', role: 'secretaria' },
        coordenacao: { email: 'coord@rbac.local', role: 'coordenacao' },
    };
    const passes = (name, method, route) => canAccessAdminPermission(accounts[name], resolveAdminApiPermission(method, route));
    const expect = {
        'GET /assignments': { admin: true, legado: true, professor: true, monitor: false, secretaria: false, coordenacao: true },
        'POST /conversations/conv_1/messages': { admin: true, professor: true, monitor: false, secretaria: false, coordenacao: false },
        'POST /conversations/conv_1/admin-open': { admin: true, legado: true, professor: false, monitor: false, secretaria: false, coordenacao: false },
        'GET /reports/frequencia-turma': { admin: true, professor: true, monitor: false, secretaria: true, coordenacao: true },
        'POST /students/import': { admin: true, professor: true, monitor: false, secretaria: true, coordenacao: false },
        'POST /students/merge': { admin: true, professor: false, monitor: false, secretaria: false, coordenacao: false },
        'POST /certificates/issue': { admin: true, professor: false, monitor: false, secretaria: true, coordenacao: false },
        'POST /exam-applications/app_1/attempt-action': { admin: true, professor: true, monitor: true, secretaria: false, coordenacao: false },
        'GET /exam-applications/app_1/access-token': { admin: true, professor: true, monitor: true, secretaria: false, coordenacao: false },
        'POST /exam-applications/app_1/answer-key-correction': { admin: true, professor: true, monitor: false, secretaria: false, coordenacao: true },
        'POST /grading/criteria': { admin: true, professor: false, monitor: false, secretaria: false, coordenacao: false },
        'POST /academic/terms/create': { admin: true, professor: false, secretaria: false },
        'POST /accounts/reset-password': { admin: true, professor: false, secretaria: false, coordenacao: false },
        'POST /account/profile': { admin: true, professor: true, monitor: true, secretaria: true, coordenacao: true },
        'POST /setup/wizard': { admin: true, professor: false, secretaria: false },
        'POST /preview-sessions': { admin: true, professor: true, monitor: true, secretaria: true, coordenacao: true },
        'GET /class-groups': { admin: true, professor: true, monitor: true, secretaria: true, coordenacao: true },
    };
    const wrong = [];
    for (const [key, byRole] of Object.entries(expect)) {
        const [method, route] = key.split(' ');
        for (const [name, allowed] of Object.entries(byRole)) {
            if (passes(name, method, route) !== allowed) wrong.push(`${name} ${key}: ${!allowed ? 'passa' : 'não passa'}`);
        }
    }
    assert.deepEqual(wrong, [], wrong.join('\n'));
});

// attempt-action junta ações do Monitor (recolher, reabrir, tentativa extra) com anular
// e desfazer a anulação, que mudam nota. O papel do professor auxiliar é "sem notas"
// (shared_contracts.rbac.papeis): as duas pedem page.results além de page.monitor.
test('fase 3: anular e desfazer a anulação pelo Monitor pedem page.results; recolher, reabrir e tentativa extra, não', () => {
    const route = '/exam-applications/app_1/attempt-action';
    for (const action of ['recolher', 'reabrir', 'tentativa_extra', 'Recolher', ' reabrir ']) {
        assert.equal(resolveAdminApiExtraPermission('POST', route, { action }), null, action);
    }
    // Sem ação: a rota recusa (400); o guarda não pede nada a mais.
    for (const body of [{}, { action: '' }, { action: null }, undefined, null]) {
        assert.equal(resolveAdminApiExtraPermission('POST', route, body), null, JSON.stringify(body));
    }
    // Anular, desfazer, outra caixa, espaço, barra no fim, lista e ação desconhecida.
    for (const [variant, body] of [
        [route, { action: 'anular' }],
        [route, { action: 'desfazer_anulacao' }],
        [route, { action: 'ANULAR' }],
        [`${route}/`, { action: ' anular ' }],
        [route.toUpperCase(), { action: 'anular' }],
        [route, { action: ['anular'] }],
        [route, { action: 'zerar' }],
    ]) assert.equal(resolveAdminApiExtraPermission('POST', variant, body), 'page.results', `${variant} ${JSON.stringify(body)}`);
    // Outras rotas não têm parte do corpo na decisão.
    assert.equal(resolveAdminApiExtraPermission('POST', '/exam-applications/app_1/answer-key-correction', { action: 'anular' }), null);
    assert.equal(resolveAdminApiExtraPermission('POST', '/student/update', { action: 'anular' }), null);
    assert.equal(resolveAdminApiExtraPermission('GET', '/whoami', { action: 'anular' }), null);

    const accounts = {
        admin: { email: 'admin@rbac.local', role: 'admin' },
        professor: { email: 'prof@rbac.local', role: 'professor' },
        monitor: { email: 'monitor@rbac.local', role: 'monitor' },
        secretaria: { email: 'sec@rbac.local', role: 'secretaria' },
    };
    const passes = (name, action) => {
        const body = { action };
        if (!canAccessAdminPermission(accounts[name], resolveAdminApiPermission('POST', route))) return false;
        const extra = resolveAdminApiExtraPermission('POST', route, body);
        return !extra || canAccessAdminPermission(accounts[name], extra);
    };
    for (const action of ['recolher', 'reabrir', 'tentativa_extra']) {
        assert.deepEqual(['admin', 'professor', 'monitor', 'secretaria'].map(name => passes(name, action)), [true, true, true, false], action);
    }
    for (const action of ['anular', 'desfazer_anulacao']) {
        assert.deepEqual(['admin', 'professor', 'monitor', 'secretaria'].map(name => passes(name, action)), [true, true, false, false], action);
    }
});
