/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Spinner, SpinnerFocusProvider } from "../../src/component/spinner"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>) {
  const deadline = Date.now() + 2000
  while (true) {
    await app.renderOnce()
    if (app.captureCharFrame().includes("Loading")) return
    if (Date.now() > deadline) throw new Error("timed out waiting for spinner frame")
    await Bun.sleep(10)
  }
}

test("pauses animated spinners while the terminal is unfocused", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <SpinnerFocusProvider>
                <Spinner>Loading</Spinner>
                <Spinner frames={["*"]} interval={40} fallback="[⋯]" />
              </SpinnerFocusProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 3 },
  )

  try {
    await waitForFrame(app)
    expect(app.captureCharFrame()).not.toContain("⋯ Loading")
    expect(app.captureCharFrame()).toContain("*")

    app.renderer.emit("blur")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("⋯ Loading")
    expect(app.captureCharFrame()).toContain("[⋯]")

    app.renderer.emit("focus")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("⋯ Loading")
    expect(app.captureCharFrame()).toContain("*")
  } finally {
    app.renderer.destroy()
  }
})
