// ---------------------------------------------------------------------------
// Configuracao central de SESSAO (seguranca de login).
// - SERVER_INSTANCE_ID: identidade unica gerada a cada boot do servidor. Se o
//   servidor for parado/reiniciado, o id muda; o cliente detecta a divergencia
//   e forca novo login (impede "sessao herdada" entre turnos).
// - TTLs: prazo maximo absoluto e inatividade das sessoes. Ajustaveis aqui.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const SERVER_INSTANCE_ID = crypto.randomBytes(12).toString('hex');

// Prazo maximo ABSOLUTO desde o login, mesmo em uso continuo (backstop no servidor).
const ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas

// Inatividade: enforced principalmente no CLIENTE (eventos reais de usuario),
// pois o heartbeat do aluno impede medir ociosidade no servidor. Exposto aqui
// para o frontend consumir via /api/session/status? Nao: fica como constante
// compartilhada de referencia para o backend.
const IDLE_TTL_MS = 60 * 60 * 1000; // 60 minutos

module.exports = { SERVER_INSTANCE_ID, ABSOLUTE_TTL_MS, IDLE_TTL_MS };
