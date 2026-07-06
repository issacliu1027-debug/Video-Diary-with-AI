import json
import os
import re
import secrets
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

# Recordings started within this window of the previous entry are added onto it
# as another "part" (same day's reflection) instead of becoming a separate entry.
MERGE_WINDOW_SECONDS = 5 * 3600

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


@app.get("/sessions/<sid>/<filename>")
def session_media(sid, filename):
    # Serves an entry's video part(s) — video.webm, video-2.webm, … — or its
    # thumbnail. The filename is whitelisted so nothing else can be read.
    if not re.fullmatch(r"video(-\d+)?\.webm|thumb\.jpg", filename):
        abort(404)
    directory = SESSIONS / os.path.basename(sid)
    if not (directory / filename).exists():
        abort(404)
    return send_from_directory(directory, filename)  # supports range/seeking


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

    continuation = None
    if not history and not wrap_up:
        # Opening question. If the most recent entry is still within the merge window,
        # this recording will be added onto it — so greet as a continuation of it.
        newest = _newest_entry()
        if newest is not None:
            _, entry = newest
            last = _entry_last_activity(entry)
            if last is not None and (
                datetime.now(timezone.utc) - last
            ).total_seconds() <= MERGE_WINDOW_SECONDS:
                parts = entry.get("parts")
                recent_summary = (
                    (parts[-1].get("summary") if isinstance(parts, list) and parts else None)
                    or entry.get("summary")
                    or ""
                ).strip()
                title = (entry.get("title") or "").strip()
                if title.lower() == "untitled entry":
                    title = ""
                if title or recent_summary:  # only if there's a real topic to name
                    continuation = {"title": title, "summary": recent_summary}

    try:
        question = next_question(
            history,
            recent_entries=_recent_entries(),
            wrap_up=wrap_up,
            continuation=continuation,
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

def _parse_ts(ts):
    """Parse an ISO timestamp (the front-end sends ...Z) to an aware UTC datetime."""
    try:
        return datetime.fromisoformat((ts or "").replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return None


def _entry_last_activity(session):
    """When an entry was last added to (its newest part) — used for the merge window."""
    return _parse_ts(session.get("lastAt") or session.get("createdAt"))


def _newest_entry():
    """(directory, session) of the entry with the most recent activity, or None."""
    newest = None
    newest_ts = None
    for directory in SESSIONS.iterdir():
        meta = directory / "session.json"
        if not (directory.is_dir() and meta.exists()):
            continue
        try:
            s = json.loads(meta.read_text())
        except Exception:  # noqa: BLE001
            continue
        ts = _entry_last_activity(s)
        if ts is not None and (newest_ts is None or ts > newest_ts):
            newest, newest_ts = (directory, s), ts
    return newest


@app.post("/api/sessions")
def api_create_session():
    b = request.get_json(silent=True) or {}
    created = b.get("createdAt") or datetime.now(timezone.utc).isoformat()
    duration = b.get("durationSec") or 0
    turns = b.get("transcript") if isinstance(b.get("transcript"), list) else []
    chapters = b.get("chapters") if isinstance(b.get("chapters"), list) else []
    summary = b.get("summary") or ""
    title = b.get("title") or "Untitled entry"

    # --- Continuation? If the most recent entry is within the merge window, add
    #     this recording onto it as another part instead of making a new entry. ---
    newest = _newest_entry()
    if newest is not None:
        directory, entry = newest
        last = _entry_last_activity(entry)
        now = _parse_ts(created) or datetime.now(timezone.utc)
        if last is not None and (now - last).total_seconds() <= MERGE_WINDOW_SECONDS:
            # On the first append, migrate the flat single-clip entry into parts[].
            parts = entry.get("parts")
            if not isinstance(parts, list) or not parts:
                parts = [{
                    "createdAt": entry.get("createdAt"),
                    "durationSec": entry.get("durationSec") or 0,
                    "video": "video.webm",
                    "transcript": entry.get("transcript") if isinstance(entry.get("transcript"), list) else [],
                    "chapters": entry.get("chapters") if isinstance(entry.get("chapters"), list) else [],
                    "summary": entry.get("summary") or "",
                }]
            video_name = f"video-{len(parts) + 1}.webm"
            parts.append({
                "createdAt": created,
                "durationSec": duration,
                "video": video_name,
                "transcript": turns,
                "chapters": chapters,
                "summary": summary,
            })
            entry["parts"] = parts
            entry["lastAt"] = created
            entry["durationSec"] = sum(p.get("durationSec") or 0 for p in parts)
            entry["transcript"] = [t for p in parts for t in (p.get("transcript") or [])]
            # title + summary stay from part 1 (the entry's identity / card preview)
            (directory / "session.json").write_text(json.dumps(entry, indent=2))
            return jsonify(id=entry["id"], videoName=video_name, appended=True)

    # --- Otherwise a brand-new entry (same flat shape as before, plus lastAt). ---
    sid = f"s_{int(time.time() * 1000)}_{secrets.token_hex(3)}"
    directory = SESSIONS / sid
    directory.mkdir(parents=True, exist_ok=True)
    session = {
        "id": sid,
        "createdAt": created,
        "lastAt": created,
        "title": title,
        "summary": summary,
        "chapters": chapters,
        "transcript": turns,
        "durationSec": duration,
    }
    (directory / "session.json").write_text(json.dumps(session, indent=2))
    return jsonify(id=sid, videoName="video.webm", appended=False)


@app.post("/api/sessions/<sid>/video")
def api_save_video(sid):
    directory = SESSIONS / os.path.basename(sid)
    if not directory.exists():
        return jsonify(error="session not found"), 404
    name = request.args.get("name", "video.webm")
    if not re.fullmatch(r"video(-\d+)?\.webm", name):  # guard against path traversal
        name = "video.webm"
    (directory / name).write_bytes(request.get_data())
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
            item = {k: s.get(k) for k in ("id", "createdAt", "title", "summary", "durationSec")}
            parts = s.get("parts")
            item["partCount"] = len(parts) if isinstance(parts, list) and parts else 1
            items.append(item)
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


@app.delete("/api/sessions/<sid>/parts/<int:idx>")
def api_delete_part(sid, idx):
    """Delete just one part (recording) of a multi-part entry, keeping the rest.
    If it's the only remaining part, the whole entry is removed."""
    directory = SESSIONS / os.path.basename(sid)
    meta = directory / "session.json"
    if not meta.exists():
        return jsonify(error="not found"), 404
    entry = json.loads(meta.read_text())
    parts = entry.get("parts")

    # A single-clip entry (or one down to its last part): "delete the part" = delete
    # the whole entry.
    if not isinstance(parts, list) or len(parts) <= 1:
        shutil.rmtree(directory, ignore_errors=True)
        return jsonify(ok=True, entryDeleted=True)

    if idx < 0 or idx >= len(parts):
        return jsonify(error="bad part index"), 400

    removed = parts.pop(idx)
    vid = removed.get("video")
    if vid and re.fullmatch(r"video(-\d+)?\.webm", vid):
        (directory / vid).unlink(missing_ok=True)  # delete that clip's video file

    if not parts:  # removed the last one → drop the whole entry
        shutil.rmtree(directory, ignore_errors=True)
        return jsonify(ok=True, entryDeleted=True)

    # Recompute the entry's aggregates from the remaining parts.
    entry["parts"] = parts
    entry["durationSec"] = sum(p.get("durationSec") or 0 for p in parts)
    entry["transcript"] = [t for p in parts for t in (p.get("transcript") or [])]
    entry["createdAt"] = parts[0].get("createdAt") or entry.get("createdAt")
    entry["lastAt"] = parts[-1].get("createdAt") or entry.get("lastAt")
    entry["summary"] = parts[0].get("summary") or entry.get("summary") or ""  # keep title
    meta.write_text(json.dumps(entry, indent=2))
    return jsonify(ok=True, entryDeleted=False)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    print(f"\n🎥  AI Video Diary running at http://localhost:{port}")
    print("   Open it in Google Chrome, and grant camera + microphone access.\n")
    app.run(host="127.0.0.1", port=port, threaded=True)
