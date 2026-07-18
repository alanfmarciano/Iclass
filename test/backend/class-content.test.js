const test = require('node:test')
const assert = require('node:assert/strict')
const db = require('../../backend/database.js')
const { effectiveStructure, ensureOverrides, forkEvaluation, resetOverridesForCourseItem } = require('../../backend/utils/classContent.js')

test('estrutura efetiva isola variantes de avaliação entre turmas do mesmo curso', () => {
    const previous = {
        courses: db.memory.courses,
        classes: db.memory.classes,
        evaluations: db.memory.evaluations,
    }
    try {
        db.memory.courses = [{
            id: 'DES',
            name: 'Desenvolvimento',
            structure: [{ id: 'm1', name: 'Módulo 1', units: [{ id: '1', name: 'Prova base', avaliacaoKey: 'Avaliacao_DES_1' }] }],
        }]
        db.memory.classes = [
            { courseId: 'DES', name: '1DES' },
            { courseId: 'DES', name: '2DES' },
        ]
        db.memory.evaluations = { Avaliacao_DES_1: { key: 'Avaliacao_DES_1', title: 'Prova base', questions: [] } }

        const forked = forkEvaluation({ courseId: 'DES', className: '1DES', key: 'Avaliacao_DES_1' })
        db.memory.evaluations[forked.key].title = 'Prova exclusiva 1DES'

        const first = effectiveStructure('DES', '1DES')
        const second = effectiveStructure('DES', '2DES')
        assert.equal(first.structure[0].units[0].avaliacaoKey, forked.key)
        assert.equal(second.structure[0].units[0].avaliacaoKey, 'Avaliacao_DES_1')
        assert.equal(db.memory.evaluations.Avaliacao_DES_1.title, 'Prova base')

        ensureOverrides(db.memory.classes[0]).unitNames.Avaliacao_DES_1 = 'Prova exclusiva 1DES'
        assert.equal(effectiveStructure('DES', '1DES').structure[0].units[0].name, 'Prova exclusiva 1DES')
        assert.deepEqual(resetOverridesForCourseItem('DES', 'evaluations', 'Avaliacao_DES_1'), ['1DES'])
        assert.equal(effectiveStructure('DES', '1DES').structure[0].units[0].avaliacaoKey, 'Avaliacao_DES_1')
    } finally {
        db.memory.courses = previous.courses
        db.memory.classes = previous.classes
        db.memory.evaluations = previous.evaluations
    }
})
