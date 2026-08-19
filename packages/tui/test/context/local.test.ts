import { expect, test } from "bun:test"
import type { TuiSelection } from "@opencode-ai/plugin/tui"
import { batch, createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import {
  createSelectionState,
  parseModel,
  recentModels,
  resolveModel,
  selectionSnapshot,
} from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("snapshots effective models for every primary visible agent", () => {
  const valid = (model: { providerID: string; modelID: string }) => model.modelID !== "invalid"
  const overrides = { build: { providerID: "openai", modelID: "gpt-5" } }
  const configured = {
    build: { providerID: "anthropic", modelID: "invalid" },
    plan: { providerID: "anthropic", modelID: "claude" },
  }
  const fallback = { providerID: "google", modelID: "gemini" }

  expect(
    selectionSnapshot({
      sessionID: "dummy",
      agent: "build",
      agents: [{ name: "plan" }, { name: "general" }, { name: "build" }],
      model: (agent) =>
        resolveModel(
          valid,
          overrides[agent.name as keyof typeof overrides],
          configured[agent.name as keyof typeof configured],
          fallback,
        ),
      variant: (_agentName, model) => (model.modelID === "gpt-5" ? "high" : undefined),
    }),
  ).toEqual({
    agent: "build",
    models: {
      build: { providerID: "openai", modelID: "gpt-5", variant: "high" },
      general: fallback,
      plan: { providerID: "anthropic", modelID: "claude" },
    },
  })
})

test("variant (effort) is per-agent: same model, independent variants", () => {
  const sameModel = { providerID: "zai", modelID: "glm-5.2" }
  const variantStore: Record<string, string | undefined> = {
    "plan/zai/glm-5.2": "high",
    "build/zai/glm-5.2": "low",
  }
  const result = selectionSnapshot({
    agents: [{ name: "build" }, { name: "plan" }],
    model: () => sameModel,
    variant: (agentName, m) => variantStore[`${agentName}/${m.providerID}/${m.modelID}`],
  })
  expect(result.models.plan).toEqual({ ...sameModel, variant: "high" })
  expect(result.models.build).toEqual({ ...sameModel, variant: "low" })
  expect(result.models.plan?.variant).not.toBe(result.models.build?.variant)
})

test("variant falls back to legacy per-model key when per-agent key absent", () => {
  const sameModel = { providerID: "zai", modelID: "glm-5.2" }
  const variantStore: Record<string, string | undefined> = {
    "zai/glm-5.2": "high",
  }
  const result = selectionSnapshot({
    agents: [{ name: "build" }, { name: "plan" }],
    model: () => sameModel,
    variant: (agentName, m) =>
      variantStore[`${agentName}/${m.providerID}/${m.modelID}`] ??
      variantStore[`${m.providerID}/${m.modelID}`],
  })
  expect(result.models.plan).toEqual({ ...sameModel, variant: "high" })
  expect(result.models.build).toEqual({ ...sameModel, variant: "high" })
})

test("pinning current models prevents fallback drift across agents", () => {
  const valid = () => true
  const agents = [{ name: "build" }, { name: "plan" }]
  const startupModel = { providerID: "openai", modelID: "startup" }
  const pickedBuild = { providerID: "anthropic", modelID: "build-picked" }
  const pickedPlan = { providerID: "google", modelID: "plan-picked" }
  const modelStore: Record<string, { providerID: string; modelID: string } | undefined> = {}
  let fallback: { providerID: string; modelID: string } = startupModel
  const snap = (agent?: string) =>
    selectionSnapshot({
      agent,
      agents,
      model: (a) => resolveModel(valid, modelStore[a.name], undefined, fallback),
      variant: () => undefined,
    })
  const before = snap()
  expect(before.models.build).toEqual(startupModel)
  expect(before.models.plan).toEqual(startupModel)
  // Pin current effective models before updating fallback
  for (const a of agents) {
    const current = resolveModel(valid, modelStore[a.name], undefined, fallback)
    if (current) modelStore[a.name] = current
  }
  // Now pick build model (simulates model.set + recent update)
  modelStore.build = pickedBuild
  fallback = pickedBuild
  const afterBuild = snap("build")
  expect(afterBuild.models.build).toEqual(pickedBuild)
  expect(afterBuild.models.plan).toEqual(startupModel)
  // Pick plan model — build must stay on its own override
  modelStore.plan = pickedPlan
  fallback = pickedPlan
  const afterPlan = snap("plan")
  expect(afterPlan.models.build).toEqual(pickedBuild)
  expect(afterPlan.models.plan).toEqual(pickedPlan)
})

test("pinning via Solid store: spread breaks shared proxy so agents stay independent", () => {
  const run = (spread: boolean) =>
    createRoot((dispose) => {
      const [modelStore, setModelStore] = createStore<{
        model: Record<string, { providerID: string; modelID: string } | undefined>
        recent: { providerID: string; modelID: string }[]
      }>({
        model: {},
        recent: [{ providerID: "openai", modelID: "startup" }],
      })
      const valid = (_m: { providerID: string; modelID: string }) => true
      const agents = [{ name: "build" }, { name: "plan" }]
      const modelFor = (a: { name: string }) => {
        const current = modelStore.model[a.name] ?? modelStore.recent[0]
        return current && valid(current) ? current : undefined
      }
      const recentModels = (
        m: { providerID: string; modelID: string },
        r: { providerID: string; modelID: string }[],
      ) => [m, ...r].filter((x, i, a) => a.findIndex((y) => y.providerID === x.providerID && y.modelID === x.modelID) === i)

      const setRecent = (agent: string, m: { providerID: string; modelID: string }) => {
        batch(() => {
          for (const ag of agents) {
            const current = modelFor(ag)
            if (current) setModelStore("model", ag.name, spread ? { ...current } : current)
          }
          setModelStore("model", agent, m)
          setModelStore("recent", recentModels(m, modelStore.recent))
        })
      }

      setRecent("build", { providerID: "anthropic", modelID: "build-picked" })
      const afterBuild = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }
      setRecent("plan", { providerID: "google", modelID: "plan-picked" })
      const afterPlan = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }
      return { dispose, afterBuild, afterPlan }
    })

  // Without spread: both agents share the same Solid store node, picking one mutates the other
  const buggy = run(false)
  expect(buggy.afterBuild.build).toEqual({ providerID: "anthropic", modelID: "build-picked" })
  // BUG: plan already drifted to build-picked because the proxy was shared
  expect(buggy.afterBuild.plan).toEqual({ providerID: "anthropic", modelID: "build-picked" })
  // BUG: second pick drifts both to plan-picked
  expect(buggy.afterPlan.build).toEqual({ providerID: "google", modelID: "plan-picked" })
  expect(buggy.afterPlan.plan).toEqual({ providerID: "google", modelID: "plan-picked" })
  buggy.dispose()

  // With spread: each agent gets its own plain object copy, no drift
  const fixed = run(true)
  expect(fixed.afterBuild.build).toEqual({ providerID: "anthropic", modelID: "build-picked" })
  expect(fixed.afterBuild.plan).toEqual({ providerID: "openai", modelID: "startup" })
  expect(fixed.afterPlan.build).toEqual({ providerID: "anthropic", modelID: "build-picked" })
  expect(fixed.afterPlan.plan).toEqual({ providerID: "google", modelID: "plan-picked" })
  fixed.dispose()
})

test("pinning loop only pins explicit overrides, never resolves via shared fallback", () => {
  // Mirrors local.tsx model.set({ recent: true }): the pinning loop must
  // preserve ONLY models the user explicitly picked. Resolving unset agents
  // through modelFor() (override → config → shared fallback) pinned every
  // agent to the same fallback — the contamination bug.
  const run = () =>
    createRoot((dispose) => {
      const [modelStore, setModelStore] = createStore<{
        model: Record<string, { providerID: string; modelID: string } | undefined>
        recent: { providerID: string; modelID: string }[]
      }>({ model: {}, recent: [] })
      const valid = (_m: { providerID: string; modelID: string }) => true
      const agents = [{ name: "build" }, { name: "plan" }]

      const setRecent = (agent: string, m: { providerID: string; modelID: string }) => {
        batch(() => {
          for (const ag of agents) {
            // Fixed logic: only pin agents that already have an explicit override.
            const explicit = modelStore.model[ag.name]
            if (explicit && valid(explicit)) setModelStore("model", ag.name, { ...explicit })
          }
          setModelStore("model", agent, m)
          setModelStore("recent", [m, ...modelStore.recent])
        })
      }

      // No overrides at all. Picking build must NOT create a plan override
      // from the shared recent list.
      setRecent("build", { providerID: "opencode-go", modelID: "deepseek-v4-flash" })
      const afterBuild = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }

      // Now build is explicitly pinned. Picking plan must NOT overwrite it.
      setRecent("plan", { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" })
      const afterPlan = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }
      return { dispose, afterBuild, afterPlan }
    })

  const fixture = run()
  // Build picked → plan untouched (no fallback contamination).
  expect(fixture.afterBuild.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterBuild.plan).toBeUndefined()
  // Plan picked → build's explicit override preserved, plan gets its own.
  expect(fixture.afterPlan.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterPlan.plan).toEqual({ providerID: "minimax-coding-plan", modelID: "MiniMax-M3" })
  fixture.dispose()
})

test("model.restore merges partial overrides; bindExistingSession owns resets", () => {
  // Mirrors local.tsx: restore() is merge-only (never clears), while entering
  // an existing session (bindExistingSession) clears the previous scope.
  // Partial restores after compaction must NOT wipe a surviving override.
  const run = () =>
    createRoot((dispose) => {
      const [modelStore, setModelStore] = createStore<{
        sessionID?: string
        model: Record<string, { providerID: string; modelID: string } | undefined>
      }>({ sessionID: undefined, model: {} })
      const valid = (_m: { providerID: string; modelID: string }) => true
      const agents = ["build", "plan"]

      // Mirrors bindExistingSession: bind scope + clear all agent overrides.
      const bindExistingSession = (sessionID: string) => {
        for (const name of agents) setModelStore("model", name, undefined)
        setModelStore("sessionID", sessionID)
      }
      // Mirrors restore: bind scope + merge only the provided agents.
      const restore = (sessionID: string, models: Record<string, { providerID: string; modelID: string }>) => {
        setModelStore("sessionID", sessionID)
        for (const [name, value] of Object.entries(models)) {
          if (agents.includes(name) && valid(value)) setModelStore("model", name, { ...value })
        }
      }

      restore("ses_X", { build: { providerID: "opencode-go", modelID: "deepseek-v4-flash" } })
      const beforeCompaction = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }

      // After compaction, plan's last message remains, build's was pruned.
      // Partial restore must NOT wipe build's override.
      restore("ses_X", { plan: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" } })
      const afterPartial = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }

      // Entering a different existing session clears the previous scope.
      bindExistingSession("ses_Y")
      const afterSwitch = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }
      return { dispose, beforeCompaction, afterPartial, afterSwitch }
    })

  const fixture = run()
  expect(fixture.beforeCompaction.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.beforeCompaction.plan).toBeUndefined()
  // Regression: partial restore keeps build override (compaction pruned build msg)
  expect(fixture.afterPartial.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterPartial.plan).toEqual({ providerID: "minimax-coding-plan", modelID: "MiniMax-M3" })
  // Session switch resets via bindExistingSession, not restore
  expect(fixture.afterSwitch.build).toBeUndefined()
  expect(fixture.afterSwitch.plan).toBeUndefined()
  fixture.dispose()
})

test("attachNewSession transfers draft picks; bindExistingSession clears existing entry", () => {
  // Mirrors local.tsx scope transitions. A brand-new session created from
  // the home draft (attachNewSession) must keep the per-agent picks; opening
  // an existing session (bindExistingSession) discards them and lets message
  // history restore the session's own models.
  const run = () =>
    createRoot((dispose) => {
      const [modelStore, setModelStore] = createStore<{
        sessionID?: string
        model: Record<string, { providerID: string; modelID: string } | undefined>
      }>({ sessionID: undefined, model: {} })
      const valid = (_m: { providerID: string; modelID: string }) => true
      const agents = ["build", "plan"]
      const attachNewSession = (sessionID: string) => setModelStore("sessionID", sessionID)
      const bindExistingSession = (sessionID: string) => {
        for (const name of agents) setModelStore("model", name, undefined)
        setModelStore("sessionID", sessionID)
      }
      const restore = (sessionID: string, models: Record<string, { providerID: string; modelID: string }>) => {
        setModelStore("sessionID", sessionID)
        for (const [name, value] of Object.entries(models)) {
          if (agents.includes(name) && valid(value)) setModelStore("model", name, { ...value })
        }
      }

      // Home draft: build=deepseek picked explicitly, plan left to fallback.
      setModelStore("model", "build", { providerID: "opencode-go", modelID: "deepseek-v4-flash" })

      // Home → brand-new session: picks transfer unchanged, scope binds.
      attachNewSession("ses_NEW")
      const afterNew = {
        sessionID: modelStore.sessionID,
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }

      // New session's messages restore only plan (build has no message yet).
      restore("ses_NEW", { plan: { providerID: "openai", modelID: "gpt-5.6-sol" } })
      const afterRestore = {
        sessionID: modelStore.sessionID,
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }

      // Returning home keeps overrides; opening an EXISTING session clears.
      setModelStore("sessionID", undefined as string | undefined)
      bindExistingSession("ses_EXISTING")
      const afterExisting = {
        sessionID: modelStore.sessionID,
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }
      return { dispose, afterNew, afterRestore, afterExisting }
    })

  const fixture = run()
  // New session inherits the draft picks and binds its own scope.
  expect(fixture.afterNew.sessionID).toBe("ses_NEW")
  expect(fixture.afterNew.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterNew.plan).toBeUndefined()
  // Message restore merges plan; build's transferred pick survives.
  expect(fixture.afterRestore.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterRestore.plan).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
  // Opening an existing session clears draft values; history restores them.
  expect(fixture.afterExisting.sessionID).toBe("ses_EXISTING")
  expect(fixture.afterExisting.build).toBeUndefined()
  expect(fixture.afterExisting.plan).toBeUndefined()
  fixture.dispose()
})

test("homeAgents persistence: home draft survives restart, in-session picks do not leak", () => {
  // Mirrors the save() payload + tracking effect in local.tsx. The home
  // draft is snapshot only while sessionID is undefined; attaching a
  // session (or returning to home before save runs) must not let in-session
  // model edits overwrite the persisted draft.
  const run = () =>
    createRoot((dispose) => {
      const [modelStore, setModelStore] = createStore<{
        sessionID?: string
        model: Record<string, { providerID: string; modelID: string } | undefined>
      }>({ sessionID: undefined, model: {} })
      let homeAgents: Record<string, { providerID: string; modelID: string }> = {}
      const effect = () => {
        if (modelStore.sessionID === undefined) {
          homeAgents = { ...modelStore.model }
        }
      }
      // Save happens at home → captures the draft.
      effect()
      const atHome = { ...homeAgents }
      // User picks deepseek for build on home.
      setModelStore("model", "build", { providerID: "opencode-go", modelID: "deepseek-v4-flash" })
      effect()
      const afterHomePick = { ...homeAgents }
      // attachNewSession (prompt submit) sets sessionID → effect stops
      // updating homeAgents. In-session model change must NOT leak.
      setModelStore("sessionID", "ses_NEW")
      setModelStore("model", "plan", { providerID: "openai", modelID: "gpt-5.6-sol" })
      effect()
      const afterSessionPick = { ...homeAgents }
      // Restore round-trip: a fresh store built from homeAgents gets the
      // user's last home draft (build only), not the in-session plan.
      const [restored] = createStore<{
        model: Record<string, { providerID: string; modelID: string } | undefined>
      }>({ model: { ...homeAgents } })
      return { dispose, atHome, afterHomePick, afterSessionPick, restored }
    })

  const f = run()
  expect(f.atHome).toEqual({})
  expect(f.afterHomePick).toEqual({
    build: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
  })
  // In-session plan pick must NOT enter the persisted draft.
  expect(f.afterSessionPick).toEqual({
    build: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
  })
  // Restored store: only the home draft, no plan.
  expect(f.restored.model).toEqual({
    build: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
  })
  f.dispose()
})

test("route transitions: attachNewSession binds draft, bindExistingSession clears, dummy stays unbound", () => {
  // Mirrors local.tsx sync effect. home → brand-new session goes through
  // attachNewSession (draft picks survive). Opening an existing session from
  // home goes through bindExistingSession (picks cleared, history restores).
  // Returning home goes through unbindSession (frozen draft restored).
  // Placeholder IDs like "dummy" (`--continue` startup) never bind or clear.
  const run = () =>
    createRoot((dispose) => {
      const [modelStore, setModelStore] = createStore<{
        sessionID?: string
        model: Record<string, { providerID: string; modelID: string } | undefined>
      }>({ sessionID: undefined, model: {} })
      const agents = ["build", "plan"]
      let homeAgents: Record<string, { providerID: string; modelID: string }> = {}
      const homeEffect = () => {
        if (modelStore.sessionID === undefined) {
          homeAgents = { ...modelStore.model }
        }
      }
      // Mirrors local.tsx: sync effect keeps draft overrides when a session
      // was already bound by attachNewSession; clears otherwise (existing
      // session / switch). Dummy (non-ses_) routes return early — unbound.
      const routeEffect = (routeSession: string | undefined) => {
        if (!routeSession) {
          // unbindSession: clear every agent, then seed the frozen draft back.
          setModelStore("sessionID", undefined as string | undefined)
          for (const name of agents) {
            setModelStore("model", name, undefined)
            const draft = homeAgents[name]
            if (draft) setModelStore("model", name, { ...draft })
          }
          homeEffect()
          return
        }
        if (!routeSession.startsWith("ses_")) return
        if (modelStore.sessionID !== routeSession) {
          for (const name of agents) setModelStore("model", name, undefined)
          setModelStore("sessionID", routeSession)
        }
      }

      // Home draft: build pinned to deepseek.
      setModelStore("model", "build", { providerID: "opencode-go", modelID: "deepseek-v4-flash" })
      homeEffect()

      // Placeholder route (--continue): must not clear the draft.
      routeEffect("dummy")
      const afterDummy = {
        sessionID: modelStore.sessionID,
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
      }

      // Home → brand-new session: attachNewSession already bound it, so the
      // route effect skips the reset and picks survive.
      setModelStore("sessionID", "ses_new")
      routeEffect("ses_new")
      const afterNew = {
        sessionID: modelStore.sessionID,
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }

      // Opening an existing session from home: not pre-bound → clears.
      routeEffect("ses_existing")
      const afterExisting = {
        sessionID: modelStore.sessionID,
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }

      // History restores the existing session's own build model (glm).
      setModelStore("model", "build", { providerID: "zai-coding-plan", modelID: "glm-5.3" })
      // Returning home: the session's glm must NOT survive as the draft.
      routeEffect(undefined)
      const afterHome = {
        sessionID: modelStore.sessionID,
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        homeBuild: homeAgents.build ? { ...homeAgents.build } : undefined,
      }
      return { dispose, afterDummy, afterNew, afterExisting, afterHome }
    })

  const fixture = run()
  // Dummy placeholder is unbound; draft survives.
  expect(fixture.afterDummy.sessionID).toBeUndefined()
  expect(fixture.afterDummy.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  // New session preserves draft picks and binds its own scope.
  expect(fixture.afterNew.sessionID).toBe("ses_new")
  expect(fixture.afterNew.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterNew.plan).toBeUndefined()
  // Existing session opened from home clears the draft scope.
  expect(fixture.afterExisting.sessionID).toBe("ses_existing")
  expect(fixture.afterExisting.build).toBeUndefined()
  expect(fixture.afterExisting.plan).toBeUndefined()
  // Returning home restores the frozen draft; the session's history-restored
  // glm must not leak into the draft (RC1b regression).
  expect(fixture.afterHome.sessionID).toBeUndefined()
  expect(fixture.afterHome.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterHome.homeBuild).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  fixture.dispose()
})

test("late model.json restore while a session is bound does not contaminate the session scope", () => {
  // Regression (RC1a): on --continue into an existing session,
  // bindExistingSession clears overrides and history restore seeds the
  // session's own models BEFORE the async model.json read resolves. The
  // restore must NOT write the home draft into the bound session scope —
  // it lands in the frozen homeAgents draft instead, so the TUI keeps
  // displaying the session's real model while the draft survives for the
  // next session.
  const run = () =>
    createRoot((dispose) => {
      const [modelStore, setModelStore] = createStore<{
        sessionID?: string
        model: Record<string, { providerID: string; modelID: string } | undefined>
      }>({ sessionID: undefined, model: {} })
      const agents = ["build", "plan"]
      let homeAgents: Record<string, { providerID: string; modelID: string }> = {}
      const homeEffect = () => {
        if (modelStore.sessionID === undefined) {
          homeAgents = { ...modelStore.model }
        }
      }
      homeEffect() // startup snapshot: empty draft

      // --continue: bind the existing session (clears overrides), then
      // message history restores its own build model (glm).
      setModelStore("sessionID", "ses_existing")
      for (const name of agents) setModelStore("model", name, undefined)
      setModelStore("model", "build", { providerID: "zai-coding-plan", modelID: "glm-5.3" })

      // The model.json read resolves late with the persisted home draft
      // (build=luna). Mirrors the restore branch in local.tsx.
      const persisted: Record<string, { providerID: string; modelID: string }> = {
        build: { providerID: "opencode-go", modelID: "luna" },
      }
      const unbound = modelStore.sessionID === undefined
      for (const [agent, model] of Object.entries(persisted)) {
        if (unbound && !modelStore.model[agent]) {
          setModelStore("model", agent, model)
        } else if (!unbound && !homeAgents[agent]) {
          homeAgents[agent] = model
        }
      }

      return {
        dispose,
        sessionBuild: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        draftBuild: homeAgents.build ? { ...homeAgents.build } : undefined,
      }
    })

  const f = run()
  // Session scope keeps the session's own history-restored model.
  expect(f.sessionBuild).toEqual({ providerID: "zai-coding-plan", modelID: "glm-5.3" })
  // The home draft got the persisted luna instead of poisoning the session.
  expect(f.draftBuild).toEqual({ providerID: "opencode-go", modelID: "luna" })
  f.dispose()
})

test("home does NOT pin the shared fallback for unset agents (nanobanana regression)", () => {
  // Regression for the `.7` bug: the home-pinning effect pinned
  // resolverModel(a.model, fallbackModel()) into modelStore.model[agent] on
  // every visit to home, poisoning every fresh start with the first
  // provider's default (openrouter/google/gemini-3-pro-image-preview on
  // this machine). The effect was removed; per-agent restorability now
  // comes from persisted model.json `agents` instead. This test asserts
  // the local model store MUST stay at model={} for agents with no
  // explicit picker choice until the user picks one through the picker.
  const fixture = createRoot((dispose) => {
    const [modelStore, setModelStore] = createStore<{
      model: Record<string, { providerID: string; modelID: string } | undefined>
    }>({ model: {} })
    const agents = [{ name: "build" }, { name: "plan" }]
    // Simulate a home visit with no user picks. No effect should write.
    // (Before the fix, the home effect would have pinned both agents.)
    const snapshot = () =>
      Object.fromEntries(
        agents.map((a) => [a.name, modelStore.model[a.name] ? { ...modelStore.model[a.name]! } : undefined]),
      )
    return { dispose, setModelStore, modelStore, snapshot }
  })
  expect(fixture.snapshot()).toEqual({ build: undefined, plan: undefined })
  // The user explicitly picks build (e.g. via the picker → local.model.set).
  fixture.setModelStore("model", "build", { providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.snapshot()).toEqual({
    build: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    plan: undefined,
  })
  // plan stays unset — no fallback contamination.
  fixture.dispose()
})

test("emits structural selection and session changes but suppresses no-ops", async () => {
  const fixture = createRoot((dispose) => {
    const [current, setCurrent] = createSignal<TuiSelection>(
      selectionSnapshot({ agents: [], model: () => undefined, variant: () => undefined }),
    )
    return { dispose, setCurrent, state: createSelectionState(current) }
  })
  await Promise.resolve()

  const events: unknown[] = []
  fixture.state.subscribe((event) => events.push(event))
  fixture.setCurrent({ models: {} })
  const selected: TuiSelection = {
    agent: "build",
    models: { build: { providerID: "openai", modelID: "gpt-5" } },
  }
  fixture.setCurrent(selected)
  fixture.setCurrent({ ...selected, models: { ...selected.models } })
  fixture.setCurrent({ ...selected, sessionID: "ses_1" })
  await Promise.resolve()

  expect(events).toHaveLength(2)
  expect(events[0]).toEqual({
    type: "tui.selection.changed",
    data: { previous: { models: {} }, current: selected },
  })
  expect(events[1]).toEqual({
    type: "tui.selection.changed",
    data: { previous: selected, current: { ...selected, sessionID: "ses_1" } },
  })
  fixture.dispose()
})

test("keeps selection subscribers isolated per instance", async () => {
  const fixture = createRoot((dispose) => {
    const [first, setFirst] = createSignal<TuiSelection>({ models: {} })
    const [second] = createSignal<TuiSelection>({ models: {} })
    return {
      dispose,
      setFirst,
      firstState: createSelectionState(first),
      secondState: createSelectionState(second),
    }
  })
  await Promise.resolve()

  let firstEvents = 0
  let secondEvents = 0
  fixture.firstState.subscribe(() => firstEvents++)
  fixture.secondState.subscribe(() => secondEvents++)
  fixture.setFirst({ sessionID: "ses_1", models: {} })
  await Promise.resolve()

  expect(firstEvents).toBe(1)
  expect(secondEvents).toBe(0)
  fixture.dispose()
})

test("emits explicit model selections separately from selection snapshots", () => {
  const fixture = createRoot((dispose) => ({
    dispose,
    state: createSelectionState(() => ({ models: {} })),
  }))
  const events: unknown[] = []
  fixture.state.subscribeModel((event) => events.push(event))

  fixture.state.modelSelected({
    type: "tui.model.selected",
    data: {
      sessionID: "ses_1",
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
    },
  })

  expect(events).toEqual([
    {
      type: "tui.model.selected",
      data: {
        sessionID: "ses_1",
        agent: "plan",
        model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
      },
    },
  ])
  fixture.dispose()
})

test("empty message sync does not clear existing model overrides", () => {
  // Mirrors local.tsx sync effect: `restored` computed from messages can be
  // empty when the sync briefly loses the message list (refresh/reconnect).
  // An empty restore must NOT wipe overrides — that fell back to the shared
  // default for every agent (contamination).
  const run = () =>
    createRoot((dispose) => {
      const [modelStore, setModelStore] = createStore<{
        sessionID?: string
        model: Record<string, { providerID: string; modelID: string } | undefined>
      }>({ model: {} })
      const valid = (_m: { providerID: string; modelID: string }) => true
      const agents = [{ name: "build" }, { name: "plan" }]
      let modelsRestoredFor: string | undefined

      // Mirrors the fixed sync-effect guard.
      const syncRestore = (sessionID: string, restored: Record<string, { providerID: string; modelID: string }>) => {
        if (Object.keys(restored).length > 0 && modelsRestoredFor !== sessionID) {
          modelsRestoredFor = sessionID
          for (const [name, value] of Object.entries(restored)) {
            if (agents.some((a) => a.name === name) && valid(value)) setModelStore("model", name, { ...value })
          }
        }
      }

      // User picked models explicitly (model.set with recent: true).
      setModelStore("model", "build", { providerID: "opencode-go", modelID: "deepseek-v4-flash" })
      setModelStore("model", "plan", { providerID: "openai", modelID: "gpt-5.6-luna" })

      // Sync refresh yields an EMPTY message list → restored = {}.
      syncRestore("ses_1", {})
      const afterEmpty = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }

      // First real message batch restores both agents.
      syncRestore("ses_1", {
        build: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
        plan: { providerID: "openai", modelID: "gpt-5.6-luna" },
      })
      const afterFirstRestore = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }

      // A later sync (compaction, refresh) yields DIFFERENT models — must be
      // ignored because the session was already restored once.
      syncRestore("ses_1", {
        build: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" },
        plan: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" },
      })
      const afterSecondSync = {
        build: modelStore.model.build ? { ...modelStore.model.build } : undefined,
        plan: modelStore.model.plan ? { ...modelStore.model.plan } : undefined,
      }
      return { dispose, afterEmpty, afterFirstRestore, afterSecondSync }
    })

  const fixture = run()
  // Empty sync must NOT clear existing overrides.
  expect(fixture.afterEmpty.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterEmpty.plan).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" })
  // First real restore sets both.
  expect(fixture.afterFirstRestore.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterFirstRestore.plan).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" })
  // Later sync with different models is ignored (once-per-session guard).
  expect(fixture.afterSecondSync.build).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterSecondSync.plan).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" })
  fixture.dispose()
})

test("restore guard resets per session, allowing each session its own restore", () => {
  // The once-per-session guard is scoped to a sessionID. Switching sessions
  // must reset it so the new session's messages can be restored.
  const run = () =>
    createRoot((dispose) => {
      const [modelStore, setModelStore] = createStore<{
        model: Record<string, { providerID: string; modelID: string } | undefined>
      }>({ model: {} })
      const valid = (_m: { providerID: string; modelID: string }) => true
      const agents = [{ name: "build" }, { name: "plan" }]
      let modelsRestoredFor: string | undefined

      const syncRestore = (sessionID: string, restored: Record<string, { providerID: string; modelID: string }>) => {
        if (Object.keys(restored).length > 0 && modelsRestoredFor !== sessionID) {
          modelsRestoredFor = sessionID
          for (const [name, value] of Object.entries(restored)) {
            if (agents.some((a) => a.name === name) && valid(value)) setModelStore("model", name, { ...value })
          }
        }
      }

      syncRestore("ses_A", { build: { providerID: "opencode-go", modelID: "deepseek-v4-flash" } })
      const afterA = modelStore.model.build ? { ...modelStore.model.build } : undefined
      // Same session again — ignored (already restored).
      syncRestore("ses_A", { build: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" } })
      const afterSameSession = modelStore.model.build ? { ...modelStore.model.build } : undefined
      // New session — guard reset, restore proceeds.
      syncRestore("ses_B", { build: { providerID: "openai", modelID: "gpt-5.6-sol" } })
      const afterB = modelStore.model.build ? { ...modelStore.model.build } : undefined
      return { dispose, afterA, afterSameSession, afterB }
    })

  const fixture = run()
  expect(fixture.afterA).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterSameSession).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" })
  expect(fixture.afterB).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
  fixture.dispose()
})
