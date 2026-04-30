import "@fastify/jwt";
import { User } from "./user";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: User;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    isPro?: boolean;
  }

  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
}

export * from "./user";
