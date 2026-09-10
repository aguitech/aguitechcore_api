// WebSocket handler for /ciudad/ — multiuser 3D world
//
// Wire protocol (JSON):
//   server → client:  { type: 'welcome', self: <me>, peers: [...] }
//   server → client:  { type: 'peer_joined', peer }
//   server → client:  { type: 'peer_moved', peer }
//   server → client:  { type: 'peer_left', userId }
//   server → all:     { type: 'chat', userId, name, text, ts }
//   client → server:  { type: 'move', x, y, z, ry, anim }
//   client → server:  { type: 'chat', text }
//   client → server:  { type: 'dm', to: userId, text }      ← NEW: private DM
//   server → 2 users: { type: 'dm', from, fromName, to, text, ts, conversationId? }

import { WebSocketServer } from 'ws';
import { presence } from './ciudad-presence.js';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
// JWT_SECRET comes from process.env, set in auth controller

const HEARTBEAT_MS = 15000;

export function attachCiudadWS(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/ciudad') return; // other upgrades untouched

    // Authenticate via ?token=...
    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let user;
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      user = await User.findById(payload.id).lean();
      if (!user) throw new Error('user not found');
    } catch (err) {
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
        email: user.email,
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
        email: user.email,
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
            email: user.email,
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
          email: user.email,
          color: me.color,
          text,
          ts: Date.now(),
        });
      } else if (msg.type === 'dm') {
        // Private direct message — only delivered to the two participants
        const toId = String(msg.to || '');
        const text = String(msg.text || '').slice(0, 500);
        if (!toId || !text.trim()) return;
        const fromId = String(user._id);
        if (toId === fromId) return; // ignore self-DM

        const payload = {
          type: 'dm',
          from: fromId,
          fromName: user.name,
          fromEmail: user.email,
          fromColor: me.color,
          to: toId,
          text,
          ts: Date.now(),
        };

        // Send to recipient (if online in this world) and echo back to sender
        const recipient = presence.peers.get(toId);
        if (recipient && recipient.ws.readyState === 1) {
          recipient.ws.send(JSON.stringify(payload));
        }
        // Echo to sender's other tabs (don't double-send to self)
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(payload));
        }
      }
    });

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => {
      const uid = presence.removeByWs(ws);
      if (uid) broadcast({ type: 'peer_left', userId: uid });
    });
  }

  function broadcast(msg, exceptWs = null) {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client === exceptWs) continue;
      if (client.readyState === 1) {
        try { client.send(data); } catch {}
      }
    }
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
