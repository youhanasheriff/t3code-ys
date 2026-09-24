/**
 * Firebase Web app configuration for the desktop-only login + analytics feature.
 *
 * These values are NOT secret — the Firebase Web config is designed to be shipped
 * publicly in client apps. Access is secured by Firebase Authentication + Firestore
 * Security Rules (see firestore.rules), not by hiding this config. It is therefore
 * safe to commit and bundle into the distributed desktop app.
 *
 * Project: t3code-ys
 */
export const firebaseConfig = {
  apiKey: "AIzaSyCIuT9_RHeMIogcrlyzxrCe_1TCY-HuaC8",
  authDomain: "t3code-ys.firebaseapp.com",
  projectId: "t3code-ys",
  storageBucket: "t3code-ys.firebasestorage.app",
  messagingSenderId: "310873407434",
  appId: "1:310873407434:web:22639263b0ec6168d15933",
} as const;
