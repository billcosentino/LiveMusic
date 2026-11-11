(() => {
  const DATA = window.GIG_DATA || { events: [], counts: {}, updated: null };
  const EVENTS = DATA.events;
  const $ = (s) => document.querySelector(s);
  const el = { state: $('#fState'), city: $('#fCity'), venue: $('#fVenue'), text: $('#fText'), music: $('#fMusic'), view: $('#view'), count: $('#count'), range: $('#rangeLabel') };
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const LIST_DAYS = 30;

  // ---------- date helpers (all strings are local Eastern YYYY-MM-DD) ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const add = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const todayStr = (() => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  })();
  const startOfWeek = (s) => add(s, -parse(s).getDay());
  const fmtTime = (e) => {
    if (e.allDay || e.start.length <= 10) return 'All day';
    let [h, m] = e.start.slice(11, 16).split(':').map(Number);
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return m ? `${h}:${pad(m)}${ap}` : `${h}${ap}`;
  };
  const fmtDay = (s) => { const d = parse(s); return `${DOW[d.getDay()]}, ${MON[d.getMonth()].slice(0, 3)} ${d.getDate()}`; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- state (kept in the URL hash so filtered views can be bookmarked/shared) ----------
  const state = { view: 'list', date: todayStr, st: '', city: '', venue: '', q: '', music: true };
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    let savedView = null;
    try { savedView = localStorage.getItem('gig-view'); } catch {}
    state.view = ['list', 'week', 'month'].includes(p.get('view')) ? p.get('view') : savedView || (innerWidth < 720 ? 'list' : 'month');
    state.date = /^\d{4}-\d{2}-\d{2}$/.test(p.get('d') || '') ? p.get('d') : todayStr;
    state.st = p.get('st') || ''; state.city = p.get('city') || ''; state.venue = p.get('venue') || '';
    state.q = p.get('q') || ''; state.music = p.get('all') !== '1';
  }
  function writeHash() {
    const p = new URLSearchParams();
    p.set('view', state.view);
    if (state.date !== todayStr) p.set('d', state.date);
    if (state.st) p.set('st', state.st);
    if (state.city) p.set('city', state.city);
    if (state.venue) p.set('venue', state.venue);
    if (state.q) p.set('q', state.q);
    if (!state.music) p.set('all', '1');
    history.replaceState(null, '', '#' + p.toString());
    try { localStorage.setItem('gig-view', state.view); } catch {}
  }

  // ---------- filtering ----------
  function baseFiltered({ ignoreCity, ignoreVenue } = {}) {
    const q = state.q.trim().toLowerCase();
    return EVENTS.filter((e) =>
      (!state.music || e.kind === 'music') &&
      (!state.st || e.state === state.st) &&
      (ignoreCity || !state.city || e.city === state.city) &&
      (ignoreVenue || !state.venue || e.venueId === state.venue) &&
      (!q || `${e.title} ${e.venue} ${e.city} ${e.description}`.toLowerCase().includes(q)));
  }
  function fillSelect(sel, items, current, allLabel) {
    sel.innerHTML = `<option value="">${allLabel}</option>` + items.map(([v, label, n]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)} (${n})</option>`).join('');
  }
  function refreshOptions() {
    const upcoming = (list) => list.filter((e) => e.start.slice(0, 10) >= todayStr);
    const cities = new Map();
    for (const e of upcoming(baseFiltered({ ignoreCity: true, ignoreVenue: true }))) {
      const k = e.city;
      const c = cities.get(k) || [k, state.st ? k : `${k}, ${e.state}`, 0];
      c[2]++; cities.set(k, c);
    }
    if (state.city && !cities.has(state.city)) state.city = '';
    fillSelect(el.city, [...cities.values()].sort((a, b) => a[1].localeCompare(b[1])), state.city, 'All cities');
    const venues = new Map();
    for (const e of upcoming(baseFiltered({ ignoreVenue: true }))) {
      const v = venues.get(e.venueId) || [e.venueId, state.city ? e.venue : `${e.venue} — ${e.city}`, 0];
      v[2]++; venues.set(e.venueId, v);
    }
    if (state.venue && !venues.has(state.venue)) state.venue = '';
    fillSelect(el.venue, [...venues.values()].sort((a, b) => a[1].localeCompare(b[1])), state.venue, 'All venues');
  }

  // ---------- rendering ----------
  let current = []; // events in the visible range, for export
  function range() {
    if (state.view === 'list') return [state.date, add(state.date, LIST_DAYS - 1)];
    if (state.view === 'week') { const s = startOfWeek(state.date); return [s, add(s, 6)]; }
    const first = state.date.slice(0, 8) + '01';
    const gridStart = startOfWeek(first);
    const last = add(ymd(new Date(parse(first).getFullYear(), parse(first).getMonth() + 1, 1)), -1);
    return [gridStart, add(startOfWeek(last), 6), first, last];
  }
  function byDay(list) {
    const m = new Map();
    for (const e of list) { const d = e.start.slice(0, 10); (m.get(d) || m.set(d, []).get(d)).push(e); }
    return m;
  }
  function render() {
    refreshOptions();
    el.state.value = state.st; el.text.value = state.q; el.music.checked = state.music;
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
    const [from, to, mFirst, mLast] = range();
    const all = baseFiltered();
    const visFrom = mFirst || from, visTo = mLast || to;
    current = all.filter((e) => { const d = e.start.slice(0, 10); return d >= visFrom && d <= visTo; });
    const days = byDay(all.filter((e) => { const d = e.start.slice(0, 10); return d >= from && d <= to; }));

    if (state.view === 'month') el.range.textContent = `${MON[parse(mFirst).getMonth()]} ${parse(mFirst).getFullYear()}`;
    else el.range.textContent = `${fmtDay(from)} – ${fmtDay(to)}`;
    el.count.textContent = `${current.length} event${current.length === 1 ? '' : 's'} shown`;

    if (!EVENTS.length) { el.view.innerHTML = `<div class="empty">No events yet. Run <code>run.cmd</code> to collect them.</div>`; return; }
    if (state.view === 'list') renderList(days, from, to);
    else renderGrid(days, from, to, mFirst, mLast);
    writeHash();
  }
  function renderList(days, from, to) {
    let html = '';
    for (let d = from; d <= to; d = add(d, 1)) {
      const evs = days.get(d);
      if (!evs) continue;
      html += `<section class="day"><h2>${fmtDay(d)}${d === todayStr ? '<small>Today</small>' : ''}<small>${evs.length} show${evs.length > 1 ? 's' : ''}</small></h2>` +
        evs.map((e) => `<div class="ev" data-id="${e.id}" tabindex="0" role="button">
          <span class="time">${fmtTime(e)}</span><span class="title">${esc(e.title)}</span><span class="tag">${e.state}</span>
          <span class="where">${esc(e.venue)} · ${esc(e.city)}, ${e.state}${e.price ? ' · ' + esc(/^\d/.test(e.price) ? '$' + e.price : e.price) : ''}</span>
        </div>`).join('') + '</section>';
    }
    el.view.innerHTML = html || `<div class="empty">No shows match these filters between ${fmtDay(from)} and ${fmtDay(to)}.<br>Try another state or city, or clear the search.</div>`;
  }
  function renderGrid(days, from, to, mFirst, mLast) {
    const isMonth = state.view === 'month';
    const cap = isMonth ? 4 : 999;
    let html = `<div class="grid ${state.view}">` + DOW.map((d) => `<div class="dow">${d}</div>`).join('');
    for (let d = from; d <= to; d = add(d, 1)) {
      const evs = days.get(d) || [];
      const out = isMonth && (d < mFirst || d > mLast);
      html += `<div class="cell${out ? ' out' : ''}${d === todayStr ? ' today' : ''}" data-day="${d}">
        <div class="num">${isMonth ? parse(d).getDate() : fmtDay(d)}</div>` +
        evs.slice(0, cap).map((e) => `<button type="button" class="chipev" data-id="${e.id}" title="${esc(e.title)} — ${esc(e.venue)}"><b>${fmtTime(e)}</b> ${esc(e.title)}<span class="v">${esc(e.venue)}, ${esc(e.city)}</span></button>`).join('') +
        (evs.length > cap ? `<button type="button" class="more" data-more="${d}">+${evs.length - cap} more</button>` : '') + '</div>';
    }
    el.view.innerHTML = html + '</div>';
  }

  function showDetail(e) {
    const body = $('#detailBody');
    const when = `${fmtDay(e.start.slice(0, 10))}${e.allDay ? '' : ' · ' + fmtTime(e)}`;
    body.innerHTML = `<h3>${esc(e.title)}</h3>
      <p class="row"><strong>${esc(when)}</strong></p>
      <p class="row">${esc(e.venue)} · ${esc(e.city)}, ${e.state}</p>
      ${e.price ? `<p class="row">Price: ${esc(/^\d/.test(e.price) ? '$' + e.price : e.price)}</p>` : ''}
      ${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ''}
      <div class="btns">
        ${e.url ? `<a class="btn primary" href="${esc(e.url)}" target="_blank" rel="noopener">Venue page ↗</a>` : ''}
        <button class="btn" type="button" id="oneIcs">Add to calendar</button>
        <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${e.venue}, ${e.city}, ${e.state}`)}">Map ↗</a>
      </div>`;
    $('#oneIcs').onclick = () => download([e], `${e.title.slice(0, 40)}.ics`);
    $('#detail').showModal();
  }

  // ---------- .ics export (mirrors src/build.js) ----------
  function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => '\\' + m).replace(/\r?\n/g, '\\n'); }
  function fold(line) { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); }
  function stamp(s, allDay) { const d = s.replace(/[-:]/g, ''); return allDay ? `;VALUE=DATE:${d.slice(0, 8)}` : `;TZID=America/New_York:${d.slice(0, 13)}00`; }
  function plus3h(s) { const d = new Date(s.slice(0, 16) + ':00Z'); d.setUTCHours(d.getUTCHours() + 3); return d.toISOString().slice(0, 16); }
  function toIcs(list) {
    const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//gig-calendar//EN', 'CALSCALE:GREGORIAN', 'X-WR-TIMEZONE:America/New_York'];
    for (const e of list) {
      L.push('BEGIN:VEVENT', `UID:${e.id}@gig-calendar`, `DTSTAMP:${now}`, 'DTSTART' + stamp(e.start, e.allDay));
      if (!e.allDay) L.push('DTEND' + stamp(e.end && e.end.length > 10 && e.end > e.start ? e.end : plus3h(e.start), false));
      L.push(`SUMMARY:${icsEscape(e.title)}`, `LOCATION:${icsEscape(`${e.venue}, ${e.city}, ${e.state}`)}`);
      if (e.url) L.push(`URL:${e.url}`);
      L.push(`DESCRIPTION:${icsEscape([e.description, e.url].filter(Boolean).join('\n\n'))}`, 'END:VEVENT');
    }
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }
  function download(list, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toIcs(list)], { type: 'text/calendar' }));
    a.download = name.replace(/[^\w .-]+/g, '') || 'events.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- events ----------
  const byId = new Map(EVENTS.map((e) => [e.id, e]));
  el.state.onchange = () => { state.st = el.state.value; state.city = ''; state.venue = ''; render(); };
  el.city.onchange = () => { state.city = el.city.value; state.venue = ''; render(); };
  el.venue.onchange = () => { state.venue = el.venue.value; render(); };
  el.music.onchange = () => { state.music = el.music.checked; render(); };
  let t;
  el.text.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.q = el.text.value; render(); }, 180); };
  document.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { state.view = b.dataset.view; render(); }));
  const step = (dir) => {
    if (state.view === 'list') state.date = add(state.date, dir * LIST_DAYS);
    else if (state.view === 'week') state.date = add(state.date, dir * 7);
    else { const d = parse(state.date.slice(0, 8) + '01'); d.setMonth(d.getMonth() + dir); state.date = ymd(d); }
    render();
  };
  $('#prev').onclick = () => step(-1);
  $('#next').onclick = () => step(1);
  $('#today').onclick = () => { state.date = todayStr; render(); };
  $('#exportBtn').onclick = () => {
    if (!current.length) return alert('No events in the current view to export.');
    const label = [state.st, state.city, state.venue && byId.get(current[0]?.id)?.venue].filter(Boolean).join(' ') || 'live-music';
    download(current, `${label} ${el.range.textContent}.ics`);
  };
  el.view.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-id]');
    if (item) return showDetail(byId.get(item.dataset.id));
    const more = ev.target.closest('[data-more]');
    const cell = ev.target.closest('.cell');
    if (more || (cell && state.view === 'month')) { state.date = (more || cell).dataset.more || cell.dataset.day; state.view = 'week'; render(); }
  });
  el.view.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.dataset.id) showDetail(byId.get(ev.target.dataset.id)); });

  const c = DATA.counts || {};
  $('#meta').textContent = DATA.updated
    ? `${EVENTS.length.toLocaleString()} events at ${(c.venuesWithEvents || 0).toLocaleString()} venues · checked ${(c.scrapable || 0).toLocaleString()} venue websites · updated ${new Date(DATA.updated).toLocaleString()}`
    : 'No data yet';
  readHash();
  render();
})();
