// src/index.js
require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');

const authRoutes     = require('./routes/auth');
const generateRoutes = require('./routes/generate');
const billingRoutes  = require('./routes/billing');

const app = express();

// ── Security headers ──────────────────────────────────────────────────────
app.use(helmet());

// ── CORS — allow Chrome extension + web dashboard ─────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl) or matching allowlist
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
}));

// ── Body parsers ──────────────────────────────────────────────────────────
// NOTE: /billing/webhook needs raw body — must come BEFORE json()
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));  // transcripts can be large

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/auth',     authRoutes);
app.use('/generate', generateRoutes);
app.use('/billing',  billingRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ─────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PanoLearn backend running on port ${PORT} [${process.env.NODE_ENV}]`);
});
