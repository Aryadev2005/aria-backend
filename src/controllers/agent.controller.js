// src/controllers/agent.controller.js
'use strict';

const brain           = require('../services/ariaBrain.service');
const { success, errors } = require('../utils/response');
const { logger }      = require('../utils/logger');

// POST /api/v1/agent/message
const sendMessage = async (req, reply) => {
  const user = req.user;
  const { message, sessionId, history = [] } = req.body;

  if (!message?.trim()) return errors.notFound(reply, 'Message');

  try {
    const result = await brain.think({
      userId:    user.id,
      user,
      message:   message.trim(),
      sessionId,
      history,
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Agent message failed');
    return errors.serviceDown(reply, 'ARIA');
  }
};

// GET /api/v1/agent/memory
const getMemory = async (req, reply) => {
  try {
    const memory = await brain.getMemory(req.user.id);
    return success(reply, { memory, count: Object.keys(memory).length });
  } catch (err) {
    return errors.internal(reply);
  }
};

// DELETE /api/v1/agent/memory/:key
const deleteMemory = async (req, reply) => {
  const { key } = req.params;
  try {
    const sql = require('../config/database').getDB();
    await sql`DELETE FROM agent_memory WHERE user_id = ${req.user.id} AND key = ${key}`;
    return success(reply, { deleted: true });
  } catch (err) {
    return errors.internal(reply);
  }
};

module.exports = { sendMessage, getMemory, deleteMemory };
