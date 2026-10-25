// =====================================================================
// Real-time layer: Socket.IO + Redis adapter
//
// Several API containers run at the same time (replicas + several EC2s).
// A browser is connected to ONE of them, but a change may happen on ANOTHER.
// The Redis adapter publishes every emit on Redis pub/sub, so all API
// replicas forward it to their own connected clients.
//
// Rooms:
//   user:<id>      — personal notifications
//   project:<id>   — everyone currently looking at that board
// =====================================================================
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { redis } = require('./redis');
const { userFromToken } = require('./auth');
const { requireProject } = require('./access');
const config = require('../config');
const log = require('./logger');

let io = null;

const projectRoom = (id) => `project:${id}`;
const userRoom = (id) => `user:${id}`;

/** Who is looking at this board right now — across ALL API replicas (via the adapter). */
async function broadcastPresence(room) {
  if (!io) return;
  try {
    const sockets = await io.in(room).fetchSockets();
    const users = new Map();
    for (const s of sockets) if (s.data.user) users.set(s.data.user.id, s.data.user);
    io.to(room).emit('presence', { room, users: [...users.values()] });
  } catch (err) {
    log.warn('Presence broadcast failed', { error: err.message });
  }
}

async function initRealtime(httpServer) {
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  pub.on('error', (e) => log.warn('Redis pub error', { error: e.message }));
  sub.on('error', (e) => log.warn('Redis sub error', { error: e.message }));
  await Promise.all([pub.connect(), sub.connect()]);

  io = new Server(httpServer, {
    path: '/socket.io',
    adapter: createAdapter(pub, sub, { requestsTimeout: 3000 }),
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  // Authenticate the WebSocket handshake with the same JWT as the REST API
  io.use(async (socket, next) => {
    try {
      const user = await userFromToken(socket.handshake.auth?.token || '');
      socket.data.user = { id: user.id, name: user.name, color: user.avatar_color };
      next();
    } catch (err) {
      next(new Error(err.message || 'Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(userRoom(user.id));
    socket.emit('hello', { instance: config.instance });

    socket.on('board:join', async ({ projectId } = {}, ack = () => {}) => {
      try {
        await requireProject(projectId, user.id, 'viewer'); // membership check
        for (const r of socket.rooms) if (r.startsWith('project:')) { socket.leave(r); broadcastPresence(r); }
        const room = projectRoom(projectId);
        socket.join(room);
        ack({ ok: true });
        broadcastPresence(room);
      } catch (err) {
        ack({ ok: false, error: err.message });
      }
    });

    socket.on('board:leave', ({ projectId } = {}) => {
      const room = projectRoom(projectId);
      socket.leave(room);
      broadcastPresence(room);
    });

    // Remember which boards the socket was on, then update presence once it has gone
    socket.on('disconnecting', () => {
      socket.data.leftRooms = [...socket.rooms].filter((r) => r.startsWith('project:'));
    });
    socket.on('disconnect', () => {
      for (const r of socket.data.leftRooms || []) broadcastPresence(r);
    });
  });

  log.info('Socket.IO ready (Redis adapter)');
  return io;
}

const emitToProject = (projectId, event, payload) => io?.to(projectRoom(projectId)).emit(event, payload);
const emitToUser = (userId, event, payload) => io?.to(userRoom(userId)).emit(event, payload);
const closeRealtime = () => new Promise((resolve) => (io ? io.close(() => resolve()) : resolve()));

module.exports = { initRealtime, emitToProject, emitToUser, closeRealtime, projectRoom, userRoom };
