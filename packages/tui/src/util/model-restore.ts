/**
 * Pure logic for restoring the per-agent + recent + favorite + variant
 * fields from a parsed model.json value. Extracted from local.tsx so it
 * can be unit-tested with a fixture file under a temp HOME — the only
 * reliable way to know whether the restore actually applied, since the
 * original in-context restore was hidden behind an empty catch.
 *
 * The function takes a "sink" interface so the caller can wire it to
 * either a SolidJS `setStore` or a test spy.
 */

export type PersistedAgents = Record<
  string,
  { providerID: string; modelID: string }
>

export type RestoredModelState = {
  recent?: Array<{ providerID: string; modelID: string }>
  favorite?: Array<{ providerID: string; modelID: string }>
  variant?: Record<string, string | undefined>
}

export type RestoreSink = {
  /** Whether the store is currently bound to a session. */
  isUnbound: () => boolean
  /** Return the live per-agent overrides currently in the store. */
  getCurrentModels: () => PersistedAgents
  /** Return the frozen home draft (used when bound, --continue path). */
  getHomeAgents: () => PersistedAgents
  /** Apply a per-agent override to the live store. */
  setModel: (agent: string, model: { providerID: string; modelID: string }) => void
  /** Apply recent / favorite / variant to the store. */
  setRecent: (recent: Array<{ providerID: string; modelID: string }>) => void
  setFavorite: (favorite: Array<{ providerID: string; modelID: string }>) => void
  setVariant: (variant: Record<string, string | undefined>) => void
  /** Set a per-agent entry on the frozen home draft. */
  setHomeAgent: (agent: string, model: { providerID: string; modelID: string }) => void
}

/**
 * Apply a parsed model.json value to the sink. Returns the count of
 * per-agent overrides applied (so the test harness can assert the
 * restore did or did not fire).
 */
export function applyModelRestore(value: unknown, sink: RestoreSink): { agentsApplied: number } {
  if (!value || typeof value !== "object") return { agentsApplied: 0 }
  const v = value as Record<string, unknown>

  if (Array.isArray(v.recent)) sink.setRecent(v.recent as Array<{ providerID: string; modelID: string }>)
  if (Array.isArray(v.favorite)) sink.setFavorite(v.favorite as Array<{ providerID: string; modelID: string }>)
  if (typeof v.variant === "object" && v.variant !== null) {
    sink.setVariant(v.variant as Record<string, string | undefined>)
  }

  let agentsApplied = 0
  if (typeof v.agents === "object" && v.agents !== null) {
    const persisted: PersistedAgents = {}
    for (const [agent, entry] of Object.entries(v.agents as Record<string, unknown>)) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).providerID === "string" &&
        typeof (entry as Record<string, unknown>).modelID === "string"
      ) {
        persisted[agent] = {
          providerID: (entry as Record<string, unknown>).providerID as string,
          modelID: (entry as Record<string, unknown>).modelID as string,
        }
      }
    }
    const unbound = sink.isUnbound()
    for (const [agent, model] of Object.entries(persisted)) {
      if (unbound && !sink.getCurrentModels()[agent]) {
        sink.setModel(agent, model)
        agentsApplied++
      } else if (!unbound && !sink.getHomeAgents()[agent]) {
        sink.setHomeAgent(agent, model)
        agentsApplied++
      }
    }
  }
  return { agentsApplied }
}
