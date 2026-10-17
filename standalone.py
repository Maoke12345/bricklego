#!/usr/bin/env python3
"""
把一个已完成的任务打包成一个独立的 HTML 文件：没有服务器、没有 LDraw 库、双击就能看。

    python3 standalone.py jobs/1017-0038-1738 out/黑骑士守桥.html

页面结构、CSS 和交互都沿用 web/index.html，区别只在于：
  * three.js 从 jsdelivr 取（省掉 vendor/ 目录），其余模块全部内联；
  * 模型（packed.mpd）、调色板、零件清单、照片和整段对话都以 JS 常量嵌进文件；
  * 对话框是只读的快照——静态文件没法再生成。
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

# ---------------------------------------------------------------- 模块内联

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
    """把几个本地模块拼成一段代码：本地 import 删掉，裸模块的 import 合并去重。"""
    want = {}                     # 'three' -> {'ns': {...}, 'default': {...}, 'named': {local: imported}}
    bodies = []
    for path in paths:
        text = path.read_text()
        for clause, spec in IMPORT.findall(text):
            if spec.startswith("."):
                continue          # 这个文件就在下面，不用 import
            slot = want.setdefault(spec, {"ns": {}, "default": {}, "named": {}})
            for kind, value in bindings(clause):
                if kind == "named":
                    imported, local = value
                    if local in slot["named"] and slot["named"][local] != imported:
                        raise SystemExit(f"{path.name}: {local} 在不同模块里指向不同东西")
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


# ---------------------------------------------------------------- 任务内容

def data_uri(path):
    kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{kind};base64," + base64.b64encode(path.read_bytes()).decode()


def local(job, url):
    """事件里的 /jobs/<id>/work/x.png?v=… -> 任务目录里的文件。"""
    name = url.split("?")[0].split(f"/jobs/{job.name}/", 1)[-1]
    path = job / name
    return path if path.is_file() else None


def transcript(job, events):
    """整段对话，重放用。中途那些预览图磁盘上只剩最后一版，所以只保留最后一组渲染。"""
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
                out.append({"type": "tool", "text": "  ↳ 渲了一版，自己看了看"})
                continue
            shots = [data_uri(p) for p in (local(job, u) for u in urls) if p]
            if shots:
                out.append({"type": "renders", "urls": shots})
            continue
        if kind == "result":
            out.append({"type": "stage", "text": "完成 · %d 轮 · %d 分钟 · $%.2f"
                        % (event["turns"], round(event["seconds"] / 60), event["cost"])})
            continue
        row = {"type": kind, "text": event.get("text", "")}
        if kind == "tool" and event.get("error"):
            row["error"] = True
        if event.get("image"):
            shot = local(job, event["image"])
            if shot:
                row["image"] = data_uri(shot)
        out.append(row)
    return out


def pack(job, out):
    events = [json.loads(line) for line in (job / "events.jsonl").read_text().splitlines() if line.strip()]
    model = next((e for e in reversed(events) if e["type"] == "model"), None)
    if not model:
        raise SystemExit(f"{job}: 还没有做出模型")

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
    title = data["__CARD"].get("title") or "砖语"
    html = re.sub(r"<title>.*?</title>", f"<title>{title} · 砖语</title>", html, count=1)
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
