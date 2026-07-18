const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-branding-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const {
    BRANDING_KEYS,
    DEFAULT_BRANDING,
    INTERFACE_PRESETS,
    SAVED_THEME_VALUE_KEYS,
    MAX_SAVED_THEMES,
    extractBranding,
    resolveEffectiveBranding,
    validateBrandingPatch,
} = require('../../backend/utils/branding.js');
const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const adminToken = 'branding-admin-token';
let app;

test.before(async () => {
    await db.init();
    db.memory.admins = [{
        email: 'branding-admin@teste.local',
        name: 'Admin Branding',
        role: 'admin',
        password: db.hashPassword('senha-administrativa'),
    }];
    db.memory.adminSessions = {
        [adminToken]: {
            email: 'branding-admin@teste.local',
            createdAt: Date.now(),
            lastSeen: Date.now(),
        },
    };
    app = createApp();
});

test.after(async () => {
    // As rotas disparam o save debounced; deixe a última rodada pendente concluir
    // antes de fechar a conexão SQLite usada apenas por este arquivo de teste.
    await new Promise(resolve => setTimeout(resolve, 750));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('declara premium e lumen, preservando premium como padrão legado', () => {
    assert.deepEqual(INTERFACE_PRESETS, ['premium', 'lumen']);
    assert.equal(BRANDING_KEYS.includes('interfacePreset'), true);
    assert.equal(DEFAULT_BRANDING.interfacePreset, 'premium');

    const effective = resolveEffectiveBranding({
        global: { displayName: 'Instalação antiga' },
        school: { id: 'escola-legada', branding: {} },
        course: { id: 'curso-legado', schoolId: 'escola-legada' },
    });
    assert.equal(effective.interfacePreset, 'premium');
});

test('resolve interfacePreset por Curso → Escola → Sistema → premium', () => {
    const resolve = ({ courseValue, schoolValue, globalValue }) => resolveEffectiveBranding({
        global: globalValue === undefined ? {} : { interfacePreset: globalValue },
        school: { id: 'escola-1', branding: schoolValue === undefined ? {} : { interfacePreset: schoolValue } },
        course: { id: 'curso-1', schoolId: 'escola-1', branding: courseValue === undefined ? {} : { interfacePreset: courseValue } },
    }).interfacePreset;

    assert.equal(resolve({ courseValue: 'lumen', schoolValue: 'premium', globalValue: 'premium' }), 'lumen');
    assert.equal(resolve({ courseValue: '', schoolValue: 'lumen', globalValue: 'premium' }), 'lumen');
    assert.equal(resolve({ courseValue: '', schoolValue: '', globalValue: 'lumen' }), 'lumen');
    assert.equal(resolve({ courseValue: '', schoolValue: '', globalValue: undefined }), 'premium');
    assert.equal(resolve({ courseValue: 'desconhecido', schoolValue: 'lumen', globalValue: 'premium' }), 'lumen');
    assert.equal(resolve({ courseValue: 'desconhecido', schoolValue: 'inválido', globalValue: 'outro' }), 'premium');
});

test('aceita somente premium, lumen ou vazio nas escritas', () => {
    assert.equal(validateBrandingPatch({ interfacePreset: 'premium' }), null);
    assert.equal(validateBrandingPatch({ interfacePreset: 'lumen' }), null);
    assert.equal(validateBrandingPatch({ interfacePreset: '   ' }), null);
    assert.equal(extractBranding({ interfacePreset: ' lumen ' }).interfacePreset, 'lumen');
    assert.equal(extractBranding({ interfacePreset: '   ' }).interfacePreset, '');

    const invalid = validateBrandingPatch({ interfacePreset: 'classic' });
    assert.equal(invalid.code, 'INVALID_INTERFACE_PRESET');
    assert.equal(invalid.field, 'interfacePreset');
    assert.throws(
        () => extractBranding({ interfacePreset: 'classic' }),
        error => error.status === 400 && error.code === 'INVALID_INTERFACE_PRESET'
    );
});

test('valida e normaliza a biblioteca de temas visuais salvos', () => {
    const savedThemes = [{
        id: 'visual-azul',
        name: 'Azul institucional',
        createdAt: '2026-07-13T12:00:00.000Z',
        values: { interfacePreset: 'lumen', themeMode: 'light', primaryColor: '#2563eb', displayName: 'não deve entrar' },
    }];
    assert.equal(SAVED_THEME_VALUE_KEYS.includes('primaryColor'), true);
    assert.equal(MAX_SAVED_THEMES, 24);
    assert.equal(validateBrandingPatch({ savedThemes }), null);
    const extracted = extractBranding({ savedThemes }).savedThemes;
    assert.equal(extracted[0].name, 'Azul institucional');
    assert.equal(extracted[0].values.interfacePreset, 'lumen');
    assert.equal(extracted[0].values.primaryColor, '#2563eb');
    assert.equal(extracted[0].values.displayName, undefined);

    const invalidPreset = validateBrandingPatch({ savedThemes: [{ ...savedThemes[0], values: { interfacePreset: 'classic' } }] });
    assert.equal(invalidPreset.code, 'INVALID_SAVED_THEMES');
    assert.equal(validateBrandingPatch({ savedThemes: 'não-é-lista' }).code, 'INVALID_SAVED_THEMES');
    assert.equal(validateBrandingPatch({ savedThemes: Array.from({ length: 25 }, (_, index) => ({ id: `t-${index}`, name: `Tema ${index}`, values: {} })) }).code, 'INVALID_SAVED_THEMES');
});

test('rotas validam e persistem a herança de preset sem quebrar dados antigos', async () => {
    db.memory.branding = { institutionName: 'Instituição Legada', primaryColor: '#123456' };
    db.memory.schools = [{ id: 'escola-1', name: 'Escola 1', info: {}, branding: {} }];
    db.memory.courses = [{ id: 'curso-1', name: 'Curso 1', schoolId: 'escola-1', structure: [], branding: {} }];

    const legacy = await request(app).get('/api/branding?courseId=curso-1').expect(200);
    assert.equal(legacy.body.interfacePreset, 'premium');
    assert.equal(legacy.body.displayName, 'Instituição Legada');

    const invalidGlobal = await request(app)
        .post('/api/branding')
        .set('x-admin-session', adminToken)
        .send({ interfacePreset: 'classic' })
        .expect(400);
    assert.equal(invalidGlobal.body.code, 'INVALID_INTERFACE_PRESET');
    assert.equal(db.memory.branding.interfacePreset, undefined);

    await request(app)
        .post('/api/branding')
        .set('x-admin-session', adminToken)
        .send({ interfacePreset: 'lumen' })
        .expect(200);
    assert.equal(db.memory.branding.interfacePreset, 'lumen');

    const savedTheme = [{ id: 'visual-1', name: 'Tema azul', createdAt: '2026-07-13T12:00:00.000Z', values: { interfacePreset: 'lumen', primaryColor: '#2563eb' } }];
    await request(app)
        .post('/api/branding')
        .set('x-admin-session', adminToken)
        .send({ savedThemes: savedTheme })
        .expect(200);
    assert.deepEqual(db.memory.branding.savedThemes, savedTheme);
    const rawWithThemes = await request(app).get('/api/branding?raw=1').expect(200);
    assert.equal(rawWithThemes.body.savedThemes[0].name, 'Tema azul');

    const inheritedFromSystem = await request(app).get('/api/branding?courseId=curso-1').expect(200);
    assert.equal(inheritedFromSystem.body.interfacePreset, 'lumen');

    await request(app)
        .post('/api/admin/schools/update')
        .set('x-admin-session', adminToken)
        .send({ id: 'escola-1', branding: { interfacePreset: 'premium' } })
        .expect(200);
    assert.equal(db.memory.schools[0].branding.interfacePreset, 'premium');

    const globalWithoutContext = await request(app).get('/api/branding').expect(200);
    assert.equal(globalWithoutContext.body.interfacePreset, 'lumen');

    const explicitSchool = await request(app).get('/api/branding?schoolId=escola-1').expect(200);
    assert.equal(explicitSchool.body.interfacePreset, 'premium');

    const inheritedFromSchool = await request(app).get('/api/branding?courseId=curso-1').expect(200);
    assert.equal(inheritedFromSchool.body.interfacePreset, 'premium');

    await request(app)
        .put('/api/courses/curso-1')
        .set('x-admin-session', adminToken)
        .send({ branding: { interfacePreset: 'lumen' } })
        .expect(200);
    assert.equal(db.memory.courses[0].branding.interfacePreset, 'lumen');

    const overriddenByCourse = await request(app).get('/api/branding?courseId=curso-1').expect(200);
    assert.equal(overriddenByCourse.body.interfacePreset, 'lumen');

    const parentWithoutCourseOverride = await request(app).get('/api/branding?schoolId=escola-1').expect(200);
    assert.equal(parentWithoutCourseOverride.body.interfacePreset, 'premium');

    await request(app).get('/api/branding?schoolId=escola-inexistente').expect(404);
    await request(app).get('/api/branding?courseId=curso-1&schoolId=escola-1').expect(400);

    const invalidCourse = await request(app)
        .put('/api/courses/curso-1')
        .set('x-admin-session', adminToken)
        .send({ branding: { interfacePreset: 'classic' } })
        .expect(400);
    assert.equal(invalidCourse.body.code, 'INVALID_INTERFACE_PRESET');
    assert.equal(db.memory.courses[0].branding.interfacePreset, 'lumen');

    const invalidSchool = await request(app)
        .post('/api/admin/schools/update')
        .set('x-admin-session', adminToken)
        .send({ id: 'escola-1', branding: { interfacePreset: 'classic' } })
        .expect(400);
    assert.equal(invalidSchool.body.code, 'INVALID_INTERFACE_PRESET');
    assert.equal(db.memory.schools[0].branding.interfacePreset, 'premium');

    await request(app)
        .post('/api/courses')
        .set('x-admin-session', adminToken)
        .send({ id: 'curso-invalido', name: 'Curso Inválido', branding: { interfacePreset: 'classic' } })
        .expect(400);
    assert.equal(db.memory.courses.some(course => course.id === 'curso-invalido'), false);

    await request(app)
        .put('/api/courses/curso-1')
        .set('x-admin-session', adminToken)
        .send({ branding: { interfacePreset: '' } })
        .expect(200);
    const inheritedAgain = await request(app).get('/api/branding?courseId=curso-1').expect(200);
    assert.equal(inheritedAgain.body.interfacePreset, 'premium');

    await db.save();
});
