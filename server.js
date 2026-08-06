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
const DB_FILE = process.env.DB_FILE || "quiktow.db";
const db = new Database(DB_FILE);
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
  return "QT" + Math.floor(100000 + Math.random() * 900000);
}

function rowToJob(row) {
  if (!row) return row;
  return {
    id: row.id,
    service: row.service,
    priceValue: row.price_value,
    status: row.status,
    customer: row.customer,
    driver: row.driver,
    pickup: row.pickup,
    stripePaymentIntent: row.stripe_payment_intent,
    createdAt: row.created_at,
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    stripeConfigured: Boolean(stripe),
    db: { filename: DB_FILE, driver: "better-sqlite3" },
  });
});

// List all jobs, most recent first.
app.get("/api/jobs", (req, res) => {
  const rows = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all();
  res.json(rows.map(rowToJob));
});

// Create a new job request (customer app).
app.post("/api/jobs", (req, res) => {
  const { service, priceValue, pickup, customer } = req.body;
  if (!service || typeof priceValue !== "number" || Number.isNaN(priceValue) || priceValue <= 0) {
    return res.status(400).json({ error: "service and positive numeric priceValue are required" });
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
    INSERT INTO_jobs (id, service, price_value, status, customer, driver, pickup, stripe_payment_intent, created_at)
    VALUES (@id, @service, @price_value, @status, @customer, @driver, @pickup, @stripe_payment_intent, @created_at)
  `).run(job);
  res.status(201).json(rowToJob(job));
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

  res.json(rowToJob(db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id)));
});

// Create a real Stripe PaymentIntent for a job (test mode until you swap keys).
app.post("/api/jobs/:id/pay", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe is not configured on this server" });
  const job = db.prepare("SELECT * FROM_jobs WHERE id = ?").get(req.params.id);
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
      const existing = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId);
      if (existing && existing.status !== "paid") {
        db.prepare("UPDATE jobs SET status = 'paid' WHERE id = ?").run(jobId);
      }
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`QuikTow API listening on port ${PORT}`);
  if (!stripe) console.warn("STRIPE_SECRET_KEY not set — payment endpoints will fail until it is.");
});
