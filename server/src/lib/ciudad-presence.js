// In-memory presence tracker for the 3D ciudad at /ciudad/
// Each connected user holds: { ws, userId, name, role, x, y, z, ry, lastSeen, color }
// We broadcast state to all peers on every move.

const COLOR_PALETTE = [
  '#00d4ff', // cyan
  '#ffaa00', // amber
  '#ff4d8d', // pink
  '#7c4dff', // purple
  '#00ff88', // green
  '#ff7a00', // orange
  '#ffd400', // yellow
  '#ff3838', // red
];

function pickColor(userId) {
  // Hash userId to a stable color so the same user always gets the same color
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return COLOR_PALETTE[h % COLOR_PALETTE.length];
}

class CiudadPresence {
  constructor() {
    /** @type {Map<string, any>} key=userId */
    this.peers = new Map();
    /** @type {Map<string, string>} key=wsId -> userId */
    this.wsToUser = new Map();
  }

  add(ws, userId, user) {
    const entry = {
      ws,
      userId,
      name: user.name,
      role: user.role,
      x: 0,
      y: 0.5,
      z: 0,
      ry: 0,
      anim: 'idle',
      color: pickColor(userId),
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.peers.set(userId, entry);
    this.wsToUser.set(ws._id || this._wsId(ws), userId);
    return entry;
  }

  _wsId(ws) {
    if (!ws._id) ws._id = Math.random().toString(36).slice(2, 10);
    return ws._id;
  }

  removeByWs(ws) {
    const wid = ws._id || this._wsId(ws);
    const userId = this.wsToUser.get(wid);
    if (userId) {
      this.peers.delete(userId);
      this.wsToUser.delete(wid);
    }
    return userId;
  }

  update(userId, { x, y, z, ry, anim }) {
    const p = this.peers.get(userId);
    if (!p) return null;
    if (typeof x === 'number') p.x = x;
    if (typeof y === 'number') p.y = y;
    if (typeof z === 'number') p.z = z;
    if (typeof ry === 'number') p.ry = ry;
    if (typeof anim === 'string') p.anim = anim;
    p.lastSeen = Date.now();
    return p;
  }

  // Returns array of all peers (excluding `excludeUserId`) — for broadcasting
  snapshot(excludeUserId = null) {
    const arr = [];
    for (const [uid, p] of this.peers) {
      if (uid === excludeUserId) continue;
      arr.push({
        userId: p.userId,
        name: p.name,
        role: p.role,
        color: p.color,
        x: p.x,
        y: p.y,
        z: p.z,
        ry: p.ry,
        anim: p.anim,
      });
    }
    return arr;
  }

  count() {
    return this.peers.size;
  }
}

// Single shared instance per process
export const presence = new CiudadPresence();
