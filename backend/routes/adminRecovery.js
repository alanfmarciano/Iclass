const express = require('express');
const path = require('path');
const db = require('../database.js');
const { validateAdmin, isProfessorAccount } = require('../middlewares.js');
const fileStore = require('../utils/storage.js');
const backupUtil = require('../utils/backup.js');

function createAdminRecoveryRouter({ uploadForRequest, rejectInvalidUpload, uploadDir }) {
    if (typeof uploadForRequest !== 'function' || typeof rejectInvalidUpload !== 'function' || !uploadDir) {
        throw new Error('Dependências de upload inválidas para adminRecovery.');
    }

    const router = express.Router();

    router.get('/api/admin/trash', (req, res) => {
        validateAdmin(req, res, () => res.json(fileStore.listTrash()));
    });

    router.post('/api/admin/trash/restore', (req, res) => {
        validateAdmin(req, res, () => {
            const result = fileStore.restoreTrash(String((req.body && req.body.id) || ''));
            if (!result.ok) return res.status(400).json({ error: result.error });
            res.json({ success: true, restoredTo: result.restoredTo });
        });
    });

    router.post('/api/admin/trash/delete', (req, res) => {
        validateAdmin(req, res, () => {
            try {
                const removed = fileStore.deleteTrashItem(String((req.body && req.body.id) || ''));
                if (!removed) return res.status(404).json({ error: 'Item não encontrado na lixeira.' });
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ error: error.message || 'Identificador inválido.' });
            }
        });
    });

    router.post('/api/admin/trash/empty', (req, res) => {
        validateAdmin(req, res, () => {
            const removed = fileStore.emptyTrash();
            res.json({ success: true, removed });
        });
    });

    // SEG-X1: o arquivo de backup leva todos os alunos, atestados e os hashes de senha
    // das contas; baixar e restaurar é exclusivo do administrador. Professor com
    // "Executar manutenção" só gera a cópia de segurança, que fica no servidor.
    function rejectProfessor(res, matchedAdmin) {
        if (!isProfessorAccount(matchedAdmin)) return false;
        res.status(403).json({ error: 'Baixar ou restaurar backup é exclusivo do administrador.' });
        return true;
    }

    router.post('/api/admin/backup/server', (req, res) => {
        validateAdmin(req, res, async () => {
            await db.save();
            const file = backupUtil.saveServerBackup('manual');
            res.json({ success: true, fileName: path.basename(file), createdAt: Date.now() });
        });
    });

    router.get('/api/admin/backup/data', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            await db.save();
            const stamp = new Date().toISOString().slice(0, 10);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="iclass-backup-dados_${stamp}.json"`);
            res.send(JSON.stringify(backupUtil.buildDataSnapshot()));
        });
    });

    router.get('/api/admin/backup/full', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            await db.save();
            const stamp = new Date().toISOString().slice(0, 10);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="iclass-backup-completo_${stamp}.zip"`);
            try {
                await backupUtil.streamFullZip(res);
            } catch (error) {
                if (!res.headersSent) res.status(500).json({ error: 'Falha ao gerar backup completo.' });
                else res.destroy(error);
            }
        });
    });

    router.post('/api/admin/backup/restore', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            uploadForRequest().single('file')(req, res, async (error) => {
                if (error) return res.status(400).json({ error: `Erro no upload: ${error.message}` });
                if (!req.file) return res.status(400).json({ error: 'Envie o arquivo de backup (.json ou .zip).' });
                if (rejectInvalidUpload(req, res)) return;

                const temporaryFile = path.join(uploadDir, req.file.filename);
                if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESTAURAR') {
                    fileStore.moveToTrash(temporaryFile);
                    return res.status(400).json({ error: 'Confirme digitando RESTAURAR.' });
                }
                // Contas de acesso atuais ficam como estão, salvo pedido explícito.
                const replaceAccounts = ['1', 'true', 'sim', 'on'].includes(String(req.body.replaceAccounts || '').trim().toLowerCase());
                try {
                    await backupUtil.restoreFromFile(temporaryFile, req.file.originalname, { replaceAccounts });
                    fileStore.moveToTrash(temporaryFile);
                    console.log(`[backup] Restauração feita por ${matchedAdmin && matchedAdmin.email} (${req.ip}) em ${new Date().toISOString()}${replaceAccounts ? ' com substituição das contas' : ''}.`);
                    res.json({ success: true, replaceAccounts });
                } catch (restoreError) {
                    fileStore.moveToTrash(temporaryFile);
                    res.status(400).json({ error: restoreError.message || 'Falha ao restaurar backup.' });
                }
            });
        });
    });

    return router;
}

module.exports = { createAdminRecoveryRouter };
