/** Portable utility functions (Node.js compatible) */

/** Promise-based sleep, replacing Bun.sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
