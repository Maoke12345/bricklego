#!/usr/bin/env python3
"""砖语 server: the page, the job API, and the live transcript.

    python3 server.py [--port 8787]

Reads .env for the proxy key and model, then serves web/ and runs each request through pipeline.Job.
Everything is local: jobs live in jobs/<id>/, and the only thing that leaves this host is the agent's
own traffic to the LiteLLM proxy.
"""

import argparse
import json
import mimetypes
import os
from pathlib import Path
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

import pipeline
from pipeline import Job

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
MAX_BODY = 24 * 1024 * 1024          # a 1536px JPEG, base64, with room to spare

jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()


def load_env(path: Path = HERE / ".env") -> None:
    """KEY=value lines; anything already in the environment wins."""
    if not path.exists():
        raise SystemExit(f"missing {path}: it needs LITE_LLM_KEY, LITE_LLM_URL and AGENT_MODEL")
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"\s*([A-Za-z_]\w*)\s*=\s*(.*)\s*$", line)
        if match and not line.lstrip().startswith("#"):
            os.environ.setdefault(match.group(1), match.group(2).strip().strip("'\""))


def get_job(job_id: str) -> Job | None:
    with jobs_lock:
        if job_id in jobs:
            return jobs[job_id]
        job = Job.load(job_id)
        if job:
            jobs[job_id] = job
        return job


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "brickstudio"

    def log_message(self, fmt: str, *args) -> None:
        if not self.path.startswith(("/web/", "/vendor/")):
            print(f"{self.address_string()} {fmt % args}")

    # ---------- replies ----------

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path) -> None:
        if not path.is_file():
            return self.send_json({"error": "not found"}, 404)
        body = path.read_bytes()
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix in (".js", ".mjs"):
            kind = "text/javascript"
        if path.suffix in (".mpd", ".ldr", ".txt"):
            kind = "text/plain; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache" if path.suffix in (".html", ".js") else "max-age=600")
        self.end_headers()
        self.wfile.write(body)

    def under(self, root: Path, relative: str) -> Path | None:
        """A request path resolved inside `root`, or None if it tries to climb out."""
        path = (root / relative.lstrip("/")).resolve()
        return path if root.resolve() in path.parents or path == root.resolve() else None

    def body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("Request too large. Keep the photo to a few MB.")
        return json.loads(self.rfile.read(length) or b"{}")

    # ---------- routes ----------

    def do_GET(self) -> None:                                  # noqa: N802 - BaseHTTPRequestHandler's name
        path = self.path.split("?")[0]
        if path == "/":
            return self.send_file(WEB / "index.html")
        if path.startswith("/jobs/"):
            return self.serve_job_file(path)
        if match := re.fullmatch(r"/api/jobs/([\w-]+)", path):
            job = get_job(match.group(1))
            return self.send_json({"id": job.id, "busy": job.busy, "turn": job.turn} if job else {"error": "Job not found."}, 200 if job else 404)
        if match := re.fullmatch(r"/api/jobs/([\w-]+)/events", path):
            return self.stream(match.group(1))
        target = self.under(WEB, path)
        return self.send_file(target) if target else self.send_json({"error": "not found"}, 404)

    def do_POST(self) -> None:                                 # noqa: N802
        path = self.path.split("?")[0]
        try:
            payload = self.body()
        except Exception as error:                             # noqa: BLE001
            return self.send_json({"error": str(error)}, 400)

        if path == "/api/jobs":
            size = payload.get("size") if payload.get("size") in pipeline.SPLITS else "model"
            job = Job.create(size)
            with jobs_lock:
                jobs[job.id] = job
            job.submit((payload.get("text") or "").strip()[:4000], payload.get("image"))
            return self.send_json({"id": job.id})

        if match := re.fullmatch(r"/api/jobs/([\w-]+)/messages", path):
            job = get_job(match.group(1))
            if not job:
                return self.send_json({"error": "Job not found."}, 404)
            if job.busy:
                return self.send_json({"error": "This build is still running. Wait for it to finish."}, 409)
            job.submit((payload.get("text") or "").strip()[:4000], payload.get("image"))
            return self.send_json({"id": job.id})

        return self.send_json({"error": "not found"}, 404)

    def serve_job_file(self, path: str) -> None:
        match = re.fullmatch(r"/jobs/([\w-]+)/(.+)", path)
        if not match:
            return self.send_json({"error": "not found"}, 404)
        target = self.under(pipeline.JOBS / match.group(1), match.group(2))
        return self.send_file(target) if target else self.send_json({"error": "not found"}, 404)

    def stream(self, job_id: str) -> None:
        """Server-sent events: the whole transcript so far, then everything as it happens."""
        job = get_job(job_id)
        if not job:
            return self.send_json({"error": "Job not found."}, 404)
        resumed = self.headers.get("Last-Event-ID")
        asked = re.search(r"[?&]from=(\d+)", self.path)
        resume = int(resumed) + 1 if (resumed or "").isdigit() else int(asked.group(1)) if asked else 0
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            for index, event in job.follow(resume):
                label = f"id: {index}\n" if index is not None else ""
                self.wfile.write(f"{label}data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    load_env()
    for key in ("LITE_LLM_KEY", "LITE_LLM_URL", "AGENT_MODEL"):
        if not os.environ.get(key):
            raise SystemExit(f"set {key} in .env")
    pipeline.JOBS.mkdir(exist_ok=True)
    if not pipeline.PROMPT_PYTHON.exists():
        raise SystemExit(f"missing {pipeline.PROMPT_PYTHON}: set PROMPT_PYTHON to a python with jinja2")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"砖语 · http://{args.host}:{args.port}  (模型 {os.environ['AGENT_MODEL']})")
    server.serve_forever()


if __name__ == "__main__":
    main()
