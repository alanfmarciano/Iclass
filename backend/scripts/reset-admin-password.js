// Redefine a senha de uma conta administrativa SEM precisar da senha atual.
// Uso (com o servidor PARADO, para a memória dele não sobrescrever o banco):
//   node backend/scripts/reset-admin-password.js            -> primeiro administrador cadastrado
//   node backend/scripts/reset-admin-password.js email@x.com -> conta informada (admin ou professor)
// Gera uma senha temporária, marca a conta para trocar a senha no próximo login e
// imprime a senha no terminal. Nada sai pela rede: só quem tem acesso ao computador
// do servidor consegue usar.
const crypto = require('crypto');
const db = require('../database.js');

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
    if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
    db.memory.auditLogs.push({
        id: `audit_pwreset_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        type: 'admin_password_reset_local',
        actorEmail: 'launcher-local',
        targetEmail: account.email,
        at: Date.now(),
    });
    await db.save();
    return { email: account.email, temporaryPassword };
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
        console.log('Entre como Instrutor e troque a senha no primeiro acesso.');
    })().catch(error => {
        console.error(`Erro: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { resetAdminPassword };
