'use strict';

const DEMO_ACCOUNTS = Object.freeze({
    admin: Object.freeze({ name: 'Ana Administradora', email: 'admin@teste.local', password: 'teste' }),
    professor: Object.freeze({ name: 'Paulo Professor', email: 'professor@teste.local', password: 'teste' }),
    student: Object.freeze({ name: 'Alice Aluna', email: 'aluno@teste.local', password: 'teste' }),
});

module.exports = { DEMO_ACCOUNTS };
