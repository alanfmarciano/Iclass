const express = require('express');
const db = require('../database.js');
const {
    DB_CLASSES_FILE,
    readJSON,
    validateAdmin,
    findClassByNameAndCourse,
    localIpAddresses,
    getReleasedItemsForClass,
} = require('../middlewares.js');
const settingsUtil = require('../utils/settings.js');

function createAdminSystemRouter({ port = process.env.PORT || 3000 } = {}) {
    const router = express.Router();

    router.post('/api/admin/config', (req, res) => {
        validateAdmin(req, res, config => {
            const { studentClass, studentEmail, courseId } = req.body;
            const preferredIp = localIpAddresses.find(ip => !ip.name.toLowerCase().includes('virtualbox') && !ip.address.startsWith('192.168.56.'))
                || localIpAddresses[0]
                || { address: 'localhost' };
            const responseData = {
                activeExamKey: config.activeExamKey,
                releasedItems: config.releasedItems || {},
                serverUrl: `http://${preferredIp.address}:${port}`,
            };

            if (studentClass) {
                const classes = readJSON(DB_CLASSES_FILE);
                const cls = findClassByNameAndCourse(classes, studentClass, courseId);
                if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
                responseData.activeExamKey = cls.activeExamKey;
                responseData.activeExamQuestionCount = cls.activeExamQuestionCount || 20;
                responseData.examConfigs = cls.examConfigs || {};
                responseData.onlineExamConfigs = cls.onlineExamConfigs || {};
                responseData.releasedItems = getReleasedItemsForClass(cls, studentEmail);
            }
            res.json(responseData);
        });
    });

    router.post('/api/admin/flush-exam-state', (req, res) => {
        validateAdmin(req, res, () => {
            const { studentEmail, examKey, studentClass } = req.body;
            let clearedCount = 0;

            if (db.memory.studentExamState && typeof db.memory.studentExamState === 'object') {
                Object.keys(db.memory.studentExamState).forEach(key => {
                    const matchesEmail = !studentEmail
                        || key.startsWith(studentEmail + '_')
                        || key.startsWith(studentEmail + '::');
                    const matchesExam = !examKey || key.includes(examKey);
                    if (matchesEmail && matchesExam) {
                        delete db.memory.studentExamState[key];
                        clearedCount++;
                    }
                });
            }

            if (Array.isArray(db.memory.proctoringLogs)) {
                const before = db.memory.proctoringLogs.length;
                db.memory.proctoringLogs = db.memory.proctoringLogs.filter(log => {
                    // Remove só logs que batem com TODOS os filtros informados (AND):
                    // antes o OR apagava logs de toda a turma ao limpar um aluno.
                    const matchesEmail = !studentEmail || log.studentEmail === studentEmail;
                    const matchesExam = !examKey || log.examKey === examKey;
                    return !(matchesEmail && matchesExam);
                });
                clearedCount += before - db.memory.proctoringLogs.length;
            }

            if (Array.isArray(db.memory.examKeystrokes)) {
                // Mesmo critério AND dos logs de proctoring: limpa o histórico de
                // digitação junto do estado de prova (evita acúmulo em disco).
                const before = db.memory.examKeystrokes.length;
                db.memory.examKeystrokes = db.memory.examKeystrokes.filter(k => {
                    const matchesEmail = !studentEmail || k.studentEmail === studentEmail;
                    const matchesExam = !examKey || k.examKey === examKey;
                    return !(matchesEmail && matchesExam);
                });
                clearedCount += before - db.memory.examKeystrokes.length;
            }

            if (Array.isArray(db.memory.broadcastMessages)) {
                const before = db.memory.broadcastMessages.length;
                db.memory.broadcastMessages = db.memory.broadcastMessages.filter(message => {
                    const matchesEmail = !studentEmail || message.targetEmail === studentEmail;
                    const matchesClass = !studentClass || message.studentClass === studentClass;
                    return !(matchesEmail && matchesClass);
                });
                clearedCount += before - db.memory.broadcastMessages.length;
            }

            if (studentEmail && Array.isArray(db.memory.submissions)) {
                const before = db.memory.submissions.length;
                db.memory.submissions = db.memory.submissions.filter(submission => {
                    const matchesEmail = submission.email === studentEmail || (submission.student && submission.student.email === studentEmail);
                    const matchesExam = !examKey || submission.examKey === examKey;
                    return !(matchesEmail && matchesExam);
                });
                clearedCount += before - db.memory.submissions.length;
            }

            console.log(`[FLUSH] Estado de prova limpo da memória: ${clearedCount} registros removidos.`);
            res.json({
                success: true,
                message: `Estado de prova limpo: ${clearedCount} registros removidos da memória.`,
                clearedCount,
            });
        });
    });

    router.post('/api/admin/server/restart', (req, res) => {
        validateAdmin(req, res, () => {
            res.json({ success: true, message: 'Servidor reiniciando...' });
            const serverInstance = req.app.get('serverInstance');

            const spawnRestart = () => {
                console.log('Iniciando processo de reinicialização...');
                const { spawn } = require('child_process');
                const child = spawn('cmd.exe', ['/c', 'ping 127.0.0.1 -n 3 >nul && node backend/server.js'], {
                    detached: true,
                    stdio: 'ignore',
                    cwd: process.cwd(),
                    shell: true,
                });
                child.unref();
                process.exit(0);
            };

            if (serverInstance) {
                serverInstance.close(() => {
                    console.log('Porta liberada.');
                    spawnRestart();
                });
            }

            setTimeout(() => {
                console.log('Forçando reinicialização do servidor por timeout...');
                spawnRestart();
            }, 2000);
        });
    });

    router.post('/api/admin/reset', (req, res) => {
        validateAdmin(req, res, async config => {
            const cleared = {
                sessions: Object.keys(db.memory.sessions || {}).length,
                examState: Object.keys(db.memory.studentExamState || {}).length,
                messages: (db.memory.broadcastMessages || []).length,
                classes: 0,
            };

            db.memory.sessions = {};
            db.memory.studentExamState = {};
            db.memory.broadcastMessages = [];

            (db.memory.classes || []).forEach(cls => {
                let touched = false;
                if (cls.activeExamKey) {
                    cls.activeExamKey = null;
                    touched = true;
                }
                if (cls.onlineExamConfigs && typeof cls.onlineExamConfigs === 'object') {
                    Object.values(cls.onlineExamConfigs).forEach(examConfig => {
                        if (examConfig && ['running', 'waiting', 'paused'].includes(examConfig.status)) {
                            examConfig.status = 'not_applied';
                            examConfig.onlineActive = false;
                            examConfig.startTime = null;
                            examConfig.waitingRoomStartTimestamp = null;
                            examConfig.updatedAt = new Date().toISOString();
                            touched = true;
                        }
                    });
                }
                if (touched) cleared.classes++;
            });

            if (config && config.activeExamKey) config.activeExamKey = null;
            await db.save();
            res.json({
                success: true,
                message: `Sala resetada: ${cleared.sessions} aluno(s) online, ${cleared.examState} estado(s) de prova e ${cleared.messages} mensagem(ns) limpos em ${cleared.classes} turma(s). Contas e notas foram preservadas.`,
            });
        });
    });

    router.get('/api/admin/settings', (req, res) => {
        validateAdmin(req, res, () => res.json(settingsUtil.getSettings()));
    });

    router.post('/api/admin/settings', (req, res) => {
        validateAdmin(req, res, async () => {
            if (!db.memory.config) db.memory.config = {};
            db.memory.config.settings = settingsUtil.mergeSettings(req.body || {});
            await db.save();
            res.json({ success: true, settings: db.memory.config.settings });
        });
    });

    return router;
}

module.exports = { createAdminSystemRouter };
