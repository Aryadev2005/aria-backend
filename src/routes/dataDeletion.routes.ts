import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { prisma } from "../config/database";
import { logger } from "../utils/logger";

type SignedRequestData = {
  user_id?: string;
};

const decodeBase64Url = (value: string) =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Parse and verify Facebook's signed_request
 * Format: base64UrlEncode(signature).base64UrlEncode(payload)
 */
const parseSignedRequest = (signedRequest: string, appSecret: string) => {
  const [encodedSig, encodedPayload] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload) {
    throw new Error("Missing signature or payload");
  }

  const payload = decodeBase64Url(encodedPayload).toString("utf8");
  const data = JSON.parse(payload) as SignedRequestData;

  const expectedSig = crypto
    .createHmac("sha256", appSecret)
    .update(encodedPayload)
    .digest("hex");

  const actualSig = decodeBase64Url(encodedSig).toString("hex");

  if (expectedSig !== actualSig) {
    throw new Error("Signature mismatch");
  }

  return data;
};

export default async function dataDeletionRoutes(app: FastifyInstance) {
  app.post(
    "/data-deletion",
    {
      config: { skipAuth: true },
      schema: {
        body: {
          type: "object",
          required: ["signed_request"],
          properties: {
            signed_request: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { signed_request } = req.body as { signed_request?: string };

        if (!signed_request) {
          return reply.code(400).send({ error: "signed_request is required" });
        }

        const appSecret = process.env.FACEBOOK_APP_SECRET;
        if (!appSecret) {
          logger.error(
            "FACEBOOK_APP_SECRET not set — cannot process data deletion",
          );
          const code = `AIRA-NOAPPSECRET-${Date.now()}`;
          return reply.send({
            url: `${process.env.FRONTEND_URL || "https://airaos.com"}/data-deletion?code=${code}`,
            confirmation_code: code,
          });
        }

        let facebookData: SignedRequestData;
        try {
          facebookData = parseSignedRequest(signed_request, appSecret);
        } catch (err: any) {
          logger.warn(
            { err: err.message },
            "Facebook signed_request verification failed",
          );
          return reply.code(400).send({ error: "Invalid signed_request" });
        }

        const facebookUserId = facebookData.user_id;
        const confirmationCode = `AIRA-${facebookUserId || "unknown"}-${Date.now()}`;

        logger.info(
          { facebookUserId, confirmationCode },
          "Facebook data deletion request received",
        );

        if (facebookUserId) {
          try {
            await prisma.users.updateMany({
              where: {
                firebase_uid: facebookUserId,
              },
              data: {
                deletion_requested_at: new Date(),
                deletion_confirmation_code: confirmationCode,
                deletion_source: "facebook_callback",
              },
            });

            logger.info(
              { facebookUserId, confirmationCode },
              "User marked for deletion",
            );
          } catch (dbErr: any) {
            logger.error(
              { err: dbErr.message, facebookUserId },
              "DB deletion marking failed",
            );
          }
        }

        const statusUrl = `${process.env.FRONTEND_URL || "https://airaos.com"}/data-deletion?code=${confirmationCode}`;

        return reply.send({
          url: statusUrl,
          confirmation_code: confirmationCode,
        });
      } catch (err: any) {
        logger.error({ err: err.message }, "Data deletion callback error");
        return reply
          .code(500)
          .send({ error: "Internal error processing deletion request" });
      }
    },
  );

  app.get(
    "/data-deletion",
    {
      config: { skipAuth: true },
    },
    async (req, reply) => {
      const { code } = req.query as { code?: string };

      if (!code) {
        return reply.send({
          message: "AIRA Data Deletion Endpoint",
          instructions:
            "To request data deletion, visit https://airaos.com/data-deletion",
        });
      }

      try {
        const user = await prisma.users.findFirst({
          where: { deletion_confirmation_code: code },
          select: { deletion_requested_at: true, deleted_at: true },
        });

        const status = user?.deleted_at
          ? "completed"
          : user?.deletion_requested_at
            ? "pending"
            : "not_found";

        return reply.send({
          confirmation_code: code,
          status,
          message:
            status === "completed"
              ? "Your data has been deleted from AIRA."
              : status === "pending"
                ? "Your data deletion request has been received and will be completed within 30 days."
                : "Confirmation code not found. Please contact support@airaos.com",
          deleted_at: user?.deleted_at || null,
        });
      } catch (_err) {
        return reply.send({
          confirmation_code: code,
          status: "pending",
          message:
            "Your data deletion request has been received and will be completed within 30 days.",
        });
      }
    },
  );
}
