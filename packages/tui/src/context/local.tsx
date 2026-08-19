import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo } from "solid-js"
import type {
  TuiModelSelectedEvent,
  TuiSelection,
  TuiSelectionChangedEvent,
  TuiSelectionModel,
} from "@opencode-ai/plugin/tui"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { usePermission } from "./permission"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

export function resolveModel(
  valid: (model: { providerID: string; modelID: string }) => boolean,
  ...models: ({ providerID: string; modelID: string } | undefined)[]
) {
  return models.find((model) => model && valid(model))
}

export function selectionSnapshot<Agent extends { name: string }>(input: {
  sessionID?: string
  agent?: string
  agents: ReadonlyArray<Agent>
  model: (agent: Agent) => { providerID: string; modelID: string } | undefined
  variant: (agentName: string, model: { providerID: string; modelID: string }) => string | undefined
}): TuiSelection {
  const models: Record<string, TuiSelectionModel> = {}
  for (const agent of input.agents.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const model = input.model(agent)
    if (!model) continue
    const variant = input.variant(agent.name, model)
    models[agent.name] = { ...model, ...(variant ? { variant } : {}) }
  }
  return {
    ...(input.sessionID?.startsWith("ses_") ? { sessionID: input.sessionID } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    models,
  }
}

export function createSelectionState(current: () => TuiSelection) {
  const handlers = new Set<(event: TuiSelectionChangedEvent) => void>()
  const modelHandlers = new Set<(event: TuiModelSelectedEvent) => void>()
  let previous: TuiSelection | undefined
  let key: string | undefined

  createEffect(() => {
    const value = current()
    const next = JSON.stringify(value)
    if (next === key) return
    const event: TuiSelectionChangedEvent = {
      type: "tui.selection.changed",
      data: { previous, current: value },
    }
    previous = value
    key = next
    for (const handler of handlers) handler(event)
  })

  return {
    current,
    subscribe(handler: (event: TuiSelectionChangedEvent) => void) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    subscribeModel(handler: (event: TuiModelSelectedEvent) => void) {
      modelHandlers.add(handler)
      return () => modelHandlers.delete(handler)
    },
    modelSelected(event: TuiModelSelectedEvent) {
      for (const handler of modelHandlers) handler(event)
    },
  }
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const permission = usePermission()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((item) => item.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function createAgent() {
      const agents = createMemo(() => sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((agent) => !agent.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()
    let selection: ReturnType<typeof createSelectionState>

    function createModel() {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        sessionID?: string
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        sessionID: undefined,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
      }

      // Snapshot of the home/draft per-agent overrides. Mirrors
      // modelStore.model while sessionID is undefined (i.e. on home) and
      // freezes on attachNewSession, so in-session model changes never leak
      // into the persisted draft. Restored at startup via model.json so
      // new sessions start with the user's last per-agent picks — no
      // cross-agent fallback leaks.
      let homeAgents: Record<
        string,
        { providerID: string; modelID: string }
      > = {}

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
          agents: homeAgents,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const value = x as Record<string, unknown>
          if (Array.isArray(value.recent)) setModelStore("recent", value.recent)
          if (Array.isArray(value.favorite)) setModelStore("favorite", value.favorite)
          if (typeof value.variant === "object" && value.variant !== null)
            setModelStore("variant", value.variant as Record<string, string | undefined>)
          if (typeof value.agents === "object" && value.agents !== null) {
            const persisted: Record<string, { providerID: string; modelID: string }> = {}
            for (const [agent, entry] of Object.entries(value.agents as Record<string, unknown>)) {
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
            const unbound = modelStore.sessionID === undefined
            for (const [agent, model] of Object.entries(persisted)) {
              if (unbound && !modelStore.model[agent]) {
                // Home/draft scope: seed the live overrides. The homeAgents
                // effect snapshots them into the draft on its next run.
                setModelStore("model", agent, model)
              } else if (!unbound && !homeAgents[agent]) {
                // A session is already bound (e.g. --continue into an
                // existing session): writing into the store here would
                // contaminate the session scope AFTER bindExistingSession
                // cleared it and history restore seeded the session's own
                // models. Restore into the frozen draft only, so the next
                // home/new session still inherits it.
                homeAgents[agent] = model
              }
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        // NOTE: recent is intentionally NOT a fallback. It is a shared,
        // agent-agnostic list used only by the model picker dialog. Using it
        // here would resolve every agent without an override to the most
        // recently picked model — leaking one agent's pick into another.

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      function modelFor(a: { name: string; model?: { providerID: string; modelID: string } }) {
        const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
        const override = modelStore.sessionID === sessionID ? modelStore.model[a.name] : undefined
        return resolveModel(isModelValid, override, a.model, fallbackModel())
      }

      function attachNewSession(sessionID: string) {
        // Home/draft scope → brand-new session: transfer the draft per-agent
        // picks unchanged. Called by the prompt submit right after
        // session.create() succeeds, before the first prompt is sent.
        batch(() => {
          setModelStore("sessionID", sessionID)
        })
      }

      function bindExistingSession(sessionID: string) {
        // Entering an existing session (opened from home, or a session
        // switch): discard the previous scope. Per-agent message history
        // restores the session's own models below.
        batch(() => {
          setModelStore("sessionID", sessionID)
          // setStore("model", {}) does NOT remove existing nested keys in
          // SolidJS, so clear each known agent explicitly.
          for (const item of agent.list()) {
            setModelStore("model", item.name, undefined as never)
          }
        })
      }

      function unbindSession() {
        // Returning to the home/draft scope: restore the frozen draft. The
        // overrides currently in the store belong to the session we just
        // left (restored from ITS message history) and must not become the
        // home draft — otherwise one session's models leak into save()
        // and every future session.
        batch(() => {
          setModelStore("sessionID", undefined as string | undefined)
          // setStore("model", {}) does NOT remove existing nested keys in
          // SolidJS, so clear each known agent explicitly, then seed the
          // draft back.
          for (const item of agent.list()) {
            setModelStore("model", item.name, undefined as never)
            const draft = homeAgents[item.name]
            if (draft) setModelStore("model", item.name, { ...draft })
          }
        })
      }

      function modelSelected(model: TuiSelectionModel) {
        const current = agent.current()
        if (!current) return
        const variant = model.variant ?? variantFor(current.name, model)
        selection?.modelSelected({
          type: "tui.model.selected",
          data: {
            ...(route.data.type === "session" ? { sessionID: route.data.sessionID } : {}),
            agent: current.name,
            model: { providerID: model.providerID, modelID: model.modelID, ...(variant ? { variant } : {}) },
          },
        })
      }

      const currentModel = createMemo(() => {
        const a = agent.current()
        return a ? modelFor(a) : undefined
      })

      function variantFor(agentName: string, m: { providerID: string; modelID: string }) {
        const agentKey = `${agentName}/${m.providerID}/${m.modelID}`
        const legacyKey = `${m.providerID}/${m.modelID}`
        const value = modelStore.variant[agentKey] ?? modelStore.variant[legacyKey]
        if (!value) return
        const provider = sync.data.provider.find((item) => item.id === m.providerID)
        const variants = provider?.models[m.modelID]?.variants
        return variants && Object.hasOwn(variants, value) ? value : undefined
      }

      createEffect(() => {
        if (modelStore.sessionID === undefined) {
          homeAgents = { ...modelStore.model }
        }
      })

      return {
        current: currentModel,
        forAgent: modelFor,
        variantFor,
        attachNewSession,
        bindExistingSession,
        unbindSession,
        scope() {
          return modelStore.sessionID
        },
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((item) => item.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...val })
          modelSelected(val)
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          const a = agent.current()
          if (!a) return
          for (const ag of agent.list()) {
            // Only pin agents with an explicit override. Resolving via
            // modelFor() falls back to the shared fallback chain, which
            // would pin every unset agent to the same model (contamination).
            const explicit = modelStore.model[ag.name]
            if (explicit && isModelValid(explicit)) setModelStore("model", ag.name, { ...explicit })
          }
          setModelStore("model", a.name, { ...next })
          setModelStore("recent", recentModels(next, modelStore.recent))
          save()
          modelSelected(next)
        },
        restore(sessionID: string, models: Record<string, { providerID: string; modelID: string }>) {
          const names = new Set(agent.list().map((item) => item.name))
          batch(() => {
            setModelStore("sessionID", sessionID)
            // Merge, don't replace: only update agents with a matching
            // message. A full replace wipes agents whose last message was
            // pruned by compaction, causing them to fall back to a recent
            // (possibly other agent's) model.
            for (const [name, value] of Object.entries(models)) {
              if (names.has(name) && isModelValid(value)) {
                setModelStore("model", name, { ...value })
              }
            }
          })
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const a = agent.current()
            if (!a) return
            if (options?.recent) {
              for (const ag of agent.list()) {
                // Only pin agents with an explicit override. Resolving via
                // modelFor() falls back to the shared fallback chain, which
                // would pin every unset agent to the same model (contamination).
                const explicit = modelStore.model[ag.name]
                if (explicit && isModelValid(explicit)) setModelStore("model", ag.name, { ...explicit })
              }
            }
            setModelStore("model", a.name, model)
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
              modelSelected(model)
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const a = agent.current()
            const m = currentModel()
            if (!a || !m) return undefined
            const agentKey = `${a.name}/${m.providerID}/${m.modelID}`
            const legacyKey = `${m.providerID}/${m.modelID}`
            return modelStore.variant[agentKey] ?? modelStore.variant[legacyKey]
          },
          current() {
            const a = agent.current()
            const m = currentModel()
            return a && m ? variantFor(a.name, m) : undefined
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((item) => item.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const a = agent.current()
            const m = currentModel()
            if (!a || !m) return
            this.setFor(a.name, m, value)
            modelSelected({ ...m, ...(value ? { variant: value } : {}) })
          },
          setFor(agentName: string, m: { providerID: string; modelID: string }, value: string | undefined) {
            const key = `${agentName}/${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value ?? "default")
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    }

    const model = createModel()

    selection = createSelectionState(
      createMemo(() => {
        const currentAgent = agent.current()
        return selectionSnapshot({
          sessionID: route.data.type === "session" ? route.data.sessionID : undefined,
          agent: currentAgent?.name,
          agents: agent.list(),
          model: model.forAgent,
          variant: model.variantFor,
        })
      }),
    )

    let syncedSessionID: string | undefined
    let syncedModels: string | undefined
    // F1 guard: agent.set from message history runs at most once per
    // session. After that, the user's manual choice (or plan↔build flow)
    // must win over any later message sync that touches the same session.
    let agentRestoredFor: string | undefined
    // Same once-per-session guard for model.restore. Restoring from message
    // history runs at most once per session so that a later sync refresh or
    // compaction — which can temporarily yield an empty/partial message list
    // — cannot wipe the user's explicit model picks.
    let modelsRestoredFor: string | undefined
    createEffect(() => {
      if (route.data.type !== "session") {
        // Leaving a session → home/draft scope. Overrides are kept so the
        // draft (and a session created from it) continues from the last picks.
        if (syncedSessionID !== undefined) model.unbindSession()
        syncedSessionID = undefined
        syncedModels = undefined
        agentRestoredFor = undefined
        modelsRestoredFor = undefined
        return
      }
      const sessionID = route.data.sessionID
      // Placeholder route (e.g. `--continue` starts on sessionID "dummy"
      // before the session list loads). Never bind or clear for it.
      if (!sessionID.startsWith("ses_")) return
      if (sessionID !== syncedSessionID) {
        syncedSessionID = sessionID
        syncedModels = undefined
        agentRestoredFor = undefined
        modelsRestoredFor = undefined
        // Reset overrides only when entering a session that was NOT already
        // bound by attachNewSession (home → brand-new session). Opening an
        // existing session or switching sessions discards the previous scope;
        // per-agent message history restores the session's own models below.
        if (model.scope() !== sessionID) model.bindExistingSession(sessionID)
      }
      const messages = sync.data.message[sessionID]
      if (!messages) return

      const primaryAgents = agent.list()
      const restored = Object.fromEntries(
        primaryAgents.flatMap((item) => {
          const message = messages.findLast((candidate) => candidate.role === "user" && candidate.agent === item.name)
          return message?.role === "user" && message.model ? [[item.name, message.model] as const] : []
        }),
      )
      const fingerprint = JSON.stringify(restored)
      if (fingerprint === syncedModels) return
      syncedModels = fingerprint
      // Only restore from messages once per session, and only when there is
      // something to restore. An empty `restored` means the sync briefly lost
      // the message list (refresh/reconnect) — restoring would clear all
      // overrides and fall back to the shared default. After the first
      // non-empty restore, the user's explicit picks win over message history.
      if (Object.keys(restored).length > 0 && modelsRestoredFor !== sessionID) {
        modelsRestoredFor = sessionID
        model.restore(sessionID, restored)
      }

      const message = messages.findLast((candidate) => candidate.role === "user")
      if (!message || message.role !== "user") return
      if (
        agentRestoredFor !== sessionID &&
        !args.agent &&
        primaryAgents.some((item) => item.name === message.agent)
      ) {
        agent.set(message.agent)
        agentRestoredFor = sessionID
      }
      const active = args.agent
        ? messages.findLast((candidate) => candidate.role === "user" && candidate.agent === args.agent)
        : message
      if (active?.role === "user" && active.model) {
        const variantAgent = active.agent ?? agent.current()?.name
        if (variantAgent) model.variant.setFor(variantAgent, active.model, active.model.variant)
      }
    })

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const slots = createMemo(() => {
        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
      session,
      selection,
      permission,
    }
    return result
  },
})
