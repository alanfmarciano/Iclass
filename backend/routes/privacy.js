// Rotas públicas e do aluno sobre privacidade (LGPD).
//
// H8a-1 (SEG-08, OPS-12): GET /api/legal/documents?escola=ID|courseId=ID, sem login, com
// os Termos de Uso e a Política de Privacidade atuais, já com os dados da escola nos
// marcadores. O atual é a maior versão publicada; sem publicação, é o modelo do IClass
// (isModel: true), e ninguém precisa aceitar nada. O rascunho nunca aparece aqui.
// Funciona sem internet: o texto mora no banco e o modelo, no código.
//
// O H8a-2 acrescenta aqui o status e o aceite do aluno (privacy/status e privacy/accept).
const express = require('express');
const db = require('../database.js');
const { publicLegalDocuments } = require('../utils/legalDocuments.js');

const router = express.Router();

function queryText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

router.get('/api/legal/documents', (req, res) => {
    const query = req.query || {};
    res.json(publicLegalDocuments(db.memory, {
        escola: queryText(query.escola) || queryText(query.schoolId),
        courseId: queryText(query.courseId),
    }));
});

module.exports = router;
