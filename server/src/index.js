import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { connectDB } from './config/db.js';
import authRoutes from './routes/auth.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import clientRoutes from './routes/client.routes.js';
import taskRoutes from './routes/task.routes.js';
import incidentRoutes from './routes/incident.routes.js';
import calendarRoutes from './routes/calendar.routes.js';
import profileRoutes from './routes/profile.routes.js';
import apikeyRoutes from './routes/apikey.routes.js';
import userRoutes from './routes/user.routes.js';
import chatRoutes from './routes/chat.routes.js';
import mcpRoutes from './routes/mcp.routes.js';
import postRoutes from './routes/post.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';
import auditRoutes from './routes/audit.routes.js';
import appointmentsRoutes from './routes/appointments.routes.js';
import { getSitemap, getRobots } from './controllers/sitemap.controller.js';
import { errorHandler } from './middleware/error.js';
import { AuditLog } from './models/AuditLog.js';
import { Notification } from './models/Notification.js';
import juegoRoutes from './routes/juego.routes.js';
import { attachCiudadWS } from './lib/ciudad-ws.js';
import http from 'http';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '2mb' }));

// Servir archivos subidos
app.use('/api/uploads', express.static(path.resolve('uploads')));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'aguittech-core', ts: Date.now() }));

// Serve /ciudad/ static game files (so Traefik routes /ciudad → API and WS upgrade reaches ciudad-ws.js)
// IMPORTANT: bypass express.static for WebSocket upgrades so the WS server can intercept them.
const ciudadDir = path.resolve('public/ciudad');
app.use('/ciudad', (req, res, next) => {
  // Bypass for WebSocket upgrades — let the WS server handle them
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    return next();
  }
  // Only serve static for GET/HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  express.static(ciudadDir, { index: 'index.html' })(req, res, next);
});
app.get('/ciudad', (_req, res) => res.sendFile(path.join(ciudadDir, 'index.html')));

// Sitemap.xml — public, generated on demand from published posts.
// Mounted at the top level (no auth, no router prefix) so Google/Bing/etc.
// can fetch /sitemap.xml without credentials. Crawlers will hit the
// sitemap at the bare URL, so we serve both /sitemap.xml and /api/sitemap.xml.
app.get('/sitemap.xml', getSitemap);
app.get('/api/sitemap.xml', getSitemap);
// robots.txt — also public; declares which paths crawlers should skip.
app.get('/robots.txt', getRobots);

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/profile/apikeys', apikeyRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api/blog', postRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/audit-log', auditRoutes);
// Note: /api/appointments/public/* must be reachable without auth — those routes
// are mounted before requireAuth inside appointments.routes.js, but the public
// paths are also whitelisted here at the top level.
app.use('/api/appointments', appointmentsRoutes);

// 🧩 Juego /juego/* — Tetris con leaderboard autenticado (requiere login en sxxysecret)
app.use('/api/juego', juegoRoutes);

app.use(errorHandler);

connectDB().then(async () => {
  // Best-effort TTL index setup — keep audit/notifications collections lean
  try {
    await AuditLog.ensureTTL(180);
    await Notification.ensureTTL(90);
  } catch (err) {
    console.warn('[startup] TTL setup failed:', err?.message || err);
  }
  // Create HTTP server (so we can attach WebSocket for /ciudad)
  const httpServer = http.createServer(app);
  attachCiudadWS(httpServer);
  httpServer.listen(PORT, () => console.log(`🚀 API corriendo en http://localhost:${PORT} (ws: /ciudad)`));
});
