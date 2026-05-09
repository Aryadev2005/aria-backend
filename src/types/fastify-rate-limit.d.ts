declare module "@fastify/rate-limit" {
  import { FastifyPluginAsync } from "fastify";

  export interface RateLimitOptions {
    global?: boolean;
    max?: number | ((req: any) => number | Promise<number>);
    timeWindow?: number;
    hook?: "onRequest" | "onPreParsing" | "onPreValidation" | "onPreHandler";
    cache?: number;
    store?: any;
    redis?: any;
    skipOnError?: boolean;
    keyGenerator?: (req: any) => string | Promise<string>;
    errorResponseBuilder?: (req: any, context: { max: number; ttl: number }) => any;
    onExceeded?: (req: any, key: string) => void | Promise<void>;
    onBanReach?: (req: any, key: string) => void | Promise<void>;
    ban?: number;
  }

  declare const rateLimit: FastifyPluginAsync<RateLimitOptions>;
  export default rateLimit;
}
