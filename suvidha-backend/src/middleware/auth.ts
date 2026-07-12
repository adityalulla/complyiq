import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';

// Extend Express's Request type so `req.user` is recognized everywhere else in the app.
declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; email: string };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.slice('Bearer '.length);

  try {
    const payload = verifyAccessToken(token);
    req.user = { userId: payload.userId, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired access token' });
  }
}
