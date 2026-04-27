'use strict'

const { getDB } = require('../config/database')
const { success, errors } = require('../utils/response')
const { logger } = require('../utils/logger')

/**
 * POST /api/v1/trends/feedback
 * Submit feedback on ARIA recommendations
 * Helps ARIA learn what works and what doesn't
 */
const submitFeedback = async (req, reply) => {
  const user = req.user
  const { recommendationType, recommendationData, wasHelpful, resultNotes } = req.body

  try {
    if (!recommendationType) {
      return errors.validation(reply, 'recommendationType is required')
    }

    const sql = getDB()

    // Insert feedback into aria_feedback table
    await sql`
      INSERT INTO aria_feedback (
        user_id, recommendation_type, recommendation_data,
        was_helpful, result_notes, created_at
      ) VALUES (
        ${user.id},
        ${recommendationType},
        ${JSON.stringify(recommendationData || {})},
        ${wasHelpful === true},
        ${resultNotes || null},
        NOW()
      )
    `

    logger.info(
      { userId: user.id, recommendationType, wasHelpful },
      'Feedback recorded'
    )

    return success(reply, {
      message: 'Feedback received. ARIA is learning from you!',
      feedbackId: user.id,
    })
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Submit feedback failed')
    return errors.internal(reply)
  }
}

/**
 * Get recent feedback for a user
 * Used internally to inject user's past feedback into ARIA prompts
 * Helps ARIA personalize recommendations based on what worked
 *
 * Returns array of last 5 feedback entries
 */
const getRecentFeedbackForUser = async (userId) => {
  try {
    const sql = getDB()

    const feedback = await sql`
      SELECT
        recommendation_type,
        was_helpful,
        result_notes,
        created_at
      FROM aria_feedback
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 5
    `

    return feedback.map(f => ({
      type: f.recommendation_type,
      helpful: f.was_helpful,
      notes: f.result_notes,
      date: f.created_at,
    }))
  } catch (err) {
    logger.error({ err, userId }, 'Get recent feedback failed')
    return []
  }
}

module.exports = { submitFeedback, getRecentFeedbackForUser }
