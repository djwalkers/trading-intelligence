import packageJson from "../../package.json";

// Build 1.13.0 — single source of truth for the app's build/version string. `package.json`'s
// `version` field is the one place this is actually written; every UI location (Footer, Sidebar),
// the health endpoint, and any future log line should import this constant rather than repeating
// the literal string, which is exactly how two of them (Footer, Sidebar) drifted to a stale
// "Build 1.12.0" while the rest of the app had already moved on to 1.12.2.
export const APP_VERSION: string = packageJson.version;
