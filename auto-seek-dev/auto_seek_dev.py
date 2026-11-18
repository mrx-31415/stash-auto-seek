#!/usr/bin/env python3
"""Auto Seek (dev): development tools for the act timeline, as a separate plugin.

Never part of a release (scripts/build.py packages auto-seek/ only); installed
next to Auto Seek on a development Stash. It works on Auto Seek's own cache
(the marks are labels for training), so it imports the plugin from the folder
beside this one and points it at that folder.

Operations:
    review   mark an act as there (verdict 1) or not (0) at `t`; no verdict takes it back
    reviews  the marks for a scene
    queue    the review queue built on the GPU box (data/review_queue.json), less what is marked
    prefetch have Auto Seek scan the queued scenes in the background, so they open ready
"""

from __future__ import annotations

import contextlib
import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
PLUGIN_DIR = os.path.realpath(sys.argv[1] if len(sys.argv) > 1 else HERE)
MAIN_DIR = os.path.join(os.path.dirname(PLUGIN_DIR), "auto-seek")
QUEUE_PATH = os.path.join(PLUGIN_DIR, "data", "review_queue.json")
NEAR_S = 6  # a mark takes the model's score from the scanned frame this close
# Above the library task's background scans (0), below a page's (its time).
PREFETCH_PRIORITY = 1


def load_auto_seek():
    """Auto Seek's module, with its paths on its own folder (it takes them
    from the command line, which here names this plugin's folder)."""
    if not os.path.isfile(os.path.join(MAIN_DIR, "auto_seek.py")):
        raise RuntimeError(f"Auto Seek isn't installed next to this plugin ({MAIN_DIR})")
    argv = sys.argv
    sys.argv = [argv[0], MAIN_DIR]
    sys.path.insert(0, MAIN_DIR)
    try:
        import auto_seek
    finally:
        sys.argv = argv
    return auto_seek


def review_act(main, args: dict) -> dict:
    scene_id, act = str(args["scene_id"]), str(args["act"])
    if act not in main.ACTS[1:]:
        raise ValueError(f"unknown act: {act!r}")
    t = round(float(args["t"]), 2)
    verdict = args.get("verdict")
    with contextlib.closing(main.cache()) as connection, connection:
        if verdict is None:
            connection.execute(
                "DELETE FROM act_review WHERE scene_id = ? AND t = ? AND act = ?",
                (scene_id, t, act),
            )
        else:
            # The model's score on the scanned frame nearest to it, if close.
            row = main.load_timeline(scene_id) or {}
            near = min(row.get("frames", []), key=lambda frame: abs(frame[0] - t), default=None)
            acts = near[1] if near and near[1] and abs(near[0] - t) <= NEAR_S else None
            score = acts[main.ACTS.index(act)] if acts else None
            connection.execute(
                "INSERT OR REPLACE INTO act_review VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    scene_id, t, act, 1 if verdict else 0, row.get("model", ""),
                    None if score is None else score / 100, main.now(),
                ),
            )  # fmt: skip
    return {"reviews": reviews_of(main, scene_id)}


def reviews_of(main, scene_id: str) -> list:
    if not os.path.isfile(main.CACHE_PATH):
        return []
    with contextlib.closing(main.cache()) as connection:
        return [
            list(row)
            for row in connection.execute(
                "SELECT t, act, verdict FROM act_review WHERE scene_id = ? ORDER BY t", (scene_id,)
            )
        ]


def review_queue(main) -> dict:
    """The queue from the GPU box: scenes with spots where the model shown
    and a stronger one disagree. A spot counts as done once any mark for that
    act lies within 15 s of it; a scene once all its spots are."""
    if not os.path.isfile(QUEUE_PATH):
        return {"scenes": [], "models": None, "generated": None}
    with open(QUEUE_PATH, encoding="utf-8") as handle:
        queue = json.load(handle)
    marks: dict[str, list] = {}
    if os.path.isfile(main.CACHE_PATH):
        with contextlib.closing(main.cache()) as connection:
            for scene_id, t, act in connection.execute("SELECT scene_id, t, act FROM act_review"):
                marks.setdefault(scene_id, []).append((t, act))
    scenes = []
    for scene in queue.get("scenes", []):
        done = marks.get(str(scene["id"]), [])
        spots = [
            {
                **spot,
                "done": any(act == spot["act"] and abs(t - spot["t"]) <= 15 for t, act in done),
            }
            for spot in scene.get("spots", [])
        ]
        timeline = main.load_timeline(str(scene["id"]))
        scenes.append(
            {
                **scene,
                "id": str(scene["id"]),
                "spots": spots,
                "left": sum(not s["done"] for s in spots),
                # Its timeline is scanned: the page shows everything at once.
                "ready": bool(timeline and timeline["state"] == 1),
            }
        )
    return {"scenes": scenes, "models": queue.get("models"), "generated": queue.get("generated")}


def prefetch(main, args: dict, server: dict) -> dict:
    """Have Auto Seek scan the queued scenes in the background (all of them,
    or the next `count` after scene `after`), at a priority below any page's,
    so their timelines are ready when the review gets there."""
    scenes = [scene for scene in review_queue(main)["scenes"] if scene["left"]]
    ids = [scene["id"] for scene in scenes]
    here = str(args.get("after") or "")
    ahead = ids[ids.index(here) + 1 :] + ids[: ids.index(here)] if here in ids else ids
    queued = []
    for scene_id in ahead:
        if len(queued) >= int(args.get("count", len(ahead))):
            break
        row = main.load_timeline(scene_id)
        if row and row["state"] == 1:
            continue  # scanned already
        main.queue_scene(scene_id, server, priority=PREFETCH_PRIORITY)
        queued.append(scene_id)
    return {"queued": queued}


OPERATIONS = {
    "review": lambda main, args, server: review_act(main, args),
    "reviews": lambda main, args, server: {"reviews": reviews_of(main, str(args["scene_id"]))},
    "queue": lambda main, args, server: review_queue(main),
    "prefetch": prefetch,
}


def main() -> None:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        args = request.get("args") or {}
        handler = OPERATIONS.get(args.get("op"))
        if handler is None:
            raise ValueError(f"unknown operation: {args.get('op')!r}")
        server = request.get("server_connection") or {}
        reply = {"output": handler(load_auto_seek(), args, server)}
    except Exception as error:
        reply = {"error": str(error)}
    sys.stdout.write(json.dumps(reply))


if __name__ == "__main__":
    main()
