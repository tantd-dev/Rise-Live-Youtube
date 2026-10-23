import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import {
  getFirestore,
  initializeFirestore,
} from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const app =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });

let firestore;

try {
  firestore = initializeFirestore(app, {
    ignoreUndefinedProperties: true,
  });
} catch (error) {
  // Nếu Firestore đã được khởi tạo trước đó (ví dụ Next.js dev reload),
  // tái sử dụng instance hiện có.
  firestore = getFirestore(app);
}

export { firestore };