const form = document.getElementById('analyze-form');
const modeInputs = document.querySelectorAll('input[name="mode"]');
const photoField = document.getElementById('photo-field');
const photoInput = document.getElementById('photo');
const photoPreview = document.getElementById('photo-preview');
const modeHint = document.getElementById('mode-hint');
const dateInput = document.getElementById('date');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

const riverInput = document.getElementById('river');
const findRiverToggle = document.getElementById('find-river-toggle');
const riverFinder = document.getElementById('river-finder');
const useLocationBtn = document.getElementById('use-location-btn');
const zipInput = document.getElementById('zip-input');
const zipSearchBtn = document.getElementById('zip-search-btn');
const riverFinderStatus = document.getElementById('river-finder-status');
const riverResults = document.getElementById('river-results');

const MODE_COPY = {
  analyze: {
    hint: 'Upload a photo of your fly box to see what you have and what to use.',
    submitLabel: 'Analyze my flies',
    statusLabel: 'Analyzing your flies... this can take up to a minute.',
  },
  fill: {
    hint: "No photo needed - we'll recommend a starter set of flies to buy or tie for this trip.",
    submitLabel: 'Get my fly shopping list',
    statusLabel: 'Building your fly shopping list... this can take up to a minute.',
  },
};

// Default the date field to today.
dateInput.value = new Date().toISOString().slice(0, 10);

function getMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'analyze';
}

function applyMode() {
  const mode = getMode();
  const copy = MODE_COPY[mode] || MODE_COPY.analyze;
  modeHint.textContent = copy.hint;
  submitBtn.textContent = copy.submitLabel;

  if (mode === 'fill') {
    photoField.classList.add('hidden');
    photoInput.required = false;
  } else {
    photoField.classList.remove('hidden');
    photoInput.required = true;
  }
}

modeInputs.forEach((input) => input.addEventListener('change', applyMode));
applyMode();

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

findRiverToggle.addEventListener('click', () => {
  riverFinder.classList.toggle('hidden');
});

function setRiverFinderStatus(message, isError) {
  if (!message) {
    riverFinderStatus.classList.add('hidden');
    riverFinderStatus.textContent = '';
    return;
  }
  riverFinderStatus.textContent = message;
  riverFinderStatus.classList.remove('hidden');
  riverFinderStatus.classList.toggle('error', Boolean(isError));
}

async function searchNearbyRivers(payload) {
  riverResults.classList.add('hidden');
  riverResults.innerHTML = '';
  useLocationBtn.disabled = true;
  zipSearchBtn.disabled = true;
  setRiverFinderStatus('Searching for nearby rivers... this can take a moment.');

  try {
    const res = await fetch('/api/nearby-rivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Something went wrong finding nearby rivers.');
    }

    renderRiverResults(data.rivers, data.resolvedLocationName);
  } catch (err) {
    setRiverFinderStatus(err.message || 'Something went wrong finding nearby rivers.', true);
  } finally {
    useLocationBtn.disabled = false;
    zipSearchBtn.disabled = false;
  }
}

function renderRiverResults(rivers, locationName) {
  if (!Array.isArray(rivers) || rivers.length === 0) {
    setRiverFinderStatus(
      locationName
        ? `Couldn't find a well-known fly fishing river within 100 miles of ${locationName}.`
        : "Couldn't find a well-known fly fishing river nearby."
    );
    return;
  }

  setRiverFinderStatus(locationName ? `Rivers near ${locationName} - tap one to use it:` : 'Tap a river to use it:');

  riverResults.innerHTML = '';
  rivers.forEach((river) => {
    const li = document.createElement('li');
    li.className = 'river-result';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const title = document.createElement('div');
    title.className = 'river-result-title';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = river.name || 'Unknown river';
    title.appendChild(nameSpan);
    if (typeof river.distanceMiles === 'number') {
      const distanceSpan = document.createElement('span');
      distanceSpan.className = 'badge river-distance-badge';
      distanceSpan.textContent = `${Math.round(river.distanceMiles)} mi`;
      title.appendChild(distanceSpan);
    }
    li.appendChild(title);

    if (river.nearestTown) {
      const town = document.createElement('div');
      town.className = 'river-result-meta';
      town.textContent = `Near ${river.nearestTown}`;
      li.appendChild(town);
    }

    if (river.reason) {
      const reason = document.createElement('div');
      reason.className = 'river-result-reason';
      reason.textContent = river.reason;
      li.appendChild(reason);
    }

    const chooseRiver = () => {
      riverInput.value = river.nearestTown ? `${river.name}, near ${river.nearestTown}` : river.name;
      riverFinder.classList.add('hidden');
      riverInput.focus();
    };
    li.addEventListener('click', chooseRiver);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        chooseRiver();
      }
    });

    riverResults.appendChild(li);
  });
  riverResults.classList.remove('hidden');
}

useLocationBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    setRiverFinderStatus('Location access is not supported in this browser - try a ZIP code instead.', true);
    return;
  }

  setRiverFinderStatus('Requesting your location...');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      searchNearbyRivers({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      });
    },
    () => {
      setRiverFinderStatus("Couldn't access your location - try a ZIP code instead.", true);
    },
    { timeout: 10000 }
  );
});

function submitZipSearch() {
  const zip = zipInput.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    setRiverFinderStatus('Enter a valid 5-digit ZIP code.', true);
    return;
  }
  searchNearbyRivers({ zip });
}

zipSearchBtn.addEventListener('click', submitZipSearch);
zipInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitZipSearch();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = getMode();
  const copy = MODE_COPY[mode] || MODE_COPY.analyze;
  setStatus(copy.statusLabel);
  resultsEl.classList.add('hidden');
  resultsEl.innerHTML = '';
  submitBtn.disabled = true;

  try {
    const formData = new FormData(form);
    if (mode === 'fill' && !(photoInput.files && photoInput.files[0])) {
      formData.delete('image');
    }

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

  const hasPhoto = Boolean(data.hasPhoto);

  resultsEl.appendChild(renderFliesSection('Likely hatches', data.likelyHatches, renderHatchItem));
  resultsEl.appendChild(
    renderRecommendationsSection(buildRecommendationRows(sortByRank(data.recommendations), data.missingPatterns), hasPhoto)
  );
  if (hasPhoto) {
    resultsEl.appendChild(renderFliesSection('Other flies in your box', data.otherFlies, renderFlyItem));
  }

  resultsEl.classList.remove('hidden');
}

function sortByRank(list) {
  if (!Array.isArray(list)) return list;
  return [...list].sort((a, b) => (a.rank || 0) - (b.rank || 0));
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
  if (fly.usageNotes) body.appendChild(el('div', 'item-reason', `\ud83d\udca1 ${escapeHtml(fly.usageNotes)}`));
  li.appendChild(body);

  return li;
}

function renderHatchItem(hatch) {
  const li = el('li', 'item-card fly-item-card');
  li.appendChild(renderReferenceMedia({ name: hatch.insect, ...hatch }));

  const body = el('div', 'fly-item-body');
  const title = el('div', 'item-title');
  title.appendChild(el('span', null, escapeHtml(hatch.insect || 'Unknown insect')));
  if (hatch.lifecycleStage) title.appendChild(el('span', 'badge', escapeHtml(hatch.lifecycleStage)));
  body.appendChild(title);
  if (hatch.reason) body.appendChild(el('div', 'item-reason', escapeHtml(hatch.reason)));
  li.appendChild(body);

  return li;
}

function buildRecommendationRows(recommendations, missingPatterns) {
  const recRows = (Array.isArray(recommendations) ? recommendations : []).map((rec) => ({
    flyName: rec.flyName,
    reason: rec.reason,
    sizeHint: rec.sizeHint,
    inBox: rec.inBox,
    rank: rec.rank,
    referenceImageUrl: rec.referenceImageUrl,
    referenceImageSourceUrl: rec.referenceImageSourceUrl,
    referenceImageSearchUrl: rec.referenceImageSearchUrl,
  }));

  const addRows = (Array.isArray(missingPatterns) ? missingPatterns : []).map((pattern) => ({
    flyName: pattern.name,
    reason: pattern.reason,
    sizeHint: pattern.sizeHint || null,
    inBox: false,
    rank: null,
    referenceImageUrl: pattern.referenceImageUrl,
    referenceImageSourceUrl: pattern.referenceImageSourceUrl,
    referenceImageSearchUrl: pattern.referenceImageSearchUrl,
  }));

  return [...recRows, ...addRows];
}

function renderRecommendationsSection(recommendations, hasPhoto) {
  const section = el('section', 'results-section');
  section.appendChild(el('h2', null, 'Recommended flies'));

  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    section.appendChild(el('p', 'weather-note', 'Nothing to show here.'));
    return section;
  }

  const wrapper = el('div', 'table-wrapper');
  const table = el('table', 'recommendations-table');

  const columns = ['Fly', 'Description', 'Size'];
  if (hasPhoto) columns.push('In Your Box?');
  columns.push('Photo');

  const thead = el('thead');
  const headRow = el('tr');
  columns.forEach((label) => {
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

    if (hasPhoto) {
      const inBoxCell = el('td');
      inBoxCell.appendChild(el('span', `badge ${rec.inBox ? 'yes-badge' : 'no-badge'}`, rec.inBox ? 'Yes' : 'No'));
      row.appendChild(inBoxCell);
    }

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
