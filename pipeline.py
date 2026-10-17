"""Turn one request — a photo and a sentence — into a checked LEGO model.

Each job is a directory and a conversation. A turn renders the BrickAgent prompt, runs Claude Code
inside the BrickAgent container with /work as its only writable path, streams what it does back to the
page, and then validates and packs the result for the viewer.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
JOBS = HERE / "jobs"
REPO = Path(os.environ.get("BRICKAGENT_REPO", HERE.parent / "BrickAgent"))
# scripts/prompt.py renders the benchmark template with jinja2; this interpreter is the one that has it.
PROMPT_PYTHON = Path(os.environ.get("PROMPT_PYTHON", HERE.parent / "brickbench-run" / ".venv" / "bin" / "python"))
IMAGE = os.environ.get("BRICKSTUDIO_IMAGE", "brickagent-claude")
BASE_IMAGE = os.environ.get("BRICKSTUDIO_BASE_IMAGE", "brickagent")
TURN_TIMEOUT = int(os.environ.get("BRICKSTUDIO_TURN_TIMEOUT", 60 * 60))

SPLITS = {"quick": "model", "model": "model", "set": "set"}
SETTINGS = {
    "permissions": {
        "defaultMode": "bypassPermissions",
        "deny": ["WebSearch", "WebFetch", "Bash(curl:*)", "Bash(wget:*)"],
    },
    "includeCoAuthoredBy": False,
    "autoUpdates": False,
}

FIRST_TURN = """
---

# This one is for a person, not a benchmark

{photo}The person's own words are quoted at the top of this prompt. Where their words and their photo
disagree, their words win. Build what they asked for, not a generic version of it.

They are watching this page while you work, so:

- Render as you go with `view(model, "/work/preview.png")`. Every PNG you write under `/work` appears
  on their screen within seconds, so render whenever the shape changes meaningfully.
- Write `/work/card.json` before you finish:
  `{{"title": "四字以内的中文名字", "subtitle": "English name", "eyebrow": "一句话副标题",
    "summary": "2-4 句中文介绍：这是什么、有哪些细节、为了结实做了哪些取舍"}}`
- Write your closing message to them **in Chinese**, the way you would tell a friend what you built.
  No code, no API names, no part numbers — what it looks like and what you had to compromise on.
{scale}"""

LATER_TURN = """The person is looking at the model you just built and asks for this change:

{text}
{photo}
Change `/work/build.py`, keep it passing `check()`, write `/work/model.mpd` again, refresh
`/work/card.json`, and render a new `/work/preview.png`. Keep everything they did not ask you to change.
Reply to them in Chinese, briefly, saying what you changed.
"""

SCALE = {
    "quick": "- Keep this one small and quick: 60–100 parts, and stop refining once it reads clearly.\n",
    "model": "",
    "set": "",
}


def new_id() -> str:
    return time.strftime("%m%d-%H%M") + "-" + uuid.uuid4().hex[:4]


class Job:
    """One conversation: a workspace, an event log, and at most one turn running at a time."""

    def __init__(self, job_id: str, size: str = "model") -> None:
        self.id = job_id
        self.dir = JOBS / job_id
        self.work = self.dir / "work"
        self.config = self.dir / "config"
        self.size = size
        self.busy = False
        self.turn = 0
        self.model_hash = ""
        self.events: list[dict] = []
        self.waiters = threading.Condition()
        self.lock = threading.Lock()
        self.seen_png: dict[str, float] = {}
        self.stats: dict | None = None                       # 这一轮 agent 用了多少轮、多久、多少钱
        self.outcome: dict | None = None                     # 这一轮换没换模型，换成了什么

    # ---------- state ----------

    @classmethod
    def create(cls, size: str) -> "Job":
        job = cls(new_id(), size)
        job.work.mkdir(parents=True, exist_ok=True)
        job.config.mkdir(parents=True, exist_ok=True)
        (job.config / "settings.json").write_text(json.dumps(SETTINGS, indent=2), encoding="utf-8")
        job.save()
        return job

    @classmethod
    def load(cls, job_id: str) -> "Job | None":
        if not re.fullmatch(r"[\w-]{4,40}", job_id or "") or not (JOBS / job_id / "state.json").exists():
            return None
        state = json.loads((JOBS / job_id / "state.json").read_text(encoding="utf-8"))
        job = cls(job_id, state.get("size", "model"))
        job.turn = state.get("turn", 0)
        job.model_hash = state.get("model_hash", "")
        log = JOBS / job_id / "events.jsonl"
        if log.exists():
            job.events = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
        return job

    def save(self) -> None:
        (self.dir / "state.json").write_text(
            json.dumps({"size": self.size, "turn": self.turn, "model_hash": self.model_hash}), encoding="utf-8"
        )

    def emit(self, **event: object) -> None:
        """Record one event and wake everyone watching this job."""
        event.setdefault("at", round(time.time(), 3))         # 刷新回来也能算出跑了多久
        with self.waiters:
            self.events.append(event)
            with (self.dir / "events.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps(event, ensure_ascii=False) + "\n")
            self.waiters.notify_all()

    def follow(self, start: int):
        """Yield (index, event) from `start` onwards, forever: the page keeps one stream per job."""
        index = max(0, start)
        while True:
            with self.waiters:
                while index >= len(self.events):
                    if not self.waiters.wait(timeout=20):
                        yield None, {"type": "ping"}
                event = self.events[index]
            yield index, event
            index += 1

    # ---------- a turn ----------

    def submit(self, text: str, image: str | None) -> None:
        """Queue one turn; returns as soon as the worker thread is running."""
        threading.Thread(target=self._turn, args=(text, image), daemon=True).start()

    def _turn(self, text: str, image: str | None) -> None:
        with self.lock:
            self.busy = True
            self.turn += 1
            self.emit(type="busy")
            photo = self._save_photo(image) if image else None
            self.emit(type="user", text=text, image=self._url(photo) if photo else None)
            try:
                prompt = self._prompt(text, photo)
                self.emit(type="stage", text="正在读你的照片，挑零件…" if photo else "正在想怎么搭…",
                          phase="look" if photo else "search")
                self._run_agent(prompt)
                self._finish()
            except Exception as error:                       # noqa: BLE001 - the page shows every failure
                self.emit(type="error", text=f"{type(error).__name__}: {error}")
            finally:
                self.busy = False
                self.save()
                self.emit(type="done", **(self.stats or {}), **(self.outcome or {}))
                self.stats = self.outcome = None
                self.emit(type="idle")

    def _save_photo(self, data_url: str) -> Path:
        head, _, body = data_url.partition(",")
        suffix = ".png" if "png" in head else ".jpg"
        path = self.work / f"reference{'' if self.turn == 1 else f'-{self.turn}'}{suffix}"
        path.write_bytes(base64.b64decode(body))
        shutil.copy(path, self.dir / path.name)
        return path

    def _prompt(self, text: str, photo: Path | None) -> str:
        if self.turn > 1:
            mention = f"\nThey attached another photo: /work/{photo.name} — look at it with Read.\n" if photo else ""
            return LATER_TURN.format(text=text or "(照片见附件)", photo=mention)
        description = text or "the object in the attached reference photo"
        rendered = subprocess.run(
            [str(PROMPT_PYTHON), str(REPO / "scripts" / "prompt.py"), description, "--split", SPLITS[self.size]],
            capture_output=True, text=True, check=True,
        ).stdout
        mention = (
            f"A reference photo of what they want is at `/work/{photo.name}`. Read it before you start and match "
            "its subject, proportions and colours as closely as real parts allow.\n\n"
            if photo else ""
        )
        return rendered + FIRST_TURN.format(photo=mention, scale=SCALE[self.size])

    def _run_agent(self, prompt: str) -> None:
        (self.dir / f"prompt-{self.turn}.txt").write_text(prompt, encoding="utf-8")
        command = [
            "docker", "run", "--rm", "-i",
            "-v", f"{self.work}:/work",
            "-v", f"{self.config}:/agent/.claude",
            *_proxy_env(),
            IMAGE, "claude", "--print", "--verbose", "--output-format", "stream-json",
            "--model", os.environ["AGENT_MODEL"], "--permission-mode", "bypassPermissions",
        ]
        command += ["--continue"] if self.turn > 1 else []
        command += [prompt]

        started, spoke = time.time(), False
        with (self.dir / f"agent-{self.turn}.jsonl").open("w", encoding="utf-8") as raw:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
            for line in process.stdout:
                raw.write(line)
                spoke = spoke or '"type":"assistant"' in line.replace(" ", "")
                if time.time() - started > TURN_TIMEOUT:
                    process.kill()
                    raise TimeoutError("这次搭得太久，已经停下了")
                try:
                    self._translate(json.loads(line))
                except json.JSONDecodeError:
                    continue
            stderr = process.stderr.read()
            if process.wait() != 0 and not spoke:
                raise RuntimeError(stderr.strip()[-500:] or "agent exited nonzero")

    def _translate(self, event: dict) -> None:
        """One stream-json event from Claude Code, as something the page can show."""
        kind = event.get("type")
        if kind == "assistant":
            for block in event.get("message", {}).get("content", []) or []:
                if block.get("type") == "text" and block.get("text", "").strip():
                    self.emit(type="assistant", text=block["text"].strip())
                elif block.get("type") == "thinking" and block.get("thinking", "").strip():
                    self.emit(type="thinking", text=_clip(block["thinking"], 160))
                elif block.get("type") == "tool_use":
                    self.emit(type="tool", text=_tool(block), phase=_phase(block))
        elif kind == "user":
            self._new_renders()
            for block in event.get("message", {}).get("content", []) or []:
                if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("is_error"):
                    self.emit(type="tool", text="  ↳ " + _clip(_text_of(block), 160), error=True, phase="fix")
        elif kind == "result":
            self._new_renders()
            self.stats = {                                    # 它搭完了，但还要检查和打包，收尾那行最后一起发
                "turns": event.get("num_turns", 0),
                "seconds": round(event.get("duration_ms", 0) / 1000),
                "cost": round(event.get("total_cost_usd") or 0, 2),
            }

    def _new_renders(self) -> None:
        """Show any PNG the agent has written or redrawn since the last check."""
        fresh = []
        for png in sorted(self.work.glob("*.png")):
            if png.name.startswith("reference"):
                continue                                      # the person's own photo, not the agent's work
            stamp = png.stat().st_mtime
            if self.seen_png.get(png.name) != stamp:
                self.seen_png[png.name] = stamp
                fresh.append(self._url(png) + f"?v={int(stamp)}")
        if fresh:
            self.emit(type="renders", urls=fresh)

    # ---------- after the agent stops ----------

    def _finish(self) -> None:
        mpd = self.work / "model.mpd"
        if not mpd.exists():
            self.emit(type="error", text="这一轮没有写出模型文件，可以再说一次要求试试。")
            return
        digest = hashlib.sha256(mpd.read_bytes()).hexdigest()
        if digest == self.model_hash:
            self.outcome = {"changed": False}                 # nothing changed: leave the viewer alone
            return
        self.model_hash = digest

        self.emit(type="stage", text="在检查碰撞和稳定性…", phase="verify")
        valid = self._verify()
        self.emit(type="stage", text="在整理零件清单…", phase="pack")
        self._export()
        self.emit(
            type="model",
            mpd=self._url(self.dir / "packed.mpd") + f"?v={digest[:8]}",
            manifest=(manifest := json.loads((self.dir / "manifest.json").read_text(encoding="utf-8"))),
            card=self._card(),
            valid=valid,
            reference=self._reference(),
        )
        self.outcome = {"changed": True, "total": manifest["total"], "kinds": manifest["kinds"], "valid": valid}

    def _verify(self) -> bool:
        done = _docker(BASE_IMAGE, [
            "-v", f"{self.dir}:/job", "-v", f"{REPO / 'scripts'}:/scripts:ro",
        ], ["python", "/scripts/verify.py", "/job/work", "--split", SPLITS[self.size]])
        return done.returncode == 0

    def _export(self) -> None:
        done = _docker(BASE_IMAGE, [
            "-v", f"{self.dir}:/job", "-v", f"{HERE / 'container'}:/ctr:ro",
        ], ["python", "/ctr/export_model.py", "/job/work/model.mpd", "/job/packed.mpd", "/job/manifest.json"])
        if done.returncode != 0:
            raise RuntimeError("打包模型失败：" + done.stderr.strip()[-300:])

    def _card(self) -> dict:
        try:
            return json.loads((self.work / "card.json").read_text(encoding="utf-8"))
        except Exception:                                      # noqa: BLE001 - the card is decoration
            return {}

    def _reference(self) -> str | None:
        shots = sorted(self.dir.glob("reference*"))
        return self._url(shots[-1]) if shots else None

    def _url(self, path: Path) -> str:
        return f"/jobs/{self.id}/{path.relative_to(self.dir).as_posix()}"


def _proxy_env() -> list[str]:
    model = os.environ["AGENT_MODEL"]
    small = os.environ.get("AGENT_SMALL_MODEL", model)
    pairs = {
        "ANTHROPIC_BASE_URL": os.environ["LITE_LLM_URL"],
        "ANTHROPIC_AUTH_TOKEN": os.environ["LITE_LLM_KEY"],
        "ANTHROPIC_API_KEY": os.environ["LITE_LLM_KEY"],
        "ANTHROPIC_MODEL": model,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": small,
        "ANTHROPIC_SMALL_FAST_MODEL": small,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": small,
        "CLAUDE_CODE_SUBAGENT_MODEL": model,
        "MAX_THINKING_TOKENS": os.environ.get("MAX_THINKING_TOKENS", "32000"),
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": os.environ.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "32000"),
        "BASH_DEFAULT_TIMEOUT_MS": "600000",
        "BASH_MAX_TIMEOUT_MS": "1800000",
    }
    return [argument for key, value in pairs.items() for argument in ("-e", f"{key}={value}")]


def _docker(image: str, mounts: list[str], command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", "run", "--rm", *mounts, image, *command], capture_output=True, text=True)


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit] + "…"


def _text_of(block: dict) -> str:
    content = block.get("content")
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content)


def _phase(block: dict) -> str | None:
    """这一步在干什么。页面靠它把一屏命令变成一条看得懂的进度。"""
    name = (block.get("name") or "").lower()
    args = block.get("input") or {}
    text = " ".join(str(v) for v in args.values()).lower()
    if name == "read":
        path = str(args.get("file_path", "")).lower()
        if path.endswith(".png"):
            return "look" if "reference" in path else "render"
        return None
    if name in ("write", "edit", "notebookedit"):
        return "write" if "build" in str(args.get("file_path", "")).lower() else None
    if name == "bash":
        if ".png" in text or "view(" in text:
            return "render"
        if "build.py" in text and "python" in text:
            return "build"                                    # 真的跑了一遍
        if any(k in text for k in ("find(", "describe(", "connectors(", "parts(", "measure(", "catalog")):
            return "search"
        if "build.py" in text:
            return "write"                                    # 写进去但还没跑
    return None


def _tool(block: dict) -> str:
    """A tool call as one line, in the words of what it does to the model."""
    name, args = block.get("name", "?"), block.get("input") or {}
    for key in ("command", "file_path", "pattern", "path", "prompt", "description", "url"):
        if key in args:
            return f"{name} · {_clip(args[key], 120)}"
    return f"{name} · {_clip(json.dumps(args, ensure_ascii=False), 120)}"
