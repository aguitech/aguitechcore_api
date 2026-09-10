import { Router } from 'express';
import { submitScore, getLeaderboard, getMyStats } from '../controllers/juego.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.post('/score', submitScore);
router.get('/leaderboard', getLeaderboard);
router.get('/me', getMyStats);

export default router;
