import { Router } from 'express';
import sessionsRouter from './sessions';
import aiInteractionsRouter from './ai-interactions';
import agentsRouter from './agents';
import submissionsRouter from './submissions';
import liveMonitoringRouter from './live-monitoring';
import videoRouter from './video';
import assessmentsRouter from './assessments';
import mcpDatabaseRouter from './mcp-database';
import authRouter from './auth';
import profilesRouter from './profiles';
import invitationRouter from './invitations';
import adminRouter from './admin';
import uploadsRouter from './uploads';

const router = Router();

// Mount routers
router.use('/auth', authRouter);
router.use('/profiles', profilesRouter);
router.use('/sessions', sessionsRouter);
router.use('/ai-interactions', aiInteractionsRouter);
router.use('/agents', agentsRouter);
router.use('/submissions', submissionsRouter);
router.use('/live-monitoring', liveMonitoringRouter);
router.use('/video', videoRouter);
router.use('/assessments', assessmentsRouter);
router.use('/mcp-database', mcpDatabaseRouter);
router.use('/invitations', invitationRouter);
router.use('/admin', adminRouter);
router.use('/uploads', uploadsRouter);

export default router;

