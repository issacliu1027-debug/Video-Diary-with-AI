import json
import os
import secrets
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from flask import Flask, Response, abort, jsonify, request, send_from_directory

load_dotenv()  # load XAI_API_KEY from .env before importing the client

from interviewer import finalize, next_question  # noqa: E402

BASE = Path(__file__).resolve().parent
PUBLIC = BASE / "public"
SESSIONS = BASE / "sessions"
SESSIONS.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=None)

if not os.environ.get("XAI_API_KEY"):
    print("\n⚠️  XAI_API_KEY is not set. Copy .env.example to .env and paste your key.\n")


# ---- API key check ------------------------------------------------------
# This app talks ONLY to xAI (Grok). A key from another provider (OpenAI,
# Anthropic, Gemini, ...) can't work here, so the front-end uses this to block
# starting a diary with a missing / wrong-provider / invalid key.

XAI_MODELS_URL = "https://api.x.ai/v1/models"


@app.get("/api/key-status")
def api_key_status():
    key = os.environ.get("XAI_API_KEY", "").strip()
    if not key:
        return jsonify(ok=False, reason="missing")
    if not key.startswith("xai-"):
        # OpenAI keys start "sk-", Anthropic "sk-ant-", Google "AIza", etc.
        return jsonify(ok=False, reason="not_xai")
    # Confirm the key actually works against xAI (a cheap, free models call).
    try:
        r = httpx.get(
            XAI_MODELS_URL, headers={"Authorization": f"Bearer {key}"}, timeout=15
        )
        if r.status_code == 200:
            return jsonify(ok=True, reason="ok")
        if r.status_code in (401, 403):
            return jsonify(ok=False, reason="invalid")
        # Some other status — can't confirm, but don't hard-block on a hiccup.
        return jsonify(ok=True, reason="unverified")
    except Exception:  # noqa: BLE001 — a network blip shouldn't lock the user out
        return jsonify(ok=True, reason="unverified")


# ---- Static front-end ---------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(PUBLIC, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    # Serves styles.css, app.js, library.html, library.js from public/.
    return send_from_directory(PUBLIC, filename)


@app.get("/sessions/<sid>/video.webm")
def session_video(sid):
    directory = SESSIONS / os.path.basename(sid)
    if not (directory / "video.webm").exists():
        abort(404)
    return send_from_directory(directory, "video.webm")  # supports range/seeking


@app.get("/sessions/<sid>/thumb.jpg")
def session_thumb(sid):
    directory = SESSIONS / os.path.basename(sid)
    if not (directory / "thumb.jpg").exists():
        abort(404)
    return send_from_directory(directory, "thumb.jpg")


# ---- Interviewer brain --------------------------------------------------

def _recent_entries(limit=3):
    """Titles + summaries of the newest saved entries, so the interviewer can
    remember past sessions ("Last time you mentioned..."). Stays fully local."""
    entries = []
    for directory in SESSIONS.iterdir():
        meta = directory / "session.json"
        if directory.is_dir() and meta.exists():
            try:
                s = json.loads(meta.read_text())
                entries.append(
                    {
                        "createdAt": s.get("createdAt") or "",
                        "title": s.get("title") or "",
                        "summary": s.get("summary") or "",
                    }
                )
            except Exception:  # noqa: BLE001
                continue
    entries.sort(key=lambda x: x["createdAt"], reverse=True)
    return entries[:limit]


@app.post("/api/next-question")
def api_next_question():
    body = request.get_json(silent=True) or {}
    history = body.get("history") or []
    wrap_up = bool(body.get("wrapUp"))
    try:
        question = next_question(
            history, recent_entries=_recent_entries(), wrap_up=wrap_up
        )
        return jsonify(question=question)
    except Exception as err:  # noqa: BLE001
        app.logger.exception("next-question failed")
        return jsonify(error=str(err)), 500


@app.post("/api/finalize")
def api_finalize():
    transcript = (request.get_json(silent=True) or {}).get("transcript") or []
    try:
        return jsonify(finalize(transcript))
    except Exception as err:  # noqa: BLE001
        app.logger.exception("finalize failed")
        return jsonify(error=str(err)), 500


# ---- Speech-to-text (xAI / Grok) ----------------------------------------

XAI_STT_URL = "https://api.x.ai/v1/stt"


@app.post("/api/transcribe")
def api_transcribe():
    """Transcribe one spoken answer (raw audio bytes in the request body).
    Returns {"text": ""} on any failure so the front-end can fall back to the
    browser's live transcript without breaking the interview."""
    audio = request.get_data()
    if not audio or len(audio) < 200:
        return jsonify(text="")
    key = os.environ.get("XAI_API_KEY")
    if not key:
        return jsonify(text="")
    try:
        r = httpx.post(
            XAI_STT_URL,
            headers={"Authorization": f"Bearer {key}"},
            files={"file": ("answer.webm", audio, "audio/webm")},
            timeout=120,
        )
        if r.status_code != 200:
            app.logger.error("stt failed %s: %s", r.status_code, r.text[:300])
            return jsonify(text="")
        return jsonify(text=(r.json().get("text") or "").strip())
    except Exception:  # noqa: BLE001
        app.logger.exception("stt error")
        return jsonify(text="")


# ---- Voice (xAI / Grok text-to-speech) ---------------------------------

XAI_TTS_URL = "https://api.x.ai/v1/tts"
TTS_VOICES = {"ara", "eve", "leo", "rex", "sal"}


@app.post("/api/speak")
def api_speak():
    b = request.get_json(silent=True) or {}
    text = (b.get("text") or "").strip()
    voice = b.get("voice") if b.get("voice") in TTS_VOICES else "ara"
    if not text:
        return jsonify(error="no text"), 400
    key = os.environ.get("XAI_API_KEY")
    if not key:
        return jsonify(error="XAI_API_KEY not set"), 500
    try:
        r = httpx.post(
            XAI_TTS_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"text": text[:2000], "voice_id": voice, "language": "en"},
            timeout=90,
        )
        if r.status_code != 200:
            app.logger.error("tts failed %s: %s", r.status_code, r.text[:300])
            return jsonify(error=f"tts {r.status_code}"), 502
        return Response(r.content, mimetype=r.headers.get("content-type", "audio/mpeg"))
    except Exception as err:  # noqa: BLE001
        app.logger.exception("tts error")
        return jsonify(error=str(err)), 502


# ---- Saving & reading sessions -----------------------------------------

@app.post("/api/sessions")
def api_create_session():
    b = request.get_json(silent=True) or {}
    sid = f"s_{int(time.time() * 1000)}_{secrets.token_hex(3)}"
    directory = SESSIONS / sid
    directory.mkdir(parents=True, exist_ok=True)
    chapters = b.get("chapters")
    transcript = b.get("transcript")
    session = {
        "id": sid,
        "createdAt": b.get("createdAt") or datetime.now(timezone.utc).isoformat(),
        "title": b.get("title") or "Untitled entry",
        "summary": b.get("summary") or "",
        "chapters": chapters if isinstance(chapters, list) else [],
        "transcript": transcript if isinstance(transcript, list) else [],
        "durationSec": b.get("durationSec") or 0,
    }
    (directory / "session.json").write_text(json.dumps(session, indent=2))
    return jsonify(id=sid)


@app.post("/api/sessions/<sid>/video")
def api_save_video(sid):
    directory = SESSIONS / os.path.basename(sid)
    if not directory.exists():
        return jsonify(error="session not found"), 404
    (directory / "video.webm").write_bytes(request.get_data())
    return jsonify(ok=True)


@app.post("/api/sessions/<sid>/thumb")
def api_save_thumb(sid):
    directory = SESSIONS / os.path.basename(sid)
    if not directory.exists():
        return jsonify(error="session not found"), 404
    (directory / "thumb.jpg").write_bytes(request.get_data())
    return jsonify(ok=True)


@app.get("/api/sessions")
def api_list_sessions():
    items = []
    for directory in SESSIONS.iterdir():
        meta = directory / "session.json"
        if directory.is_dir() and meta.exists():
            s = json.loads(meta.read_text())
            items.append({k: s.get(k) for k in ("id", "createdAt", "title", "summary", "durationSec")})
    items.sort(key=lambda x: x.get("createdAt") or "", reverse=True)
    return jsonify(items)


@app.get("/api/sessions/<sid>")
def api_get_session(sid):
    meta = SESSIONS / os.path.basename(sid) / "session.json"
    if not meta.exists():
        return jsonify(error="not found"), 404
    return jsonify(json.loads(meta.read_text()))


@app.delete("/api/sessions/<sid>")
def api_delete_session(sid):
    directory = SESSIONS / os.path.basename(sid)
    if not directory.exists():
        return jsonify(error="not found"), 404
    shutil.rmtree(directory, ignore_errors=True)  # removes video.webm + session.json
    return jsonify(ok=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    print(f"\n🎥  AI Video Diary running at http://localhost:{port}")
    print("   Open it in Google Chrome, and grant camera + microphone access.\n")
    app.run(host="127.0.0.1", port=port, threaded=True)
