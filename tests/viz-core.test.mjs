import { test } from "node:test";
import assert from "node:assert/strict";

import {
    initialState,
    classifyEvent,
    applyImpulse,
    decay,
    computeBars,
    activityColor,
    clamp01,
} from "../viz-core.mjs";

test("clamp01 keeps values within [0,1]", () => {
    assert.equal(clamp01(-5), 0);
    assert.equal(clamp01(0.5), 0.5);
    assert.equal(clamp01(5), 1);
});

test("initialState is calm and idle", () => {
    const s = initialState();
    assert.equal(s.energy, 0);
    assert.equal(s.activity, "idle");
    assert.equal(s.beat, 0);
    assert.equal(s.toolName, null);
    assert.equal(typeof s.hue, "number");
});

test("classifyEvent maps reasoning events to a reasoning impulse with positive boost", () => {
    const imp = classifyEvent("assistant.reasoning_delta", {});
    assert.equal(imp.activity, "reasoning");
    assert.ok(imp.boost > 0);
});

test("classifyEvent maps tool start to a tool impulse carrying the tool name", () => {
    const imp = classifyEvent("tool.execution_start", { toolName: "grep" });
    assert.equal(imp.activity, "tool");
    assert.equal(imp.toolName, "grep");
    assert.ok(imp.boost > 0);
});

test("classifyEvent maps streaming output to a streaming impulse", () => {
    const imp = classifyEvent("assistant.streaming_delta", {});
    assert.equal(imp.activity, "streaming");
    assert.ok(imp.boost > 0);
});

test("classifyEvent treats idle/task_complete as a calming (non-positive) impulse", () => {
    const idle = classifyEvent("session.idle", {});
    assert.equal(idle.activity, "idle");
    assert.ok(idle.boost <= 0);
    const done = classifyEvent("session.task_complete", {});
    assert.equal(done.activity, "idle");
    assert.ok(done.boost <= 0);
});

test("classifyEvent returns null for events we do not visualize", () => {
    assert.equal(classifyEvent("session.usage_info", {}), null);
    assert.equal(classifyEvent("totally.unknown", {}), null);
});

test("applyImpulse raises energy, sets activity, and advances the beat", () => {
    const s0 = initialState();
    const s1 = applyImpulse(s0, { activity: "tool", boost: 0.4, toolName: "edit" }, 1000);
    assert.ok(s1.energy > s0.energy);
    assert.equal(s1.activity, "tool");
    assert.equal(s1.toolName, "edit");
    assert.equal(s1.beat, s0.beat + 1);
    assert.equal(s1.lastEventAt, 1000);
});

test("applyImpulse is pure - it does not mutate the input state", () => {
    const s0 = initialState();
    applyImpulse(s0, { activity: "reasoning", boost: 0.5 }, 10);
    assert.equal(s0.energy, 0);
    assert.equal(s0.beat, 0);
});

test("applyImpulse clamps energy to a maximum of 1", () => {
    let s = initialState();
    for (let i = 0; i < 50; i++) {
        s = applyImpulse(s, { activity: "tool", boost: 0.9 }, i);
    }
    assert.ok(s.energy <= 1);
    assert.ok(s.energy > 0.9);
});

test("applyImpulse never drives energy below 0 on a calming impulse", () => {
    const s0 = initialState();
    const s1 = applyImpulse(s0, { activity: "idle", boost: -0.5 }, 5);
    assert.ok(s1.energy >= 0);
});

test("decay reduces energy as time passes", () => {
    const charged = applyImpulse(initialState(), { activity: "tool", boost: 1 }, 0);
    const later = decay(charged, 1000);
    assert.ok(later.energy < charged.energy);
    assert.ok(later.energy >= 0);
});

test("decay with no elapsed time leaves energy essentially unchanged", () => {
    const charged = applyImpulse(initialState(), { activity: "tool", boost: 0.8 }, 500);
    const same = decay(charged, 500);
    assert.ok(Math.abs(same.energy - charged.energy) < 1e-9);
});

test("decay eventually returns to idle and clears the tool name", () => {
    const charged = applyImpulse(initialState(), { activity: "tool", boost: 1, toolName: "grep" }, 0);
    const calmed = decay(charged, 60_000);
    assert.equal(calmed.activity, "idle");
    assert.equal(calmed.toolName, null);
    assert.ok(calmed.energy < 0.05);
});

test("computeBars returns a deterministic array of the requested length", () => {
    const s = applyImpulse(initialState(), { activity: "streaming", boost: 0.7 }, 0);
    const a = computeBars(s, 123, 48);
    const b = computeBars(s, 123, 48);
    assert.equal(a.length, 48);
    assert.deepEqual(a, b);
});

test("computeBars values always stay within [0,1]", () => {
    const s = applyImpulse(initialState(), { activity: "tool", boost: 1 }, 0);
    for (const t of [0, 50, 250, 1000, 5000, 99999]) {
        for (const v of computeBars(s, t, 64)) {
            assert.ok(v >= 0 && v <= 1, `bar ${v} out of range at t=${t}`);
        }
    }
});

test("computeBars produces taller bars on average when energy is high", () => {
    const calm = { ...initialState(), energy: 0.1 };
    const busy = { ...initialState(), energy: 0.95 };
    const avg = (state) => {
        const samples = [0, 200, 400, 600, 800, 1000];
        let sum = 0;
        let n = 0;
        for (const t of samples) {
            for (const v of computeBars(state, t, 64)) {
                sum += v;
                n += 1;
            }
        }
        return sum / n;
    };
    assert.ok(avg(busy) > avg(calm));
});

test("activityColor gives distinct hues per activity", () => {
    const reasoning = activityColor("reasoning");
    const tool = activityColor("tool");
    const idle = activityColor("idle");
    assert.equal(typeof reasoning, "number");
    assert.notEqual(reasoning, tool);
    assert.notEqual(tool, idle);
});
