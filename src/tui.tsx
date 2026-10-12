/**
 * Event-driven usage bar for OpenCode V2.
 *
 * Shows Command Code and OpenCode Go quota windows in the prompt footer and the
 * sidebar. Quota data is fetched from the providers' own APIs:
 *
 *  - Command Code: /alpha/whoami, /alpha/billing/credits, /alpha/billing/subscriptions
 *    and /alpha/usage/summary. The 5-hour and weekly windows are the provider's own
 *    rolling caps; the monthly window compares the current billing period's spend
 *    against remaining credits.
 *  - OpenCode Go: https://opencode.ai/zen/go/v1/usage (rolling / weekly / monthly).
 *
 * Unlike a plain poller, the plugin watches the prompt's selected model and fetches
 * that provider immediately when it changes, so switching providers updates the bar
 * without waiting for the next interval. An interval refresh still runs in the
 * background for the other enabled providers.
 *
 * Credentials are read from OpenCode's auth files first (the same ones the CLI uses),
 * then from environment variables, then from explicit configuration.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createRoot, For, Show } from "solid-js"
import { appendFileSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_PATH = join(homedir(), ".local", "share", "opencode", "usage-bar.log")

function log(line: string) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics are best-effort
  }
}

const PLUGIN_ID = "hwcwy.usage-bar"
const CONFIG_FILE = "usage-bar.jsonc"
const MEMORY_KEY = "usage-bar"

const PROVIDER_IDS = ["commandcode", "opencode-go"] as const
type ProviderID = (typeof PROVIDER_IDS)[number]

const PROVIDER_LABELS: Record<ProviderID, string> = {
  commandcode: "Command Code",
  "opencode-go": "OpenCode Go",
}
const PROVIDER_SHORT: Record<ProviderID, string> = {
  commandcode: "CC",
  "opencode-go": "GO",
}
const PROVIDER_ENV: Record<ProviderID, string> = {
  commandcode: "COMMANDCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
}

type WindowKind = "rolling" | "weekly" | "monthly"

interface UsageWindow {
  kind: WindowKind
  label: string
  percent: number
  resetsAt?: number
  note?: string
}

interface ProviderUsage {
  id: ProviderID
  windows: UsageWindow[]
  plan?: string
  error?: string
  fetchedAt: number
}

interface ProviderConfig {
  enabled?: boolean
  label?: string
  apiKey?: string
  authPath?: string
}

interface Config {
  refreshIntervalSeconds: number
  barWidth: number
  warnPercent: number
  errorPercent: number
  providers: Partial<Record<ProviderID, ProviderConfig>>
}

const DEFAULT_CONFIG: Config = {
  refreshIntervalSeconds: 60,
  barWidth: 10,
  warnPercent: 70,
  errorPercent: 90,
  providers: {
    commandcode: { enabled: true },
    "opencode-go": { enabled: true },
  },
}

function configDir(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
}

/** Minimal JSONC support: comments and trailing commas. */
function stripJsonc(text: string): string {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]
    if (inLine) {
      if (char === "\n") {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false
        index++
      }
      continue
    }
    if (inString) {
      out += char
      if (char === "\\") {
        out += next ?? ""
        index++
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === "/" && next === "/") {
      inLine = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      inBlock = true
      index++
      continue
    }
    out += char
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function loadConfig(): Config {
  const path = join(configDir(), "opencode", CONFIG_FILE)
  try {
    const raw = JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as Partial<Config>
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      providers: { ...DEFAULT_CONFIG.providers, ...(raw.providers ?? {}) },
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

function expandEnv(value: string): string {
  const match = /^\{env:([A-Z0-9_]+)\}$/i.exec(value.trim())
  return match ? (process.env[match[1]] ?? "") : value
}

function resolveHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path
}

/** OpenCode auth files, in the order the CLI itself uses on this platform. */
function authPaths(explicit?: string): string[] {
  const paths: string[] = []
  if (explicit) paths.push(resolveHome(explicit))
  const dataHome = process.env.XDG_DATA_HOME?.trim()
  if (dataHome) paths.push(join(dataHome, "opencode", "auth.json"))
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    paths.push(join(process.env.LOCALAPPDATA, "opencode", "auth.json"))
  }
  paths.push(join(homedir(), ".local", "share", "opencode", "auth.json"))
  paths.push(join(homedir(), ".config", "opencode", "auth.json"))
  return paths
}

function readCredential(id: ProviderID, config: Config): string | undefined {
  const provider = config.providers[id] ?? {}
  if (provider.apiKey) {
    const key = expandEnv(provider.apiKey)
    if (key.length > 0) return key
  }
  for (const path of authPaths(provider.authPath)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      const entry = data?.[id]
      const key =
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object"
            ? ((entry as Record<string, unknown>).key ??
              (entry as Record<string, unknown>).apiKey ??
              (entry as Record<string, unknown>).access)
            : undefined
      if (typeof key === "string" && key.length > 0) return key
    } catch {
      // try the next auth file
    }
  }
  const env = process.env[PROVIDER_ENV[id]]
  return env && env.length > 0 ? env : undefined
}

async function getJson(url: string, key: string | undefined, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    headers: key
      ? { accept: "application/json", authorization: `Bearer ${key}` }
      : { accept: "application/json" },
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value))

function toMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function limitWindow(limit: unknown, kind: WindowKind, label: string): UsageWindow | undefined {
  const entry = (limit ?? {}) as Record<string, unknown>
  const cap = Number(entry.cap)
  const used = Number(entry.used)
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(used)) return undefined
  return {
    kind,
    label,
    percent: clampPercent((used / cap) * 100),
    resetsAt: toMillis(entry.resetAt),
  }
}

export async function fetchCommandCode(key: string, signal: AbortSignal): Promise<ProviderUsage> {
  const base = "https://api.commandcode.ai"
  const identity = await getJson(`${base}/alpha/whoami`, key, signal)
  const orgID = (identity?.org ?? {}).id
  const scope = typeof orgID === "string" && orgID.length > 0 ? `orgId=${encodeURIComponent(orgID)}` : ""

  const credits = await getJson(`${base}/alpha/billing/credits${scope ? `?${scope}` : ""}`, key, signal)
  const windows: UsageWindow[] = []
  const limits = (credits?.windowLimits ?? {}) as Record<string, unknown>
  const rolling = limitWindow(limits.fiveHour, "rolling", "5h")
  const weekly = limitWindow(limits.weekly, "weekly", "week")
  if (rolling) windows.push(rolling)
  if (weekly) windows.push(weekly)

  let plan: string | undefined
  const remaining = Number((credits?.credits ?? {}).monthlyCredits)
  try {
    const subscription = await getJson(
      `${base}/alpha/billing/subscriptions${scope ? `?${scope}` : ""}`,
      key,
      signal,
    )
    const data = subscription?.data ?? {}
    if (typeof data.planId === "string" && data.planId.length > 0) plan = data.planId
    const since = data.currentPeriodStart
    const summaryURL =
      `${base}/alpha/usage/summary?` +
      (scope ? `${scope}&` : "") +
      `since=${encodeURIComponent(String(since ?? ""))}`
    const summary = await getJson(summaryURL, key, signal)
    const spent = Number(summary?.totalCredits ?? summary?.totalCost)
    if (Number.isFinite(spent) && Number.isFinite(remaining) && spent + remaining > 0) {
      windows.push({
        kind: "monthly",
        label: "month",
        percent: clampPercent((spent / (spent + remaining)) * 100),
        resetsAt: toMillis(data.currentPeriodEnd),
        note: `$${remaining.toFixed(2)} left`,
      })
    }
  } catch {
    // subscription/summary are optional; the rolling windows above still render
  }

  return { id: "commandcode", windows, plan, fetchedAt: Date.now() }
}

export async function fetchOpenCodeGo(key: string, signal: AbortSignal): Promise<ProviderUsage> {
  const body = await getJson("https://opencode.ai/zen/go/v1/usage", key, signal)
  const usage = (body?.usage ?? {}) as Record<string, unknown>
  const windows: UsageWindow[] = []
  const push = (entry: unknown, kind: WindowKind, label: string) => {
    const record = (entry ?? {}) as Record<string, unknown>
    const percent = Number(record.percent)
    if (!Number.isFinite(percent)) return
    const status = typeof record.status === "string" && record.status !== "ok" ? record.status : undefined
    windows.push({
      kind,
      label,
      percent: clampPercent(percent),
      resetsAt: toMillis(record.resetsAt),
      ...(status ? { note: status } : {}),
    })
  }
  push(usage.rolling, "rolling", "5h")
  push(usage.weekly, "weekly", "week")
  push(usage.monthly, "monthly", "month")
  return { id: "opencode-go", windows, fetchedAt: Date.now() }
}

function isProviderID(value: string | undefined): value is ProviderID {
  return value === "commandcode" || value === "opencode-go"
}

interface UsageState {
  byID: () => Record<string, ProviderUsage | undefined>
  refresh: (id?: ProviderID, force?: boolean) => Promise<void>
  dispose: () => void
}

function createUsage(context: Context, config: Config): UsageState {
  const [store, setStore] = context.storage.memory<{ byID: Record<string, ProviderUsage | undefined> }>(
    MEMORY_KEY,
    { initial: { byID: {} } },
  )
  const inflight = new Map<ProviderID, Promise<void>>()
  const controller = new AbortController()

  const enabled = (id: ProviderID) => (config.providers[id]?.enabled ?? true) !== false
  const stale = (id: ProviderID, maxAgeMs: number): boolean => {
    const current = store.byID[id]
    if (!current) return true
    if (current.error) return true
    return Date.now() - current.fetchedAt > maxAgeMs
  }

  const refresh = async (id?: ProviderID, force = false) => {
    const targets: ProviderID[] = id ? [id] : PROVIDER_IDS.filter(enabled)
    await Promise.all(
      targets.map(async (target) => {
        if (!enabled(target)) return
        if (!force && !stale(target, Math.max(5_000, config.refreshIntervalSeconds * 1_000 - 1_000))) return
        const running = inflight.get(target)
        if (running) return running
        const run = (async () => {
          try {
            const key = readCredential(target, config)
            if (!key) throw new Error(`missing ${PROVIDER_ENV[target]}`)
            const next =
              target === "commandcode"
                ? await fetchCommandCode(key, controller.signal)
                : await fetchOpenCodeGo(key, controller.signal)
            setStore("byID", target, next)
            log(`fetch ${target}: windows=${next.windows.length} plan=${next.plan ?? "-"}`)
          } catch (error) {
            const previous = store.byID[target]
            setStore("byID", target, {
              id: target,
              windows: previous?.windows ?? [],
              ...(previous?.plan ? { plan: previous.plan } : {}),
              error: error instanceof Error ? error.message : String(error),
              fetchedAt: Date.now(),
            } as ProviderUsage)
            log(`fetch ${target} failed: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            inflight.delete(target)
          }
        })()
        inflight.set(target, run)
        return run
      }),
    )
  }

  // Event-driven: the footer follows the prompt's model, so fetch that provider
  // immediately when the selection changes instead of waiting for the interval.
  const disposeEffect = createRoot((dispose) => {
    createEffect(() => {
      const providerID = context.ui.model.current()?.providerID
      if (!isProviderID(providerID)) return
      if (stale(providerID, 5_000)) void refresh(providerID)
    })
    return dispose
  })

  const timer = setInterval(
    () => void refresh(),
    Math.max(15, config.refreshIntervalSeconds) * 1_000,
  )
  void refresh()

  return {
    byID: () => store.byID,
    refresh,
    dispose: () => {
      clearInterval(timer)
      disposeEffect()
      controller.abort()
    },
  }
}

const BAR_FULL = "\u2588"
const BAR_EMPTY = "\u2591"

export function renderBar(percent: number, width: number): string {
  const size = Math.max(4, Math.min(40, Math.round(width)))
  const filled = Math.max(0, Math.min(size, Math.round((percent / 100) * size)))
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(size - filled)
}

export function renderCountdown(resetsAt: number | undefined): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return ""
  const remaining = resetsAt - Date.now()
  if (remaining <= 0) return "now"
  const minutes = Math.floor(remaining / 60_000)
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

type ThemeColor = unknown

function themeValue(context: Context, ...path: string[]): ThemeColor {
  let value: any = context.theme
  for (const key of path) value = value?.[key]
  return value
}

function neutralColor(context: Context): ThemeColor {
  return themeValue(context, "text", "muted") ?? themeValue(context, "text", "base")
}

function toneColor(context: Context, percent: number, config: Config): ThemeColor {
  if (percent >= config.errorPercent) {
    return (
      themeValue(context, "text", "feedback", "error", "base") ??
      themeValue(context, "text", "feedback", "error") ??
      themeValue(context, "text", "base")
    )
  }
  if (percent >= config.warnPercent) {
    return (
      themeValue(context, "text", "feedback", "warning", "base") ??
      themeValue(context, "text", "feedback", "warning") ??
      themeValue(context, "text", "base")
    )
  }
  return neutralColor(context)
}

function FooterBar(props: { usage: UsageState; config: Config }) {
  const context = usePlugin()
  const providerID = createMemo<ProviderID | undefined>(() => {
    const selected = context.ui.model.current()?.providerID
    return isProviderID(selected) ? selected : undefined
  })
  const usage = createMemo(() => {
    const id = providerID()
    return id ? props.usage.byID()[id] : undefined
  })
  const error = createMemo(() => usage()?.error)

  let renders = 0
  createEffect(() => {
    const provider = providerID() ?? "-"
    const windows = usage()?.windows.length ?? 0
    if (renders++ < 10) log(`footer render #${renders}: provider=${provider} windows=${windows} error=${error() ?? "-"}`)
  })

  return (
    <Show when={providerID()}>
      <Show when={usage()?.windows.length}>
        <text>
          <span fg={neutralColor(context)}>{`${PROVIDER_SHORT[providerID()!]} `}</span>
          <For each={usage()?.windows ?? []}>
            {(window, index) => (
              <span fg={toneColor(context, window.percent, props.config)}>
                {`${index() > 0 ? " \u00b7 " : ""}${window.label} ${renderBar(window.percent, props.config.barWidth)} ${Math.round(window.percent)}%`}
              </span>
            )}
          </For>
          <span fg={neutralColor(context)}>
            {renderCountdown(usage()?.windows[0]?.resetsAt)
              ? ` \u00b7 ${renderCountdown(usage()?.windows[0]?.resetsAt)}`
              : ""}
          </span>
        </text>
      </Show>
      <Show when={!usage()?.windows.length || error()}>
        <text fg={toneColor(context, props.config.errorPercent, props.config)}>
          {error() ? `${PROVIDER_SHORT[providerID()!]} ${error()}` : ""}
        </text>
      </Show>
    </Show>
  )
}

function SidebarBlock(props: { usage: UsageState; config: Config }) {
  const context = usePlugin()
  const rows = createMemo(() =>
    PROVIDER_IDS.filter((id) => (props.config.providers[id]?.enabled ?? true) !== false).map((id) => ({
      id,
      label: props.config.providers[id]?.label ?? PROVIDER_LABELS[id],
      usage: props.usage.byID()[id],
    })),
  )

  let renders = 0
  createEffect(() => {
    const summary = rows()
      .map((row) => `${row.id}:${row.usage?.windows.length ?? 0}${row.usage?.error ? `(${row.usage.error})` : ""}`)
      .join(" ")
    if (renders++ < 10) log(`sidebar render #${renders}: ${summary}`)
  })

  return (
    <box flexDirection="column">
      <text fg={themeValue(context, "text", "base")}>Usage</text>
      <For each={rows()}>
        {(row) => (
          <box flexDirection="column">
            <text fg={themeValue(context, "text", "base")}>
              {`  ${row.label}${row.usage?.plan ? ` \u00b7 ${row.usage.plan}` : ""}`}
            </text>
            <Show when={row.usage?.windows.length}>
              <For each={row.usage?.windows ?? []}>
                {(window) => (
                  <text>
                    <span fg={neutralColor(context)}>{`    ${window.label.padEnd(6)}`}</span>
                    <span fg={toneColor(context, window.percent, props.config)}>
                      {`${renderBar(window.percent, props.config.barWidth)} ${String(Math.round(window.percent)).padStart(3)}%`}
                    </span>
                    <span fg={neutralColor(context)}>
                      {`  ${window.note ?? renderCountdown(window.resetsAt)}`}
                    </span>
                  </text>
                )}
              </For>
            </Show>
            <Show when={!row.usage?.windows.length}>
              <text fg={toneColor(context, props.config.errorPercent, props.config)}>
                {`    ${row.usage?.error ?? "loading..."}`}
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context: Context) {
    try {
      log(`setup: app=${context.app.version} location=${context.location?.directory ?? "-"}`)
      const config = loadConfig()
      log(
        `setup: ${PROVIDER_IDS.map((id) => `${id}=${(config.providers[id]?.enabled ?? true) ? "on" : "off"}`).join(" ")} interval=${config.refreshIntervalSeconds}s barWidth=${config.barWidth}`,
      )
      for (const id of PROVIDER_IDS) {
        const key = readCredential(id, config)
        log(`setup: credential ${id} ${key ? `found(len=${key.length})` : "MISSING"}`)
      }
      const usage = createUsage(context, config)

      const footer = context.ui.slot({
        append: "prompt.footer.status",
        render: () => <FooterBar usage={usage} config={config} />,
      })
      log("setup: footer slot registered (prompt.footer.status)")
      const sidebar = context.ui.slot({
        append: "sidebar.content",
        render: () => <SidebarBlock usage={usage} config={config} />,
      })
      log("setup: sidebar slot registered (sidebar.content)")

      context.keymap.layer(() => ({
        commands: [
          {
            id: `${PLUGIN_ID}.refresh`,
            title: "Refresh usage bar",
            group: "Usage",
            palette: true,
            slash: { name: "usage-bar" },
            run: async () => {
              await usage.refresh(undefined, true)
              context.ui.toast.show({ message: "Usage refreshed", variant: "success" })
            },
          },
        ],
      }))

      const offCredential = context.data.on("credential.updated", () => {
        void usage.refresh(undefined, true)
      })

      void usage.refresh(undefined, true).catch((error) => log(`setup: refresh failed ${String(error)}`))
      context.ui.toast.show({ message: "Usage bar loaded (CC + Go)", variant: "success" })
      log("setup: done")

      return () => {
        footer()
        sidebar()
        offCredential()
        usage.dispose()
      }
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      log(`setup FAILED: ${message}`)
      try {
        context.ui.toast.show({ message: `Usage bar failed: ${message.slice(0, 120)}`, variant: "error" })
      } catch {
        // nothing else we can do
      }
      return
    }
  },
})
