import { expect, test } from "bun:test"
import type { TuiSelection } from "@opencode-ai/plugin/tui"
import { createRoot, createSignal } from "solid-js"
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
      variant: (model) => (model.modelID === "gpt-5" ? "high" : undefined),
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

test("pinning current models prevents fallback drift across agents", () => {
  const valid = () => true
  const agents = [{ name: "build" }, { name: "plan" }]
  const startupModel = { providerID: "openai", modelID: "startup" }
  const pickedPlan = { providerID: "anthropic", modelID: "plan-picked" }
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
  // Now pick plan model (simulates model.set + recent update)
  modelStore.plan = pickedPlan
  fallback = pickedPlan
  const after = snap("plan")
  expect(after.models.build).toEqual(startupModel)
  expect(after.models.plan).toEqual(pickedPlan)
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
