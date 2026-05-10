// src/routes/credits.routes.ts

import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/credits.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

export default async function creditRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // User-facing
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

  // Admin — add your own admin auth middleware in production
  app.post("/admin/reset", ctrl.adminReset);
  app.post("/admin/grant", ctrl.adminGrant);
  app.post("/admin/flush-cache", ctrl.adminFlushCache);
}
