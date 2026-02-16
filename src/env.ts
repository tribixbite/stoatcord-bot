/**
 * Manual .env loader for Bun running under glibc-runner (grun).
 * grun doesn't forward environment variables to child processes,
 * so we read .env from disk and inject into process.env ourselves.
 * This module must be imported before any code that reads process.env.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

// Use the project root (parent of src/) rather than process.cwd(),
// which may be wrong under glibc-runner (grun) on ARM64 Termux
const projectRoot = resolve(dirname(import.meta.dir));
const envPath = resolve(projectRoot, ".env");

if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf8");
  let loaded = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (single or double)
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    // Only set if not already defined (env vars take precedence over .env)
    if (process.env[key] === undefined) {
      process.env[key] = val;
      loaded++;
    }
  }

  console.log(`[env] Loaded ${loaded} variable(s) from .env`);
} else {
  console.warn("[env] No .env file found at", envPath);
}
