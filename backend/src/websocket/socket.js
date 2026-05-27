/**
 * websocket/socket.js
 * ====================
 * Socket.IO server setup with JWT authentication,
 * room management, and real-time event handling.
 */

'use strict';

const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/jwt');
const logger = require('../utils/logger');

let io = null;

/**
 * Initialize WebSocket server
 * @param {http.Server} server - HTTP server instance
 */
const initializeWebSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()),
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  });

  // ─── Authentication Middleware ─────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];

      if (!token) {
        // Allow unauthenticated for public rooms (e.g., live product stock)
        socket.userId = null;
        socket.userRole = null;
        return next();
      }

      const decoded = verifyAccessToken(token);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch (error) {
      logger.warn('⚠️ Socket auth failed:', { error: error.message });
      next(new Error('Authentication failed'));
    }
  });

  // ─── Connection Handler ────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    logger.info(`🔌 Socket connected: ${socket.id}`, {
      userId: socket.userId,
      ip: socket.handshake.address,
    });

    // Join user-specific room for private notifications
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);

      // Join admin room
      if (['ADMIN', 'SUPERADMIN'].includes(socket.userRole)) {
        socket.join('admin-room');
        logger.info(`👑 Admin joined admin room: ${socket.userId}`);
      }
    }

    // ─── Event: Subscribe to order tracking ──────────────────────────────────
    socket.on('subscribe:order', (orderId) => {
      if (socket.userId) {
        socket.join(`order:${orderId}`);
        logger.debug(`📦 User ${socket.userId} subscribed to order ${orderId}`);
      }
    });

    // ─── Event: Subscribe to product (for real-time stock) ───────────────────
    socket.on('subscribe:product', (productId) => {
      socket.join(`product:${productId}`);
    });

    // ─── Event: Join chat with admin ──────────────────────────────────────────
    socket.on('chat:join', (data) => {
      if (socket.userId) {
        socket.join(`chat:${socket.userId}`);
        io.to('admin-room').emit('chat:newUser', {
          userId: socket.userId,
          socketId: socket.id,
          timestamp: new Date(),
        });
      }
    });

    socket.on('chat:message', (data) => {
      const room = data.isAdmin ? `chat:${data.targetUserId}` : `chat:${socket.userId}`;
      io.to(room).emit('chat:message', {
        ...data,
        from: socket.userId,
        timestamp: new Date(),
      });
      // Also notify admin room
      if (!data.isAdmin) {
        io.to('admin-room').emit('chat:message', { ...data, from: socket.userId });
      }
    });

    // ─── Event: Ping (keep-alive) ─────────────────────────────────────────────
    socket.on('ping', () => socket.emit('pong', { timestamp: Date.now() }));

    // ─── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      logger.info(`🔌 Socket disconnected: ${socket.id}`, { reason, userId: socket.userId });
    });

    socket.on('error', (error) => {
      logger.error('❌ Socket error:', { socketId: socket.id, error: error.message });
    });
  });

  logger.info('✅ Socket.IO initialized');
  return io;
};

/**
 * Get the IO instance (for use in other modules)
 */
const getIO = () => io;

/**
 * Emit event to a specific user
 */
const emitToUser = (userId, event, data) => {
  if (io) io.to(`user:${userId}`).emit(event, data);
};

/**
 * Emit event to all admins
 */
const emitToAdmins = (event, data) => {
  if (io) io.to('admin-room').emit(event, data);
};

/**
 * Emit product stock update
 */
const emitStockUpdate = (productId, stock) => {
  if (io) io.to(`product:${productId}`).emit('stock:update', { productId, stock });
};

/**
 * Emit order status update to subscriber
 */
const emitOrderUpdate = (orderId, data) => {
  if (io) io.to(`order:${orderId}`).emit('order:update', data);
};

module.exports = {
  initializeWebSocket,
  getIO,
  emitToUser,
  emitToAdmins,
  emitStockUpdate,
  emitOrderUpdate,
};
