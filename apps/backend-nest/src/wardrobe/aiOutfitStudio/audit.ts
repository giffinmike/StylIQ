// Containment audit logger.
//
// Emits a single structured log line per Studio-routed call when the env flag
// STUDIO_CONTAINMENT_AUDIT=1 is set. Used during the containment verification
// window to prove that:
//   1. Every AI Outfit Studio request goes through this namespace.
//   2. No non-Studio request ever produces one of these log lines.
// Removed in a follow-up PR after sign-off.

const ENABLED = process.env.STUDIO_CONTAINMENT_AUDIT === '1';

export interface StudioAuditContext {
  sharedTarget?: string;
  sourceFeature?: string;
  requestId?: string;
}

export function studioAuditLog(
  adapter: string,
  ctx: StudioAuditContext = {},
): void {
  if (!ENABLED) return;
  const parts: string[] = [`adapter=${adapter}`];
  if (ctx.sharedTarget !== undefined) {
    parts.push(`shared_target=${ctx.sharedTarget}`);
  }
  if (ctx.sourceFeature !== undefined) {
    parts.push(`source_feature=${ctx.sourceFeature}`);
  }
  if (ctx.requestId !== undefined) {
    parts.push(`requestId=${ctx.requestId}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[STUDIO_CONTAINMENT_AUDIT] ${parts.join(' ')}`);
}
