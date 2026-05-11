import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import sensible from "@fastify/sensible";
import { getRedisClient } from "./config/redis";

// Route Imports
import authRoutes from "./routes/auth.routes";
import userRoutes from "./routes/user.routes";
import trendRoutes from "./routes/trend.routes";
import songRoutes from "./routes/song.routes";
import contentRoutes from "./routes/content.routes";
import analyticsRoutes from "./routes/analytics.routes";
import calendarRoutes from "./routes/calendar.routes";
import calendarEntryRoutes from "./routes/calendarEntry.routes";
import radarRoutes from "./routes/radar.routes";
import onboardingRoutes from "./routes/onboarding.routes";
import agentRoutes from "./routes/agent.routes";
import studioRoutes from "./routes/studio.routes";
import launchRoutes from "./routes/launch.routes";
import profileRoutes from "./routes/profile.routes";
import webhookRoutes from "./routes/webhook.routes";
// import brainRoutes from "./routes/brain.routes";
import videoDnaRoutes from "./routes/video_dna.routes";
import dataDeletionRoutes from "./routes/dataDeletion.routes";
import integrationRoutes from "./routes/integrations.routes";
import creditRoutes from "./routes/credits.routes";
import notesRoutes from "./routes/notes.routes";
import deepAnalysisRoutes from "./routes/deepAnalysis.routes";

export const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      transport:
        process.env.NODE_ENV !== "production"
          ? {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "SYS:HH:MM:ss",
                ignore: "pid,hostname",
              },
            }
          : undefined,
    },
    genReqId: (req) => {
      return (
        (req.headers["x-request-id"] as string) ||
        `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      );
    },
    trustProxy: true,
    ajv: {
      customOptions: {
        removeAdditional: true,
        useDefaults: true,
        coerceTypes: true,
        allErrors: false,
      },
    },
  });

  // ── Plugins ────────────────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // Dev tunnel origins are always allowed — devtunnels.ms is VS Code's tunnel
  // service and is used in staging/QA even when NODE_ENV=production
  const devWildcardOrigins = [
    "*.ngrok-free.app",
    "*.ngrok-free.dev",
    "*.ngrok.io",
    "*.devtunnels.ms", // VS Code dev tunnels (all regions)
    "*.inc1.devtunnels.ms", // India Central region
    "*.asse.devtunnels.ms", // Asia SE region
    "*.euw.devtunnels.ms", // Europe West
    "*.use.devtunnels.ms", // US East
  ];

  const allowedOrigins = (process.env.ALLOWED_ORIGINS?.split(",") || [])
    .map((origin) => origin.trim())
    .filter(Boolean)
    .concat([
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:5173",
      "http://localhost:3000",
      ...devWildcardOrigins,
    ]);
  const allowAllOrigins = allowedOrigins.includes("*");

  const isOriginAllowed = (origin: string): boolean => {
    if (allowAllOrigins) return true;
    if (allowedOrigins.includes(origin)) return true;

    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return false;
    }

    return allowedOrigins.some((pattern) => {
      if (!pattern.includes("*")) return false;
      const normalized = pattern.replace(/^https?:\/\//, "");
      if (normalized.startsWith("*.")) {
        const suffix = normalized.slice(1);
        return hostname.endsWith(suffix);
      }
      return false;
    });
  };

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (process.env.NODE_ENV !== "production") return cb(null, true);
      if (isOriginAllowed(origin)) {
        return cb(null, true);
      }
      return cb(new Error("CORS origin blocked"), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "content-type",
      "Authorization",
      "authorization",
      "X-Request-ID",
      "x-request-id",
      "X-Requested-With",
      "x-requested-with",
      "ngrok-skip-browser-warning",
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    credentials: true,
  });

  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip", "deflate"],
  });

  await app.register(rateLimit, {
    global: true,
    max: parseInt(process.env.RATE_LIMIT_MAX || "100", 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || "60000", 10),
    redis: getRedisClient(),
    keyGenerator: (req) => (req.headers["x-forwarded-for"] as string) || req.ip,
    errorResponseBuilder: (req, context) => ({
      success: false,
      error: "RATE_LIMIT_EXCEEDED",
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET as string,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN || "7d", algorithm: "HS256" },
    verify: { algorithms: ["HS256"] },
  });

  await app.register(sensible);

  // ── Verbose logging ───────────────────────────────────────────────────────
  app.addHook("onRequest", async (req, reply) => {
    req.log.info(
      {
        reqId: req.id,
        method: req.method,
        url: req.url,
        ip: req.ip,
      },
      "request started",
    );
  });

  app.addHook("onResponse", async (req, reply) => {
    const responseTime =
      typeof (reply as any).getResponseTime === "function"
        ? (reply as any).getResponseTime()
        : (reply as any).elapsedTime;

    req.log.info(
      {
        reqId: req.id,
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        responseTime,
      },
      "request completed",
    );
  });

  app.addHook("onError", async (req, reply, err) => {
    req.log.error(
      {
        reqId: req.id,
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        err,
      },
      "request error",
    );
  });

  // ── Health check ───────────────────────────────────────────────────────────
  app.get("/health", async () => {
    return {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || "1.0.0",
    };
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  const API_PREFIX = `/api/${process.env.API_VERSION || "v1"}`;

  await app.register(webhookRoutes, { prefix: `${API_PREFIX}/webhooks` });
  await app.register(authRoutes, { prefix: `${API_PREFIX}/auth` });
  await app.register(userRoutes, { prefix: `${API_PREFIX}/users` });
  await app.register(trendRoutes, { prefix: `${API_PREFIX}/trends` });
  await app.register(songRoutes, { prefix: `${API_PREFIX}/songs` });
  await app.register(contentRoutes, { prefix: `${API_PREFIX}/content` });
  await app.register(analyticsRoutes, { prefix: `${API_PREFIX}/analytics` });
  await app.register(calendarRoutes, { prefix: `${API_PREFIX}/calendar` });
  await app.register(calendarEntryRoutes, { prefix: `${API_PREFIX}/calendar` });
  await app.register(radarRoutes, { prefix: `${API_PREFIX}/discover` });
  await app.register(onboardingRoutes, { prefix: `${API_PREFIX}/onboarding` });
  await app.register(agentRoutes, { prefix: `${API_PREFIX}/agent` });
  await app.register(studioRoutes, { prefix: `${API_PREFIX}/studio` });
  await app.register(launchRoutes, { prefix: `${API_PREFIX}/launch` });
  await app.register(profileRoutes, { prefix: `${API_PREFIX}/profile` });
  // await app.register(brainRoutes, { prefix: `${API_PREFIX}/brain` });
  await app.register(videoDnaRoutes, { prefix: `${API_PREFIX}/video-dna` });
  await app.register(integrationRoutes, {
    prefix: `${API_PREFIX}/integrations`,
  });
  await app.register(creditRoutes, { prefix: `${API_PREFIX}/credits` });
  await app.register(notesRoutes, { prefix: `${API_PREFIX}/notes` });
  await app.register(dataDeletionRoutes, {
    prefix: `${API_PREFIX}/data-deletion`,
  });
  // await app.register(deepAnalysisRoutes, {
  //   prefix: `${API_PREFIX}/deep-analysis`,
  // });

  // ── Lifecycle / error handlers ─────────────────────────────────────────────
  app.setNotFoundHandler((req, reply) => {
    // Log details about 404 for debugging
    app.log.warn(
      {
        method: req.method,
        url: req.url,
        headers: req.headers,
      },
      "404 Not Found",
    );

    reply.code(404).send({
      success: false,
      error: "NOT_FOUND",
      message: `Route ${req.method} ${req.url} not found`,
    });
  });

  app.setErrorHandler((error: any, request, reply) => {
    app.log.error(error);
    reply.status(error.statusCode || 500).send({
      success: false,
      error: error.statusCode === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR",
      message: error.message || "Internal server error",
      timestamp: new Date().toISOString(),
    });
  });

  return app;
};
