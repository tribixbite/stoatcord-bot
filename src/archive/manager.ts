/**
 * Shared archive job manager — provides a central registry for active
 * archive jobs and their AbortControllers. Used by both the Discord
 * slash command handler and the HTTP API to start, pause, and resume jobs.
 */

const activeJobs = new Map<string, AbortController>();

/** Register a new job and return its AbortSignal */
export function registerJob(jobId: string): AbortSignal {
  const controller = new AbortController();
  activeJobs.set(jobId, controller);
  return controller.signal;
}

/** Abort a running job. Returns true if the job was found and aborted. */
export function abortJob(jobId: string): boolean {
  const controller = activeJobs.get(jobId);
  if (controller) {
    controller.abort();
    activeJobs.delete(jobId);
    return true;
  }
  return false;
}

/** Remove a job from the registry (after completion or failure) */
export function unregisterJob(jobId: string): void {
  activeJobs.delete(jobId);
}

/** Check if a job is actively running */
export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}
