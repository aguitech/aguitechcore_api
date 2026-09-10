import TetrisScore from '../models/TetrisScore.js';

// POST /api/juego/score — guarda el score del usuario autenticado
export async function submitScore(req, res) {
  try {
    const { score, level, lines, duration } = req.body;
    if (typeof score !== 'number' || score < 0) {
      return res.status(400).json({ message: 'score inválido' });
    }

    const entry = await TetrisScore.create({
      user: req.user._id,
      name: req.user.name,
      score,
      level: level || 1,
      lines: lines || 0,
      duration: duration || 0,
    });

    res.json({ ok: true, id: entry._id });
  } catch (err) {
    console.error('[juego] submitScore:', err.message);
    res.status(500).json({ message: 'No se pudo guardar el score' });
  }
}

// GET /api/juego/leaderboard — top 20 con el mejor score de cada usuario
export async function getLeaderboard(_req, res) {
  try {
    // Aggregate: solo el mejor score por usuario
    const top = await TetrisScore.aggregate([
      { $sort: { score: -1, createdAt: 1 } },
      {
        $group: {
          _id: '$user',
          name: { $first: '$name' },
          bestScore: { $max: '$score' },
          bestLevel: { $max: '$level' },
          totalLines: { $sum: '$lines' },
          gamesPlayed: { $sum: 1 },
          lastPlayed: { $max: '$createdAt' },
        },
      },
      { $sort: { bestScore: -1 } },
      { $limit: 20 },
    ]);

    // Lookup del role de cada user
    const User = (await import('../models/User.js')).default;
    const userIds = top.map((t) => t._id);
    const users = await User.find({ _id: { $in: userIds } }, { role: 1, name: 1 }).lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const leaderboard = top.map((entry) => {
      const u = userMap.get(String(entry._id));
      return {
        userId: String(entry._id),
        name: entry.name,
        role: u?.role || 'member',
        bestScore: entry.bestScore,
        bestLevel: entry.bestLevel,
        totalLines: entry.totalLines,
        gamesPlayed: entry.gamesPlayed,
        lastPlayed: entry.lastPlayed,
      };
    });

    res.json({ leaderboard });
  } catch (err) {
    console.error('[juego] getLeaderboard:', err.message);
    res.status(500).json({ message: 'No se pudo cargar el leaderboard' });
  }
}

// GET /api/juego/me — score del usuario actual
export async function getMyStats(req, res) {
  try {
    const scores = await TetrisScore.find({ user: req.user._id })
      .sort({ score: -1 })
      .limit(10)
      .lean();

    const best = scores[0]?.score || 0;
    const totalGames = await TetrisScore.countDocuments({ user: req.user._id });
    const totalLines = await TetrisScore.aggregate([
      { $match: { user: req.user._id } },
      { $group: { _id: null, sum: { $sum: '$lines' } } },
    ]);

    res.json({
      bestScore: best,
      totalGames,
      totalLines: totalLines[0]?.sum || 0,
      recent: scores,
    });
  } catch (err) {
    console.error('[juego] getMyStats:', err.message);
    res.status(500).json({ message: 'No se pudo cargar tu stats' });
  }
}
