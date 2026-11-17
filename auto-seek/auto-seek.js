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
    const { video } = view;
    const start = video.currentTime;
    const duration = Math.max(video.duration || 0, start);
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
    const before = view.target == null ? view.video.currentTime < 120 : view.video.currentTime < view.target - 2;
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

  function seekPlayer(view, time) {
    const before = view.video.currentTime;
    setTime(view, time);
    view.dismissed = true;
    render();
    toast(view, `Skipped to ${formatTime(time)}`, () => setTime(view, before));
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
      '<div class="auto-seek-strip-bars"><span class="auto-seek-strip-line"></span><b class="auto-seek-strip-flag" hidden></b></div>' +
      `<span class="auto-seek-strip-label">${STRIP_ICON}<span></span></span>` +
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
    if (threshold != null && score >= threshold) bar.className = "hit";
    bar.style.left = `${Math.min(100, Math.max(0, (100 * time) / duration))}%`;
    bar.style.height = `${22 + 78 * score}%`; // a visible stub even at 0
    bar.dataset.time = time;
    bar.dataset.score = score;
    bars.appendChild(bar);
    view.stripTimer = setTimeout(() => drainStrip(view, bars, pace), pace);
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
    const label = view.strip?.querySelector(".auto-seek-strip-label span");
    if (label) label.textContent = text;
  }

  async function showStart(view, flash) {
    if (!view.samples?.length || !(await ensureStrip(view))) return;
    // A cached answer fills in quickly; a live one keeps its pace.
    paintStrip(view, { samples: view.samples, duration: view.duration, threshold: view.threshold }, view.stripDrawn ? 90 : 25);
    await stripSettled(view);
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
    view.quietTimer = setTimeout(() => view.strip?.classList.add("is-quiet"), 4000);
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
            if (progress.samples?.length) paintStrip(view, progress);
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
    if (target != null && !view.userSeeked && video.currentTime < target) seekPlayer(view, target);
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
      seekPlayer(view, view.target);
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
      if (current === view && !view.userSeeked && video.currentTime < target) seekPlayer(view, target);
    }, () => {});
  }

  async function onFirstPlay(view) {
    if (view.autoDone || view.holding) return;
    view.autoDone = true;
    const { plugin } = await settings();
    if (plugin.autoSkip !== true || view.video.currentTime > 15) return;
    if (view.target != null) {
      if (!view.userSeeked && view.video.currentTime < view.target - 2) seekPlayer(view, view.target);
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
      if (view.ourSeek) view.ourSeek = false; else if (video.currentTime > 1) view.userSeeked = true;
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
      '<span class="auto-seek-tl-chevron" aria-hidden="true">▾</span></button>' +
      '<button type="button" class="auto-seek-tl-review" aria-pressed="false" hidden ' +
      'title="Review: tap a lane once for &quot;wrong, not this act here&quot;, twice for &quot;right, it is here&quot;, a third time to clear">Review</button></div>' +
      '<p class="auto-seek-tl-review-help" hidden>Go to a moment (play, or tap a lane), then judge it on an act\'s row: ' +
      '<b class="no">✗</b> not this act here, <b class="yes">✓</b> it is here. It marks the frame you are looking at; press again to take it back.</p>' +
      '<div class="auto-seek-tl-body"><div class="auto-seek-tl-rows"></div>' +
      '<button type="button" class="auto-seek-tl-more" hidden></button>' +
      '<span class="auto-seek-tl-scanline" hidden></span><span class="auto-seek-tl-playhead" hidden></span>' +
      '<div class="auto-seek-tl-peek" hidden><span class="auto-seek-strip-peek-image"></span><span class="auto-seek-tl-peek-text"></span></div></div>';
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
    const review = panel.querySelector(".auto-seek-tl-review");
    settings().then(({ plugin }) => { review.hidden = plugin.enableReview !== true; });
    review.addEventListener("click", () => {
      view.reviewing = !view.reviewing;
      review.setAttribute("aria-pressed", String(view.reviewing));
      panel.classList.toggle("is-reviewing", view.reviewing);
      panel.querySelector(".auto-seek-tl-review-help").hidden = !view.reviewing;
    });
    const rows = panel.querySelector(".auto-seek-tl-rows");
    // A tap on a lane plays from there; on an act's name, from where it first
    // shows. In review mode a tap on a lane marks that frame instead.
    rows.addEventListener("click", (event) => {
      if (current !== view) return;
      const name = event.target.closest(".auto-seek-tl-name");
      const lane = event.target.closest(".auto-seek-tl-lane");
      const judge = event.target.closest(".auto-seek-tl-judge button");
      if (judge) { judgeHere(view, judge.closest(".auto-seek-tl-row").dataset.act, Number(judge.dataset.verdict)); return; }
      let time = null;
      if (name?.dataset.jump) time = Number(name.dataset.jump);
      else if (lane && view.timelineDuration) {
        const box = lane.getBoundingClientRect();
        time = (Math.min(Math.max(event.clientX - box.left, 0), box.width) / box.width) * view.timelineDuration;
      }
      if (time == null) return;
      seekPlayer(view, time);
      view.userSeeked = true;
      if (view.video.paused) playVideo(view).catch(() => {});
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
    view.timelineResize?.disconnect();
    view.timelineResize = new ResizeObserver(() => alignTimeline(view));
    view.timelineResize.observe(panel);
    alignTimeline(view);
    return panel;
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
    placeLine(view, view.timeline?.querySelector(".auto-seek-tl-playhead"), view.video.currentTime);
  }

  // Hovering a lane shows that moment: Stash's seek-bar thumbnail at once,
  // then the exact frame the scan scored nearest to it.
  function attachTimelinePeek(view, panel) {
    const rows = panel.querySelector(".auto-seek-tl-rows");
    const peek = panel.querySelector(".auto-seek-tl-peek");
    const image = peek.querySelector(".auto-seek-strip-peek-image");
    const text = peek.querySelector(".auto-seek-tl-peek-text");
    const show = async (event) => {
      const lane = event.target.closest(".auto-seek-tl-lane");
      const duration = view.timelineDuration;
      if (!lane || !duration) { peek.hidden = true; return; }
      const box = lane.getBoundingClientRect();
      const time = ((event.clientX - box.left) / box.width) * duration;
      const j = view.timelineActs?.indexOf(lane.dataset.act) ?? -1;
      const near = nearestFrame(view, time); // nothing the scan line hasn't revealed yet
      if (!near || j < 0) { peek.hidden = true; return; }
      const [at, scores] = near;
      text.textContent = `${actLabel(lane.dataset.act)} · ${formatTime(at)} · ${scores[j]}%`;
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
    rows.addEventListener("pointerleave", () => { peek.hidden = true; });
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
    row.className = "auto-seek-tl-row is-unsure";
    row.dataset.act = name;
    row.innerHTML = nameButton(actLabel(name), null, false, 0) + JUDGE +
      `<div class="auto-seek-tl-lane" data-act="${name}"><svg viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true"></svg></div>`;
    return row;
  }

  // An act's name: plays from where it first shows, or, for an act without
  // a clear start, from where it looked most likely ("~" and in italics).
  // Review mode's buttons on each row: judge the act at the playhead.
  const JUDGE = '<span class="auto-seek-tl-judge"><button type="button" data-verdict="0" title="Not this act here (the frame you are looking at)">✗</button>' +
    '<button type="button" data-verdict="1" title="This act is here (the frame you are looking at)">✓</button></span>';

  function nameButton(label, time, sure, peak) {
    const when = time == null ? "" : `${sure ? "" : "~"}${formatTime(time)}`;
    const title = time == null ? "" : sure
      ? `Play from ${formatTime(time)}, where it first shows`
      : `No clear start: play from ${formatTime(time)}, where it looked most likely (${Math.round(100 * peak)}%)`;
    return `<button type="button" class="auto-seek-tl-name"${time == null ? "" : ` data-jump="${time}" title="${title}"`}>` +
      `<span class="auto-seek-tl-label">${label}</span><span class="auto-seek-tl-first">${when}</span></button>`;
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
    const before = [...list.children].find((other) => other !== row && key(other) > key(row));
    list.insertBefore(row, before || null);
  }

  function revealUpTo(view, upto) {
    const tl = view.tl;
    const list = view.timeline?.querySelector(".auto-seek-tl-rows");
    if (!tl || !list) return;
    list.querySelector(".auto-seek-tl-empty")?.remove();
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
    // Starts the line has reached: the row moves up among the sure ones.
    for (const [name, row] of tl.rows) {
      const first = tl.firsts[name];
      if (first == null || first > upto || row.dataset.first) continue;
      row.dataset.first = String(first);
      row.classList.remove("is-unsure");
      setNameButton(row, actLabel(name), first, true, 0);
      const mark = document.createElement("i");
      mark.className = "auto-seek-tl-mark pop";
      mark.style.left = `${((100 * first) / tl.duration).toFixed(2)}%`;
      row.querySelector(".auto-seek-tl-lane").appendChild(mark);
      placeRow(list, row);
    }
    if (view.reviews?.size && tl.rows.size !== tl.paintedRows) {
      tl.paintedRows = tl.rows.size; // new rows: put their marks on
      paintReviews(view);
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
      view.timeline.querySelector(".auto-seek-tl-status").textContent =
        `· scanning… ${Math.min(99, Math.round((100 * tl.cursor) / tl.duration))}%`;
      if (tl.cursor >= tl.target && tl.final) { finishScan(view); return; }
      tl.raf = requestAnimationFrame(step);
    };
    tl.raf = requestAnimationFrame(step);
  }

  function finishScan(view) {
    const answer = view.tl.final;
    view.tl = null;
    paintTimeline(view, answer);
    view.timeline?.querySelectorAll(".auto-seek-tl-mark").forEach((mark) => mark.classList.add("pop"));
  }

  // A new answer from the server while it scans: aim the line at its
  // position, to arrive about when the next update is due.
  function followScan(view, answer) {
    const panel = ensureTimeline(view);
    if (!panel) return;
    const duration = answer.duration || view.duration || view.video.duration;
    if (!(duration > 0)) return;
    view.timelineDuration = duration;
    view.timelineActs = answer.acts;
    view.timelineFrames = (answer.frames || []).filter(([, scores]) => scores).sort((a, b) => a[0] - b[0]);
    const spacing = answer.spacing || 10;
    const now = performance.now();
    const done = answer.state === "done" || answer.state === "failed";
    const position = done ? duration : Math.min(duration, (answer.position || 0) + spacing);
    let tl = view.tl;
    if (!tl) {
      // What was scanned before this page opened shows at once.
      panel.querySelector(".auto-seek-tl-rows").innerHTML = "";
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
    if (answer.reviews) setReviews(view, answer.reviews);
    panel.classList.add("is-scanning");
    animateScan(view);
  }

  // ── review mode: the viewer's verdicts, as labels for training ──
  // A tap cycles the scanned frame nearest to it: wrong (not this act
  // here), right (it is here), cleared. Saved on the server at once.
  function nearestFrame(view, time) {
    const limit = view.tl?.cursor ?? Infinity;
    let near = null;
    for (const frame of view.timelineFrames || []) {
      if (frame[0] <= limit && (!near || Math.abs(frame[0] - time) < Math.abs(near[0] - time))) near = frame;
    }
    return near;
  }

  // Mark the act at the frame on screen; the same verdict again within a
  // second takes the mark back.
  async function judgeHere(view, act, verdict) {
    const time = Math.round(view.video.currentTime * 100) / 100;
    view.reviews ||= new Map();
    const same = [...view.reviews].find(([key, value]) => {
      const at = Number(key.slice(key.lastIndexOf("|") + 1));
      return key.startsWith(`${act}|`) && value === verdict && Math.abs(at - time) <= 1;
    });
    const at = same ? Number(same[0].slice(same[0].lastIndexOf("|") + 1)) : time;
    const next = same ? null : verdict;
    const save = async (value) => {
      if (value == null) view.reviews.delete(`${act}|${at}`); else view.reviews.set(`${act}|${at}`, value);
      paintReviews(view);
      try {
        const answer = await operation({ op: "review", scene_id: view.id, t: at, act, verdict: value });
        setReviews(view, answer.reviews);
      } catch (error) {
        toast(view, `Couldn't save the mark: ${error.message}`);
      }
    };
    await save(next);
    const what = `${actLabel(act)} at ${formatTime(at)}`;
    toast(view, next == null ? `Mark taken back: ${what}` : `${next ? "✓" : "✗"} ${what}`, () => save(next == null ? verdict : null));
  }

  function setReviews(view, list) {
    view.reviews = new Map((list || []).map(([time, act, verdict]) => [`${act}|${time}`, verdict]));
    paintReviews(view);
  }

  function paintReviews(view) {
    const panel = view.timeline;
    if (!panel || !view.timelineDuration) return;
    panel.querySelectorAll(".auto-seek-tl-dot").forEach((dot) => dot.remove());
    for (const [key, verdict] of view.reviews || []) {
      const [act, time] = [key.slice(0, key.lastIndexOf("|")), Number(key.slice(key.lastIndexOf("|") + 1))];
      const lane = panel.querySelector(`.auto-seek-tl-lane[data-act="${CSS.escape(act)}"]`);
      if (!lane) continue;
      const dot = document.createElement("i");
      dot.className = `auto-seek-tl-dot ${verdict ? "yes" : "no"}`;
      dot.title = `${actLabel(act)} at ${formatTime(time)}: ${verdict ? "right, it is here" : "wrong, not here"}`;
      dot.style.left = `${((100 * time) / view.timelineDuration).toFixed(2)}%`;
      lane.appendChild(dot);
    }
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
    if (answer.reviews) view.reviews = new Map(answer.reviews.map(([time, act, verdict]) => [`${act}|${time}`, verdict]));
    view.timelineFrames = (answer.frames || []).filter(([, scores]) => scores).sort((a, b) => a[0] - b[0]);
    const rows = timelineRows(answer);
    view.timelineRows = rows;
    // The scene's length from the player when the server has none yet, so
    // the lanes keep one scale from the first frame on.
    view.timelineDuration = answer.duration || view.duration || view.video.duration;
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
    const more = panel.querySelector(".auto-seek-tl-more");
    more.hidden = !unsure;
    more.textContent = panel.classList.contains("shows-more") ? "Show fewer" : `Show ${unsure} more (no clear start)`;
    const duration = view.timelineDuration;
    const list = panel.querySelector(".auto-seek-tl-rows");
    if (!rows.length || !(duration > 0)) {
      list.innerHTML = answer.state === "done" ? '<p class="auto-seek-tl-empty">The model didn\'t see any act clearly in this scene.</p>' : "";
    } else {
      list.innerHTML = rows.map((row) => {
        const sure = row.first != null;
        const mark = sure ? `<i class="auto-seek-tl-mark" style="left:${((100 * row.first) / duration).toFixed(2)}%"></i>` : "";
        return `<div class="auto-seek-tl-row${sure ? "" : " is-unsure"}" data-act="${row.name}"${sure ? ` data-first="${row.first}"` : ""}>` +
          nameButton(row.label, sure ? row.first : row.peakAt, sure, row.peak) + JUDGE +
          `<div class="auto-seek-tl-lane" data-act="${row.name}">${laneSvg(row.points, duration, answer.threshold ?? 0.8, answer.spacing || 10)}${mark}</div></div>`;
      }).join("");
    }
    placeLine(view, panel.querySelector(".auto-seek-tl-scanline"), null);
    paintReviews(view);
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
