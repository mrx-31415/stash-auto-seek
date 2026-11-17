// Prints the settings page's act lists and how it reads and writes the Start
// at setting, for tests/plugin/test_settings_page.py to check against the
// backend. Then checks the PluginSettings patch against Stash's calling
// contract (patch.tsx runInstead: the arguments, then `next`).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../auto-seek/auto-seek.js"), "utf8");

const helpers = { Math, String, Number, parseFloat };
vm.createContext(helpers);
vm.runInContext(
  source.slice(source.indexOf("  // ── pure helpers"), source.indexOf("  // ── end pure helpers")) +
    "\nthis.out = { ACT_GROUPS, PRESETS, readStart, writeStart, actMatches };",
  helpers,
);
const { ACT_GROUPS, PRESETS, readStart, writeStart, actMatches } = helpers.out;
const samples = JSON.parse(process.argv[2] || "[]");

// Search finds acts by their label, backend name, other words or group.
const find = (query) => ACT_GROUPS.flatMap((group) => group.acts.filter((act) => actMatches(act, group.name, query)).map((act) => act[0]));
const plain = (value) => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(find("doggy")), ["doggy style"]);
assert.deepEqual(plain(find("bj")), ["oral on him"]);
assert.ok(find("cum").includes("creampie") && find("cum").includes("facial"));
assert.ok(find("oral").includes("oral on her") && find("oral").includes("rimming"));
assert.equal(find("").length, ACT_GROUPS.flatMap((group) => group.acts).length);

// The patch: only Auto Seek's own panel changes; everything else passes on.
let patched = null;
const calls = [];
const window = {
  PluginApi: {
    React: { Fragment: "Fragment", createElement: (type, props, ...children) => ({ type, props, children }) },
    libraries: { ReactSelect: { default: "Select" } },
    hooks: { useSettings: () => ({}) },
    patch: { instead: (name, fn) => { assert.equal(name, "PluginSettings"); patched = fn; } },
  },
};
const page = {
  window, location: { pathname: "/settings" }, sessionStorage: { getItem: () => "1", setItem() {} },
  document: { querySelector: () => null, querySelectorAll: () => [], body: {} },
  MutationObserver: class { observe() {} disconnect() {} }, setTimeout: () => 0, clearTimeout() {},
  console, Math, String, Number, parseFloat, JSON, Promise, Map, Set, Array, Object,
};
page.window.__autoSeekLoaded = false;
vm.createContext(page);
vm.runInContext(source.replace("window.__autoSeekLoaded", "window.__autoSeekLoadedUnderTest"), page);
assert.ok(patched, "PluginSettings is patched");
const settings = ["startStage", "accurateModel", "leadIn"].map((name) => ({ name }));
const renderer = { me: true };
function next(...args) { calls.push({ self: this, args }); return "native"; }

for (const extra of [[], ["legacy context"]]) {
  calls.length = 0;
  const other = { pluginID: "other", settings };
  assert.equal(patched.call(renderer, other, ...extra, next), "native");
  assert.equal(calls[0].self, renderer);
  assert.deepEqual(calls[0].args, [other, ...extra]);

  calls.length = 0;
  const own = patched.call(renderer, { pluginID: "auto-seek", settings }, ...extra, next);
  assert.equal(own.type, "Fragment");
  assert.equal(own.children[1], "native");
  assert.equal(calls[0].self, renderer);
  assert.deepEqual(plain(calls[0].args[0].settings.map((s) => s.name)), ["leadIn"]);
  assert.deepEqual(calls[0].args.slice(1), extra);
}

// Without the hooks it needs (an older Stash), Stash's own fields stay.
delete window.PluginApi.hooks.useSettings;
calls.length = 0;
assert.equal(patched.call(renderer, { pluginID: "auto-seek", settings }, next), "native");
assert.equal(calls[0].args[0].settings.length, 3);

console.log(JSON.stringify({
  groups: ACT_GROUPS.map((group) => ({ name: group.name, acts: group.acts.map((act) => act[0]) })),
  presets: Object.fromEntries(PRESETS.map((preset) => [preset.key, preset.acts])),
  read: samples.map((value) => readStart(value)),
  written: samples.map((value) => writeStart(readStart(value).acts)),
}));
