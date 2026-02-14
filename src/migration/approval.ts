/**
 * Live approval system for migration requests.
 * When a Discord admin runs /migrate with a stoat_server_id but no claim code,
 * the bot posts an approval request to the Stoat server. A Stoat admin must
 * reply "approve" to that message within 5 minutes.
 *
 * This module manages in-memory pending approval promises that bridge the
 * Stoat WebSocket message handler and the Discord interaction flow.
 */

interface PendingApproval {
  resolve: (approvedByUserId: string) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  requestId: string;
}

/** Map: stoatMessageId → PendingApproval */
const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Wait for a Stoat admin to approve a migration request by replying to
 * the bot's message. Returns the approving user's Stoat ID on success.
 * Rejects on timeout or explicit denial.
 */
export function waitForApproval(
  stoatMessageId: string,
  requestId: string,
  timeoutMs: number = 300_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingApprovals.delete(stoatMessageId);
      reject(new Error("Approval timed out — no response within 5 minutes"));
    }, timeoutMs);

    pendingApprovals.set(stoatMessageId, {
      resolve,
      reject,
      timeoutId,
      requestId,
    });
  });
}

/**
 * Resolve a pending approval (called from Stoat message handler when
 * an admin replies "approve" to the bot's request message).
 * Returns true if a matching pending approval was found.
 */
export function resolveApproval(
  stoatMessageId: string,
  approvedByUserId: string
): boolean {
  const pending = pendingApprovals.get(stoatMessageId);
  if (!pending) return false;
  clearTimeout(pending.timeoutId);
  pendingApprovals.delete(stoatMessageId);
  pending.resolve(approvedByUserId);
  return true;
}

/**
 * Reject a pending approval (called when a Stoat admin replies "deny"/"reject",
 * or when the request needs to be cancelled).
 * Returns true if a matching pending approval was found.
 */
export function rejectApproval(
  stoatMessageId: string,
  reason: string
): boolean {
  const pending = pendingApprovals.get(stoatMessageId);
  if (!pending) return false;
  clearTimeout(pending.timeoutId);
  pendingApprovals.delete(stoatMessageId);
  pending.reject(new Error(reason));
  return true;
}

/** Check if a specific message ID has a pending approval */
export function hasPendingApproval(stoatMessageId: string): boolean {
  return pendingApprovals.has(stoatMessageId);
}

/** Cancel all pending approvals (used during shutdown) */
export function cancelAllPending(): void {
  for (const [id, pending] of pendingApprovals) {
    clearTimeout(pending.timeoutId);
    pending.reject(new Error("Bot shutting down"));
    pendingApprovals.delete(id);
  }
}
