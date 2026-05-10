// src/routes/credits.routes.ts
// ── FULL REPLACEMENT — adds Razorpay routes ───────────────────────────────────

import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/credits.controller";
import * as rzpCtrl from "../controllers/razorpay.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

export default async function creditRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // ── User-facing credit routes ─────────────────────────────────────────────
  app.get("/wallet", auth, ctrl.getWallet);

  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/history",
    auth,
    ctrl.getHistory,
  );

  app.get("/packs", auth, ctrl.getPacks);

  // Legacy direct topup (kept for backward compat — no verification)
  // NOTE: prefer /razorpay/verify for production use
  app.post<{ Body: { packId: string; paymentId: string } }>(
    "/topup",
    auth,
    ctrl.buyTopup,
  );

  // ── Razorpay payment routes ───────────────────────────────────────────────

  // Step 1: Create a Razorpay order
  // Frontend calls this first to get an orderId before opening the checkout modal
  app.post<{ Body: { packId: string } }>(
    "/razorpay/create-order",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["packId"],
          properties: {
            packId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    rzpCtrl.createOrder,
  );

  // Step 2: Verify payment after user completes checkout
  // This is the CRITICAL security endpoint — verifies HMAC-SHA256 signature
  app.post<{
    Body: {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
      packId: string;
    };
  }>(
    "/razorpay/verify",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: [
            "razorpay_order_id",
            "razorpay_payment_id",
            "razorpay_signature",
            "packId",
          ],
          properties: {
            razorpay_order_id: { type: "string" },
            razorpay_payment_id: { type: "string" },
            razorpay_signature: { type: "string" },
            packId: { type: "string" },
          },
        },
      },
    },
    rzpCtrl.verifyPayment,
  );

  // Webhook — Razorpay calls this for payment.captured events
  // Register BEFORE body parsing is applied (needs raw body for signature verification)
  // In Razorpay Dashboard → Settings → Webhooks → add this URL
  // Add Content-Type: application/json
  app.post(
    "/razorpay/webhook",
    {
      // No auth middleware — Razorpay calls this from their servers
      // Security is handled by HMAC-SHA256 webhook signature verification
      config: { rawBody: true } as any,
    },
    rzpCtrl.handleWebhook,
  );

  // ── Admin routes ──────────────────────────────────────────────────────────
  app.post("/admin/reset", ctrl.adminReset);
  app.post("/admin/grant", ctrl.adminGrant);
  app.post("/admin/flush-cache", ctrl.adminFlushCache);
}
