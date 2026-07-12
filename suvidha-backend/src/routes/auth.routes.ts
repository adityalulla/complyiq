import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { hashPassword, verifyPassword } from '../utils/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { requireAuth } from '../middleware/auth';

export const authRouter = Router();

const signupSchema = z.object({
  name: z.string().min(2, 'Name is too short'),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// POST /auth/signup
authRouter.post('/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }
  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { name, email, passwordHash },
  });

  const accessToken = signAccessToken({ userId: user.id, email: user.email });
  const refreshToken = signRefreshToken({ userId: user.id });

  return res.status(201).json({
    user: { id: user.id, name: user.name, email: user.email },
    accessToken,
    refreshToken,
  });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
});

// POST /auth/login
authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  // Deliberately vague error message - never reveal whether the email exists.
  if (!user) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  const accessToken = signAccessToken({ userId: user.id, email: user.email });
  const refreshToken = signRefreshToken({ userId: user.id });

  return res.json({
    user: { id: user.id, name: user.name, email: user.email },
    accessToken,
    refreshToken,
  });
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// POST /auth/refresh
authRouter.post('/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const payload = verifyRefreshToken(parsed.data.refreshToken);
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
    }
    const accessToken = signAccessToken({ userId: user.id, email: user.email });
    return res.json({ accessToken });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// POST /auth/logout
// Note: since refresh tokens here are stateless JWTs, true server-side invalidation
// needs a stored token/blacklist table - flagged as a TODO before production launch.
// For now, logout is handled client-side by discarding both tokens.
authRouter.post('/logout', requireAuth, async (_req, res) => {
  return res.json({ message: 'Logged out. Discard both tokens on the client.' });
});

