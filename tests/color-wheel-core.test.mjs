import { test } from "node:test";
import assert from "node:assert/strict";

import {
    hexWheelCells,
    colorToWheel,
    nearestCell,
    rgbToHsl,
    parseColorInput,
} from "../viz-core.mjs";

// ---------------------------------------------------------------------------
// hexWheelCells — honeycomb layout + per-cell color
// ---------------------------------------------------------------------------

test("hexWheelCells returns 1 + 3R(R+1) cells for R rings", () => {
    assert.equal(hexWheelCells(0).length, 1);
    assert.equal(hexWheelCells(1).length, 7); // 1 + 3*1*2
    assert.equal(hexWheelCells(2).length, 19); // 1 + 3*2*3
    assert.equal(hexWheelCells(3).length, 37); // 1 + 3*3*4
});

test("hexWheelCells has exactly one center cell with zero saturation", () => {
    const cells = hexWheelCells(4);
    const centers = cells.filter((c) => c.ring === 0);
    assert.equal(centers.length, 1);
    assert.equal(centers[0].saturation, 0);
    assert.equal(centers[0].q, 0);
    assert.equal(centers[0].r, 0);
});

test("hexWheelCells keeps hues in [0,360) and saturations in [0,100]", () => {
    for (const c of hexWheelCells(5)) {
        assert.ok(c.hue >= 0 && c.hue < 360, `hue ${c.hue}`);
        assert.ok(c.saturation >= 0 && c.saturation <= 100, `sat ${c.saturation}`);
        assert.equal(typeof c.x, "number");
        assert.equal(typeof c.y, "number");
    }
});

test("hexWheelCells saturates the outer ring fully", () => {
    const cells = hexWheelCells(4);
    const outer = cells.filter((c) => c.ring === 4);
    assert.ok(outer.length > 0);
    for (const c of outer) assert.equal(c.saturation, 100);
});

test("hexWheelCells produces unique (q,r) coordinates", () => {
    const cells = hexWheelCells(3);
    const seen = new Set(cells.map((c) => `${c.q},${c.r}`));
    assert.equal(seen.size, cells.length);
});

// ---------------------------------------------------------------------------
// colorToWheel — (hue, saturation) → normalized point
// ---------------------------------------------------------------------------

test("colorToWheel maps zero saturation to the origin for any hue", () => {
    for (const hue of [0, 90, 200, 359]) {
        const p = colorToWheel(hue, 0);
        assert.ok(Math.abs(p.x) < 1e-9);
        assert.ok(Math.abs(p.y) < 1e-9);
    }
});

test("colorToWheel maps full saturation to the unit circle", () => {
    const a = colorToWheel(0, 100);
    assert.ok(Math.abs(a.x - 1) < 1e-9);
    assert.ok(Math.abs(a.y) < 1e-9);

    const b = colorToWheel(90, 100);
    assert.ok(Math.abs(b.x) < 1e-9);
    assert.ok(Math.abs(b.y - 1) < 1e-9);
});

// ---------------------------------------------------------------------------
// nearestCell — find the closest cell to a (hue, saturation)
// ---------------------------------------------------------------------------

test("nearestCell returns the center for any hue at zero saturation", () => {
    const cells = hexWheelCells(4);
    const got = nearestCell(cells, 137, 0);
    assert.equal(got.ring, 0);
    assert.equal(got.q, 0);
    assert.equal(got.r, 0);
});

test("nearestCell returns a cell's own coordinates for its exact color", () => {
    const cells = hexWheelCells(4);
    const corner = cells.find((c) => c.q === 4 && c.r === 0);
    const got = nearestCell(cells, corner.hue, corner.saturation);
    assert.equal(got.q, corner.q);
    assert.equal(got.r, corner.r);
});

// ---------------------------------------------------------------------------
// rgbToHsl
// ---------------------------------------------------------------------------

test("rgbToHsl converts primaries", () => {
    assert.deepEqual(rgbToHsl(255, 0, 0), { h: 0, s: 100, l: 50 });
    assert.deepEqual(rgbToHsl(0, 255, 0), { h: 120, s: 100, l: 50 });
    assert.deepEqual(rgbToHsl(0, 0, 255), { h: 240, s: 100, l: 50 });
});

test("rgbToHsl reports zero saturation for grayscale", () => {
    assert.equal(rgbToHsl(255, 255, 255).s, 0);
    assert.equal(rgbToHsl(128, 128, 128).s, 0);
    assert.equal(rgbToHsl(0, 0, 0).s, 0);
});

// ---------------------------------------------------------------------------
// parseColorInput
// ---------------------------------------------------------------------------

test("parseColorInput parses 6-digit hex", () => {
    assert.deepEqual(parseColorInput("#ff0000"), { baseHue: 0, saturation: 100 });
    assert.deepEqual(parseColorInput("#00ff00"), { baseHue: 120, saturation: 100 });
    assert.deepEqual(parseColorInput("#0000ff"), { baseHue: 240, saturation: 100 });
});

test("parseColorInput parses 3-digit hex and is case/space tolerant", () => {
    assert.deepEqual(parseColorInput("  #F00 "), { baseHue: 0, saturation: 100 });
    assert.deepEqual(parseColorInput("#FFF"), { baseHue: 0, saturation: 0 });
});

test("parseColorInput parses rgb() and named colors", () => {
    assert.deepEqual(parseColorInput("rgb(255, 0, 0)"), { baseHue: 0, saturation: 100 });
    assert.deepEqual(parseColorInput("red"), { baseHue: 0, saturation: 100 });
    assert.deepEqual(parseColorInput("LIME"), { baseHue: 120, saturation: 100 });
});

test("parseColorInput parses bare hex without a leading hash", () => {
    assert.deepEqual(parseColorInput("0000ff"), { baseHue: 240, saturation: 100 });
});

test("parseColorInput returns null for invalid input", () => {
    assert.equal(parseColorInput("garbage"), null);
    assert.equal(parseColorInput("#12"), null);
    assert.equal(parseColorInput(""), null);
    assert.equal(parseColorInput(null), null);
    assert.equal(parseColorInput(42), null);
});
