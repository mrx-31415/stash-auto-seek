const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../auto-seek/auto-seek.js"), "utf8");
const context = { Math, String, Number, parseFloat };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf("  // ── pure helpers"), source.indexOf("  // ── end pure helpers")), context);
const { formatTime, parseVtt, spriteCue, timelineRows, actStops, nextStop } = context;
const plain = (value) => JSON.parse(JSON.stringify(value));

// Times on the toasts and the pill: m:ss, with hours when needed.
assert.equal(formatTime(372), "6:12");
assert.equal(formatTime(3725), "1:02:05");
assert.equal(formatTime(-3), "0:00");

// The browser no longer scores frames: no model or runtime is loaded here.
for (const gone of ["onnxruntime", "InferenceSession", "indexedDB", "createImageBitmap"]) {
  assert.ok(!source.includes(gone), `${gone} is still referenced`);
}

// Stash's sprite VTT: the cue covering a time gives the thumbnail's place in the sprite.
const cues = parseVtt("WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nsprite.jpg#xywh=0,0,160,90\n\n00:00:10.000 --> 00:01:00.500\nsprite.jpg#xywh=160,0,160,90\n");
assert.equal(cues.length, 2);
assert.deepEqual(plain(spriteCue(cues, 42)), { start: 10, end: 60.5, x: 160, y: 0, w: 160, h: 90 });
assert.equal(spriteCue(cues, 5).x, 0);

// The timeline's rows: acts in the order they first show, then ones the
// model was fairly sure of somewhere without a clear start; the rest left out.
{
  const acts = ["nothing yet", "kissing", "oral on him", "cowgirl", "facial"];
  const frames = [[20, [90, 10, 85, 5, 0]], [0, [95, 5, 0, 0, 0]], [40, null], [60, [10, 90, 20, 95, 30]]];
  const rows = timelineRows({ acts, frames, firsts: { cowgirl: 58.5, kissing: 18 } });
  assert.deepEqual(plain(rows.map((row) => [row.name, row.first])), [["kissing", 18], ["cowgirl", 58.5], ["oral on him", null]]);
  assert.equal(rows[0].label, "Kissing");
  assert.deepEqual(plain(rows[1].points), [[0, 0], [20, 0.05], [60, 0.95]]); // time order, blank frames skipped
}

// An act name's stops: one per stretch at or above the floor (a one-frame
// dip doesn't split a stretch), at its peak, except where the act clearly
// starts; stepping goes on from the playhead and wraps round to the first.
{
  const points = [[0, 0.1], [10, 0.6], [20, 0.9], [30, 0.4], [40, 0.7], [50, 0.2], [60, 0.1], [70, 0.8], [80, 0.95], [90, 0.3]];
  assert.deepEqual(plain(actStops(points)), [20, 80]); // 30 s dips for one frame only
  assert.deepEqual(plain(actStops(points, 8)), [8, 80]); // the start stands for its stretch
  assert.deepEqual(plain(actStops(points, 65)), [20, 65]); // just before the second stretch
  assert.deepEqual(plain(actStops([[0, 0.9], [10, 0.1], [20, 0.1], [30, 0.6]])), [0, 30]);
  assert.deepEqual(plain(actStops([], 12)), [12]);
  assert.deepEqual(plain(actStops([])), []);
  assert.deepEqual(plain(nextStop([8, 80], 0)), { time: 8, index: 0, wrapped: false });
  assert.deepEqual(plain(nextStop([8, 80], 8.2)), { time: 80, index: 1, wrapped: false }); // just past a stop
  assert.deepEqual(plain(nextStop([8, 80], 80)), { time: 8, index: 0, wrapped: true });
  assert.equal(nextStop([], 0), null);
}
