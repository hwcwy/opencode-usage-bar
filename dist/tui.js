// @bun
// src/tui.tsx
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createRoot, For, Show } from "solid-js";
import { appendFileSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var LOG_PATH = join(homedir(), ".local", "share", "opencode", "usage-bar.log");
function log(line) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}
`);
  } catch {}
}
var PLUGIN_ID = "hwcwy.usage-bar";
var CONFIG_FILE = "usage-bar.jsonc";
var MEMORY_KEY = "usage-bar";
var PROVIDER_IDS = ["commandcode", "opencode-go"];
var PROVIDER_LABELS = {
  commandcode: "Command Code",
  "opencode-go": "OpenCode Go"
};
var PROVIDER_SHORT = {
  commandcode: "CC",
  "opencode-go": "GO"
};
var PROVIDER_ENV = {
  commandcode: "COMMANDCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY"
};
var DEFAULT_CONFIG = {
  refreshIntervalSeconds: 60,
  barWidth: 10,
  warnPercent: 70,
  errorPercent: 90,
  providers: {
    commandcode: { enabled: true },
    "opencode-go": { enabled: true }
  }
};
function configDir() {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}
function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0;index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) {
      if (char === `
`) {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        index++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      index++;
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
function loadConfig() {
  const path = join(configDir(), "opencode", CONFIG_FILE);
  try {
    const raw = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      providers: { ...DEFAULT_CONFIG.providers, ...raw.providers ?? {} }
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
function expandEnv(value) {
  const match = /^\{env:([A-Z0-9_]+)\}$/i.exec(value.trim());
  return match ? process.env[match[1]] ?? "" : value;
}
function resolveHome(path) {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}
function authPaths(explicit) {
  const paths = [];
  if (explicit)
    paths.push(resolveHome(explicit));
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  if (dataHome)
    paths.push(join(dataHome, "opencode", "auth.json"));
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    paths.push(join(process.env.LOCALAPPDATA, "opencode", "auth.json"));
  }
  paths.push(join(homedir(), ".local", "share", "opencode", "auth.json"));
  paths.push(join(homedir(), ".config", "opencode", "auth.json"));
  return paths;
}
function readCredential(id, config) {
  const provider = config.providers[id] ?? {};
  if (provider.apiKey) {
    const key = expandEnv(provider.apiKey);
    if (key.length > 0)
      return key;
  }
  for (const path of authPaths(provider.authPath)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      const entry = data?.[id];
      const key = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.key ?? entry.apiKey ?? entry.access : undefined;
      if (typeof key === "string" && key.length > 0)
        return key;
    } catch {}
  }
  const env = process.env[PROVIDER_ENV[id]];
  return env && env.length > 0 ? env : undefined;
}
async function getJson(url, key, signal) {
  const res = await fetch(url, {
    headers: key ? { accept: "application/json", authorization: `Bearer ${key}` } : { accept: "application/json" },
    signal
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`);
  return await res.json();
}
var clampPercent = (value) => Math.max(0, Math.min(100, value));
function toMillis(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1000000000000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0)
      return numeric < 1000000000000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return;
}
function limitWindow(limit, kind, label) {
  const entry = limit ?? {};
  const cap = Number(entry.cap);
  const used = Number(entry.used);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(used))
    return;
  return {
    kind,
    label,
    percent: clampPercent(used / cap * 100),
    resetsAt: toMillis(entry.resetAt)
  };
}
async function fetchCommandCode(key, signal) {
  const base = "https://api.commandcode.ai";
  const identity = await getJson(`${base}/alpha/whoami`, key, signal);
  const orgID = (identity?.org ?? {}).id;
  const scope = typeof orgID === "string" && orgID.length > 0 ? `orgId=${encodeURIComponent(orgID)}` : "";
  const credits = await getJson(`${base}/alpha/billing/credits${scope ? `?${scope}` : ""}`, key, signal);
  const windows = [];
  const limits = credits?.windowLimits ?? {};
  const rolling = limitWindow(limits.fiveHour, "rolling", "5h");
  const weekly = limitWindow(limits.weekly, "weekly", "week");
  if (rolling)
    windows.push(rolling);
  if (weekly)
    windows.push(weekly);
  let plan;
  const remaining = Number((credits?.credits ?? {}).monthlyCredits);
  try {
    const subscription = await getJson(`${base}/alpha/billing/subscriptions${scope ? `?${scope}` : ""}`, key, signal);
    const data = subscription?.data ?? {};
    if (typeof data.planId === "string" && data.planId.length > 0)
      plan = data.planId;
    const since = data.currentPeriodStart;
    const summaryURL = `${base}/alpha/usage/summary?` + (scope ? `${scope}&` : "") + `since=${encodeURIComponent(String(since ?? ""))}`;
    const summary = await getJson(summaryURL, key, signal);
    const spent = Number(summary?.totalCredits ?? summary?.totalCost);
    if (Number.isFinite(spent) && Number.isFinite(remaining) && spent + remaining > 0) {
      windows.push({
        kind: "monthly",
        label: "month",
        percent: clampPercent(spent / (spent + remaining) * 100),
        resetsAt: toMillis(data.currentPeriodEnd),
        note: `$${remaining.toFixed(2)} left`
      });
    }
  } catch {}
  return { id: "commandcode", windows, plan, fetchedAt: Date.now() };
}
async function fetchOpenCodeGo(key, signal) {
  const body = await getJson("https://opencode.ai/zen/go/v1/usage", key, signal);
  const usage = body?.usage ?? {};
  const windows = [];
  const push = (entry, kind, label) => {
    const record = entry ?? {};
    const percent = Number(record.percent);
    if (!Number.isFinite(percent))
      return;
    const status = typeof record.status === "string" && record.status !== "ok" ? record.status : undefined;
    windows.push({
      kind,
      label,
      percent: clampPercent(percent),
      resetsAt: toMillis(record.resetsAt),
      ...status ? { note: status } : {}
    });
  };
  push(usage.rolling, "rolling", "5h");
  push(usage.weekly, "weekly", "week");
  push(usage.monthly, "monthly", "month");
  return { id: "opencode-go", windows, fetchedAt: Date.now() };
}
function isProviderID(value) {
  return value === "commandcode" || value === "opencode-go";
}
function createUsage(context, config) {
  const [store, update] = context.storage.memory(MEMORY_KEY, { initial: { byID: {} } });
  const inflight = new Map;
  const controller = new AbortController;
  const enabled = (id) => (config.providers[id]?.enabled ?? true) !== false;
  const stale = (id, maxAgeMs) => {
    const current = store.byID[id];
    if (!current)
      return true;
    if (current.error)
      return true;
    return Date.now() - current.fetchedAt > maxAgeMs;
  };
  const refresh = async (id, force = false) => {
    const targets = id ? [id] : PROVIDER_IDS.filter(enabled);
    await Promise.all(targets.map(async (target) => {
      if (!enabled(target))
        return;
      if (!force && !stale(target, Math.max(5000, config.refreshIntervalSeconds * 1000 - 1000)))
        return;
      const running = inflight.get(target);
      if (running)
        return running;
      const run = (async () => {
        try {
          const key = readCredential(target, config);
          if (!key)
            throw new Error(`missing ${PROVIDER_ENV[target]}`);
          const next = target === "commandcode" ? await fetchCommandCode(key, controller.signal) : await fetchOpenCodeGo(key, controller.signal);
          update((draft) => {
            draft.byID[target] = next;
          });
          log(`fetch ${target}: windows=${next.windows.length} plan=${next.plan ?? "-"}`);
        } catch (error) {
          const previous = store.byID[target];
          update((draft) => {
            draft.byID[target] = {
              id: target,
              windows: previous?.windows ?? [],
              ...previous?.plan ? { plan: previous.plan } : {},
              error: error instanceof Error ? error.message : String(error),
              fetchedAt: Date.now()
            };
          });
          log(`fetch ${target} failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          inflight.delete(target);
        }
      })();
      inflight.set(target, run);
      return run;
    }));
  };
  const disposeEffect = createRoot((dispose) => {
    createEffect(() => {
      const providerID = context.ui.model.current()?.providerID;
      if (!isProviderID(providerID))
        return;
      if (stale(providerID, 5000))
        refresh(providerID);
    });
    return dispose;
  });
  const timer = setInterval(() => void refresh(), Math.max(15, config.refreshIntervalSeconds) * 1000);
  refresh();
  return {
    byID: () => store.byID,
    refresh,
    dispose: () => {
      clearInterval(timer);
      disposeEffect();
      controller.abort();
    }
  };
}
var BAR_FULL = "\u2588";
var BAR_EMPTY = "\u2591";
function renderBar(percent, width) {
  const size = Math.max(4, Math.min(40, Math.round(width)));
  const filled = Math.max(0, Math.min(size, Math.round(percent / 100 * size)));
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(size - filled);
}
function renderCountdown(resetsAt) {
  if (!resetsAt || !Number.isFinite(resetsAt))
    return "";
  const remaining = resetsAt - Date.now();
  if (remaining <= 0)
    return "now";
  const minutes = Math.floor(remaining / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const mins = minutes % 60;
  if (days > 0)
    return `${days}d ${hours}h`;
  if (hours > 0)
    return `${hours}h ${mins}m`;
  return `${mins}m`;
}
function themeValue(context, ...path) {
  let value = context.theme;
  for (const key of path)
    value = value?.[key];
  return value;
}
function neutralColor(context) {
  return themeValue(context, "text", "muted") ?? themeValue(context, "text", "base");
}
function toneColor(context, percent, config) {
  if (percent >= config.errorPercent) {
    return themeValue(context, "text", "feedback", "error", "base") ?? themeValue(context, "text", "feedback", "error") ?? themeValue(context, "text", "base");
  }
  if (percent >= config.warnPercent) {
    return themeValue(context, "text", "feedback", "warning", "base") ?? themeValue(context, "text", "feedback", "warning") ?? themeValue(context, "text", "base");
  }
  return neutralColor(context);
}
function FooterBar(props) {
  const context = usePlugin();
  const providerID = createMemo(() => {
    const selected = context.ui.model.current()?.providerID;
    return isProviderID(selected) ? selected : undefined;
  });
  const usage = createMemo(() => {
    const id = providerID();
    return id ? props.usage.byID()[id] : undefined;
  });
  const error = createMemo(() => usage()?.error);
  let renders = 0;
  createEffect(() => {
    const provider = providerID() ?? "-";
    const windows = usage()?.windows.length ?? 0;
    if (renders++ < 10)
      log(`footer render #${renders}: provider=${provider} windows=${windows} error=${error() ?? "-"}`);
  });
  return /* @__PURE__ */ jsxs(Show, {
    when: providerID(),
    children: [
      /* @__PURE__ */ jsx(Show, {
        when: usage()?.windows.length,
        children: /* @__PURE__ */ jsxs("text", {
          children: [
            /* @__PURE__ */ jsx("span", {
              fg: neutralColor(context),
              children: `${PROVIDER_SHORT[providerID()]} `
            }),
            /* @__PURE__ */ jsx(For, {
              each: usage()?.windows ?? [],
              children: (window, index) => /* @__PURE__ */ jsx("span", {
                fg: toneColor(context, window.percent, props.config),
                children: `${index() > 0 ? " \xB7 " : ""}${window.label} ${renderBar(window.percent, props.config.barWidth)} ${Math.round(window.percent)}%`
              })
            }),
            /* @__PURE__ */ jsx("span", {
              fg: neutralColor(context),
              children: renderCountdown(usage()?.windows[0]?.resetsAt) ? ` \xB7 ${renderCountdown(usage()?.windows[0]?.resetsAt)}` : ""
            })
          ]
        })
      }),
      /* @__PURE__ */ jsx(Show, {
        when: !usage()?.windows.length || error(),
        children: /* @__PURE__ */ jsx("text", {
          fg: toneColor(context, props.config.errorPercent, props.config),
          children: error() ? `${PROVIDER_SHORT[providerID()]} ${error()}` : `${PROVIDER_SHORT[providerID()]} loading...`
        })
      })
    ]
  });
}
function SidebarBlock(props) {
  const context = usePlugin();
  const rows = createMemo(() => PROVIDER_IDS.filter((id) => (props.config.providers[id]?.enabled ?? true) !== false).map((id) => ({
    id,
    label: props.config.providers[id]?.label ?? PROVIDER_LABELS[id],
    usage: props.usage.byID()[id]
  })));
  let renders = 0;
  createEffect(() => {
    const summary = rows().map((row) => `${row.id}:${row.usage?.windows.length ?? 0}${row.usage?.error ? `(${row.usage.error})` : ""}`).join(" ");
    if (renders++ < 10)
      log(`sidebar render #${renders}: ${summary}`);
  });
  return /* @__PURE__ */ jsxs("box", {
    flexDirection: "column",
    children: [
      /* @__PURE__ */ jsx("text", {
        fg: themeValue(context, "text", "base"),
        children: "Usage"
      }),
      /* @__PURE__ */ jsx(For, {
        each: rows(),
        children: (row) => /* @__PURE__ */ jsxs("box", {
          flexDirection: "column",
          children: [
            /* @__PURE__ */ jsx("text", {
              fg: themeValue(context, "text", "base"),
              children: `  ${row.label}${row.usage?.plan ? ` \xB7 ${row.usage.plan}` : ""}`
            }),
            /* @__PURE__ */ jsx(Show, {
              when: row.usage?.windows.length,
              children: /* @__PURE__ */ jsx(For, {
                each: row.usage?.windows ?? [],
                children: (window) => /* @__PURE__ */ jsxs("text", {
                  children: [
                    /* @__PURE__ */ jsx("span", {
                      fg: neutralColor(context),
                      children: `    ${window.label.padEnd(6)}`
                    }),
                    /* @__PURE__ */ jsx("span", {
                      fg: toneColor(context, window.percent, props.config),
                      children: `${renderBar(window.percent, props.config.barWidth)} ${String(Math.round(window.percent)).padStart(3)}%`
                    }),
                    /* @__PURE__ */ jsx("span", {
                      fg: neutralColor(context),
                      children: `  ${window.note ?? renderCountdown(window.resetsAt)}`
                    })
                  ]
                })
              })
            }),
            /* @__PURE__ */ jsx(Show, {
              when: !row.usage?.windows.length,
              children: /* @__PURE__ */ jsx("text", {
                fg: toneColor(context, props.config.errorPercent, props.config),
                children: `    ${row.usage?.error ?? "loading..."}`
              })
            })
          ]
        })
      })
    ]
  });
}
var tui_default = Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    try {
      log(`setup: app=${context.app.version} location=${context.location?.directory ?? "-"}`);
      const config = loadConfig();
      log(`setup: ${PROVIDER_IDS.map((id) => `${id}=${config.providers[id]?.enabled ?? true ? "on" : "off"}`).join(" ")} interval=${config.refreshIntervalSeconds}s barWidth=${config.barWidth}`);
      for (const id of PROVIDER_IDS) {
        const key = readCredential(id, config);
        log(`setup: credential ${id} ${key ? `found(len=${key.length})` : "MISSING"}`);
      }
      const usage = createUsage(context, config);
      const footer = context.ui.slot({
        append: "prompt.footer.status",
        render: () => /* @__PURE__ */ jsx(FooterBar, {
          usage,
          config
        })
      });
      log("setup: footer slot registered (prompt.footer.status)");
      const sidebar = context.ui.slot({
        append: "sidebar.content",
        render: () => /* @__PURE__ */ jsx(SidebarBlock, {
          usage,
          config
        })
      });
      log("setup: sidebar slot registered (sidebar.content)");
      context.keymap.layer(() => ({
        commands: [
          {
            id: `${PLUGIN_ID}.refresh`,
            title: "Refresh usage bar",
            group: "Usage",
            palette: true,
            slash: { name: "usage-bar" },
            run: async () => {
              await usage.refresh(undefined, true);
              context.ui.toast.show({ message: "Usage refreshed", variant: "success" });
            }
          }
        ]
      }));
      const offCredential = context.data.on("credential.updated", () => {
        usage.refresh(undefined, true);
      });
      usage.refresh(undefined, true).catch((error) => log(`setup: refresh failed ${String(error)}`));
      context.ui.toast.show({ message: "Usage bar loaded (CC + Go)", variant: "success" });
      log("setup: done");
      return () => {
        footer();
        sidebar();
        offCredential();
        usage.dispose();
      };
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      log(`setup FAILED: ${message}`);
      try {
        context.ui.toast.show({ message: `Usage bar failed: ${message.slice(0, 120)}`, variant: "error" });
      } catch {}
      return;
    }
  }
});
export {
  tui_default as default,
  fetchCommandCode,
  fetchOpenCodeGo,
  renderBar,
  renderCountdown
};
