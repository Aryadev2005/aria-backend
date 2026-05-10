// src/routes/credits.routes.ts
import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/credits.controller";
import * as rzpCtrl from "../controllers/razorpay.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

export default async function creditRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // ── Credit wallet routes ──────────────────────────────────────────────────
  app.get("/wallet", auth, ctrl.getWallet);
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/history",
    auth,
    ctrl.getHistory,
  );
  app.get("/packs", auth, ctrl.getPacks);
  app.post<{ Body: { packId: string; paymentId: string } }>(
    "/topup",
    auth,
    ctrl.buyTopup,
  );

  // ── Razorpay: create order ────────────────────────────────────────────────
  // Accepts { planId } for plan purchase OR { packId } for top-up
  app.post<{ Body: { planId?: string; packId?: string } }>(
    "/razorpay/create-order",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          anyOf: [
            {
              required: ["planId"],
              properties: { planId: { type: "string", minLength: 1 } },
            },
            {
              required: ["packId"],
              properties: { packId: { type: "string", minLength: 1 } },
            },
          ],
        },
      },
    },
    rzpCtrl.createOrder,
  );

  // ── Razorpay: verify payment ──────────────────────────────────────────────
  app.post<{
    Body: {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
      itemId: string;
      paymentType: "plan" | "topup";
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
            "itemId",
            "paymentType",
          ],
          properties: {
            razorpay_order_id: { type: "string" },
            razorpay_payment_id: { type: "string" },
            razorpay_signature: { type: "string" },
            itemId: { type: "string" },
            paymentType: { type: "string", enum: ["plan", "topup"] },
          },
        },
      },
    },
    rzpCtrl.verifyPayment,
  );

  // ── Razorpay: webhook (no auth — secured by HMAC signature check) ─────────
  app.post(
    "/razorpay/webhook",
    { config: { rawBody: true } as any },
    rzpCtrl.handleWebhook,
  );

  // ── Admin routes ──────────────────────────────────────────────────────────
  app.post("/admin/reset", ctrl.adminReset);
  app.post("/admin/grant", ctrl.adminGrant);
  app.post("/admin/flush-cache", ctrl.adminFlushCache);
}
