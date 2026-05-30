import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "../utils/logger";

let firebaseApp: ReturnType<typeof initializeApp> | null = null;

// Synchronous — admin.initializeApp() does NOT make network calls.
// Network calls happen lazily on first auth/messaging use.
export const initFirebase = () => {
  if (firebaseApp) return firebaseApp;
  if (getApps().length > 0) {
    firebaseApp = getApps()[0];
    return firebaseApp;
  }
  try {
    firebaseApp = initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    logger.info(
      { projectId: process.env.FIREBASE_PROJECT_ID },
      "Firebase Admin initialized",
    );
    return firebaseApp;
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Firebase init failed — auth middleware will handle retries",
    );
    return null;
  }
};

export const verifyFirebaseToken = async (idToken: string) => {
  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name || decoded.email?.split("@")[0],
      picture: decoded.picture,
    };
  } catch (err: any) {
    // Log the actual error for debugging
    logger.error({
      err: err.message,
      code: err.code,
      tokenLength: idToken.length,
      tokenPrefix: idToken.slice(0, 50),
    }, 'Firebase token verification failed');
    throw new Error("Invalid Firebase token");
  }
};

export const sendPushNotification = async ({
  token,
  title,
  body,
  data = {},
}: {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}) => {
  try {
    return await getMessaging()
      .send({
        token,
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)]),
        ),
        android: { priority: "high" },
        apns: { payload: { aps: { sound: "default", badge: 1 } } },
      });
  } catch (err) {
    logger.error({ err }, "Push notification failed");
  }
};
