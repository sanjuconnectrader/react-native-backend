import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { User } from '../models/index.js';
let io;
export function initSockets(server) {
  io = new Server(server, { cors: { origin: config.corsOrigins } });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: 'serveflow-pos' });
      const user = await User.findByPk(claims.sub);
      if (!user?.active || claims.type !== 'access' || user.restaurantId !== claims.restaurantId) throw new Error('Unauthorized');
      socket.data.restaurantId = user.restaurantId;
      next();
    } catch { next(new Error('Unauthorized')); }
  });
  io.on('connection', (socket) => socket.join(`restaurant:${socket.data.restaurantId}`));
}
export function emitRestaurant(restaurantId, event, data) { io?.to(`restaurant:${restaurantId}`).emit(event, data); }
