const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../auto-seek/auto-seek.js"), "utf8");
const context = { Math, String, Number, parseFloat };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf("  // ── pure helpers"), source.indexOf("  // ── end pure helpers")), context);
const { formatTime, parseVtt, spriteCue, timelineRows, actStops, nextStop, heatColor, lockSteps, chapters, actColour, spanText } = context;
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
  // With a threshold, a stretch that never reaches it (a grey bar on the
  // lane) isn't a stop, unless no stretch reaches it at all.
  const maybes = [[0, 0.9], [10, 0.1], [20, 0.1], [30, 0.66], [40, 0.1], [50, 0.1], [60, 0.85]];
  assert.deepEqual(plain(actStops(maybes, 0, 0.5, 0.8)), [0, 60]);
  assert.deepEqual(plain(actStops([[0, 0.6], [10, 0.1], [20, 0.1], [30, 0.7]], null, 0.5, 0.8)), [0, 30]);
  assert.deepEqual(plain(actStops([], 12)), [12]);
  assert.deepEqual(plain(actStops([])), []);
  assert.deepEqual(plain(nextStop([8, 80], 0)), { time: 8, index: 0, wrapped: false });
  assert.deepEqual(plain(nextStop([8, 80], 8.2)), { time: 80, index: 1, wrapped: false }); // just past a stop
  assert.deepEqual(plain(nextStop([8, 80], 80)), { time: 8, index: 0, wrapped: true });
  assert.equal(nextStop([], 0), null);
}

// Strip bars warm with the score: grey well below the threshold, amber at
// it, white-hot when certain.
assert.equal(heatColor(0, 0.7), "rgb(75, 80, 90)");
assert.equal(heatColor(0.7, 0.7), "rgb(255, 184, 31)");
assert.equal(heatColor(1, 0.7), "rgb(255, 241, 194)");
assert.equal(heatColor(2, 0.7), "rgb(255, 241, 194)");

// The lock-on replays how the search closed in: the last miss before the
// start and the first hit after it, as the frames came in.
{
  const samples = [[0, 0.1], [60, 0.2], [120, 0.9], [180, 0.95], [70, 0.3], [80, 0.2], [90, 0.8], [85, 0.4], [87.5, 0.85], [86, 0.75]];
  assert.deepEqual(plain(lockSteps(samples, 86, 0.7)), [[60, 120], [70, 120], [80, 120], [80, 90], [85, 90], [85, 87.5], [85, 86]]);
  assert.deepEqual(plain(lockSteps([[0, 0.9]], 0, 0.7)), []); // nothing before the start to close in from
}

// Chapters: the surest act at or above the threshold, runs joined; frames
// with no clear act leave a gap.
{
  const acts = ["nothing yet", "kissing", "oral on him"];
  const frames = [[20, [10, 90, 50]], [0, [90, 10, 0]], [10, [10, 85, 0]], [30, [10, 70, 95]], [40, [10, 10, 90]], [50, null], [60, [90, 0, 0]]];
  assert.deepEqual(plain(chapters(frames, acts, 0.8, 10)), [
    { act: "kissing", from: 10, to: 30 },
    { act: "oral on him", from: 30, to: 60 },
  ]);
}

// One colour per group of acts; an act it doesn't know keeps the old amber.
assert.equal(actColour("cowgirl"), actColour("missionary"));
assert.notEqual(actColour("cowgirl"), actColour("oral on him"));
assert.equal(actColour("something new"), "#f5b400");

// The skipped-this-month total in words.
assert.equal(spanText(40), "40 s");
assert.equal(spanText(14 * 60 + 5), "14 m");
assert.equal(spanText(2 * 3600 + 14 * 60), "2 h 14 m");
