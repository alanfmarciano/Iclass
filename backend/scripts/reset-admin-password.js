// Redefine a senha de uma conta administrativa SEM precisar da senha atual.
// Uso (com o servidor PARADO, para a memória dele não sobrescrever o banco):
//   node backend/scripts/reset-admin-password.js            -> primeiro administrador cadastrado
//   node backend/scripts/reset-admin-password.js email@x.com -> conta informada (admin ou professor)
// Gera uma senha temporária, marca a conta para trocar a senha no próximo login, encerra
// as sessões abertas dessa conta e imprime a senha no terminal. Nada sai pela rede: só
// quem tem acesso ao computador do servidor consegue usar.
const crypto = require('crypto');
const db = require('../database.js');
const { recordAudit } = require('../utils/audit.js');

async function resetAdminPassword(requestedEmail) {
    const email = String(requestedEmail || '').trim().toLowerCase();
    const admins = db.memory.admins || [];
    const account = email
        ? admins.find(item => item && String(item.email || '').toLowerCase() === email)
        : admins.find(item => item && item.email && (!item.role || item.role === 'admin'));
    if (!account) {
        throw new Error(email ? `Conta ${email} não encontrada.` : 'Nenhuma conta administradora cadastrada.');
    }
    const temporaryPassword = crypto.randomBytes(9).toString('base64url');
    account.password = db.hashPassword(temporaryPassword);
    account.mustChangePassword = true;
    // As sessões abertas da conta acabam aqui, também as gravadas em auth_sessions (H3a-2),
    // que o boot retomaria se o servidor voltasse em até 60 min. Sem isso, quem tinha a
    // sessão (o motivo comum de redefinir a senha) voltava logado e, com a troca
    // obrigatória, escolhia a senha nova sem conhecer a temporária. As outras contas
    // continuam conectadas.
    const sessionsRevoked = db.revokeAccountSessions({ kind: 'admin', email: account.email });
    // Senha temporária do launcher = troca pedida sem passwordChangeReason (utils/
    // passwordChange.js): vale também com TEST_MODE e não pede a senha atual. Um motivo
    // antigo ('weak', 'created', 'reset') ficava e mudava as duas coisas: com TEST_MODE a
    // troca deixava de ser pedida, e a tela dizia "A sua senha é fácil de adivinhar".
    delete account.passwordChangeReason;
    // Mesmo registro de antes (type/actorEmail/at), pelo recordAudit; quem fez é o
    // computador do servidor (launcher), não uma conta.
    const at = Date.now();
    recordAudit(db.memory, { actor: 'launcher-local', action: 'admin_password_reset_local', category: 'security', targetEmail: account.email }, {
        timestamp: at,
        legacy: { type: 'admin_password_reset_local', actorEmail: 'launcher-local', at },
    });
    await db.save();
    return { email: account.email, temporaryPassword, sessionsRevoked };
}

if (require.main === module) {
    (async () => {
        await db.init();
        const result = await resetAdminPassword(process.argv[2]);
        await db.close();
        console.log('');
        console.log('Senha temporária definida.');
        console.log(`Usuário: ${result.email}`);
        console.log(`Senha temporária: ${result.temporaryPassword}`);
        if (result.sessionsRevoked) console.log('As sessões abertas desta conta foram encerradas: será preciso entrar de novo.');
        console.log('Entre como Instrutor e troque a senha no primeiro acesso.');
    })().catch(error => {
        console.error(`Erro: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { resetAdminPassword };
