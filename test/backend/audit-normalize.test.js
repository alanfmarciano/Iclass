// Trilha de auditoria (H7a-1): utils/audit.js isolado, sem banco nem servidor.
// recordAudit (formato canônico, cópia sem segredos), normalizeAuditEntry (os quatro
// formatos antigos do banco) e mergeAuditTrails (junção na restauração).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ACTION_LABELS,
    ACTION_CATEGORIES,
    AUDIT_CATEGORIES,
    CATEGORY_LABELS,
    recordAudit,
    normalizeAuditEntry,
    mergeAuditTrails,
    stripSecrets,
    inferAuditCategory,
} = require('../../backend/utils/audit.js');

function fakeReq({ ip = '::ffff:10.0.0.7', ua = 'Mozilla/5.0', adminAccount, studentEmail } = {}) {
    return { ip, socket: { remoteAddress: ip }, headers: { 'user-agent': ua }, adminAccount, studentEmail };
}

test('[UC-AUDITORIA-001] recordAudit grava a entrada canônica no fim da lista e devolve a entrada', () => {
    const existing = { id: 'antiga', type: 'class_created', actorEmail: 'x@y.z', at: 1 };
    const memory = { auditLogs: [existing] };
    const req = fakeReq({ ua: 'A'.repeat(300), adminAccount: { email: 'Prof@Escola.Local', role: 'professor' } });
    const entry = recordAudit(memory, {
        req,
        actor: { email: 'Prof@Escola.Local', role: 'professor' },
        action: 'account_updated',
        targetEmail: ' Outra@Escola.Local ',
        courseId: 'curso_1',
        studentClass: '1DES',
        reason: `  ${'m'.repeat(600)}  `,
    }, { timestamp: 1700000000123 });

    assert.equal(memory.auditLogs.length, 2);
    assert.equal(memory.auditLogs[0], existing, 'a entrada antiga continua a mesma');
    assert.deepEqual(existing, { id: 'antiga', type: 'class_created', actorEmail: 'x@y.z', at: 1 });
    assert.equal(memory.auditLogs[1], entry);
    assert.match(entry.id, /^audit_account_1700000000123_[0-9a-f]{8}$/);
    assert.equal(entry.action, 'account_updated');
    assert.equal(entry.category, 'account', 'categoria pelo catálogo de ações');
    assert.equal(entry.actor, 'prof@escola.local');
    assert.equal(entry.actorRole, 'professor');
    assert.equal(entry.timestamp, 1700000000123);
    assert.equal(entry.ip, '10.0.0.7');
    assert.equal(entry.device.length, 160);
    assert.equal(entry.targetEmail, 'outra@escola.local');
    assert.equal(entry.courseId, 'curso_1');
    assert.equal(entry.studentClass, '1DES');
    assert.equal(entry.reason.length, 500);
    // Campos opcionais não informados ficam de fora (nem undefined nem null).
    for (const key of ['studentEmail', 'examKey', 'applicationId', 'submissionId', 'field', 'oldValue', 'newValue', 'before', 'after', 'details']) {
        assert.equal(Object.prototype.hasOwnProperty.call(entry, key), false, `${key} não devia existir`);
    }
});

test('[UC-AUDITORIA-001] recordAudit cria a lista que falta, aceita null explícito e recusa ação vazia', () => {
    const memory = {};
    const entry = recordAudit(memory, { action: 'grade_create', submissionId: 42, courseId: null, studentClass: null, before: null, reason: '   ' });
    assert.deepEqual(memory.auditLogs, [entry]);
    assert.equal(entry.submissionId, '42');
    assert.equal(entry.courseId, null);
    assert.equal(entry.studentClass, null);
    assert.equal(entry.before, null);
    assert.equal('reason' in entry, false, 'motivo em branco não entra');
    assert.equal(entry.actor, 'sistema');
    assert.equal(entry.actorRole, 'sistema');
    assert.equal(entry.ip, '');
    assert.equal(entry.device, '');
    assert.throws(() => recordAudit(memory, { action: '  ' }), TypeError);
    assert.throws(() => recordAudit(null, { action: 'grade_create' }), TypeError);
    assert.equal(memory.auditLogs.length, 1);
});

test('[UC-AUDITORIA-001] quem fez: conta do pedido, aluno da sessão, texto livre e o launcher', () => {
    const memory = { auditLogs: [] };
    const fromRequest = recordAudit(memory, { req: fakeReq({ adminAccount: { email: 'ADMIN@Escola.Local' } }), action: 'settings_updated' });
    assert.equal(fromRequest.actor, 'admin@escola.local');
    assert.equal(fromRequest.actorRole, 'admin', 'conta sem papel é administrador');
    const student = recordAudit(memory, { req: fakeReq({ studentEmail: 'ana@escola.local' }), action: 'privacy_accept' });
    assert.equal(student.actor, 'ana@escola.local');
    assert.equal(student.actorRole, 'aluno');
    assert.equal(student.category, 'privacy');
    const named = recordAudit(memory, { actor: 'Administrador', action: 'grade_create' });
    assert.equal(named.actor, 'Administrador', 'texto sem @ fica como veio');
    assert.equal('actorRole' in named, false, 'sem como saber o papel, fica de fora');
    const launcher = recordAudit(memory, { actor: 'launcher-local', action: 'admin_password_reset_local' });
    assert.equal(launcher.actorRole, 'sistema');
    assert.equal(launcher.category, 'security');
});

test('[UC-AUDITORIA-001] before, after e details entram como cópia, sem senha, hash, sal nem token', () => {
    const live = {
        name: 'Prof',
        password: 'scrypt$abc',
        passwordHash: 'x',
        mustChangePassword: true,
        requireToken: false,
        profile: { salt: 's', hash: 'h', email: 'p@e.l', sessions: [{ token: 'T1', sessionToken: 'T2', ok: 1 }] },
        nested: { accessToken: 'a', adminSessionToken: 'b', studentPassword: '123', examAnswerSecret: 'segredo', Token: 'X', when: new Date(0) },
        // Hash e sal com prefixo: o accessTokenHash da prova (sha256 sem sal de 5 letras)
        // e o tokenHash das sessões voltam ao segredo por tentativa.
        exam: { accessTokenHash: 'f'.repeat(64), accessTokenIssuedAt: 1700000000000, tokenEnabled: true, requiresToken: true },
        session: { tokenHash: 'e'.repeat(64), keySalt: 'pimenta', SESSIONHASH: 'd'.repeat(64), examKey: 'Avaliacao_A' },
    };
    const memory = { auditLogs: [] };
    const entry = recordAudit(memory, { action: 'account_updated', before: live, after: { list: [live] }, details: { senha: '1', novaSenha: '2', controlToken: 'c', keep: 'sim' } });
    const serialized = JSON.stringify(entry);
    for (const secret of ['scrypt$abc', '"salt"', '"hash"', 'T1', 'T2', '"accessToken"', '"adminSessionToken"', 'studentPassword', 'segredo', '"senha"', 'novaSenha', 'controlToken', '"Token"', 'passwordHash',
        'accessTokenHash', 'f'.repeat(64), 'tokenHash', 'e'.repeat(64), 'keySalt', 'pimenta', 'SESSIONHASH', 'd'.repeat(64)]) {
        assert.equal(serialized.includes(secret), false, `${secret} vazou para a auditoria`);
    }
    // O que não é segredo continua: a hora de emissão do token e as chaves booleanas.
    assert.deepEqual(entry.before.exam, { accessTokenIssuedAt: 1700000000000, tokenEnabled: true, requiresToken: true });
    assert.deepEqual(entry.before.session, { examKey: 'Avaliacao_A' });
    assert.equal(entry.before.mustChangePassword, true, 'booleano não é segredo');
    assert.equal(entry.before.requireToken, false);
    assert.equal(entry.before.profile.email, 'p@e.l');
    assert.deepEqual(entry.before.profile.sessions, [{ ok: 1 }]);
    assert.equal(entry.before.nested.when, '1970-01-01T00:00:00.000Z');
    assert.equal(entry.details.keep, 'sim');
    // O objeto de quem chamou não muda, e mudar o objeto depois não muda a entrada.
    assert.equal(live.password, 'scrypt$abc');
    assert.equal(live.profile.sessions[0].token, 'T1');
    live.name = 'Outro nome';
    live.profile.email = 'mudou@e.l';
    assert.equal(entry.before.name, 'Prof');
    assert.equal(entry.after.list[0].profile.email, 'p@e.l');
});

test('[UC-AUDITORIA-001] stripSecrets não trava em referência circular nem em objeto muito fundo', () => {
    const loop = { a: 1 };
    loop.self = loop;
    assert.deepEqual(stripSecrets(loop), { a: 1, self: '[referência circular]' });
    let deep = {};
    const root = deep;
    for (let index = 0; index < 100; index += 1) { deep.next = {}; deep = deep.next; }
    assert.doesNotThrow(() => JSON.stringify(stripSecrets(root)));
    // O mesmo objeto em dois lugares não é ciclo.
    const shared = { x: 1 };
    assert.deepEqual(stripSecrets({ a: shared, b: shared }), { a: { x: 1 }, b: { x: 1 } });
});

test('[UC-AUDITORIA-001] campos do formato antigo (legacy) ficam, sem trocar os canônicos nem levar segredo', () => {
    const memory = { auditLogs: [] };
    const entry = recordAudit(memory, { actor: { email: 'a@b.c' }, action: 'class_updated' }, {
        timestamp: 5000,
        legacy: { type: 'class_updated', actorEmail: 'a@b.c', at: 5000, target: { courseId: 'c1', className: '1DES', token: 'X' }, action: 'outra', id: 'falso', password: 'p', vazio: undefined },
    });
    assert.equal(entry.type, 'class_updated');
    assert.equal(entry.actorEmail, 'a@b.c');
    assert.equal(entry.at, 5000);
    assert.deepEqual(entry.target, { courseId: 'c1', className: '1DES' });
    assert.equal(entry.action, 'class_updated');
    assert.notEqual(entry.id, 'falso');
    assert.equal('password' in entry, false);
    assert.equal('vazio' in entry, false);
    assert.equal(entry.category, 'academic');
});

test('[UC-AUDITORIA-001] catálogo: os nomes de ação do contrato 6, com categoria e rótulo em português', () => {
    const contract = {
        student_password_reset: 'security',
        account_created: 'account', account_updated: 'account', account_deleted: 'account', account_password_changed: 'account', account_login_unlocked: 'account', student_login_unlocked: 'account',
        course_created: 'academic', course_updated: 'academic', course_deleted: 'academic', course_cloned: 'academic',
        settings_updated: 'system', storage_compacted: 'system', network_settings_changed: 'system',
        backup_server_created: 'backup', backup_downloaded: 'backup', backup_restored: 'backup', backup_restore_failed: 'backup',
        privacy_accept: 'privacy', legal_publish: 'privacy', retention_purge: 'privacy', lgpd_export: 'privacy',
        student_anonymized: 'student', student_purged: 'student',
    };
    for (const [action, category] of Object.entries(contract)) {
        assert.equal(inferAuditCategory(action), category, action);
        assert.ok(ACTION_LABELS[action] && /[a-zà-ú]/i.test(ACTION_LABELS[action]), `${action} sem rótulo`);
    }
    // Toda ação com rótulo cai numa categoria conhecida (pela lista ou pelo começo do
    // nome): quem acrescenta o rótulo de um nome sem prefixo conhecido acrescenta também
    // a categoria em ACTION_CATEGORIES.
    for (const action of Object.keys(ACTION_LABELS)) {
        const category = inferAuditCategory(action);
        assert.ok(AUDIT_CATEGORIES.includes(category) && category !== 'other', `${action} sem categoria`);
    }
    for (const category of Object.values(ACTION_CATEGORIES)) assert.ok(AUDIT_CATEGORIES.includes(category), category);
    for (const category of AUDIT_CATEGORIES) assert.ok(CATEGORY_LABELS[category], category);
    // Exceções ao começo do nome: limpar o estado de prova e resetar a sala são do sistema.
    assert.equal(inferAuditCategory('class_reset'), 'system');
    assert.equal(inferAuditCategory('exam_state_flushed'), 'system');
    assert.equal(inferAuditCategory('class_created'), 'academic');
    assert.equal(inferAuditCategory('exam_application_finished'), 'exam');
    assert.equal(ACTION_LABELS.grade_create, 'Nota lançada');
    assert.ok(Object.isFrozen(ACTION_LABELS) && Object.isFrozen(ACTION_CATEGORIES), 'as listas só mudam no código');
    // backup_* novo (do H4) cai em backup mesmo antes de ganhar rótulo.
    assert.equal(inferAuditCategory('backup_external_failed'), 'backup');
    assert.equal(inferAuditCategory('qualquer_coisa'), 'other');
});

test('[UC-AUDITORIA-001] normalizeAuditEntry lê os quatro formatos antigos sem mudar a entrada', () => {
    const rows = [
        // action/actor/timestamp em ms (cadastro do aluno, sem category)
        { id: 'a1', actor: 'admin@e.l', studentEmail: 'Ana@E.L', action: 'update', field: 'Status', oldValue: 'Ativo', newValue: 'Inativo', timestamp: 1700000000000, ip: '10.0.0.1' },
        // type/actorEmail/at em ms (turma)
        { id: 'a2', type: 'class_updated', actorEmail: 'prof@e.l', target: { courseId: 'c1', className: '1DES' }, before: { period: 'Manhã' }, after: { period: 'Tarde' }, at: 1700000001000 },
        // type/actor/timestamp em ISO (prova)
        { id: 'a3', type: 'exam_attempt_reopened_extra_time', actor: 'sistema', applicationId: 'app_1', examKey: 'P1', studentClass: '1DES', courseId: 'c1', details: { studentEmail: 'bia@e.l', attemptId: 't1' }, timestamp: '2023-11-14T22:13:22.000Z' },
        // type/actorEmail/at em ISO (modo de configuração)
        { id: 'a4', type: 'local_quick_login', profile: 'admin', actorEmail: 'admin@e.l', at: '2023-11-14T22:13:23.000Z', ip: '::1' },
        // manutenção: exam_state_flushed é sistema, não prova
        { id: 'a5', type: 'exam_state_flushed', actorEmail: 'admin@e.l', studentClass: '1DES', courseId: 'c1', details: { applicationId: 'app_2', removedStates: 1 }, at: 1700000002000 },
        // backup gravado pela versão anterior, com os dados soltos
        { id: 'a6', actorEmail: 'admin@e.l', at: 1700000003000, type: 'backup_restore_failed', file: 'velho.json', size: 10, error: 'inválido' },
        // hora inválida e ação desconhecida
        { id: 'a7', action: 'algo_novo', actor: 'x@e.l', timestamp: 'ontem' },
        { id: 'a8', type: 'class_reset', actorEmail: 'admin@e.l', at: '1700000004000' },
    ];
    const copy = JSON.parse(JSON.stringify(rows));
    const [n1, n2, n3, n4, n5, n6, n7, n8] = rows.map(normalizeAuditEntry);
    assert.deepEqual(rows, copy, 'a leitura não altera nada');

    assert.equal(n1.action, 'update');
    assert.equal(n1.category, 'student', 'field sem type é alteração de cadastro');
    assert.equal(n1.studentEmail, 'ana@e.l');
    assert.equal(n1.label, 'Cadastro do aluno alterado');
    assert.equal(n1.timestamp, 1700000000000);
    assert.equal(n1.oldValue, 'Ativo');

    assert.equal(n2.action, 'class_updated');
    assert.equal(n2.actor, 'prof@e.l');
    assert.equal(n2.category, 'academic');
    assert.equal(n2.courseId, 'c1');
    assert.equal(n2.studentClass, '1DES');
    assert.equal(n2.timestamp, 1700000001000);
    assert.deepEqual(n2.after, { period: 'Tarde' });
    assert.equal(n2.label, 'Turma alterada');

    assert.equal(n3.category, 'exam');
    assert.equal(n3.timestamp, Date.parse('2023-11-14T22:13:22.000Z'));
    assert.equal(n3.studentEmail, 'bia@e.l', 'aluno lido de details');
    assert.equal(n3.applicationId, 'app_1');
    assert.equal(n3.actorRole, 'sistema');

    assert.equal(n4.category, 'security');
    assert.equal(n4.actor, 'admin@e.l');
    assert.equal(n4.timestamp, Date.parse('2023-11-14T22:13:23.000Z'));
    assert.deepEqual(n4.details, { profile: 'admin' });

    assert.equal(n5.category, 'system');
    assert.equal(n5.applicationId, 'app_2');

    assert.equal(n6.category, 'backup');
    assert.deepEqual(n6.details, { file: 'velho.json', size: 10, error: 'inválido' });

    assert.equal(n7.timestamp, 0, 'hora inválida vira 0');
    assert.equal(n7.category, 'other');
    assert.equal(n7.label, 'Outro evento (algo_novo)');

    assert.equal(n8.category, 'system');
    assert.equal(n8.timestamp, 1700000004000);

    assert.equal(normalizeAuditEntry(null), null);
    assert.equal(normalizeAuditEntry('texto'), null);
    assert.equal(normalizeAuditEntry([1]), null);
});

test('[UC-AUDITORIA-001] a entrada canônica nova volta igual na leitura', () => {
    const memory = { auditLogs: [] };
    const entry = recordAudit(memory, {
        req: fakeReq({ adminAccount: { email: 'admin@e.l', role: 'admin' } }),
        action: 'grade_publish', studentEmail: 'ana@e.l', submissionId: 's1', examKey: 'P1', applicationId: 'app', courseId: 'c', studentClass: 'T',
        field: 'Publicação', oldValue: 'oculta', newValue: 'publicada', reason: 'revisão', before: { a: 1 }, after: { a: 2 }, details: { d: true },
    }, { timestamp: 1234 });
    const normalized = normalizeAuditEntry(entry);
    assert.deepEqual({ ...normalized }, {
        id: entry.id, action: 'grade_publish', category: 'grade', actor: 'admin@e.l', actorRole: 'admin', timestamp: 1234, ip: '10.0.0.7',
        studentEmail: 'ana@e.l', targetEmail: '', courseId: 'c', studentClass: 'T', examKey: 'P1', applicationId: 'app', submissionId: 's1',
        field: 'Publicação', oldValue: 'oculta', newValue: 'publicada', reason: 'revisão', before: { a: 1 }, after: { a: 2 }, details: { d: true },
        label: 'Nota publicada para o aluno',
    });
});

test('[UC-AUDITORIA-001] mergeAuditTrails junta a trilha do backup com a atual, em ordem de hora', () => {
    const backup = [
        { id: 'b1', action: 'create', timestamp: 1000 },
        { id: 'comum', action: 'update', field: 'Status', newValue: 'do backup', timestamp: 3000 },
        { id: 'b2', type: 'class_created', at: '1970-01-01T00:00:02.000Z' },
    ];
    const current = [
        { id: 'b1', action: 'create', timestamp: 1000, alterada: true },
        { id: 'comum', action: 'update', field: 'Status', newValue: 'atual', timestamp: 3000 },
        { id: 'depois', action: 'create', timestamp: 5000 },
        { type: 'sem_id', at: 4000 },
        null,
        { id: 'mesma_hora', action: 'x', timestamp: 1000 },
    ];
    const backupCopy = JSON.parse(JSON.stringify(backup));
    const currentCopy = JSON.parse(JSON.stringify(current));
    const merged = mergeAuditTrails(backup, current);
    assert.deepEqual(backup, backupCopy, 'não altera as listas recebidas');
    assert.deepEqual(current, currentCopy);
    assert.deepEqual(merged.map(entry => entry.id || entry.type), ['b1', 'mesma_hora', 'b2', 'comum', 'sem_id', 'depois']);
    assert.equal(merged.find(entry => entry.id === 'comum').newValue, 'do backup', 'no mesmo id vale a do backup');
    assert.equal(merged.find(entry => entry.id === 'b1').alterada, undefined);
    // Entrada sem id que o backup também tem não duplica.
    assert.equal(mergeAuditTrails([{ type: 'x', at: 1 }], [{ type: 'x', at: 1 }]).length, 1);
    // Backup sem a trilha: a atual fica como está (mesma ordem), numa lista nova.
    const kept = mergeAuditTrails(undefined, current);
    assert.notEqual(kept, current);
    assert.deepEqual(kept, current.filter(Boolean));
    assert.deepEqual(mergeAuditTrails([], []), []);
    assert.deepEqual(mergeAuditTrails([{ id: 'só' }], null), [{ id: 'só' }]);
});
