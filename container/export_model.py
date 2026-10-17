"""Prepare a finished model for the web viewer, inside the BrickAgent container.

    python export_model.py /work/model.mpd /out/packed.mpd /out/manifest.json

`packed.mpd` embeds every LDraw file the model references, so the browser needs no parts library.
`manifest.json` is the parts list and overall size, read from the placements the viewer will draw.
"""

import argparse
from collections import Counter
import json
import os
from pathlib import Path

LDU_CM = 0.04  # 1 LDU = 0.4 mm
STUD = 20.0


def embedded(text: str) -> dict[str, list[str]]:
    """Embedded files by lowercased name, in order; the main model first."""
    found: dict[str, list[str]] = {}
    name = None
    for line in text.splitlines():
        if line.startswith("0 FILE "):
            name = line[7:].strip().lower()
            found.setdefault(name, [])
        elif name is not None:
            found[name].append(line)
    return found


def matmul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def placements(files: dict[str, list[str]]) -> list[tuple[str, int, list[list[float]]]]:
    """(part file, color code, 4x4 pose) for every library part, with color 16 resolved as the viewer resolves it."""
    identity = [[float(i == j) for j in range(4)] for i in range(4)]
    out: list[tuple[str, int, list[list[float]]]] = []
    pending = [(next(iter(files)), identity, 7)]
    while pending:
        name, pose, color = pending.pop()
        if name.endswith(".dat"):
            out.append((name, color, pose))
            continue
        if name not in files:
            raise ValueError(f"missing MPD definition: {name}")
        children = []
        for line in files[name]:
            fields = line.strip().split()
            if len(fields) < 15 or fields[0] != "1":
                continue
            v = [float(x) for x in fields[2:14]]
            local = [
                [v[3], v[4], v[5], v[0]],
                [v[6], v[7], v[8], v[1]],
                [v[9], v[10], v[11], v[2]],
                [0.0, 0.0, 0.0, 1.0],
            ]
            child = " ".join(fields[14:]).replace("\\", "/").lower()
            tint = color if int(fields[1]) in (16, 24) else int(fields[1])
            children.append((child, matmul(pose, local), tint))
        pending.extend(reversed(children))
    return out


class Library:
    """The LDraw parts library on disk, indexed by lowercased path for case-insensitive lookup."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.index: dict[str, Path] = {}
        for directory in ("parts", "p", "models"):
            base = root / directory
            for path in base.rglob("*.dat") if base.is_dir() else ():
                self.index[str(path.relative_to(root)).replace(os.sep, "/").lower()] = path

    def find(self, ref: str) -> tuple[str, str] | None:
        """(library-rooted name, file text) for a reference as written in a type-1 line."""
        key = ref.replace("\\", "/").lower()
        for candidate in (f"parts/{key}", f"p/{key}", f"models/{key}", key):
            path = self.index.get(candidate)
            if path is not None:
                return candidate, path.read_text(encoding="utf-8", errors="replace")
        return None


def pack(text: str, library: Library) -> str:
    """The model with every referenced LDraw file embedded, each under the name it is referenced by."""
    seen: set[str] = set(embedded(text))
    out = [text.rstrip("\n")]
    pending = [ref for ref in references(text.splitlines()) if ref not in seen]
    while pending:
        ref = pending.pop(0)
        if ref in seen:
            continue
        seen.add(ref)
        found = library.find(ref)
        if found is None:
            raise ValueError(f"not in the LDraw library: {ref}")
        rooted, body = found
        out.append(f"0 FILE {ref}\n{body.rstrip()}\n0")
        if rooted != ref and rooted not in seen:
            seen.add(rooted)
            out.append(f"0 FILE {rooted}\n{body.rstrip()}\n0")
        pending.extend(r for r in references(body.splitlines()) if r not in seen)
    return "\n".join(out) + "\n"


def references(lines: list[str]) -> list[str]:
    """Every subfile a set of LDraw lines refers to, lowercased with forward slashes."""
    found = []
    for line in lines:
        fields = line.strip().split()
        if len(fields) >= 15 and fields[0] == "1":
            found.append(" ".join(fields[14:]).replace("\\", "/").lower())
    return found


def manifest(placed: list[tuple[str, int, list[list[float]]]]) -> dict:
    """Parts grouped by part and color, plus the model's overall size."""
    import brickagent as b

    palette = {c["code"]: c for c in json.loads(_colors_path().read_text(encoding="utf-8"))["colors"]}
    counts = Counter((Path(name).stem, code) for name, code, _ in placed)
    rows = []
    for (stem, code), n in counts.most_common():
        color = palette.get(code, {})
        try:
            title = b.name(stem)
        except Exception:
            title = stem
        rows.append({
            "id": stem,
            "name": title,
            "code": code,
            "color": color.get("name", str(code)).replace("_", " "),
            "hex": color.get("hex", "#9ba19d"),
            "n": n,
        })

    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for name, _, pose in placed:
        try:
            low, high = b.measure(Path(name).stem)
        except Exception:
            continue
        for corner in _corners(low, high):
            for axis in range(3):
                world = sum(pose[axis][k] * corner[k] for k in range(3)) + pose[axis][3]
                lo[axis], hi[axis] = min(lo[axis], world), max(hi[axis], world)
    size = [hi[i] - lo[i] for i in range(3)] if hi[0] > lo[0] else [0.0, 0.0, 0.0]
    return {
        "total": len(placed),
        "kinds": len(rows),
        "rows": rows,
        "size": {
            "ldu": [round(v, 1) for v in size],
            "cm": [round(v * LDU_CM, 1) for v in size],
            "studs": [round(size[0] / STUD), round(size[2] / STUD)],
            "height_cm": round(size[1] * LDU_CM, 1),
        },
    }


def _corners(low, high):
    return [(x, y, z) for x in (low[0], high[0]) for y in (low[1], high[1]) for z in (low[2], high[2])]


def _colors_path() -> Path:
    from importlib.resources import files

    catalog = os.environ.get("BRICKNET_CATALOG", "v1")
    return Path(str(files("brickagent"))) / "_data" / catalog / "colors.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mpd", type=Path)
    parser.add_argument("packed", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()

    text = args.mpd.read_text(encoding="utf-8")
    library = Library(Path(os.environ.get("BRICKAGENT_LDRAW", "/opt/ldraw")))
    args.packed.write_text(pack(text, library), encoding="utf-8")
    report = manifest(placements(embedded(text)))
    args.manifest.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{args.packed} {args.packed.stat().st_size} bytes; {report['total']} parts, {report['kinds']} kinds")


if __name__ == "__main__":
    main()
