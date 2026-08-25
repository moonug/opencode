import { createSignal, onCleanup, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { createSimpleContext } from "../context/helper"
import type { JSX } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { ColorGenerator } from "opentui-spinner"
import { registerOpencodeSpinner } from "./register-spinner"

registerOpencodeSpinner()

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export const { use: useSpinnerFocus, provider: SpinnerFocusProvider } = createSimpleContext({
  name: "SpinnerFocus",
  init: () => {
    const renderer = useRenderer()
    const [focused, setFocused] = createSignal(true)
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)

    renderer.on("focus", onFocus)
    renderer.on("blur", onBlur)
    onCleanup(() => {
      renderer.off("focus", onFocus)
      renderer.off("blur", onBlur)
    })

    return { focused }
  },
})

export function Spinner(props: {
  children?: JSX.Element
  color?: RGBA | ColorGenerator
  frames?: string[]
  interval?: number
  fallback?: JSX.Element
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const focused = useSpinnerFocus().focused
  const color = () => props.color ?? theme.textMuted
  const fallbackColor = () => (props.color instanceof RGBA ? props.color : theme.textMuted)
  const fallback = () => props.fallback ?? <>⋯ {props.children}</>
  return (
    <Show
      when={kv.get("animations_enabled", true) && focused()}
      fallback={<text fg={fallbackColor()}>{fallback()}</text>}
    >
      <box flexDirection="row" gap={1}>
        <spinner
          frames={props.frames ?? SPINNER_FRAMES}
          interval={props.interval ?? 80}
          color={color() as unknown as string | RGBA}
        />
        <Show when={props.children}>
          <text fg={fallbackColor()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
