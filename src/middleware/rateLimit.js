// src/middleware/rateLimit.js
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── IP-level rate limit (unauthenticated endpoints like /auth) ────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  message: { error: 'Too many requests from this IP, try again in 15 minutes.' }
});

// ── Per-user generation limit based on plan ───────────────────────────────
async function generationLimiter(req, res, next) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  // CAMPUS: unlimited
  if (user.plan === 'CAMPUS') return next();

  // FREE: BYOK — they're using their own key, no platform limit
  // (we still log for analytics, but don't block)
  if (user.plan === 'FREE') return next();

  // PRO: 300 generations per billing period
  if (user.plan === 'PRO') {
    const periodStart = user.subCurrentPeriodEnd
      ? new Date(user.subCurrentPeriodEnd.getTime() - 30 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const count = await prisma.generation.count({
      where: { userId: user.id, createdAt: { gte: periodStart } }
    });

    if (count >= 300) {
      return res.status(429).json({
        error: 'Monthly generation limit reached (300/month on Pro plan).',
        upgradeUrl: 'https://panolearn.app/upgrade'
      });
    }
  }

  next();
}

module.exports = { authLimiter, generationLimiter };
