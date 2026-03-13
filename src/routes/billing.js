// src/routes/billing.js
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

const PRICE_IDS = {
  PRO:    process.env.STRIPE_PRO_PRICE_ID,
  CAMPUS: process.env.STRIPE_CAMPUS_PRICE_ID,
};

// ── POST /billing/checkout — create Stripe checkout session ──────────────
router.post('/checkout', requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!PRICE_IDS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  // Get or create Stripe customer
  let customerId = req.user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: req.user.email,
      metadata: { userId: req.user.id }
    });
    customerId = customer.id;
    await prisma.user.update({ where: { id: req.user.id }, data: { stripeCustomerId: customerId } });
  }

  const session = await stripe.checkout.sessions.create({
    customer:   customerId,
    mode:       'subscription',
    line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
    success_url: 'https://panolearn.app/billing/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url:  'https://panolearn.app/billing/cancel',
    metadata: { userId: req.user.id, plan },
  });

  res.json({ url: session.url });
});

// ── POST /billing/portal — open Stripe customer portal ───────────────────
router.post('/portal', requireAuth, async (req, res) => {
  if (!req.user.stripeCustomerId) {
    return res.status(400).json({ error: 'No active subscription' });
  }
  const session = await stripe.billingPortal.sessions.create({
    customer:   req.user.stripeCustomerId,
    return_url: 'https://panolearn.app/settings',
  });
  res.json({ url: session.url });
});

// ── POST /billing/webhook — Stripe webhook handler ────────────────────────
// Use express.raw() for this route (signature verification requires raw body)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: `Webhook error: ${e.message}` });
  }

  const session = event.data.object;

  switch (event.type) {

    case 'checkout.session.completed': {
      const userId = session.metadata?.userId;
      const plan   = session.metadata?.plan;
      if (!userId || !plan) break;
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      await prisma.user.update({
        where: { id: userId },
        data: {
          plan,
          stripeSubId: sub.id,
          subCurrentPeriodEnd: new Date(sub.current_period_end * 1000),
        }
      });
      break;
    }

    case 'invoice.payment_succeeded': {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      const user = await prisma.user.findFirst({ where: { stripeSubId: sub.id } });
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: { subCurrentPeriodEnd: new Date(sub.current_period_end * 1000) }
        });
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const user = await prisma.user.findFirst({ where: { stripeSubId: session.id } });
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: { plan: 'FREE', stripeSubId: null, subCurrentPeriodEnd: null }
        });
      }
      break;
    }
  }

  res.json({ received: true });
});

// ── GET /billing/usage — how many generations used this period ────────────
router.get('/usage', requireAuth, async (req, res) => {
  const periodStart = req.user.subCurrentPeriodEnd
    ? new Date(req.user.subCurrentPeriodEnd.getTime() - 30 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const count = await prisma.generation.count({
    where: { userId: req.user.id, createdAt: { gte: periodStart } }
  });

  const limits = { FREE: null, PRO: 300, CAMPUS: null };
  res.json({
    used:  count,
    limit: limits[req.user.plan],
    plan:  req.user.plan,
    periodStart,
    periodEnd: req.user.subCurrentPeriodEnd,
  });
});

module.exports = router;
