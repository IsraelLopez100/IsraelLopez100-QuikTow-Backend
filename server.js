import "dotenv/config";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import Stripe from "stripe";

const PORT = process.env.PORT || 4000;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/* ---------------------------------- database ---------------------------------- */
// SQLite file on disk. NOTE: on Render's free tier the filesystem is ephemeral —
// this resets on every redeploy/restart. Fine for testing; move to a real
// managed Postgres (Render, Supabase, Neon) before you have real customers.

const db = new Database("quiktow.db");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    price_value REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested',
    customer TEXT,
    driver TEXT,
    pickup TEXT,
    stripe_payment_intent TEXT,
    created_at INTEGER NOT NULL
  );
`);

/* ----------------------------------- app ----------------------------------- */

const app = express();
app.use(cors()); // tighten this to your real frontend origin before launch
app.use((req, res, next) => {
  // Stripe webhook needs the raw body for signature verification, so skip JSON
  // parsing for that one route.
  if (req.originalUrl === "/api/stripe/webhook") return next();
  express.json()(req, res, next);
});

function makeJobId() {
  return "QT" + Math.floor(1000 + Math.random() * 9000);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, stripeConfigured: Boolean(stripe) });
});

// List all jobs, most recent first.
app.get("/api/jobs", (req, res) => {
  const jobs = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all();
  res.json(jobs);
});

// Create a new job request (customer app).
app.post("/api/jobs", (req, res) => {
  const { service, priceValue, pickup, customer } = req.body;
  if (!service || typeof priceValue !== "number") {
    return res.status(400).json({ error: "service and numeric priceValue are required" });
  }
  const id = makeJobId();
  const job = {
    id,
    service,
    price_value: priceValue,
    status: "requested",
    customer: customer || "Guest Customer",
    driver: null,
    pickup: pickup || "",
    stripe_payment_intent: null,
    created_at: Date.now(),
  };
  db.prepare(`
    INSERT INTO jobs (id, service, price_value, status, customer, driver, pickup, stripe_payment_intent, created_at)
    VALUES (@id, @service, @price_value, @status, @customer, @driver, @pickup, @stripe_payment_intent, @created_at)
  `).run(job);
  res.status(201).json(job);
});

// Update job status / assign a driver (driver app + dispatch).
app.patch("/api/jobs/:id", (req, res) => {
  const { status, driver } = req.body;
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });

  const next = {
    status: status ?? job.status,
    driver: driver ?? job.driver,
  };
  db.prepare("UPDATE jobs SET status = @status, driver = @driver WHERE id = @id")
    .run({ ...next, id: req.params.id });

  res.json(db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id));
});

// Create a real Stripe PaymentIntent for a job (test mode until you swap keys).
app.post("/api/jobs/:id/pay", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe is not configured on this server" });
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });

  try {
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(job.price_value * 100), // cents
      currency: "usd",
      metadata: { jobId: job.id },
      automatic_payment_methods: { enabled: true },
    });
    db.prepare("UPDATE jobs SET stripe_payment_intent = ? WHERE id = ?").run(intent.id, job.id);
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook — this is the source of truth for "did the payment actually work."
// Never mark a job paid just because the frontend says so; wait for this event.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send("Webhook not configured");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    const jobId = intent.metadata?.jobId;
    if (jobId) {
      db.prepare("UPDATE jobs SET status = 'paid' WHERE id = ?").run(jobId);
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`QuikTow API listening on port ${PORT}`);
  if (!stripe) console.warn("STRIPE_SECRET_KEY not set — payment endpoints will fail until it is.");
});
