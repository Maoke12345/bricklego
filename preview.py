#!/usr/bin/env python3
"""
Export the empty opening state as a standalone HTML file: no backend, no three.js,
just the layout itself and the three example buttons. For showing the design to people.

    python3 preview.py out/interface.html
"""
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

def build(out: Path) -> Path:
    html = (ROOT / "web" / "index.html").read_text()
    html = re.sub(r'<script type="importmap">.*?</script>\n?', "", html, flags=re.S)
    html = html.replace('<script type="module" src="./app.js"></script>', STUB)
    html = re.sub(r"<title>.*?</title>", "<title>BRICKFORM · Interface</title>", html, count=1)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    return out

if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "out" / "interface.html"
    print(build(target), (target.stat().st_size + 1023) // 1024, "KB")
