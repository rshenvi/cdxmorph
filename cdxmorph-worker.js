/* cdxmorph in the browser — the worker that runs Python.
 *
 * Everything heavy happens here rather than on the page's thread, so a
 * render that takes half a minute does not freeze the tab.  The Python
 * side is the package's own browser module, which drives the same code
 * path the desktop program uses.
 *
 * Developed by Ryan Shenvi @ ShenviLab
 */
"use strict";

/* Runtime builds are tried in order; the first that loads wins, so the
 * page keeps working when a version is retired from the CDN. */
const RUNTIMES = [
  "https://cdn.jsdelivr.net/pyodide/v0.28.0/full/",
  "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/",
  "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/",
  "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/"
];

let py = null;

function log(text) {
  self.postMessage({ log: text });
}

async function boot() {
  if (py) return;
  let lastError = null;
  for (const base of RUNTIMES) {
    try {
      log("starting Python (" + base.split("/").slice(-3, -2) + ")…");
      importScripts(base + "pyodide.js");
      py = await loadPyodide({ indexURL: base });
      break;
    } catch (err) {
      lastError = err;
      py = null;
    }
  }
  if (!py) {
    throw new Error("could not load the Python runtime: " +
                    (lastError && lastError.message));
  }
  log("loading numpy, scipy, matplotlib, pillow…");
  await py.loadPackage(["numpy", "scipy", "matplotlib", "pillow", "micropip"]);

  /* The wheel's name is kept in a one-line text file so that updating the
   * program means replacing two files and editing nothing. */
  let wheel = "cdxmorph-1.3.5-py3-none-any.whl";
  try {
    const r = await fetch("wheel.txt", { cache: "no-store" });
    if (r.ok) {
      const t = (await r.text()).trim();
      if (t) wheel = t;
    }
  } catch (err) { /* keep the built-in name */ }
  const url = new URL(wheel, self.location.href).href;

  log("installing " + wheel + "…");
  py.globals.set("_wheel_url", url);
  await py.runPythonAsync(`
import micropip
await micropip.install("defusedxml")
# deps=False: the wheel also lists flask and an MP4 encoder, which a
# browser neither has nor needs.  Everything it does need is already
# loaded above.
await micropip.install(_wheel_url, deps=False)
import json
import cdxmorph.browser as br

def _payload(raw):
    """Uploaded bytes, whichever way the browser handed them over."""
    return bytes(raw.to_py()) if hasattr(raw, "to_py") else bytes(raw)
`);
  /* ChemDraw draws in Arial, and a browser has no system fonts at all, so
   * matplotlib would fall back to DejaVu Sans - up to 20% wider on the same
   * label.  Liberation Sans carries Arial's advance widths (within 3.5% on
   * every label tested), and a label's width is what sets its occlusion box,
   * so shipping it keeps the browser's drawing the same as the desktop's. */
  log("loading the Arial-metric font…");
  const fontFiles = ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"];
  const got = [];
  for (const name of fontFiles) {
    try {
      const rf = await fetch(name);
      if (!rf.ok) continue;
      const buf = new Uint8Array(await rf.arrayBuffer());
      py.FS.writeFile("/tmp/" + name, buf);
      got.push("/tmp/" + name);
    } catch (err) { /* fall through to whatever matplotlib has */ }
  }
  py.globals.set("_font_paths", got);
  await py.runPythonAsync(`
from matplotlib import font_manager as _fm
import cdxmorph.scene as _cs
for _p in list(_font_paths):
    try:
        _fm.fontManager.addfont(_p)
    except Exception:
        pass
# what the canvas will actually use, reported so a mismatch is visible
from matplotlib.font_manager import FontProperties as _FP, findfont as _ff
import matplotlib as _mpl
_resolved = (_ff(_FP(family=_cs.TEXT_FAMILY)).split("/")[-1]
             + "  (matplotlib " + _mpl.__version__ + ")")
`);
  log("drawing text in " + py.globals.get("_resolved"));

  log("ready — cdxmorph " + py.runPython("br.version()"));
}

async function call(cmd, msg) {
  await boot();
  py.globals.set("_name", msg.name || "input.cdxml");
  py.globals.set("_raw", msg.bytes || new Uint8Array(0));
  py.globals.set("_opts", JSON.stringify(msg.opts || {}));
  py.globals.set("_cfg", JSON.stringify(msg.config || null));

  if (cmd === "describe" || cmd === "editors" || cmd === "still") {
    const fn = { describe: "describe", editors: "editors", still: "still" }[cmd];
    await py.runPythonAsync(`
_cfg_d = json.loads(_cfg)
_res = br.${fn}(_name, _payload(_raw), _cfg_d)
_data = _res.pop("data", None) if isinstance(_res, dict) else None
_report = json.dumps(_res, default=str)
`);
  } else if (cmd === "animate") {
    await py.runPythonAsync(`
_o = json.loads(_opts)
_o["config"] = json.loads(_cfg)
_res = br.animate(_name, _payload(_raw), _o)
_data = _res.pop("data")
_report = json.dumps(_res, default=str)
`);
  } else {
    throw new Error("unknown command " + cmd);
  }

  const report = JSON.parse(py.globals.get("_report"));
  let data = py.globals.get("_data");
  if (data && data.toJs) data = data.toJs();
  return { report: report, data: data || null };
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    const out = await call(msg.cmd, msg);
    const reply = { id: msg.id, ok: true, report: out.report };
    if (out.data) {
      reply.data = out.data;
      self.postMessage(reply, [out.data.buffer]);
    } else {
      self.postMessage(reply);
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false,
                       error: (err && err.message) || String(err) });
  }
};
