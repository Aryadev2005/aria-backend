// src/routes/calendarEntry.routes.ts
import { FastifyInstance } from 'fastify';
import * as ctrl from '../controllers/calendarEntry.controller';
import { authenticateFirebase } from '../middleware/auth.middleware';

export default async function calendarEntryRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // POST /api/v1/calendar/entries
  app.post('/entries', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['title', 'scheduled_date'],
        properties: {
          title:             { type: 'string', maxLength: 300 },
          idea:              { type: 'string', maxLength: 500 },
          platform:          { type: 'string' },
          niche:             { type: 'string' },
          format:            { type: 'string' },
          scheduled_date:    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          scheduled_time:    { type: 'string' },
          status:            { type: 'string', enum: ['idea', 'script', 'ready', 'posted'] },
          studio_session_id: { type: 'string' },
          source:            { type: 'string' },
          hook:              { type: 'string' },
          caption:           { type: 'string' },
          hashtags:          { type: 'array', items: { type: 'string' } },
          aria_tip:          { type: 'string' },
          is_ai_suggested:   { type: 'boolean' },
        },
      },
    },
  }, ctrl.createEntry as any);

  // GET /api/v1/calendar/entries?month=YYYY-MM
  app.get('/entries', auth, ctrl.getEntries as any);

  // PATCH /api/v1/calendar/entries/:id
  app.patch('/entries/:id', {
    ...auth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          status:         { type: 'string', enum: ['idea', 'script', 'ready', 'posted'] },
          scheduled_date: { type: 'string' },
          scheduled_time: { type: 'string' },
          caption:        { type: 'string' },
          posted_at:      { type: 'string' },
          ai_accepted:    { type: 'boolean' },
        },
      },
    },
  }, ctrl.updateEntry as any);

  // DELETE /api/v1/calendar/entries/:id
  app.delete('/entries/:id', {
    ...auth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, ctrl.deleteEntry as any);
}
