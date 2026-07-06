const listEl = document.getElementById('list');
const detailEl = document.getElementById('detail');
const emptyEl = document.getElementById('empty');

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
function fmtDur(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

async function loadList() {
  const res = await fetch('/api/sessions');
  const sessions = await res.json();
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', sessions.length > 0);

  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <img class="card-thumb" src="/sessions/${encodeURIComponent(s.id)}/thumb.jpg"
           alt="" onerror="this.remove()" />
      <div class="card-main">
        <span class="card-title">${escapeHtml(s.title)}</span>
        <span class="card-meta">${fmtDate(s.createdAt)} · ${fmtDur(s.durationSec)}${
          s.partCount > 1 ? ` · ${s.partCount} parts` : ''
        }</span>
        <span class="card-summary">${escapeHtml(s.summary || '')}</span>
      </div>
      <button class="card-del" title="Delete this entry">Delete</button>`;
    card.querySelector('.card-main').addEventListener('click', () => loadDetail(s.id));
    const thumb = card.querySelector('.card-thumb');
    if (thumb) thumb.addEventListener('click', () => loadDetail(s.id));
    card.querySelector('.card-del').addEventListener('click', () => deleteEntry(s));
    listEl.appendChild(card);
  }
}

async function deleteEntry(s) {
  const ok = confirm(
    `Delete "${s.title}"?\n\nThis permanently removes the video and its transcript from your computer, and cannot be undone.`
  );
  if (!ok) return;
  try {
    const res = await fetch('/api/sessions/' + s.id, { method: 'DELETE' });
    if (!res.ok) throw new Error('delete failed');
    // Return to the list and refresh it.
    detailEl.classList.add('hidden');
    detailEl.innerHTML = '';
    listEl.classList.remove('hidden');
    await loadList();
  } catch {
    alert('Sorry, that entry could not be deleted. Please try again.');
  }
}

function chaptersHtml(list) {
  return (list || [])
    .map(
      (c) =>
        `<button class="chapter" data-t="${Number(c.atSec) || 0}">${escapeHtml(
          c.label
        )} · ${fmtDur(Math.round(Number(c.atSec) || 0))}</button>`
    )
    .join('');
}

function transcriptHtml(turns) {
  return (turns || [])
    .map(
      (t) =>
        `<div class="turn"><p class="q">${escapeHtml(t.question)}</p><p class="a">${
          t.answer
            ? escapeHtml(t.answer)
            : '<em class="no-answer">(no spoken answer)</em>'
        }</p></div>`
    )
    .join('');
}

async function deletePart(s, idx) {
  const ok = confirm(
    `Delete Part ${idx + 1} of "${s.title}"?\n\n` +
      'This permanently removes just this one recording. The rest of the entry stays.'
  );
  if (!ok) return;
  try {
    const res = await fetch(`/api/sessions/${s.id}/parts/${idx}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('delete failed');
    if (data.entryDeleted) {
      // That was the only part left — the whole entry is gone; go back to the list.
      detailEl.classList.add('hidden');
      detailEl.innerHTML = '';
      listEl.classList.remove('hidden');
      await loadList();
    } else {
      await loadDetail(s.id); // re-render with the remaining parts
    }
  } catch {
    alert('Sorry, that part could not be deleted. Please try again.');
  }
}

async function loadDetail(id) {
  const res = await fetch('/api/sessions/' + id);
  const s = await res.json();
  detailEl.classList.remove('hidden');
  listEl.classList.add('hidden');

  // Normalize to a list of parts so old single-clip entries and new multi-part
  // entries (recorded within 5h of each other) render the same way.
  const parts =
    Array.isArray(s.parts) && s.parts.length
      ? s.parts
      : [
          {
            video: 'video.webm',
            createdAt: s.createdAt,
            transcript: s.transcript || [],
            chapters: s.chapters || [],
          },
        ];
  const multi = parts.length > 1;

  const partsHtml = parts
    .map((p, i) => {
      const header = multi
        ? `<div class="part-head">
             <span class="part-header">Part ${i + 1} · ${fmtDate(p.createdAt)}</span>
             <button class="part-del danger" data-idx="${i}">🗑 Delete this part</button>
           </div>`
        : '';
      const chapters = chaptersHtml(p.chapters);
      return `
      <div class="part">
        ${header}
        <video class="player" src="/sessions/${s.id}/${p.video || 'video.webm'}" controls playsinline></video>
        ${chapters ? `<div class="chapters">${chapters}</div>` : ''}
        <div class="transcript">${transcriptHtml(p.transcript)}</div>
      </div>`;
    })
    .join('');

  const dateLine = multi
    ? `${fmtDate(s.createdAt)} · ${parts.length} parts`
    : fmtDate(s.createdAt);

  detailEl.innerHTML = `
    <div class="detail-top">
      <button class="ghost back">← All entries</button>
      <button class="danger detail-del">Delete this entry</button>
    </div>
    <h2>${escapeHtml(s.title)}</h2>
    <p class="hint">${dateLine}</p>
    <p class="summary">${escapeHtml(s.summary || '')}</p>
    <h3>Recording${multi ? 's' : ''} &amp; transcript</h3>
    ${partsHtml}`;

  // Each part's chapter buttons seek that part's own video.
  detailEl.querySelectorAll('.part').forEach((partEl) => {
    const video = partEl.querySelector('.player');
    partEl.querySelectorAll('.chapter').forEach((b) =>
      b.addEventListener('click', () => {
        video.currentTime = Number(b.dataset.t) || 0;
        video.play();
      })
    );
  });

  // Per-part delete buttons (only present on multi-part entries).
  detailEl.querySelectorAll('.part-del').forEach((b) =>
    b.addEventListener('click', () => deletePart(s, Number(b.dataset.idx)))
  );

  detailEl.querySelector('.back').addEventListener('click', () => {
    detailEl.classList.add('hidden');
    listEl.classList.remove('hidden');
    detailEl.innerHTML = '';
  });
  detailEl.querySelector('.detail-del').addEventListener('click', () => deleteEntry(s));
}

// Match the backdrop (and its framing) to the scene chosen on the record page.
try {
  const theme = localStorage.getItem('bgTheme') === 'space' ? 'space' : 'room';
  document.body.classList.remove('bg-room', 'bg-space');
  document.body.classList.add('bg-' + theme);
  const img = document.querySelector('.room-img');
  if (img) img.src = theme === 'space' ? 'spaceship.webp' : 'room.webp';
} catch {
  /* keep the default room backdrop */
}

loadList();
