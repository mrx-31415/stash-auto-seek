const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../auto-seek/auto-seek.js"), "utf8");
const context = { Math, String, Number, parseFloat };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf("  // ── pure helpers"), source.indexOf("  // ── end pure helpers")), context);
const { formatTime, parseVtt, spriteCue, timelineRows, actStretches, actStops, nextStop, heatColor, lockSteps, chapters, actColour, spanText, hitRuns, zoomWindow, rulerSteps } = context;
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

// Where an act clearly is: a stretch starts at the threshold and lasts while
// the score stays at or above the floor; same-act stretches under a minute
// apart join, and ones shorter than 30 s are dropped.
{
  const wobbly = [[0, 0.85], [10, 0.6], [20, 0.9], [30, 0.55], [40, 0.82], [50, 0.3]];
  assert.deepEqual(plain(actStretches(wobbly)), [{ from: 0, to: 50, peak: [20, 0.9] }]);
  const cut = (gap) => [[0, 0.9], [10, 0.9], [20, 0.9], ...Array.from({ length: gap / 10 }, (_, k) => [30 + 10 * k, 0.1]), [30 + gap, 0.9], [40 + gap, 0.9], [50 + gap, 0.95]];
  assert.deepEqual(plain(actStretches(cut(50)).map((s) => [s.from, s.to])), [[0, 110]]); // a cut-away
  assert.deepEqual(plain(actStretches(cut(100)).map((s) => [s.from, s.to])), [[0, 30], [130, 160]]);
  assert.deepEqual(plain(actStretches([[0, 0.1], [10, 0.95], [20, 0.1]])), []); // one sure frame alone
  assert.deepEqual(plain(actStretches([[0, 0.7], [10, 0.7], [20, 0.7], [30, 0.7]])), []); // never reaches the line
  assert.deepEqual(plain(actStretches([[0, 0.9], [10, 0.9], [20, 0.9], [200, 0.6]]).map((s) => [s.from, s.to])), [[0, 30]]); // frames not scanned yet don't extend it
  // A short scene scales both down: in 40 s, two sure frames 15 s apart stay two.
  const short = [[0, 0.1], [5, 0.6], [10, 0.95], [15, 0.3], [20, 0.1], [25, 0.1], [30, 0.85], [35, 0.4]];
  assert.deepEqual(plain(actStretches(short, 0.8, 0.5, 5, 40).map((s) => [s.from, s.to])), [[10, 15], [30, 35]]);
}

// An act name's stops: one per stretch, at its peak, except where the act
// clearly starts; an act never that sure steps through its likely stretches;
// stepping goes on from the playhead and wraps round to the first.
{
  const points = Array.from({ length: 25 }, (_, k) => [10 * k, 0.1]);
  [[0, 0.6], [10, 0.9], [20, 0.85], [30, 0.7], [200, 0.85], [210, 0.9], [220, 0.95], [230, 0.6]].forEach(([time, score]) => (points[time / 10][1] = score));
  assert.deepEqual(plain(actStops(points, null, 0.5, 0.8)), [10, 220]);
  assert.deepEqual(plain(actStops(points, 5, 0.5, 0.8)), [5, 220]); // the start stands for its stretch
  assert.deepEqual(plain(actStops(points, 150, 0.5, 0.8)), [10, 150]); // just before the second stretch
  assert.deepEqual(plain(actStops(points)), [10, 220]);
  assert.deepEqual(plain(actStops([[0, 0.6], [10, 0.7], [20, 0.1], [30, 0.1]], null, 0.5, 0.8)), [10]); // unsure: likely stretches
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

// The top-act strip: the act whose stretch covers a frame, kept while it
// lasts; another takes over only after leading for 30 s, from where its lead
// began, so a one-frame lead doesn't flicker. Frames with no act leave a gap.
{
  const acts = ["nothing yet", "kissing", "oral on him"];
  const kissing = [90, 90, 90, 90, 90, 90, 60, 60, 60, 0, 0, 0, 0];
  const oral = [0, 0, 95, 0, 85, 85, 95, 95, 95, 95, 95, 95, 95];
  const frames = kissing.map((score, k) => [10 * k, [10, score, oral[k]]]).reverse();
  frames.push([130, null], [140, [90, 0, 0]], [150, [90, 0, 0]], [160, [90, 0, 0]], [170, [90, 0, 0]], [180, [10, 95, 0]], [190, [10, 95, 0]], [200, [10, 95, 0]]);
  assert.deepEqual(plain(chapters(frames, acts, 0.8, 10)), [
    { act: "kissing", from: 0, to: 60 },
    { act: "oral on him", from: 60, to: 140 },
    { act: "kissing", from: 180, to: 210 },
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

// The lanes' overview blocks are the act's stretches.
{
  const points = [[0, 0.9], [10, 0.85], [20, 0.5], [30, 0.95], [40, 0.2], [50, 0.1], [60, 0.81], [70, 0.3]];
  assert.deepEqual(plain(hitRuns(points, 0.8, 10)), [[0, 70]]);
  assert.deepEqual(plain(hitRuns([[0, 0.9], [10, 0.9], [20, 0.9], [200, 0.9]], 0.8, 10)), [[0, 30]]);
  assert.deepEqual(plain(hitRuns([[0, 0.5]], 0.8, 10)), []);
}

// The zoomed window stays inside the scene and no narrower than allowed.
assert.deepEqual(plain(zoomWindow(-30, 90, 1800, 60)), [0, 120]);
assert.deepEqual(plain(zoomWindow(1790, 1800, 1800, 60)), [1740, 1800]);
assert.deepEqual(plain(zoomWindow(0, 5000, 1800, 60)), [0, 1800]);
assert.deepEqual(plain(zoomWindow(10, 20, 40, 60)), [0, 40]); // a scene shorter than the least

// Ruler ticks: whole minutes across a long scene, seconds when close.
assert.deepEqual(plain(rulerSteps(1800, 700)), [300, 120]);
assert.deepEqual(plain(rulerSteps(120, 700)), [10, 5]);
assert.deepEqual(plain(rulerSteps(100000, 300)), [3600, 1800]);
