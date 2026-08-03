'use strict';

// Config-driven registry of the Firebase/Google projects users can sign in
// through. All app data still lives in ONE primary Firestore database
// (FIREBASE_PROJECT_ID); each project here only represents a distinct Google
// Sign-In (OAuth) client. The user's chosen project is saved as `projectId`
// on their profile so we can tell which project an account belongs to.
//
// To add another project in the future, just add its id to AUTH_PROJECTS and
// set its OAuth client env vars — no code changes required.

const DEFAULT_PROJECT_ID = 'ytautomation-2fae5';

// Turn a projectId into a valid env-var suffix, e.g.
// "ytautomation-a90e5" -> "YTAUTOMATION_A90E5"
const envKey = (projectId) => String(projectId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');

const getProjectIds = () => {
  const raw = (process.env.AUTH_PROJECTS || '').trim();
  const ids = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  if (!ids.length) {
    // Backward compatible: fall back to the single existing project.
    ids.push((process.env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID).trim());
  }

  // De-dupe while preserving order.
  return [...new Set(ids)];
};

const getDefaultProjectId = () => {
  const explicit = (process.env.AUTH_DEFAULT_PROJECT || '').trim();
  if (explicit && getProjectIds().includes(explicit)) return explicit;
  return getProjectIds()[0];
};

const buildProject = (projectId) => {
  const key = envKey(projectId);
  const isDefault = projectId === getDefaultProjectId();

  // Per-project OAuth client, with fallback to the legacy global client for
  // the default project so existing single-project setups keep working.
  const clientId =
    (process.env[`OAUTH_CLIENT_ID_${key}`] || '').trim() ||
    (isDefault ? (process.env.GOOGLE_CLIENT_ID || '').trim() : '');
  const clientSecret =
    (process.env[`OAUTH_CLIENT_SECRET_${key}`] || '').trim() ||
    (isDefault ? (process.env.GOOGLE_CLIENT_SECRET || '').trim() : '');
  const label = (process.env[`PROJECT_LABEL_${key}`] || '').trim() || projectId;

  return {
    id: projectId,
    label,
    clientId,
    clientSecret,
    isDefault,
    // A project can drive Google Sign-In only if its OAuth client is configured.
    configured: Boolean(clientId && clientSecret),
  };
};

const getProjects = () => getProjectIds().map(buildProject);

const isValidProjectId = (projectId) => Boolean(projectId) && getProjectIds().includes(projectId);

const getProject = (projectId) => {
  if (!isValidProjectId(projectId)) return null;
  return buildProject(projectId);
};

// Always returns a usable project. Falls back to the default project when the
// requested id is missing or unknown.
const resolveProject = (projectId) => getProject(projectId) || buildProject(getDefaultProjectId());

// Public shape for the frontend selector (never expose the client secret).
const getPublicProjects = () =>
  getProjects().map(({ id, label, isDefault, configured }) => ({ id, label, isDefault, configured }));

module.exports = {
  DEFAULT_PROJECT_ID,
  getProjectIds,
  getDefaultProjectId,
  getProjects,
  getProject,
  isValidProjectId,
  resolveProject,
  getPublicProjects,
};
