// WebSocket server for /ciudad/ — authenticates via JWT in the query string
// or Authorization header (browsers can't send custom headers on WS upgrade).
//
// Protocol (JSON over WS):
//   client → server:  { type: 'move', x, y, z, ry, anim }
//   server → client:  { type: 'welcome', self: <me>, peers: [...] }
//   server → client:  { type: 'peer_joined', peer: {...} }
//   server → client:  { type: 'peer_left', userId }
//   server → all:     { type: 'peer_moved', peer: {...} }
//   server → all:     { type: 'chat', userId, name, text, ts }

import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { presence } from './ciudad-presence.js';

const HEARTBEAT_MS = 15000;

function authenticate(req) {
  try {
    const url = new URL(req.url, 'http://x');
    const token =
      url.searchParams.get('token') ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

export function attachCiudadWS(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  function broadcast(payload, excludeWs = null) {
    const data = JSON.stringify(payload);
    for (const c of wss.clients) {
      if (c === excludeWs) continue;
      if (c.readyState === 1) c.send(data);
    }
  }

  httpServer.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ciudad') return; // other upgrades untouched

    const payload = authenticate(req);
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let user;
    try { user = await User.findById(payload.id).lean(); } catch {}
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
  });

  function onConnection(ws, user) {
    ws._id = Math.random().toString(36).slice(2, 10);
    ws.isAlive = true;

    const me = presence.add(ws, String(user._id), user);

    // Welcome the new peer with their identity + everyone already here
    ws.send(JSON.stringify({
      type: 'welcome',
      self: {
        userId: String(user._id),
        name: user.name,
        role: user.role,
        color: me.color,
      },
      peers: presence.snapshot(String(user._id)),
      worldTime: Date.now(),
    }));

    // Announce to others
    broadcast({
      type: 'peer_joined',
      peer: {
        userId: String(user._id),
        name: user.name,
        role: user.role,
        color: me.color,
        x: me.x, y: me.y, z: me.z, ry: me.ry, anim: me.anim,
      },
    }, ws);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'move') {
        const updated = presence.update(String(user._id), {
          x: msg.x, y: msg.y, z: msg.z, ry: msg.ry, anim: msg.anim,
        });
        if (!updated) return;
        broadcast({
          type: 'peer_moved',
          peer: {
            userId: String(user._id),
            name: user.name,
            role: user.role,
            color: me.color,
            x: updated.x, y: updated.y, z: updated.z, ry: updated.ry, anim: updated.anim,
          },
        }, ws);
      } else if (msg.type === 'chat') {
        const text = String(msg.text || '').slice(0, 200);
        if (!text.trim()) return;
        broadcast({
          type: 'chat',
          userId: String(user._id),
          name: user.name,
          role: user.role,
          color: me.color,
          text,
          ts: Date.now(),
        });
      }
    });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => {
      const uid = presence.removeByWs(ws);
      if (uid) broadcast({ type: 'peer_left', userId: uid });
    });
  }

  // Heartbeat: drop silent sockets
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, HEARTBEAT_MS).unref();

  console.log('[ciudad] WebSocket attached at ws://<host>/ciudad (path /ciudad)');
}
