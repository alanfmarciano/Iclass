// Fase I.1 — Identidade white-label: campos, defaults e herança Curso → Escola → Sistema.

// Chaves de identidade visual (valem em Sistema, Escola e Curso).
const BRANDING_KEYS = [
    'displayName', 'shortName', 'logoLightUrl', 'logoDarkUrl', 'faviconUrl', 'monogram',
    'primaryColor', 'secondaryColor', 'themeMode', 'palettePreset', 'interfacePreset',
    'accentColor', 'successColor', 'warningColor', 'dangerColor',
    'radius', 'density', 'fontHeading', 'fontBody', 'fontScale',
    'loginLayout', 'loginBgUrl', 'loginBgColor', 'loginWelcome',
    'termStudent', 'termClass', 'termCourse', 'termTeacher', 'locale',
    'certLogoUrl', 'certFooter', 'customCss',
];
const BOOLEAN_KEYS = ['hideVendorMark'];
const INTERFACE_PRESETS = Object.freeze(['premium', 'lumen']);
const INTERFACE_PRESET_SET = new Set(INTERFACE_PRESETS);
const SAVED_THEME_VALUE_KEYS = Object.freeze([
    'primaryColor', 'secondaryColor', 'themeMode', 'palettePreset', 'interfacePreset',
    'accentColor', 'successColor', 'warningColor', 'dangerColor',
    'radius', 'density', 'fontHeading', 'fontBody', 'fontScale',
    'loginLayout', 'loginBgUrl', 'loginBgColor', 'customCss',
]);
const MAX_SAVED_THEMES = 24;

// Dados institucionais (só existem no nível Escola).
const INSTITUTIONAL_KEYS = [
    'tradeName', 'legalName', 'registrationId', 'address', 'cityState', 'zip',
    'phone', 'email', 'website', 'directorName', 'directorRole', 'signatureUrl',
];

// Padrão de fábrica (nível mais baixo da herança).
const DEFAULT_BRANDING = {
    displayName: 'IClass',
    shortName: 'IC',
    primaryColor: '#ef4444',
    secondaryColor: '',
    themeMode: 'auto',
    interfacePreset: 'premium',
    radius: 'padrao',
    density: 'confortavel',
    fontHeading: 'Inter',
    fontBody: 'Inter',
    fontScale: 'padrao',
    loginLayout: 'centralizado',
    termStudent: 'aluno',
    termClass: 'turma',
    termCourse: 'curso',
    termTeacher: 'instrutor',
    locale: 'pt-BR',
    hideVendorMark: false,
};

function brandingError(code, field, message) {
    return { code, field, message };
}

function validateSavedThemes(savedThemes) {
    if (!Array.isArray(savedThemes)) return brandingError('INVALID_SAVED_THEMES', 'savedThemes', 'savedThemes deve ser uma lista.');
    if (savedThemes.length > MAX_SAVED_THEMES) return brandingError('INVALID_SAVED_THEMES', 'savedThemes', `Salve no máximo ${MAX_SAVED_THEMES} temas.`);
    for (const entry of savedThemes) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return brandingError('INVALID_SAVED_THEMES', 'savedThemes', 'Cada tema salvo deve ser um objeto.');
        const id = String(entry.id || '').trim();
        const name = String(entry.name || '').trim();
        if (!id || id.length > 80) return brandingError('INVALID_SAVED_THEMES', 'savedThemes', 'Tema salvo com identificador inválido.');
        if (!name || name.length > 60) return brandingError('INVALID_SAVED_THEMES', 'savedThemes', 'O nome do tema deve ter entre 1 e 60 caracteres.');
        if (!entry.values || typeof entry.values !== 'object' || Array.isArray(entry.values)) return brandingError('INVALID_SAVED_THEMES', 'savedThemes', `O tema "${name}" não possui configurações válidas.`);
        if (entry.values.interfacePreset !== undefined) {
            const preset = String(entry.values.interfacePreset).trim();
            if (!INTERFACE_PRESET_SET.has(preset)) return brandingError('INVALID_SAVED_THEMES', 'savedThemes', `O tema "${name}" possui uma interface inválida.`);
        }
    }
    return null;
}

function validateBrandingPatch(body) {
    if (!body || typeof body !== 'object') return null;
    if (body.interfacePreset !== undefined) {
        const value = String(body.interfacePreset).trim();
        if (value !== '' && !INTERFACE_PRESET_SET.has(value)) {
            return brandingError('INVALID_INTERFACE_PRESET', 'interfacePreset', `interfacePreset inválido. Use ${INTERFACE_PRESETS.join(', ')} ou deixe vazio para herdar.`);
        }
    }
    if (body.savedThemes !== undefined) return validateSavedThemes(body.savedThemes);
    return null;
}

function normalizeSavedThemes(savedThemes) {
    return savedThemes.map(entry => {
        const values = {};
        SAVED_THEME_VALUE_KEYS.forEach(key => {
            if (entry.values[key] !== undefined) values[key] = String(entry.values[key]).trim();
        });
        return {
            id: String(entry.id).trim(),
            name: String(entry.name).trim(),
            createdAt: String(entry.createdAt || '').trim(),
            values,
        };
    });
}

function extractBranding(body) {
    const out = {};
    if (!body || typeof body !== 'object') return out;
    const validationError = validateBrandingPatch(body);
    if (validationError) {
        const error = new Error(validationError.message);
        error.status = 400;
        error.code = validationError.code;
        error.field = validationError.field;
        throw error;
    }
    BRANDING_KEYS.forEach(k => { if (body[k] !== undefined) out[k] = String(body[k]).trim(); });
    BOOLEAN_KEYS.forEach(k => { if (body[k] !== undefined) out[k] = !!body[k]; });
    if (body.savedThemes !== undefined) out.savedThemes = normalizeSavedThemes(body.savedThemes);
    return out;
}

function extractInstitutional(body) {
    const out = {};
    if (!body || typeof body !== 'object') return out;
    INSTITUTIONAL_KEYS.forEach(k => { if (body[k] !== undefined) out[k] = String(body[k]).trim(); });
    return out;
}

// Primeiro valor não-vazio entre os níveis (Curso → Escola → Sistema → padrão).
function pickCascade(key, course, school, global) {
    const chain = [course && course.branding, school && school.branding, global, DEFAULT_BRANDING];
    for (const src of chain) {
        if (!src || src[key] === undefined || src[key] === null || src[key] === '') continue;
        if (key === 'interfacePreset') {
            const value = String(src[key]).trim();
            if (INTERFACE_PRESET_SET.has(value)) return value;
            continue;
        }
        return src[key];
    }
    return DEFAULT_BRANDING[key] !== undefined ? DEFAULT_BRANDING[key] : '';
}

// Calcula a identidade efetiva de um curso, com os dados institucionais da escola.
function resolveEffectiveBranding({ global, school, course }) {
    const effective = {};
    [...BRANDING_KEYS, ...BOOLEAN_KEYS].forEach(k => { effective[k] = pickCascade(k, course, school, global); });
    return {
        ...effective,
        schoolId: (course && course.schoolId) || (school && school.id) || null,
        schoolName: (school && (school.name || (school.info && school.info.tradeName))) || '',
        institution: (school && school.info) || {},
    };
}

module.exports = {
    BRANDING_KEYS,
    BOOLEAN_KEYS,
    INTERFACE_PRESETS,
    SAVED_THEME_VALUE_KEYS,
    MAX_SAVED_THEMES,
    INSTITUTIONAL_KEYS,
    DEFAULT_BRANDING,
    validateBrandingPatch,
    extractBranding,
    extractInstitutional,
    resolveEffectiveBranding,
};
