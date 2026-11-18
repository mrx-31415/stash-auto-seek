// Auto Seek (dev): review tools on Auto Seek's act timeline. A separate plugin
// that releases don't include; it hooks into Auto Seek's timeline through
// window.AutoSeekExtensions (see "extensions" in auto-seek.js).
//
// Review mode: mark an act as there (✓) or not (✗) at the frame on screen;
// the marks are labels for training. The review queue (built on the GPU box)
// lists new scenes and the spots in them where the model shown and a stronger
// one disagree: n jumps to the next spot, y / x mark its act there.
(function () {
  "use strict";
  if (window.__autoSeekDevLoaded) return;
  window.__autoSeekDevLoaded = true;

  const PLUGIN_ID = "auto-seek-dev";
  const REVIEWING_KEY = "auto-seek-dev:reviewing";
  const MARKS_CLOSED_KEY = "auto-seek-dev:marks-closed";
  const SPOT_DONE_S = 15; // a mark this close to a spot (same act) settles it

  function stored(key) {
    try { return localStorage.getItem(key) === "1"; } catch (error) { return false; }
  }
  function store(key, on) {
    try { localStorage.setItem(key, on ? "1" : "0"); } catch (error) { /* this page only */ }
  }

  let queuePromise = null;
  function loadQueue(api, fresh = false) {
    if (fresh || !queuePromise) queuePromise = run(api, { op: "queue" }).catch(() => ({ scenes: [] }));
    return queuePromise;
  }

  // This plugin's operations (`api` is unused: the navigation bar has none).
  async function run(api, args) {
    const response = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation AutoSeekDevOperation($args: Map!) { runPluginOperation(plugin_id: "${PLUGIN_ID}", args: $args) }`,
        variables: { args },
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors) throw new Error(payload.errors?.[0]?.message || `HTTP ${response.status}`);
    return payload.data.runPluginOperation;
  }

  // The next scene to review: the first in the queue with spots left (scanned
  // ones first, so it opens with its timeline), other than `here`.
  function nextQueued(queue, here = null) {
    const waiting = (queue?.scenes || []).filter((scene) => scene.left > 0 && scene.id !== here);
    return waiting.find((scene) => scene.ready) || waiting[0] || null;
  }

  // Once per page load: Auto Seek scans every queued scene that isn't yet,
  // in the background, so each opens ready.
  let prefetched = false;
  function prefetchAll() {
    if (prefetched) return;
    prefetched = true;
    run(null, { op: "prefetch" }).catch(() => {});
  }

  let active = null; // the scene page's review state, for the keyboard

  (window.AutoSeekExtensions ||= []).push((api) => {
    const state = { api, reviews: new Map(), reviewing: stored(REVIEWING_KEY), spots: [], spot: null, queue: null };
    active = state;
    api.keepPaused(state.reviewing);
    run(api, { op: "reviews", scene_id: api.sceneId }).then((answer) => setReviews(state, answer.reviews)).catch(() => {});
    loadQueue(api).then((queue) => {
      state.queue = queue;
      const scene = queue.scenes.find((item) => item.id === String(api.sceneId));
      state.spots = scene ? scene.spots.map((spot) => ({ ...spot })) : [];
      paintQueue(state);
      paintSpots(state);
    });
    return {
      panel: () => buildPanel(state),
      rows: () => { addJudges(state); paintReviews(state); paintSpots(state); },
    };
  });

  // ── the panel: Review switch, help, queue bar, marks grid ──
  function buildPanel(state) {
    const panel = state.api.panel;
    if (!panel || panel.querySelector(".auto-seek-tl-review")) return;
    const top = panel.querySelector(".auto-seek-tl-top");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "auto-seek-tl-review";
    button.textContent = "Review";
    button.title = "Review mode (dev): mark acts as there or not, as labels for training";
    top.appendChild(button);
    const help = document.createElement("p");
    help.className = "auto-seek-tl-review-help";
    help.innerHTML = "Go to a moment (play, or tap a lane), then judge it on an act's row: " +
      '<b class="no">✗</b> not this act here, <b class="yes">✓</b> it is here. It marks the frame you are looking at; ' +
      "press again to take it back.<span class=\"auto-seek-dev-keys\"> Queue: <kbd>n</kbd> next spot, <kbd>y</kbd> / <kbd>x</kbd> mark its act.</span>";
    top.after(help);
    const bar = document.createElement("div");
    bar.className = "auto-seek-dev-queue";
    help.after(bar);
    const marks = document.createElement("details");
    marks.className = "auto-seek-tl-marks";
    marks.hidden = true;
    marks.innerHTML = '<summary>Your marks <span class="auto-seek-tl-marks-count"></span></summary><div class="auto-seek-tl-marks-grid"></div>';
    marks.open = !stored(MARKS_CLOSED_KEY);
    panel.appendChild(marks);

    button.addEventListener("click", () => setReviewing(state, !state.reviewing));
    marks.addEventListener("toggle", () => { store(MARKS_CLOSED_KEY, !marks.open); loadMarkFrames(state); });
    marks.querySelector(".auto-seek-tl-marks-grid").addEventListener("click", (event) => onMarkCard(state, event));
    panel.querySelector(".auto-seek-tl-rows").addEventListener("click", (event) => {
      const judge = event.target.closest(".auto-seek-tl-judge button");
      if (!judge || !state.api.active) return;
      event.stopPropagation();
      judgeHere(state, judge.closest(".auto-seek-tl-row").dataset.act, Number(judge.dataset.verdict));
    });
    bar.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "next-spot") nextSpot(state);
      else if (action === "next-scene") nextScene(state);
      else if (action === "yes" || action === "no") markSpot(state, action === "yes" ? 1 : 0);
    });
    setReviewing(state, state.reviewing);
    addJudges(state);
    paintReviews(state);
    paintQueue(state);
    paintSpots(state);
  }

  function setReviewing(state, on) {
    state.reviewing = on;
    store(REVIEWING_KEY, on);
    state.api.keepPaused(on);
    paintCard(state);
    const panel = state.api.panel;
    if (!panel) return;
    panel.classList.toggle("is-reviewing", on);
    panel.querySelector(".auto-seek-tl-review")?.setAttribute("aria-pressed", String(on));
    loadMarkFrames(state);
  }

  // A ✗/✓ pair on each row, between its name and its lane (shown while reviewing).
  function addJudges(state) {
    for (const row of state.api.panel?.querySelectorAll(".auto-seek-tl-row") || []) {
      if (row.querySelector(".auto-seek-tl-judge")) continue;
      const judge = document.createElement("span");
      judge.className = "auto-seek-tl-judge";
      judge.innerHTML = '<button type="button" data-verdict="0" title="Not this act here (the frame you are looking at)">✗</button>' +
        '<button type="button" data-verdict="1" title="This act is here (the frame you are looking at)">✓</button>';
      row.querySelector(".auto-seek-tl-lane")?.before(judge);
    }
  }

  // ── marks ──
  // Mark the act at the frame on screen; the same verdict again within a
  // second takes the mark back.
  async function judgeHere(state, act, verdict) {
    const { api } = state;
    const time = Math.round(api.video.currentTime * 100) / 100;
    const same = [...state.reviews].find(([key, value]) => {
      const at = Number(key.slice(key.lastIndexOf("|") + 1));
      return key.startsWith(`${act}|`) && value === verdict && Math.abs(at - time) <= 1;
    });
    const at = same ? Number(same[0].slice(same[0].lastIndexOf("|") + 1)) : time;
    const next = same ? null : verdict;
    await saveMark(state, act, at, next);
    const what = `${api.actLabel(act)} at ${api.formatTime(at)}`;
    api.toast(next == null ? `Mark taken back: ${what}` : `${next ? "✓" : "✗"} ${what}`, () => saveMark(state, act, at, next == null ? verdict : null));
  }

  // Set (1 right, 0 wrong) or take back (null) one mark, on the page at once
  // and then on the server, whose list of marks then stands.
  async function saveMark(state, act, at, value) {
    if (value == null) state.reviews.delete(`${act}|${at}`); else state.reviews.set(`${act}|${at}`, value);
    paintReviews(state);
    try {
      const answer = await run(state.api, { op: "review", scene_id: state.api.sceneId, t: at, act, verdict: value });
      setReviews(state, answer.reviews);
    } catch (error) {
      state.api.toast(`Couldn't save the mark: ${error.message}`);
    }
  }

  function setReviews(state, list) {
    state.reviews = new Map((list || []).map(([time, act, verdict]) => [`${act}|${time}`, verdict]));
    paintReviews(state);
  }

  function marksOf(state) {
    return [...state.reviews].map(([key, verdict]) => {
      const cut = key.lastIndexOf("|");
      return { key, act: key.slice(0, cut), time: Number(key.slice(cut + 1)), verdict };
    }).sort((a, b) => a.time - b.time || a.act.localeCompare(b.act));
  }

  // A dot on the lane for each mark (red: wrong, green: right), then the grid.
  function paintReviews(state) {
    const { api } = state;
    const panel = api.panel;
    if (!panel || !api.duration) return;
    panel.querySelectorAll(".auto-seek-tl-dot").forEach((dot) => dot.remove());
    for (const mark of marksOf(state)) {
      const lane = panel.querySelector(`.auto-seek-tl-lane[data-act="${CSS.escape(mark.act)}"]`);
      if (!lane) continue;
      const dot = document.createElement("i");
      dot.className = `auto-seek-tl-dot ${mark.verdict ? "yes" : "no"}`;
      dot.title = `${api.actLabel(mark.act)} at ${api.formatTime(mark.time)}: ${mark.verdict ? "right, it is here" : "wrong, not here"}`;
      dot.style.left = `${((100 * mark.time) / api.duration).toFixed(2)}%`;
      lane.appendChild(dot);
    }
    settleSpots(state);
    renderMarks(state);
  }

  // Below the timeline while reviewing: each mark's exact frame, verdict,
  // act and time, in time order. A tap on the frame goes there (paused stays
  // paused); × takes the mark back.
  function renderMarks(state) {
    const { api } = state;
    const box = api.panel?.querySelector(".auto-seek-tl-marks");
    if (!box) return;
    const marks = marksOf(state);
    box.hidden = !marks.length;
    box.querySelector(".auto-seek-tl-marks-count").textContent = String(marks.length);
    const grid = box.querySelector(".auto-seek-tl-marks-grid");
    const cards = new Map([...grid.children].map((card) => [card.dataset.key, card]));
    marks.forEach((mark, i) => {
      let card = cards.get(mark.key);
      cards.delete(mark.key);
      if (!card) {
        card = document.createElement("figure");
        card.className = "auto-seek-mark-card";
        card.dataset.key = mark.key;
        card.dataset.act = mark.act;
        card.dataset.time = String(mark.time);
        card.innerHTML =
          `<button type="button" class="auto-seek-mark-shot" title="Go to ${api.formatTime(mark.time)}">` +
          `<img alt="" hidden><span class="auto-seek-mark-time">${api.formatTime(mark.time)}</span></button>` +
          '<figcaption><b></b> <span></span></figcaption>' +
          '<button type="button" class="auto-seek-mark-remove" title="Remove this mark" aria-label="Remove this mark">×</button>';
        card.querySelector("figcaption span").textContent = api.actLabel(mark.act);
      }
      card.classList.toggle("yes", mark.verdict === 1);
      card.classList.toggle("no", mark.verdict !== 1);
      card.dataset.verdict = String(mark.verdict);
      card.querySelector("figcaption b").textContent = mark.verdict === 1 ? "✓" : "✗";
      if (grid.children[i] !== card) grid.insertBefore(card, grid.children[i] || null);
    });
    for (const card of cards.values()) card.remove();
    loadMarkFrames(state);
  }

  // The frames, one at a time (each is an ffmpeg run on the server), and
  // only while the grid shows.
  function loadMarkFrames(state) {
    const box = state.api.panel?.querySelector(".auto-seek-tl-marks");
    if (!box || !box.open || !state.reviewing) return;
    for (const card of box.querySelectorAll(".auto-seek-mark-card:not([data-queued])")) {
      card.dataset.queued = "1";
      state.markFrames = (state.markFrames || Promise.resolve()).then(async () => {
        if (!card.isConnected) return;
        const url = await state.api.exactFrame(Number(card.dataset.time));
        const image = card.querySelector("img");
        if (url) { image.src = url; image.hidden = false; }
      });
    }
  }

  function onMarkCard(state, event) {
    const card = event.target.closest(".auto-seek-mark-card");
    if (!card || !state.api.active) return;
    const time = Number(card.dataset.time);
    if (event.target.closest(".auto-seek-mark-remove")) {
      const { act } = card.dataset;
      const verdict = Number(card.dataset.verdict);
      saveMark(state, act, time, null);
      state.api.toast(`Mark taken back: ${state.api.actLabel(act)} at ${state.api.formatTime(time)}`, () => saveMark(state, act, time, verdict));
    } else if (event.target.closest(".auto-seek-mark-shot")) {
      state.api.seek(time);
    }
  }

  // ── review queue ──
  // Spots: hollow rings on the lanes where the two models disagree; settled
  // ones (a mark for that act close by) fade.
  function settleSpots(state) {
    const marks = marksOf(state);
    for (const spot of state.spots) {
      spot.done = marks.some((mark) => mark.act === spot.act && Math.abs(mark.time - spot.t) <= SPOT_DONE_S);
    }
    paintQueue(state);
    paintSpots(state);
    paintCard(state);
  }

  function paintSpots(state) {
    const { api } = state;
    const panel = api.panel;
    if (!panel || !api.duration) return;
    panel.querySelectorAll(".auto-seek-dev-spot").forEach((ring) => ring.remove());
    // The current spot's act stands out (and shows even when it is one of
    // the acts without a clear start, which are otherwise folded away).
    panel.querySelectorAll(".auto-seek-tl-row.is-spot").forEach((row) => row.classList.remove("is-spot"));
    if (state.spot) panel.querySelector(`.auto-seek-tl-row[data-act="${CSS.escape(state.spot.act)}"]`)?.classList.add("is-spot");
    for (const spot of state.spots) {
      const lane = panel.querySelector(`.auto-seek-tl-lane[data-act="${CSS.escape(spot.act)}"]`);
      if (!lane) continue;
      const ring = document.createElement("i");
      ring.className = `auto-seek-dev-spot${spot.done ? " is-done" : ""}${spot === state.spot ? " is-current" : ""}`;
      ring.title = `${api.actLabel(spot.act)} at ${api.formatTime(spot.t)}: this model ${Math.round(100 * spot.yours)}%, the stronger one ${Math.round(100 * spot.teacher)}%`;
      ring.style.left = `${((100 * spot.t) / api.duration).toFixed(2)}%`;
      lane.appendChild(ring);
    }
  }

  function paintQueue(state) {
    const bar = state.api.panel?.querySelector(".auto-seek-dev-queue");
    if (!bar) return;
    const scenes = state.queue?.scenes || [];
    const waiting = scenes.filter((scene) => scene.left > 0 && scene.id !== String(state.api.sceneId));
    if (!scenes.length) { bar.hidden = true; return; }
    bar.hidden = false;
    const here = state.spots.length;
    const left = state.spots.filter((spot) => !spot.done).length;
    const position = scenes.findIndex((scene) => scene.id === String(state.api.sceneId));
    const parts = [`<b>Review queue</b> · ${waiting.length} more scene${waiting.length === 1 ? "" : "s"}`];
    if (here) parts.push(`this scene ${position + 1}/${scenes.length}: ${left} of ${here} spots left`);
    else parts.push("this scene isn't in it");
    const spot = state.spot;
    const now = spot ? ` · <span class="auto-seek-dev-now">${state.api.actLabel(spot.act)}: this model ${Math.round(100 * spot.yours)}%, stronger ${Math.round(100 * spot.teacher)}%</span>` : "";
    // Buttons for touch (the keys do the same): judge the spot's act at the
    // frame on screen, skip on, or go to the next scene.
    const judge = spot && !spot.done
      ? `<button type="button" class="no" data-action="no" title="${state.api.actLabel(spot.act)} isn't here (x)">✗ Not here</button>` +
        `<button type="button" class="yes" data-action="yes" title="${state.api.actLabel(spot.act)} is here (y)">✓ It's here</button>`
      : "";
    const step = here
      ? `<button type="button" data-action="next-spot"${left ? "" : " disabled"} title="Jump to the next spot (n)">${spot ? "Skip ▸" : "Next spot ▸"}</button>`
      : "";
    bar.innerHTML = `<span>${parts.join(" · ")}${now}</span>` +
      `<span class="auto-seek-dev-actions">${judge}${step}` +
      `<button type="button" data-action="next-scene"${waiting.length ? "" : " disabled"}>Next scene ▸</button></span>`;
  }

  // Judge the current spot's act at the frame on screen, then on to the next spot.
  function markSpot(state, verdict) {
    const spot = state.spot;
    if (!spot || state.marking) return;
    state.marking = true;
    const at = Math.round(state.api.video.currentTime * 100) / 100;
    flashCard(state, verdict, `${verdict ? "✓" : "✗"} ${state.api.actLabel(spot.act)}`);
    saveMark(state, spot.act, at, verdict).then(() => {
      // Long enough to see the answer land, then on to the next spot.
      setTimeout(() => {
        state.marking = false;
        if (state.spots.some((item) => !item.done)) nextSpot(state);
        else { state.spot = null; paintQueue(state); paintCard(state); state.api.toast("All spots in this scene are done"); }
      }, 450);
    });
  }

  // ── answering a spot: the card on the video, the pad under the thumb ──
  // The card sits over the top of the video (in fullscreen too) and asks
  // about the act, with what the two models say, so the eyes stay on the
  // picture. On a phone a pad at the bottom of the screen answers it within
  // reach of the thumb. Swipe right on the card, the video or the pad for
  // "it's here", left for "not here"; both follow the finger and colour as
  // the swipe gets far enough. Buttons on both do the same.
  const SWIPE_PX = 60; // far enough to count…
  const FLICK_PX = 30; // …or this far, quickly
  const FLICK_SPEED = 0.6; // px per ms

  function answerButtons() {
    return '<button type="button" class="auto-seek-dev-no" data-card="no" aria-label="Not here">✗</button>' +
      '<div class="auto-seek-dev-text"><b></b><small></small><em></em></div>' +
      '<button type="button" class="auto-seek-dev-yes" data-card="yes" aria-label="It\'s here">✓</button>' +
      '<button type="button" class="auto-seek-dev-skip" data-card="skip" aria-label="Skip this spot">Skip ›</button>';
  }

  function surfaces(state) {
    const host = state.api.video.closest(".video-js");
    return [host?.querySelector(".auto-seek-dev-card"), state.api.panel?.querySelector(".auto-seek-dev-pad")].filter(Boolean);
  }

  function ensureSurface(state, parent, className) {
    let element = parent.querySelector(`:scope > .${className}`);
    if (element) return element;
    element = document.createElement("div");
    element.className = className;
    element.innerHTML = answerButtons();
    // Taps on it stay off the player (which would play or pause).
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.dragged) { state.dragged = false; return; } // the end of a swipe, not a tap
      const what = event.target.closest("[data-card]")?.dataset.card;
      if (what === "yes" || what === "no") markSpot(state, what === "yes" ? 1 : 0);
      else if (what === "skip") nextSpot(state);
    });
    parent.appendChild(element);
    swipeable(state, element, false);
    return element;
  }

  function paintCard(state) {
    const { api } = state;
    const host = api.video.closest(".video-js");
    if (!host || state.marking) return; // while the answer shows, the next spot follows
    const spot = state.spot;
    const on = Boolean(spot && !spot.done && state.reviewing);
    host.classList.toggle("auto-seek-dev-swiping", on);
    if (!on) { surfaces(state).forEach((element) => element.remove()); return; }
    swipeable(state, host, true);
    const left = state.spots.filter((item) => !item.done).length;
    const elements = [ensureSurface(state, host, "auto-seek-dev-card")];
    if (api.panel) elements.push(ensureSurface(state, api.panel, "auto-seek-dev-pad"));
    for (const element of elements) {
      element.classList.remove("is-answered", "is-yes", "is-no", "lean-yes", "lean-no", "is-dragging");
      element.style.transform = "";
      element.querySelector("b").textContent = `${api.actLabel(spot.act)}?`;
      element.querySelector("small").textContent = `this model ${Math.round(100 * spot.yours)}% · stronger ${Math.round(100 * spot.teacher)}%`;
      element.querySelector("em").textContent = `${left} left · swipe ← not here · → it's here`;
    }
  }

  function flashCard(state, verdict, text) {
    for (const element of surfaces(state)) {
      element.classList.remove("lean-yes", "lean-no", "is-dragging");
      element.classList.add("is-answered", verdict ? "is-yes" : "is-no");
      element.style.transform = "";
      element.querySelector("b").textContent = text;
      element.querySelector("small").textContent = "saved";
      element.querySelector("em").textContent = "";
    }
  }

  // Follow the finger (dx in px), or settle back (null).
  function lean(state, dx) {
    for (const element of surfaces(state)) {
      const pad = element.classList.contains("auto-seek-dev-pad");
      element.classList.toggle("is-dragging", dx != null);
      element.classList.toggle("lean-yes", dx != null && dx >= SWIPE_PX);
      element.classList.toggle("lean-no", dx != null && dx <= -SWIPE_PX);
      const shift = dx == null ? 0 : Math.round(dx * (pad ? 0.8 : 0.6));
      element.style.transform = dx == null ? "" : pad
        ? `translateX(${shift}px)`
        : `translateX(calc(-50% + ${shift}px)) rotate(${(dx / 40).toFixed(1)}deg)`;
    }
  }

  // A sideways drag on `element` answers the current spot. Vertical drags are
  // left to the page (it scrolls); `touchOnly` leaves mouse clicks on the
  // video to the player.
  function swipeable(state, element, touchOnly) {
    if (element.dataset.autoSeekDevSwipe) return;
    element.dataset.autoSeekDevSwipe = "1";
    let drag = null;
    element.addEventListener("pointerdown", (event) => {
      if (touchOnly && event.pointerType === "mouse") return;
      // The nearest swipe surface takes it (the card sits inside the video).
      if (event.target.closest("[data-auto-seek-dev-swipe]") !== element) return;
      if (!event.isPrimary || !state.spot || !state.reviewing || state.marking) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, sideways: false, samples: [] };
    });
    element.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.sideways) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          drag.sideways = true;
          try { element.setPointerCapture(event.pointerId); } catch (error) { /* already gone */ }
        } else if (Math.abs(dy) > 12) { drag = null; return; } else return;
      }
      drag.samples = [...drag.samples, [event.timeStamp, event.clientX]].slice(-4);
      lean(state, dx);
    });
    const end = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { sideways, samples, x } = drag;
      drag = null;
      if (!sideways) return;
      state.dragged = true; // the click that follows is the swipe's end
      setTimeout(() => { state.dragged = false; }, 400);
      const dx = event.clientX - x;
      const [first, last] = [samples[0], samples[samples.length - 1]];
      const speed = first && last && last[0] > first[0] ? (last[1] - first[1]) / (last[0] - first[0]) : 0;
      const flick = Math.abs(dx) >= FLICK_PX && Math.abs(speed) >= FLICK_SPEED && Math.sign(speed) === Math.sign(dx);
      if (event.type === "pointerup" && (Math.abs(dx) >= SWIPE_PX || flick)) markSpot(state, dx > 0 ? 1 : 0);
      else lean(state, null);
    };
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  }

  // The next unsettled spot after the playhead (round to the first), paused
  // on its frame with its act's row picked out.
  function nextSpot(state) {
    const { api } = state;
    const open = state.spots.filter((spot) => !spot.done).sort((a, b) => a.t - b.t);
    if (!open.length) { api.toast("No spots left in this scene"); return; }
    const after = api.video.currentTime + 0.5;
    const spot = open.find((item) => item.t > after) || open[0];
    state.spot = spot;
    if (!state.reviewing) setReviewing(state, true);
    const go = () => { if (state.spot === spot) { api.seek(spot.t, true); api.pause(); } };
    if (api.video.readyState >= 1) go();
    else {
      // A phone loads nothing before the first play and ignores a seek until
      // then: start it (this tap allows that), then seek and pause.
      // Seeking first also tells Auto Seek the viewer chose where to be, so
      // its skip on the first play doesn't take over.
      api.seek(spot.t, true);
      api.video.addEventListener("loadedmetadata", go, { once: true });
      Promise.resolve(api.video.play()).catch(() => {});
    }
    paintQueue(state);
    paintSpots(state);
    paintCard(state);
  }

  async function nextScene(state) {
    const next = nextQueued(await loadQueue(state.api, true), String(state.api.sceneId));
    if (!next) { state.api.toast("The review queue is done"); return; }
    store(REVIEWING_KEY, true);
    window.location.assign(`/scenes/${next.id}`);
  }

  // ── entry point: "Review" in Stash's navigation bar ──
  // Shown while the queue has scenes left: opens the next one (scanned ones
  // first) with review mode on. Its page load also starts the background
  // scans of the queued scenes (see prefetchAll).
  const Api = window.PluginApi;
  if (Api?.patch?.after && Api.React) {
    const { React, libraries } = Api;
    const { Nav } = libraries.Bootstrap;
    const { NavLink } = libraries.ReactRouterDOM;
    const { FontAwesomeIcon } = libraries.ReactFontAwesome;
    const { faCheckCircle } = libraries.FontAwesomeSolid;
    const ReviewNavItem = () => {
      const [queue, setQueue] = React.useState(null);
      React.useEffect(() => {
        let live = true;
        const refresh = () => loadQueue(null, true).then((answer) => { if (live) setQueue(answer); });
        refresh();
        prefetchAll();
        const timer = setInterval(refresh, 60000);
        return () => { live = false; clearInterval(timer); };
      }, []);
      const waiting = (queue?.scenes || []).filter((scene) => scene.left > 0);
      const next = nextQueued(queue);
      if (!next) return null;
      const ready = waiting.filter((scene) => scene.ready).length;
      return React.createElement(
        Nav.Link,
        { as: "div", eventKey: "/auto-seek-review", className: "col-4 col-sm-3 col-md-2 col-lg-auto auto-seek-dev-nav" },
        React.createElement(
          NavLink,
          {
            to: `/scenes/${next.id}`,
            onClick: () => store(REVIEWING_KEY, true),
            title: `Review queue: ${waiting.length} scenes with spots left, ${ready} scanned and ready. Opens the next one in review mode.`,
            className: "btn minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center",
          },
          React.createElement(FontAwesomeIcon, { icon: faCheckCircle, className: "fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" }),
          React.createElement("span", null, `Review ${waiting.length}`),
        ),
      );
    };
    Api.patch.after("MainNavBar.MenuItems", function (props, ...args) {
      const result = args[args.length - 1];
      if (!React.isValidElement(result)) return result;
      const children = React.Children.toArray(result.props.children);
      if (!children.some((child) => child?.type === ReviewNavItem)) {
        children.push(React.createElement(ReviewNavItem, { key: "auto-seek-dev-review" }));
      }
      return React.cloneElement(result, {}, children);
    });
  }

  // Keys while reviewing on a scene page: n next spot, y / x mark the
  // current spot's act at the playhead (then on to the next spot).
  window.addEventListener("keydown", (event) => {
    const state = active;
    if (!state?.reviewing || !state.api.active || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    const key = event.key.toLowerCase();
    if (key === "n") nextSpot(state);
    else if ((key === "y" || key === "x") && state.spot) {
      markSpot(state, key === "y" ? 1 : 0);
    } else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();
