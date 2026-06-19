import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceNumericSetting, SETTINGS_BOUNDS } from "../viz-core.mjs";

test("SETTINGS_BOUNDS carries a step for each numeric setting", () => {
    assert.equal(SETTINGS_BOUNDS.barCount.step, 1);
    assert.equal(SETTINGS_BOUNDS.oscThickness.step, 0.5);
});

test("coerceNumericSetting parses plain numeric strings", () => {
    assert.equal(coerceNumericSetting("barCount", "16"), 16);
    assert.equal(coerceNumericSetting("oscThickness", "2"), 2);
});

test("coerceNumericSetting accepts a number directly", () => {
    assert.equal(coerceNumericSetting("barCount", 100), 100);
    assert.equal(coerceNumericSetting("oscThickness", 3.5), 3.5);
});

test("coerceNumericSetting trims surrounding whitespace", () => {
    assert.equal(coerceNumericSetting("barCount", "  32 "), 32);
});

test("coerceNumericSetting clamps barCount to [8,256]", () => {
    assert.equal(coerceNumericSetting("barCount", "7"), 8);
    assert.equal(coerceNumericSetting("barCount", "0"), 8);
    assert.equal(coerceNumericSetting("barCount", "300"), 256);
    assert.equal(coerceNumericSetting("barCount", "8"), 8);
    assert.equal(coerceNumericSetting("barCount", "256"), 256);
});

test("coerceNumericSetting rounds barCount to an integer", () => {
    assert.equal(coerceNumericSetting("barCount", "40.7"), 41);
    assert.equal(coerceNumericSetting("barCount", "63.2"), 63);
});

test("coerceNumericSetting clamps oscThickness to [0.5,8]", () => {
    assert.equal(coerceNumericSetting("oscThickness", "0.2"), 0.5);
    assert.equal(coerceNumericSetting("oscThickness", "0"), 0.5);
    assert.equal(coerceNumericSetting("oscThickness", "10"), 8);
    assert.equal(coerceNumericSetting("oscThickness", "0.5"), 0.5);
    assert.equal(coerceNumericSetting("oscThickness", "8"), 8);
});

test("coerceNumericSetting snaps oscThickness to the 0.5 step", () => {
    assert.equal(coerceNumericSetting("oscThickness", "1.7"), 1.5);
    assert.equal(coerceNumericSetting("oscThickness", "2.2"), 2);
    assert.equal(coerceNumericSetting("oscThickness", "3.9"), 4);
});

test("coerceNumericSetting returns null for non-numeric input", () => {
    assert.equal(coerceNumericSetting("barCount", "abc"), null);
    assert.equal(coerceNumericSetting("barCount", ""), null);
    assert.equal(coerceNumericSetting("barCount", "   "), null);
    assert.equal(coerceNumericSetting("oscThickness", "NaN"), null);
    assert.equal(coerceNumericSetting("barCount", null), null);
    assert.equal(coerceNumericSetting("barCount", undefined), null);
    assert.equal(coerceNumericSetting("oscThickness", Infinity), null);
});

test("coerceNumericSetting returns null for keys without numeric bounds", () => {
    assert.equal(coerceNumericSetting("hueMode", "5"), null);
    assert.equal(coerceNumericSetting("nope", "5"), null);
});
