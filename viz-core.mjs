// viz-core.mjs
//
// Functional core for the Agent Activity Visualizer.
//
// PURE: no Node, no DOM, no imports. This module is reused verbatim in three
// places — the node:test suite, the extension shell (extension.mjs), and the
// browser iframe (client.html, loaded as <script type="module">). Keeping it
// dependency-free is what lets the same animation math run in all three.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function clamp01(n) {
    if (Number.isNaN(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

// Base hue (HSL degrees) per activity. Distinct per activity so the palette
// shifts as the agent moves between phases.
const ACTIVITY_HUE = {
    idle: 205, // calm blue
    reasoning: 280, // violet
    tool: 150, // green
    streaming: 45, // amber
    speaking: 18, // warm orange
};

export function activityColor(activity) {
    const hue = ACTIVITY_HUE[activity];
    return typeof hue === "number" ? hue : ACTIVITY_HUE.idle;
}

export function initialState() {
    return {
        energy: 0,
        activity: "idle",
        toolName: null,
        beat: 0,
        hue: activityColor("idle"),
        lastEventAt: 0,
    };
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------
//
// Maps a raw session-event type to a visual "impulse". An impulse is a small
// kick to the energy field plus the activity it represents. Returning null
// means "ignore this event" — the visualizer simply keeps decaying.

const EVENT_IMPULSE = {
    // user kicked off a turn — strong jolt
    "user.message": { activity: "reasoning", boost: 0.5 },

    // assistant thinking
    "assistant.turn_start": { activity: "reasoning", boost: 0.35 },
    "assistant.intent": { activity: "reasoning", boost: 0.25 },
    "assistant.reasoning": { activity: "reasoning", boost: 0.3 },
    "assistant.reasoning_delta": { activity: "reasoning", boost: 0.14 },

    // assistant producing output
    "assistant.message_start": { activity: "streaming", boost: 0.22 },
    "assistant.streaming_delta": { activity: "streaming", boost: 0.12 },
    "assistant.message_delta": { activity: "streaming", boost: 0.12 },
    "assistant.message": { activity: "speaking", boost: 0.28 },

    // tool use — the busiest, brightest phase
    "tool.user_requested": { activity: "tool", boost: 0.35 },
    "tool.execution_start": { activity: "tool", boost: 0.55 },
    "tool.execution_progress": { activity: "tool", boost: 0.18 },
    "tool.execution_partial_result": { activity: "tool", boost: 0.18 },
    "tool.execution_complete": { activity: "tool", boost: 0.28 },

    // winding down
    "assistant.turn_end": { activity: "streaming", boost: 0.05 },
    "session.task_complete": { activity: "idle", boost: -0.5 },
    "session.idle": { activity: "idle", boost: -1 },
};

export function classifyEvent(type, data) {
    const base = EVENT_IMPULSE[type];
    if (!base) return null;
    const impulse = { activity: base.activity, boost: base.boost };
    if (base.activity === "tool") {
        impulse.toolName = (data && data.toolName) || null;
    }
    return impulse;
}

// ---------------------------------------------------------------------------
// State transitions (pure)
// ---------------------------------------------------------------------------

export function applyImpulse(state, impulse, nowMs) {
    const boost = typeof impulse.boost === "number" ? impulse.boost : 0;
    const activity = impulse.activity || state.activity;

    let toolName = null;
    if (activity === "tool") {
        toolName =
            impulse.toolName != null
                ? impulse.toolName
                : state.activity === "tool"
                  ? state.toolName
                  : null;
    }

    return {
        energy: clamp01(state.energy + boost),
        activity,
        toolName,
        beat: state.beat + 1,
        hue: activityColor(activity),
        lastEventAt: nowMs,
    };
}

// Exponential decay toward calm. lastEventAt is advanced to nowMs so repeated
// decay ticks compose correctly (each tick decays from the previous tick's
// time rather than re-decaying the whole span from the last *event*).
const ENERGY_HALF_LIFE_MS = 480;
const IDLE_ENERGY_THRESHOLD = 0.05;

export function decay(state, nowMs) {
    const elapsed = Math.max(0, nowMs - state.lastEventAt);
    const factor = Math.pow(0.5, elapsed / ENERGY_HALF_LIFE_MS);
    const energy = clamp01(state.energy * factor);

    const calmed = energy < IDLE_ENERGY_THRESHOLD;
    return {
        energy,
        activity: calmed ? "idle" : state.activity,
        toolName: calmed ? null : state.toolName,
        beat: state.beat,
        hue: calmed ? activityColor("idle") : state.hue,
        lastEventAt: nowMs,
    };
}

// ---------------------------------------------------------------------------
// Settings (pure normalization)
// ---------------------------------------------------------------------------
//
// User-tunable display options. normalizeSettings is the single validation gate
// shared by the shell (persisted to disk + POST /settings), the agent-callable
// `configure` action, and the iframe form — so every path clamps identically.

export const SETTINGS_BOUNDS = {
    barCount: { min: 8, max: 256, step: 1 },
    oscThickness: { min: 0.5, max: 8, step: 0.5 },
    saturation: { min: 0, max: 100, step: 1 },
};

const HUE_MODES = ["activity", "fixed"];

export function defaultSettings() {
    return {
        barCount: 64,
        showSpectrum: true,
        showOscilloscope: true,
        oscThickness: 1.5,
        hueMode: "activity",
        baseHue: 205,
        saturation: 90,
    };
}

function clampNumber(value, fallback, min, max) {
    const n = typeof value === "number" ? value : Number.NaN;
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

function wrapHue(value, fallback) {
    const n = typeof value === "number" ? value : Number.NaN;
    if (!Number.isFinite(n)) return fallback;
    return ((n % 360) + 360) % 360;
}

// Merge an arbitrary partial over the defaults, coercing/clamping every field
// and dropping anything unknown. Always returns a complete, valid settings
// object — never throws.
export function normalizeSettings(partial) {
    const d = defaultSettings();
    const p = partial && typeof partial === "object" ? partial : {};

    const bc = SETTINGS_BOUNDS.barCount;
    const ot = SETTINGS_BOUNDS.oscThickness;
    const sat = SETTINGS_BOUNDS.saturation;

    return {
        barCount: Math.round(clampNumber(p.barCount, d.barCount, bc.min, bc.max)),
        showSpectrum: typeof p.showSpectrum === "boolean" ? p.showSpectrum : d.showSpectrum,
        showOscilloscope:
            typeof p.showOscilloscope === "boolean" ? p.showOscilloscope : d.showOscilloscope,
        oscThickness: clampNumber(p.oscThickness, d.oscThickness, ot.min, ot.max),
        hueMode: HUE_MODES.includes(p.hueMode) ? p.hueMode : d.hueMode,
        baseHue: wrapHue(p.baseHue, d.baseHue),
        saturation: clampNumber(p.saturation, d.saturation, sat.min, sat.max),
    };
}

// Validate a single typed value (string or number) for a bounded numeric
// setting. Returns a finite, clamped, step-snapped number, or null when the key
// has no numeric bounds or the input is empty / non-numeric. Used by the iframe's
// typed entry boxes so typing enforces the same limits as the sliders.
export function coerceNumericSetting(key, raw) {
    const bounds = SETTINGS_BOUNDS[key];
    if (!bounds) return null;

    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (raw === "" || (typeof raw === "string" && raw.trim() === "")) return null;
    if (!Number.isFinite(n)) return null;

    const clamped = Math.min(bounds.max, Math.max(bounds.min, n));
    const step = bounds.step || 1;
    const snapped = Math.round(clamped / step) * step;
    const bounded = Math.min(bounds.max, Math.max(bounds.min, snapped));
    return Number(bounded.toFixed(4));
}

// The base hue the renderer should use: the live activity hue, or a fixed hue
// the user pinned. Per-bar spread is applied on top of this in the renderer.
export function resolveBaseHue(settings, state) {
    if (settings && settings.hueMode === "fixed") return settings.baseHue;
    return state.hue;
}

// ---------------------------------------------------------------------------
// Hex color wheel (pure)
// ---------------------------------------------------------------------------
//
// A Winamp-style honeycomb color picker: a large hexagon tiled with small
// pointy-top hexagons. Hue is the angle around the center; saturation grows
// with the ring index (center = white, outer ring = fully saturated). The same
// geometry feeds the iframe's <canvas> picker and the unit tests.

// Axial hex distance from the origin (number of steps to the center cell).
function hexRing(q, r) {
    return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
}

// Build every cell within `rings` of center. Each cell carries its axial
// coordinate (q,r), its ring, a unit-cell pixel position (x,y) for layout, and
// the (hue, saturation) color it represents.
export function hexWheelCells(rings = 5) {
    const R = Math.max(0, Math.round(rings));
    const cells = [];
    for (let q = -R; q <= R; q++) {
        const rMin = Math.max(-R, -q - R);
        const rMax = Math.min(R, -q + R);
        for (let r = rMin; r <= rMax; r++) {
            const ring = hexRing(q, r);
            // pointy-top axial → pixel, in units where the cell radius is 1.
            const x = Math.sqrt(3) * (q + r / 2);
            const y = 1.5 * r;
            const saturation = R === 0 ? 0 : Math.round((ring / R) * 100);
            const hue =
                ring === 0
                    ? 0
                    : Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360) % 360;
            cells.push({ q, r, ring, x, y, hue, saturation });
        }
    }
    return cells;
}

// (hue, saturation) → a point on the unit color disc. Radius is saturation/100,
// angle is the hue. The inverse direction used by nearestCell.
export function colorToWheel(hue, saturation) {
    const deg = (((typeof hue === "number" ? hue : 0) % 360) + 360) % 360;
    const a = (deg * Math.PI) / 180;
    const rad = clamp01((typeof saturation === "number" ? saturation : 0) / 100);
    return { x: rad * Math.cos(a), y: rad * Math.sin(a) };
}

// The wheel cell whose color is closest to (hue, saturation). Distance is
// measured on the unit disc so zero-saturation always lands on the center.
export function nearestCell(cells, hue, saturation) {
    const target = colorToWheel(hue, saturation);
    let best = null;
    let bestD = Infinity;
    for (const c of cells) {
        const p = colorToWheel(c.hue, c.saturation);
        const dx = p.x - target.x;
        const dy = p.y - target.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
            bestD = d;
            best = c;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Color parsing (pure) — for the "Or Enter a Color" text field
// ---------------------------------------------------------------------------

const NAMED_COLORS = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    lime: "#00ff00",
    green: "#008000",
    blue: "#0000ff",
    yellow: "#ffff00",
    cyan: "#00ffff",
    aqua: "#00ffff",
    magenta: "#ff00ff",
    fuchsia: "#ff00ff",
    silver: "#c0c0c0",
    gray: "#808080",
    grey: "#808080",
    maroon: "#800000",
    olive: "#808000",
    teal: "#008080",
    navy: "#000080",
    purple: "#800080",
    orange: "#ffa500",
    pink: "#ffc0cb",
    brown: "#a52a2a",
    gold: "#ffd700",
    indigo: "#4b0082",
    violet: "#ee82ee",
    turquoise: "#40e0d0",
    coral: "#ff7f50",
    salmon: "#fa8072",
    crimson: "#dc143c",
};

export function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    let s = 0;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        if (max === rn) h = ((gn - bn) / d) % 6;
        else if (max === gn) h = (bn - rn) / d + 2;
        else h = (rn - gn) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function parseHexTriplet(hex) {
    let h = hex.replace(/^#/, "");
    if (h.length === 3) {
        h = h
            .split("")
            .map((c) => c + c)
            .join("");
    }
    if (h.length === 8) h = h.slice(0, 6); // ignore alpha
    if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

// Parse a CSS-ish color string into the visualizer's { baseHue, saturation }.
// Accepts #rgb / #rrggbb (with or without a leading #), rgb()/rgba(), and a
// small set of named colors. Returns null on anything it cannot understand.
export function parseColorInput(input) {
    if (typeof input !== "string") return null;
    let s = input.trim().toLowerCase();
    if (!s) return null;
    if (NAMED_COLORS[s]) s = NAMED_COLORS[s];

    let rgb = null;
    if (s.startsWith("#")) {
        rgb = parseHexTriplet(s);
    } else if (s.startsWith("rgb")) {
        const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
        if (m) rgb = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    } else if (/^[0-9a-f]{3}$|^[0-9a-f]{6}$/.test(s)) {
        rgb = parseHexTriplet(s);
    }

    if (!rgb) return null;
    if ([rgb.r, rgb.g, rgb.b].some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return null;

    const { h, s: sat } = rgbToHsl(rgb.r, rgb.g, rgb.b);
    return { baseHue: h, saturation: sat };
}

// ---------------------------------------------------------------------------
// Rendering math (pure, deterministic)
// ---------------------------------------------------------------------------
//
// computeBars turns a VizState + a time sample into spectrum-analyzer bar
// heights in [0,1]. Deterministic in (state, timeMs, barCount): the iframe
// drives timeMs from the animation clock, so motion comes entirely from time.

const IDLE_FLOOR = 0.035; // gentle "breathing" so it never goes flat-dead

export function computeBars(state, timeMs, barCount = 64) {
    const energy = clamp01(state.energy);
    const t = timeMs / 1000;
    const speed = 2.0 + energy * 6.5; // busier => faster wobble
    const bars = new Array(barCount);

    for (let i = 0; i < barCount; i++) {
        const norm = barCount > 1 ? i / (barCount - 1) : 0;
        const bass = 1 - 0.55 * norm; // bass-heavy falloff toward the right

        const w1 = 0.5 + 0.5 * Math.sin(t * speed + i * 0.5);
        const w2 = 0.5 + 0.5 * Math.sin(t * speed * 0.37 + i * 0.27 + 1.7);
        const wob = 0.6 * w1 + 0.4 * w2; // combined 0..1 wobble

        const peak = energy * bass * (0.35 + 0.65 * wob);
        const idle = IDLE_FLOOR * (0.5 + 0.5 * Math.sin(t * 0.9 + i * 0.35));

        bars[i] = clamp01(Math.max(peak, idle));
    }
    return bars;
}
