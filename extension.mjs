// Extension: agent-visualizer
//
// A Winamp / Windows Media Player-style audio visualizer that animates in
// response to LIVE agent activity — reasoning, tool calls, streaming output —
// instead of an audio signal.
//
// Architecture (functional core + imperative shell):
//   - viz-core.mjs  : pure animation math (classifyEvent/applyImpulse/decay/
//                     computeBars). No Node, no DOM. Unit-tested with node:test.
//                     Reused verbatim here AND inside the iframe.
//   - extension.mjs : THIS imperative shell. Subscribes to session events,
//                     folds them into a single VizState, and serves the iframe
//                     + the core module + a Server-Sent-Events stream per
//                     canvas instance.
//   - client.html   : the <canvas> renderer. Imports the SAME core, runs a
//                     60fps loop, locally decays energy between SSE syncs.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

import {
    initialState,
    classifyEvent,
    applyImpulse,
    decay,
    defaultSettings,
    normalizeSettings,
} from "./viz-core.mjs";

const CLIENT_HTML_URL = new URL("./client.html", import.meta.url);
const CORE_JS_URL = new URL("./viz-core.mjs", import.meta.url);
// User preferences are global to this extension and expected to survive reloads,
// so they live in the extension's own artifacts dir (not keyed by instanceId).
const ARTIFACTS_DIR_URL = new URL("./artifacts/", import.meta.url);
const SETTINGS_FILE_URL = new URL("./artifacts/settings.json", import.meta.url);

// ---------------------------------------------------------------------------
// Imperative shell state
// ---------------------------------------------------------------------------

// The single source of truth for the visualization. Session events fold into
// this; the decay tick relaxes it back toward calm between events. It is global
// because there is exactly one agent session driving every open instance.
let vizState = initialState();

// Display preferences (bar count, colors, oscilloscope, visibility). Global to
// the extension; loaded from disk on startup and persisted on every change.
let settings = defaultSettings();

// One loopback HTTP server per open canvas instance.
const servers = new Map(); // instanceId -> { server, url }
// Every connected SSE client across all instance servers. State is global, so
// we broadcast the same frame to all of them.
const sseClients = new Set(); // ServerResponse

async function loadSettings() {
    try {
        const raw = await readFile(SETTINGS_FILE_URL, "utf8");
        settings = normalizeSettings(JSON.parse(raw));
    } catch {
        // No file yet (or unreadable) -> keep defaults.
        settings = defaultSettings();
    }
}

async function persistSettings() {
    try {
        await mkdir(ARTIFACTS_DIR_URL, { recursive: true });
        await writeFile(SETTINGS_FILE_URL, JSON.stringify(settings, null, 2), "utf8");
    } catch (err) {
        session?.log?.(`Failed to persist visualizer settings: ${err.message}`, {
            level: "warn",
            ephemeral: true,
        });
    }
}

// Apply a partial settings patch through the pure normalizer, persist, and push
// the new settings to every open iframe. Shared by POST /settings and the
// agent-callable `configure` action.
async function applySettings(patch) {
    settings = normalizeSettings({ ...settings, ...(patch && typeof patch === "object" ? patch : {}) });
    await persistSettings();
    broadcastSettings();
    return settings;
}

function statePayload() {
    return {
        energy: vizState.energy,
        activity: vizState.activity,
        toolName: vizState.toolName,
        hue: vizState.hue,
        beat: vizState.beat,
    };
}

function broadcast() {
    if (sseClients.size === 0) return;
    const frame = `data: ${JSON.stringify(statePayload())}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(frame);
        } catch {
            sseClients.delete(res);
        }
    }
}

// Settings travel on a named SSE event so the iframe can tell them apart from
// the high-frequency state frames (which arrive as the default "message").
function settingsFrame() {
    return `event: settings\ndata: ${JSON.stringify(settings)}\n\n`;
}

function broadcastSettings() {
    if (sseClients.size === 0) return;
    const frame = settingsFrame();
    for (const res of sseClients) {
        try {
            res.write(frame);
        } catch {
            sseClients.delete(res);
        }
    }
}

function readBody(req, limitBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
            if (data.length > limitBytes) {
                reject(new Error("Request body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

// Fold one impulse into the global state and notify the iframes. Shared by the
// live event subscription, the agent-callable `pulse` action, and the iframe's
// manual /pulse buttons.
function pushImpulse(impulse) {
    vizState = applyImpulse(vizState, impulse, Date.now());
    broadcast();
    return statePayload();
}

// ---------------------------------------------------------------------------
// HTTP: iframe assets + SSE
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
        try {
            const html = await readFile(CLIENT_HTML_URL);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
        } catch (err) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(`Failed to load renderer: ${err.message}`);
        }
        return;
    }

    if (path === "/viz-core.mjs") {
        try {
            const js = await readFile(CORE_JS_URL);
            res.writeHead(200, {
                "Content-Type": "text/javascript; charset=utf-8",
                "Cache-Control": "no-cache",
            });
            res.end(js);
        } catch (err) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(`Failed to load core: ${err.message}`);
        }
        return;
    }

    if (path === "/state") {
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(statePayload()));
        return;
    }

    if (path === "/events") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.write(`retry: 2000\n\n`);
        res.write(settingsFrame());
        res.write(`data: ${JSON.stringify(statePayload())}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
    }

    if (path === "/settings" && req.method === "GET") {
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache",
        });
        res.end(JSON.stringify(settings));
        return;
    }

    if (path === "/settings" && req.method === "POST") {
        let patch = {};
        try {
            const body = await readBody(req);
            patch = body ? JSON.parse(body) : {};
        } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: `Invalid settings body: ${err.message}` }));
            return;
        }
        const next = await applySettings(patch);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(next));
        return;
    }

    // Manual kick from the iframe controls (demo / "make it dance" button).
    if (path === "/pulse" && req.method === "POST") {
        const activity = url.searchParams.get("activity") || vizState.activity;
        const boostParam = Number.parseFloat(url.searchParams.get("boost") ?? "");
        const boost = Number.isFinite(boostParam) ? Math.max(-1, Math.min(1, boostParam)) : 0.6;
        const impulse = { activity, boost };
        if (activity === "tool") impulse.toolName = url.searchParams.get("toolName") || null;
        const payload = pushImpulse(impulse);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
        return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
}

async function startServer() {
    const server = createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
            try {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(String(err && err.message ? err.message : err));
            } catch {
                /* response already sent */
            }
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

// ---------------------------------------------------------------------------
// Canvas + session wiring
// ---------------------------------------------------------------------------

const PULSE_ACTIVITIES = ["reasoning", "tool", "streaming", "speaking", "idle"];

await loadSettings();

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "agent-visualizer",
            displayName: "Agent Visualizer",
            description:
                "A media-player-style spectrum visualizer that pulses and glows while the agent reasons, runs tools, and streams output.",
            actions: [
                {
                    name: "pulse",
                    description:
                        "Manually drive the visualizer — raise or lower its energy and set the current activity. Useful for demos or reacting to custom milestones.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            activity: { type: "string", enum: PULSE_ACTIVITIES },
                            boost: { type: "number", minimum: -1, maximum: 1 },
                            toolName: { type: "string" },
                        },
                    },
                    handler: async (ctx) => {
                        const input = ctx.input || {};
                        const activity = input.activity || vizState.activity;
                        const boost = typeof input.boost === "number" ? input.boost : 0.6;
                        const impulse = { activity, boost };
                        if (activity === "tool") {
                            impulse.toolName = input.toolName || vizState.toolName || null;
                        }
                        return pushImpulse(impulse);
                    },
                },
                {
                    name: "reset",
                    description: "Calm the visualizer back to its idle resting state.",
                    handler: async () => {
                        vizState = { ...initialState(), lastEventAt: Date.now() };
                        broadcast();
                        return statePayload();
                    },
                },
                {
                    name: "configure",
                    description:
                        "Update the visualizer's appearance: bar count, show/hide the spectrum or oscilloscope, oscilloscope thickness, and color (hue mode, base hue, saturation). Partial updates are merged over the current settings.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            barCount: { type: "integer", minimum: 8, maximum: 256 },
                            showSpectrum: { type: "boolean" },
                            showOscilloscope: { type: "boolean" },
                            oscThickness: { type: "number", minimum: 0.5, maximum: 8 },
                            hueMode: { type: "string", enum: ["activity", "fixed"] },
                            baseHue: { type: "number", minimum: 0, maximum: 360 },
                            saturation: { type: "number", minimum: 0, maximum: 100 },
                        },
                    },
                    handler: async (ctx) => applySettings(ctx.input || {}),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer();
                    servers.set(ctx.instanceId, entry);
                    session.log("Agent Visualizer canvas opened", { ephemeral: true });
                }
                return { title: "Agent Visualizer", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});

// Live wiring: every session event is classified into a visual impulse; ignored
// events (classifyEvent -> null) simply let the energy keep decaying.
session.on((event) => {
    const impulse = classifyEvent(event.type, event.data);
    if (impulse) pushImpulse(impulse);
});

// Decay tick: relaxes energy toward calm between events and keeps SSE clients in
// sync so an idle agent fades out smoothly. The iframe interpolates at 60fps
// locally using the same decay function, so a modest server cadence is plenty.
const decayTimer = setInterval(() => {
    if (sseClients.size === 0) return;
    const next = decay(vizState, Date.now());
    const changed =
        next.energy !== vizState.energy ||
        next.activity !== vizState.activity ||
        next.toolName !== vizState.toolName;
    vizState = next;
    if (changed) broadcast();
}, 150);
decayTimer.unref?.();
