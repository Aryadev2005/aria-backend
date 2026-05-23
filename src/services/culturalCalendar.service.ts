// src/services/culturalCalendar.service.ts
import { INDIAN_CULTURAL_EVENTS, CulturalEvent } from '../data/indian_cultural_calendar';

const WINDOW_DAYS = 30; // look-ahead window for "upcoming"
const PRE_DAYS    = 7;  // consider an event "active" up to 7 days before

function dayOfYear(month: number, day: number): number {
  return month * 31 + day; // approximate ordinal for proximity math
}

function eventProximityDays(event: CulturalEvent, now: Date): number {
  const eventDate = new Date(now.getFullYear(), event.month - 1, event.day);
  // If event already passed this year, use next year
  if (eventDate < now) eventDate.setFullYear(now.getFullYear() + 1);
  return Math.floor((eventDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Returns events happening within the next WINDOW_DAYS days, sorted by proximity.
 */
export const getUpcomingEvents = (windowDays = WINDOW_DAYS): CulturalEvent[] => {
  const now = new Date();
  return INDIAN_CULTURAL_EVENTS
    .map((e) => ({ event: e, days: eventProximityDays(e, now) }))
    .filter(({ days }) => days >= -PRE_DAYS && days <= windowDays)
    .sort((a, b) => a.days - b.days)
    .map(({ event }) => event);
};

/**
 * Returns the single most imminent upcoming event.
 */
export const getPrimaryUpcomingEvent = (): (CulturalEvent & { daysAway: number }) | null => {
  const now = new Date();
  const sorted = INDIAN_CULTURAL_EVENTS
    .map((e) => ({ event: e, days: eventProximityDays(e, now) }))
    .filter(({ days }) => days >= 0 && days <= WINDOW_DAYS)
    .sort((a, b) => a.days - b.days);

  if (!sorted.length) return null;
  return { ...sorted[0].event, daysAway: sorted[0].days };
};

/**
 * Returns content angles for a given event ID.
 */
export const getEventContentAngles = (eventId: string): string[] => {
  const event = INDIAN_CULTURAL_EVENTS.find((e) => e.id === eventId);
  return event?.contentAngles ?? [];
};

/**
 * Builds a compact prompt block for injection into ARIA system prompt.
 * Injected near the top so ARIA proactively suggests event-relevant content.
 */
export const buildCulturalCalendarBlock = (): string => {
  const upcoming = getUpcomingEvents(14); // only very near events for prompt context
  if (!upcoming.length) return '';

  const lines = upcoming.slice(0, 3).map((e) => {
    const now = new Date();
    const days = eventProximityDays(e, now);
    const timeLabel = days === 0 ? 'TODAY' : days <= 3 ? `${days}d away` : `~${days}d`;
    return `• ${e.name} (${timeLabel}) — top angles: ${e.contentAngles.slice(0, 2).join(' | ')}`;
  });

  return `\nUPCOMING INDIAN CULTURAL MOMENTS (next 14 days):
${lines.join('\n')}
Use these moments proactively when relevant. Suggest event-specific content ideas without being asked.\n`;
};
