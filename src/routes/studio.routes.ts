import { FastifyInstance } from 'fastify'
import * as ctrl from '../controllers/studio.controller'
import { authenticateFirebase } from '../middleware/auth.middleware'

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
          angle: { type: 'string' }
        }
      }
    }
  }, ctrl.getScriptStructure);

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
          mood: { type: 'string' }
        }
      }
    }
  }, ctrl.adviseSection);

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
          duration: { type: 'string' }
        }
      }
    }
  }, ctrl.matchBGM);

  app.post('/shots', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['idea'],
        properties: {
          idea: { type: 'string' },
          format: { type: 'string' },
          sections: { type: 'array' }
        }
      }
    }
  }, ctrl.getShotList);

  app.post('/editing/help', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['problem', 'tool'],
        properties: {
          problem: { type: 'string' },
          tool: { type: 'string' }
        }
      }
    }
  }, ctrl.getEditingHelp);

  app.post('/analyse/url', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['videoUrl'],
        properties: {
          videoUrl: { type: 'string' },
          mood: { type: 'string' }
        }
      }
    }
  }, ctrl.analyseVideoUrl);

  app.post('/analyse/upload', {
    preHandler: [authenticateFirebase]
  }, ctrl.analyseVideoUpload);

  app.post('/session/save', { ...auth }, ctrl.saveSession);
}
