const express = require('express');
const path = require('path');
const db = require('../database.js');
const { validateAdmin } = require('../middlewares.js');
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

    router.get('/api/admin/backup/data', (req, res) => {
        validateAdmin(req, res, async () => {
            await db.save();
            const stamp = new Date().toISOString().slice(0, 10);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="iclass-backup-dados_${stamp}.json"`);
            res.send(JSON.stringify(backupUtil.buildDataSnapshot()));
        });
    });

    router.get('/api/admin/backup/full', (req, res) => {
        validateAdmin(req, res, async () => {
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
        validateAdmin(req, res, () => {
            uploadForRequest().single('file')(req, res, async (error) => {
                if (error) return res.status(400).json({ error: `Erro no upload: ${error.message}` });
                if (!req.file) return res.status(400).json({ error: 'Envie o arquivo de backup (.json ou .zip).' });
                if (rejectInvalidUpload(req, res)) return;

                const temporaryFile = path.join(uploadDir, req.file.filename);
                if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESTAURAR') {
                    fileStore.moveToTrash(temporaryFile);
                    return res.status(400).json({ error: 'Confirme digitando RESTAURAR.' });
                }
                try {
                    await backupUtil.restoreFromFile(temporaryFile, req.file.originalname);
                    fileStore.moveToTrash(temporaryFile);
                    res.json({ success: true });
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
