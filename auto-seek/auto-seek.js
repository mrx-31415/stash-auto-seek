(function () {
  "use strict";

  if (window.__autoSeekLoaded) return;
  window.__autoSeekLoaded = true;

  // The server finds the start points (auto_seek.py: frames cut by Stash's
  // ffmpeg, scored by an image model); this script reads them, asks for one
  // when a scene has none yet, and drives the player.
  const PLUGIN_ID = "auto-seek";
  const ENSURED_KEY = "auto-seek:ensured";
  // A scene takes a few seconds on a typical server; a busy one can queue it
  // behind the background task's ffmpeg runs.
  const ANALYSIS_TIMEOUT_MS = 120000;

  // ── pure helpers (tests/plugin/test_auto_seek.cjs) ─────────────────────

  function formatTime(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
  }

  // Stash's sprite VTT: "HH:MM:SS.mmm --> HH:MM:SS.mmm" then
  // "sprite.jpg#xywh=x,y,w,h", one cue per thumbnail.
  function parseVtt(text) {
    const seconds = (stamp) => stamp.split(":").reduce((total, part) => total * 60 + parseFloat(part), 0);
    const cues = [];
    const pattern = /([\d:.]+)\s*-->\s*([\d:.]+)\s*\n[^\n#]*#xywh=(\d+),(\d+),(\d+),(\d+)/g;
    for (const match of text.matchAll(pattern)) {
      cues.push({ start: seconds(match[1]), end: seconds(match[2]), x: +match[3], y: +match[4], w: +match[5], h: +match[6] });
    }
    return cues;
  }

  function spriteCue(cues, time) {
    return cues.find((cue) => time >= cue.start && time < cue.end) || cues[cues.length - 1] || null;
  }

  // The model's acts as the settings page shows them: [backend name, label,
  // other words a search finds it by]. The backend's names (auto_seek.py
  // ACTS) stay as they are; tests/test_settings_page.py keeps the two in step.
  const ACT_GROUPS = [
    { name: "Tease", acts: [["striptease / tease", "Striptease / tease", "strip show dance pose"]] },
    {
      name: "Foreplay",
      acts: [
        ["kissing", "Kissing", "kiss making out"],
        ["massage / oil", "Massage / oil", "oiled rub"],
        ["breast worship", "Breast worship", "boobs tits nipples"],
        ["ass worship", "Ass worship", "butt"],
        ["foot play", "Foot play", "feet footjob"],
      ],
    },
    { name: "Masturbation", acts: [["masturbation / toys", "Masturbation / toys", "solo dildo vibrator toy"]] },
    {
      name: "Oral",
      acts: [
        ["oral on him", "Blowjob", "bj oral on him suck deepthroat"],
        ["oral on her", "Eating pussy", "cunnilingus oral on her lick"],
        ["69", "69", "sixty-nine sixty nine"],
        ["rimming", "Rimming", "anilingus rimjob"],
      ],
    },
    {
      name: "Hands",
      acts: [
        ["handjob", "Handjob", "hj hand"],
        ["fingering", "Fingering", "finger"],
        ["titjob", "Titjob", "titfuck boobjob"],
      ],
    },
    {
      name: "Sex",
      acts: [
        ["cowgirl", "Cowgirl", "riding reverse cowgirl"],
        ["missionary", "Missionary", ""],
        ["doggy style", "Doggy style", "doggystyle from behind"],
        ["prone bone", "Prone bone", "lying flat"],
        ["side/spoon", "Spooning", "side spoon"],
        ["ballerina", "Ballerina", "standing leg up"],
        ["stand & carry", "Stand & carry", "standing lift and carry"],
        ["pile driving", "Pile driver", "piledriver pile driving"],
        ["scissoring", "Scissoring", "tribbing lesbian"],
      ],
    },
    {
      name: "Finish",
      acts: [
        ["facial", "Facial", "cum face cumshot"],
        ["in mouth", "Cum in mouth", "cum swallow"],
        ["on body", "Cum on body", "cumshot bodyshot cum"],
        ["creampie", "Creampie", "cum inside"],
      ],
    },
  ];
  const ALL_ACTS = ACT_GROUPS.flatMap((group) => group.acts.map(([name]) => name));
  const groupActs = (...names) => ACT_GROUPS.filter((group) => names.includes(group.name)).flatMap((group) => group.acts.map(([name]) => name));
  const LATER_ACTS = groupActs("Oral", "Hands", "Sex", "Finish");
  const FOREPLAY_ACTS = groupActs("Foreplay", "Masturbation").filter((name) => name !== "foot play");
  // The backend's stages (auto_seek.py STAGES), most useful first.
  const PRESETS = [
    { key: "oral", label: "Oral, hands or sex", note: "The default. Kissing, tease and other foreplay don't count yet.", acts: LATER_ACTS },
    { key: "kissing", label: "Kissing or later", note: "Kissing counts too; other foreplay and tease don't.", acts: ["kissing", ...LATER_ACTS] },
    { key: "sex", label: "Sex positions only", note: "Skips oral and hands as well.", acts: groupActs("Sex") },
    { key: "foreplay", label: "Foreplay or later", note: "Massage, worship, masturbation and kissing count; tease doesn't.", experimental: true, acts: [...FOREPLAY_ACTS, ...LATER_ACTS] },
    { key: "anything", label: "Anything, tease included", note: "Even a striptease counts as the start.", experimental: true, acts: ["striptease / tease", ...FOREPLAY_ACTS, ...LATER_ACTS] },
  ];
  const DEFAULT_PRESET = "oral";

  const sameActs = (a, b) => a.length === b.length && a.every((name) => b.includes(name));

  // The Start at setting as the backend reads it (auto_seek.py stage_of): a
  // stage's name, written leniently, or "acts: a, b" for a pick of acts.
  // Returns the preset it matches (null for a pick of its own) and its acts.
  function readStart(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text.startsWith("acts:")) {
      const names = text.slice(5).split(",").map((name) => name.trim());
      const acts = ALL_ACTS.filter((name) => names.includes(name));
      if (acts.length) {
        const preset = PRESETS.find((candidate) => sameActs(candidate.acts, acts));
        return { preset: preset ? preset.key : null, acts: preset ? preset.acts : acts };
      }
    } else {
      const words = text.split(/\s+/);
      for (const key of ["anything", "foreplay", "kissing", "oral", "sex", "position"]) {
        if (text.startsWith(key) || words.includes(key)) {
          const preset = PRESETS.find((candidate) => candidate.key === (key === "position" ? "sex" : key));
          return { preset: preset.key, acts: preset.acts };
        }
      }
    }
    const preset = PRESETS.find((candidate) => candidate.key === DEFAULT_PRESET);
    return { preset: preset.key, acts: preset.acts };
  }

  // What to save for a set of acts: a stage's name when it matches one.
  function writeStart(acts) {
    const preset = PRESETS.find((candidate) => sameActs(candidate.acts, acts));
    return preset ? preset.key : `acts: ${ALL_ACTS.filter((name) => acts.includes(name)).join(", ")}`;
  }

  // Search: every word typed starts a word of the act's label, name, other
  // words or group ("cum", "dog", "oral"; "bj" isn't found in "boobjob").
  function actMatches(act, group, query) {
    const words = `${act[1]} ${act[0]} ${act[2]} ${group}`.toLowerCase().split(/[\s/&-]+/);
    return String(query || "").toLowerCase().split(/\s+/).filter(Boolean)
      .every((typed) => words.some((word) => word.startsWith(typed)));
  }

  const ACT_LABELS = new Map(ACT_GROUPS.flatMap((group) => group.acts.map(([name, label]) => [name, label])));
  const actLabel = (name) => ACT_LABELS.get(name) || name;

  // The timeline's rows from the backend's answer (op "timeline"): every act
  // that first shows somewhere, in the order it does, then acts the model
  // was fairly sure of somewhere without a clear start. Frames are
  // [time, [percent per act] or null]; each row gets its [time, score] pairs.
  function timelineRows({ acts = [], frames = [], firsts = {} }, floor = 0.5) {
    const sorted = frames.filter(([, scores]) => scores).sort((a, b) => a[0] - b[0]);
    const rows = [];
    acts.forEach((name, j) => {
      if (j === 0) return; // "nothing yet"
      const points = sorted.map(([time, scores]) => [time, scores[j] / 100]);
      const top = points.reduce((best, point) => (!best || point[1] > best[1] ? point : best), null);
      const peak = top ? top[1] : 0;
      const first = firsts[name];
      if (first == null && peak < floor) return;
      rows.push({ name, label: actLabel(name), first: first ?? null, peak, peakAt: top ? top[0] : null, points });
    });
    return rows.sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity) || b.peak - a.peak);
  }

  // Where tapping an act's name steps to. Its points ([time, score], in
  // time order) fall into stretches at or above `floor` (a single frame
  // dipping below doesn't end one); each stretch is one stop, at its peak,
  // except the stretch where the act clearly starts (`first`), which stops
  // there. When some stretch reaches `threshold` (where the lane colours a
  // hit), only those count, so every stop is one you can see on the lane.
  // Sorted, in seconds.
  function actStops(points, first = null, floor = 0.5, threshold = null) {
    const stretches = [];
    let open = null;
    let below = 0;
    for (const [time, score] of points) {
      if (score >= floor) {
        if (!open) open = { end: time, peak: [time, score] };
        open.end = time;
        if (score > open.peak[1]) open.peak = [time, score];
        below = 0;
      } else if (open && ++below > 1) {
        stretches.push(open);
        open = null;
      }
    }
    if (open) stretches.push(open);
    if (threshold != null && stretches.some((stretch) => stretch.peak[1] >= threshold)) {
      stretches.splice(0, Infinity, ...stretches.filter((stretch) => stretch.peak[1] >= threshold));
    }
    const stops = stretches.map((stretch) => stretch.peak[0]);
    if (first != null) {
      const holds = stretches.findIndex((stretch) => stretch.end >= first);
      if (holds >= 0 && stretches[holds].peak[0] >= first - 15) stops[holds] = first;
      else stops.push(first);
    }
    return [...new Set(stops)].sort((a, b) => a - b);
  }

  // The stop after `after` seconds; after the last, back to the first.
  function nextStop(stops, after) {
    const index = stops.findIndex((time) => time > after + 0.5);
    if (index >= 0) return { time: stops[index], index, wrapped: false };
    return stops.length ? { time: stops[0], index: 0, wrapped: true } : null;
  }

  // A scan-strip bar's colour by how sure its frame is: grey well below the
  // threshold, warming to amber at it, then orange and white-hot as it gets
  // certain.
  function heatColor(score, threshold = 0.7) {
    const s = Math.min(1, Math.max(0, score));
    const stops = [
      [0, [75, 80, 90]],
      [threshold * 0.7, [120, 96, 50]],
      [threshold, [255, 184, 31]],
      [threshold + (1 - threshold) * 0.6, [255, 138, 31]],
      [1, [255, 241, 194]],
    ];
    for (let k = 1; k < stops.length; k++) {
      if (s > stops[k][0]) continue;
      const [a, from] = stops[k - 1];
      const [b, to] = stops[k];
      const f = b > a ? (s - a) / (b - a) : 1;
      return `rgb(${from.map((c, j) => Math.round(c + (to[j] - c) * f)).join(", ")})`;
    }
    return "rgb(255, 241, 194)";
  }

  // How the search closed in on `start`, replayed from the frames it scored
  // (in the order it scored them): the last miss before the start and the
  // first hit at or after it, each time either moves.
  function lockSteps(samples, start, threshold) {
    let low = null;
    let high = null;
    const steps = [];
    for (const [time, score] of samples) {
      if (time < start && score < threshold && (low == null || time > low)) low = time;
      else if (time >= start && score >= threshold && (high == null || time < high)) high = time;
      else continue;
      const last = steps[steps.length - 1];
      if (low != null && high != null && !(last && last[0] === low && last[1] === high)) steps.push([low, high]);
    }
    return steps;
  }

  // The top-act strip (not chapters yet: it follows every switch): at each frame the act the model is surest of (at
  // or above the threshold), with runs of the same act joined.
  function chapters(frames, acts, threshold = 0.8, spacing = 10) {
    const sorted = frames.filter(([, scores]) => scores).sort((a, b) => a[0] - b[0]);
    const out = [];
    sorted.forEach(([time, scores], k) => {
      let best = -1;
      scores.forEach((percent, j) => {
        if (j > 0 && percent >= 100 * threshold && (best < 0 || percent > scores[best])) best = j;
      });
      if (best < 0) return;
      const end = k + 1 < sorted.length ? sorted[k + 1][0] : time + spacing;
      const last = out[out.length - 1];
      if (last && last.act === acts[best] && last.to >= time) last.to = end;
      else out.push({ act: acts[best], from: time, to: end });
    });
    return out;
  }

  // One colour per group of acts, so the lanes and chapters read at a glance.
  const GROUP_COLOURS = {
    Tease: "#ff7a59", Foreplay: "#ff5fa2", Masturbation: "#a3e635", Oral: "#ffb81f",
    Hands: "#2dd4bf", Sex: "#5b9dff", Finish: "#b98cff",
  };
  function actColour(name) {
    const group = ACT_GROUPS.find((candidate) => candidate.acts.some(([act]) => act === name));
    return (group && GROUP_COLOURS[group.name]) || "#f5b400";
  }

  // A running total in words: "2 h 14 m", "14 m", "40 s".
  function spanText(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s} s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h} h ${m} m` : `${m} m`;
  }

  // ── end pure helpers ───────────────────────────────────────────────────

  async function graphql(query, variables) {
    const response = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors) throw new Error(payload.errors?.[0]?.message || `HTTP ${response.status}`);
    return payload.data;
  }

  function operation(args) {
    return graphql(
      `mutation AutoSeekOperation($args: Map!) { runPluginOperation(plugin_id: "${PLUGIN_ID}", args: $args) }`,
      { args },
    ).then((data) => data.runPluginOperation);
  }

  let settingsPromise = null;
  function settings() {
    settingsPromise ||= graphql(`query AutoSeekSettings { configuration { plugins(include: ["${PLUGIN_ID}"]) } }`)
      .then((data) => ({ plugin: data.configuration.plugins[PLUGIN_ID] || {} }))
      .catch(() => ({ plugin: {} }));
    return settingsPromise;
  }

  // ── server-side files ──────────────────────────────────────────────────

  // Ask the backend once per tab to fetch the model if it hasn't yet; the
  // operation returns immediately and the download continues on the server.
  async function ensureServerFiles() {
    try {
      if (sessionStorage.getItem(ENSURED_KEY)) return;
      sessionStorage.setItem(ENSURED_KEY, "1");
    } catch (error) { /* storage blocked: ask anyway */ }
    const { plugin } = await settings();
    if (plugin.disableDownload === true) return;
    const current = await operation({ op: "status" });
    if (!current.ready && !current.downloading) await operation({ op: "ensure" });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── start points ───────────────────────────────────────────────────────

  // The server's answer: the cached start, or one worked out now. Fails after
  // a while rather than keeping the viewer waiting for ever.
  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Finding the start took too long; the server may be busy")), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  // While the model is still downloading on first use, keep waiting (the
  // strip shows the download) instead of failing.
  async function analyseOnServer(id) {
    for (;;) {
      try {
        return await withTimeout(operation({ op: "analyse", scene_id: id }), ANALYSIS_TIMEOUT_MS);
      } catch (error) {
        if (!/still downloading/i.test(error.message)) throw error;
        await sleep(2000);
      }
    }
  }

  // One analysis at a time, remembered per scene for this tab.
  const known = new Map();
  let queue = Promise.resolve();
  function startPoint(id) {
    if (!known.has(id)) {
      const run = queue.then(() => analyseOnServer(id)).then((hit) => ({
        start: hit.start,
        duration: hit.duration,
        marked: hit.model === "user",
        samples: hit.samples || [],
        threshold: hit.threshold,
      }));
      queue = run.catch(() => {});
      known.set(id, run);
      run.catch(() => known.delete(id));
    }
    return known.get(id);
  }

  // Where to jump: just before the detected start, for a smoother way in.
  // The search lands within seconds, so a short lead-in is enough.
  async function leadIn() {
    const value = Number((await settings()).plugin.leadIn);
    return Number.isFinite(value) && value >= 0 ? Math.min(value, 60) : 3;
  }

  // ── player ─────────────────────────────────────────────────────────────

  function sceneIdFrom(pathname) {
    const match = /^\/scenes\/(\d+)\/?$/.exec(pathname);
    return match ? match[1] : null;
  }

  const TARGET_ICON =
    '<svg class="auto-seek-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>';

  const FLAG_ICON =
    '<svg class="auto-seek-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M6 4h11l-2.5 4L17 12H6" fill="currentColor"/></svg>';

  // The viewer's own answer: the action starts where the player is now. It
  // replaces the computed start for this scene from now on (the backend
  // keeps it apart from the cache, so a new model doesn't undo it), and,
  // next to the computed start, is a label for training a better model.
  async function markStart(view) {
    const start = timeOf(view);
    const duration = Math.max(durationOf(view) || 0, start);
    const before = { marked: view.marked, start: view.start };
    // Answer the tap at once; the save follows (a busy server can take seconds).
    known.set(view.id, Promise.resolve({ start, duration, cached: true, marked: true, samples: view.samples, threshold: view.threshold }));
    view.promise = null;
    view.dismissed = true; // already there; no "Skip intro" now
    resolve(view).catch(() => {});
    operation({ op: "mark", scene_id: view.id, start, duration }).catch((error) => {
      known.delete(view.id);
      view.promise = null;
      resolve(view).catch(() => {});
      toast(view, `Couldn't save the start: ${error.message}`);
    });
    // Undo puts back an earlier mark, or else the computed start.
    toast(view, `Start set to ${formatTime(start)}`, async () => {
      const restore = before.marked
        ? { op: "mark", scene_id: view.id, start: before.start, duration }
        : { op: "unmark", scene_id: view.id };
      await operation(restore).catch(() => {});
      known.delete(view.id);
      view.promise = null;
      resolve(view).catch(() => {});
    });
  }

  // The scene page's state: its player, our controls, and what is known.
  let current = null;

  function render() {
    const view = current;
    if (!view) return;
    const label = {
      busy: "Finding where the action starts…",
      ready: view.target == null ? "Skip intro" : `Skip intro (to ${formatTime(view.target)}${view.marked ? ", your mark" : ""})`,
      error: `Auto Seek: ${view.error}`,
    }[view.state];
    view.button.dataset.state = view.state;
    view.button.title = label;
    view.button.querySelector(".vjs-control-text").textContent = label;
    // The pill only offers itself while there is still an intro to skip, or
    // while it is holding playback for the start point.
    const before = view.target == null ? timeOf(view) < 120 : timeOf(view) < view.target - 2;
    // Hidden by the setting, it still appears while it holds playback for an
    // automatic skip, since only it can say so.
    const show = view.holding || view.needsTap || (!view.hideButton && view.state !== "error" && !view.dismissed && before);
    view.pill.hidden = !show;
    // While the server works the start out the pill shimmers; once it shows
    // its arrow, a tap jumps straight there.
    view.pill.dataset.state = view.state;
    view.pill.title = label;
    view.pill.querySelector(".auto-seek-pill-text").textContent = view.holding
      ? "Starting…"
      : view.needsTap ? `Play from ${formatTime(view.target)}` : "Skip intro";
    view.pill.querySelector(".auto-seek-pill-arrow").hidden = view.state !== "ready";
  }

  // Stash's player is video.js. Seeking and playing through it, rather than
  // on the bare <video>, keeps its own state (and its handling of
  // transcoded streams) in step; the element is the fallback.
  function playerOf(view) {
    return view.video.closest(".video-js")?.player ?? null;
  }

  // Where the video is, and how long, in the scene's time. Ask Stash's
  // player: a file it converts on the fly (one the browser can't play as it
  // is) restarts the stream at each seek, and the <video> element's own clock
  // and duration count from that restart.
  function timeOf(view) {
    const time = playerOf(view)?.currentTime();
    return Number.isFinite(time) ? time : view.video.currentTime;
  }

  function durationOf(view) {
    const duration = playerOf(view)?.duration();
    return Number.isFinite(duration) && duration > 0 ? duration : view.video.duration;
  }

  function setTime(view, time) {
    view.ourSeek = true;
    const player = playerOf(view);
    if (player) player.currentTime(time); else view.video.currentTime = time;
  }

  function playVideo(view) {
    const player = playerOf(view);
    return Promise.resolve(player ? player.play() : view.video.play());
  }

  function pauseVideo(view) {
    const player = playerOf(view);
    if (player) player.pause(); else view.video.pause();
  }

  // `intro`: a Skip intro jump (the pill, the button or the automatic one),
  // which counts up what it skipped; other jumps just say where they went.
  function seekPlayer(view, time, intro = false) {
    const before = timeOf(view);
    setTime(view, time);
    view.dismissed = true;
    render();
    const skipped = time - before;
    if (!intro || skipped < 5) {
      toast(view, `Skipped to ${formatTime(time)}`, () => setTime(view, before));
      return;
    }
    rippleSeekBar(view, before, time);
    const month = addSkipped(skipped);
    const box = toast(view, "", () => { setTime(view, before); addSkipped(-skipped); });
    if (!box) return;
    const words = document.createElement("span");
    box.prepend(words);
    const extra = month > skipped + 1 ? ` · ${spanText(month)} this month` : "";
    const started = performance.now();
    const count = (now) => {
      const f = reducedMotion() ? 1 : Math.min(1, (now - started) / 700);
      words.textContent = `Skipped ${formatTime(skipped * (1 - (1 - f) ** 3))} of intro${f < 1 ? "" : extra}`;
      if (f < 1 && box.isConnected) requestAnimationFrame(count);
    };
    count(started);
  }

  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

  // Intro time skipped this month, kept in this browser.
  function addSkipped(seconds) {
    const now = new Date();
    const key = `auto-seek:skipped:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    try {
      const total = Math.max(0, (Number(localStorage.getItem(key)) || 0) + seconds);
      localStorage.setItem(key, String(Math.round(total)));
      return total;
    } catch (error) {
      return Math.max(0, seconds);
    }
  }

  // The jump on Stash's own seek bar: a streak from where the video was to
  // where it lands, and a ripple there.
  function rippleSeekBar(view, from, to) {
    const holder = view.video.closest(".video-js")?.querySelector(".vjs-progress-holder");
    const duration = view.duration || durationOf(view);
    if (!holder || !(duration > 0) || reducedMotion()) return;
    const at = (time) => `${Math.min(100, Math.max(0, (100 * time) / duration))}%`;
    const streak = document.createElement("span");
    streak.className = "auto-seek-jump-streak";
    streak.style.left = at(Math.min(from, to));
    streak.style.width = `calc(${at(Math.abs(to - from))})`;
    const ripple = document.createElement("span");
    ripple.className = "auto-seek-jump-ripple";
    ripple.style.left = at(to);
    holder.append(streak, ripple);
    setTimeout(() => { streak.remove(); ripple.remove(); }, 1000);
  }

  function toast(view, text, undo) {
    const host = view.video.closest(".video-js");
    if (!host) return;
    host.querySelector(".auto-seek-toast")?.remove();
    const box = document.createElement("div");
    box.className = "auto-seek-toast";
    box.textContent = text;
    if (undo) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Undo";
      button.onclick = () => { undo(); box.remove(); };
      box.append(" ", button);
    }
    host.appendChild(box);
    setTimeout(() => box.remove(), 6000);
    return box;
  }

  // ── scan strip ─────────────────────────────────────────────────────────

  // A thin strip under the video showing the frames the server scored: one
  // bar each, as tall as the model was sure the action had started, orange
  // past the threshold and grey before it. It fills in live while a scene is
  // being worked out and flashes a line at the start once it is found. The
  // × hides it for this tab; Settings → "Hide the scan chart" for good.
  const STRIP_HIDDEN_KEY = "auto-seek:strip-hidden";
  // Auto Seek's logo (docs/assets/auto-seek.svg) as a self-contained image:
  // inline, its gradient, clip and glow references (url(#id)) resolve
  // against Stash's <base href> in some browsers and break.
  const STRIP_ICON = `<img class="auto-seek-strip-icon" alt="" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 128 128%22%3E %3Cdefs%3E%3ClinearGradient id=%22g%22 x1=%2214%22 y1=%2210%22 x2=%22114%22 y2=%22118%22 gradientUnits=%22userSpaceOnUse%22%3E%3Cstop stop-color=%22%23ffcf3f%22/%3E%3Cstop offset=%22.55%22 stop-color=%22%23ff9a1f%22/%3E%3Cstop offset=%221%22 stop-color=%22%23ff5c39%22/%3E%3C/linearGradient%3E %3Cfilter id=%22glow%22 filterUnits=%22userSpaceOnUse%22 x=%220%22 y=%220%22 width=%22128%22 height=%22128%22%3E%3CfeGaussianBlur stdDeviation=%222.6%22 result=%22b%22/%3E%3CfeMerge%3E%3CfeMergeNode in=%22b%22/%3E%3CfeMergeNode in=%22SourceGraphic%22/%3E%3C/feMerge%3E%3C/filter%3E%3CclipPath id=%22k%22%3E%3Crect x=%2220%22 y=%2224%22 width=%2288%22 height=%2264%22 rx=%2213%22/%3E%3C/clipPath%3E%3CclipPath id=%22behind%22%3E%3Crect width=%2272%22 height=%22128%22/%3E%3C/clipPath%3E%3CclipPath id=%22ahead%22%3E%3Crect x=%2272%22 width=%2256%22 height=%22128%22/%3E%3C/clipPath%3E%3ClinearGradient id=%22t%22 x1=%2222%22 x2=%2272%22 gradientUnits=%22userSpaceOnUse%22%3E%3Cstop stop-color=%22%23ffb81f%22 stop-opacity=%220%22/%3E%3Cstop offset=%221%22 stop-color=%22%23ffb81f%22 stop-opacity=%22.42%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width=%22128%22 height=%22128%22 rx=%2234%22 fill=%22url(%23g)%22/%3E%3Crect x=%2220%22 y=%2224%22 width=%2288%22 height=%2264%22 rx=%2213%22 fill=%22%231b1208%22/%3E%3Cg clip-path=%22url(%23k)%22%3E%3Crect x=%2222%22 y=%2224%22 width=%2250%22 height=%2264%22 fill=%22url(%23t)%22/%3E%3Cg clip-path=%22url(%23ahead)%22%3E%3Cpath d=%22M44 38l18 18-18 18M64 38l18 18-18 18%22 fill=%22none%22 stroke=%22%23ffb81f%22 stroke-width=%228%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22 opacity=%22.3%22/%3E%3C/g%3E%3Cg clip-path=%22url(%23behind)%22%3E%3Cpath d=%22M44 38l18 18-18 18M64 38l18 18-18 18%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%228%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3C/g%3E%3Cpath d=%22M72 24V88%22 stroke=%22%23ffd25a%22 stroke-width=%223.5%22 filter=%22url(%23glow)%22/%3E%3C/g%3E%3Crect x=%2224.0%22 y=%22108.5%22 width=%224%22 height=%223.5%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.42%22/%3E%3Crect x=%2231.6%22 y=%22108.5%22 width=%224%22 height=%223.5%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.42%22/%3E%3Crect x=%2239.2%22 y=%22108.5%22 width=%224%22 height=%223.5%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.42%22/%3E%3Crect x=%2246.8%22 y=%22108.5%22 width=%224%22 height=%223.5%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.42%22/%3E%3Crect x=%2254.4%22 y=%22107.6%22 width=%224%22 height=%224.4%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.46%22/%3E%3Crect x=%2262.0%22 y=%22103.0%22 width=%224%22 height=%229.0%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.63%22/%3E%3Crect x=%2269.6%22 y=%2298.0%22 width=%224%22 height=%2214.0%22 rx=%222%22 fill=%22%23fff%22 opacity=%221.00%22/%3E%3Crect x=%2277.2%22 y=%22102.2%22 width=%224%22 height=%229.8%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.66%22/%3E%3Crect x=%2284.8%22 y=%22107.3%22 width=%224%22 height=%224.7%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.46%22/%3E%3Crect x=%2292.4%22 y=%22108.4%22 width=%224%22 height=%223.6%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.42%22/%3E%3Crect x=%22100.0%22 y=%22108.5%22 width=%224%22 height=%223.5%22 rx=%222%22 fill=%22%231b1208%22 opacity=%220.42%22/%3E%3C/svg%3E">`;

  function stripDismissed() {
    try { return sessionStorage.getItem(STRIP_HIDDEN_KEY) === "1"; } catch (error) { return false; }
  }

  async function ensureStrip(view) {
    if (view.strip?.isConnected) return view.strip;
    if (stripDismissed() || (await settings()).plugin.hideScanChart === true || current !== view) return null;
    const wrapper = view.video.closest(".video-wrapper");
    if (!wrapper?.parentElement || view.strip?.isConnected) return view.strip?.isConnected ? view.strip : null;
    document.querySelectorAll(".auto-seek-strip").forEach((old) => old.remove());
    const strip = document.createElement("div");
    strip.className = "auto-seek-strip";
    strip.innerHTML =
      '<div class="auto-seek-strip-bars"><span class="auto-seek-strip-line"></span><b class="auto-seek-strip-flag" hidden></b>' +
      '<b class="auto-seek-strip-bracket is-low" hidden></b><b class="auto-seek-strip-bracket is-high" hidden></b>' +
      '<em class="auto-seek-strip-edge is-low" hidden></em><em class="auto-seek-strip-edge is-high" hidden></em></div>' +
      `<span class="auto-seek-strip-label">${STRIP_ICON}<i class="auto-seek-strip-thumb" hidden><b></b></i><span class="auto-seek-strip-text"></span></span>` +
      '<div class="auto-seek-strip-peek" hidden><span class="auto-seek-strip-peek-image"></span><span class="auto-seek-strip-peek-text"></span></div>' +
      '<button type="button" class="auto-seek-strip-close" aria-label="Hide the scan chart" title="Hide (Settings → Plugins → Auto Seek hides it for good)">×</button>';
    strip.querySelector(".auto-seek-strip-label").addEventListener("click", () => strip.classList.toggle("is-quiet"));
    strip.querySelector(".auto-seek-strip-close").addEventListener("click", () => {
      try { sessionStorage.setItem(STRIP_HIDDEN_KEY, "1"); } catch (error) { /* hidden on this page only */ }
      strip.remove();
    });
    wrapper.after(strip);
    view.strip = strip;
    view.stripDrawn = 0;
    attachPeek(view, strip);
    alignStrip(view);
    // Keep the bars over the matching spot of the seek bar as the page resizes.
    view.stripResize?.disconnect();
    view.stripResize = new ResizeObserver(() => alignStrip(view));
    view.stripResize.observe(strip);
    return strip;
  }

  // Line the bars up with Stash's seek bar, so a bar sits over the moment it
  // was taken from (the seek bar is inset by the player's buttons).
  function alignStrip(view) {
    const bars = view.strip?.querySelector(".auto-seek-strip-bars");
    const holder = view.video.closest(".video-js")?.querySelector(".vjs-progress-holder");
    if (!bars || !holder) return;
    const seek = holder.getBoundingClientRect();
    const strip = view.strip.getBoundingClientRect();
    if (!seek.width || !strip.width) return;
    bars.style.marginLeft = `${seek.left - strip.left}px`;
    bars.style.width = `${seek.width}px`;
  }

  // Add the frames not drawn yet; `samples` only ever grows.
  function paintStrip(view, { samples = [], duration, threshold }, pace = 90) {
    const bars = view.strip?.querySelector(".auto-seek-strip-bars");
    if (!bars || !(duration > 0)) return;
    if (threshold != null) bars.querySelector(".auto-seek-strip-line").style.bottom = `${22 + 78 * threshold}%`; // where a bar of that score ends
    view.stripPending ||= [];
    if (samples.length < view.stripDrawn) {
      bars.querySelectorAll("i").forEach((bar) => bar.remove());
      view.stripPending = [];
      view.stripDrawn = 0;
    }
    // Frames arrive in clumps (they are cut in parallel); they join a queue
    // that adds one bar at a steady pace, so the strip visibly works through
    // the scene frame by frame.
    view.stripPending.push(...samples.slice(view.stripDrawn).map(([time, score]) => ({ time, score, duration, threshold })));
    view.stripDrawn = samples.length;
    if (!view.stripTimer) drainStrip(view, bars, pace);
  }

  function drainStrip(view, bars, pace) {
    const next = view.stripPending.shift();
    if (!next) {
      view.stripTimer = null;
      view.stripIdle?.();
      return;
    }
    const { time, score, duration, threshold } = next;
    const bar = document.createElement("i");
    const hit = threshold != null && score >= threshold;
    if (hit) bar.className = "hit";
    bar.style.left = stripX(view, time, duration);
    bar.style.height = `${22 + 78 * score}%`; // a visible stub even at 0
    bar.style.background = heatColor(score, threshold ?? 0.7);
    bar.dataset.time = time;
    bar.dataset.score = score;
    bars.appendChild(bar);
    // Live, the label shows the frame being looked at, and the first frame
    // past the threshold throws a spark and lights the threshold line.
    if (pace >= 60) {
      showThumb(view, time);
      if (hit && !bars.classList.contains("is-lit")) {
        bars.classList.add("is-lit");
        if (!reducedMotion()) {
          const spark = document.createElement("b");
          spark.className = "auto-seek-strip-spark";
          spark.style.left = bar.style.left;
          spark.style.bottom = bar.style.height;
          bars.appendChild(spark);
          setTimeout(() => spark.remove(), 800);
        }
      }
    }
    view.stripTimer = setTimeout(() => drainStrip(view, bars, pace), pace);
  }

  // Where `time` sits across the strip: the whole scene, or while the
  // lock-on zooms in, the window it shows (view.stripView).
  function stripX(view, time, duration = view.duration) {
    const [low, high] = view.stripView || [0, duration];
    return `${((100 * (time - low)) / Math.max(1e-6, high - low)).toFixed(3)}%`;
  }

  // Show [low, high] of the scene across the strip (null: all of it); the
  // bars glide to their new places (auto-seek.css).
  function zoomStrip(view, low, high) {
    const strip = view.strip;
    if (!strip) return;
    view.stripView = low == null ? null : [low, high];
    strip.classList.toggle("is-zoomed", low != null);
    for (const bar of strip.querySelectorAll(".auto-seek-strip-bars i")) {
      const t = Number(bar.dataset.time);
      bar.style.left = stripX(view, t);
    }
    const [lowEdge, highEdge] = strip.querySelectorAll(".auto-seek-strip-edge");
    lowEdge.hidden = highEdge.hidden = low == null;
    if (low != null) { lowEdge.textContent = formatTime(low); highEdge.textContent = formatTime(high); }
  }

  function placeBrackets(view, low, high) {
    const [left, right] = view.strip?.querySelectorAll(".auto-seek-strip-bracket") || [];
    if (!left) return;
    left.hidden = right.hidden = low == null;
    if (low == null) return;
    left.style.left = stripX(view, low);
    right.style.left = stripX(view, high);
  }

  // The frame at `time` beside the strip's words, from Stash's seek-bar
  // sprite (no frames are cut for it). null hides it.
  async function showThumb(view, time, held = false) {
    const thumb = view.strip?.querySelector(".auto-seek-strip-thumb");
    if (!thumb) return;
    thumb.classList.toggle("is-held", held);
    spriteThumb(view, thumb, time, 22); // auto-seek.css: the thumbnail is 22 px tall
  }

  // Shows the sprite thumbnail nearest `time` in `thumb` (an <i> holding a
  // <b>), `height` px tall; null, or a scene without a sprite, hides it.
  // Only touches the page when the thumbnail changes.
  async function spriteThumb(view, thumb, time, height) {
    if (time == null) { thumb.hidden = true; delete thumb.dataset.time; return; }
    thumb.dataset.time = String(time);
    const sprite = await sceneSprite(view.id);
    const cue = sprite && spriteCue(sprite.cues, time);
    if (thumb.dataset.time !== String(time)) return;
    if (!cue) { thumb.hidden = true; return; }
    const key = `${cue.x},${cue.y}`;
    if (thumb.dataset.cue === key && !thumb.hidden) return;
    thumb.dataset.cue = key;
    const image = thumb.firstElementChild;
    showImage(image, { url: sprite.sprite, cue });
    const scale = height / cue.h;
    image.style.transform = `scale(${scale})`;
    thumb.style.width = `${Math.round(cue.w * scale)}px`;
    thumb.hidden = false;
  }

  // Once a live search has found the start: the strip zooms into where the
  // search closed in, brackets narrow onto the start as each frame it
  // checked did, lock, and the strip zooms back out for the flag to drop.
  async function lockOn(view) {
    const duration = view.duration;
    const steps = lockSteps(view.samples || [], view.start, view.threshold ?? 0.7);
    const first = steps.findIndex(([a, b]) => b - a <= Math.max(120, duration / 8));
    if (first < 0 || reducedMotion() || !view.strip) return;
    const [a0, b0] = steps[first];
    const pad = Math.max(4, (b0 - a0) * 0.3);
    view.strip.classList.add("is-quiet", "is-locking"); // is-locking clips the bars to the strip
    zoomStrip(view, Math.max(0, a0 - pad), Math.min(duration, b0 + pad));
    labelStrip(view, "Closing in on the start…");
    showThumb(view, a0);
    await sleep(650);
    for (const [a, b] of steps.slice(first)) {
      if (current !== view || !view.strip) return;
      placeBrackets(view, a, b);
      showThumb(view, b);
      await sleep(240);
    }
    if (current !== view || !view.strip) return;
    placeBrackets(view, view.start, view.start);
    view.strip.classList.add("is-locked");
    labelStrip(view, `Found it · ${formatTime(view.start)}`);
    showThumb(view, view.start, true);
    await sleep(550);
    if (current !== view || !view.strip) return;
    placeBrackets(view, null);
    view.strip.classList.remove("is-locked");
    zoomStrip(view, null);
    await sleep(650);
    view.strip?.classList.remove("is-locking");
  }

  // Resolves once every queued bar is on the strip.
  function stripSettled(view) {
    if (!view.stripTimer && !view.stripPending?.length) return Promise.resolve();
    return new Promise((resolve) => {
      const previous = view.stripIdle;
      view.stripIdle = () => { view.stripIdle = null; previous?.(); resolve(); };
    });
  }

  // ── strip preview: Stash's own seek-bar sprite, when the scene has one ──

  const spriteCache = new Map();
  function sceneSprite(id) {
    if (!spriteCache.has(id)) {
      spriteCache.set(id, (async () => {
        const data = await graphql(
          "query AutoSeekSprite($id: ID!) { autoSeekSprite: findScene(id: $id) { paths { vtt sprite } } }",
          { id },
        );
        const paths = data.autoSeekSprite?.paths;
        if (!paths?.vtt || !paths?.sprite) return null;
        const response = await fetch(paths.vtt, { credentials: "same-origin" });
        if (!response.ok) return null;
        return { sprite: paths.sprite, cues: parseVtt(await response.text()) };
      })().catch(() => null));
    }
    return spriteCache.get(id);
  }

  // Exact frames for the preview, cut by the server once per bar and kept.
  const frameCache = new Map();
  let peekTimer = null;
  async function exactFrame(id, time) {
    const key = `${id}:${time}`;
    if (!frameCache.has(key)) {
      frameCache.set(key, operation({ op: "frame", scene_id: id, time })
        .then((frame) => (frame.jpeg ? `data:image/jpeg;base64,${frame.jpeg}` : null))
        .catch(() => null));
    }
    const url = await frameCache.get(key);
    if (url) frameCache.set(key, url); // later hovers read the URL at once
    return url;
  }

  function showImage(image, source) {
    image.hidden = !source;
    if (!source) return;
    const { url, cue } = source;
    image.style.backgroundImage = `url("${url}")`;
    if (cue) {
      image.style.width = `${cue.w}px`;
      image.style.height = `${cue.h}px`;
      image.style.backgroundSize = "";
      image.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
    } else {
      image.style.width = "160px";
      image.style.height = "90px";
      image.style.backgroundSize = "cover";
      image.style.backgroundPosition = "center";
    }
  }

  function attachPeek(view, strip) {
    const bars = strip.querySelector(".auto-seek-strip-bars");
    const peek = strip.querySelector(".auto-seek-strip-peek");
    const image = peek.querySelector(".auto-seek-strip-peek-image");
    const text = peek.querySelector(".auto-seek-strip-peek-text");
    const barAt = (event) => {
      let nearest = null;
      let distance = 10; // px: a bar is only a few pixels wide
      for (const bar of bars.querySelectorAll("i")) {
        const x = bar.getBoundingClientRect().left + bar.offsetWidth / 2;
        if (Math.abs(x - event.clientX) < distance) { nearest = bar; distance = Math.abs(x - event.clientX); }
      }
      return nearest;
    };
    const show = async (event) => {
      const box = bars.getBoundingClientRect();
      const nearest = barAt(event);
      if (!nearest) { peek.hidden = true; return; }
      const time = Number(nearest.dataset.time);
      const score = Number(nearest.dataset.score);
      text.textContent = `${formatTime(time)} · ${Math.round(100 * score)}%`;
      peek.style.left = `${Math.min(Math.max(nearest.getBoundingClientRect().left - box.left, 60), box.width - 60)}px`;
      peek.hidden = false;
      peek.dataset.time = String(time);
      // The seek-bar sprite first (instant, but its nearest thumbnail can be
      // tens of seconds away), then the exact frame from the server.
      const exact = frameCache.get(`${view.id}:${time}`);
      if (typeof exact === "string") { showImage(image, { url: exact }); return; }
      const sprite = await sceneSprite(view.id);
      const cue = sprite && spriteCue(sprite.cues, time);
      if (peek.dataset.time !== String(time)) return;
      showImage(image, cue ? { url: sprite.sprite, cue } : null);
      clearTimeout(peekTimer);
      peekTimer = setTimeout(async () => {
        const url = await exactFrame(view.id, time);
        if (url && peek.dataset.time === String(time) && !peek.hidden) showImage(image, { url });
      }, 120);
    };
    bars.addEventListener("pointermove", show);
    bars.addEventListener("pointerdown", show);
    bars.addEventListener("pointerleave", () => { peek.hidden = true; });
    // Letting go on a bar plays from that frame, as Skip intro does; sliding
    // off the strip first only looks.
    bars.addEventListener("pointerup", (event) => {
      const bar = barAt(event);
      if (!bar || current !== view) return;
      event.stopPropagation();
      peek.hidden = true;
      seekPlayer(view, Number(bar.dataset.time));
      view.userSeeked = true;
      if (view.video.paused) playVideo(view).catch(() => {});
    });
    bars.addEventListener("click", (event) => event.stopPropagation());
  }

  function labelStrip(view, text) {
    const label = view.strip?.querySelector(".auto-seek-strip-text");
    if (label) label.textContent = text;
  }

  async function showStart(view, flash) {
    if (!view.samples?.length || !(await ensureStrip(view))) return;
    // A cached answer fills in quickly; a live one keeps its pace.
    paintStrip(view, { samples: view.samples, duration: view.duration, threshold: view.threshold }, view.stripDrawn ? 90 : 25);
    await stripSettled(view);
    // The full lock-on only for a search this page watched; an answer known
    // before the page opened just drops its flag.
    if (flash && view.watched && !view.marked) await lockOn(view);
    if (current !== view || !view.strip?.isConnected) return;
    const flag = view.strip.querySelector(".auto-seek-strip-flag");
    flag.hidden = false;
    flag.classList.toggle("marked", Boolean(view.marked));
    flag.style.left = `${Math.min(100, Math.max(0, (100 * view.start) / view.duration))}%`;
    labelStrip(view, view.marked ? `Your start · ${formatTime(view.start)}` : `Starts at ${formatTime(view.start)}`);
    view.strip.classList.remove("is-busy");
    // Once found, the words step aside after a moment so they don't cover
    // the bars; hovering the strip (or tapping the logo) brings them back.
    view.strip.classList.remove("is-quiet");
    clearTimeout(view.quietTimer);
    view.quietTimer = setTimeout(() => { view.strip?.classList.add("is-quiet"); showThumb(view, null); }, 4000);
    if (flash) {
      view.strip.classList.remove("is-found");
      void view.strip.offsetWidth; // restart the animation
      view.strip.classList.add("is-found");
    }
  }

  // While the server works, poll what it has scored so far.
  // What the server is doing, in words.
  function phaseText(progress) {
    const mb = (bytes) => Math.round((bytes || 0) / 1e6);
    switch (progress.phase) {
      case "downloading":
        return `Downloading the model, ${mb(progress.received)} of ${mb(progress.total)} MB (first time only)…`;
      case "waiting-download":
        return progress.error ? `The model download failed: ${progress.error}` : "Preparing to download the model (first time only)…";
      case "loading": return "Loading the model…";
      case "sampling": return "Looking through the scene…";
      case "zooming": return "Zooming in…";
      case "pinpointing": return "Pinpointing the start…";
      default: return "Finding where the action starts…";
    }
  }

  function watchProgress(view) {
    let stopped = false;
    (async () => {
      await sleep(250);
      while (!stopped && current === view && view.state === "busy") {
        try {
          const progress = await operation({ op: "progress", scene_id: view.id });
          if (!stopped && progress.phase && (await ensureStrip(view))) {
            view.strip.classList.add("is-busy");
            labelStrip(view, phaseText(progress));
            if (progress.samples?.length) { view.watched = true; paintStrip(view, progress); }
          }
        } catch (error) { /* the result itself will arrive or fail */ }
        await sleep(200);
      }
    })();
    return () => { stopped = true; };
  }

  // Look the start point up (or work it out) and keep the view in step.
  function resolve(view) {
    if (view.promise) return view.promise;
    const stopWatching = view.state === "busy" ? watchProgress(view) : () => {};
    view.promise = startPoint(view.id).then(
      async (result) => {
        stopWatching();
        view.target = Math.max(0, result.start - (await leadIn()));
        view.marked = Boolean(result.marked);
        view.start = result.start;
        view.duration = result.duration;
        view.samples = result.samples || [];
        view.threshold = result.threshold;
        view.state = "ready";
        render();
        showStart(view, true).catch(() => {}).finally(() => watchTimeline(view));
        return view.target;
      },
      (error) => {
        stopWatching();
        view.state = "error";
        view.error = error.message;
        view.promise = null;
        render();
        // The strip stops saying it is working and says why instead.
        if (view.strip) {
          view.strip.classList.remove("is-busy");
          labelStrip(view, `Auto Seek: ${error.message}`);
        }
        throw error;
      },
    );
    return view.promise;
  }

  // Hold playback until the start point is known, then jump there and play,
  // so the intro never plays while the analysis runs. Browsers only allow
  // audible playback straight after a tap, so a paused player is started and
  // stopped at once while the tap still counts; that lets the later play()
  // through. Gives up after `maxWaitMs` and plays from where it is.
  async function playFromStart(view, maxWaitMs) {
    const { video } = view;
    view.holding = true;
    view.tookOver = false;
    view.userSeeked = false;
    render();
    if (video.paused) await Promise.race([playVideo(view).catch(() => {}), sleep(1000)]);
    pauseVideo(view);
    // Stash's player may jump to the scene's resume point when playback
    // first starts; that is not the viewer moving.
    view.userSeeked = false;
    const target = await Promise.race([resolve(view).catch(() => null), sleep(maxWaitMs).then(() => null)]);
    view.holding = false;
    if (current !== view) return;
    // Jump unless the viewer moved on their own meanwhile, or is already past
    // the start (a resume point beyond the intro wins).
    if (target != null && !view.userSeeked && timeOf(view) < target) seekPlayer(view, target, true);
    // Playing, or the viewer pressed play or pause themselves while it waited:
    // leave play and pause alone.
    if (!video.paused || view.tookOver) {
      render();
      return;
    }
    try {
      await playVideo(view);
    } catch (error) {
      view.needsTap = target != null;
    }
    render();
  }

  function onSkip(event) {
    event.stopPropagation();
    const view = current;
    if (!view || view.holding) return;
    const { video } = view;
    if (view.needsTap) {
      view.needsTap = false;
      playVideo(view).catch(() => {});
      render();
      return;
    }
    if (view.state === "error") { view.state = "busy"; render(); }
    if (view.target != null) {
      seekPlayer(view, view.target, true);
      if (video.paused) playVideo(view).catch(() => {});
      return;
    }
    if (video.paused) {
      playFromStart(view, 60000);
      return;
    }
    // Already playing: keep going and jump once the start is known.
    view.userSeeked = false;
    resolve(view).then((target) => {
      if (current === view && !view.userSeeked && timeOf(view) < target) seekPlayer(view, target, true);
    }, () => {});
  }

  async function onFirstPlay(view) {
    if (view.autoDone || view.holding) return;
    view.autoDone = true;
    const { plugin } = await settings();
    if (plugin.autoSkip !== true || timeOf(view) > 15) return;
    if (view.target != null) {
      if (!view.userSeeked && timeOf(view) < view.target - 2) seekPlayer(view, view.target, true);
      return;
    }
    playFromStart(view, 30000);
  }

  function attach(id, video, bar) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vjs-control vjs-button auto-seek-button";
    button.innerHTML = `${TARGET_ICON}<span class="vjs-control-text"></span>`;
    bar.insertBefore(button, bar.querySelector(".vjs-fullscreen-control"));
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "vjs-control vjs-button auto-seek-mark";
    marker.title = "The action starts here: skip to this point from now on";
    marker.innerHTML = `${FLAG_ICON}<span class="vjs-control-text">${marker.title}</span>`;
    bar.insertBefore(marker, button);
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "auto-seek-pill";
    pill.innerHTML = '<span class="auto-seek-pill-text">Skip intro</span> <span class="auto-seek-pill-arrow" aria-hidden="true">›</span>';
    video.closest(".video-js").appendChild(pill);
    const view = { id, video, button, marker, pill, state: "busy", target: null, error: null, promise: null, autoDone: false, ourSeek: false, userSeeked: false, holding: false, needsTap: false, dismissed: false };
    current = view;
    settings().then(({ plugin }) => {
      view.hideButton = plugin.hideSkipButton === true;
      button.style.display = view.hideButton ? "none" : "";
      render();
    });
    button.addEventListener("click", onSkip);
    marker.addEventListener("click", (event) => { event.stopPropagation(); markStart(view); });
    pill.addEventListener("click", onSkip);
    video.addEventListener("seeking", () => {
      if (view.ourSeek) view.ourSeek = false; else if (timeOf(view) > 1) view.userSeeked = true;
    });
    video.addEventListener("timeupdate", render);
    // The viewer pressing play or pause (a control, a tap on the picture, or
    // the keyboard) while playback is held ends the hold.
    const host = video.closest(".video-js");
    const takeOver = () => {
      if (!view.holding || view.tookOver) return;
      view.tookOver = true;
      view.holding = false;
      render();
    };
    // A tap on the picture only shows the controls on touch screens; with a
    // mouse, a click there toggles playback.
    const toggles = window.matchMedia?.("(pointer: fine)").matches
      ? ".vjs-play-control, .vjs-big-play-button, .vjs-tech, video"
      : ".vjs-play-control, .vjs-big-play-button";
    host.addEventListener("click", (event) => { if (event.target.closest(toggles)) takeOver(); }, true);
    host.addEventListener("keydown", (event) => { if (event.key === " " || event.key === "k") takeOver(); }, true);
    video.addEventListener("playing", () => onFirstPlay(view));
    render();
    // The strip shows at once, saying it is working, until bars arrive.
    ensureStrip(view).then((strip) => {
      if (strip && view.state === "busy") {
        strip.classList.add("is-busy");
        labelStrip(view, "Finding where the action starts…");
      } else if (strip && view.state === "error") {
        labelStrip(view, `Auto Seek: ${view.error}`);
      }
    }).catch(() => {});
    // Work it out right away, so a click finds the answer ready.
    resolve(view).catch(() => {});
  }

  let observer = null;
  function onLocation(pathname) {
    observer?.disconnect();
    observer = null;
    const id = sceneIdFrom(pathname);
    if (!id) {
      current = null;
      document.querySelectorAll(".auto-seek-strip, .auto-seek-timeline").forEach((element) => element.remove());
      return;
    }
    // Start right away; the player mounts a moment later and finds it running.
    startPoint(id).catch(() => {});
    const tryAttach = () => {
      const bar = document.querySelector(".video-js .vjs-control-bar");
      const video = document.querySelector(".video-js video");
      if (!bar || !video) return false;
      if (current?.id === id && current.button.isConnected && current.video === video) return true;
      bar.querySelector(".auto-seek-button")?.remove();
      bar.querySelector(".auto-seek-mark")?.remove();
      video.closest(".video-js").querySelector(".auto-seek-pill")?.remove();
      attach(id, video, bar);
      return true;
    };
    if (tryAttach()) return;
    observer = new MutationObserver(() => { if (tryAttach()) { observer.disconnect(); observer = null; } });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer?.disconnect(); observer = null; }, 30000);
  }

  // ── act timeline ───────────────────────────────────────────────────────

  // Under the player once the start is known: every act the model sees,
  // its score across the scene and where it first shows. The server scans
  // the whole scene in the background, left to right, and the timeline
  // fills in live (with a line where the scan is) while this page is open.
  // The lanes line up with the seek bar, as the scan chart's bars do.
  const TIMELINE_COLLAPSED_KEY = "auto-seek:timeline-collapsed";
  const TIMELINE_MORE_KEY = "auto-seek:timeline-more";
  const TIMELINE_POLL_MS = 1000;

  function stored(key) {
    try { return localStorage.getItem(key) === "1"; } catch (error) { return false; }
  }
  function store(key, on) {
    try { localStorage.setItem(key, on ? "1" : "0"); } catch (error) { /* this page only */ }
  }

  function ensureTimeline(view) {
    if (view.timeline?.isConnected) return view.timeline;
    const wrapper = view.video.closest(".video-wrapper");
    if (!wrapper?.parentElement) return null;
    document.querySelectorAll(".auto-seek-timeline").forEach((old) => old.remove());
    const panel = document.createElement("section");
    panel.className = "auto-seek-timeline";
    panel.classList.toggle("is-collapsed", stored(TIMELINE_COLLAPSED_KEY));
    panel.classList.toggle("shows-more", stored(TIMELINE_MORE_KEY));
    panel.innerHTML =
      '<div class="auto-seek-tl-top"><button type="button" class="auto-seek-tl-head">' +
      '<span class="auto-seek-tl-title">Acts</span> <span class="auto-seek-tl-status"></span>' +
      '<span class="auto-seek-tl-found" hidden></span><span class="auto-seek-tl-now" hidden>Now: <b></b></span>' +
      '<span class="auto-seek-tl-chevron" aria-hidden="true">▾</span></button></div>' +
      '<div class="auto-seek-tl-body"><div class="auto-seek-tl-rows"></div>' +
      '<button type="button" class="auto-seek-tl-more" hidden></button>' +
      '<span class="auto-seek-tl-scanline" hidden><i class="auto-seek-tl-scanthumb" hidden><b></b></i></span><span class="auto-seek-tl-playhead" hidden></span><span class="auto-seek-tl-cross" hidden></span>' +
      '<div class="auto-seek-tl-peek" hidden><span class="auto-seek-strip-peek-image"></span><span class="auto-seek-tl-peek-text"></span>' +
      '<span class="auto-seek-tl-peek-acts"></span></div></div>';
    const head = panel.querySelector(".auto-seek-tl-head");
    head.setAttribute("aria-expanded", String(!panel.classList.contains("is-collapsed")));
    head.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("is-collapsed");
      head.setAttribute("aria-expanded", String(!collapsed));
      store(TIMELINE_COLLAPSED_KEY, collapsed);
      if (!collapsed) alignTimeline(view);
    });
    panel.querySelector(".auto-seek-tl-more").addEventListener("click", () => {
      store(TIMELINE_MORE_KEY, panel.classList.toggle("shows-more"));
      if (view.tl) revealUpTo(view, view.tl.shown);
      else if (view.timelineAnswer) paintTimeline(view, view.timelineAnswer);
    });
    const rows = panel.querySelector(".auto-seek-tl-rows");
    // A tap on a lane plays from there; on an act's name, from the act's next
    // stop (where it starts, then each later peak, then round again). When an
    // extension asks for it (see keepPaused), a paused video stays paused.
    // One-shot animations end for good: a row moved in the page would
    // otherwise replay them.
    rows.addEventListener("animationend", (event) => {
      const target = event.target;
      if (target.classList?.contains("pop")) target.classList.remove("pop");
      if (target.classList?.contains("ring")) target.classList.remove("ring");
      if (event.animationName === "auto-seek-tl-enter") target.closest(".auto-seek-tl-row")?.classList.remove("is-new");
    });
    rows.addEventListener("click", (event) => {
      if (current !== view) return;
      const chapter = event.target.closest(".auto-seek-tl-chapter");
      if (chapter) {
        seekPlayer(view, Number(chapter.dataset.from));
        view.userSeeked = true;
        if (view.video.paused && !view.keepPaused) playVideo(view).catch(() => {});
        return;
      }
      const name = event.target.closest(".auto-seek-tl-name");
      const lane = event.target.closest(".auto-seek-tl-lane");
      let time = null;
      if (name) {
        const act = name.closest(".auto-seek-tl-row").dataset.act;
        const stops = stopsOf(view, act);
        const stop = nextStop(stops, timeOf(view));
        if (!stop) return;
        const before = timeOf(view);
        seekPlayer(view, stop.time);
        view.userSeeked = true;
        if (view.video.paused && !view.keepPaused) playVideo(view).catch(() => {});
        const where = stops.length > 1 ? ` ${stop.index + 1}/${stops.length}` : "";
        toast(view, `${actLabel(act)}${where} · ${formatTime(stop.time)}${stop.wrapped && stops.length > 1 ? " (back to the first)" : ""}`,
          () => setTime(view, before));
        return;
      }
      if (lane && view.timelineDuration) {
        const box = lane.getBoundingClientRect();
        time = (Math.min(Math.max(event.clientX - box.left, 0), box.width) / box.width) * view.timelineDuration;
      }
      if (time == null) return;
      seekPlayer(view, time);
      view.userSeeked = true;
      if (view.video.paused && !view.keepPaused) playVideo(view).catch(() => {});
    });
    attachTimelinePeek(view, panel);
    // Below the player and its scrubber, not inside the player: Stash sizes
    // the player to the window, so rows added inside would shrink the video.
    const host = wrapper.closest(".scene-player-container");
    if (host) host.appendChild(panel); else (view.strip?.isConnected ? view.strip : wrapper).after(panel);
    // Where the details column sits below the navigation bar, for keeping it
    // pinned there while the page scrolls (see auto-seek.css).
    const tabs = host?.parentElement?.querySelector(":scope > .scene-tabs");
    if (tabs) document.documentElement.style.setProperty("--auto-seek-tabs-top", `${Math.max(0, tabs.getBoundingClientRect().top + window.scrollY)}px`);
    view.timeline = panel;
    view.video.addEventListener("timeupdate", () => movePlayhead(view));
    const playing = () => panel.classList.toggle("is-playing", !view.video.paused);
    for (const type of ["play", "pause", "ended"]) view.video.addEventListener(type, playing);
    playing();
    view.timelineResize?.disconnect();
    view.timelineResize = new ResizeObserver(() => alignTimeline(view));
    view.timelineResize.observe(panel);
    alignTimeline(view);
    emit(view, "panel");
    return panel;
  }

  // ── extensions ──
  // Another plugin can add to the timeline (the development tools in this
  // repository's auto-seek-dev/, which releases don't include) by pushing a
  // function onto window.AutoSeekExtensions, before or after this script
  // loads. It is called once per scene page with the API below and returns
  // handlers: panel() when the timeline panel is (re)built, rows() when rows
  // were added or redrawn.
  const extensions = (window.AutoSeekExtensions ||= []);

  function extensionApi(view) {
    return {
      sceneId: view.id,
      video: view.video,
      get panel() { return view.timeline; },
      get active() { return current === view; },
      get duration() { return view.timelineDuration; },
      get acts() { return view.timelineActs || []; },
      get frames() { return view.timelineFrames || []; },
      // While on, taps that move the video leave a paused video paused.
      keepPaused(on) { view.keepPaused = Boolean(on); },
      // To `time`, with the usual "Skipped to" toast (and Undo) unless quiet.
      seek(time, quiet = false) {
        if (quiet) setTime(view, time); else seekPlayer(view, time);
        view.userSeeked = true;
      },
      pause: () => pauseVideo(view),
      toast: (text, undo) => toast(view, text, undo),
      nearestFrame: (time) => nearestFrame(view, time),
      exactFrame: (time) => exactFrame(view.id, time),
      graphql,
      formatTime,
      actLabel,
    };
  }

  function emit(view, type) {
    if (!extensions.length || !view.timeline) return;
    view.extensions ||= new Map();
    for (const extension of extensions) {
      try {
        if (!view.extensions.has(extension)) view.extensions.set(extension, extension(extensionApi(view)) || {});
        const handlers = view.extensions.get(extension);
        if (type !== "panel" && !handlers.attached) { handlers.attached = true; handlers.panel?.(); }
        if (type === "panel") handlers.attached = true;
        handlers[type]?.();
      } catch (error) {
        console.error("Auto Seek extension:", error);
      }
    }
  }

  function alignTimeline(view) {
    movePlayhead(view);
  }

  // A line across the lanes at `time` (the playhead, or where the scan is).
  function placeLine(view, line, time) {
    if (!line || !view.timelineDuration || time == null) { if (line) line.hidden = true; return; }
    const lane = view.timeline.querySelector(".auto-seek-tl-lane");
    if (!lane) { line.hidden = true; return; }
    const body = line.parentElement.getBoundingClientRect();
    const box = lane.getBoundingClientRect();
    line.hidden = false;
    line.style.left = `${box.left - body.left + box.width * Math.min(1, Math.max(0, time / view.timelineDuration))}px`;
  }

  function movePlayhead(view) {
    const time = timeOf(view);
    placeLine(view, view.timeline?.querySelector(".auto-seek-tl-playhead"), time);
    showNow(view, time);
  }

  // What is on screen at `time`: the acts the model is sure of there light up
  // (the surest one named in the header), with the chapter it falls in and
  // how far each act's stops have got.
  function showNow(view, time) {
    const panel = view.timeline;
    if (!panel || !view.timelineActs) return;
    const spacing = view.timelineAnswer?.spacing || view.tl?.spacing || 10;
    const threshold = 100 * (view.timelineAnswer?.threshold ?? view.tl?.threshold ?? 0.8);
    const near = nearestFrame(view, time);
    const scores = near && Math.abs(near[0] - time) <= spacing ? near[1] : null;
    let best = null;
    for (const row of panel.querySelectorAll(".auto-seek-tl-row")) {
      const j = view.timelineActs.indexOf(row.dataset.act);
      const on = Boolean(scores) && j > 0 && scores[j] >= threshold;
      row.classList.toggle("is-now", on);
      if (on && !row.classList.contains("is-unsure") && (!best || scores[j] > best.score)) best = { act: row.dataset.act, score: scores[j] };
    }
    const chip = panel.querySelector(".auto-seek-tl-now");
    if (chip && chip.dataset.act !== (best?.act || "")) {
      chip.dataset.act = best?.act || "";
      chip.hidden = !best;
      if (best) {
        chip.style.setProperty("--as-c", actColour(best.act));
        const name = chip.querySelector("b");
        name.textContent = actLabel(best.act);
        name.classList.remove("is-new");
        void name.offsetWidth; // restart the animation
        name.classList.add("is-new");
      }
    }
    for (const chapter of panel.querySelectorAll(".auto-seek-tl-chapter")) {
      chapter.classList.toggle("is-now", time >= Number(chapter.dataset.from) && time < Number(chapter.dataset.to));
    }
    for (const row of panel.querySelectorAll(".auto-seek-tl-row[data-stops]")) {
      const passed = row.dataset.stops.split(",").filter((stop) => Number(stop) <= time + 0.5).length;
      row.querySelectorAll(".auto-seek-tl-dots i").forEach((dot, k) => dot.classList.toggle("on", k === passed - 1));
    }
  }

  // The top-act strip above the lanes, from the frames shown so far.
  function paintChapters(view, frames) {
    const box = view.timeline?.querySelector(".auto-seek-tl-chapters");
    const duration = view.timelineDuration;
    if (!box || !(duration > 0)) return;
    const answer = view.timelineAnswer || view.tl || {};
    const segments = chapters(frames, view.timelineActs || [], answer.threshold ?? 0.8, answer.spacing || 10);
    box.innerHTML = segments.map(({ act, from, to }) => {
      const width = (100 * (Math.min(to, duration) - from)) / duration;
      return `<button type="button" class="auto-seek-tl-chapter" data-act="${act}" data-from="${from}" data-to="${to}" ` +
        `style="left:${((100 * from) / duration).toFixed(2)}%;width:${width.toFixed(2)}%;--as-c:${actColour(act)}" ` +
        `title="${actLabel(act)} · ${formatTime(from)}">${width > 9 ? `<span>${actLabel(act)}</span>` : ""}</button>`;
    }).join("");
    box.hidden = box.previousElementSibling.hidden = !segments.length;
  }

  const CHAPTERS_HTML = '<span class="auto-seek-tl-chapters-label" hidden>Top act</span><div class="auto-seek-tl-chapters" hidden></div>';

  // An act's stops (see actStops) over the frames scanned so far (while a
  // scan runs, only those its line has revealed).
  function stopsOf(view, act) {
    const j = view.timelineActs?.indexOf(act) ?? -1;
    if (j < 0) return [];
    const limit = view.tl?.cursor ?? Infinity;
    const points = (view.timelineFrames || []).filter(([time]) => time <= limit).map(([time, scores]) => [time, scores[j] / 100]);
    const row = view.timeline?.querySelector(`.auto-seek-tl-row[data-act="${CSS.escape(act)}"]`);
    const first = row?.dataset.first ? Number(row.dataset.first) : null;
    const stops = actStops(points, first, TL_FLOOR, view.timelineThreshold);
    return stops.length || first == null ? stops : [first];
  }

  // Hovering a lane shows that moment: Stash's seek-bar thumbnail at once,
  // then the exact frame the scan scored nearest to it.
  function attachTimelinePeek(view, panel) {
    const rows = panel.querySelector(".auto-seek-tl-rows");
    const peek = panel.querySelector(".auto-seek-tl-peek");
    const image = peek.querySelector(".auto-seek-strip-peek-image");
    const text = peek.querySelector(".auto-seek-tl-peek-text");
    const others = peek.querySelector(".auto-seek-tl-peek-acts");
    const cross = panel.querySelector(".auto-seek-tl-cross");
    const hide = () => { peek.hidden = true; cross.hidden = true; };
    const show = async (event) => {
      const lane = event.target.closest(".auto-seek-tl-lane");
      const duration = view.timelineDuration;
      if (!lane || !duration) { hide(); return; }
      const box = lane.getBoundingClientRect();
      const time = ((event.clientX - box.left) / box.width) * duration;
      const j = view.timelineActs?.indexOf(lane.dataset.act) ?? -1;
      const near = nearestFrame(view, time); // nothing the scan line hasn't revealed yet
      if (!near || j < 0) { hide(); return; }
      const [at, scores] = near;
      text.textContent = `${actLabel(lane.dataset.act)} · ${formatTime(at)} · ${scores[j]}%`;
      // A line through every lane at that moment, and the other acts the
      // model saw there.
      placeLine(view, cross, at);
      const shown = new Set([...rows.querySelectorAll(".auto-seek-tl-lane")].filter((other) => other.offsetParent).map((other) => other.dataset.act));
      others.innerHTML = scores.map((percent, k) => [percent, view.timelineActs[k]])
        .filter(([percent, act], k) => k > 0 && k !== j && percent >= 100 * (view.timelineThreshold ?? 0.8) && shown.has(act))
        .sort((a, b) => b[0] - a[0]).slice(0, 3)
        .map(([percent, act]) => `<span style="--as-c:${actColour(act)}">${actLabel(act)} ${percent}%</span>`).join("");
      const body = peek.parentElement.getBoundingClientRect();
      const x = box.left - body.left + (box.width * at) / duration;
      peek.style.left = `${Math.min(Math.max(x, 85), body.width - 85)}px`;
      peek.style.top = `${box.top - body.top}px`;
      peek.hidden = false;
      peek.dataset.time = String(at);
      const exact = frameCache.get(`${view.id}:${at}`);
      if (typeof exact === "string") { showImage(image, { url: exact }); return; }
      const sprite = await sceneSprite(view.id);
      const cue = sprite && spriteCue(sprite.cues, at);
      if (peek.dataset.time !== String(at)) return;
      showImage(image, cue ? { url: sprite.sprite, cue } : null);
      clearTimeout(peekTimer);
      peekTimer = setTimeout(async () => {
        const url = await exactFrame(view.id, at);
        if (url && peek.dataset.time === String(at) && !peek.hidden) showImage(image, { url });
      }, 120);
    };
    rows.addEventListener("pointermove", show);
    rows.addEventListener("pointerdown", show);
    rows.addEventListener("pointerleave", hide);
  }

  // ── the scan, played back smoothly ──
  // The page stays one server update behind: a red line glides towards the
  // newest position at the pace the updates arrive, and the bars pop up as
  // it passes them; an act's row (and its first mark) appears once the line
  // reaches it. When the scan is done the line runs out to the end and the
  // final timeline (with its narrowed-down first marks) takes over.
  const TL_FLOOR = 0.5;

  function rowElement(view, name) {
    const row = document.createElement("div");
    row.className = "auto-seek-tl-row is-unsure is-new";
    row.dataset.act = name;
    row.style.setProperty("--as-c", actColour(name));
    row.innerHTML = nameButton(actLabel(name), null, false, 0) +
      `<div class="auto-seek-tl-lane" data-act="${name}"><svg viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true"></svg></div>`;
    return row;
  }

  // An act's name, with where it first shows, or, for an act without a
  // clear start, where it looked most likely ("~" and in italics); a tap
  // steps through its stops (see actStops).
  function nameButton(label, time, sure, peak, stops = 0) {
    const when = time == null ? "" : `${sure ? "" : "~"}${formatTime(time)}`;
    const title = time == null ? "" : sure
      ? `Tap to step through it: ${formatTime(time)}, where it first shows, then each later peak`
      : `No clear start (most likely at ${formatTime(time)}, ${Math.round(100 * peak)}%): tap to step through where it looked likely`;
    return `<button type="button" class="auto-seek-tl-name"${time == null ? "" : ` data-jump="${time}" title="${title}"`}>` +
      `<span class="auto-seek-tl-label">${label}</span><span class="auto-seek-tl-first">${when}</span>` +
      `${stops > 1 ? `<span class="auto-seek-tl-dots" aria-hidden="true">${"<i></i>".repeat(stops)}</span>` : ""}</button>`;
  }

  function setNameButton(row, label, time, sure, peak) {
    const holder = document.createElement("div");
    holder.innerHTML = nameButton(label, time, sure, peak);
    row.querySelector(".auto-seek-tl-name").replaceWith(holder.firstChild);
  }

  function addBar(svg, time, score, tl, pop) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", ((1000 * time) / tl.duration).toFixed(1));
    rect.setAttribute("y", (10 * (1 - score)).toFixed(2));
    rect.setAttribute("width", Math.max(1, (1000 * tl.spacing) / tl.duration).toFixed(1));
    rect.setAttribute("height", (10 * score).toFixed(2));
    if (score >= tl.threshold) rect.classList.add("hit");
    if (pop) rect.classList.add("pop");
    svg.appendChild(rect);
  }

  // Put a row where it belongs: acts with a start in the order they start,
  // then the unsure ones.
  function placeRow(list, row) {
    const key = (element) => (element.dataset.first ? Number(element.dataset.first) : Infinity);
    const before = [...list.querySelectorAll(":scope > .auto-seek-tl-row")].find((other) => other !== row && key(other) > key(row));
    if (before === row.nextElementSibling && row.parentElement === list) return;
    list.insertBefore(row, before || null);
  }

  // Move a row that is already showing to its new place, the rows between
  // sliding over (the rows are "display: contents", so their cells move).
  function slideRow(list, row) {
    const cells = [...list.querySelectorAll(":scope > .auto-seek-tl-row > *")];
    const tops = new Map(cells.map((cell) => [cell, cell.getBoundingClientRect().top]));
    placeRow(list, row);
    if (reducedMotion()) return;
    for (const cell of cells) {
      const shift = tops.get(cell) - cell.getBoundingClientRect().top;
      if (!shift) continue;
      cell.style.transition = "none";
      cell.style.transform = `translateY(${shift}px)`;
      requestAnimationFrame(() => {
        cell.style.transition = "transform 0.35s cubic-bezier(0.25, 0.8, 0.3, 1)";
        cell.style.transform = "";
      });
    }
  }

  function revealUpTo(view, upto) {
    const tl = view.tl;
    const list = view.timeline?.querySelector(".auto-seek-tl-rows");
    if (!tl || !list) return;
    list.querySelector(".auto-seek-tl-empty")?.remove();
    const revealed = tl.revealed.length;
    for (const [time, scores] of tl.frames) {
      if (time <= tl.shown || time > upto) continue;
      tl.revealed.push([time, scores]);
      scores.forEach((percent, j) => {
        if (j === 0) return;
        const name = tl.acts[j];
        const score = percent / 100;
        let row = tl.rows.get(name);
        if (!row && score < TL_FLOOR && !(tl.firsts[name] <= upto)) return;
        if (!row) {
          row = rowElement(view, name);
          tl.rows.set(name, row);
          const svg = row.querySelector("svg");
          for (const [past, pastScores] of tl.revealed) {
            addBar(svg, past, pastScores[j] / 100, tl, past === time);
            if (pastScores[j] / 100 > (Number(row.dataset.peak) || 0)) {
              row.dataset.peak = String(pastScores[j] / 100);
              setNameButton(row, actLabel(name), past, false, pastScores[j] / 100);
            }
          }
          placeRow(list, row);
        } else {
          addBar(row.querySelector("svg"), time, score, tl, true);
        }
        if (!row.dataset.first && score > (Number(row.dataset.peak) || 0)) {
          row.dataset.peak = String(score);
          setNameButton(row, actLabel(name), time, false, score);
        }
      });
    }
    // Starts the line has reached: the row moves up among the sure ones,
    // its start mark rings, and the count of acts found goes up.
    const showsMore = view.timeline.classList.contains("shows-more");
    for (const [name, row] of tl.rows) {
      const first = tl.firsts[name];
      if (first == null || first > upto || row.dataset.first) continue;
      const wasShown = showsMore || !row.classList.contains("is-unsure");
      row.dataset.first = String(first);
      row.classList.remove("is-unsure");
      setNameButton(row, actLabel(name), first, true, 0);
      const mark = document.createElement("i");
      mark.className = "auto-seek-tl-mark pop ring";
      mark.style.left = `${((100 * first) / tl.duration).toFixed(2)}%`;
      row.querySelector(".auto-seek-tl-lane").appendChild(mark);
      if (wasShown) slideRow(list, row);
      else { row.classList.add("is-new"); placeRow(list, row); } // it opens up in its place
      tl.found = (tl.found || 0) + 1;
      const badge = view.timeline.querySelector(".auto-seek-tl-found");
      badge.hidden = false;
      badge.textContent = `${tl.found} found`;
      badge.classList.remove("bump");
      void badge.offsetWidth; // restart the animation
      badge.classList.add("bump");
    }
    if (tl.revealed.length !== revealed) paintChapters(view, tl.revealed);
    if (tl.rows.size !== tl.paintedRows) {
      tl.paintedRows = tl.rows.size;
      emit(view, "rows");
    }
    tl.shown = upto;
    const unsure = [...tl.rows.values()].filter((row) => !row.dataset.first).length;
    const more = view.timeline.querySelector(".auto-seek-tl-more");
    more.hidden = !unsure;
    more.textContent = view.timeline.classList.contains("shows-more") ? "Show fewer" : `Show ${unsure} more (no clear start)`;
  }

  function animateScan(view) {
    const tl = view.tl;
    if (!tl || tl.raf) return;
    let last = performance.now();
    const step = (now) => {
      tl.raf = null;
      if (current !== view || view.tl !== tl) return;
      const dt = now - last;
      last = now;
      tl.cursor = Math.min(tl.target, tl.cursor + tl.speed * dt);
      revealUpTo(view, tl.cursor);
      placeLine(view, view.timeline.querySelector(".auto-seek-tl-scanline"), tl.cursor);
      scanThumb(view, tl.cursor);
      view.timeline.querySelector(".auto-seek-tl-status").textContent =
        `· scanning… ${Math.min(99, Math.round((100 * tl.cursor) / tl.duration))}%`;
      if (tl.cursor >= tl.target && tl.final) { finishScan(view); return; }
      tl.raf = requestAnimationFrame(step);
    };
    tl.raf = requestAnimationFrame(step);
  }

  // The frame under the scan line, riding on it: right of the line at the
  // start, left of it at the end, so it never leaves the panel.
  function scanThumb(view, time) {
    const thumb = view.timeline?.querySelector(".auto-seek-tl-scanthumb");
    if (!thumb || !view.timelineDuration) return;
    thumb.style.transform = `translateX(${(-100 * Math.min(1, Math.max(0, time / view.timelineDuration))).toFixed(1)}%)`;
    spriteThumb(view, thumb, time, 40); // auto-seek.css: 40 px tall
  }

  function finishScan(view) {
    const answer = view.tl.final;
    view.tl = null;
    paintTimeline(view, answer);
  }

  // A new answer from the server while it scans: aim the line at its
  // position, to arrive about when the next update is due.
  function followScan(view, answer) {
    const panel = ensureTimeline(view);
    if (!panel) return;
    const duration = answer.duration || view.duration || durationOf(view);
    if (!(duration > 0)) return;
    view.timelineDuration = duration;
    view.timelineActs = answer.acts;
    view.timelineThreshold = answer.threshold ?? 0.8;
    view.timelineFrames = (answer.frames || []).filter(([, scores]) => scores).sort((a, b) => a[0] - b[0]);
    const spacing = answer.spacing || 10;
    const now = performance.now();
    const done = answer.state === "done" || answer.state === "failed";
    const position = done ? duration : Math.min(duration, (answer.position || 0) + spacing);
    let tl = view.tl;
    if (!tl) {
      // What was scanned before this page opened shows at once.
      panel.querySelector(".auto-seek-tl-rows").innerHTML = CHAPTERS_HTML;
      tl = view.tl = {
        acts: answer.acts, duration, spacing, threshold: answer.threshold ?? 0.8,
        rows: new Map(), revealed: [], shown: -1, cursor: position, target: position, speed: 0, at: now, final: null,
      };
      tl.frames = view.timelineFrames;
      tl.firsts = answer.firsts || {};
      revealUpTo(view, position);
      if (done) { tl.final = answer; finishScan(view); return; }
    } else {
      tl.frames = view.timelineFrames;
      tl.firsts = { ...(answer.firsts || {}) };
      if (position > tl.target || done) {
        // Paced on the last few gaps between updates, with some slack, so
        // the line rarely catches up and stops before the next one arrives.
        tl.gaps = [...(tl.gaps || []), Math.min(15000, Math.max(500, now - tl.at))].slice(-3);
        const expected = 1.25 * (tl.gaps.reduce((sum, gap) => sum + gap, 0) / tl.gaps.length);
        tl.target = Math.max(tl.target, position);
        tl.speed = Math.max(0, tl.target - tl.cursor) / (done ? 700 : expected);
        tl.at = now;
      }
      if (done) tl.final = answer;
    }
    panel.classList.add("is-scanning");
    animateScan(view);
  }

  // The scanned frame nearest to `time` (only those the scan line has revealed).
  function nearestFrame(view, time) {
    const limit = view.tl?.cursor ?? Infinity;
    let near = null;
    for (const frame of view.timelineFrames || []) {
      if (frame[0] <= limit && (!near || Math.abs(frame[0] - time) < Math.abs(near[0] - time))) near = frame;
    }
    return near;
  }

  function laneSvg(points, duration, threshold, spacing) {
    // One bar per frame, a frame step wide, at a fixed place on the lane.
    const width = Math.max(1, (1000 * spacing) / duration);
    const bars = points.map(([time, score]) => {
      const cls = score >= threshold ? ' class="hit"' : "";
      return `<rect${cls} x="${((1000 * time) / duration).toFixed(1)}" y="${(10 * (1 - score)).toFixed(2)}" width="${width.toFixed(1)}" height="${(10 * score).toFixed(2)}"/>`;
    });
    return `<svg viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true">${bars.join("")}</svg>`;
  }

  function paintTimeline(view, answer) {
    const panel = ensureTimeline(view);
    if (!panel) return;
    view.timelineAnswer = answer;
    view.timelineActs = answer.acts;
    view.timelineThreshold = answer.threshold ?? 0.8;
    view.timelineFrames = (answer.frames || []).filter(([, scores]) => scores).sort((a, b) => a[0] - b[0]);
    const rows = timelineRows(answer);
    view.timelineRows = rows;
    // The scene's length from the player when the server has none yet, so
    // the lanes keep one scale from the first frame on.
    view.timelineDuration = answer.duration || view.duration || durationOf(view);
    const found = rows.filter((row) => row.first != null);
    const unsure = rows.length - found.length;
    const scanning = answer.state === "scanning" || answer.state === "queued";
    panel.querySelector(".auto-seek-tl-status").textContent = {
      queued: "· waiting to scan the whole scene…",
      scanning: `· scanning… ${Math.min(99, Math.round((100 * (answer.scanned || 0)) / (answer.planned || 1)))}%`,
      failed: `· the scan failed: ${answer.error || "unknown error"}`,
      done: found.length ? `· ${found.length} found` : "· none found",
    }[answer.state] || "";
    panel.classList.toggle("is-scanning", scanning);
    panel.querySelector(".auto-seek-tl-found").hidden = true;
    const more = panel.querySelector(".auto-seek-tl-more");
    more.hidden = !unsure;
    more.textContent = panel.classList.contains("shows-more") ? "Show fewer" : `Show ${unsure} more (no clear start)`;
    const duration = view.timelineDuration;
    const list = panel.querySelector(".auto-seek-tl-rows");
    if (!rows.length || !(duration > 0)) {
      list.innerHTML = answer.state === "done" ? '<p class="auto-seek-tl-empty">The model didn\'t see any act clearly in this scene.</p>' : "";
    } else {
      list.innerHTML = CHAPTERS_HTML + rows.map((row) => {
        const sure = row.first != null;
        const mark = sure ? `<i class="auto-seek-tl-mark" style="left:${((100 * row.first) / duration).toFixed(2)}%"></i>` : "";
        const stops = sure ? actStops(row.points, row.first, TL_FLOOR, answer.threshold ?? 0.8) : [];
        return `<div class="auto-seek-tl-row${sure ? "" : " is-unsure"}" data-act="${row.name}"${sure ? ` data-first="${row.first}"` : ""}` +
          `${stops.length > 1 ? ` data-stops="${stops.join(",")}"` : ""} style="--as-c:${actColour(row.name)}">` +
          nameButton(row.label, sure ? row.first : row.peakAt, sure, row.peak, stops.length) +
          `<div class="auto-seek-tl-lane" data-act="${row.name}">${laneSvg(row.points, duration, answer.threshold ?? 0.8, answer.spacing || 10)}${mark}</div></div>`;
      }).join("");
    }
    paintChapters(view, view.timelineFrames);
    placeLine(view, panel.querySelector(".auto-seek-tl-scanline"), null);
    emit(view, "rows");
    movePlayhead(view);
  }

  function watchTimeline(view) {
    if (view.timelineWatching) return;
    view.timelineWatching = true;
    (async () => {
      while (current === view) {
        let answer;
        try {
          answer = await operation({ op: "timeline", scene_id: view.id });
        } catch (error) {
          await sleep(5 * TIMELINE_POLL_MS);
          continue;
        }
        if (current !== view) break;
        if (answer.state === "off") { view.timeline?.remove(); break; }
        if (answer.state === "scanning" || view.tl) followScan(view, answer);
        else paintTimeline(view, answer);
        if (answer.state === "done" || answer.state === "failed") break;
        await sleep(TIMELINE_POLL_MS);
      }
      view.timelineWatching = false;
    })();
  }

  // ── settings page ──────────────────────────────────────────────────────

  // Auto Seek's group under Settings → Plugins: the start and the model get
  // a dropdown and a searchable grid of acts in place of the plain text and
  // on/off fields; the other settings stay Stash's own.
  const OWN_SETTINGS = new Set(["startStage", "accurateModel"]);
  const MODEL_OPTIONS = [
    { value: "fast", label: "Fast (ViT-B/32)", note: "The default. About 0.15 s a frame on two CPU threads." },
    { value: "accurate", label: "Accurate (ViT-B/16)", note: "Finds starts a little more accurately, about four times as slowly (0.6 s a frame). Downloads in place of the fast model." },
  ];

  function StartSettings({ pluginID }) {
    const { React, libraries } = window.PluginApi;
    const h = React.createElement;
    const Select = libraries.ReactSelect.default;
    const { plugins, savePluginSettings } = window.PluginApi.hooks.useSettings();
    const values = plugins?.[pluginID] || {};
    const [query, setQuery] = React.useState("");
    const start = readStart(values.startStage);
    const preset = PRESETS.find((candidate) => candidate.key === start.preset);

    function save(change) {
      savePluginSettings(pluginID, { ...values, ...change });
      known.clear(); // starts this tab remembered may be for the old choice
    }
    const saveActs = (acts) => save({ startStage: writeStart(acts) });
    function toggle(name) {
      const on = start.acts.includes(name);
      if (on && start.acts.length === 1) return; // something has to count
      saveActs(on ? start.acts.filter((act) => act !== name) : [...start.acts, name]);
    }

    const optionLabel = (option, { context }) => context === "value"
      ? option.label
      : h("div", { className: "auto-seek-option" },
        h("div", null, option.label, option.experimental ? h("span", { className: "auto-seek-badge" }, "Experimental") : null),
        option.note ? h("div", { className: "auto-seek-option-note" }, option.note) : null);
    const selectProps = {
      classNamePrefix: "react-select",
      className: "auto-seek-select",
      menuPortalTarget: document.body,
      formatOptionLabel: optionLabel,
      components: { IndicatorSeparator: () => null },
    };
    const startOptions = PRESETS.map((candidate) => ({ value: candidate.key, ...candidate }));
    const ownPick = { value: "", label: `Your own pick · ${start.acts.length} ${start.acts.length === 1 ? "act" : "acts"}`, note: "Tap acts below to change it.", experimental: true };
    if (!preset) startOptions.push(ownPick);

    const groups = ACT_GROUPS.map((group) => ({ ...group, shown: group.acts.filter((act) => actMatches(act, group.name, query)) }))
      .filter((group) => group.shown.length);
    const shown = groups.flatMap((group) => group.shown);
    const note = preset
      ? (preset.experimental ? "Experimental: foreplay and tease are the hardest to tell apart from an intro." : null)
      : "Experimental: the start is the first frame that shows one of your acts. Short or rare acts (69, titjob, fingering, tease) are found less reliably.";

    return h("div", { className: "auto-seek-settings" },
      h("div", { className: "setting auto-seek-start" },
        h("div", null,
          h("h3", null, "Start at"),
          h("div", { className: "sub-heading" },
            "Auto Seek skips to the first moment that shows one of the highlighted acts. Pick a stage, or tap acts to make your own pick. Changing it works out start points again; starts you marked stay.")),
        h("div", null, h(Select, {
          ...selectProps,
          inputId: "auto-seek-start-select",
          options: startOptions,
          value: preset ? startOptions.find((option) => option.value === preset.key) : ownPick,
          onChange: (option) => option?.value && save({ startStage: option.value }),
        }))),
      h("div", { className: "auto-seek-acts" },
        h("div", { className: "auto-seek-acts-bar" },
          h("input", {
            type: "search",
            className: "form-control auto-seek-search",
            placeholder: "Search acts: doggy, cum, kissing…",
            "aria-label": "Search acts",
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter" && shown.length === 1) { event.preventDefault(); toggle(shown[0][0]); }
              if (event.key === "Escape") setQuery("");
            },
          }),
          h("span", { className: "auto-seek-count" }, `${start.acts.length} of ${ALL_ACTS.length} acts count`)),
        note ? h("div", { className: "auto-seek-note" }, note) : null,
        groups.length ? null : h("div", { className: "auto-seek-empty" }, `No act matches “${query}”.`),
        ...groups.map((group) => {
          const names = group.acts.map(([name]) => name);
          const all = names.every((name) => start.acts.includes(name));
          return h("div", { className: "auto-seek-group", key: group.name },
            h("button", {
              type: "button",
              className: "auto-seek-group-name",
              title: all ? `Don't count ${group.name.toLowerCase()}` : `Count all ${group.name.toLowerCase()}`,
              onClick: () => {
                const rest = start.acts.filter((name) => !names.includes(name));
                if (!all) saveActs([...rest, ...names]);
                else if (rest.length) saveActs(rest);
              },
            }, group.name),
            h("div", { className: "auto-seek-chips" }, ...group.shown.map(([name, label]) => {
              const on = start.acts.includes(name);
              return h("button", {
                type: "button",
                key: name,
                className: `auto-seek-chip${on ? " is-on" : ""}`,
                "aria-pressed": on,
                title: on && start.acts.length === 1 ? "At least one act has to count" : undefined,
                onClick: () => toggle(name),
              }, label);
            })));
        })),
      h("div", { className: "setting auto-seek-model" },
        h("div", null,
          h("h3", null, "Model"),
          h("div", { className: "sub-heading" }, "Only the chosen model is downloaded (about 90 MB). Changing it works out start points again.")),
        h("div", null, h(Select, {
          ...selectProps,
          inputId: "auto-seek-model-select",
          isSearchable: false,
          options: MODEL_OPTIONS,
          value: MODEL_OPTIONS[values.accurateModel === true ? 1 : 0],
          onChange: (option) => option && save({ accurateModel: option.value === "accurate" }),
        }))));
  }

  // Stash's PluginSettings (v0.27+): Auto Seek's own panel, then Stash's
  // fields for the remaining settings. Other plugins' settings, extra
  // arguments and other patches pass through untouched.
  window.PluginApi?.patch?.instead?.("PluginSettings", function (...args) {
    const next = args.pop();
    const [props, ...rest] = args;
    if (props?.pluginID !== PLUGIN_ID || !window.PluginApi.hooks?.useSettings || !window.PluginApi.libraries?.ReactSelect) {
      return next.apply(this, args);
    }
    const { React } = window.PluginApi;
    const native = next.apply(this, [{ ...props, settings: (props.settings || []).filter((setting) => !OWN_SETTINGS.has(setting.name)) }, ...rest]);
    return React.createElement(React.Fragment, null, React.createElement(StartSettings, { pluginID: props.pluginID }), native);
  });

  window.PluginApi?.Event?.addEventListener("stash:location", (event) => onLocation(event.detail.data.location.pathname));
  onLocation(location.pathname);
  setTimeout(() => ensureServerFiles().catch((error) => console.warn("Auto Seek:", error.message)), 3000);
})();
