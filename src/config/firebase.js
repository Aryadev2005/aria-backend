'use strict'

const admin = require('firebase-admin')
const { logger } = require('../utils/logger')

let firebaseApp = null

// Synchronous — admin.initializeApp() does NOT make network calls.
// Network calls happen lazily on first auth/messaging use.
const initFirebase = () => {
  if (firebaseApp) return firebaseApp
  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    })
    logger.info({ projectId: process.env.FIREBASE_PROJECT_ID }, 'Firebase Admin initialized')
    return firebaseApp
  } catch (err) {
    logger.warn({ err: err.message }, 'Firebase init failed — auth middleware will handle retries')
    return null
  }
}

const verifyFirebaseToken = async (idToken) => {
  try {
    const decoded = await admin.auth().verifyIdToken(idToken)
    return {
      uid:     decoded.uid,
      email:   decoded.email,
      name:    decoded.name || decoded.email?.split('@')[0],
      picture: decoded.picture,
    }
  } catch {
    throw new Error('Invalid Firebase token')
  }
}

const sendPushNotification = async ({ token, title, body, data = {} }) => {
  try {
    return await admin.messaging().send({
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    })
  } catch (err) {
    logger.error({ err }, 'Push notification failed')
  }
}

module.exports = { initFirebase, verifyFirebaseToken, sendPushNotification }
