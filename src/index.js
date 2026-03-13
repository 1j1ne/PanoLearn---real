require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');

const authRoutes     = require('./routes/auth');
const generateRoutes = require('./routes/generate');
const billingRoutes  = require('./routes/billing');

const app = express();

app.use(helmet());

// ── CORS — allow everything (Chrome extension + web) ─────────────────────
app.use(cors({ origin: true, credentials: true }));

// ── Body parsers ──────────────────────────────────────────────────────────
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/auth',     authRoutes);
app.use('/generate', generateRoutes);
app.use('/billing',  billingRoutes);

app.use((_, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PanoLearn backend running on port ${PORT} [${process.env.NODE_ENV}]`);
});
