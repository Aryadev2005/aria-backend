import { FastifyInstance } from 'fastify';
import * as ctrl from '../controllers/studio.controller';
import { authenticateFirebase } from '../middleware/auth.middleware';

export default async function studioRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  app.post('/script/structure', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['idea'],
        properties: {
          idea: { type: 'string' },
          platform: { type: 'string' },
          niche: { type: 'string' },
          format: { type: 'string' },
          mood: { type: 'string' },
          collaboration: { type: 'string' },
          angle: { type: 'string' },
        },
      },
    },
  }, ctrl.getScriptStructure as any);

  app.post('/script/advise', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['sectionLabel', 'creatorContent'],
        properties: {
          sectionLabel: { type: 'string' },
          creatorContent: { type: 'string' },
          sectionType: { type: 'string' },
          idea: { type: 'string' },
          mood: { type: 'string' },
        },
      },
    },
  }, ctrl.adviseSection as any);

  app.post('/bgm/match', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['idea'],
        properties: {
          idea: { type: 'string' },
          mood: { type: 'string' },
          format: { type: 'string' },
          duration: { type: 'string' },
        },
      },
    },
  }, ctrl.matchBGM as any);

  app.post('/shots', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['idea'],
        properties: {
          idea: { type: 'string' },
          format: { type: 'string' },
          sections: { type: 'array' },
        },
      },
    },
  }, ctrl.getShotList as any);

  app.post('/editing/help', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['problem', 'tool'],
        properties: {
          problem: { type: 'string' },
          tool: { type: 'string' },
        },
      },
    },
  }, ctrl.getEditingHelp as any);

  app.post('/analyse/url', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['videoUrl'],
        properties: {
          videoUrl: { type: 'string' },
          mood: { type: 'string' },
        },
      },
    },
  }, ctrl.analyseVideoUrl as any);

  app.post('/analyse/upload', {
    preHandler: [authenticateFirebase],
  }, ctrl.analyseVideoUpload as any);

  // ── Session & History ──────────────────────────────────────────────────────
  app.post('/session/save', auth, ctrl.saveSession as any);

  app.get('/history', auth, ctrl.getScriptHistory as any);

  app.patch('/pin/:scriptId', auth, ctrl.togglePin as any);

  // ── Learning endpoint ──────────────────────────────────────────────────────
  app.post('/learn', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['generatedSections', 'editedSections', 'intentLabel'],
        properties: {
          generatedSections: { type: 'array' },
          editedSections: { type: 'array' },
          intentLabel: {
            type: 'string',
            enum: [
              'tightened_language',
              'changed_tone',
              'voice_was_off',
              'facts_were_wrong',
              'restructured',
              'other',
            ],
          },
          sessionId: { type: 'string' },
        },
      },
    },
  }, ctrl.learnFromEdit as any);
}

