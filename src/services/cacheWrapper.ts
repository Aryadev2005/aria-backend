import { cache } from '../config/redis';

export async function getCache<T>(key: string): Promise<T | null> {
  try {
    return await cache.get(key) as T;
  } catch {
    return null;
  }
}

export async function setCache(key: string, value: any, ttlSeconds = 300): Promise<void> {
  try {
    await cache.set(key, value, ttlSeconds);
  } catch {
    // Redis unavailable — continue without cache
  }
}

export async function deleteCache(key: string): Promise<void> {
  try {
    await cache.del(key);
  } catch {}
}
