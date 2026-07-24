import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

async function waitFor(check: () => boolean, timeout = 3000, label = "condition") {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("continue restores the last model for each primary agent", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const sessionID = "ses_continue_models"
  const session = {
    id: sessionID,
    projectID: "project",
    title: "Continue models",
    slug: "continue-models",
    directory,
    version: "0.0.0-test",
    time: { created: 1, updated: 3 },
  }
  const model = (id: string, name: string) => ({
    id,
    name,
    providerID: id.startsWith("gpt") ? "openai" : "minimax-coding-plan",
    release_date: "2026-01-01",
    status: "active",
    capabilities: { temperature: true, reasoning: true, attachment: false, toolcall: true },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1000, output: 1000 },
    options: {},
    headers: {},
  })
  const providers = [
    {
      id: "openai",
      name: "OpenAI",
      source: "config",
      env: [],
      options: {},
      models: { "gpt-5.6-sol": model("gpt-5.6-sol", "GPT-5.6 Sol") },
    },
    {
      id: "minimax-coding-plan",
      name: "MiniMax",
      source: "config",
      env: [],
      options: {},
      models: { "MiniMax-M2.7-highspeed": model("MiniMax-M2.7-highspeed", "MiniMax M2.7") },
    },
  ]
  const messages = [
    {
      info: {
        id: "msg_build",
        sessionID,
        role: "user",
        agent: "build",
        model: { providerID: "minimax-coding-plan", modelID: "MiniMax-M2.7-highspeed" },
        time: { created: 1 },
      },
      parts: [],
    },
    {
      info: {
        id: "msg_plan",
        sessionID,
        role: "user",
        agent: "plan",
        model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
        time: { created: 2 },
      },
      parts: [],
    },
  ]
  let resolveMessages!: (response: Response) => void
  const messagesResponse = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let messagesRequested = false
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      messagesRequested = true
      return messagesResponse
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === "/agent")
      return json([
        { name: "build", mode: "primary", hidden: false, permission: [] },
        { name: "plan", mode: "primary", hidden: false, permission: [] },
      ])
    if (url.pathname === "/config/providers")
      return json({ providers, default: { openai: "gpt-5.6-sol", "minimax-coding-plan": "MiniMax-M2.7-highspeed" } })
    if (url.pathname === "/provider")
      return json({ all: providers, default: { openai: "gpt-5.6-sol" }, connected: providers.map((item) => item.id) })
  })
  let api: TuiPluginApi | undefined

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await waitFor(() => api?.state.selection().sessionID === sessionID, 3000, "session route")
    await waitFor(() => messagesRequested, 3000, "message request")
    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_assistant",
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: "msg_assistant",
            sessionID,
            role: "assistant",
            agent: "plan",
            providerID: "openai",
            modelID: "gpt-5.6-sol",
            mode: "plan",
            parentID: "msg_plan",
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 3 },
          },
        },
      },
    })
    await waitFor(
      () => api?.state.session.messages(sessionID).some((item) => item.id === "msg_assistant") === true,
      3000,
      "live assistant",
    )
    resolveMessages(json(messages))
    await waitFor(
      () => api?.state.session.messages(sessionID).some((item) => item.id === "msg_plan") === true,
      3000,
      "hydrated messages",
    )
    await waitFor(
      () => api?.state.selection().models.build?.modelID === "MiniMax-M2.7-highspeed",
      3000,
      "build model",
    )
    await waitFor(() => api?.state.selection().models.plan?.modelID === "gpt-5.6-sol", 3000, "plan model")
    await waitFor(() => api?.state.selection().agent === "plan", 3000, "plan agent")
    expect(api?.state.selection()).toMatchObject({
      sessionID,
      agent: "plan",
      models: {
        plan: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
        build: { providerID: "minimax-coding-plan", modelID: "MiniMax-M2.7-highspeed" },
      },
    })

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
