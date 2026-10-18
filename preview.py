#!/usr/bin/env python3
"""
Export the empty opening state as a standalone HTML file: no backend, no three.js,
just the layout itself and the three example buttons. For showing the design to people.

    python3 preview.py out/interface.html
"""
import base64
import mimetypes
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STUB = """<script>
/* A static preview: no backend, no model. Only the example buttons are wired up;
   everything else stays in its opening state. */
for (const eg of document.querySelectorAll('.eg')) {
  eg.onclick = () => {
    const box = document.getElementById('text');
    box.value = eg.textContent;
    box.focus();
  };
}
document.getElementById('composer').addEventListener('submit', e => e.preventDefault());
</script>"""

def inline_assets(css: str, base: Path) -> str:
    """url('./x.svg') -> url("data:...") so the stylesheet carries its own images."""
    def swap(match: re.Match) -> str:
        name = match.group(1)
        asset = base / name
        if not asset.is_file():
            return match.group(0)
        kind = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
        return f'url("data:{kind};base64,{base64.b64encode(asset.read_bytes()).decode()}")'
    return re.sub(r"""url\(['"]\./([^'")?]+)(?:\?[^'")]*)?['"]\)""", swap, css)


def build(out: Path) -> Path:
    web = ROOT / "web"
    html = (web / "index.html").read_text()
    html = re.sub(r'<script type="importmap">.*?</script>\n?', "", html, flags=re.S)
    html = html.replace('<script type="module" src="./app.js"></script>', STUB)
    def as_data_uri(name: str) -> str | None:
        asset = web / name.split("?")[0]
        if not asset.is_file():
            return None
        kind = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
        return f"data:{kind};base64,{base64.b64encode(asset.read_bytes()).decode()}"

    for src in set(re.findall(r'<img[^>]+src="\./([^"]+)"', html)):
        uri = as_data_uri(src)
        if uri:
            html = html.replace(f'src="./{src}"', f'src="{uri}"')

    for link in re.findall(r'<link rel="stylesheet" href="\./([^"]+)">', html):
        css = inline_assets((web / link).read_text(), web)
        html = html.replace(f'<link rel="stylesheet" href="./{link}">', f"<style>\n{css}\n</style>")
    html = re.sub(r"<title>.*?</title>", "<title>BRICKFORM · Interface</title>", html, count=1)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    return out

if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "out" / "interface.html"
    print(build(target), (target.stat().st_size + 1023) // 1024, "KB")
