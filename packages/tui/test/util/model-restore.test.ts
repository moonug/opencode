import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { applyModelRestore, type RestoreSink } from "../../src/util/model-restore"
import { readJson, writeJsonAtomic } from "../../src/util/persistence"

function makeSink(state: {
  unbound: boolean
  current: Record<string, { providerID: string; modelID: string }>
  home: Record<string, { providerID: string; modelID: string }>
}): { sink: RestoreSink; applied: { recent: any[]; favorite: any[]; variant: any; models: Record<string, any>; homeAgents: Record<string, any> } } {
  const applied = { recent: undefined as any, favorite: undefined as any, variant: undefined as any, models: {} as Record<string, any>, homeAgents: {} as Record<string, any> }
  const sink: RestoreSink = {
    isUnbound: () => state.unbound,
    getCurrentModels: () => state.current,
    getHomeAgents: () => state.home,
    setModel: (agent, model) => {
      applied.models[agent] = model
    },
    setHomeAgent: (agent, model) => {
      applied.homeAgents[agent] = model
    },
    setRecent: (r) => {
      applied.recent = r
    },
    setFavorite: (f) => {
      applied.favorite = f
    },
    setVariant: (v) => {
      applied.variant = v
    },
  }
  return { sink, applied }
}

describe("util.model-restore", () => {
  test("unbound home: agents seed the live store", () => {
    const { sink, applied } = makeSink({ unbound: true, current: {}, home: {} })
    const result = applyModelRestore(
      {
        recent: [{ providerID: "openai", modelID: "gpt-x" }],
        favorite: [],
        agents: {
          plan: { providerID: "openai", modelID: "gpt-1" },
          build: { providerID: "openai", modelID: "gpt-2" },
        },
      },
      sink,
    )
    expect(result.agentsApplied).toBe(2)
    expect(applied.models.plan).toEqual({ providerID: "openai", modelID: "gpt-1" })
    expect(applied.models.build).toEqual({ providerID: "openai", modelID: "gpt-2" })
    expect(applied.recent).toEqual([{ providerID: "openai", modelID: "gpt-x" }])
  })

  test("unbound: skips agents already present in the live store", () => {
    const { sink, applied } = makeSink({
      unbound: true,
      current: { build: { providerID: "anthropic", modelID: "claude" } },
      home: {},
    })
    const result = applyModelRestore(
      { agents: { build: { providerID: "openai", modelID: "gpt-y" } } },
      sink,
    )
    expect(result.agentsApplied).toBe(0)
    expect(applied.models.build).toBeUndefined()
  })

  test("bound session: agents seed the frozen homeAgents draft only", () => {
    const { sink, applied } = makeSink({
      unbound: false,
      current: {},
      home: {},
    })
    const result = applyModelRestore(
      { agents: { plan: { providerID: "openai", modelID: "gpt-1" } } },
      sink,
    )
    expect(result.agentsApplied).toBe(1)
    expect(applied.homeAgents.plan).toEqual({ providerID: "openai", modelID: "gpt-1" })
    expect(applied.models.plan).toBeUndefined()
  })

  test("skips agents with non-string providerID/modelID", () => {
    const { sink, applied } = makeSink({ unbound: true, current: {}, home: {} })
    const result = applyModelRestore(
      { agents: { plan: { providerID: "openai", modelID: "ok" }, build: { providerID: 123, modelID: "bad" } } },
      sink,
    )
    expect(result.agentsApplied).toBe(1)
    expect(applied.models.plan).toEqual({ providerID: "openai", modelID: "ok" })
    expect(applied.models.build).toBeUndefined()
  })

  test("non-object input is a no-op", () => {
    const { sink, applied } = makeSink({ unbound: true, current: {}, home: {} })
    expect(applyModelRestore(null, sink).agentsApplied).toBe(0)
    expect(applyModelRestore(undefined, sink).agentsApplied).toBe(0)
    expect(applyModelRestore("string", sink).agentsApplied).toBe(0)
    expect(applied.models).toEqual({})
  })

  test("real readJson + applyModelRestore round-trips against a fixture file", async () => {
    // This is the path that was previously broken — restore was reading the
    // file but the empty catch hid any failure. We round-trip a real file
    // through readJson so a future regression in either layer surfaces.
    const dir = mkdtempSync(join(tmpdir(), "model-restore-"))
    try {
      const path = join(dir, "model.json")
      await writeJsonAtomic(path, {
        recent: [{ providerID: "openai", modelID: "gpt-recent" }],
        favorite: [],
        agents: { plan: { providerID: "openai", modelID: "gpt-plan" } },
      })
      const value = await readJson<unknown>(path)
      const { sink, applied } = makeSink({ unbound: true, current: {}, home: {} })
      const result = applyModelRestore(value, sink)
      expect(result.agentsApplied).toBe(1)
      expect(applied.models.plan).toEqual({ providerID: "openai", modelID: "gpt-plan" })
      expect(applied.recent).toEqual([{ providerID: "openai", modelID: "gpt-recent" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
