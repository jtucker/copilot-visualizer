import { test } from "node:test";
import assert from "node:assert/strict";

import {
    initialState,
    defaultSettings,
    normalizeSettings,
    resolveBaseHue,
} from "../viz-core.mjs";

test("defaultSettings returns sane, visible defaults", () => {
    const d = defaultSettings();
    assert.ok(d.barCount >= 8 && d.barCount <= 256);
    assert.equal(d.showSpectrum, true);
    assert.equal(d.showOscilloscope, true);
    assert.ok(d.oscThickness > 0);
    assert.equal(d.hueMode, "activity");
    assert.equal(typeof d.baseHue, "number");
    assert.equal(typeof d.saturation, "number");
});

test("defaultSettings returns a fresh object each call (no shared mutation)", () => {
    const a = defaultSettings();
    a.barCount = 999;
    assert.notEqual(defaultSettings().barCount, 999);
});

test("normalizeSettings fills missing fields from defaults", () => {
    const n = normalizeSettings({ barCount: 32 });
    const d = defaultSettings();
    assert.equal(n.barCount, 32);
    assert.equal(n.showSpectrum, d.showSpectrum);
    assert.equal(n.hueMode, d.hueMode);
    assert.equal(n.saturation, d.saturation);
});

test("normalizeSettings clamps barCount to [8,256] and rounds to an integer", () => {
    assert.equal(normalizeSettings({ barCount: 2 }).barCount, 8);
    assert.equal(normalizeSettings({ barCount: 9999 }).barCount, 256);
    assert.equal(normalizeSettings({ barCount: 40.7 }).barCount, 41);
});

test("normalizeSettings clamps oscThickness and saturation to range", () => {
    assert.equal(normalizeSettings({ oscThickness: 0 }).oscThickness, 0.5);
    assert.equal(normalizeSettings({ oscThickness: 100 }).oscThickness, 8);
    assert.equal(normalizeSettings({ saturation: -10 }).saturation, 0);
    assert.equal(normalizeSettings({ saturation: 999 }).saturation, 100);
});

test("normalizeSettings wraps baseHue into [0,360)", () => {
    assert.equal(normalizeSettings({ baseHue: 380 }).baseHue, 20);
    assert.equal(normalizeSettings({ baseHue: -10 }).baseHue, 350);
    assert.equal(normalizeSettings({ baseHue: 200 }).baseHue, 200);
});

test("normalizeSettings keeps booleans and drops unknown keys", () => {
    const n = normalizeSettings({ showSpectrum: false, showOscilloscope: false, bogus: 123 });
    assert.equal(n.showSpectrum, false);
    assert.equal(n.showOscilloscope, false);
    assert.equal("bogus" in n, false);
});

test("normalizeSettings rejects bad types and falls back to the default field", () => {
    const d = defaultSettings();
    assert.equal(normalizeSettings({ barCount: "lots" }).barCount, d.barCount);
    assert.equal(normalizeSettings({ showSpectrum: "yes" }).showSpectrum, d.showSpectrum);
    assert.equal(normalizeSettings({ hueMode: "rainbow" }).hueMode, d.hueMode);
    assert.equal(normalizeSettings({ hueMode: "fixed" }).hueMode, "fixed");
});

test("normalizeSettings tolerates non-object input", () => {
    assert.deepEqual(normalizeSettings(null), defaultSettings());
    assert.deepEqual(normalizeSettings(undefined), defaultSettings());
    assert.deepEqual(normalizeSettings("nope"), defaultSettings());
});

test("resolveBaseHue follows the live activity hue in activity mode", () => {
    const s = { ...initialState(), hue: 280 };
    assert.equal(resolveBaseHue(defaultSettings(), s), 280);
});

test("resolveBaseHue uses the fixed baseHue in fixed mode", () => {
    const settings = normalizeSettings({ hueMode: "fixed", baseHue: 120 });
    const s = { ...initialState(), hue: 280 };
    assert.equal(resolveBaseHue(settings, s), 120);
});
