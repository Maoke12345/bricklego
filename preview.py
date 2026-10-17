#!/usr/bin/env python3
"""
把界面的初始空状态导成一个能单独打开的 HTML：没有后端、没有 three.js，
只有版面本身和那三个例子按钮。用来发给人看设计。

    python3 preview.py out/初始界面.html
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STUB = """<script>
/* 这是静态预览：没有后端，也没有模型。只把例子按钮接上，其余按初始状态呈现。 */
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
    html = re.sub(r"<title>.*?</title>", "<title>砖语 · 界面</title>", html, count=1)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    return out

if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "out" / "初始界面.html"
    print(build(target), (target.stat().st_size + 1023) // 1024, "KB")
