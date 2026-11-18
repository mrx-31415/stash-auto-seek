# Changelog

## [0.4.0](https://github.com/mrx-31415/stash-auto-seek/compare/auto-seek-v0.3.1...auto-seek-v0.4.0) (2026-11-18)


### Features

* choose where the action starts, with act-based models in two sizes ([#12](https://github.com/mrx-31415/stash-auto-seek/issues/12)) ([e2ae890](https://github.com/mrx-31415/stash-auto-seek/commit/e2ae8900d3f6ad70db8b8292857422dbeb92c4b2))
* move review mode into a separate dev plugin that releases leave out ([#19](https://github.com/mrx-31415/stash-auto-seek/issues/19)) ([eb0094f](https://github.com/mrx-31415/stash-auto-seek/commit/eb0094f473332ccea3dcaf75cf6b14e2bf77b2a4))
* pick where the action starts from a dropdown and a searchable list of acts ([5dea555](https://github.com/mrx-31415/stash-auto-seek/commit/5dea555552ec43c37ec9eb044922653396a0d5d8))
* preview, smooth live scan and a review mode on the act timeline ([#16](https://github.com/mrx-31415/stash-auto-seek/issues/16)) ([f9b7b9f](https://github.com/mrx-31415/stash-auto-seek/commit/f9b7b9f9306a5c2e42b747e0d4de388b778cf3aa))
* show every act across the scene in a live timeline under the player ([#15](https://github.com/mrx-31415/stash-auto-seek/issues/15)) ([ccb4005](https://github.com/mrx-31415/stash-auto-seek/commit/ccb4005715e72e755e98f89fa9014b13eee30094))
* step through an act from its name, and see your review marks as frames ([977a6e2](https://github.com/mrx-31415/stash-auto-seek/commit/977a6e2865aa6b1f72aa9acb58ab9da2238fcb34))
* step through an act's peaks, a green playhead, and no autoplay while reviewing ([3fc8d1e](https://github.com/mrx-31415/stash-auto-seek/commit/3fc8d1e8740368aabc93fa79ba9f759f0a2c11f8))

## [0.3.1](https://github.com/mrx-31415/stash-auto-seek/compare/auto-seek-v0.3.0...auto-seek-v0.3.1) (2026-11-13)


### Bug Fixes

* don't skip when no frame looks started ([#10](https://github.com/mrx-31415/stash-auto-seek/issues/10)) ([b5bf724](https://github.com/mrx-31415/stash-auto-seek/commit/b5bf7243848aa5312b8cfff154a933980d3ce7f5))

## [0.3.0](https://github.com/mrx-31415/stash-auto-seek/compare/auto-seek-v0.2.1...auto-seek-v0.3.0) (2026-11-13)


### Features

* jump from the scan chart, hide the Skip intro button, keep data when switching sources ([#6](https://github.com/mrx-31415/stash-auto-seek/issues/6)) ([fe42192](https://github.com/mrx-31415/stash-auto-seek/commit/fe42192b095dc690ed31d35915c3ff3f1e889184))


### Bug Fixes

* play from the frame tapped on the scan chart ([#9](https://github.com/mrx-31415/stash-auto-seek/issues/9)) ([095a00e](https://github.com/mrx-31415/stash-auto-seek/commit/095a00e99b183229f4ca1c12262d967251a920b6))

## [0.2.1](https://github.com/mrx-31415/stash-auto-seek/compare/auto-seek-v0.2.0...auto-seek-v0.2.1) (2026-11-11)


### Bug Fixes

* respect "Don't download the model" and stop waiting when it's off ([#3](https://github.com/mrx-31415/stash-auto-seek/issues/3)) ([79eb869](https://github.com/mrx-31415/stash-auto-seek/commit/79eb869acb717c142b007d863b616c875466880d))

## [0.2.0](https://github.com/mrx-31415/stash-curator/compare/auto-seek-v0.1.0...auto-seek-v0.2.0) (2026-11-08)


### Features

* add Auto Seek, a plugin that skips to where the action starts ([d8b754e](https://github.com/mrx-31415/stash-curator/commit/d8b754e2b665ac52c9ee59d7858f9c7215b28a24))
* Auto Seek model v2, trained on cleaner labels ([f666083](https://github.com/mrx-31415/stash-curator/commit/f6660835686493489b237f1c1ddf96e253deada1))
* live scan strip under the player, and a look-back rule for unsure starts ([f8463ef](https://github.com/mrx-31415/stash-curator/commit/f8463efd5da82bd4ddb49ee14a03df918996777d))
* release Curator and Auto Seek separately ([ae54a31](https://github.com/mrx-31415/stash-curator/commit/ae54a31a8ce19ffd1b6e2a3d252778fa245f17b2))
* shorten Auto Seek's default lead-in to 3 seconds ([6a902a0](https://github.com/mrx-31415/stash-curator/commit/6a902a0609281a3e2ab2351c52f2de4d7d1d6b3c))
* show Auto Seek's scored frames above the seek bar ([550677e](https://github.com/mrx-31415/stash-curator/commit/550677e01a9594f6a6c3fd241922ae3048a57bb6))
* status messages and a compact one-row Auto Seek strip ([b9435e4](https://github.com/mrx-31415/stash-curator/commit/b9435e4f7ac12374fe9aaa2fee16efa401ae51db))


### Bug Fixes

* scan from the scene's start when the jump is at the first scored frame ([c260931](https://github.com/mrx-31415/stash-curator/commit/c260931aab4057ecc9dd1bcb5a104182cc1ad189))
