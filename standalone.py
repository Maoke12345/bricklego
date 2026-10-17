#!/usr/bin/env python3
"""
Pack a finished job into one self-contained HTML file: no server, no LDraw library, just open it.

    python3 standalone.py jobs/1017-0038-1738 out/black-knight.html

The markup, CSS and interactions come straight from web/index.html. The differences:
  * three.js is pulled from jsdelivr (so vendor/ can be left out) and every other module is inlined;
  * the model (packed.mpd), palette, part list, photo and whole transcript are embedded as JS constants;
  * the composer is a read-only snapshot - a static file cannot generate anything.
"""
import base64
import json
import mimetypes
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
THREE = "0.183.2"
CDN = (
    '<script type="importmap">{"imports":{'
    f'"three":"https://cdn.jsdelivr.net/npm/three@{THREE}/build/three.module.js",'
    f'"three/addons/":"https://cdn.jsdelivr.net/npm/three@{THREE}/examples/jsm/"'
    "}}</script>"
)

# ---------------------------------------------------------------- Inlining the modules

IMPORT = re.compile(r"^import\s+([\s\S]*?)\s*from\s*'([^']+)';?[ \t]*$", re.M)


def bindings(clause):
    """'* as THREE' / 'Thing' / '{ a, b as c }' -> [('ns'|'default'|'named', ...)]"""
    out = []
    clause = clause.strip()
    braces = re.search(r"\{([\s\S]*)\}", clause)
    if braces:
        for piece in braces.group(1).split(","):
            piece = piece.strip()
            if not piece:
                continue
            parts = [p for p in re.split(r"\s+as\s+", piece)]
            out.append(("named", (parts[0], parts[-1])))
        clause = clause[: braces.start()].rstrip().rstrip(",").strip()
    for piece in filter(None, (p.strip() for p in clause.split(","))):
        star = re.match(r"\*\s+as\s+(\w+)$", piece)
        out.append(("ns", star.group(1)) if star else ("default", piece))
    return out


def inline(paths):
    """Concatenate local modules: drop local imports, merge and de-duplicate bare ones."""
    want = {}                     # 'three' -> {'ns': {...}, 'default': {...}, 'named': {local: imported}}
    bodies = []
    for path in paths:
        text = path.read_text()
        for clause, spec in IMPORT.findall(text):
            if spec.startswith("."):
                continue          # that file is right below; no import needed
            slot = want.setdefault(spec, {"ns": {}, "default": {}, "named": {}})
            for kind, value in bindings(clause):
                if kind == "named":
                    imported, local = value
                    if local in slot["named"] and slot["named"][local] != imported:
                        raise SystemExit(f"{path.name}: {local} means different things in different modules")
                    slot["named"][local] = imported
                else:
                    slot[kind][value] = True
        bodies.append(f"/* ---- {path.name} ---- */\n{IMPORT.sub('', text).strip()}\n")

    head = []
    for spec, slot in want.items():
        for name in slot["ns"]:
            head.append(f"import * as {name} from '{spec}';")
        for name in slot["default"]:
            head.append(f"import {name} from '{spec}';")
        if slot["named"]:
            names = ", ".join(
                local if local == imported else f"{imported} as {local}"
                for local, imported in sorted(slot["named"].items())
            )
            head.append(f"import {{ {names} }} from '{spec}';")
    return "\n".join(head) + "\n\n" + "\n".join(bodies)


# ---------------------------------------------------------------- What the job holds

def data_uri(path):
    kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{kind};base64," + base64.b64encode(path.read_bytes()).decode()


def local(job, url):
    """Turn /jobs/<id>/work/x.png?v=... from an event into a file in the job directory."""
    name = url.split("?")[0].split(f"/jobs/{job.name}/", 1)[-1]
    path = job / name
    return path if path.is_file() else None


def transcript(job, events):
    """The whole transcript, for replay. Only the last render survives on disk, so keep only that set."""
    renders = [i for i, e in enumerate(events) if e["type"] == "renders"]
    last = renders[-1] if renders else None
    out = []
    for i, event in enumerate(events):
        kind = event["type"]
        if kind in ("busy", "idle", "model"):
            continue
        if kind == "renders":
            urls = [u for u in event["urls"] if "reference" not in u]
            if i != last or not urls:
                out.append({"type": "tool", "text": "  \u21b3 rendered a version and looked at it"})
                continue
            shots = [data_uri(p) for p in (local(job, u) for u in urls) if p]
            if shots:
                out.append({"type": "renders", "urls": shots})
            continue
        if kind == "result":                              # older jobs: the agent finished, but checks and packing had not run
            out.append({"type": "stage", "text": "Model written · %d turns · %d min · $%.2f"
                        % (event["turns"], round(event["seconds"] / 60), event["cost"])})
            continue
        if kind == "done":                                # the closing line; pass its fields through as they are
            out.append(dict(event))
            continue
        row = {"type": kind, "text": event.get("text", "")}
        if kind == "tool" and event.get("error"):
            row["error"] = True
        if event.get("image"):
            shot = local(job, event["image"])
            if shot:
                row["image"] = data_uri(shot)
        out.append(row)

    # jobs from before the closing line existed: rebuild one from what is there, so the snapshot does not stop halfway
    if not any(r["type"] == "done" for r in out):
        model = next((e for e in reversed(events) if e["type"] == "model"), None)
        last = next((e for e in reversed(events) if e["type"] == "result"), None)
        if model:
            done = {"type": "done", "changed": True, "valid": bool(model.get("valid")),
                    "total": model["manifest"]["total"], "kinds": model["manifest"]["kinds"]}
            if last:
                done |= {k: last[k] for k in ("turns", "seconds", "cost") if k in last}
            out.append(done)
    return out


def pack(job, out):
    events = [json.loads(line) for line in (job / "events.jsonl").read_text().splitlines() if line.strip()]
    model = next((e for e in reversed(events) if e["type"] == "model"), None)
    if not model:
        raise SystemExit(f"{job}: no model was built yet")

    reference = next((local(job, model[k]) for k in ("reference",) if model.get(k)), None)
    data = {
        "__JOB": job.name,
        "__MPD": (job / "packed.mpd").read_text(),
        "__COLORS": json.loads((WEB / "colors.json").read_text())["colors"],
        "__PARTS": json.loads((job / "manifest.json").read_text()),
        "__CARD": model.get("card") or {},
        "__VALID": bool(model.get("valid")),
        "__REF": data_uri(reference) if reference else None,
        "__CHAT": transcript(job, events),
    }
    block = "\n".join(f"const {k} = {json.dumps(v, ensure_ascii=False)};" for k, v in data.items())
    code = block + "\n\n" + inline([WEB / "vendor" / "LDrawLoader.js", WEB / "vendor" / "viewer.js",
                                    WEB / "classic.js"]) + "\n" + (ROOT / "driver.js").read_text()

    html = (WEB / "index.html").read_text()
    html = html.replace(
        '<script type="importmap">{"imports":{"three":"./vendor/three/build/three.module.js",'
        '"three/addons/":"./vendor/three/examples/jsm/"}}</script>', CDN)
    title = data["__CARD"].get("title") or "BRICKFORM"
    html = re.sub(r"<title>.*?</title>", f"<title>{title} · BRICKFORM</title>", html, count=1)
    html = html.replace('<script type="module" src="./app.js"></script>',
                        '<script type="module">\n' + code + "\n</script>")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    job = Path(sys.argv[1]).resolve()
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "out" / f"{job.name}.html"
    print(pack(job, target), (target.stat().st_size + 1023) // 1024, "KB")
