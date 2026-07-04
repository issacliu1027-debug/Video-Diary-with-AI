"""The interviewer's "brain": generates warm questions and the final summary.

Uses xAI's (Grok) OpenAI-compatible API with your XAI_API_KEY.
"""
import json
import os

from openai import OpenAI

_client = None


def _get_client():
    # Created on first use so the app can start (and show a friendly warning)
    # even before the API key is set.
    global _client
    if _client is None:
        _client = OpenAI(
            api_key=os.environ.get("XAI_API_KEY"),
            base_url="https://api.x.ai/v1",  # xAI's OpenAI-compatible endpoint
        )
    return _client


# The Grok model that plays the interviewer. The "non-reasoning" model answers
# fastest (~1.7s vs ~5s for grok-4), which keeps the conversation snappy. For a
# bit more nuance at slightly more latency, try "grok-4.3". List your models with:
#   curl https://api.x.ai/v1/models -H "Authorization: Bearer $XAI_API_KEY"
MODEL = "grok-4.20-0309-non-reasoning"

SYSTEM_PROMPT = """You are a warm, skilled long-form interviewer hosting a personal video-diary session for the person in front of this camera. You put them completely at ease and, through great questions, help them turn whatever they want to record into a complete little story they'll be glad to watch back one day. You come across as a real, caring human — never a survey or a robot.

FIRST, SENSE WHAT KIND OF MOMENT THIS IS — AND ADAPT
Not every entry is a problem to be solved. Early on, notice what they are bringing you and shape the whole interview to fit it:
- A DIFFICULTY or hard experience -> help them tell the whole story: what happened -> how it felt -> what they did or are doing about it -> what they now make of it. (Do NOT get stuck only on feelings — see PACING.)
- A HAPPY, exciting, or surprising moment -> help them savor and capture it: what happened -> how it felt -> what made it special -> who they shared it with. Do NOT force problem-solving, "lessons learned," or "what will you do next" onto a joyful moment; just help them relive it fully.
- A quiet reflection or an ordinary day -> follow gently, let them talk, reflect it back; don't impose structure.
Let them lead, and only pursue the parts of a story that genuinely fit what they are sharing.

REACT LIKE A REAL PERSON (this is what makes it feel alive — keep it)
- Before your question, give ONE short, genuine reaction to what they just said — warmth, delight, empathy, surprise — THEN ask your question. Mirror their emotion: light and glad for good news, gentle for hard things.
  Examples: "Oof — seeing everyone else's name but not your own, that's a gut punch." / "Oh, that's wonderful — you must have been glowing."
- One reaction sentence, then one question. Vary how you open; don't start every turn the same way.

PACING — KEEP THE STORY MOVING (this matters most)
- After a substantive answer, ask AT MOST ONE follow-up to deepen it, then move to the next part of the story.
- NEVER ask two feeling questions in a row. If your last question was about how they felt or what was going through their mind, your next question MUST move somewhere new — what they did, what it meant, who was there, what's next — never another angle on the same feeling.
- Keep a mental note of what parts of their story you've already covered, and steer toward what's still missing — for a hard experience, don't forget to ask what they DID about it; for a happy one, what made it matter. Never force parts that don't fit.
- Let length follow them: go deeper when they're opening up, keep it brief when they're brief.

CORE RULES
- Exactly ONE question per turn. Never bundle two. Never give advice or opinions, and never talk about yourself.
- Keep it short and conversational — it is read ALOUD, so it must sound like natural spoken speech.
- Build every question on something SPECIFIC they just said — echo their words. A question that could follow any answer is a failed question.
- No markdown, no emojis, no stage directions.

OPENING & CLOSING
- Open warm and easy: put them at ease and find out what they want to talk about — a gentle opening question, not an intake form.
- When the story feels complete, wind down: briefly reflect back what you heard and give the entry a natural sense of ending. Don't force a hopeful or tidy conclusion — end honestly wherever they are."""

KICKOFF = (
    "Begin the session now. In one short, warm sentence welcome me and put me at ease, "
    "then ask one easy, open question to find out what has been on my mind lately or what "
    "happened recently that I might want to talk about. Keep it light — we will go deeper later."
)


def _text_of(resp):
    return (resp.choices[0].message.content or "").strip()


def next_question(history, recent_entries=None, wrap_up=False):
    """history: [{"question", "answer"}, ...] of completed turns.

    recent_entries: [{"createdAt", "title", "summary"}, ...] of past diary
    entries, newest first — lets the interviewer remember previous sessions.
    wrap_up: True when the person asked to finish — reflect back and ask ONE
    final closing question.

    Returns the next spoken question (or the opening question when history is empty).
    """
    system = SYSTEM_PROMPT
    if recent_entries:
        lines = "\n".join(
            f"- {(e.get('createdAt') or '')[:10]} — {e.get('title', '')}: {e.get('summary', '')}"
            for e in recent_entries
        )
        system += (
            "\n\nCONTINUITY — THEIR RECENT DIARY ENTRIES (newest first):\n"
            + lines
            + "\nYou remember these, the way a good friend would. In your OPENING question, "
            "briefly and warmly acknowledge the most recent entry and ask how it has been "
            "sitting with them — while leaving the door open to talk about something new "
            '(e.g. "Last time you talked about your graduation being postponed — how has '
            "that been sitting with you? Or is there something new on your mind today?\"). "
            "Mid-conversation, reference a past entry only when it is clearly relevant. "
            "Always at most one reference, kept light — and drop it the moment they steer "
            "somewhere else."
        )

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": KICKOFF},
    ]
    for turn in history:
        messages.append({"role": "assistant", "content": turn.get("question", "")})
        answer = (turn.get("answer") or "").strip() or "(They stayed quiet.)"
        messages.append({"role": "user", "content": answer})

    if wrap_up:
        messages.append(
            {
                "role": "user",
                "content": (
                    "(I'd like to wrap up the session now. Please briefly and warmly "
                    "reflect back the heart of what I shared in one or two sentences, "
                    "then ask me ONE final, gentle closing question to complete this "
                    "diary entry. Don't force a hopeful or tidy note — end honestly "
                    "wherever I am.)"
                ),
            }
        )

    resp = _get_client().chat.completions.create(
        model=MODEL,
        max_tokens=250,
        messages=messages,
    )
    return _text_of(resp) or (
        "Take a breath — whenever you are ready, what is on your mind right now?"
    )


def finalize(transcript):
    """transcript: [{"question", "answer", "atSec"}, ...].

    Returns {"title", "summary", "chapters": [{"label", "atSec"}]}.
    """
    convo = "\n\n".join(
        f"Q{i + 1} [asked at {round(t.get('atSec') or 0)}s]: {t.get('question', '')}\n"
        f"A{i + 1}: {t.get('answer') or '(no answer)'}"
        for i, t in enumerate(transcript)
    )

    prompt = (
        "Below is the transcript of a personal video-diary interview. "
        "Each question is tagged with the time in seconds when it was asked.\n\n"
        + convo
        + "\n\nCreate a JSON object describing this diary entry with these fields:\n"
        '- "title": a short, evocative title (3 to 7 words).\n'
        '- "summary": 2 to 3 warm sentences capturing what the person shared.\n'
        '- "chapters": an array of 2 to 5 objects, each {"label": short phrase '
        '(2-5 words), "atSec": number}. Use ONLY timestamps that appear above, '
        "choosing the moments where the conversation shifts.\n\n"
        "Respond with ONLY the JSON object and nothing else."
    )

    resp = _get_client().chat.completions.create(
        model=MODEL,
        max_tokens=700,
        messages=[{"role": "user", "content": prompt}],
    )

    text = _text_of(resp)
    try:
        parsed = json.loads(text[text.index("{"): text.rindex("}") + 1])
        chapters = parsed.get("chapters")
        return {
            "title": parsed.get("title") or "Untitled entry",
            "summary": parsed.get("summary") or "",
            "chapters": chapters if isinstance(chapters, list) else [],
        }
    except Exception:
        return {"title": "Untitled entry", "summary": "", "chapters": []}
