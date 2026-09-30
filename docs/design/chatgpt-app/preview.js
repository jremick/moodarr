// Deliberately fixture-only. No SDK bridge, credentials, network calls, or storage.
const $ = selector => document.querySelector(selector);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#${name}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
const movies = [
  { id: 'chef', title: 'Chef', year: 2014, duration: '1h 54m', rating: 'R', genre: 'Comedy · Drama', available: true,
    poster: 'https://quinlan.it/upload/images/2014/07/chef-la-ricetta-perfetta-2014-jon-favreau-poster.jpg',
    reason: 'A fresh start, good food, and an easygoing road trip.',
    description: 'A chef leaves his restaurant job and takes a food truck on the road with his son. Cooking, music, and family take center stage.',
    match: 'Warm family connections and a hopeful fresh start, without a high-stakes plot.',
    caution: 'Strong language and some adult references.', director: 'Jon Favreau' },
  { id: 'wilderpeople', title: 'Hunt for the Wilderpeople', year: 2016, duration: '1h 41m', rating: 'PG-13', genre: 'Adventure · Comedy', available: true,
    poster: 'https://static1.squarespace.com/static/5005e3ca84aedff1462455d6/t/59c1972aca70ecd39561da33/1493409967067/1000w/hunt%2Bfor%2Bthe%2Bwilderpeople.jpg',
    reason: 'Dry humor and an unlikely friendship in the bush.',
    description: 'A foster kid and his reluctant guardian become the focus of a manhunt in the New Zealand wilderness. Their shared misadventure turns into an unlikely bond.',
    match: 'Playful, offbeat humor with real heart. The more adventurous pick of the three.',
    caution: 'Includes bereavement, hunting, and moments of peril.', director: 'Taika Waititi' },
  { id: 'paddington', title: 'Paddington 2', year: 2017, duration: '1h 44m', rating: 'PG', genre: 'Family · Comedy', available: false,
    poster: 'https://www.impawards.com/intl/uk/2017/posters/paddington_two_ver31_xlg.jpg',
    reason: 'Kindness, gentle chaos, and a very good bear.',
    description: 'Paddington is saving for a special birthday gift for Aunt Lucy. When the gift disappears, the Browns rally around him in a colorful, good-hearted mystery.',
    match: 'Generous, optimistic, and funny. A gentle option with a few lively action sequences.',
    caution: 'Some mild peril and prison scenes.', director: 'Paul King' }
];
const state = { scenario: 'ready', selected: null, view: 'detail', feedback: new Map(), watchlist: new Set(), operations: new Map(), attemptCount: 0, pending: false, generation: 0, connectionGeneration: 0, address: 'https://cinema.example.com', connectionStep: 'address' };
const dialog = $('#title-dialog');
const poster = (movie, extra = '') => `<div class="poster ${extra}"><div class="poster-fallback" aria-hidden="true"><svg><use href="#ticket"/></svg>${escape(movie.title)}<small>Poster unavailable</small></div><img src="${movie.poster}" alt="${escape(movie.title)} theatrical poster" referrerpolicy="no-referrer"></div>`;
document.addEventListener('error', event => { if (event.target instanceof HTMLImageElement) event.target.hidden = true; }, true);
const button = (label, action, primary = false, symbol = '', attributes = '') => `<button class="button${primary ? ' primary' : ''}" data-action="${action}" ${attributes}>${symbol ? icon(symbol) : ''}${label}</button>`;
const availability = movie => `<p class="availability"><span class="status-dot${movie.available ? '' : ' outline'}"></span>${movie.available ? 'In your Plex library' : 'Not in your Plex library'}</p>`;
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function browse() {
  $('#conversation').hidden = false;
  $('#connection').hidden = true;
  $('#browse-tab').setAttribute('aria-pressed', 'true');
  $('#connect-tab').setAttribute('aria-pressed', 'false');
  renderCards();
}
function renderCards() {
  const expired = state.scenario === 'expired';
  const empty = state.scenario === 'empty';
  $('#host-status').textContent = expired ? 'Connection needs attention' : 'Connected to My cinema';
  $('#host-response').hidden = expired || empty;
  if (expired || empty) {
    $('#widget').innerHTML = `<div class="empty-state">${icon(expired ? 'lock' : 'ticket')}<h2>${expired ? 'Reconnect to your library.' : 'No titles fit all of these filters.'}</h2><p>${expired ? 'Your session has expired. Sign in again to browse your library and manage requests.' : 'Keep the lighthearted mood and try a longer runtime, or include titles outside your Plex library.'}</p>${button(expired ? 'Reconnect Moodarr' : 'Show sample picks', expired ? 'connect' : 'reset', true, 'arrow')}</div>`;
    return;
  }
  $('#widget').innerHTML = `${state.scenario === 'readonly' ? '<p class="read-only-note">Read-only account · Browsing is available. Requests and preference changes are disabled.</p>' : ''}<div class="widget-head"><div><h2>Easygoing picks for tonight</h2><p>Funny, uplifting, and under two hours.</p></div><span class="count">3 titles</span></div><div class="cards">${movies.map(movie => `<article class="movie-card">${poster(movie)}<h3 class="movie-title">${movie.title}</h3><p class="movie-meta">${movie.year} · ${movie.duration} · ${movie.rating}</p><p class="reason">${movie.reason}</p>${availability(movie)}${button('View title', 'title', false, '', `data-id="${movie.id}" aria-label="View ${movie.title}"` ).replace('</button>', `${icon('arrow')}</button>`)}</article>`).join('')}</div><div class="widget-foot"><span>Availability from your connected library</span><button class="text-button" data-action="connect">Manage connection</button></div>`;
}
function showTitle(id) {
  state.selected = movies.find(movie => movie.id === id);
  state.view = state.operations.has(id) ? 'outcome' : 'detail';
  state.generation++;
  renderDetail();
  dialog.showModal();
}
const dialogHeader = label => `<div class="dialog-header"><span>${label}</span><button class="icon-button" data-action="close" aria-label="Close title" title="Close title">${icon('close')}</button></div>`;
function renderDetail() {
  const movie = state.selected;
  if (!movie) return;
  if (state.view === 'preview') { renderPreview(); return; }
  if (state.view === 'outcome') { renderOutcome(); return; }
  const readOnly = state.scenario === 'readonly';
  const saved = state.feedback.get(movie.id);
  const watchlisted = state.watchlist.has(movie.id);
  $('#detail-content').innerHTML = `${dialogHeader('Title details · expanded view')}<div class="detail-layout animate-in">${poster(movie, 'detail-poster')}<div class="detail-body"><p class="eyebrow">${movie.genre}</p><h2 id="detail-title" tabindex="-1">${movie.title}</h2><p class="movie-meta">${movie.year} · ${movie.duration} · ${movie.rating}<br>Directed by ${movie.director}</p>${availability(movie)}<p class="detail-description">${movie.description}</p><div class="match-note"><strong>Why it fits tonight</strong><p>${movie.match}</p></div><p class="content-note">Worth knowing: ${movie.caution}</p><div class="detail-actions">${movie.available ? button('Open in Plex', 'plex', true, 'external') + (readOnly ? '' : button(watchlisted ? 'On your Watchlist' : 'Add to Watchlist', 'watchlist', false, watchlisted ? 'check' : 'plus', watchlisted ? 'disabled' : '')) : (readOnly ? '<p class="inline-notice">Your account can browse titles. Ask your instance owner for request access.</p>' : button('Preview request', 'preview', true, 'plus'))}</div>${readOnly ? '' : `<div class="feedback"><div class="feedback-label">Is this the kind of thing you had in mind?</div><div class="feedback-buttons">${button('More like this', 'more', false, 'heart', `aria-pressed="${saved === 'more'}"`)}${button('Less like this', 'less', false, 'minus', `aria-pressed="${saved === 'less'}"`)}</div><p class="feedback-message" role="status">${saved ? 'Preference saved for this session.' : ''}</p></div>`}</div></div>`;
}
function renderPreview() {
  const movie = state.selected;
  $('#detail-content').innerHTML = `${dialogHeader('Review request')}<div class="confirm-body animate-in"><p class="eyebrow">ONE EXPLICIT CONFIRMATION</p><h2 id="detail-title" tabindex="-1">Request this movie?</h2><p>Moodarr will attempt to send this request to Seerr using your account.</p><div class="confirm-item">${poster(movie)}<div><h3>${movie.title}</h3><p>${movie.year} · Movie · ${movie.duration}</p></div></div><div class="permission-summary"><div><span>Instance</span>My cinema</div><div><span>Account</span>Alex · Plex user</div></div><p class="inline-notice">Seerr availability has not been checked. This preview does not guarantee the title can be requested or when it will be available.</p><label class="confirmation-check"><input type="checkbox" id="confirm-check"> <span>Request ${movie.title} (${movie.year}) for my account.</span></label><div class="confirm-buttons">${button('Cancel', 'cancel-preview')}${button('Confirm request', 'confirm', true, '', 'disabled')}</div></div>`;
  $('#detail-title').focus();
}
function renderOutcome() {
  const movie = state.selected;
  const operation = state.operations.get(movie.id);
  const uncertain = operation.status === 'uncertain';
  const pending = operation.status === 'pending';
  $('#detail-content').innerHTML = `${dialogHeader('Request status')}<div class="confirm-body animate-in"><div class="status-symbol${uncertain ? ' warn' : ''}">${pending ? '<span class="spinner" aria-label="Sending request"></span>' : icon(uncertain ? 'warning' : 'check')}</div><h2 id="detail-title" tabindex="-1">${pending ? 'Sending your request…' : uncertain ? 'We could not confirm the outcome.' : 'Request received'}</h2><p>${pending ? `Sending ${movie.title} to Seerr. You can close this view while it completes.` : uncertain ? 'The connection dropped after the request was sent. It may already have reached Seerr. Check its status before doing anything else.' : `${movie.title} (${movie.year}) is now requested in Seerr. This does not mean it is ready to watch.`}</p><p class="reference">Request reference ${operation.id}</p>${uncertain ? '<p class="inline-notice">This request will not be sent again while its outcome is unresolved.</p>' : ''}<div class="confirm-buttons">${button('Close', 'close')}${uncertain ? button('Check request status', 'check-status', true, '', operation.checking ? 'disabled' : '') : ''}</div><p class="field-help" role="status">${operation.checking ? 'Checking the existing request…' : ''}</p></div>`;
  $('#detail-title').focus();
}
async function confirmRequest() {
  const movie = state.selected;
  if (state.scenario === 'readonly' || state.view !== 'preview' || !$('#confirm-check')?.checked || state.operations.has(movie.id)) return;
  // Concept boundary only. Live code must use the immutable server preview and operation identity.
  const operation = { id: `DEMO-${String(++state.attemptCount).padStart(3, '0')}`, status: 'pending', checking: false };
  state.operations.set(movie.id, operation);
  state.view = 'outcome';
  const uncertain = state.scenario === 'uncertain';
  renderOutcome();
  await pause(700);
  operation.status = uncertain ? 'uncertain' : 'received';
  if (dialog.open && state.selected?.id === movie.id) renderOutcome();
}
async function checkStatus() {
  const movie = state.selected;
  const operation = state.operations.get(movie.id);
  if (operation.status !== 'uncertain' || operation.checking) return;
  operation.checking = true;
  renderOutcome();
  await pause(650);
  operation.checking = false;
  operation.status = 'received';
  if (dialog.open && state.selected?.id === movie.id) renderOutcome();
}
async function feedback(action) {
  if (state.pending || state.scenario === 'readonly') return;
  const movie = state.selected;
  const generation = state.generation;
  state.pending = true;
  $('.feedback-message').textContent = 'Saving preference…';
  document.querySelectorAll('.feedback-buttons button').forEach(control => { control.disabled = true; });
  await pause(350);
  state.feedback.set(movie.id, action);
  state.pending = false;
  if (dialog.open && generation === state.generation) {
    renderDetail();
    $(`[data-action="${action}"]`)?.focus();
  }
}
async function watchlist() {
  const movie = state.selected;
  if (state.scenario === 'readonly' || state.watchlist.has(movie.id) || !movie.available) return;
  const control = $('[data-action="watchlist"]');
  control.disabled = true;
  control.textContent = 'Adding…';
  await pause(400);
  state.watchlist.add(movie.id);
  if (dialog.open && state.selected?.id === movie.id && state.view === 'detail') renderDetail();
}
function connect() {
  dialog.close();
  $('#conversation').hidden = true;
  $('#connection').hidden = false;
  $('#browse-tab').setAttribute('aria-pressed', 'false');
  $('#connect-tab').setAttribute('aria-pressed', 'true');
  state.connectionGeneration++;
  state.connectionStep = 'address';
  renderConnection();
}
function renderConnection() {
  ['address', 'consent', 'done'].forEach(step => { $(`#step-${step}`).classList.toggle('current', state.connectionStep === step); });
  const root = $('#connection-content');
  if (state.connectionStep === 'address') {
    root.innerHTML = `<h2>Connect your Moodarr</h2><p>Enter the public HTTPS address of your Moodarr API or MCP endpoint.</p><form id="connection-form"><label class="field-label" for="instance-address">Moodarr address</label><input class="address-input" id="instance-address" name="address" type="url" autocomplete="url" spellcheck="false" value="${escape(state.address)}" required aria-describedby="address-help"><p class="field-help" id="address-help">Use a public endpoint, such as https://cinema.example.com/mcp. Any hosting provider is welcome.</p><button type="submit" class="button primary wide" id="check-connection">Check connection ${icon('arrow')}</button></form><p class="privacy-note">${icon('lock')}<span>You’ll sign in through the endpoint’s authorization flow. No API keys or administrator tokens to paste here.</span></p><div id="connection-result" aria-live="polite"></div><p class="review-fixture">Preview fixture: this form does not contact the address or sign you in.</p>`;
  } else if (state.connectionStep === 'consent') {
    root.innerHTML = `<p class="eyebrow">AUTHORIZATION PAGE · CONCEPT</p><h2>Allow Moodarr to connect?</h2><p>This account will be used when you access your instance from ChatGPT.</p><div class="account-row"><strong>Alex</strong><p>Plex user · My cinema</p><p>${escape(state.address)}</p></div><ul class="consent-list"><li>${icon('check')}<span>Find titles in your library<small>Relevant titles and availability can be shared with ChatGPT.</small></span></li><li>${icon('check')}<span>Save your preferences<small>Record feedback you choose to give.</small></span></li><li>${icon('check')}<span>Manage Watchlist and media requests<small>Requests require your explicit confirmation.</small></span></li></ul><p class="field-help">Your instance’s existing permissions still apply. You can revoke this connection in your account settings.</p>${button('Authorize connection', 'authorize', true, 'arrow')} ${button('Back', 'connect')}<p class="review-fixture">Simulated consent. The production authorization page is supplied by the agreed authentication service.</p>`;
  } else {
    root.innerHTML = `<div class="status-symbol">${icon('check')}</div><h2>Your movie nights, connected.</h2><p>My cinema is linked to Alex’s account. You’re ready to find something to watch.</p><div class="account-row"><strong>My cinema</strong><p>${escape(state.address)}</p><p>Browse · Feedback · Watchlist · Confirmed requests</p></div>${button('Return to preview', 'return', true, 'arrow')}<p class="review-fixture">This is a simulated connection. No account has been linked.</p>`;
  }
}
function addressIssue(value) {
  let url;
  try { url = new URL(value); } catch { return ['Enter a valid address.', 'Use the complete public HTTPS URL of your Moodarr API or MCP endpoint.']; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const octets = host.split('.').map(Number);
  const ipv4 = octets.length === 4 && octets.every(Number.isInteger);
  const local4 = ipv4 && (octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127));
  const localHost = host === 'localhost' || /\.(local|localhost|lan|internal|home\.arpa)$/.test(host) || !host.includes('.') && !host.includes(':');
  const local6 = host === '::1' || host === '::' || /^(fc|fd|fe[89ab])/.test(host) && host.includes(':') || host.startsWith('::ffff:');
  if (local4 || localHost || local6) return ['This address is on a private network.', 'ChatGPT needs an endpoint reachable over the public internet. Ask your instance owner for a public HTTPS API or MCP address with authentication.'];
  if (url.protocol !== 'https:') return ['A secure address is required.', 'Use a public HTTPS endpoint with a valid certificate and supported authentication.'];
  if (url.username || url.password || url.hash || url.search) return ['Use an address without credentials or tokens.', 'Remove credentials, query parameters, and fragments. Sign-in happens in the authorization flow.'];
  return null;
}
async function checkConnection(event) {
  event.preventDefault();
  const value = $('#instance-address').value.trim();
  state.address = value;
  const generation = ++state.connectionGeneration;
  const control = $('#check-connection');
  control.disabled = true;
  control.innerHTML = '<span class="spinner" aria-hidden="true"></span> Checking…';
  $('#instance-address').removeAttribute('aria-invalid');
  $('#connection-result').innerHTML = '';
  await pause(550);
  if (generation !== state.connectionGeneration || state.connectionStep !== 'address') return;
  const issue = addressIssue(value) || (state.scenario === 'unreachable' ? ['We could not reach this endpoint.', 'Check the address, TLS certificate, and public access rules with your instance owner, then try again.'] : state.scenario === 'auth' ? ['Supported authentication was not found.', 'Ask your instance owner for an API or MCP endpoint with the supported authorization configuration. Do not paste a server token here.'] : null);
  control.disabled = false;
  control.innerHTML = `Check connection ${icon('arrow')}`;
  $('#instance-address').setAttribute('aria-invalid', String(Boolean(issue)));
  $('#connection-result').innerHTML = `<div class="connection-result"><div class="result-heading">${icon(issue ? 'warning' : 'check')}<h3>${issue ? issue[0] : 'My cinema is ready to connect.'}</h3></div><p>${issue ? issue[1] : 'Continue to the authorization page to choose your account and review access.'}</p>${issue ? '' : button('Continue to sign in', 'sign-in', true, 'arrow')}<p class="review-fixture">${issue ? 'The error state is simulated.' : 'Sample reachability result; no network check was made.'}</p></div>`;
}
document.addEventListener('submit', event => { if (event.target.id === 'connection-form') checkConnection(event); });
document.addEventListener('change', event => {
  if (event.target.id === 'confirm-check') $('[data-action="confirm"]').disabled = !event.target.checked;
});
document.addEventListener('input', event => {
  if (event.target.id === 'instance-address') {
    state.connectionGeneration++;
    $('#connection-result').innerHTML = '';
    $('#check-connection').disabled = false;
    $('#check-connection').innerHTML = `Check connection ${icon('arrow')}`;
  }
});
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  if (action === 'title') showTitle(target.dataset.id);
  if (action === 'close') dialog.close();
  if (action === 'connect') connect();
  if (action === 'reset') { $('#scenario').value = state.scenario = 'ready'; renderCards(); }
  if (action === 'plex') toast('Preview: this opens the title in your Plex app.');
  if (action === 'more' || action === 'less') feedback(action);
  if (action === 'watchlist') watchlist();
  if (action === 'preview') { state.view = 'preview'; renderDetail(); }
  if (action === 'cancel-preview') { state.view = 'detail'; renderDetail(); $('[data-action="preview"]')?.focus(); }
  if (action === 'confirm') confirmRequest();
  if (action === 'check-status') checkStatus();
  if (action === 'sign-in') { state.connectionStep = 'consent'; renderConnection(); }
  if (action === 'authorize') { state.connectionStep = 'done'; renderConnection(); }
  if (action === 'return') { $('#scenario').value = state.scenario = 'ready'; browse(); }
});
dialog.addEventListener('close', () => { state.generation++; });
$('#browse-tab').addEventListener('click', browse);
$('#connect-tab').addEventListener('click', connect);
$('#scenario').insertAdjacentHTML('beforeend', '<option value="unreachable">Connection · unreachable</option><option value="auth">Connection · unsupported auth</option>');
$('#scenario').addEventListener('change', event => {
  dialog.close();
  state.scenario = event.target.value;
  state.operations.clear();
  state.attemptCount = 0;
  if (state.scenario === 'unreachable' || state.scenario === 'auth') connect(); else browse();
});
$('#appearance').addEventListener('click', () => {
  const dark = document.body.classList.toggle('dark');
  const label = `${dark ? 'Light' : 'Dark'} appearance`;
  $('#appearance').setAttribute('aria-label', label);
  $('#appearance').title = label;
  $('#appearance').innerHTML = icon(dark ? 'sun' : 'moon');
});
browse();
