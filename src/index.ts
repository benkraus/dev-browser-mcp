#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { serveRelay, type RelayServer } from "./relay.js";
import { getSnapshotScript } from "./snapshot/browser-script.js";

type RelayMode = "auto" | "start" | "connect";

type ServerInfoResponse = {
  wsEndpoint: string;
  mode?: string;
  extensionConnected?: boolean;
};

type ListPagesResponse = { pages: string[] };

type GetPageResponse = {
  wsEndpoint: string;
  name: string;
  targetId: string;
  url?: string;
};

type CdpCommand = {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
};

type CdpResponse = {
  id: number;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
};

type CdpEvent = {
  method: string;
  sessionId?: string;
  params?: unknown;
};

type CdpMessage = Partial<CdpCommand & CdpResponse & CdpEvent>;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readEnvString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function parseRelayMode(raw: string | undefined): RelayMode {
  if (!raw) return "auto";
  const v = raw.trim().toLowerCase();
  if (v === "auto" || v === "start" || v === "connect") return v;
  return "auto";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tryResolveWorktreeRoot(cwd: string): string {
  const fromEnv = process.env.DCT_WORKTREE_ROOT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });

  if (result.status === 0) {
    const out = (result.stdout ?? "").trim();
    if (out) return out;
  }

  return cwd;
}

function stablePageNameFromPath(rootPath: string): string {
  const base = path.basename(rootPath) || "workspace";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 24);

  const digest = createHash("sha256")
    .update(rootPath)
    .digest("hex")
    .slice(0, 8);

  const name = `oc-${slug || "workspace"}-${digest}`;
  return name.slice(0, 64);
}

function safeJsonStringify(value: unknown): string {
  if (typeof value === "string") return value;

  try {
    const json = JSON.stringify(value, null, 2);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

function toSafeFileSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

function isoTimestampForFilename(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function writePngToDefaultOutputDir(args: {
  base64Png: string;
  pageName: string;
}): Promise<string> {
  const dir = path.join(process.cwd(), ".opencode", "dev_browser");
  await mkdir(dir, { recursive: true });

  const fileName = `${toSafeFileSegment(args.pageName || "page")}-${isoTimestampForFilename()}.png`;
  const fullPath = path.join(dir, fileName);

  const buf = Buffer.from(args.base64Png, "base64");
  await writeFile(fullPath, buf);

  return fullPath;
}

class CdpClient {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;

  private pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  private eventHandlers = new Set<(event: CdpEvent) => void>();

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  setWsUrl(wsUrl: string) {
    if (this.wsUrl === wsUrl) return;
    this.wsUrl = wsUrl;
    this.close();
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const onOpen = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        resolve();
      };

      const onError = (event: Event) => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        const err = new Error(
          `CDP WebSocket error connecting to ${this.wsUrl}: ${String(event)}`
        );
        this.failAllPending(err);
        this.ws = null;
        reject(err);
      };

      const onClose = () => {
        const err = new Error(`CDP WebSocket closed: ${this.wsUrl}`);
        this.failAllPending(err);
        this.ws = null;
      };

      const onMessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(String(event.data)) as CdpMessage;
          this.handleMessage(msg);
        } catch (err) {
          console.error("[dev-browser-mcp] CDP parse error:", err);
        }
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      ws.addEventListener("message", onMessage);
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        console.error("[dev-browser-mcp] CDP close error:", err);
      }
    }
    this.ws = null;
  }

  onEvent(handler: (event: CdpEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  async send(
    method: string,
    params?: unknown,
    sessionId?: string
  ): Promise<any> {
    await this.connect();

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP not connected to ${this.wsUrl}`);
    }

    const id = this.nextId++;

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    const payload: CdpCommand = { id, method };
    if (params !== undefined) payload.params = params;
    if (sessionId) payload.sessionId = sessionId;

    ws.send(JSON.stringify(payload));

    return await resultPromise;
  }

  async waitForEvent(
    method: string,
    options: { sessionId?: string; timeoutMs: number }
  ): Promise<CdpEvent> {
    const { sessionId, timeoutMs } = options;

    return await new Promise<CdpEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for event ${method} (sessionId=${sessionId ?? "<none>"})`
          )
        );
      }, timeoutMs);

      const handler = (event: CdpEvent) => {
        if (event.method !== method) return;
        if (sessionId && event.sessionId !== sessionId) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(event);
      };

      const unsubscribe = this.onEvent(handler);
    });
  }

  private failAllPending(err: Error) {
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(msg: CdpMessage) {
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);

      if (msg.error && typeof (msg.error as any)?.message === "string") {
        pending.reject(new Error((msg.error as any).message));
        return;
      }

      pending.resolve(msg.result);
      return;
    }

    if (typeof msg.method === "string") {
      const event: CdpEvent = {
        method: msg.method,
        sessionId:
          typeof msg.sessionId === "string" ? msg.sessionId : undefined,
        params: msg.params,
      };

      for (const handler of this.eventHandlers) {
        try {
          handler(event);
        } catch (err) {
          console.error("[dev-browser-mcp] CDP event handler error:", err);
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const host = readEnvString("HOST", "127.0.0.1");
  const port = readEnvInt("PORT", 9222);
  const relayMode = parseRelayMode(process.env.RELAY_MODE);
  const serverUrl = `http://${host}:${port}`;

  const mcp = new McpServer({ name: "dev-browser-mcp", version: "0.2.0" });

  let relay: RelayServer | null = null;
  let relayOwned = false;

  const cdp = new CdpClient(`ws://${host}:${port}/cdp`);
  const targetSession = new Map<
    string,
    { sessionId: string; initialized: boolean }
  >();

  let lastPageName: string | null = null;
  const defaultPageName = stablePageNameFromPath(
    tryResolveWorktreeRoot(process.cwd())
  );

  async function probeRelay(
    timeoutMs = 600
  ): Promise<ServerInfoResponse | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const info = await fetchJson<ServerInfoResponse>(serverUrl, {
          signal: controller.signal,
        });
        if (!info || typeof info.wsEndpoint !== "string") return null;
        return info;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  async function ensureRelayAvailable(): Promise<void> {
    if (relayOwned) return;
    if (relay) return;

    if (relayMode === "connect") {
      const info = await probeRelay();
      if (!info) {
        throw new Error(
          `RELAY_MODE=connect but relay is not reachable at ${serverUrl}`
        );
      }
      cdp.setWsUrl(info.wsEndpoint);
      return;
    }

    if (relayMode === "auto") {
      const info = await probeRelay();
      if (info) {
        cdp.setWsUrl(info.wsEndpoint);
        return;
      }
    }

    try {
      relay = await serveRelay({ host, port });
      relayOwned = true;
      cdp.setWsUrl(relay.wsEndpoint);
    } catch (err: any) {
      if (relayMode === "auto" && err && err.code === "EADDRINUSE") {
        const info = await probeRelay(1200);
        if (info) {
          cdp.setWsUrl(info.wsEndpoint);
          relay = null;
          relayOwned = false;
          return;
        }
      }
      throw err;
    }
  }

  async function getRelayInfo(): Promise<ServerInfoResponse> {
    const info = await fetchJson<ServerInfoResponse>(serverUrl);
    cdp.setWsUrl(info.wsEndpoint);
    return info;
  }

  async function resolvePageName(name?: string): Promise<string> {
    const resolved = name ?? lastPageName ?? defaultPageName;
    if (!lastPageName) lastPageName = resolved;
    return resolved;
  }

  async function openOrGetNamedPage(name: string): Promise<GetPageResponse> {
    await ensureRelayAvailable();

    const pageInfo = await fetchJson<GetPageResponse>(`${serverUrl}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    lastPageName = name;
    return pageInfo;
  }

  async function getTargetSession(
    pageName?: string
  ): Promise<{ name: string; targetId: string; sessionId: string }> {
    const name = await resolvePageName(pageName);

    const pageInfo = await openOrGetNamedPage(name);
    const targetId = pageInfo.targetId;

    await ensureRelayAvailable();

    let entry = targetSession.get(targetId);
    if (!entry) {
      const attach = (await cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId?: string };

      if (!attach || typeof attach.sessionId !== "string") {
        throw new Error("Failed to attach to target: missing sessionId");
      }

      entry = { sessionId: attach.sessionId, initialized: false };
      targetSession.set(targetId, entry);
    }

    if (!entry.initialized) {
      await cdp.send("Runtime.enable", undefined, entry.sessionId);
      await cdp.send("Page.enable", undefined, entry.sessionId);
      await cdp.send("DOM.enable", undefined, entry.sessionId);
      entry.initialized = true;
    }

    return { name, targetId, sessionId: entry.sessionId };
  }

  async function runtimeEvaluate(
    sessionId: string,
    expression: string,
    options?: { awaitPromise?: boolean; returnByValue?: boolean }
  ): Promise<any> {
    const result = (await cdp.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: options?.awaitPromise ?? true,
        returnByValue: options?.returnByValue ?? true,
        userGesture: true,
      },
      sessionId
    )) as any;

    if (result?.exceptionDetails) {
      const text =
        result.exceptionDetails?.exception?.description ||
        result.exceptionDetails?.text ||
        "Runtime.evaluate exception";
      throw new Error(text);
    }

    return result;
  }

  async function evalValue(
    sessionId: string,
    expression: string
  ): Promise<any> {
    const res = await runtimeEvaluate(sessionId, expression, {
      awaitPromise: true,
      returnByValue: true,
    });
    return res?.result?.value;
  }

  async function ensureSnapshotInstalled(sessionId: string): Promise<void> {
    const installed = await evalValue(
      sessionId,
      `(() => typeof window.__devBrowser_getAISnapshot === 'function')()`
    );

    if (installed) return;

    const script = getSnapshotScript();
    await runtimeEvaluate(sessionId, script, {
      awaitPromise: false,
      returnByValue: false,
    });
  }

  async function waitForSelectorInTarget(
    sessionId: string,
    selector: string,
    state: "attached" | "detached" | "visible" | "hidden",
    timeoutMs: number
  ): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const ok = await evalValue(
        sessionId,
        `(() => {
          const sel = ${JSON.stringify(selector)};
          const el = document.querySelector(sel);

          const isVisible = (node) => {
            if (!node) return false;
            const style = window.getComputedStyle(node);
            if (!style) return true;
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          const st = ${JSON.stringify(state)};
          if (st === 'attached') return !!el;
          if (st === 'detached') return !el;
          if (st === 'visible') return !!el && isVisible(el);
          if (st === 'hidden') return !el || !isVisible(el);
          return false;
        })()`
      );

      if (ok) return;
      await sleep(150);
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for selector ${JSON.stringify(
        selector
      )} state=${state}`
    );
  }

  async function shutdown(exitCode: number): Promise<void> {
    try {
      cdp.close();
    } catch (err) {
      console.error("[dev-browser-mcp] CDP close error:", err);
    }

    if (relayOwned && relay) {
      try {
        await relay.stop();
      } catch (err) {
        console.error("[dev-browser-mcp] Error stopping relay:", err);
      }
    }

    process.exit(exitCode);
  }

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  mcp.registerTool(
    "dev_browser_relay_status",
    {
      description:
        "Get relay status (wsEndpoint, extensionConnected, mode). In RELAY_MODE=auto it will start or attach.",
      inputSchema: z.object({}),
    },
    async () => {
      await ensureRelayAvailable();
      const info = await getRelayInfo();
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        structuredContent: info,
      };
    }
  );

  mcp.registerTool(
    "dev_browser_ensure_extension_connected",
    {
      description: "Wait for extensionConnected=true (polls /).",
      inputSchema: z.object({
        timeoutMs: z.number().int().positive().default(30000),
        pollIntervalMs: z.number().int().positive().default(250),
      }),
    },
    async ({ timeoutMs, pollIntervalMs }) => {
      await ensureRelayAvailable();

      const start = Date.now();
      let last: ServerInfoResponse | null = null;

      while (Date.now() - start < timeoutMs) {
        last = await getRelayInfo();
        if (last.extensionConnected) {
          return {
            content: [{ type: "text", text: JSON.stringify(last, null, 2) }],
            structuredContent: last,
          };
        }
        await sleep(pollIntervalMs);
      }

      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for extension. Last: ${JSON.stringify(
          last
        )}`
      );
    }
  );

  mcp.registerTool(
    "dev_browser_pages_list",
    {
      description: "List named pages registered in the relay.",
      inputSchema: z.object({}),
    },
    async () => {
      await ensureRelayAvailable();
      const pages = await fetchJson<ListPagesResponse>(`${serverUrl}/pages`);
      return {
        content: [{ type: "text", text: JSON.stringify(pages, null, 2) }],
        structuredContent: pages,
      };
    }
  );

  mcp.registerTool(
    "dev_browser_page_open",
    {
      description:
        "Get or create a named tab via the relay and select it for subsequent actions.",
      inputSchema: z.object({ name: z.string().min(1) }),
    },
    async ({ name }) => {
      const pageInfo = await openOrGetNamedPage(name);
      return {
        content: [{ type: "text", text: JSON.stringify(pageInfo, null, 2) }],
        structuredContent: pageInfo,
      };
    }
  );

  mcp.registerTool(
    "dev_browser_page_delete_mapping",
    {
      description: "Delete a named page mapping in the relay.",
      inputSchema: z.object({ name: z.string().min(1) }),
    },
    async ({ name }) => {
      await ensureRelayAvailable();

      const res = await fetch(
        `${serverUrl}/pages/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
        }
      );

      const body = await res.text().catch(() => "");
      if (!res.ok) {
        throw new Error(
          `Failed to delete page mapping: HTTP ${res.status} ${res.statusText}: ${body}`
        );
      }

      if (lastPageName === name) lastPageName = null;

      return { content: [{ type: "text", text: body || "{}" }] };
    }
  );

  mcp.registerTool(
    "dev_browser_goto",
    {
      description: "Navigate the selected tab to a URL.",
      inputSchema: z.object({
        url: z.string().min(1),
        pageName: z.string().min(1).optional(),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle", "commit"])
          .optional(),
        timeoutMs: z.number().int().positive().default(30000),
      }),
    },
    async ({ url, pageName, waitUntil, timeoutMs }) => {
      const { sessionId } = await getTargetSession(pageName);

      await cdp.send("Page.navigate", { url }, sessionId);

      const until = waitUntil ?? "load";
      if (until === "domcontentloaded") {
        await cdp.waitForEvent("Page.domContentEventFired", {
          sessionId,
          timeoutMs,
        });
      } else if (until === "load" || until === "networkidle") {
        await cdp.waitForEvent("Page.loadEventFired", { sessionId, timeoutMs });
      }

      return { content: [{ type: "text", text: `OK: navigated to ${url}` }] };
    }
  );

  mcp.registerTool(
    "dev_browser_click",
    {
      description:
        "Click an element by CSS selector or snapshotRef (from dev_browser_snapshot).",
      inputSchema: z.object({
        pageName: z.string().min(1).optional(),
        selector: z.string().min(1).optional(),
        snapshotRef: z.string().min(1).optional(),
      }),
    },
    async ({ pageName, selector, snapshotRef }) => {
      const { sessionId } = await getTargetSession(pageName);

      const hasSelector = typeof selector === "string";
      const hasRef = typeof snapshotRef === "string";
      if (hasSelector === hasRef) {
        throw new Error("Pass exactly one of selector or snapshotRef");
      }

      if (selector) {
        await runtimeEvaluate(
          sessionId,
          `(() => {
            const sel = ${JSON.stringify(selector)};
            const el = document.querySelector(sel);
            if (!el) throw new Error('No element for selector: ' + sel);
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.click();
            return true;
          })()`
        );
        return { content: [{ type: "text", text: `OK: clicked ${selector}` }] };
      }

      await ensureSnapshotInstalled(sessionId);
      const ref = snapshotRef as string;

      await runtimeEvaluate(
        sessionId,
        `(() => {
          const refId = ${JSON.stringify(ref)};
          const el = window.__devBrowser_selectSnapshotRef(refId);
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.click();
          return true;
        })()`
      );

      return {
        content: [{ type: "text", text: `OK: clicked [ref=${ref}]` }],
      };
    }
  );

  mcp.registerTool(
    "dev_browser_type",
    {
      description:
        "Type into an input by CSS selector or snapshotRef (from dev_browser_snapshot).",
      inputSchema: z.object({
        pageName: z.string().min(1).optional(),
        text: z.string(),
        selector: z.string().min(1).optional(),
        snapshotRef: z.string().min(1).optional(),
        clearFirst: z.boolean().default(true),
      }),
    },
    async ({ pageName, text, selector, snapshotRef, clearFirst }) => {
      const { sessionId } = await getTargetSession(pageName);

      const hasSelector = typeof selector === "string";
      const hasRef = typeof snapshotRef === "string";
      if (hasSelector === hasRef) {
        throw new Error("Pass exactly one of selector or snapshotRef");
      }

      const value = text;

      if (selector) {
        await runtimeEvaluate(
          sessionId,
          `(() => {
            const sel = ${JSON.stringify(selector)};
            const el = document.querySelector(sel);
            if (!el) throw new Error('No element for selector: ' + sel);
            const input = el;
            if (input && typeof input.focus === 'function') input.focus();
            if (${JSON.stringify(clearFirst)}) {
              if ('value' in input) input.value = '';
            }
            if ('value' in input) input.value = (input.value || '') + ${JSON.stringify(value)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`
        );

        return {
          content: [{ type: "text", text: `OK: typed into ${selector}` }],
        };
      }

      await ensureSnapshotInstalled(sessionId);
      const ref = snapshotRef as string;

      await runtimeEvaluate(
        sessionId,
        `(() => {
          const refId = ${JSON.stringify(ref)};
          const el = window.__devBrowser_selectSnapshotRef(refId);
          const input = el;
          if (input && typeof input.focus === 'function') input.focus();
          if (${JSON.stringify(clearFirst)}) {
            if ('value' in input) input.value = '';
          }
          if ('value' in input) input.value = (input.value || '') + ${JSON.stringify(value)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`
      );

      return {
        content: [{ type: "text", text: `OK: typed into [ref=${ref}]` }],
      };
    }
  );

  mcp.registerTool(
    "dev_browser_wait_for_selector",
    {
      description: "Wait for a selector on the selected tab.",
      inputSchema: z.object({
        pageName: z.string().min(1).optional(),
        selector: z.string().min(1),
        timeoutMs: z.number().int().positive().default(10000),
        state: z
          .enum(["attached", "detached", "visible", "hidden"])
          .default("visible"),
      }),
    },
    async ({ pageName, selector, timeoutMs, state }) => {
      const { sessionId } = await getTargetSession(pageName);
      await waitForSelectorInTarget(sessionId, selector, state, timeoutMs);
      return {
        content: [
          {
            type: "text",
            text: `OK: selector ${JSON.stringify(selector)} state=${state}`,
          },
        ],
      };
    }
  );

  mcp.registerTool(
    "dev_browser_evaluate",
    {
      description: "Evaluate JavaScript in the selected tab context.",
      inputSchema: z.object({
        pageName: z.string().min(1).optional(),
        code: z.string().min(1),
      }),
    },
    async ({ pageName, code }) => {
      const { sessionId } = await getTargetSession(pageName);

      const asExpression = `(() => (${code}))()`;
      const asStatements = `(() => {\n${code}\n})()`;

      const tryEvaluate = async (expression: string) => {
        const result = await runtimeEvaluate(sessionId, expression, {
          awaitPromise: true,
          returnByValue: true,
        });

        if (result?.result?.type === "undefined") {
          return "undefined";
        }

        if (result?.result?.value !== undefined) {
          return safeJsonStringify(result.result.value);
        }

        const fallback = await runtimeEvaluate(sessionId, expression, {
          awaitPromise: true,
          returnByValue: false,
        });

        if (typeof fallback?.result?.description === "string") {
          return fallback.result.description;
        }

        return safeJsonStringify(fallback?.result ?? fallback);
      };

      try {
        const text = await tryEvaluate(asExpression);
        return { content: [{ type: "text", text }] };
      } catch {
        const text = await tryEvaluate(asStatements);
        return { content: [{ type: "text", text }] };
      }
    }
  );

  mcp.registerTool(
    "dev_browser_screenshot",
    {
      description:
        "Take a PNG screenshot of the selected tab. Also writes the PNG to ./.opencode/dev_browser and returns the file path.",
      inputSchema: z.object({
        pageName: z.string().min(1).optional(),
        fullPage: z.boolean().default(false),
        saveToFile: z.boolean().default(true),
      }),
    },
    async ({ pageName, fullPage, saveToFile }) => {
      const { sessionId, name } = await getTargetSession(pageName);

      const res = (await cdp.send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: fullPage,
          fromSurface: true,
        },
        sessionId
      )) as { data?: string };

      if (!res || typeof res.data !== "string") {
        throw new Error("Screenshot failed: missing data");
      }

      const filePath = saveToFile
        ? await writePngToDefaultOutputDir({
            base64Png: res.data,
            pageName: name,
          })
        : null;

      const meta = {
        pageName: name,
        fullPage,
        filePath,
      };

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: "image/png" }
      > = [];

      if (filePath) {
        content.push({ type: "text", text: filePath });
      }

      content.push({ type: "image", data: res.data, mimeType: "image/png" });

      return {
        content,
        structuredContent: meta,
      };
    }
  );

  mcp.registerTool(
    "dev_browser_snapshot",
    {
      description:
        "Return an AI-friendly snapshot (YAML-ish) for the selected tab.",
      inputSchema: z.object({ pageName: z.string().min(1).optional() }),
    },
    async ({ pageName }) => {
      const { sessionId } = await getTargetSession(pageName);
      await ensureSnapshotInstalled(sessionId);

      const snapshot = await evalValue(
        sessionId,
        `(() => window.__devBrowser_getAISnapshot())()`
      );

      return { content: [{ type: "text", text: String(snapshot ?? "") }] };
    }
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  void ensureRelayAvailable().catch((err) => {
    console.error("[dev-browser-mcp] relay startup failed:", err);
  });

  console.error(
    `[dev-browser-mcp] running (stdio). relayMode=${relayMode} relay=${serverUrl}`
  );
}

main().catch((err) => {
  console.error("[dev-browser-mcp] Fatal error:", err);
  process.exit(1);
});
