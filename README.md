# Auto Seek

**Stop scrubbing. Skip to the part you want.** Auto Seek is a [Stash](https://github.com/stashapp/stash)
plugin that finds where the action starts in each scene and jumps straight there: tap
**Skip intro** on the player, or let it skip on its own. A small image model works it
out on your Stash server in a few seconds when you open a scene, or ahead of time in
the background if you like, and no frames leave your server. When it picks the wrong
spot, a flag on the player fixes that scene for good. You choose what counts as the
start, from kissing to sex positions, and a timeline under the player maps every act
it sees across the scene, to jump to and zoom into.

[See it in action](https://mrx-31415.github.io/stash-curator/auto-seek/) ·
[Guide](https://mrx-31415.github.io/stash-curator/auto-seek-guide/)

## Install

Add this plugin source under **Settings > Plugins > Available Plugins**, then install
**Auto Seek** and reload plugins:

```text
https://mrx-31415.github.io/stash-plugins/main/index.yml
```

Auto Seek needs Stash v0.31 and the `python` Stash already uses for plugins. Installs
from the Stash Curator source
(`https://mrx-31415.github.io/stash-curator/index.yml`) keep receiving updates there.

**Moving from the Stash Curator source:** uninstall Auto Seek there and install it from
the source above, in either order. Uninstalling leaves Auto Seek's data folder behind,
and the new install picks up its start points and your marks the first time it runs.
Don't delete the old plugin folder by hand before that.

Development builds from `main`: `https://mrx-31415.github.io/stash-auto-seek/dev/index.yml`.

## Development

Auto Seek was developed in [stash-curator](https://github.com/mrx-31415/stash-curator)
until 0.2.0; references like `mrx-31415/stash-curator#473` in the history point there.

```bash
python -m pytest tests --ignore=tests/integration   # unit tests; needs pytest and node
python scripts/build.py         # dist/auto-seek.zip and dist/auto-seek-index.yml
python scripts/build.py --dev   # the dev source in dist/dev/
```

The integration tests run the built plugin in a throwaway Stash (Docker), with one
synthetic clip scanned, and drive Stash's own scene page with Playwright:

```bash
pip install -r tests/integration/requirements.txt && playwright install chromium
scripts/integration                      # everything, against stashapp/stash:v0.31.1
scripts/integration -m "not model"       # skip the tests that download and run the model
STASH_IMAGE=stashapp/stash:latest AUTO_SEEK_FILES=~/.cache/auto-seek-files scripts/integration
```

`AUTO_SEEK_FILES` keeps the downloaded model and runtime (about 100 MB) between runs;
`KEEP_STASH=1` leaves the Stash running afterwards. CI runs them against v0.31.1 and
`latest`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
release-please bumps `version:` in `auto-seek/auto-seek.yml`, updates
`auto-seek/CHANGELOG.md` and tags `auto-seek-vX.Y.Z`; the release workflow then
attaches `auto-seek.zip` and `auto-seek-index.yml`, which the plugin hub mirrors.

`scripts/build_auto_seek_runtime.sh` builds the musl ONNX Runtime bundles served from
the `auto-seek-runtime-v1` release of stash-curator.

### The development plugin

`auto-seek-dev/` is a second plugin, **Auto Seek Dev**, with tools for improving the
model: a review mode on the act timeline (mark an act as there or not at the frame on
screen; the marks go into Auto Seek's cache as training labels) and a review queue (new
scenes and the spots in them where two models disagree, built offline into
`auto-seek-dev/data/review_queue.json`; `n` jumps to the next spot, `y` / `x` mark it).
It is never packaged (`scripts/build.py` takes `auto-seek/` only) and hooks into the
timeline through `window.AutoSeekExtensions` (see "extensions" in `auto-seek.js`). To
use it, copy the folder next to an installed Auto Seek, so that the two folders are
siblings in Stash's plugins folder, and reload plugins. The integration tests install
it the same way.

## License

[AGPL-3.0](LICENSE)
