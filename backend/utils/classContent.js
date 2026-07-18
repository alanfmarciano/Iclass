const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const runtimePaths = require('../runtimePaths.js');

function deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function findCourse(courseId) {
    return (db.memory.courses || []).find(course => String(course.id) === String(courseId)) || null;
}

function findClass(courseId, className) {
    return (db.memory.classes || []).find(cls => String(cls.courseId) === String(courseId) && String(cls.name) === String(className)) || null;
}

function ensureOverrides(cls) {
    if (!cls) return null;
    if (!cls.contentOverrides || typeof cls.contentOverrides !== 'object') cls.contentOverrides = {};
    if (!cls.contentOverrides.materials || typeof cls.contentOverrides.materials !== 'object') cls.contentOverrides.materials = {};
    if (!cls.contentOverrides.evaluations || typeof cls.contentOverrides.evaluations !== 'object') cls.contentOverrides.evaluations = {};
    if (!cls.contentOverrides.unitNames || typeof cls.contentOverrides.unitNames !== 'object') cls.contentOverrides.unitNames = {};
    if (!Array.isArray(cls.contentOverrides.extraUnits)) cls.contentOverrides.extraUnits = [];
    if (!Array.isArray(cls.contentOverrides.structure)) cls.contentOverrides.structure = null;
    return cls.contentOverrides;
}

function variantSuffix(courseId, className) {
    return crypto.createHash('sha1').update(`${courseId}::${className}`).digest('hex').slice(0, 10);
}

function uniqueVariantKey(baseKey, courseId, className) {
    const safeBase = String(baseKey || 'Conteudo').replace(/[^a-zA-Z0-9_-]/g, '_');
    const stem = `${safeBase}__turma_${variantSuffix(courseId, className)}`;
    let key = stem;
    let index = 2;
    while (db.memory.evaluations?.[key] || fs.existsSync(path.join(runtimePaths.CONTENT_DIR, `${key}.md`))) {
        key = `${stem}_${index++}`;
    }
    return key;
}

function mappingForKey(overrides, kind, key) {
    const map = overrides?.[kind] || {};
    for (const [baseKey, entry] of Object.entries(map)) {
        if (String(entry?.key || entry) === String(key)) return { baseKey, entry: typeof entry === 'string' ? { key: entry } : entry };
    }
    return null;
}

function effectiveStructure(courseId, className) {
    const course = findCourse(courseId);
    if (!course) return null;
    const cls = className ? findClass(courseId, className) : null;
    const overrides = cls ? ensureOverrides(cls) : null;
    const structure = deepClone(overrides?.structure || course.structure || []);
    const variants = {};

    structure.forEach(module => {
        (module.units || module.items || []).forEach(unit => {
            const originalMaterialKey = unit.apostilaKey;
            const originalEvaluationKey = unit.avaliacaoKey;
            const materialMapping = originalMaterialKey && overrides
                ? (overrides.materials[originalMaterialKey]
                    ? { baseKey: originalMaterialKey, entry: overrides.materials[originalMaterialKey] }
                    : mappingForKey(overrides, 'materials', originalMaterialKey))
                : null;
            if (unit.apostilaKey && materialMapping) {
                const baseKey = materialMapping.baseKey;
                unit.apostilaKey = materialMapping.entry.key || materialMapping.entry;
                variants[unit.apostilaKey] = { kind: 'material', scope: 'class', baseKey };
            } else if (unit.apostilaKey) variants[unit.apostilaKey] = { kind: 'material', scope: 'course', baseKey: unit.apostilaKey };

            const evaluationMapping = originalEvaluationKey && overrides
                ? (overrides.evaluations[originalEvaluationKey]
                    ? { baseKey: originalEvaluationKey, entry: overrides.evaluations[originalEvaluationKey] }
                    : mappingForKey(overrides, 'evaluations', originalEvaluationKey))
                : null;
            if (unit.avaliacaoKey && evaluationMapping) {
                const baseKey = evaluationMapping.baseKey;
                unit.avaliacaoKey = evaluationMapping.entry.key || evaluationMapping.entry;
                variants[unit.avaliacaoKey] = { kind: 'evaluation', scope: 'class', baseKey };
            } else if (unit.avaliacaoKey) variants[unit.avaliacaoKey] = { kind: 'evaluation', scope: 'course', baseKey: unit.avaliacaoKey };

            const nameOverride = overrides?.unitNames?.[evaluationMapping?.baseKey || originalEvaluationKey]
                || overrides?.unitNames?.[materialMapping?.baseKey || originalMaterialKey];
            if (nameOverride) unit.name = nameOverride;
        });
    });

    (overrides?.extraUnits || []).forEach(extra => {
        const module = structure.find((item, index) => String(item.id || item.key || item.name || index) === String(extra.moduleId));
        if (!module) return;
        if (!Array.isArray(module.units)) module.units = Array.isArray(module.items) ? module.items : [];
        const unit = deepClone(extra.unit);
        module.units.push(unit);
        if (unit.apostilaKey) variants[unit.apostilaKey] = { kind: 'material', scope: 'class', baseKey: null };
        if (unit.avaliacaoKey) variants[unit.avaliacaoKey] = { kind: 'evaluation', scope: 'class', baseKey: null };
    });

    return {
        course,
        cls,
        structure,
        variants,
        source: cls && (Object.keys(overrides.materials).length || Object.keys(overrides.evaluations).length || overrides.extraUnits.length) ? 'mixed' : 'course',
    };
}

function courseClasses(courseId) {
    return (db.memory.classes || []).filter(cls => String(cls.courseId) === String(courseId));
}

function forkMaterial({ courseId, className, key }) {
    const cls = findClass(courseId, className);
    if (!cls) throw Object.assign(new Error('Turma não encontrada.'), { status: 404 });
    const overrides = ensureOverrides(cls);
    const existing = mappingForKey(overrides, 'materials', key);
    if (existing) return { key: existing.entry.key, baseKey: existing.baseKey, created: false };
    const effective = effectiveStructure(courseId, className);
    const variantMeta = effective?.variants?.[key];
    if (variantMeta?.scope === 'class' && !variantMeta.baseKey) return { key, baseKey: null, created: false };
    const baseKey = variantMeta?.baseKey || key;
    if (overrides.materials[baseKey]) return { key: overrides.materials[baseKey].key, baseKey, created: false };
    const variantKey = uniqueVariantKey(baseKey, courseId, className);
    const sourcePath = path.join(runtimePaths.CONTENT_DIR, `${baseKey}.md`);
    const targetPath = path.join(runtimePaths.CONTENT_DIR, `${variantKey}.md`);
    fs.writeFileSync(targetPath, fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '', 'utf8');
    overrides.materials[baseKey] = { key: variantKey, createdAt: Date.now() };
    if (cls.releasedItems && cls.releasedItems[baseKey] !== undefined) cls.releasedItems[variantKey] = cls.releasedItems[baseKey];
    return { key: variantKey, baseKey, created: true };
}

function forkEvaluation({ courseId, className, key }) {
    const cls = findClass(courseId, className);
    if (!cls) throw Object.assign(new Error('Turma não encontrada.'), { status: 404 });
    const overrides = ensureOverrides(cls);
    const existing = mappingForKey(overrides, 'evaluations', key);
    if (existing) return { key: existing.entry.key, baseKey: existing.baseKey, created: false };
    const effective = effectiveStructure(courseId, className);
    const variantMeta = effective?.variants?.[key];
    if (variantMeta?.scope === 'class' && !variantMeta.baseKey) return { key, baseKey: null, created: false };
    const baseKey = variantMeta?.baseKey || key;
    if (overrides.evaluations[baseKey]) return { key: overrides.evaluations[baseKey].key, baseKey, created: false };
    const source = db.memory.evaluations?.[baseKey];
    if (!source) throw Object.assign(new Error('Avaliação não encontrada.'), { status: 404 });
    const variantKey = uniqueVariantKey(baseKey, courseId, className);
    db.memory.evaluations[variantKey] = { ...deepClone(source), key: variantKey, sourceEvaluationKey: baseKey };
    overrides.evaluations[baseKey] = { key: variantKey, createdAt: Date.now() };
    if (cls.releasedItems) {
        if (cls.releasedItems[baseKey] !== undefined) cls.releasedItems[variantKey] = cls.releasedItems[baseKey];
        if (cls.releasedItems[`Gabarito_${baseKey}`] !== undefined) cls.releasedItems[`Gabarito_${variantKey}`] = cls.releasedItems[`Gabarito_${baseKey}`];
    }
    return { key: variantKey, baseKey, created: true };
}

function resetOverridesForCourseItem(courseId, kind, baseKey) {
    const affectedClasses = [];
    courseClasses(courseId).forEach(cls => {
        const overrides = ensureOverrides(cls);
        const mapping = mappingForKey(overrides, kind, baseKey);
        const key = mapping?.baseKey || baseKey;
        if (overrides[kind][key]) {
            delete overrides[kind][key];
            affectedClasses.push(cls.name);
        }
        if (overrides.unitNames[baseKey]) delete overrides.unitNames[baseKey];
    });
    return affectedClasses;
}

function resolveBaseKey(courseId, className, kind, key) {
    const cls = findClass(courseId, className);
    const mapping = cls ? mappingForKey(ensureOverrides(cls), kind, key) : null;
    return mapping?.baseKey || key;
}

function addExtraUnit({ courseId, className, moduleId, unit }) {
    const cls = findClass(courseId, className);
    if (!cls) throw Object.assign(new Error('Turma não encontrada.'), { status: 404 });
    const overrides = ensureOverrides(cls);
    overrides.extraUnits.push({ id: `extra_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, moduleId: String(moduleId), unit: deepClone(unit), createdAt: Date.now() });
}

module.exports = {
    addExtraUnit,
    courseClasses,
    deepClone,
    effectiveStructure,
    ensureOverrides,
    findClass,
    findCourse,
    forkEvaluation,
    forkMaterial,
    resetOverridesForCourseItem,
    resolveBaseKey,
    uniqueVariantKey,
};
