import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { User, Role, RolePermission, Permission } from '../models/index.js';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS } from '../constants/permissions.js';
import { HttpError } from '../errors/http-error.js';

export async function authenticate(req, _res, next) {
  try {
    const raw = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!raw) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
    const claims = jwt.verify(raw, config.jwtSecret, { algorithms: ['HS256'], issuer: 'serveflow-pos' });
    if (claims.type !== 'access') throw new Error('Invalid token type');
    const user = await User.findByPk(claims.sub);
    if (!user || !user.active || user.restaurantId !== claims.restaurantId) throw new Error('Account unavailable');
    let permissions = DEFAULT_PERMISSIONS[user.role] || [];
    if (user.role === 'OWNER') permissions = ALL_PERMISSIONS;
    else {
      const role = await Role.findOne({ where: { restaurantId: user.restaurantId, name: user.role } });
      if (role) {
        const grants = await RolePermission.findAll({ where: { roleId: role.id } });
        const entries = await Permission.findAll({ where: { id: grants.map((g) => g.permissionId) } });
        permissions = entries.map((p) => p.code);
      }
    }
    req.auth = { userId: user.id, restaurantId: user.restaurantId, role: user.role, permissions };
    next();
  } catch (error) { next(error instanceof HttpError ? error : new HttpError(401, 'UNAUTHORIZED', 'Invalid or expired session')); }
}
export const requirePermission = (permission) => (req, _res, next) => req.auth.permissions.includes(permission)
  ? next() : next(new HttpError(403, 'FORBIDDEN', 'Permission denied'));
