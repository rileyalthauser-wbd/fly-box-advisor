const form = document.getElementById('analyze-form');
const photoInput = document.getElementById('photo');
const photoPreview = document.getElementById('photo-preview');
const dateInput = document.getElementById('date');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

// Default the date field to today.
dateInput.value = new Date().toISOString().slice(0, 10);

photoInput.addEventListener('change', () => {
  const file = photoInput.files && photoInput.files[0];
  if (!file) {
    photoPreview.classList.add('hidden');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    photoPreview.src = e.target.result;
    photoPreview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus('Analyzing your flies... this can take up to a minute.');
  resultsEl.classList.add('hidden');
  resultsEl.innerHTML = '';
  submitBtn.disabled = true;

  try {
    const formData = new FormData(form);
    const res = await fetch('/api/analyze', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Something went wrong.');
    }

    renderResults(data);
    clearStatus();
  } catch (err) {
    setStatus(err.message || 'Something went wrong.', true);
  } finally {
    submitBtn.disabled = false;
  }
});

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
  statusEl.classList.toggle('error', Boolean(isError));
}

function clearStatus() {
  statusEl.classList.add('hidden');
  statusEl.textContent = '';
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function renderResults(data) {
  resultsEl.innerHTML = '';

  if (data.summary) {
    const section = el('section', 'results-section');
    section.appendChild(el('h2', null, 'Summary'));
    section.appendChild(el('p', 'summary-text', escapeHtml(data.summary)));
    resultsEl.appendChild(section);
  }

  resultsEl.appendChild(renderWeatherSection(data));
  resultsEl.appendChild(renderFliesSection('Likely hatches right now', data.likelyHatches, renderHatchItem));
  resultsEl.appendChild(renderRecommendationsSection(sortByRank(data.recommendations)));
  resultsEl.appendChild(renderFliesSection('Consider adding to your box', data.missingPatterns, renderMissingItem));
  resultsEl.appendChild(renderFliesSection('Other flies in your box', data.otherFlies, renderFlyItem));

  resultsEl.classList.remove('hidden');
}

function sortByRank(list) {
  if (!Array.isArray(list)) return list;
  return [...list].sort((a, b) => (a.rank || 0) - (b.rank || 0));
}

function renderWeatherSection(data) {
  const section = el('section', 'results-section');
  section.appendChild(el('h2', null, 'Location & weather'));

  if (data.resolvedLocationName) {
    section.appendChild(el('p', 'location-note', `Resolved location: ${escapeHtml(data.resolvedLocationName)}`));
  } else {
    section.appendChild(el('p', 'warn-note', "Couldn't pinpoint this location on the map, so recommendations fall back on general seasonal reasoning."));
  }

  const weather = data.weather;
  if (weather && weather.available) {
    const grid = el('div', 'weather-grid');
    grid.appendChild(weatherStat('High', weather.tempMaxC != null ? `${weather.tempMaxC}\u00b0C` : '-'));
    grid.appendChild(weatherStat('Low', weather.tempMinC != null ? `${weather.tempMinC}\u00b0C` : '-'));
    grid.appendChild(weatherStat('Precip', weather.precipitationMm != null ? `${weather.precipitationMm}mm` : '-'));
    grid.appendChild(weatherStat('Wind', weather.windSpeedMaxKmh != null ? `${weather.windSpeedMaxKmh}km/h` : '-'));
    grid.appendChild(weatherStat('Cloud', weather.cloudCoverPercent != null ? `${Math.round(weather.cloudCoverPercent)}%` : '-'));
    section.appendChild(grid);
    if (weather.note) {
      section.appendChild(el('p', 'weather-note', escapeHtml(weather.note)));
    }
  } else if (weather) {
    section.appendChild(el('p', 'warn-note', escapeHtml(weather.note || 'Weather data unavailable.')));
  }

  return section;
}

function weatherStat(label, value) {
  const stat = el('div', 'weather-stat');
  stat.appendChild(el('div', 'value', escapeHtml(String(value))));
  stat.appendChild(el('div', 'label', escapeHtml(label)));
  return stat;
}

function renderFliesSection(title, items, itemRenderer) {
  const section = el('section', 'results-section');
  section.appendChild(el('h2', null, title));

  if (!Array.isArray(items) || items.length === 0) {
    section.appendChild(el('p', 'weather-note', 'Nothing to show here.'));
    return section;
  }

  const list = el('ul', 'item-list');
  items.forEach((item) => list.appendChild(itemRenderer(item)));
  section.appendChild(list);
  return section;
}

function renderReferenceMedia(item, size) {
  const media = el('div', `fly-item-media${size === 'small' ? ' fly-item-media-sm' : ''}`);
  if (item.referenceImageUrl) {
    const link = el('a', null);
    link.href = item.referenceImageSourceUrl || item.referenceImageUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const img = el('img', 'fly-reference-img');
    img.src = item.referenceImageUrl;
    img.alt = `Reference photo of ${item.name || item.flyName || 'fly'}`;
    img.loading = 'lazy';
    link.appendChild(img);
    media.appendChild(link);
  } else if (item.referenceImageSearchUrl) {
    const link = el('a', 'reference-search-link', '\ud83d\udd0d');
    link.href = item.referenceImageSearchUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Search reference photos';
    media.appendChild(link);
  }
  return media;
}

function renderFlyItem(fly) {
  const li = el('li', 'item-card fly-item-card');
  li.appendChild(renderReferenceMedia(fly));

  const body = el('div', 'fly-item-body');
  const title = el('div', 'item-title');
  title.appendChild(el('span', null, escapeHtml(fly.name || 'Unknown fly')));
  if (fly.type) title.appendChild(el('span', 'badge', escapeHtml(fly.type)));
  body.appendChild(title);

  const metaParts = [];
  if (fly.sizeHint) metaParts.push(`Size: ${fly.sizeHint}`);
  if (fly.colorNotes) metaParts.push(fly.colorNotes);
  if (typeof fly.confidence === 'number') metaParts.push(`Confidence: ${Math.round(fly.confidence * 100)}%`);
  if (metaParts.length) body.appendChild(el('div', 'item-meta', escapeHtml(metaParts.join(' \u2022 '))));
  li.appendChild(body);

  return li;
}

function renderHatchItem(hatch) {
  const li = el('li', 'item-card');
  const title = el('div', 'item-title');
  title.appendChild(el('span', null, escapeHtml(hatch.insect || 'Unknown insect')));
  if (hatch.lifecycleStage) title.appendChild(el('span', 'badge', escapeHtml(hatch.lifecycleStage)));
  li.appendChild(title);
  if (hatch.reason) li.appendChild(el('div', 'item-reason', escapeHtml(hatch.reason)));
  return li;
}

function renderMissingItem(pattern) {
  const li = el('li', 'item-card fly-item-card');
  li.appendChild(renderReferenceMedia(pattern));

  const body = el('div', 'fly-item-body');
  body.appendChild(el('div', 'item-title', escapeHtml(pattern.name || 'Unknown pattern')));
  if (pattern.reason) body.appendChild(el('div', 'item-reason', escapeHtml(pattern.reason)));
  li.appendChild(body);

  return li;
}

function renderRecommendationsSection(recommendations) {
  const section = el('section', 'results-section');
  section.appendChild(el('h2', null, 'Recommended flies'));

  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    section.appendChild(el('p', 'weather-note', 'Nothing to show here.'));
    return section;
  }

  const wrapper = el('div', 'table-wrapper');
  const table = el('table', 'recommendations-table');

  const thead = el('thead');
  const headRow = el('tr');
  ['Fly', 'Description', 'Size', 'In Your Box?', 'Photo'].forEach((label) => {
    headRow.appendChild(el('th', null, escapeHtml(label)));
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  recommendations.forEach((rec) => {
    const row = el('tr');

    const nameCell = el('td');
    nameCell.appendChild(el('span', null, escapeHtml(rec.flyName || 'Unknown fly')));
    if (rec.rank) nameCell.appendChild(el('span', 'badge rank-badge table-rank-badge', `#${rec.rank}`));
    row.appendChild(nameCell);

    row.appendChild(el('td', 'reason-cell', escapeHtml(rec.reason || '-')));
    row.appendChild(el('td', null, escapeHtml(rec.sizeHint || '-')));

    const inBoxCell = el('td');
    inBoxCell.appendChild(el('span', `badge ${rec.inBox ? 'yes-badge' : 'no-badge'}`, rec.inBox ? 'Yes' : 'No'));
    row.appendChild(inBoxCell);

    const photoCell = el('td');
    photoCell.appendChild(renderReferenceMedia(rec, 'small'));
    row.appendChild(photoCell);

    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  wrapper.appendChild(table);
  section.appendChild(wrapper);
  return section;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
