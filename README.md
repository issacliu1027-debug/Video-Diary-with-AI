# 🎥 Video Diary with AI

> **Journal your life by _talking_, not typing.**
> A warm AI interviewer asks you gentle questions out loud while your webcam records —
> then saves a replayable video with an auto-written title, summary, and chapter
> markers. Everything stays on your own computer.

**Runs on:** 🐍 Python · 🌐 Google Chrome · 🤖 xAI (Grok)

---

## ✨ What it does

Ever open a journal and stare at the blank page? This app removes that friction —
you just **talk to a friendly interviewer** and it turns your words into a keepsake video.

- 🎙️ **An AI interviewer** greets you and asks gentle, thoughtful questions — it reacts
  to what you say and asks natural follow-ups, like a real documentary host.
- 🔊 **It speaks out loud** in a warm, human voice (xAI Grok text-to-speech).
- 📼 **Your webcam records** the whole session; you can replay it any time — with **both**
  the interviewer's voice and your own.
- 📝 **Automatic write-up** — each entry gets a title, a short summary, and chapter markers.
- 🧠 **It remembers you** — the interviewer may reference your last entry ("Last time you
  mentioned…").
- 🪄 **Two cozy pixel-art scenes** — a warm room and a spaceship cockpit — and your webcam
  plays *inside* the on-screen monitor. Switch anytime with the button in the top-left.
- 🔒 **Private by design** — your videos and transcripts are saved **only on your computer**
  and are never uploaded anywhere.

---

## 🧰 Before you start — what you need

| Requirement | Notes |
|---|---|
| **Python 3** | Already on most Macs. Windows users: install from [python.org](https://www.python.org/downloads/) (tick *"Add Python to PATH"*). |
| **Google Chrome** | The live captions & recording use Chrome-only features. |
| **A free xAI (Grok) API key** | Get one at **[console.x.ai](https://console.x.ai)** → *API Keys*. |

> ⚠️ **This app uses xAI (Grok) only.** Keys from other providers (OpenAI, Anthropic,
> Google, etc.) **will not work**. The app checks your key when it opens and won't let
> you start a diary until a valid **xAI** key is in place.

---

## 🚀 Setup — one time only

You'll type a few commands into your computer's **Terminal** (Mac) or
**Command Prompt / PowerShell** (Windows). Don't worry — just copy, paste, and press Enter.

### 1️⃣ Download the code

**Option A — the easy way (no tools needed):**
Click the green **`< > Code`** button at the top of this page → **Download ZIP** → unzip it.

**Option B — with git:**
```bash
git clone https://github.com/issacliu1027-debug/Video-Diary-with-AI.git
```

Then open a terminal **inside that folder** (the one containing `app.py`).

### 2️⃣ Add your xAI key

1. In the folder, find the file **`.env.example`**.
2. Make a copy of it named exactly **`.env`**.
3. Open `.env` in any text editor and paste your key:
   ```
   XAI_API_KEY=xai-your-key-here
   ```
   *(This file stays on your computer and is never shared or uploaded.)*

### 3️⃣ Install it (creates a small private environment)

**On Mac / Linux:**
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**On Windows:**
```bat
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

You only do steps 1–3 once. ✅

---

## ▶️ Running it — every time

**Mac / Linux:**
```bash
source venv/bin/activate
python app.py
```

**Windows:**
```bat
venv\Scripts\activate
python app.py
```

Then open **[http://localhost:3000](http://localhost:3000) in Google Chrome** and allow
**camera + microphone** when asked.

To stop the app, press **`Ctrl + C`** in the terminal.

---

## 🎙️ How to use it

1. **Click "Start the interview."** The interviewer greets you and asks a question aloud.
2. **Answer out loud.** Your words appear as live captions (you can also type). When you
   click **Done — next question**, your answer is re-transcribed cleanly and the next
   question comes.
3. **🔊 Replay a question** any time with the speaker button.
4. **Switch the scene** (room ↔ spaceship) with the button in the **top-left corner**.
5. **Wrap up** when you're ready — the interviewer asks one warm closing question, then
   your entry is saved. *(Or hit **End & save now** to finish immediately.)*
6. **Revisit anything** under **Past entries** — replay the video with its transcript and
   chapters, or delete an entry.

---

## 🔒 Your privacy

- Your **videos, transcripts, and thumbnails** are saved in the **`sessions/`** folder on
  your computer. They are **never** uploaded anywhere.
- The only things sent over the internet are the **text of your conversation** and your
  **spoken audio**, which go to **xAI (Grok)** to generate the next question, the voice,
  and the transcript.
- Deleting an entry in **Past entries** permanently removes its files from your computer.

---

## 🎨 Make it yours

- **Change the interviewer's voice:** edit `VOICE_ID` in `public/app.js` — options are
  `ara` (default), `eve`, `leo`, `rex`, `sal`.
- **Change the model:** edit `MODEL` in `interviewer.py` (default
  `grok-4.20-0309-non-reasoning`, chosen because it replies fast).

---

## 🩺 Troubleshooting

| Problem | Fix |
|---|---|
| **"This diary only works with an xAI key"** | You entered a non-xAI key. Get an xAI key at [console.x.ai](https://console.x.ai) and put it in `.env`. |
| **"That xAI key didn't work"** | The key is mistyped or turned off — copy it again from console.x.ai. |
| **The Start button stays greyed out** | Allow camera + mic, and make sure your `.env` has a valid xAI key. |
| **Camera/mic not working** | Use **Chrome**, and click **Allow** when it asks for permission. |
| **`model not found`** | List the models your key can use and pick one: `curl https://api.x.ai/v1/models -H "Authorization: Bearer $XAI_API_KEY"` |
| **"Port 3000 is in use"** | Something else is using it. Run with a different port: `PORT=3001 python app.py`. |
| **The interviewer's voice sounds robotic** | That's the browser fallback voice — it only happens if xAI's voice service briefly fails. Try again. |

---

## 🤝 For anyone sharing or forking this

Your **`.env`** (API key) and **`sessions/`** (your videos) are already listed in
`.gitignore`, so they stay private and are never committed or uploaded. Anyone who
downloads this repo simply adds **their own** xAI key during setup — never share your own,
since usage is billed to whoever owns the key.

---

## 🛠️ Built with

Python (Flask) · vanilla HTML/CSS/JavaScript · the browser's camera, recording & speech
APIs · and **xAI (Grok)** for the interviewer's brain, voice, and transcription.

*Made with ❤️ for people who'd rather talk than write.*
