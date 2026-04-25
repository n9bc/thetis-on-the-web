// ── STATE ──
const S = {
  ws: null, connected: false,
  vfoA: 14225000, vfoB: 14196000,
  mode: 'USB', mox: false, tune: false,
  step: 500, _pttWatchdog: null,
  audioCtx: null, rxOn: false, txMicOn: false, micStream: null, micCtx: null, micStreaming: false, txAnalyser: null,
  // IQ panadapter
  iqOn: false, iqSR: 192000, iqCentre: 14225000,
};

// noise / toggle states
// Explicitly initialize all toggle states so first-use is predictable
const TG = { split: false, mute: false, mon: false, rx2: false };

// ── BANDPASS DRAG / PREVIEW STATE ──
let bpDragHzOffset = 0;          // Hz offset during drag (read by drawSpec for preview)
let bpDraggingInProgress = false; // suppress incoming VFO updates while dragging
let bpIgnoreVfoUpdateUntil = 0;  // timestamp — ignore radio VFO echoes until this time
let sliderLastValue = 0;         // tuning slider last position
let _wheelCommitTimer = null;    // debounce timer for wheel tuning
let _wheelBaseVfo = 0;           // VFO baseline when wheel scrolling starts
let _wheelLastSend = 0;          // timestamp of last VFO send (rate-limiter)

// ── XSS HARDENING ──
// Every template literal that interpolates external data (Spothole API, hamqsl XML,
// imported JSON memories) flows through this. `textContent`/`createElement` would be
// safer still, but escaping keeps the existing innerHTML template shape intact.
const _ESC_MAP = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
function escHtml(v) {
  return (v == null ? '' : String(v)).replace(/[&<>"']/g, c => _ESC_MAP[c]);
}

// ── SCREEN WAKE LOCK ──
// Keep the screen on while connected so the radio link doesn't drop when the
// phone sleeps (CLAUDE.md §3). The sentinel auto-releases on tab hide — the
// visibilitychange handler below re-acquires when the tab becomes visible.
let _wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (_wakeLock && !_wakeLock.released) return;   // already held — don't leak a second sentinel
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch (e) { /* permission denied or unsupported — non-fatal */ }
}
function releaseWakeLock() {
  if (_wakeLock) { try { _wakeLock.release(); } catch (e) {} _wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.connected) acquireWakeLock();
});

// ── WEBSOCKET ──
// Auto-reconnect state: when the user clicks DISCONNECT we set _userClosed=true
// so onclose doesn't schedule a retry. Backoff starts at 1s and caps at 30s.
let _reconnectTimer = null;
let _reconnectDelay = 1000;
const _RECONNECT_MAX = 30000;

function toggleConn() {
  S.connected ? disconnect() : connect();
}

function connect() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  const url = document.getElementById('hostInput').value.trim();
  // Reject clearly invalid URLs before handing off to the WebSocket constructor
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    log('err', 'Invalid URL — must begin with ws:// or wss://');
    return;
  }
  S._userClosed = false;
  log('sys', 'Connecting → ' + url);
  document.getElementById('connBtn').textContent = 'CONNECTING…';
  try {
    S.ws = new WebSocket(url);
    S.ws.binaryType = 'arraybuffer';
    S.ws.onopen    = () => {
      S.connected = true;
      _reconnectDelay = 1000;  // reset backoff on a successful open
      acquireWakeLock();
      setUI(true);
      log('sys', 'Connected — Thetis TCI online');
      // Auto-start RX audio after Thetis sends 'ready'
      S._autoStartRx = true;

      document.getElementById('specMsg').style.display = 'none';
      startSmeterPoll();
      startNetMonitor();
      // Start IQ panadapter stream
      setTimeout(() => {
        if (S.ws && S.ws.readyState === 1) {
          S.ws.send('iq_samplerate:192000;'); netTx(22);
          S.ws.send('iq_start:0;'); netTx(12);
          S.iqOn = true;
          log('sys', 'IQ panadapter stream started (192 kHz)');
        }
      }, 500);

      // Auto-start RX audio — fires after 'ready' message OR after 1.5s fallback
      setTimeout(() => {
        if (S.connected && !S.rxOn) {
          log('sys', 'Auto-starting RX audio…');
          togAudio('rx');
        }
      }, 1500);
    };
    S.ws.onmessage = onMsg;
    S.ws.onclose   = () => {
      S.connected = false; S.iqOn = false;
      if (S.mox)  { S.mox = false;  stopMicStream(); updTXRX(); log('err','⚠ PTT auto-released — connection lost'); }
      if (S.tune) { S.tune = false; updTune(); }
      if (S._pttWatchdog) { clearTimeout(S._pttWatchdog); S._pttWatchdog = null; }
      setUI(false); log('sys','Disconnected'); stopRx(); stopSmeterPoll(); stopNetMonitor();
      SM.dbm = null; SM.smoothDbm = -130; SM.peakDbm = -130;
      if (S._userClosed) releaseWakeLock();
      if (!S._userClosed) scheduleReconnect();
    };
    S.ws.onerror   = () => { log('err','Connection error — is Thetis TCI Server running?'); setUI(false); };
  } catch(e) { log('err', 'Bad URL: ' + e.message); setUI(false); }
}

function scheduleReconnect() {
  if (_reconnectTimer) return;
  const delay = Math.min(_reconnectDelay, _RECONNECT_MAX);
  log('sys', 'Reconnecting in ' + (delay / 1000).toFixed(1) + 's…');
  const btn = document.getElementById('connBtn');
  if (btn) btn.textContent = 'RECONNECT ' + Math.round(delay / 1000) + 's';
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (!S._userClosed) connect();
  }, delay);
  _reconnectDelay = Math.min(_reconnectDelay * 2, _RECONNECT_MAX);
}

function disconnect() {
  S._userClosed = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (S.ws) S.ws.close();
}

function onMsg(evt) {
  if (evt.data instanceof ArrayBuffer) {
    netRx(evt.data.byteLength);
    rxAudio(evt.data);
    return;
  }
  // Text frames
  netRx(evt.data.length);
  evt.data.trim().split(';').map(s=>s.trim()).filter(Boolean).forEach(parseTCI);
}

// Commands that fire many times/sec — suppress from log to avoid flood
const _logSilence = new Set([
  'vfo','if','rx_smeter','s_meter','smeter',
  // Known Thetis startup broadcast messages — informational only, no action needed
  'protocol','device','receive_only','trx_count','channels_count',
  'vfo_limits','if_limits','modulations_list','dds',
  'tx_frequency','tx_frequency_thetis',
  'rx_enable','rx_nr_enable','rx_nr_enable_ex',
  'tx_power','swr',
  'rx_volume','rx_ctun_ex','rx_mute',
  'tx_profiles_ex','tx_profile_ex','calibration_ex',
  'rx_channel_enable','tx_enable',
  'iq_stop','iq_samplerate','iq_start',
  'audio_stream_sample_type','audio_stream_channels',
  'audio_stream_samples','tx_stream_audio_buffering',
  'mon_enable','mon_volume',
]);

function parseTCI(msg) {
  const ci = msg.indexOf(':');
  if (ci < 0) {
    log('rx', msg+';');
    if (msg === 'ready' && S._autoStartRx) {
      S._autoStartRx = false;
      setTimeout(() => togAudio('rx'), 300);
    }
    return;
  }
  const cmdPeek = msg.slice(0, ci).toLowerCase();
  if (!_logSilence.has(cmdPeek)) log('rx', msg + ';');
  if (ci < 0) return;
  const cmd  = msg.slice(0, ci).toLowerCase();
  const args = msg.slice(ci + 1).split(',');
  switch (cmd) {
    case 'vfo':
      if (args.length >= 3) {
        const v = parseInt(args[2]);
        // Ignore radio echo-backs while user is dragging/scrolling to prevent display jitter
        if (args[0]==='0' && args[1]==='0') {
          if (Date.now() >= bpIgnoreVfoUpdateUntil) setVfoDisp('A', v);
        }
        if (args[0]==='0' && args[1]==='1') setVfoDisp('B', v);
      }
      break;
    case 'dds':
      if (args.length >= 2 && args[0] === '0') {
        S.iqCentre = parseInt(args[1]) || S.iqCentre;
      }
      break;
    case 'iq_samplerate':
      S.iqSR = parseInt(args[0]) || 192000;
      break;
    case 'modulation':
      if (args.length >= 2 && args[0] === '0') {
        S.mode = args[1].toUpperCase();
        updMode();
        // Re-apply active filter edges for the new mode
        const ab = document.querySelector('#filtG .f-btn.active');
        if (ab && ab.dataset.bw) {
          const [lo, hi] = bwToLoHi(parseInt(ab.dataset.bw));
          el('flo').value =lo; el('fhi').value =hi;
        }
        // Immediately re-filter DX spots if Track Mode is active
        if (dxEnabled && (el('dxTrackMode') || {}).checked) dxApplyFilter();
      }
      break;
    case 'trx':
      if (args.length >= 2) { S.mox = args[1]==='true'; updTXRX(); }
      break;
    case 'tune':
      if (args.length >= 2) { S.tune = args[1]==='true'; updTune(); }
      break;
    case 'rx_filter_band':
      if (args.length >= 3 && args[0]==='0') {
        document.getElementById('flo').value = args[1];
        document.getElementById('fhi').value = args[2];
      }
      break;


    case 'split_enable':
      TG.split = args[0]==='true'; el('splitC').classList.toggle('on', TG.split);
      break;
    case 'line_in':
      // Thetis broadcasting line_in state to other clients — just log it
      log('sys', 'Thetis line_in: ' + (args[1]||'?') + ' (notification to other clients)');
      break;
    case 'audio_start':
      log('sys', '✓ Thetis confirmed audio_start — binary frames should follow');
      break;
    case 'audio_samplerate':
      log('sys', '✓ Thetis confirmed audio_samplerate:'+args[0]);
      break;
    case 'mute':
      TG.mute = args[0]==='true'; el('muteC').classList.toggle('on', TG.mute);
      break;

    // S-meter: Thetis sends rx_smeter:receiver,vfo,dBm
    case 'rx_smeter':
    case 's_meter':
    case 'smeter':
      {
        const val = parseFloat(args[args.length - 1]);
        if (!isNaN(val)) { smTciLastTime = Date.now(); updateSmeter(val, 'tci'); }
      }
      break;

    // NR state from Thetis — rx_nr_enable_ex has 3rd arg with NR type (1-4)
    case 'rx_nr_enable':
      // Just the master on/off — we rely on rx_nr_enable_ex for the NR type
      break;
    case 'rx_nr_enable_ex':
      if (args.length >= 2 && args[0] === '0') {
        if (args[1] === 'true' && args.length >= 3) {
          activeNR = parseInt(args[2]) || 1;  // 3rd arg = NR type (1,2,3,4)
        } else if (args[1] === 'false') {
          activeNR = 0;
        }
        ['nr1C','nr2C','nr3C','nr4C'].forEach((id, i) => {
          const b = el(id); if (b) b.classList.toggle('on', activeNR === i + 1);
        });
      }
      break;


    case 'tx_power': {
      // Thetis may send either "tx_power:watts;" or "tx_power:trx,watts;"
      // If two args, args[0] is the TRX index; if one arg, args[0] is the watts value.
      const txW = parseFloat(args.length >= 2 ? args[1] : args[0]) || 0;
      SM.txWatts = txW;
      break;
    }
    case 'swr': {
      // Same dual-format handling: "swr:value;" or "swr:trx,value;"
      const swrV = parseFloat(args.length >= 2 ? args[1] : args[0]) || 1.0;
      SM.swr = Math.max(1.0, swrV);
      break;
    }
    case 'rx_anf_enable':
      if (args.length >= 2 && args[0] === '0') {
        anfOn = args[1] === 'true';
        const ab2 = el('anfC'); if (ab2) ab2.classList.toggle('on', anfOn);
      }
      break;

    default:
      // Log truly unknown commands (not in silence list) — useful for discovering new TCI commands
      if (!_logSilence.has(cmd)) {
        log('sys', '? unknown TCI: ' + cmd + ':' + args.join(','));
      }
      break;
  }
}

function send(msg) {
  if (S.ws && S.ws.readyState === 1) { S.ws.send(msg); netTx(msg.length); log('tx', msg); }
}

// ── UI helpers ──
function el(id) { return document.getElementById(id); }

function setUI(on) {
  const btn = el('connBtn');
  btn.textContent = on ? 'DISCONNECT' : 'CONNECT';
  btn.className = 'btn-connect' + (on ? ' on' : '');
  el('sDot').className = 'status-dot' + (on ? ' rx' : '');
  el('sLabel').textContent = on ? 'ONLINE' : 'OFFLINE';
  el('sLabel').className = 'status-label' + (on ? '' : '');
  if (!on) { el('txrxDot').className='status-dot'; el('txrxLabel').textContent='RX'; }
}

function updTXRX() {
  el('txrxDot').className = 'status-dot ' + (S.mox ? 'tx' : 'rx');
  el('txrxLabel').textContent = S.mox ? 'TX' : 'RX';
  el('pttBtn').classList.toggle('active', S.mox);
  // Keep mobile bar PTT button state in sync
  el('pttBtnMobile')?.classList.toggle('active', S.mox);
}

function updMode() {
  document.querySelectorAll('#modeBtns .mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.m === S.mode));
}



function updTune() {
  el('tuneBtn').classList.toggle('active', S.tune);
  el('tuneBtnMobile')?.classList.toggle('active', S.tune);
  // Only reset TX values when TUNE goes OFF so the S-meter keeps
  // showing power until the key actually drops.
  if (!S.tune) {
    SM.txWatts = 0;
    SM.swr = 1.0;
  }
}

// ── VFO ──
const BAND_RANGES = [
  { band:'160m', lo:1800000,   hi:2000000   },
  { band:'80m',  lo:3500000,   hi:4000000   },
  { band:'60m',  lo:5330000,   hi:5410000   },
  { band:'40m',  lo:7000000,   hi:7300000   },
  { band:'30m',  lo:10100000,  hi:10150000  },
  { band:'20m',  lo:14000000,  hi:14350000  },
  { band:'17m',  lo:18068000,  hi:18168000  },
  { band:'15m',  lo:21000000,  hi:21450000  },
  { band:'12m',  lo:24890000,  hi:24990000  },
  { band:'10m',  lo:28000000,  hi:29700000  },
  { band:'6m',   lo:50000000,  hi:54000000  },
];

function freqToBand(hz) {
  for (const r of BAND_RANGES) if (hz >= r.lo && hz <= r.hi) return r.band;
  return null;
}

function updBandButtons(hz) {
  const band = freqToBand(hz);
  document.querySelectorAll('.band-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.band === band);
  });
}

function setVfoDisp(vfo, hz) {
  if (vfo==='A') S.vfoA=hz; else S.vfoB=hz;
  const mhz = hz / 1e6;
  const whole = Math.floor(mhz).toString();
  const dec = mhz.toFixed(4).split('.')[1]; // 4 decimal digits
  const disp = el('vfo' + vfo + 'Disp');

  // Build digit spans: each digit gets a data-hz attribute for its positional value
  // Whole part: e.g. "14" → positions 10MHz, 1MHz
  // Decimal part: "2250" → 100kHz, 10kHz, 1kHz, 100Hz
  const decValues = [100000, 10000, 1000, 100];
  let html = '';

  // Whole MHz digits
  const wholeValues = [];
  for (let i = 0; i < whole.length; i++) {
    wholeValues.push(Math.pow(10, whole.length - 1 - i) * 1000000);
  }
  for (let i = 0; i < whole.length; i++) {
    html += '<span class="vfo-digit" data-hz="' + wholeValues[i] + '" data-vfo="' + vfo + '">' + whole[i] + '</span>';
  }
  html += '.';
  // Decimal digits
  for (let i = 0; i < 4; i++) {
    html += '<span class="vfo-digit" data-hz="' + decValues[i] + '" data-vfo="' + vfo + '">' + dec[i] + '</span>';
  }
  html += '<span class="mhz"> MHz</span>';
  disp.innerHTML = html;
  if (vfo==='A') {
    updBandButtons(hz);
    if (specZoom > 1) specZoomCentre = hz; // keep zoomed view tracking VFO A
    updateMobileBar(); // keep mobile bottom bar freq readout in sync
  }
  saveState();
}

// Handle digit clicks: left-click = increment, right-click = decrement
document.addEventListener('click', function(e) {
  const d = e.target.closest('.vfo-digit');
  if (!d) return;
  const vfo = d.dataset.vfo;
  const step = parseInt(d.dataset.hz);
  const hz = Math.max(0, (vfo==='A' ? S.vfoA : S.vfoB) + step);
  setVfoDisp(vfo, hz);
  send('vfo:0,' + (vfo==='A'?'0':'1') + ',' + hz + ';');
});
document.addEventListener('contextmenu', function(e) {
  const d = e.target.closest('.vfo-digit');
  if (!d) return;
  e.preventDefault();
  const vfo = d.dataset.vfo;
  const step = parseInt(d.dataset.hz);
  const hz = Math.max(0, (vfo==='A' ? S.vfoA : S.vfoB) - step);
  setVfoDisp(vfo, hz);
  send('vfo:0,' + (vfo==='A'?'0':'1') + ',' + hz + ';');
});

function editFreq(vfo) {
  const disp = el('vfo' + vfo + 'Disp');
  const inp  = el('vfo' + vfo + 'In');
  disp.style.display = 'none';
  inp.style.display  = 'block';
  inp.value = ((vfo==='A' ? S.vfoA : S.vfoB) / 1e6).toFixed(4);
  inp.select(); inp.focus();
}

function commitFreq(vfo) {
  const inp  = el('vfo' + vfo + 'In');
  const disp = el('vfo' + vfo + 'Disp');
  const hz = Math.round(parseFloat(inp.value) * 1e6);
  if (!isNaN(hz) && hz > 0) {
    setVfoDisp(vfo, hz);
    send('vfo:0,' + (vfo==='A'?'0':'1') + ',' + hz + ';');
  }
  inp.style.display  = 'none';
  disp.style.display = 'block';
}

function freqKey(e, vfo) {
  if (e.key==='Enter')  { commitFreq(vfo); return; }
  if (e.key==='Escape') {
    el('vfo'+vfo+'In').style.display='none';
    el('vfo'+vfo+'Disp').style.display='block';
    return;
  }
  const inp = el('vfo'+vfo+'In');
  const v   = parseFloat(inp.value)||0;
  if (e.key==='ArrowUp')   { e.preventDefault(); inp.value=(v+S.step/1e6).toFixed(4); }
  if (e.key==='ArrowDown') { e.preventDefault(); inp.value=(v-S.step/1e6).toFixed(4); }
}

// Mouse-wheel tuning on VFO display
document.addEventListener('wheel', e => {
  const t = e.target.closest('#vfoADisp,#vfoBDisp');
  if (!t) return;
  e.preventDefault();
  const vfo = t.id.includes('A') ? 'A' : 'B';
  const dir = e.deltaY < 0 ? 1 : -1;
  const hz  = Math.max(0, (vfo==='A'?S.vfoA:S.vfoB) + dir*S.step);
  setVfoDisp(vfo, hz);
  send('vfo:0,'+(vfo==='A'?'0':'1')+','+hz+';');
}, { passive: false });

function vfoSwap(cmd) {
  if (cmd==='A2B') { setVfoDisp('B',S.vfoA); send('vfo:0,1,'+S.vfoA+';'); }
  else if (cmd==='B2A') { setVfoDisp('A',S.vfoB); send('vfo:0,0,'+S.vfoB+';'); }
  else {
    const t=S.vfoA; setVfoDisp('A',S.vfoB); setVfoDisp('B',t);
    send('vfo:0,0,'+S.vfoB+';'); send('vfo:0,1,'+t+';');
  }
}

function setStep(btn, hz) {
  S.step = hz;
  document.querySelectorAll('#stepRow .sbtn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.hz)===hz));
  // Update tuning slider label to reflect new step size
  const lbl = el('tuningStepLabel');
  if (lbl) lbl.textContent = 'TUNE (' + (hz >= 1000 ? (hz/1000)+'kHz' : hz+'Hz') + ')';
  saveState();
}

// ── BAND ──
const bandDfltMode = {
  '160m':'LSB','80m':'LSB','60m':'USB','40m':'LSB','30m':'USB',
  '20m':'USB','17m':'USB','15m':'USB','12m':'USB','10m':'USB','6m':'USB'
};
document.querySelectorAll('.band-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.band-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  const hz = parseInt(b.dataset.freq);
  setVfoDisp('A', hz);
  send('vfo:0,0,'+hz+';');
  setMode(bandDfltMode[b.dataset.band]||'USB');
}));

// ── MODE ──
function setMode(m) {
  S.mode = m; updMode();
  send('modulation:0,'+m+';');
  // Re-apply active filter with correct lo/hi for the new mode
  const activeBtn = document.querySelector('#filtG .f-btn.active');
  if (activeBtn && activeBtn.dataset.bw) {
    const [lo, hi] = bwToLoHi(parseInt(activeBtn.dataset.bw));
    el('flo').value =lo; el('fhi').value =hi;
    send('rx_filter_band:0,' + lo + ',' + hi + ';');
  }
  saveState();
  updateMobileBar(); // keep mobile bar mode readout current
}

// ── ANF ──
let anfOn = false;
function togANF() {
  anfOn = !anfOn;
  send('rx_anf_enable:0,' + anfOn + ';');
  const b = el('anfC'); if (b) b.classList.toggle('on', anfOn);
}

// ── FILTER ──
function bwToLoHi(bw) {
  // Convert a bandwidth value to lo/hi edges based on current mode
  const m = (S.mode||'USB').toUpperCase();
  const half = Math.round(bw / 2);
  if (['USB','DIGU'].includes(m))       return [100, 100 + bw];
  if (['LSB','DIGL'].includes(m))       return [-(100 + bw), -100];
  if (['CWU'].includes(m))              return [600 - half, 600 + half];
  if (['CWL'].includes(m))              return [-(600 + half), -(600 - half)];
  if (['AM','SAM','DSB','NFM','FM'].includes(m)) return [-half, half];
  // Default: treat as USB
  return [100, 100 + bw];
}

function setFilt(btn) {
  document.querySelectorAll('#filtG .f-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const bw = parseInt(btn.dataset.bw);
  const [lo, hi] = bwToLoHi(bw);
  el('flo').value =lo;
  el('fhi').value =hi;
  send('rx_filter_band:0,' + lo + ',' + hi + ';');
  saveState();
}
function customFilt() {
  document.querySelectorAll('#filtG .f-btn').forEach(b => b.classList.remove('active'));
  send('rx_filter_band:0,'+el('flo')?.value+','+el('fhi')?.value+';');
  saveState();
}

// ── AGC ──

// ── NOISE REDUCTION — mutually exclusive NR1/2/3/4 ──
// Reverse-engineered from TCI sniffer:
//   NR off:  rx_nr_enable:0,false;  +  rx_nr_enable_ex:0,false,0;
//   NR1 on:  rx_nr_enable:0,true;   +  rx_nr_enable_ex:0,true,1;
//   NR2 on:  rx_nr_enable:0,true;   +  rx_nr_enable_ex:0,true,2;
//   NR3 on:  rx_nr_enable:0,true;   +  rx_nr_enable_ex:0,true,3;
//   NR4 on:  rx_nr_enable:0,true;   +  rx_nr_enable_ex:0,true,4;
let activeNR = 0;  // 0=off, 1=NR, 2=NR2, 3=NR3, 4=NR4

function setNR(n) {
  if (activeNR === n) {
    // Clicking active NR → turn it off
    send('rx_nr_enable:0,false;');
    send('rx_nr_enable_ex:0,false,0;');
    activeNR = 0;
  } else {
    // Turn on selected NR type
    send('rx_nr_enable:0,true;');
    send('rx_nr_enable_ex:0,true,' + n + ';');
    activeNR = n;
  }
  // Update button visuals
  ['nr1C','nr2C','nr3C','nr4C'].forEach((id, i) => {
    const btn = el(id);
    if (btn) btn.classList.toggle('on', activeNR === i + 1);
  });
}

const noiseCmd = {};
const noiseSpecial = {};
function tog(k) {
  TG[k] = !TG[k];
  const c = el(k+'C'); if (c) c.classList.toggle('on', TG[k]);
  if (noiseSpecial[k]) { noiseSpecial[k](TG[k]); return; }
  const cmd = noiseCmd[k];
  if (cmd) { send(cmd+TG[k]+';'); return; }
  const txCmds = {
    mon:'mon_enable:',      // monitor enable
    split:'split_enable:0,', // split operation
    mute:'mute:'            // confirmed working
  };
  if (txCmds[k]) send(txCmds[k]+TG[k]+';');
}

// ── PTT / TUNE ──
function setPTT(on) {
  if (S.mox === on) return; // ignore duplicate events
  if (S._pttWatchdog) { clearTimeout(S._pttWatchdog); S._pttWatchdog = null; }
  S.mox = on;
  updTXRX();
  send('trx:0,' + on + (on ? ',tci' : '') + ';');
  if (on) {
    // 3-minute auto-release safety watchdog
    S._pttWatchdog = setTimeout(() => {
      log('err', '⚠ PTT auto-released — 3 min timeout');
      setPTT(false);
    }, 180000);
    if (!S.txMicOn) {
      // Auto-arm mic on first PTT press
      startTxMic().then(() => { if (S.mox) startMicStream(); });
    } else {
      startMicStream();
    }
  } else {
    stopMicStream();
  }
}
function togTune() { S.tune=!S.tune; updTune(); send('tune:0,'+S.tune+';'); }

// ── SLIDERS ──
function sl(k, v) {
  v = parseInt(v);
  const map = {
    af:    () => { el('afV').textContent=v+' dB'; const ms=el('afSliderMobile'); if(ms){ms.value=v;el('afVMobile').textContent=v+' dB';} send('rx_volume:0,0,'+v+';'); },

    drive: () => { el('drV').textContent=v+'%';       send('drive:0,'+v+';'); },

    rx2:   () => { el('rx2V').textContent=v;          send('rx_volume:1,'+(v-100)+';'); },
  };
  if (map[k]) { map[k](); saveState(); }
}



// ── ANTENNA ──
function setAnt(n) {
  [el('a1C'),el('a2C'),el('a3C'),el('aXC')].forEach(b => b.classList.remove('on'));
  const targets = {1:'a1C',2:'a2C',3:'a3C',0:'aXC'};
  el(targets[n]).classList.add('on');
  send('rx_antenna:0,'+(n>0?n-1:3)+';');
}

// ── RX2 / DIV ──
function togRX2() { TG.rx2=!TG.rx2; el('rx2C').classList.toggle('on',TG.rx2); send('rx_enable:1,'+TG.rx2+';'); }

// ── AUDIO ──
async function togAudio(dir) {
  if (dir==='rx') {
    if (S.rxOn) { stopRx(); } else { await startRx(); }
  } else {
    if (S.txMicOn) { stopTxMic(); } else { await startTxMic(); }
  }
}

// ── TCI AUDIO BINARY FRAME FORMAT (TCI Protocol v2.0) ──
// 64-byte header (8 × uint32):
//   [0]  receiver     (0 = TRX0)
//   [4]  sample_rate  (48000)
//   [8]  format       (3 = FLOAT32)
//   [12] codec        (0 = uncompressed)
//   [16] crc          (0 = not implemented)
//   [20] length       (number of float32 samples)
//   [24] type         (0=IQ, 1=RX_AUDIO, 2=TX_AUDIO, 3=TX_CHRONO, 4=LINEOUT)
//   [28] channels     (2 = stereo)
//   [32–63] reserv[8] (zeros)
// Followed by: length × float32 samples, interleaved stereo (L,R,L,R,…)
// TX PTT: send trx:0,true,tci; to route TCI audio to TX chain

// TCI stream types (per TCI 2.0 spec, offset 24 in 64-byte header)
// 0=IQ, 1=RX_AUDIO, 2=TX_AUDIO, 3=TX_CHRONO, 4=LINEOUT

// Diagnostic counters
const audioDiag = {
  binaryFrames: 0,      // total binary WS frames received
  audioFrames: 0,       // frames with streamType=1
  unknownTypes: {},     // any other stream types seen
  shortFrames: 0,       // frames too short to parse
  played: 0,            // successfully scheduled for playback
  lastType: null,
  lastSize: null,
  lastSampleCount: null,
};

// Scheduled playback time for gapless audio
let rxNextTime = 0;

async function startRx() {
  try {
    if (S.audioCtx) { S.audioCtx.close(); }

    // Reuse a pre-unlocked context if one was created by the iOS touch handler.
    // This is the only reliable way to get audio on iOS Safari — the context must
    // have been resume()d while a user-gesture event was on the call stack.
    if (window._preUnlockedAudioCtx && window._preUnlockedAudioCtx.state !== 'closed') {
      S.audioCtx = window._preUnlockedAudioCtx;
      window._preUnlockedAudioCtx = null;
      log('sys', 'Reusing pre-unlocked AudioContext (iOS) — state: ' + S.audioCtx.state);
    } else {
      S.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    }

    // Analyser for real-time spectrum display
    S.analyser = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 2048;
    S.analyser.smoothingTimeConstant = 0.89;
    S.analyser.connect(S.audioCtx.destination);

    // On desktop Chrome the context may be suspended until first gesture — resume it.
    // On iOS this should already be 'running' if the pre-unlock path was taken.
    if (S.audioCtx.state === 'suspended') {
      await S.audioCtx.resume();
      log('sys', 'AudioContext resumed from suspended state');
    }

    rxNextTime = S.audioCtx.currentTime + 0.05;
    S.rxOn = true;
    el('rxAuC').classList.add('on');

    // Reset diagnostic counters
    Object.assign(audioDiag, {binaryFrames:0,audioFrames:0,unknownTypes:{},shortFrames:0,played:0,lastType:null,lastSize:null,lastSampleCount:null});

    // Send all audio init in ONE WebSocket frame to guarantee order.
    // Thetis needs audio_start first, audio_samplerate last to trigger streaming.
    // Send each command with a small delay to guarantee Thetis receives them in order.
    // Must match MSHV exactly: audio_start first, audio_samplerate last.
    const audioSeq = [
      'audio_start:0;',
      'tx_stream_audio_buffering:50;',
      'audio_stream_samples:2048;',
      'audio_stream_channels:2;',
      'audio_stream_sample_type:float32;',
      'audio_samplerate:48000;'
    ];
    audioSeq.forEach((cmd, i) => {
      setTimeout(() => {
        if (S.ws && S.ws.readyState === 1) {
          S.ws.send(cmd); netTx(cmd.length);
          log('tx', cmd);
        }
      }, i * 20); // 20ms between each command
    });
    log('sys', 'RX AUDIO ON — sent full MSHV audio start sequence — ctx: '+S.audioCtx.state);
    log('sys', 'Waiting for binary frames from Thetis…');

    // After 3s, report what we got
    setTimeout(() => {
      if (!S.rxOn) return;
      log('sys', '--- Audio diagnostics (3s) ---');
      log('sys', 'Binary WS frames received: ' + audioDiag.binaryFrames);
      log('sys', 'Stream type=1 (RX audio) frames: ' + audioDiag.audioFrames);
      log('sys', 'Frames played to AudioContext: ' + audioDiag.played);
      log('sys', 'Frames too short: ' + audioDiag.shortFrames);
      log('sys', 'AudioContext state now: ' + (S.audioCtx ? S.audioCtx.state : 'null'));
      if (audioDiag.lastType !== null) {
        log('sys', 'Last frame — type:'+audioDiag.lastType+' size:'+audioDiag.lastSize+'b samples:'+audioDiag.lastSampleCount);
      }
      const otherTypes = Object.keys(audioDiag.unknownTypes);
      if (otherTypes.length) log('sys', 'Other stream types seen: ' + otherTypes.map(t=>t+'(×'+audioDiag.unknownTypes[t]+')').join(', '));

      if (audioDiag.binaryFrames === 0) {
        log('err', '⚠ No binary frames received — Thetis is not streaming audio.');
        log('err', 'Sent: audio_samplerate:48000; — Thetis should now stream audio.');
        log('err', 'If still no frames: check Thetis version supports TCI audio (v2.10.3.11+).');
        log('err', 'Also check: is MSHV still connected? Only one TCI audio client at a time.');
      } else if (audioDiag.audioFrames === 0) {
        log('err', '⚠ Binary frames received but none are stream type 1 (RX audio).');
        log('err', 'Types seen: '+JSON.stringify(audioDiag.unknownTypes)+' — frame format may differ from expected.');
        log('err', 'Try disabling header parsing (see diag below for raw bytes).');
      } else if (audioDiag.played === 0) {
        log('err', '⚠ RX audio frames received but none played — sample count or buffer issue.');
      } else {
        log('sys', '✓ Audio pipeline looks healthy — '+audioDiag.played+' buffers played');
      }
    }, 3000);

  } catch(e) { log('err', 'Audio context error: '+e.message); }
}

function stopRx() {
  S.rxOn = false;
  el('rxAuC').classList.remove('on');
  if (S.connected) send('audio_stop:0;');
  if (S.audioCtx) { S.audioCtx.close(); S.audioCtx = null; S.analyser = null; }
  rxNextTime = 0;
}

function rxAudio(buf) {
  audioDiag.binaryFrames++;
  audioDiag.lastSize = buf.byteLength;

  // Route by TCI 2.0 64-byte header type field at offset 24
  // IQ frames: sr=192000 at offset 4, type=0 at offset 24, 2112 bytes total
  // Audio frames: 8-byte non-standard header, different size
  if (buf.byteLength >= 64) {
    const dv = new DataView(buf);
    const srAt4 = dv.getUint32(4, true);
    const typeAt24 = dv.getUint32(24, true);
    if (typeAt24 === 3) { handleTxChrono(dv); return; }  // TX_CHRONO
    // IQ detection: sample rate > 48000 and type=0, or frame is exactly IQ-sized
    if (typeAt24 === 0 && srAt4 > 48000 && srAt4 <= 1000000) { handleIQFrame(buf); return; }
  }

  if (!S.audioCtx || !S.rxOn) return;
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume();

  // Thetis uses a non-standard header — we determined experimentally:
  // bytes 0-1: uint16 type (0 in practice), bytes 2-3: uint16 receiver,
  // bytes 4-7: uint32 = 48000 (sample rate, not count)
  // Derive float count from payload size, not header field.
  const MIN_HEADER = 8;
  if (buf.byteLength < MIN_HEADER) { audioDiag.shortFrames++; tryRawAudio(buf); return; }

  const view      = new DataView(buf);
  const frameType = view.getUint16(0, true);
  const receiver  = view.getUint16(2, true);
  const field3    = view.getUint32(4, true);

  audioDiag.lastType        = frameType;
  audioDiag.lastSampleCount = field3;

  if (frameType === 0 || frameType === 1) {
    audioDiag.audioFrames++;
    if (audioDiag.audioFrames === 1) {
      log('sys', 'First audio frame: type='+frameType+' recv='+receiver+' field3='+field3+' size='+buf.byteLength+'b');
      let hex = '';
      for (let b = 0; b < Math.min(16, buf.byteLength); b++) hex += view.getUint8(b).toString(16).padStart(2,'0')+' ';
      log('sys', 'First 16 bytes (hex): ' + hex);
    }
    // Use payload size to derive float count — field3 is sample rate not count
    const payloadBytes = buf.byteLength - MIN_HEADER;
    const actualFloats = Math.floor(payloadBytes / 4);
    if (actualFloats < 2) { tryRawAudio(buf); return; }
    playFloat32Stereo(buf, MIN_HEADER, actualFloats);
    return;
  }

  // Unknown type — log once
  if (!audioDiag.unknownTypes[frameType]) {
    audioDiag.unknownTypes[frameType] = 0;
    log('sys', 'Binary frame type='+frameType+' recv='+receiver+' field3='+field3+' size='+buf.byteLength+'b');
  }
  audioDiag.unknownTypes[frameType]++;
  tryRawAudio(buf);
}

// ── TX_CHRONO handler: Thetis is asking us to send TX audio ──
let txChronoCount = 0;
function handleTxChrono(dv) {
  txChronoCount++;
  if (txChronoCount === 1) log('sys', 'TX_CHRONO received! Thetis is requesting TX audio frames');
  if (txChronoCount === 10) log('sys', 'TX_CHRONO: 10 received');
}

// ── Play float32 interleaved stereo from an ArrayBuffer ──
function playFloat32Stereo(buf, offset, sampleCount) {
  const frames = Math.floor(sampleCount / 2);
  if (frames < 1) return;
  const floats = new Float32Array(buf, offset, sampleCount);
  const ab = S.audioCtx.createBuffer(2, frames, 48000);
  const L = ab.getChannelData(0);
  const R = ab.getChannelData(1);

  // Fade length: 64 samples (~1.3ms at 48kHz) — enough to kill clicks, short enough to be inaudible
  const FADE = Math.min(64, frames >> 2);

  for (let i = 0; i < frames; i++) {
    let s = 1.0;
    if (i < FADE)             s = i / FADE;           // fade in
    else if (i >= frames - FADE) s = (frames - i) / FADE; // fade out
    L[i] = floats[i * 2]     * s;
    R[i] = floats[i * 2 + 1] * s;
  }
  schedulePlayback(ab);
}

// ── Fallback: try treating entire buffer as raw float32 mono or stereo ──
// Used when Thetis sends audio without the expected header, or header parsing failed
function tryRawAudio(buf) {
  if (!S.audioCtx) return;
  const totalFloats = Math.floor(buf.byteLength / 4);
  if (totalFloats < 2) return;

  // Try as interleaved stereo float32 (no header)
  const frames = Math.floor(totalFloats / 2);
  const floats = new Float32Array(buf, 0, totalFloats);
  const ab = S.audioCtx.createBuffer(2, frames, 48000);
  const L = ab.getChannelData(0);
  const R = ab.getChannelData(1);
  for (let i = 0; i < frames; i++) {
    L[i] = floats[i * 2];
    R[i] = floats[i * 2 + 1];
  }
  schedulePlayback(ab);
}

// ── Schedule a buffer for gapless playback ──
function schedulePlayback(ab) {
  const now = S.audioCtx.currentTime;
  if (rxNextTime < now) rxNextTime = now + 0.02;
  const src = S.audioCtx.createBufferSource();
  src.buffer = ab;
  src.connect(S.analyser || S.audioCtx.destination);
  src.start(rxNextTime);
  rxNextTime += ab.duration;
  audioDiag.played++;
  drawAuMeter(ab.getChannelData(0));
}

// ── TX MIC — AudioWorklet processor source ──
// Inlined as a string because the app is one file and has no build step.
// The worklet accumulates incoming 128-sample render quanta into 2048-sample
// blocks, then posts them to the main thread for WS send. Keeps all audio
// processing off the main thread per CLAUDE.md §3.
const TX_WORKLET_SRC = `
class TotwTxMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.pos++] = ch[i];
      if (this.pos >= this.buf.length) {
        this.port.postMessage(this.buf.slice(0));
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('totw-tx-mic', TotwTxMicProcessor);
`;
let _txWorkletUrl = null;
function getTxWorkletUrl() {
  if (!_txWorkletUrl) {
    _txWorkletUrl = URL.createObjectURL(new Blob([TX_WORKLET_SRC], { type: 'application/javascript' }));
  }
  return _txWorkletUrl;
}

// ── TX MIC — device setup (button toggle) ──
// Grabs the mic device and arms it. Actual streaming starts/stops
// when Thetis sends line_in:0,true / line_in:0,false (on PTT).
async function startTxMic() {
  try {
    const AudioCtxCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxCtor) throw new Error('This browser does not support the Web Audio API needed for TX audio.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access requires https:// or localhost and a current browser.');
    }
    if (!window.AudioWorkletNode) {
      throw new Error('AudioWorklet not supported — use a current Chrome/Edge/Firefox/Safari.');
    }
    S.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate:48000, channelCount:1,
               echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
    S.micCtx = new AudioCtxCtor({ sampleRate: 48000 });
    if (!S.micCtx.audioWorklet) {
      throw new Error('AudioWorklet not supported by this browser context.');
    }
    if (S.micCtx.state === 'suspended') {
      try { await S.micCtx.resume(); } catch(e) {}
    }

    // Load the inline worklet module (once per context)
    await S.micCtx.audioWorklet.addModule(getTxWorkletUrl());

    const src = S.micCtx.createMediaStreamSource(S.micStream);

    // TX analyser — feeds spectrum/waterfall during TX
    S.txAnalyser = S.micCtx.createAnalyser();
    S.txAnalyser.fftSize = 2048;
    S.txAnalyser.smoothingTimeConstant = 0.89;

    const node = new AudioWorkletNode(S.micCtx, 'totw-tx-mic', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1,
    });
    S._txWorkletNode = node;

    let txFrameCount = 0;
    node.port.onmessage = (e) => {
      if (!S.connected || !S.micStreaming) return;
      const inp = e.data;                       // Float32Array(2048) mono
      const frameCount = inp.length;
      const stereoCount = frameCount * 2;

      // TCI 2.0 Stream structure — same 64-byte header the old path emitted.
      const HEADER = 64;
      const buf = new ArrayBuffer(HEADER + stereoCount * 4);
      const dv  = new DataView(buf);
      dv.setUint32(0,  0,            true); // receiver = 0
      dv.setUint32(4,  48000,        true); // sample_rate
      dv.setUint32(8,  3,            true); // format = FLOAT32 (3)
      dv.setUint32(12, 0,            true); // codec = 0
      dv.setUint32(16, 0,            true); // crc = 0
      dv.setUint32(20, stereoCount,  true); // length = total float32 count
      dv.setUint32(24, 2,            true); // type = TX_AUDIO_STREAM (2)
      dv.setUint32(28, 2,            true); // channels = 2
      // bytes 32–63: reserv[8] — zero-initialized by ArrayBuffer

      const floats = new Float32Array(buf, HEADER);
      for (let i = 0; i < frameCount; i++) {
        const s = Math.max(-1.0, Math.min(1.0, inp[i]));
        floats[i * 2]     = s; // L
        floats[i * 2 + 1] = s; // R
      }

      if (S.ws && S.ws.readyState === 1) {
        S.ws.send(buf);
        netTx(buf.byteLength);
        txFrameCount++;
        if (txFrameCount === 1) {
          log('sys', 'TX frame 1 (worklet): 64-byte header + '+stereoCount+' floats = '+buf.byteLength+'b total');
        }
        if (txFrameCount === 50) log('sys', 'TX: 50 frames sent — check Thetis TX power meter');
      } else {
        if (txFrameCount === 0) log('err', 'TX: WS not open — readyState='+(S.ws?S.ws.readyState:'null'));
      }
    };

    src.connect(S.txAnalyser);
    src.connect(node);
    // No destination connection needed — AudioWorkletNode runs on the audio
    // render thread regardless. We don't want mic playback either.
    S.txMicOn = true;
    S.micStreaming = false; // streaming starts only when Thetis sends line_in:0,true
    el('txMcC').classList.add('on');
    log('sys', 'TX mic armed (AudioWorklet) — press PTT to transmit');
  } catch(e) {
    const msg = e.name === 'NotAllowedError'
      ? 'Mic access DENIED — open browser site settings and allow microphone, then reload'
      : e.name === 'NotFoundError'
      ? 'No microphone found — check device connections'
      : 'Mic error: ' + e.message;
    log('err', msg);
    alert(msg);
  }
}

function stopTxMic() {
  stopMicStream();
  if (S._txWorkletNode) {
    try { S._txWorkletNode.port.onmessage = null; S._txWorkletNode.disconnect(); } catch(e) {}
    S._txWorkletNode = null;
  }
  if (S.micStream) { S.micStream.getTracks().forEach(t => t.stop()); S.micStream = null; }
  if (S.micCtx) { S.micCtx.close(); S.micCtx = null; }
  S.txAnalyser = null;
  S.txMicOn = false;
  S.micStreaming = false;
  el('txMcC').classList.remove('on');
}

// Start/stop mic audio streaming — called directly on PTT
function startMicStream() {
  if (!S.txMicOn) return;
  S.micStreaming = true;
  log('sys', 'TX: mic streaming started — txMicOn='+S.txMicOn+' ws='+(S.ws?S.ws.readyState:'null'));
}

function stopMicStream() {
  if (!S.micStreaming) return;
  S.micStreaming = false;
  log('sys', 'TX: mic streaming stopped');
}



// ── AUDIO LEVEL METER ──
let _auSmooth = 0;
function drawAuMeter(smp) {
  const cv = el('auMtr'); if (!cv) return;
  cv.width = cv.offsetWidth; cv.height = cv.offsetHeight;
  const ctx = cv.getContext('2d');

  // RMS level
  let rms = 0; for (const s of smp) rms += s * s;
  rms = Math.sqrt(rms / smp.length);

  // Smooth: fast attack, slow decay
  _auSmooth = rms > _auSmooth ? rms * 0.8 + _auSmooth * 0.2
                               : rms * 0.05 + _auSmooth * 0.95;
  const level = Math.min(1, _auSmooth * 6); // scale so typical speech hits ~0.6

  const w = cv.width, h = cv.height;

  // Background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);

  if (level > 0.001) {
    // Full gradient bar — green → yellow → red
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0,    '#3fb950'); // green
    g.addColorStop(0.6,  '#3fb950'); // green
    g.addColorStop(0.75, '#e3b341'); // yellow
    g.addColorStop(0.9,  '#f85149'); // red
    g.addColorStop(1.0,  '#ff0000');

    // Clip to level width
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, level * w, h);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // Peak tick — brief hold at peak
  if (!drawAuMeter._peak || _auSmooth > drawAuMeter._peak) {
    drawAuMeter._peak = _auSmooth;
    drawAuMeter._peakTime = Date.now();
  } else if (Date.now() - drawAuMeter._peakTime > 800) {
    drawAuMeter._peak *= 0.95; // decay
  }
  const px = Math.min(w - 2, drawAuMeter._peak * 6 * w);
  if (px > 2) {
    ctx.fillStyle = drawAuMeter._peak * 6 > 0.9 ? '#f85149' : '#e3b341';
    ctx.fillRect(px, 0, 2, h);
  }
}

// ── S-METER ──
let smCal = 20;  // IQ S-meter calibration offset in dB (tune so S9 ≈ -73 dBm)
const SM = {
  dbm: null,          // current dBm reading (null = no data)
  smoothDbm: -130,    // smoothed for needle
  peakDbm: -130,      // peak hold
  peakTime: 0,
  source: 'tci',      // 'tci' or 'audio'
  pollId: null,
  txWatts: 0,         // TX forward power (watts) from tx_power TCI
  swr: 1.0,           // SWR from swr TCI
};

// S-unit dBm thresholds (50-ohm convention)
const S_UNITS = [
  { label:'S1', dbm:-121 }, { label:'S2', dbm:-115 }, { label:'S3', dbm:-109 },
  { label:'S4', dbm:-103 }, { label:'S5', dbm:-97  }, { label:'S6', dbm:-91  },
  { label:'S7', dbm:-85  }, { label:'S8', dbm:-79  }, { label:'S9', dbm:-73  },
  { label:'+10',dbm:-63  }, { label:'+20',dbm:-53  }, { label:'+30',dbm:-43  },
  { label:'+40',dbm:-33  }, { label:'+60',dbm:-13  },
];

function dbmToSunit(dbm) {
  if (dbm == null) return '– – –';
  for (let i = S_UNITS.length - 1; i >= 0; i--) {
    if (dbm >= S_UNITS[i].dbm) {
      if (i >= 8) return 'S9 ' + S_UNITS[i].label;  // S9+xx
      return S_UNITS[i].label;
    }
  }
  return 'S0';
}

// Normalise dBm to 0..1 for meter arc
function dbmToNorm(dbm) {
  // S1 (-121) = 0, S9+60 (-13) = 1
  return Math.max(0, Math.min(1, (dbm - (-127)) / ((-13) - (-127))));
}

// Start polling Thetis for S-meter data
let smTciLastTime = 0;
function startSmeterPoll() {
  if (SM.pollId) return;
  SM.pollId = setInterval(() => {
    if (!S.connected) return;
    if (S.ws && S.ws.readyState !== 1) return;
    if (S.mox || S.tune) {
      // During TX/TUNE: query Thetis for TX forward power (responds with tx_power:trx,watts;)
      S.ws.send('tx_power:0;');
    } else {
      // During RX: request S-meter reading from Thetis
      S.ws.send('rx_smeter:0,0;');
      // Fallback to IQ or audio if TCI S-meter hasn't arrived recently
      if (Date.now() - smTciLastTime > 2000) {
        if (S.iqOn && IQ.fftReady) smeterFromIQ();
        else if (S.analyser && S.rxOn) smeterFromAudio();
      }
    }
  }, 100);  // 10 Hz
}
function stopSmeterPoll() {
  if (SM.pollId) { clearInterval(SM.pollId); SM.pollId = null; }
}

// ── IQ-based S-meter: measure real RF power in the filter passband ──
function smeterFromIQ() {
  if (!IQ.fftReady) return;
  const N = IQ.FFT_SIZE;
  const SR = S.iqSR || 192000;
  const loHz = S.iqCentre - SR / 2;

  // Get filter passband in absolute Hz
  const flo = parseInt(el('flo')?.value) || 100;
  const fhi = parseInt(el('fhi')?.value) || 2900;
  const filterLoHz = S.vfoA + Math.min(flo, fhi);
  const filterHiHz = S.vfoA + Math.max(flo, fhi);

  // Map to FFT bins
  const binLo = Math.max(0, Math.floor(((filterLoHz - loHz) / SR) * N));
  const binHi = Math.min(N - 1, Math.ceil(((filterHiHz - loHz) / SR) * N));
  if (binHi <= binLo) return;

  // Sum linear power across passband bins (use RAW fft data, not specGain-adjusted)
  let powerSum = 0;
  const binCount = binHi - binLo + 1;
  for (let i = binLo; i <= binHi; i++) {
    const db = IQ.fftResult[i]; // raw dB from FFT (includes -70 calibration from runIQFFT)
    powerSum += Math.pow(10, db / 10);
  }

  // Average power per bin, then to dBm
  const avgDb = 10 * Math.log10((powerSum / binCount) + 1e-20);
  const dbm = Math.max(-140, Math.min(0, avgDb + smCal));

  updateSmeter(dbm, 'iq');
}

// Fallback: derive signal level from audio RMS energy
let _smTimeBuf = null;
function smeterFromAudio() {
  if (!S.analyser || !S.rxOn || S.mox) return;
  const bufLen = S.analyser.fftSize;
  if (!_smTimeBuf || _smTimeBuf.length !== bufLen) _smTimeBuf = new Float32Array(bufLen);
  const data = _smTimeBuf;
  S.analyser.getFloatTimeDomainData(data);

  let sumSq = 0;
  for (let i = 0; i < bufLen; i++) sumSq += data[i] * data[i];
  const rms = Math.sqrt(sumSq / bufLen);
  const dbfs = rms > 1e-10 ? 20 * Math.log10(rms) : -100;
  const approxDbm = Math.max(-130, Math.min(-13, 1.3 * dbfs - 43));
  updateSmeter(approxDbm, 'audio');
}

function updateSmeter(dbm, source) {
  SM.dbm = dbm;
  SM.source = source || 'tci';

  // Smooth: fast attack, slow decay
  if (dbm > SM.smoothDbm) {
    SM.smoothDbm = dbm * 0.6 + SM.smoothDbm * 0.4;
  } else {
    SM.smoothDbm = dbm * 0.08 + SM.smoothDbm * 0.92;
  }

  // Peak hold (1.5s then decay)
  const now = Date.now();
  if (dbm > SM.peakDbm) {
    SM.peakDbm = dbm;
    SM.peakTime = now;
  } else if (now - SM.peakTime > 1500) {
    SM.peakDbm = SM.peakDbm * 0.97 + SM.smoothDbm * 0.03;
  }

  // Digital readout
  el('smDbm').textContent = dbm.toFixed(1) + ' dBm';
  el('smSunit').textContent = dbmToSunit(dbm);
  const srcLabels = { tci: 'tci signal', iq: 'iq passband', audio: 'audio estimate' };
  el('smSrc').textContent = srcLabels[source] || source;

  // Also update LED bar meter
  drawLedMeter(SM.smoothDbm);
}

// ── LED BAR METER (vintage CB style) ──
function drawLedMeter(dbm) {
  const cv = el('ledMeterC');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.offsetWidth || 200;
  const cssH = cv.offsetHeight || 32;
  if (cv.width !== cssW * dpr || cv.height !== cssH * dpr) {
    cv.width = cssW * dpr; cv.height = cssH * dpr;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = cssH;

  // Background
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  // Total segments: 14 green (S1-S9) + 6 orange/red (+10 to +60)
  const totalSegs = 20;
  const gap = 2;
  const segW = (W - (totalSegs - 1) * gap) / totalSegs;

  // Map dBm to number of lit segments (0-20)
  // S1=-121 → seg 0, S9=-73 → seg 13, S9+60=-13 → seg 19
  const norm = dbmToNorm(dbm);
  const litSegs = Math.round(norm * totalSegs);

  // Single clean bar per segment — no dual-row split
  const segH = H - 4;  // 2px breathing room top and bottom
  for (let i = 0; i < totalSegs; i++) {
    const x = i * (segW + gap);
    const isLit = i < litSegs;
    const isRed = i >= 14;
    const isOrange = i >= 12 && i < 14;

    if (isLit) {
      ctx.fillStyle = isRed ? '#f85149' : isOrange ? '#e3b341' : '#3fb950';
      ctx.shadowColor = isRed ? '#f8514966' : isOrange ? '#e3b34144' : '#3fb95044';
      ctx.shadowBlur = 5;
    } else {
      ctx.fillStyle = isRed ? '#3d1010' : isOrange ? '#2a1f0d' : '#0d2a0d';
      ctx.shadowBlur = 0;
    }
    ctx.fillRect(x, 2, segW, segH);
    ctx.shadowBlur = 0;
  }
}

// ── NETWORK THROUGHPUT ──
const NET = {
  rxBytes: 0, txBytes: 0,     // bytes this interval
  totalRx: 0, totalTx: 0,     // total since connect
  packets: 0,                  // total packets
  lastRxRate: 0, lastTxRate: 0,
  peakRate: 500000,            // auto-scaling max for bar (bytes/s)
  intervalId: null,
};

function startNetMonitor() {
  if (NET.intervalId) return;
  NET.totalRx = 0; NET.totalTx = 0; NET.packets = 0;
  NET.intervalId = setInterval(() => {
    NET.lastRxRate = NET.rxBytes;
    NET.lastTxRate = NET.txBytes;
    // Format rates
    const rxEl = el('netRx'), txEl = el('netTx');
    const totEl = el('netTotal'), pktEl = el('netPkts');
    const barEl = el('netBar');
    if (rxEl) rxEl.textContent = fmtRate(NET.lastRxRate);
    if (txEl) txEl.textContent = fmtRate(NET.lastTxRate);
    if (totEl) totEl.textContent = fmtBytes(NET.totalRx + NET.totalTx);
    if (pktEl) pktEl.textContent = NET.packets.toLocaleString();
    // Usage bar (auto-scaling)
    const total = NET.lastRxRate + NET.lastTxRate;
    if (total > NET.peakRate * 0.8) NET.peakRate = total * 1.5;
    if (barEl) barEl.style.width = Math.min(100, (total / NET.peakRate) * 100).toFixed(1) + '%';
    NET.rxBytes = 0;
    NET.txBytes = 0;
  }, 1000);
}

function stopNetMonitor() {
  if (NET.intervalId) { clearInterval(NET.intervalId); NET.intervalId = null; }
}

function netRx(bytes) { NET.rxBytes += bytes; NET.totalRx += bytes; NET.packets++; }
function netTx(bytes) { NET.txBytes += bytes; NET.totalTx += bytes; }

function fmtRate(bps) {
  if (bps > 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  if (bps > 1024) return (bps / 1024).toFixed(0) + ' kB/s';
  return bps + ' B/s';
}
function fmtBytes(b) {
  if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b > 1024) return (b / 1024).toFixed(0) + ' kB';
  return b + ' B';
}

// ── S-Meter canvas drawing — classic analog style ──
let smRAF;
function drawSmeter() {
  // Always reschedule first so a drawing error can't kill the loop
  smRAF = requestAnimationFrame(drawSmeter);

  const cv = el('smeterC');
  // Skip if canvas is hidden (e.g. panel collapsed) or has zero dimensions
  if (!cv || cv.offsetWidth === 0 || cv.offsetHeight === 0) return;

  try {
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.offsetWidth || 200;
  const cssH = cv.offsetHeight || 105;
  if (cv.width !== cssW * dpr || cv.height !== cssH * dpr) {
    cv.width = cssW * dpr;
    cv.height = cssH * dpr;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = cssH;

  // ── Meter face — warm cream with rounded bezel ──
  // Outer bezel
  ctx.fillStyle = '#1c2128';
  ctx.fillRect(0, 0, W, H);

  // Inner cream face with rounded corners
  const bz = 3; // bezel width
  const rr = 6; // corner radius
  const faceGrad = ctx.createLinearGradient(0, 0, 0, H);
  faceGrad.addColorStop(0,   '#f2e8d5');
  faceGrad.addColorStop(0.3, '#f7efde');
  faceGrad.addColorStop(0.7, '#efe5d0');
  faceGrad.addColorStop(1,   '#e2d6c0');
  ctx.fillStyle = faceGrad;
  ctx.beginPath();
  ctx.moveTo(bz + rr, bz);
  ctx.lineTo(W - bz - rr, bz); ctx.arcTo(W - bz, bz, W - bz, bz + rr, rr);
  ctx.lineTo(W - bz, H - bz - rr); ctx.arcTo(W - bz, H - bz, W - bz - rr, H - bz, rr);
  ctx.lineTo(bz + rr, H - bz); ctx.arcTo(bz, H - bz, bz, H - bz - rr, rr);
  ctx.lineTo(bz, bz + rr); ctx.arcTo(bz, bz, bz + rr, bz, rr);
  ctx.closePath();
  ctx.fill();

  // Subtle inner highlight (top edge shine)
  ctx.strokeStyle = '#faf4e8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bz + rr, bz + 1);
  ctx.lineTo(W - bz - rr, bz + 1);
  ctx.stroke();

  // ── Compute arc geometry — very wide flat arc ──
  const sweepDeg = 53;
  const sweepRad = sweepDeg * Math.PI / 180;
  const pad = 28;       // more padding for full label visibility
  const cx = W / 2;
  const R = (cx - pad) / Math.sin(sweepRad);
  const arcTopY = 34;   // top margin
  const cy = arcTopY + R;
  const arcStart = Math.PI * 1.5 - sweepRad;
  const arcEnd   = Math.PI * 1.5 + sweepRad;
  const arcRange = arcEnd - arcStart;

  // S9 sits at fraction 8/12 of the full sweep
  const s9frac = 8 / 12;
  const s9angle = arcStart + s9frac * arcRange;

  // ── Scale arcs ──
  // Main arc — black up to S9
  ctx.beginPath();
  ctx.arc(cx, cy, R, arcStart, s9angle);
  ctx.strokeStyle = '#1a1208';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Main arc — red above S9
  ctx.beginPath();
  ctx.arc(cx, cy, R, s9angle, arcEnd);
  ctx.strokeStyle = '#cc2020';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // ── Tick marks ──
  // S-scale: major ticks at S1–S9, minor ticks between
  for (let i = 0; i < 12; i++) {
    const frac = i / 12;
    const a = arcStart + frac * arcRange;
    const isMajor = true; // every S-unit is a major tick
    const isRed = i >= 9;

    // Major tick
    const outerTick = R + 2;
    const innerTick = R - (i <= 8 ? 11 : 10);
    const ox = cx + outerTick * Math.cos(a);
    const oy = cy + outerTick * Math.sin(a);
    const ix = cx + innerTick * Math.cos(a);
    const iy = cy + innerTick * Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ix, iy);
    ctx.strokeStyle = isRed ? '#cc2020' : '#1a1208';
    ctx.lineWidth = isRed ? 1.8 : 1.5;
    ctx.stroke();

    // Minor ticks (halfway between majors)
    if (i < 11) {
      const mFrac = (i + 0.5) / 12;
      const mA = arcStart + mFrac * arcRange;
      const mIsRed = mFrac > s9frac;
      const mOuter = R + 1;
      const mInner = R - 6;
      ctx.beginPath();
      ctx.moveTo(cx + mOuter * Math.cos(mA), cy + mOuter * Math.sin(mA));
      ctx.lineTo(cx + mInner * Math.cos(mA), cy + mInner * Math.sin(mA));
      ctx.strokeStyle = mIsRed ? '#cc202088' : '#1a1208aa';
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // Quarter ticks for finer graduation
      for (const q of [0.25, 0.75]) {
        const qFrac = (i + q) / 12;
        const qA = arcStart + qFrac * arcRange;
        const qIsRed = qFrac > s9frac;
        ctx.beginPath();
        ctx.moveTo(cx + (R + 0.5) * Math.cos(qA), cy + (R + 0.5) * Math.sin(qA));
        ctx.lineTo(cx + (R - 4) * Math.cos(qA),   cy + (R - 4) * Math.sin(qA));
        ctx.strokeStyle = qIsRed ? '#cc202055' : '#1a120855';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }
  }

  // ── Labels ──
  // S-unit numbers: 1 through 9
  const labelR = R + 15;
  for (let i = 1; i <= 9; i++) {
    const frac = (i - 1) / 12;
    const a = arcStart + frac * arcRange;
    const lx = cx + labelR * Math.cos(a);
    const ly = cy + labelR * Math.sin(a);
    ctx.font = 'bold 13px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1a1208';
    ctx.fillText(String(i), lx, ly);
  }

  // dB labels: +20, +40, +60
  const dbLabels = [
    { frac: 9/12,  label: '+20' },
    { frac: 10/12, label: '+40' },
    { frac: 11/12, label: '+60' },
  ];
  dbLabels.forEach(d => {
    const a = arcStart + d.frac * arcRange;
    const lx = cx + (labelR + 2) * Math.cos(a);
    const ly = cy + (labelR + 2) * Math.sin(a);
    ctx.font = 'bold 11px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#cc2020';
    ctx.fillText(d.label, lx, ly);
  });

  // "S" label — left of scale
  const sLabelA = arcStart - 0.065;
  ctx.font = 'bold 16px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1a1208';
  ctx.fillText('S', cx + (labelR + 2) * Math.cos(sLabelA), cy + (labelR + 2) * Math.sin(sLabelA));

  // "dB" label — right of scale
  const dbA = arcEnd + 0.06;
  ctx.font = 'bold 11px Georgia, "Times New Roman", serif';
  ctx.fillStyle = '#cc2020';
  ctx.fillText('dB', cx + (labelR + 2) * Math.cos(dbA), cy + (labelR + 2) * Math.sin(dbA));

  // ── Decorative PO (Power Output) scale ──
  const poR = R - 18;
  // PO arc line
  ctx.beginPath();
  ctx.arc(cx, cy, poR, arcStart, arcEnd);
  ctx.strokeStyle = '#5a7a4a';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // PO scale: non-linear watts (0 → 25W mapped across the full arc)
  const poMarks = [
    { frac: 0,     label: '0' },
    { frac: 0.15,  label: '0.8' },
    { frac: 0.25,  label: '1.5' },
    { frac: 0.42,  label: '5' },
    { frac: 0.53,  label: '7.5' },
    { frac: 0.70,  label: '15' },
    { frac: 0.85,  label: '25W' },
  ];
  poMarks.forEach(p => {
    const a = arcStart + p.frac * arcRange;
    ctx.beginPath();
    ctx.moveTo(cx + (poR + 1) * Math.cos(a), cy + (poR + 1) * Math.sin(a));
    ctx.lineTo(cx + (poR - 5) * Math.cos(a), cy + (poR - 5) * Math.sin(a));
    ctx.strokeStyle = '#5a7a4a';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    const lr = poR - 8;
    ctx.font = '7px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#5a7a4a';
    ctx.fillText(p.label, cx + lr * Math.cos(a), cy + lr * Math.sin(a));
  });
  // "PO" label
  const poLabelA = arcStart - 0.06;
  ctx.font = 'bold 8px Georgia, serif';
  ctx.fillStyle = '#5a7a4a';
  ctx.fillText('PO', cx + (poR - 8) * Math.cos(poLabelA), cy + (poR - 8) * Math.sin(poLabelA));

  // ── Decorative SWR scale ──
  const swrR = R - 34;
  // SWR arc line
  ctx.beginPath();
  ctx.arc(cx, cy, swrR, arcStart, arcEnd);
  ctx.strokeStyle = '#cc2020aa';
  ctx.lineWidth = 0.7;
  ctx.stroke();

  // SWR scale: non-linear (1 → ∞ mapped across the arc)
  const swrMarks = [
    { frac: 0,    label: '1' },
    { frac: 0.25, label: '1.5' },
    { frac: 0.42, label: '2' },
    { frac: 0.60, label: '3' },
    { frac: 0.78, label: '5' },
    { frac: 1.0,  label: '∞' },
  ];
  swrMarks.forEach(p => {
    const a = arcStart + p.frac * arcRange;
    ctx.beginPath();
    ctx.moveTo(cx + (swrR + 1) * Math.cos(a), cy + (swrR + 1) * Math.sin(a));
    ctx.lineTo(cx + (swrR - 4) * Math.cos(a), cy + (swrR - 4) * Math.sin(a));
    ctx.strokeStyle = '#cc2020aa';
    ctx.lineWidth = 0.7;
    ctx.stroke();
    const lr = swrR - 7;
    ctx.font = '7px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#cc2020';
    ctx.fillText(p.label, cx + lr * Math.cos(a), cy + lr * Math.sin(a));
  });
  // "SWR" label
  const swrLabelA = arcStart - 0.06;
  ctx.font = 'bold 7px Georgia, serif';
  ctx.fillStyle = '#cc2020';
  ctx.fillText('SWR', cx + (swrR - 7) * Math.cos(swrLabelA), cy + (swrR - 7) * Math.sin(swrLabelA));

  // ── Needle ──
  // When transmitting: needle shows TX power on PO scale; else: RX signal strength
  function txWattsToFrac(w) {
    const po = [{w:0,f:0},{w:0.8,f:0.15},{w:1.5,f:0.25},{w:5,f:0.42},{w:7.5,f:0.53},{w:15,f:0.70},{w:25,f:0.85},{w:100,f:1.0}];
    if (w <= 0) return 0;
    for (let i = 1; i < po.length; i++) {
      if (w <= po[i].w) { const t=(w-po[i-1].w)/(po[i].w-po[i-1].w); return po[i-1].f+t*(po[i].f-po[i-1].f); }
    }
    return 1.0;
  }
  function swrToFrac(s) {
    const sw = [{s:1,f:0},{s:1.5,f:0.25},{s:2,f:0.42},{s:3,f:0.60},{s:5,f:0.78},{s:100,f:1.0}];
    if (s <= 1) return 0;
    for (let i = 1; i < sw.length; i++) {
      if (s <= sw[i].s) { const t=(s-sw[i-1].s)/(sw[i].s-sw[i-1].s); return sw[i-1].f+t*(sw[i].f-sw[i-1].f); }
    }
    return 1.0;
  }
  // Show TX power during PTT or TUNE; show RX signal otherwise
  const isTx = S.mox || S.tune;
  const needleNorm = isTx ? txWattsToFrac(SM.txWatts) : dbmToNorm(SM.smoothDbm);
  const needleActive = isTx ? true : SM.dbm !== null;
  const needleAngle = arcStart + needleNorm * arcRange;
  const needleTipR = R + 5;
  const needleTailR = 20;

  // ── SWR indicator (small triangle on SWR arc, TX only) ──
  if (isTx && SM.swr > 1.0) {
    const sf = swrToFrac(SM.swr);
    const sa = arcStart + sf * arcRange;
    const sArrow = swrR - 2;
    const stx = cx + sArrow * Math.cos(sa), sty = cy + sArrow * Math.sin(sa);
    const sp = sa + Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(stx, sty);
    ctx.lineTo(stx - 5*Math.cos(sa) + 2*Math.cos(sp), sty - 5*Math.sin(sa) + 2*Math.sin(sp));
    ctx.lineTo(stx - 5*Math.cos(sa) - 2*Math.cos(sp), sty - 5*Math.sin(sa) - 2*Math.sin(sp));
    ctx.closePath();
    ctx.fillStyle = '#f85149';
    ctx.fill();
  }

  if (needleActive) {
    const tipX  = cx + needleTipR * Math.cos(needleAngle);
    const tipY  = cy + needleTipR * Math.sin(needleAngle);
    const tailX = cx - needleTailR * Math.cos(needleAngle);
    const tailY = cy - needleTailR * Math.sin(needleAngle);

    // Needle shadow
    ctx.save();
    ctx.translate(1, 2);
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // Needle body — black
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = '#1a1208';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Red tip portion (last 40%)
    const redR = needleTipR * 0.5;
    const redX = cx + redR * Math.cos(needleAngle);
    const redY = cy + redR * Math.sin(needleAngle);
    ctx.beginPath();
    ctx.moveTo(redX, redY);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = '#cc2020';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Needle tip arrow/triangle
    const triSize = 3;
    const perpAngle = needleAngle + Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 8 * Math.cos(needleAngle) + triSize * Math.cos(perpAngle),
               tipY - 8 * Math.sin(needleAngle) + triSize * Math.sin(perpAngle));
    ctx.lineTo(tipX - 8 * Math.cos(needleAngle) - triSize * Math.cos(perpAngle),
               tipY - 8 * Math.sin(needleAngle) - triSize * Math.sin(perpAngle));
    ctx.closePath();
    ctx.fillStyle = '#cc2020';
    ctx.fill();
  } else {
    // Resting needle at far left
    const restAngle = arcStart - 0.04;
    const tipX = cx + needleTipR * Math.cos(restAngle);
    const tipY = cy + needleTipR * Math.sin(restAngle);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = '#1a120844';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Pivot hub (drawn but mostly hidden below canvas)
  ctx.save();
  ctx.beginPath();
  ctx.rect(bz, bz, W - bz*2, H - bz*2);
  ctx.clip();
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#2c2418';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#d4c8b0';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = '#888070';
  ctx.fill();
  ctx.restore();

  // ── Bottom label area ──
  ctx.fillStyle = '#1c212899';
  ctx.fillRect(bz, H - bz - 10, W - bz*2, 10);
  ctx.font = '7px Georgia, serif';
  ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'center';
  ctx.fillText(isTx ? (S.tune ? 'TUNE  POWER' : 'TX  POWER') : 'THETIS  TCI', W / 2, H - bz - 2);

  // ── Mic level bar ──
  (function() {
    const wrap = el('micLvlWrap'), bar = el('micLvlBar');
    if (!wrap || !bar) return;
    if (!S.txMicOn || !S.txAnalyser) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    const bins = S.txAnalyser.frequencyBinCount;
    if (!drawSmeter._micBuf || drawSmeter._micBuf.length !== bins) {
      drawSmeter._micBuf = new Uint8Array(bins);
    }
    const data = drawSmeter._micBuf;
    S.txAnalyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i] - 128) / 128; if (v > peak) peak = v; }
    bar.style.width = Math.min(100, peak * 100).toFixed(1) + '%';
  })();

  } catch(e) {
    // Swallow drawing errors — the RAF is already scheduled above so the loop continues
  }
}

// ── IQ PANADAPTER ENGINE ──
const IQ = {
  FFT_SIZE: 4096,
  bufI: null, bufQ: null,  // accumulation buffers
  pos: 0,                  // write position in buffer
  fftResult: null,         // Float32Array of dB magnitudes, length FFT_SIZE
  fftReady: false,
  window: null,            // Blackman-Harris window
  frameCount: 0,
  smooth: 0.95,            // FFT smoothing (0=no smoothing, 0.99=very slow)
};

// Pre-compute Blackman-Harris window
function initIQ() {
  const N = IQ.FFT_SIZE;
  IQ.bufI = new Float32Array(N);
  IQ.bufQ = new Float32Array(N);
  IQ.fftResult = new Float32Array(N);
  IQ.window = new Float32Array(N);
  // Pre-allocated FFT scratch buffers — reused every runIQFFT() call to avoid
  // ~1.5 MB/s of GC pressure at 192 kHz / 47 FFTs per second.
  IQ._re = new Float32Array(N);
  IQ._im = new Float32Array(N);
  const prev = new Float32Array(N); // for smoothing
  IQ._prev = prev;
  for (let i = 0; i < N; i++) {
    const x = 2 * Math.PI * i / (N - 1);
    IQ.window[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2*x) - 0.01168 * Math.cos(3*x);
  }
  IQ._prev.fill(-140);
}
initIQ();

// ── Radix-2 in-place FFT (Cooley-Tukey) ──
// re[], im[] are modified in place, length must be power of 2
function fft(re, im) {
  const N = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // FFT butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const a = i + j, b = a + halfLen;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe;  im[b] = im[a] - tIm;
        re[a] += tRe;          im[a] += tIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

// ── Handle incoming IQ frame (64-byte header + float32 I/Q pairs) ──
function handleIQFrame(buf) {
  const HEADER = 64;
  if (buf.byteLength <= HEADER) return;

  // Extract sample rate from header
  const dv = new DataView(buf);
  const sr = dv.getUint32(4, true);
  if (sr > 0 && sr <= 1000000) S.iqSR = sr;

  const payloadBytes = buf.byteLength - HEADER;
  const floatCount = Math.floor(payloadBytes / 4);
  const pairCount = Math.floor(floatCount / 2);  // I/Q pairs
  if (pairCount < 1) return;

  const floats = new Float32Array(buf, HEADER, floatCount);
  const N = IQ.FFT_SIZE;

  // Accumulate I/Q pairs into buffer
  for (let i = 0; i < pairCount; i++) {
    IQ.bufI[IQ.pos] = floats[i * 2];
    IQ.bufQ[IQ.pos] = floats[i * 2 + 1];
    IQ.pos++;
    if (IQ.pos >= N) {
      IQ.pos = 0;
      runIQFFT();
    }
  }
  IQ.frameCount++;
}

function runIQFFT() {
  const N = IQ.FFT_SIZE;
  // Reuse pre-allocated scratch buffers (initIQ allocates once)
  const re = IQ._re;
  const im = IQ._im;
  for (let i = 0; i < N; i++) {
    re[i] = IQ.bufI[i] * IQ.window[i];
    im[i] = IQ.bufQ[i] * IQ.window[i];
  }

  // Run FFT
  fft(re, im);

  // Compute magnitude in dB and rearrange (FFT shift: move DC to center)
  const half = N >> 1;
  for (let i = 0; i < N; i++) {
    const idx = (i + half) % N;  // FFT shift
    const mag = re[idx] * re[idx] + im[idx] * im[idx];
    const db = mag > 1e-20 ? 10 * Math.log10(mag) - 70 : -150;  // scale to ~dBm
    // Smooth with previous frame
    IQ.fftResult[i] = IQ._prev[i] * IQ.smooth + db * (1 - IQ.smooth);
    IQ._prev[i] = IQ.fftResult[i];
  }
  IQ.fftReady = true;
}

// Start/stop IQ from UI
function startIQ() {
  if (S.iqOn) return;
  send('iq_samplerate:192000;');
  send('iq_start:0;');
  S.iqOn = true;
}
function stopIQ() {
  if (!S.iqOn) return;
  send('iq_stop:0;');
  S.iqOn = false;
  IQ.fftReady = false;
}

// ── UTC CLOCK ──
(function() {
  function tick() {
    const now = new Date();
    const h = now.getUTCHours().toString().padStart(2,'0');
    const m = now.getUTCMinutes().toString().padStart(2,'0');
    const s = now.getUTCSeconds().toString().padStart(2,'0');
    const clk = el('utcClock');
    if (clk) clk.textContent = h + ':' + m + ':' + s + ' UTC';
  }
  tick();
  setInterval(tick, 1000);
})();

// ── MODAL HELPERS ──
function openModal(id) { const m = el(id); if (m) { m.classList.remove('hidden'); if (id === 'settingsModal') loadSettingsUI(); if (id === 'memModal') renderMemModalList(); if (id === 'diagModal') refreshDiagnostics(); } }
function closeModal(id) {
  const m = el(id);
  if (m) m.classList.add('hidden');
  // After closing Settings, ensure the smeter poll and draw loop are still running.
  // Defensive guard: the poll can be disrupted if applyPanelVisibility briefly
  // collapses the smeter canvas, and the RAF guard (offsetWidth===0) keeps it paused.
  if (id === 'settingsModal') {
    if (S.connected && !SM.pollId) startSmeterPoll();
    if (!smRAF) drawSmeter();
  }
}
function refreshDiagnostics() {
  const d = getDiagnostics();
  const summary = el('diagSummary');
  if (summary) {
    const item = (label, value, ok) => '<div style="background:#161b22;border:1px solid #30363d;border-radius:5px;padding:7px 9px;"><div style="font-size:9px;color:#7d8590;text-transform:uppercase;">' + escHtml(label) + '</div><div style="font-family:\'SF Mono\',monospace;color:' + (ok ? '#3fb950' : '#e3b341') + ';">' + escHtml(value) + '</div></div>';
    summary.innerHTML =
      item('Connection', d.websocketState, d.connected) +
      item('Secure Context', d.secureContext ? 'yes' : 'no', d.secureContext) +
      item('Mic API', d.mediaDevices ? 'modern' : (d.legacyGetUserMedia ? 'legacy' : 'missing'), d.mediaDevices || d.legacyGetUserMedia) +
      item('IQ Frames', String(d.iqFrames), d.iqFrames > 0);
  }
  const text = el('diagText');
  if (text) text.value = JSON.stringify(d, null, 2);
}

function copyDiagnostics() {
  refreshDiagnostics();
  const text = el('diagText');
  if (!text) return;
  navigator.clipboard.writeText(text.value).catch(() => {
    text.select();
    document.execCommand('copy');
  });
  log('sys', 'Diagnostics copied');
}

function runStartupChecks() {
  const secure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure) log('err', 'Mic warning: TX audio requires https:// or localhost');
  if (!(window.AudioContext || window.webkitAudioContext)) log('err', 'Browser warning: Web Audio API unavailable');
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
      !(navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia)) {
    log('err', 'Browser warning: microphone capture API unavailable');
  }
}

function attachSpectrumHoverReadout() {
  const cv = el('specC');
  const box = el('specHover');
  if (!cv || !box) return;
  cv.addEventListener('mousemove', e => {
    if (!S.iqOn || !IQ.fftReady) { box.style.display = 'none'; return; }
    const rect = cv.getBoundingClientRect();
    const xFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const SR = S.iqSR || 192000;
    const vSR = SR / specZoom;
    const vLo = (specZoomCentre || S.iqCentre) - vSR / 2;
    const hz = vLo + xFrac * vSR;
    const offset = hz - S.vfoA;
    box.textContent = (hz / 1e6).toFixed(5) + ' MHz  ' + (offset >= 0 ? '+' : '') + Math.round(offset) + ' Hz';
    box.style.display = 'block';
    box.style.left = Math.min(rect.width - 165, Math.max(4, e.clientX - rect.left + 12)) + 'px';
    box.style.top = Math.max(4, e.clientY - rect.top + 12) + 'px';
  });
  cv.addEventListener('mouseleave', () => { box.style.display = 'none'; });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['settingsModal','keysModal','memModal','diagModal'].forEach(id => closeModal(id));
  }
});

// ── SPECTRUM CANVAS ──
let specRAF;
let DB_MIN = -140, DB_MAX = -30; // dBm range — adjustable via settings
let specGain = -5; // dB offset adjusted by slider
let specZoom = 1;        // 1 = full IQ span, 2/4/8/16/32 = zoomed in
let specZoomCentre = 0;  // Hz at centre of zoom view (0 = auto)
let peakHoldEnabled = false;
let peakHoldBuf = null;  // Float32Array per-pixel peak values
let wfTheme = 0;         // 0=classic 1=heat 2=gray 3=night

function drawSpec() {
  const cv = el('specC'); if (!cv) return;
  const W = cv.width || cv.parentElement.offsetWidth;
  const H = cv.height || cv.parentElement.offsetHeight;
  const ctx = cv.getContext('2d');

  // Background
  ctx.fillStyle = '#010409';
  ctx.fillRect(0, 0, W, H);

  // Greyline propagation map overlay
  if (window._greylineImg) {
    const cfg = getSettings();
    const opacity = Math.max(0.1, Math.min(1.0, (cfg.greylineOpacity || 80) / 100));
    ctx.globalAlpha = opacity;
    ctx.drawImage(window._greylineImg, 0, 0, W, H);
    ctx.globalAlpha = 1.0;
  }

  const useIQ = S.iqOn && IQ.fftReady;
  const activeAnalyser = (S.mox && S.txAnalyser) ? S.txAnalyser : S.analyser;

  if (!S.connected || (!useIQ && !activeAnalyser) || (!useIQ && !S.rxOn && !S.mox)) {
    ctx.fillStyle = '#21262d';
    ctx.font = '11px SF Mono, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(S.connected ? 'Waiting for IQ data…' : 'Connect to Thetis to activate panadapter', W/2, H/2);
    specRAF = requestAnimationFrame(drawSpec);
    return;
  }

  const dbRange = DB_MAX - DB_MIN;

  if (useIQ) {
    // ═══ IQ PANADAPTER MODE ═══
    const N = IQ.FFT_SIZE;
    const SR = S.iqSR || 192000;
    const centreHz = S.iqCentre;
    const loHz = centreHz - SR / 2;
    const hiHz = centreHz + SR / 2;

    // Map Hz to raw FFT bin (always full SR)
    const hzToBin = (hz) => Math.round(((hz - loHz) / SR) * N);

    // ── Zoom: compute visible Hz range ──
    if (specZoom <= 1) { specZoom = 1; specZoomCentre = centreHz; }
    else {
      // Clamp zoom centre inside IQ window
      const vSR2 = SR / specZoom;
      specZoomCentre = Math.max(loHz + vSR2 / 2, Math.min(hiHz - vSR2 / 2, specZoomCentre || centreHz));
    }
    const visibleSR  = SR / specZoom;
    const visLoHz    = specZoomCentre - visibleSR / 2;
    const visHiHz    = specZoomCentre + visibleSR / 2;

    // Map Hz to x pixel — always uses zoomed view
    const hzToX = (hz) => ((hz - visLoHz) / visibleSR) * W;
    // Map pixel column to FFT bin via zoomed frequency
    const pxToBin = (px) => {
      const hz = visLoHz + (px / W) * visibleSR;
      return Math.max(0, Math.min(N - 1, Math.round(((hz - loHz) / SR) * N)));
    };

    // ── dB grid lines ──
    ctx.strokeStyle = '#0d1820'; ctx.lineWidth = 0.5;
    ctx.font = '8px SF Mono, Consolas, monospace';
    ctx.textAlign = 'left';
    for (let db = -130; db <= -30; db += 10) {
      const y = H * (1 - (db - DB_MIN) / dbRange);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = '#3d444d';
      if (y > 22 && y < H - 20) ctx.fillText(db + ' dBm', 3, y - 2);
    }

    // ── Ham band edges ──
    for (const band of BAND_RANGES) {
      const bx1 = hzToX(band.lo), bx2 = hzToX(band.hi);
      if (bx2 < 0 || bx1 > W) continue;
      const cx1 = Math.max(0, bx1), cx2 = Math.min(W, bx2);
      // Subtle fill
      ctx.fillStyle = 'rgba(63,185,80,0.06)';
      ctx.fillRect(cx1, 20, cx2 - cx1, H - 40);
      // Edge lines
      ctx.setLineDash([3, 3]); ctx.lineWidth = 0.8;
      if (bx1 >= 0 && bx1 <= W) {
        ctx.strokeStyle = '#3fb95060';
        ctx.beginPath(); ctx.moveTo(bx1, 20); ctx.lineTo(bx1, H - 20); ctx.stroke();
      }
      if (bx2 >= 0 && bx2 <= W) {
        ctx.strokeStyle = '#3fb95060';
        ctx.beginPath(); ctx.moveTo(bx2, 20); ctx.lineTo(bx2, H - 20); ctx.stroke();
      }
      ctx.setLineDash([]);
      // Band name label near top
      ctx.font = 'bold 9px SF Mono, Consolas, monospace';
      ctx.fillStyle = '#3fb95099';
      ctx.textAlign = 'center';
      const labelX = Math.max(cx1 + 12, Math.min(cx2 - 12, (cx1 + cx2) / 2));
      ctx.fillText(band.band, labelX, 28);
    }

    // ── Frequency grid + top & bottom labels ──
    const stepHz = visibleSR > 100000 ? 20000 : visibleSR > 40000 ? 10000 : visibleSR > 10000 ? 2000 : visibleSR > 3000 ? 500 : 100;
    const firstGrid = Math.ceil(visLoHz / stepHz) * stepHz;
    // Background strips top and bottom
    ctx.fillStyle = 'rgba(1,4,9,0.85)';
    ctx.fillRect(0, 0, W, 20);
    ctx.fillRect(0, H - 20, W, 20);
    ctx.textAlign = 'center';
    for (let f = firstGrid; f <= visHiHz; f += stepHz) {
      const x = hzToX(f);
      const isMajor = f % (stepHz * 5) === 0 || f % 100000 === 0;
      ctx.strokeStyle = isMajor ? '#1a2a3a' : '#0d1820';
      ctx.lineWidth = isMajor ? 0.8 : 0.5;
      ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, H - 20); ctx.stroke();
      const label = (f / 1e6).toFixed(stepHz < 1000 ? 4 : 3);
      ctx.font = 'bold 14px SF Mono, Consolas, monospace';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x, H - 5);   // bottom
      ctx.fillText(label, x, 14);      // top
    }

    // ── Filter passband overlay ──
    const flo = parseInt(el('flo')?.value) || 100;
    const fhi = parseInt(el('fhi')?.value) || 2900;
    const filterLoHz = S.vfoA + Math.min(flo, fhi);
    const filterHiHz = S.vfoA + Math.max(flo, fhi);
    const xFlo = hzToX(filterLoHz);
    const xFhi = hzToX(filterHiHz);

    // Shade outside passband
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, xFlo, H);
    ctx.fillRect(xFhi, 0, W - xFhi, H);

    // Passband tint
    ctx.fillStyle = S.mox ? 'rgba(255,80,0,0.08)' : 'rgba(56,139,253,0.05)';
    ctx.fillRect(xFlo, 0, xFhi - xFlo, H);

    // Filter edge lines
    ctx.strokeStyle = S.mox ? '#ff5500cc' : '#e3b34199';
    ctx.lineWidth = S.mox ? 1.5 : 1;
    ctx.setLineDash([3, 3]);
    [xFlo, xFhi].forEach(x => { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); });
    ctx.setLineDash([]);

    // ── Spectrum fill ──
    ctx.beginPath();
    for (let px = 0; px < W; px++) {
      const bin = pxToBin(px);
      const db = Math.max(DB_MIN, Math.min(DB_MAX, IQ.fftResult[bin] + specGain));
      const y = H * (1 - (db - DB_MIN) / dbRange);
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(56,139,253,0.7)');
    grad.addColorStop(0.5, 'rgba(56,139,253,0.3)');
    grad.addColorStop(1, 'rgba(56,139,253,0.08)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Spectrum line
    ctx.beginPath();
    for (let px = 0; px < W; px++) {
      const bin = pxToBin(px);
      const db = Math.max(DB_MIN, Math.min(DB_MAX, IQ.fftResult[bin] + specGain));
      const y = H * (1 - (db - DB_MIN) / dbRange);
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.strokeStyle = specLineColor || '#58a6ff'; ctx.lineWidth = 1; ctx.stroke();

    // ── Peak hold trace ──
    if (peakHoldEnabled) {
      if (!peakHoldBuf || peakHoldBuf.length !== W) peakHoldBuf = new Float32Array(W).fill(DB_MIN);
      ctx.beginPath();
      for (let px = 0; px < W; px++) {
        const bin = pxToBin(px);
        const db = Math.max(DB_MIN, Math.min(DB_MAX, IQ.fftResult[bin] + specGain));
        peakHoldBuf[px] = db >= peakHoldBuf[px] ? db : Math.max(DB_MIN, peakHoldBuf[px] - 0.06);
        const y = H * (1 - (peakHoldBuf[px] - DB_MIN) / dbRange);
        px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
      }
      ctx.strokeStyle = '#e3b341bb'; ctx.lineWidth = 1; ctx.stroke();
    }

    // ── Digital mode markers ──
    drawDigMarkers(ctx, W, H, hzToX);

    // ── DX cluster overlay ──
    drawDXOverlay(ctx, W, H, hzToX);

    // ── VFO A cursor ──
    const vfoAx = hzToX(S.vfoA);
    if (vfoAx >= 0 && vfoAx <= W) {
      ctx.beginPath(); ctx.moveTo(vfoAx, 0); ctx.lineTo(vfoAx, H);
      ctx.strokeStyle = '#58a6ff88'; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = 'bold 10px SF Mono, Consolas, monospace';
      ctx.fillStyle = '#58a6ff';
      ctx.textAlign = 'left';
      ctx.fillText((S.vfoA / 1e6).toFixed(4) + ' MHz', vfoAx + 4, 28);
    }

    // ── VFO B cursor ──
    const vfoBx = hzToX(S.vfoB);
    if (vfoBx >= 0 && vfoBx <= W) {
      ctx.beginPath(); ctx.moveTo(vfoBx, 0); ctx.lineTo(vfoBx, H);
      ctx.strokeStyle = '#7d859055'; ctx.lineWidth = 1; ctx.setLineDash([2,2]); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '9px SF Mono, Consolas, monospace';
      ctx.fillStyle = '#7d8590';
      ctx.textAlign = 'left';
      ctx.fillText('B ' + (S.vfoB / 1e6).toFixed(4), vfoBx + 3, 38);
    }

    // ── Bandwidth indicator ──
    ctx.font = '9px SF Mono, Consolas, monospace';
    ctx.fillStyle = '#484f58';
    ctx.textAlign = 'right';
    const zStr = specZoom > 1 ? '  |  ' + specZoom + '× ZOOM  [dbl-click to reset]' : '';
    ctx.fillText('IQ ' + (SR/1000) + ' kHz  |  ' + N + '-pt FFT' + zStr, W - 6, 28);

  } else {
    // ═══ AUDIO FALLBACK (original behaviour) ═══
    const analyser = activeAnalyser;
    const bufLen = analyser.frequencyBinCount;
    if (!drawSpec._fBuf || drawSpec._fBuf.length !== bufLen) drawSpec._fBuf = new Float32Array(bufLen);
    const freqData = drawSpec._fBuf;
    analyser.getFloatFrequencyData(freqData);
    const hzPerBin = 48000 / analyser.fftSize;
    const flo = Math.abs(parseInt(el('flo')?.value) || 100);
    const fhi = Math.abs(parseInt(el('fhi')?.value) || 2900);
    const passBandHi = Math.max(flo, fhi);
    const displayMax = Math.max(4000, Math.ceil(passBandHi * 1.15 / 500) * 500);
    const maxBin = Math.min(bufLen - 1, Math.floor(displayMax / hzPerBin));

    // Simple audio spectrum line
    ctx.beginPath();
    for (let i = 0; i <= maxBin; i++) {
      const x = (i / maxBin) * W;
      const db = Math.max(DB_MIN, Math.min(DB_MAX, freqData[i] + specGain));
      const y = H * (1 - (db - DB_MIN) / dbRange);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const g2 = ctx.createLinearGradient(0, 0, 0, H);
    g2.addColorStop(0, 'rgba(56,139,253,0.5)');
    g2.addColorStop(1, 'rgba(56,139,253,0.02)');
    ctx.fillStyle = g2; ctx.fill();
    ctx.beginPath();
    for (let i = 0; i <= maxBin; i++) {
      const x = (i / maxBin) * W;
      const db = Math.max(DB_MIN, Math.min(DB_MAX, freqData[i] + specGain));
      const y = H * (1 - (db - DB_MIN) / dbRange);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = '9px SF Mono, Consolas, monospace';
    ctx.fillStyle = '#484f58'; ctx.textAlign = 'right';
    ctx.fillText('Audio FFT (no IQ)', W - 6, 12);
  }

  specRAF = requestAnimationFrame(drawSpec);
}

// ── WATERFALL ──
let wfRAF, wfImg=null;
let wfFrameSkip = 0;
let wfSpeed = 10;
let wfColorCacheTheme = -1;
let wfColorCache = null;

function drawWF() {
  const cv=el('wfC'); if (!cv) return;
  const W=cv.parentElement.offsetWidth, H=cv.parentElement.offsetHeight;
  if (cv.width!==W||cv.height!==H) { cv.width=W; cv.height=H; wfImg=null; }
  const ctx=cv.getContext('2d');

  const useIQ = S.iqOn && IQ.fftReady;
  const activeAnalyser = (S.mox && S.txAnalyser) ? S.txAnalyser : S.analyser;

  if (!S.connected || (!useIQ && (!activeAnalyser || (!S.rxOn && !S.mox)))) {
    ctx.fillStyle='#010409'; ctx.fillRect(0,0,W,H);
    wfRAF=requestAnimationFrame(drawWF); return;
  }

  wfFrameSkip = (wfFrameSkip + 1) % wfSpeed;
  if (wfFrameSkip !== 0) { wfRAF=requestAnimationFrame(drawWF); return; }

  if (!wfImg) {
    wfImg=ctx.createImageData(W,H);
    const d=wfImg.data;
    for (let i=0;i<d.length;i+=4){d[i]=1;d[i+1]=4;d[i+2]=9;d[i+3]=255;}
  }

  // Scroll down
  const d = wfImg.data;
  d.copyWithin(W*4, 0, W*(H-1)*4);

  const dbRange = DB_MAX - DB_MIN;

  if (useIQ) {
    // IQ waterfall row
    const N = IQ.FFT_SIZE;
    for (let x = 0; x < W; x++) {
      const bin = Math.round((x / W) * N);
      const db = Math.max(DB_MIN, Math.min(DB_MAX, (bin >= 0 && bin < N ? IQ.fftResult[bin] : -150) + specGain));
      const t = (db - DB_MIN) / dbRange;
      const [r,g,b] = wfColFast(t);
      const idx = x * 4;
      d[idx]=r; d[idx+1]=g; d[idx+2]=b; d[idx+3]=255;
    }
  } else {
    // Audio fallback waterfall row
    const analyser = activeAnalyser;
    const bufLen = analyser.frequencyBinCount;
    if (!drawWF._fBuf || drawWF._fBuf.length !== bufLen) drawWF._fBuf = new Float32Array(bufLen);
    const freqData = drawWF._fBuf;
    analyser.getFloatFrequencyData(freqData);
    const hzPerBin = 48000 / analyser.fftSize;
    const fhi = Math.abs(parseInt(el('fhi')?.value) || 2900);
    const displayMax = Math.max(4000, Math.ceil(fhi * 1.15 / 500) * 500);
    const maxBin = Math.min(bufLen - 1, Math.floor(displayMax / hzPerBin));
    for (let x = 0; x < W; x++) {
      const bin = Math.min(maxBin, Math.round((x / W) * maxBin));
      const db = Math.max(DB_MIN, Math.min(DB_MAX, freqData[bin] + specGain));
      const t = (db - DB_MIN) / dbRange;
      const [r,g,b] = wfColFast(t);
      const idx = x * 4;
      d[idx]=r; d[idx+1]=g; d[idx+2]=b; d[idx+3]=255;
    }
  }
  ctx.putImageData(wfImg, 0, 0);

  // VFO marker lines on waterfall
  if (useIQ) {
    const SR = S.iqSR || 192000;
    const loHz = S.iqCentre - SR / 2;
    const hzToX = (hz) => ((hz - loHz) / SR) * W;

    // Filter edges
    const flo = parseInt(el('flo')?.value) || 100;
    const fhi2 = parseInt(el('fhi')?.value) || 2900;
    const xFlo = hzToX(S.vfoA + Math.min(flo, fhi2));
    const xFhi = hzToX(S.vfoA + Math.max(flo, fhi2));
    ctx.strokeStyle = S.mox ? '#ff550066' : '#e3b34144';
    ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    [xFlo, xFhi].forEach(x => { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); });
    ctx.setLineDash([]);

    // VFO A line
    const vx = hzToX(S.vfoA);
    ctx.strokeStyle = '#58a6ff44'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(vx,0); ctx.lineTo(vx,H); ctx.stroke();
  }

  wfRAF=requestAnimationFrame(drawWF);
}

function wfCol(t) {
  switch (wfTheme) {
    case 1: // heat: black → dark red → red → orange → yellow → white
      if (t < 0.25) { const s=t/0.25;       return [Math.round(s*180), 0, 0]; }
      if (t < 0.5)  { const s=(t-0.25)/0.25; return [Math.round(180+s*75), Math.round(s*100), 0]; }
      if (t < 0.75) { const s=(t-0.5)/0.25;  return [255, Math.round(100+s*155), 0]; }
      { const s=(t-0.75)/0.25; return [255, 255, Math.round(s*255)]; }
    case 2: // grayscale: black → white
      { const v=Math.round(t*255); return [v, v, v]; }
    case 3: // night: black → dark green → bright green → yellow-green
      if (t < 0.4) { const s=t/0.4;         return [0, Math.round(s*210), 0]; }
      if (t < 0.75) { const s=(t-0.4)/0.35;  return [Math.round(s*80), Math.round(210+s*45), 0]; }
      { const s=(t-0.75)/0.25; return [Math.round(80+s*175), 255, Math.round(s*80)]; }
    // ── NFL team palettes ──
    case 4: // Chiefs — black → crimson → red → gold
      if (t < 0.3) { const s=t/0.3;         return [Math.round(s*80),  0, Math.round(s*10)]; }
      if (t < 0.62){ const s=(t-0.3)/0.32;  return [Math.round(80+s*140), 0, Math.round(10+s*10)]; }
      {              const s=(t-0.62)/0.38;  return [255, Math.round(s*184), Math.round(20-s*20)]; }
    case 5: // Ravens — black → deep purple → violet → gold
      if (t < 0.3) { const s=t/0.3;         return [Math.round(s*40),  0, Math.round(s*90)]; }
      if (t < 0.65){ const s=(t-0.3)/0.35;  return [Math.round(40+s*90), 0, Math.round(90+s*110)]; }
      {              const s=(t-0.65)/0.35;  return [Math.round(130+s*125), Math.round(s*160), Math.round(200-s*200)]; }
    case 6: // Broncos — black → navy → vivid orange
      if (t < 0.35){ const s=t/0.35;        return [0, Math.round(s*10), Math.round(s*60)]; }
      if (t < 0.7) { const s=(t-0.35)/0.35; return [Math.round(s*230), Math.round(10+s*70), Math.round(60-s*60)]; }
      {              const s=(t-0.7)/0.3;    return [Math.round(230+s*25), Math.round(80+s*79), 0]; }
    case 7: // Seahawks — dark navy → forest green → action green
      if (t < 0.3) { const s=t/0.3;         return [0, 0, Math.round(20+s*30)]; }
      if (t < 0.6) { const s=(t-0.3)/0.3;   return [0, Math.round(s*90), Math.round(50-s*30)]; }
      if (t < 0.85){ const s=(t-0.6)/0.25;  return [Math.round(s*80), Math.round(90+s*115), Math.round(20+s*20)]; }
      {              const s=(t-0.85)/0.15;  return [Math.round(80+s*75), Math.round(205+s*50), Math.round(40+s*40)]; }
    case 8: // Dolphins — black → deep teal → bright teal → orange pop
      if (t < 0.5) { const s=t/0.5;         return [0, Math.round(s*155), Math.round(s*151)]; }
      if (t < 0.78){ const s=(t-0.5)/0.28;  return [Math.round(s*252), Math.round(155-s*79), Math.round(151-s*149)]; }
      {              const s=(t-0.78)/0.22;  return [252, Math.round(76-s*30), Math.round(2+s*20)]; }
    case 9: // Raiders — black → dark charcoal → silver-white
      { const v = t < 0.65 ? Math.round(t/0.65*120) : Math.round(120+(t-0.65)/0.35*135);
        return [v, v, Math.min(255, Math.round(v*1.04))]; }
    case 10: // 49ers — black → deep red → scarlet → gold
      if (t < 0.35){ const s=t/0.35;        return [Math.round(s*100), 0, 0]; }
      if (t < 0.65){ const s=(t-0.35)/0.3;  return [Math.round(100+s*100), 0, 0]; }
      {              const s=(t-0.65)/0.35;  return [200, Math.round(s*165), Math.round(s*77)]; }
    case 11: // Packers — dark green → bright green → gold
      if (t < 0.4) { const s=t/0.4;         return [0, Math.round(20+s*140), Math.round(5+s*15)]; }
      if (t < 0.75){ const s=(t-0.4)/0.35;  return [Math.round(s*55), Math.round(160+s*22), Math.round(20+s*20)]; }
      {              const s=(t-0.75)/0.25;  return [Math.round(55+s*200), Math.round(182-s*50), Math.round(40-s*40)]; }
    default: // classic: dark blue → cyan → green → yellow → red
      if (t < 0.2) { const s=t/0.2;         return [0, 0, Math.round(s*180)]; }
      if (t < 0.4) { const s=(t-0.2)/0.2;   return [0, Math.round(s*180), 180]; }
      if (t < 0.6) { const s=(t-0.4)/0.2;   return [0, Math.round(180+s*75), Math.round(180-s*180)]; }
      if (t < 0.8) { const s=(t-0.6)/0.2;   return [Math.round(s*255), 255, 0]; }
      { const s=(t-0.8)/0.2;                 return [255, Math.round(255-s*200), 0]; }
  }
}

function wfColFast(t) {
  if (!wfColorCache || wfColorCacheTheme !== wfTheme) {
    wfColorCacheTheme = wfTheme;
    wfColorCache = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const c = wfCol(i / 255);
      wfColorCache[i * 3] = c[0];
      wfColorCache[i * 3 + 1] = c[1];
      wfColorCache[i * 3 + 2] = c[2];
    }
  }
  const idx = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
  return [wfColorCache[idx], wfColorCache[idx + 1], wfColorCache[idx + 2]];
}

function togglePeakHold() {
  peakHoldEnabled = !peakHoldEnabled;
  if (!peakHoldEnabled) peakHoldBuf = null;
  const btn = el('peakHoldBtn');
  if (btn) btn.classList.toggle('active', peakHoldEnabled);
  saveState();
}

function setWfTheme(n) {
  wfTheme = n;
  document.querySelectorAll('.wf-theme-btn[data-theme]').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.theme) === n));
  saveState();
}

// ── RIT (Receiver Incremental Tuning) ──
let ritHz = 0;      // current RIT offset in Hz
let ritOn = false;  // RIT enabled flag

function togRIT() {
  ritOn = !ritOn;
  const btn = el('ritOnBtn');
  if (btn) btn.classList.toggle('on', ritOn);
  updRITDisp();
}
function nudgeRIT(delta) {
  ritHz = Math.max(-9999, Math.min(9999, ritHz + delta));
  updRITDisp();
}
function clearRIT() {
  ritHz = 0;
  updRITDisp();
}
function updRITDisp() {
  const d = el('ritDisp');
  if (d) d.textContent = (ritOn ? (ritHz >= 0 ? '+' : '') + ritHz : '0') + ' Hz';
}
// Effective receive frequency (VFO A + RIT if enabled)
function vfoARit() { return ritOn ? S.vfoA + ritHz : S.vfoA; }

// ── DIGITAL MODE MARKERS ──
let showDigMarkers = true;
// FT8, FT4, and PSK31 markers removed — only WSPR and JS8 remain
const DIGITAL_MARKERS = [
  // 160m
  { name:'WSPR', hz:1836600,  color:'#00cc66' },
  // 80m
  { name:'WSPR', hz:3568600,  color:'#00cc66' },
  { name:'JS8',  hz:3578000,  color:'#aa88ff' },
  // 40m
  { name:'WSPR', hz:7038600,  color:'#00cc66' },
  { name:'JS8',  hz:7078000,  color:'#aa88ff' },
  // 30m
  { name:'WSPR', hz:10138700, color:'#00cc66' },
  { name:'JS8',  hz:10130000, color:'#aa88ff' },
  // 20m
  { name:'WSPR', hz:14095600, color:'#00cc66' },
  { name:'JS8',  hz:14078000, color:'#aa88ff' },
  // 17m
  { name:'WSPR', hz:18104600, color:'#00cc66' },
  // 15m
  { name:'WSPR', hz:21094600, color:'#00cc66' },
  { name:'JS8',  hz:21078000, color:'#aa88ff' },
  // 12m
  { name:'WSPR', hz:24924600, color:'#00cc66' },
  // 10m
  { name:'WSPR', hz:28124600, color:'#00cc66' },
  { name:'JS8',  hz:28078000, color:'#aa88ff' },
  // 6m
  { name:'WSPR', hz:50293000, color:'#00cc66' },
];

function drawDigMarkers(ctx, W, H, hzToX) {
  if (!showDigMarkers) return;
  ctx.font = 'bold 9px SF Mono, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1;
  const labelBuckets = {}; // avoid overlapping labels at same x
  for (const m of DIGITAL_MARKERS) {
    const x = hzToX(m.hz);
    if (x < 0 || x > W) continue;
    ctx.strokeStyle = m.color + 'aa';
    ctx.fillStyle   = m.color + 'cc';
    ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, H - 20); ctx.stroke();
    // Bucket labels by 20px columns to avoid overlap
    const bucket = Math.round(x / 20) * 20;
    if (!labelBuckets[bucket]) {
      labelBuckets[bucket] = true;
      ctx.fillText(m.name, x, H - 24);
    }
  }
  ctx.setLineDash([]);
}

// ── DX CLUSTER (Spothole API) ──
let dxSpots = [];       // filtered spots for display
let dxAllSpots = [];    // raw spots from API
let dxEnabled = false;
let dxLabelHits = [];   // [{freq, x, y, w, h}] bounding boxes of drawn callsign pills, in canvas px
// Tracks newly-arrived spots: key = "CALL|band" → { firstSeen: ms, acked: bool }
const dxNewMap = new Map();
let dxPollId = null;
let dxLastFetch = 0;
const DX_POLL_INTERVAL = 60000; // 60s

function togDXCluster() {
  dxEnabled = !dxEnabled;
  const btn = el('dxEnableC');
  if (btn) btn.classList.toggle('on', dxEnabled);
  if (dxEnabled) {
    fetchDXSpots();
    if (!dxPollId) dxPollId = setInterval(fetchDXSpots, DX_POLL_INTERVAL);
  } else {
    if (dxPollId) { clearInterval(dxPollId); dxPollId = null; }
    dxSpots = []; dxAllSpots = [];
    el('dxList').innerHTML = '';
    el('dxAge').textContent = '';
  }
}

function fetchDXSpots() {
  fetch('https://spothole.app/api/v1/spots?limit=200')
    .then(r => r.json())
    .then(data => {
      const incoming = Array.isArray(data) ? data : [];
      const now = Date.now();

      // Build set of keys that already existed before this fetch
      const existingKeys = new Set(dxAllSpots.map(s =>
        (s.dx_call || '').toUpperCase() + '|' + (s.band || '')));

      // Mark any spot we haven't seen before as new
      incoming.forEach(s => {
        const key = (s.dx_call || '').toUpperCase() + '|' + (s.band || '');
        if (!existingKeys.has(key) && !dxNewMap.has(key)) {
          dxNewMap.set(key, { firstSeen: now, acked: false });
        }
      });

      // Expire entries older than 90s to keep the map tidy
      dxNewMap.forEach((v, k) => { if (now - v.firstSeen > 90000) dxNewMap.delete(k); });

      dxAllSpots = incoming;
      dxLastFetch = now;
      dxApplyFilter();
    })
    .catch(() => {});
}

// Map current TCI mode string to Spothole mode_type ('CW' | 'DATA' | 'PHONE')
// NOTE: Spothole tags all voice spots (SSB, AM, FM, SAM, etc.) as 'PHONE'.
// Returning 'SSB' here — as an earlier revision did — never matched any spot,
// which silently broke Track Mode filtering for voice operators.
function modeToModeType(m) {
  m = (m || '').toUpperCase();
  // Morse-style CW variants. Thetis emits CWL/CWU; bare 'CW' is kept for safety.
  if (['CW','CWL','CWU','CWN'].includes(m)) return 'CW';
  // Digital sub-modes. DIGU/DIGL are the Thetis passthrough containers,
  // the rest cover explicit decoder modes some rigs report.
  if (['DIGU','DIGL','DATA','RTTY','PSK','FT8','FT4','JS8','WSPR'].includes(m)) return 'DATA';
  // Default: every remaining mode (USB, LSB, AM, SAM, NFM, DSB, etc.) is voice.
  return 'PHONE';
}

function dxApplyFilter() {
  const trackBand = (el('dxTrackBand') || {}).checked;
  const trackMode = (el('dxTrackMode') || {}).checked;
  const curBand = freqToBand(S.vfoA);
  const curModeType = modeToModeType(S.mode);

  // Pull settings-based filters
  const cfg = getSettings();
  const myContinent      = cfg.dxMyContinent || '';
  const myZone           = cfg.dxMyZone || 0;
  const onlyMyZone       = cfg.dxOnlyMyZone || false;
  const hideMyContinent  = cfg.dxHideMyContinent || false;
  const localSpottersOnly= cfg.dxLocalSpotters || false;
  const maxAgeMins       = cfg.dxMaxAge != null ? cfg.dxMaxAge : 0;
  const dxContinent      = cfg.dxContinent || '';

  const now = Date.now();

  dxSpots = dxAllSpots.filter(s => {
    // Track band / track mode (from dock panel checkboxes)
    if (trackBand && curBand && s.band !== curBand) return false;
    // Track Mode: only keep spots whose mode_type matches the rig's current
    // category (CW / DATA / PHONE). Spots with a missing mode_type field are
    // kept so unknown sources don't silently disappear from the list.
    if (trackMode) {
      const spotType = (s.mode_type || '').toUpperCase();
      if (spotType && spotType !== curModeType) return false;
    }

    // Max age
    if (maxAgeMins > 0 && s.time_iso) {
      const spotMs = new Date(s.time_iso).getTime();
      if (!isNaN(spotMs) && (now - spotMs) > maxAgeMins * 60000) return false;
    }

    // Only DX on a specific continent
    if (dxContinent && s.dx_continent !== dxContinent) return false;

    // Hide DX on my own continent (show true DX only)
    if (hideMyContinent && myContinent && s.dx_continent === myContinent) return false;

    // Only spots from local spotters (de_continent matches mine)
    if (localSpottersOnly && myContinent && s.de_continent !== myContinent) return false;

    // Only my CQ zone — map zone to continent as best approximation
    // (Spothole doesn't return CQ zone per spot; filter by country substring if zone set)
    if (onlyMyZone && myZone > 0) {
      // Best effort: keep spot if dx_call prefix roughly matches zone's typical countries
      // For now, use the user-set continent as the zone boundary
      if (myContinent && s.dx_continent !== myContinent) return false;
    }

    return true;
  });

  // Deduplicate: keep only the most recent spot per dx_call per band.
  // The same station may appear on multiple bands (keep each), but only once per band.
  const seen = new Map();
  dxSpots = dxSpots.filter(s => {
    const key = (s.dx_call || '').toUpperCase() + '|' + (s.band || '');
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  }).slice(0, 100);

  renderDXList();
}

function renderDXList() {
  const box = el('dxList');
  if (!box) return;
  if (!dxSpots.length) { box.innerHTML = '<span style="color:#484f58;">No spots</span>'; return; }
  box.innerHTML = dxSpots.slice(0, 30).map(s => {
    const modeColor = s.mode_type === 'DATA' ? '#ff8800' : s.mode_type === 'CW' ? '#3fb950' : '#58a6ff';
    const mhz = s.freq ? (s.freq / 1e6).toFixed(3) : '?';
    const freqAttr = Number.isFinite(s.freq) ? s.freq : 0;  // numeric, safe in attribute
    const tipRaw = (s.de_call || '') + ' → ' + (s.dx_call || '') + ' @ ' + mhz + ' MHz ' + (s.mode || '');
    return `<div class="dx-row" style="cursor:pointer;padding:1px 2px;border-radius:2px;" data-freq="${freqAttr}" title="${escHtml(tipRaw)}">
      <span style="color:${modeColor};min-width:38px;display:inline-block;">${escHtml((s.mode||'?').slice(0,4))}</span>
      <span style="color:#58a6ff;min-width:52px;display:inline-block;">${escHtml(mhz)}</span>
      <span style="color:#e6edf3;min-width:68px;display:inline-block;">${escHtml(s.dx_call||'')} ${escHtml(s.dx_flag||'')}</span>
      <span style="color:#e6edf3;">${escHtml(s.dx_country||'')}</span>
    </div>`;
  }).join('');
  const age = dxLastFetch ? Math.round((Date.now() - dxLastFetch) / 1000) + 's ago' : '';
  const ageEl = el('dxAge'); if (ageEl) ageEl.textContent = dxSpots.length + ' spots · ' + age;
}

// Event delegation for DX row clicks — replaces inline onclick=dxTuneTo(...)
document.addEventListener('click', e => {
  const row = e.target.closest('#dxList .dx-row');
  if (!row) return;
  const f = parseInt(row.dataset.freq, 10);
  if (f > 0) dxTuneTo(f);
});

function dxTuneTo(freqHz) {
  if (!freqHz || freqHz <= 0) return;
  setVfoDisp('A', freqHz);
  send('vfo:0,0,' + freqHz + ';');
}

// Age display refresh + re-filter when tracking is on and band/mode changed
let _dxLastBand = null, _dxLastMode = null;
setInterval(() => {
  if (!dxEnabled) return;
  // Refresh age label
  if (dxLastFetch) { const ageEl = el('dxAge'); if (ageEl) { const age = Math.round((Date.now()-dxLastFetch)/1000); ageEl.textContent = dxSpots.length + ' spots · ' + age + 's ago'; } }
  // Re-filter if tracking and band/mode changed
  const trackBand = (el('dxTrackBand') || {}).checked;
  const trackMode = (el('dxTrackMode') || {}).checked;
  if (trackBand || trackMode) {
    const curBand = freqToBand(S.vfoA);
    const curMode = S.mode;
    if (curBand !== _dxLastBand || curMode !== _dxLastMode) {
      _dxLastBand = curBand; _dxLastMode = curMode;
      dxApplyFilter();
    }
  }
}, 3000);

// Draw DX spots on spectrum — horizontal stacked callsigns just below freq labels
function drawDXOverlay(ctx, W, H, hzToX) {
  dxLabelHits = []; // reset hit areas each frame
  if (!dxEnabled || !dxSpots.length) return;

  ctx.font = 'bold 13px SF Mono, Consolas, monospace';
  ctx.textAlign = 'left';

  // Build visible spots
  const items = [];
  for (const s of dxSpots) {
    if (!s.freq) continue;
    const x = hzToX(s.freq);
    if (x < 1 || x > W - 1) continue;
    const mt = s.mode_type || 'SSB';
    const col = mt === 'DATA' ? '#ff8800' : mt === 'CW' ? '#3fb950' : '#79c0ff';
    const flag = s.dx_flag || '';
    const label = ((s.dx_call || '?').slice(0, 10) + (flag ? ' ' + flag : '')).trimEnd();
    const dxKey = (s.dx_call || '').toUpperCase() + '|' + (s.band || '');
    const newEntry = dxNewMap.get(dxKey);
    const isNew = newEntry && !newEntry.acked && (Date.now() - newEntry.firstSeen) < 60000;
    items.push({ x, col, call: label, spot: s, dxKey, isNew });
  }
  if (!items.length) return;

  // Sort left-to-right for greedy row assignment
  items.sort((a, b) => a.x - b.x);

  // Assign rows: each label sits in the first row where it won't overlap the previous label
  const LABEL_ROW_H = 16;   // px per row (matches 13px font)
  const TICK_Y      = 21;   // y where tick starts — just below the 20px freq strip
  const MAX_ROWS    = 5;
  const rowRight = new Float32Array(MAX_ROWS).fill(-Infinity);

  for (const item of items) {
    const tw = ctx.measureText(item.call).width + 6;
    let row = MAX_ROWS - 1;
    for (let r = 0; r < MAX_ROWS; r++) {
      if (item.x - rowRight[r] > tw + 2) { row = r; break; }
    }
    item.row = row;
    rowRight[row] = item.x + tw;
  }

  // Draw each spot
  for (const item of items) {
    const labelY = TICK_Y + item.row * LABEL_ROW_H + 13; // text baseline

    // Downward-pointing triangle tick at exact frequency, sitting on the freq strip edge
    ctx.fillStyle = item.col + 'dd';
    ctx.beginPath();
    ctx.moveTo(item.x - 5, TICK_Y);
    ctx.lineTo(item.x + 5, TICK_Y);
    ctx.lineTo(item.x,     TICK_Y + 8);
    ctx.closePath();
    ctx.fill();

    // Short dashed connector from tick tip down to the label row (only when stacked)
    if (item.row > 0) {
      ctx.strokeStyle = item.col + '55';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(item.x, TICK_Y + 8);
      ctx.lineTo(item.x, labelY - 12);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Dark pill behind callsign text for readability
    const tw = ctx.measureText(item.call).width;
    const pillX = item.x + 1, pillY = labelY - 12, pillW = tw + 6, pillH = 15;
    ctx.fillStyle = 'rgba(1,4,9,0.82)';
    ctx.fillRect(pillX, pillY, pillW, pillH);

    // Callsign — horizontal, readable
    ctx.fillStyle = item.col;
    ctx.fillText(item.call, item.x + 3, labelY);

    // Yellow highlight border for spots that arrived in the last 60s and haven't been clicked
    if (item.isNew) {
      ctx.strokeStyle = '#ffe033';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(pillX - 1, pillY - 1, pillW + 2, pillH + 2);
    }

    // Store hit area so click handler can tune to this spot (and ack new-spot highlight)
    dxLabelHits.push({ freq: item.spot.freq, x: pillX, y: pillY, w: pillW, h: pillH, dxKey: item.dxKey });
  }
}

// Hover tooltip on spectrum canvas for DX spots
(function() {
  function attachDXHover(canvasId) {
    const cv = document.getElementById(canvasId);
    if (!cv) return;
    cv.addEventListener('mousemove', function(e) {
      const tooltip = el('dxTooltip');
      if (!dxEnabled || !dxSpots.length || !S.iqOn) { if (tooltip) tooltip.style.display = 'none'; return; }
      const rect = cv.getBoundingClientRect();
      const xFrac = (e.clientX - rect.left) / rect.width;
      const SR = S.iqSR || 192000;
      const vSR = SR / specZoom;
      const vLo = (specZoomCentre || S.iqCentre) - vSR / 2;
      const hoverHz = vLo + xFrac * vSR;
      const threshold = vSR / rect.width * 10; // ±10px
      let hit = null;
      for (const s of dxSpots) {
        if (s.freq && Math.abs(s.freq - hoverHz) < threshold) { hit = s; break; }
      }
      if (!tooltip) return;
      if (hit) {
        const mhz = (hit.freq / 1e6).toFixed(4);
        const time = hit.time_iso ? hit.time_iso.slice(11, 16) + 'Z' : '';
        tooltip.innerHTML = `<b style="color:#58a6ff;">${escHtml(hit.dx_call || '?')}</b> ${escHtml(hit.dx_flag || '')} <span style="color:#7d8590;">${escHtml(hit.dx_country || '')}</span><br>
          <span style="color:#3fb950;">${escHtml(mhz)} MHz</span> · <span style="color:#e3b341;">${escHtml(hit.mode || '?')}</span> · ${escHtml(time)}<br>
          <span style="color:#484f58;">Spotter: ${escHtml(hit.de_call || '?')} (${escHtml(hit.de_country || '')})</span>
          ${hit.comment ? '<br><span style="color:#7d8590;">' + escHtml(hit.comment) + '</span>' : ''}`;
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 14) + 'px';
        tooltip.style.top  = (e.clientY - 10) + 'px';
      } else {
        tooltip.style.display = 'none';
      }
    });
    cv.addEventListener('mouseleave', () => { const t = el('dxTooltip'); if (t) t.style.display = 'none'; });

    // Click on a callsign/flag pill to tune VFO A to that spot's frequency
    cv.addEventListener('click', function(e) {
      if (!dxEnabled || !dxLabelHits.length) return;
      const rect = cv.getBoundingClientRect();
      // Convert CSS click coords to canvas pixel coords
      const scaleX = cv.width  / rect.width;
      const scaleY = cv.height / rect.height;
      const cx = (e.clientX - rect.left) * scaleX;
      const cy = (e.clientY - rect.top)  * scaleY;
      for (const hit of dxLabelHits) {
        if (cx >= hit.x && cx <= hit.x + hit.w && cy >= hit.y && cy <= hit.y + hit.h) {
          // Dismiss the new-spot yellow highlight when clicked
          if (hit.dxKey && dxNewMap.has(hit.dxKey)) dxNewMap.get(hit.dxKey).acked = true;
          dxTuneTo(hit.freq);
          e.stopPropagation(); // don't also trigger spectrum drag-to-tune
          return;
        }
      }
    });
  }
  // Attach after DOM is ready
  window.addEventListener('load', () => { attachDXHover('specC'); });
})();

// ── PROPAGATION WIDGET ──
let propData = null;
let propFetching = false;

function fetchPropagation() {
  if (propFetching) return;
  propFetching = true;
  // Use a CORS-friendly proxy approach — hamqsl.com supports direct XML fetch
  fetch('https://www.hamqsl.com/solarxml.php')
    .then(r => r.text())
    .then(txt => {
      propFetching = false;
      propData = parseSolarXML(txt);
      renderProp();
    })
    .catch(() => { propFetching = false; });
}

function parseSolarXML(txt) {
  try {
    const p = new DOMParser();
    const doc = p.parseFromString(txt, 'text/xml');
    const g = t => { const n = doc.querySelector(t); return n ? n.textContent.trim() : '--'; };
    return {
      sfi: g('solarflux'),
      aindex: g('aindex'),
      kindex: g('kindex'),
      xray: g('xray'),
      updated: g('updated'),
      bands: {
        '80m-40m': { day: g('band[name="80m-40m"] condition[time="day"]'), night: g('band[name="80m-40m"] condition[time="night"]') },
        '30m-20m': { day: g('band[name="30m-20m"] condition[time="day"]'), night: g('band[name="30m-20m"] condition[time="night"]') },
        '17m-15m': { day: g('band[name="17m-15m"] condition[time="day"]'), night: g('band[name="17m-15m"] condition[time="night"]') },
        '10m-6m':  { day: g('band[name="10m-6m"] condition[time="day"]'),  night: g('band[name="10m-6m"] condition[time="night"]') },
      }
    };
  } catch(e) { return null; }
}

function condClass(c) {
  if (!c) return '';
  c = c.toLowerCase();
  if (c.includes('good') || c.includes('excel')) return 'cond-good';
  if (c.includes('fair')) return 'cond-fair';
  return 'cond-poor';
}

function renderProp() {
  if (!propData) return;
  const d = propData;
  const sv = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  sv('pSFI', d.sfi);
  sv('pA', d.aindex);
  sv('pK', d.kindex);
  sv('pXray', d.xray);
  const bandsEl = el('propBands');
  if (bandsEl) {
    const hr = new Date().getUTCHours();
    const isDay = hr >= 6 && hr < 20;
    bandsEl.innerHTML = Object.entries(d.bands).map(([band, cond]) => {
      const c = isDay ? cond.day : cond.night;
      return `<span class="prop-cond ${condClass(c)}" title="${escHtml(band)} (${isDay?'day':'night'})">${escHtml(band)} ${escHtml(c||'?')}</span>`;
    }).join('');
  }
  const ageEl = el('propAge');
  if (ageEl) ageEl.textContent = d.updated ? 'Updated: ' + d.updated : '';
}


// ── AUDIO RECORDER ──
let recorder = null;
let recChunks = [];
let recOn = false;

function toggleRecord() {
  recOn ? stopRecord() : startRecord();
}

function startRecord() {
  if (!S.audioCtx || !S.rxOn) {
    log('err', 'Recorder: start RX audio first');
    return;
  }
  try {
    // Create a MediaStreamDestination from the audio context
    const dest = S.audioCtx.createMediaStreamDestination();
    if (S.analyser) S.analyser.connect(dest);
    // MediaRecorder prefers audio/webm
    const opts = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? { mimeType: 'audio/webm;codecs=opus' }
      : {};
    recorder = new MediaRecorder(dest.stream, opts);
    recChunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      a.download = 'totw-' + ts + '.webm';
      a.href = URL.createObjectURL(blob);
      a.click();
      URL.revokeObjectURL(a.href);
      log('sys', 'Recording saved: ' + a.download + ' (' + (blob.size/1024).toFixed(1) + ' kB)');
    };
    recorder.start(1000); // 1s chunks
    recOn = true;
    const btn = el('recBtn'); if (btn) btn.classList.add('on');
    const lbl = el('recLabel'); if (lbl) lbl.textContent = 'STOP';
    log('sys', 'Recording started');
  } catch(e) {
    log('err', 'Recorder error: ' + e.message);
  }
}

function stopRecord() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recorder = null;
  recOn = false;
  const btn = el('recBtn'); if (btn) btn.classList.remove('on');
  const lbl = el('recLabel'); if (lbl) lbl.textContent = 'REC';
}

// ── FREQUENCY MEMORIES ──
const MEM_KEY = 'totw_mem_v1';
let memories = [];

function loadMemories() {
  try { memories = JSON.parse(localStorage.getItem(MEM_KEY)) || []; } catch(e) { memories = []; }
}

function saveMemories() {
  try { localStorage.setItem(MEM_KEY, JSON.stringify(memories)); } catch(e) {}
}

function memSave() {
  const name = prompt('Memory name (leave blank for auto):', (S.vfoA / 1e6).toFixed(4) + ' MHz') ;
  if (name === null) return; // cancelled
  memories.push({
    name: name || (S.vfoA / 1e6).toFixed(4) + ' ' + S.mode,
    freq: S.vfoA,
    mode: S.mode,
    ts: Date.now()
  });
  saveMemories();
  renderMemShort();
  renderMemModalList();
}

function memRecall(idx) {
  const m = memories[idx];
  if (!m) return;
  setVfoDisp('A', m.freq);
  send('vfo:0,0,' + m.freq + ';');
  if (m.mode) { S.mode = m.mode; updMode(); send('modulation:0,' + m.mode + ';'); }
}

function memDelete(idx) {
  memories.splice(idx, 1);
  saveMemories();
  renderMemShort();
  renderMemModalList();
}

function memClearAll() {
  if (!confirm('Clear all memories?')) return;
  memories = [];
  saveMemories();
  renderMemShort();
  renderMemModalList();
}

function memExport() {
  const blob = new Blob([JSON.stringify(memories, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.download = 'totw-memories.json';
  a.href = URL.createObjectURL(blob);
  a.click();
  URL.revokeObjectURL(a.href);
}

function memImportClick() { const f = el('memImportFile'); if (f) f.click(); }

function memImportLoad(inp) {
  if (!inp.files || !inp.files[0]) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (Array.isArray(imported)) {
        memories = memories.concat(imported);
        saveMemories();
        renderMemShort();
        renderMemModalList();
        log('sys', 'Imported ' + imported.length + ' memories');
      }
    } catch(err) { log('err', 'Memory import failed: ' + err.message); }
    inp.value = '';
  };
  reader.readAsText(inp.files[0]);
}

function renderMemShort() {
  const box = el('memListShort');
  if (!box) return;
  if (!memories.length) { box.innerHTML = '<span style="font-size:9px;color:#484f58;font-family:\'SF Mono\',monospace;">No memories saved</span>'; return; }
  box.innerHTML = '<table class="mem-table">' + memories.slice(0, 20).map((m, i) => {
    const mhz = (m.freq / 1e6).toFixed(4);
    return `<tr class="mem-row" data-mem-idx="${i}" data-mem-recall="1">
      <td class="mem-freq">${escHtml(mhz)}</td>
      <td class="mem-mode">${escHtml(m.mode||'')}</td>
      <td class="mem-name" title="${escHtml(m.name||'')}">${escHtml((m.name||'').slice(0,14))}</td>
      <td class="mem-del" data-mem-idx="${i}" data-mem-delete="1" title="Delete">✕</td>
    </tr>`;
  }).join('') + '</table>';
}

function renderMemModalList() {
  const box = el('memModalList');
  if (!box) return;
  if (!memories.length) { box.innerHTML = '<span style="font-size:11px;color:#484f58;">No memories saved.</span>'; return; }
  box.innerHTML = '<table class="mem-table" style="font-size:11px;">' +
    '<tr><td style="color:#484f58;padding:2px 4px;">#</td><td style="color:#484f58;">Freq</td><td style="color:#484f58;">Mode</td><td style="color:#484f58;">Name</td><td></td></tr>' +
    memories.map((m, i) => {
      const mhz = (m.freq / 1e6).toFixed(4);
      return `<tr class="mem-row" data-mem-idx="${i}" data-mem-recall="1" data-mem-close-modal="1">
        <td style="color:#484f58;">${i+1}</td>
        <td class="mem-freq">${escHtml(mhz)}</td>
        <td class="mem-mode">${escHtml(m.mode||'')}</td>
        <td class="mem-name" title="${escHtml(m.name||'')}">${escHtml((m.name||'').slice(0,24))}</td>
        <td class="mem-del" data-mem-idx="${i}" data-mem-delete="1" title="Delete">✕</td>
      </tr>`;
    }).join('') + '</table>';
}

// Event delegation for memory rows — replaces inline onclick=memRecall/memDelete
document.addEventListener('click', e => {
  const delCell = e.target.closest('[data-mem-delete]');
  if (delCell) {
    e.stopPropagation();
    const idx = parseInt(delCell.dataset.memIdx, 10);
    if (!isNaN(idx)) memDelete(idx);
    return;
  }
  const row = e.target.closest('[data-mem-recall]');
  if (!row) return;
  const idx = parseInt(row.dataset.memIdx, 10);
  if (isNaN(idx)) return;
  memRecall(idx);
  if (row.dataset.memCloseModal) closeModal('memModal');
});

// ── COLOR THEMES — unified spectrum line + waterfall ──
// Each theme defines: specLine color + wfTheme index
const COLOR_THEMES = {
  // ── Standard ──
  classic: { specLine: '#58a6ff', wf: 0 },
  heat:    { specLine: '#ff8800', wf: 1 },
  gray:    { specLine: '#aaaaaa', wf: 2 },
  night:   { specLine: '#3fb950', wf: 3 },
  amber:   { specLine: '#e3b341', wf: 0 },
  // ── NFL Team Spectrums ──
  nfl_chiefs:   { specLine: '#FFB81C', wf: 4 },
  nfl_ravens:   { specLine: '#c9a030', wf: 5 },
  nfl_broncos:  { specLine: '#FB4F14', wf: 6 },
  nfl_seahawks: { specLine: '#69BE28', wf: 7 },
  nfl_dolphins: { specLine: '#FC4C02', wf: 8 },
  nfl_raiders:  { specLine: '#A5ACAF', wf: 9 },
  nfl_niners:   { specLine: '#C9A84C', wf: 10 },
  nfl_packers:  { specLine: '#FFB612', wf: 11 },
};
let activeColorTheme = 'classic';

function setColorTheme(name) {
  // Accept either a string name or a legacy button element (backwards compat)
  activeColorTheme = (typeof name === 'string') ? name : name.dataset.theme;
  // Sync dropdown selector
  const sel = el('cfgColorTheme');
  if (sel) sel.value = activeColorTheme;
  applyColorTheme(activeColorTheme);
}

function applyColorTheme(name) {
  const t = COLOR_THEMES[name] || COLOR_THEMES.classic;
  specLineColor = t.specLine;
  wfTheme = t.wf;
  // Sync the hidden wf-theme-btn active states (for saveState compat)
  document.querySelectorAll('.wf-theme-btn[data-theme]').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.theme) === wfTheme));
}

// ── UI COLOR THEMES ──
// Controls panel/background color via data-ui-theme on <html>.
let activeUITheme = 'dark';

// Called by the select dropdown's onchange — previews the theme immediately.
// The choice is only permanently saved when the user clicks Save in Settings.
function applyUITheme(name) {
  activeUITheme = name || 'dark';
  // 'dark' is the base stylesheet — remove the attribute to restore defaults
  if (activeUITheme === 'dark') {
    document.documentElement.removeAttribute('data-ui-theme');
  } else {
    document.documentElement.setAttribute('data-ui-theme', activeUITheme);
  }
  // Keep the select in sync (in case called from applySettings, not the select itself)
  const sel = el('cfgUITheme');
  if (sel) sel.value = activeUITheme;
}

// ── SETTINGS ──
let specLineColor = '#58a6ff';

function loadSettingsUI() {
  const cfg = getSettings();
  const v = (id, val) => { const e = el(id); if (e) e.value = val; };
  const c = (id, val) => { const e = el(id); if (e) e.checked = val; };
  v('cfgCall', cfg.callsign || '');
  v('cfgGrid', cfg.grid || '');
  v('cfgName', cfg.opname || '');
  c('cfgAutoConn', cfg.autoConn || false);
  c('cfgDigMarkers', cfg.digMarkers !== false);
  v('cfgPttMode', cfg.pttMode || 'momentary');
  v('cfgPttTimeout', cfg.pttTimeout || 3);
  v('cfgDbFloor', cfg.dbFloor || -140);
  v('cfgDbCeil', cfg.dbCeil || -30);
  activeColorTheme = cfg.colorTheme || 'classic';
  const colorSel = el('cfgColorTheme');
  if (colorSel) colorSel.value = activeColorTheme;
  activeUITheme = cfg.uiTheme || 'dark';
  const uiSel = el('cfgUITheme');
  if (uiSel) uiSel.value = activeUITheme;
  // DX cluster filters
  v('cfgMyContinent',       cfg.dxMyContinent || '');
  v('cfgMyZone',            cfg.dxMyZone || '');
  c('cfgDxOnlyMyZone',      cfg.dxOnlyMyZone || false);
  c('cfgDxHideMyContinent', cfg.dxHideMyContinent || false);
  c('cfgDxLocalSpotters',   cfg.dxLocalSpotters || false);
  v('cfgDxMaxAge',          cfg.dxMaxAge != null ? cfg.dxMaxAge : 30);
  v('cfgDxContinent',       cfg.dxContinent || '');
  // Greyline
  c('cfgGreyline',     cfg.greyline || false);
  v('cfgGreylineUrl',  cfg.greylineUrl || '');
  v('cfgGreylineOpacity', cfg.greylineOpacity != null ? cfg.greylineOpacity : 80);
  // Panel visibility
  const vis = cfg.panelVis || {};
  PANELS.forEach(p => {
    const cb = el('vis_' + p.id);
    if (cb) cb.checked = vis[p.id] !== undefined ? vis[p.id] : p.def;
  });
}

function saveSettings() {
  const gv = id => { const e = el(id); return e ? e.value : ''; };
  const gc = id => { const e = el(id); return e ? e.checked : false; };
  const cfg = {
    schemaVersion:        SETTINGS_SCHEMA_VERSION,
    callsign:           gv('cfgCall').toUpperCase().trim(),
    grid:               gv('cfgGrid').toUpperCase().trim(),
    opname:             gv('cfgName').trim(),
    autoConn:           gc('cfgAutoConn'),
    digMarkers:         gc('cfgDigMarkers'),
    pttMode:            gv('cfgPttMode'),
    pttTimeout:         parseInt(gv('cfgPttTimeout')) || 3,
    dbFloor:            parseInt(gv('cfgDbFloor')) || -140,
    dbCeil:             parseInt(gv('cfgDbCeil')) || -30,
    colorTheme:         activeColorTheme,
    uiTheme:            activeUITheme,
    // DX cluster filters
    dxMyContinent:      gv('cfgMyContinent'),
    dxMyZone:           parseInt(gv('cfgMyZone')) || 0,
    dxOnlyMyZone:       gc('cfgDxOnlyMyZone'),
    dxHideMyContinent:  gc('cfgDxHideMyContinent'),
    dxLocalSpotters:    gc('cfgDxLocalSpotters'),
    dxMaxAge:           parseInt(gv('cfgDxMaxAge')) || 0,
    dxContinent:        gv('cfgDxContinent'),
    // Greyline
    greyline:           gc('cfgGreyline'),
    greylineUrl:        gv('cfgGreylineUrl').trim(),
    greylineOpacity:    parseInt(gv('cfgGreylineOpacity')) || 80,
    // Panel visibility
    panelVis:           Object.fromEntries(PANELS.map(p => {
      const cb = el('vis_' + p.id); return [p.id, cb ? cb.checked : p.def];
    })),
  };
  try { localStorage.setItem('totw_cfg_v1', JSON.stringify(cfg)); } catch(e) {}
  applyUITheme(cfg.uiTheme || 'dark');
  showDigMarkers = cfg.digMarkers;
  DB_MIN = cfg.dbFloor;
  DB_MAX = cfg.dbCeil;
  applyColorTheme(cfg.colorTheme);
  const csEl = document.querySelector('.callsign');
  if (csEl && cfg.callsign) csEl.textContent = cfg.callsign + ' · Thetis On The Web · Beta v.0.52';
  // Apply panel visibility
  applyPanelVisibility();
  // Apply greyline
  if (cfg.greyline) startGreyline(); else stopGreyline();
  closeModal('settingsModal');
  log('sys', 'Settings saved' + (cfg.callsign ? ' · ' + cfg.callsign : ''));
}

const SETTINGS_SCHEMA_VERSION = 2;
function migrateSettings(cfg) {
  cfg = (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
  if (!cfg.schemaVersion) cfg.schemaVersion = 1;
  if (cfg.schemaVersion < 2) {
    if (cfg.dxMaxAge == null) cfg.dxMaxAge = 30;
    if (cfg.digMarkers == null) cfg.digMarkers = true;
    cfg.schemaVersion = 2;
  }
  return cfg;
}

function getSettings() {
  try { return migrateSettings(JSON.parse(localStorage.getItem('totw_cfg_v1')) || {}); } catch(e) { return migrateSettings({}); }
}

// ── SETTINGS EXPORT ──
// Grabs the saved config and downloads it as a JSON file.
function exportSettings() {
  const cfg = getSettings();
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'totw-settings.json';
  a.click();
  // Release the object URL immediately after the click is dispatched
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  log('sys', 'Settings exported to totw-settings.json');
}

// ── SETTINGS IMPORT ──
// Reads a previously exported JSON file, saves it to localStorage, and applies it.
function importSettings(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const cfg = JSON.parse(ev.target.result);
      // Basic sanity check — must be a plain object, not an array or primitive
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        log('err', 'Import failed: file does not look like a TOTW settings export');
        return;
      }
      localStorage.setItem('totw_cfg_v1', JSON.stringify(migrateSettings(cfg)));
      applySettings();    // apply runtime effects (theme, markers, panels)
      loadSettingsUI();   // refresh all the modal fields so the user sees the new values
      log('sys', 'Settings imported — re-open Settings to verify');
    } catch(e) {
      log('err', 'Import failed: invalid JSON (' + e.message + ')');
    }
    input.value = ''; // reset so the same file can be re-imported if needed
  };
  reader.readAsText(file);
}

// ── SETTINGS RESET ──
// Clears all localStorage keys used by TOTW and reloads the page to apply defaults.
// A confirmation dialog prevents accidental resets.
function exportAllState() {
  const backup = {
    app: 'Thetis On The Web',
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    settings: getSettings(),
    state: (() => { try { return JSON.parse(localStorage.getItem('totw_v1')) || {}; } catch(e) { return {}; } })(),
    memories: (() => { try { return JSON.parse(localStorage.getItem(MEM_KEY)) || []; } catch(e) { return []; } })(),
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'totw-full-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  log('sys', 'Full backup exported');
}

function importAllState(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const backup = JSON.parse(ev.target.result);
      if (!backup || typeof backup !== 'object' || backup.app !== 'Thetis On The Web') {
        log('err', 'Full backup import failed: file is not a TOTW full backup');
        return;
      }
      if (backup.settings) localStorage.setItem('totw_cfg_v1', JSON.stringify(migrateSettings(backup.settings)));
      if (backup.state) localStorage.setItem('totw_v1', JSON.stringify(backup.state));
      if (Array.isArray(backup.memories)) localStorage.setItem(MEM_KEY, JSON.stringify(backup.memories));
      log('sys', 'Full backup imported; reloading...');
      setTimeout(() => location.reload(), 600);
    } catch(e) {
      log('err', 'Full backup import failed: ' + e.message);
    }
    input.value = '';
  };
  reader.readAsText(file);
}

function resetSettings() {
  if (!confirm('Reset ALL settings, layout, and state to defaults?\n\nThis cannot be undone — export first if you want to keep your settings.')) return;
  localStorage.removeItem('totw_cfg_v1');  // user preferences, themes, DX filters
  localStorage.removeItem('totw_v1');       // runtime state: VFO, mode, step, panel layout
  // Note: memories (totw_mem_v1) are intentionally kept — use the Memories panel to clear those
  log('sys', 'Settings reset to defaults — reloading…');
  setTimeout(() => location.reload(), 600);
}

function applySettings() {
  const cfg = getSettings();
  showDigMarkers = cfg.digMarkers !== false;
  if (cfg.dbFloor) DB_MIN = cfg.dbFloor;
  if (cfg.dbCeil)  DB_MAX = cfg.dbCeil;
  activeColorTheme = cfg.colorTheme || 'classic';
  applyColorTheme(activeColorTheme);
  activeUITheme = cfg.uiTheme || 'dark';
  applyUITheme(activeUITheme);
  if (cfg.callsign) {
    const csEl = document.querySelector('.callsign');
    if (csEl) csEl.textContent = cfg.callsign + ' · Thetis On The Web · Beta v.0.52';
  }
  // Panel visibility
  applyPanelVisibility();
  initTuningSlider();
  // Greyline map
  if (cfg.greyline) startGreyline();
}

// ── PANEL VISIBILITY ──
const PANELS = [
  { id: 'dpBands',    label: 'Bands',           def: true  },
  { id: 'dpVFO',      label: 'VFO',             def: true  },
  { id: 'dpStep',     label: 'Tune Step',       def: true  },
  { id: 'dpMode',     label: 'Mode',            def: true  },
  { id: 'dpTuning',   label: 'Tuning Slider',   def: false },
  { id: 'dpSMeter',   label: 'S-Meter',         def: true  },
  { id: 'dpSigBar',   label: 'Signal Bar',      def: true  },
  { id: 'dpNetwork',  label: 'Network',         def: true  },
  { id: 'dpAFGain',   label: 'AF Gain',         def: true  },
  { id: 'dpNR',       label: 'Noise Reduction', def: true  },
  { id: 'dpFilter',   label: 'Filter Width',    def: true  },
  { id: 'dpTCILog',   label: 'TCI Log',         def: true  },
  { id: 'dpTransmit', label: 'Transmit',        def: true  },
  { id: 'dpOptions',  label: 'Options',         def: true  },
  { id: 'dpTCIAudio', label: 'TCI Audio',       def: true  },
  { id: 'dpAntenna',  label: 'Antenna',         def: true  },
  { id: 'dpRX2',      label: 'Second Receiver', def: false },
  { id: 'dpDXCluster',label: 'DX Cluster',      def: true  },
  { id: 'dpMemories', label: 'Memories',        def: true  },
];

function applyPanelVisibility() {
  const cfg = getSettings();
  const vis = cfg.panelVis || {};
  PANELS.forEach(p => {
    const panel = el(p.id);
    if (!panel) return;
    const show = vis[p.id] !== undefined ? vis[p.id] : p.def;
    panel.classList.toggle('dp-hidden', !show);
  });
}

// ── SNAP TO STEP ──
function applyLayoutPreset(name) {
  const presets = {
    dx: ['dpBands','dpVFO','dpStep','dpMode','dpSMeter','dpSigBar','dpNetwork','dpAFGain','dpFilter','dpTCILog','dpTransmit','dpTCIAudio','dpDXCluster','dpMemories'],
    mobile: ['dpVFO','dpStep','dpMode','dpSMeter','dpAFGain','dpTransmit','dpTCIAudio','dpMemories'],
    full: PANELS.map(p => p.id),
  };
  const keep = new Set(presets[name] || presets.full);
  const cfg = getSettings();
  cfg.panelVis = Object.fromEntries(PANELS.map(p => [p.id, keep.has(p.id)]));
  localStorage.setItem('totw_cfg_v1', JSON.stringify(migrateSettings(cfg)));
  loadSettingsUI();
  applyPanelVisibility();
  log('sys', 'Layout preset applied: ' + name);
}

function snapToStep(hz, step) {
  if (!step || step <= 1) return Math.round(hz);
  return Math.round(hz / step) * step;
}

// ── PREVIEW VFO DISPLAY (no state change — used during drag/scroll) ──
function previewVfoDisp(vfo, hz) {
  hz = Math.max(0, hz);
  window['_previewHz' + vfo] = hz;
  const mhz = hz / 1e6;
  const whole = Math.floor(mhz).toString();
  // Use 4 decimal places (100 Hz resolution) — same format as the static display
  const dec = mhz.toFixed(4).split('.')[1];
  const disp = el('vfo' + vfo + 'Disp');
  if (!disp) return;
  disp.innerHTML = whole + '.' + dec + '<span class="mhz"> MHz</span>';
}

// ── TUNING SLIDER ──
function adjustFrequency(value) {
  const delta = parseInt(value) - sliderLastValue;
  if (delta === 0) return;
  const raw = S.vfoA + delta * S.step;
  const hz = Math.max(0, snapToStep(raw, S.step));
  bpIgnoreVfoUpdateUntil = Date.now() + 1000;
  setVfoDisp('A', hz);
  send('vfo:0,0,' + hz + ';');
  sliderLastValue = parseInt(value);
}

function resetSlider() {
  const slider = el('tuningSlider');
  if (slider) { slider.value = 0; sliderLastValue = 0; }
}

function initTuningSlider() {
  const lbl = el('tuningStepLabel');
  if (lbl) lbl.textContent = 'TUNE (' + (S.step >= 1000 ? (S.step/1000)+'kHz' : S.step+'Hz') + ')';
}

// ── GREYLINE MAP ──
let _greylineTimer = null;
window._greylineImg = null;

function loadGreyline() {
  const cfg = getSettings();
  if (!cfg.greyline) return;
  const url = (cfg.greylineUrl || 'https://pure-editions.com/on7off/greyline.jpg').trim();
  const img = new Image();
  img.onload = () => {
    window._greylineImg = img;
    log('sys', 'Greyline map loaded (' + img.naturalWidth + 'x' + img.naturalHeight + ')');
  };
  img.onerror = () => {
    log('sys', 'Greyline: failed to load image');
  };
  img.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
}

function startGreyline() {
  stopGreyline();
  loadGreyline();
  _greylineTimer = setInterval(loadGreyline, 5 * 60 * 1000);
}

function stopGreyline() {
  if (_greylineTimer) { clearInterval(_greylineTimer); _greylineTimer = null; }
  window._greylineImg = null;
}

// ── LOG ──
let logN=0;
function log(type, msg) {
  const box=el('tciLog');
  const div=document.createElement('div');
  div.className='log-'+type;
  const ts=new Date().toLocaleTimeString('en',{hour12:false});
  div.textContent=ts+'  '+msg;
  box.appendChild(div);
  box.scrollTop=box.scrollHeight;
  if (++logN>120) { box.removeChild(box.firstChild); logN--; }
}

function copyTciLog() {
  const lines = Array.from(el('tciLog').children).map(d => d.textContent).join('\n');
  navigator.clipboard.writeText(lines).then(() => {
    const btn = el('logCopyBtn');
    if (btn) { btn.textContent = 'COPIED'; setTimeout(() => { btn.textContent = 'COPY'; }, 1500); }
  }).catch(() => {
    // Fallback for browsers without clipboard API
    const ta = document.createElement('textarea');
    ta.value = lines;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    const btn = el('logCopyBtn');
    if (btn) { btn.textContent = 'COPIED'; setTimeout(() => { btn.textContent = 'COPY'; }, 1500); }
  });
}

function toggleLog() {
  const log = el('tciLog');
  const btn = el('logTogBtn');
  const hidden = log.style.display === 'none';
  log.style.display = hidden ? '' : 'none';
  btn.textContent = hidden ? 'HIDE' : 'SHOW';
}

function getDiagnostics() {
  const secure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return {
    version: (document.querySelector('.callsign') || {}).textContent || 'Thetis On The Web',
    location: location.href,
    secureContext: !!secure,
    websocketUrl: el('hostInput') ? el('hostInput').value : '',
    websocketState: S.ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][S.ws.readyState] : 'none',
    connected: S.connected,
    rxAudio: S.rxOn,
    txMicArmed: S.txMicOn,
    txStreaming: S.micStreaming,
    iqOn: S.iqOn,
    iqSampleRate: S.iqSR,
    iqFrames: IQ.frameCount,
    fftReady: IQ.fftReady,
    vfoA: S.vfoA,
    mode: S.mode,
    audioContext: S.audioCtx ? S.audioCtx.state : 'none',
    micContext: S.micCtx ? S.micCtx.state : 'none',
    mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    legacyGetUserMedia: !!(navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia),
    audioWorklet: !!window.AudioWorkletNode,
    wakeLock: !!navigator.wakeLock,
    userAgent: navigator.userAgent,
  };
}

// ── KEYBOARD ──
document.addEventListener('keydown', e => {
  if (e.target.tagName==='INPUT' || e.target.tagName==='SELECT' || e.target.tagName==='TEXTAREA') return;
  // Modals open — Esc handled by modal listener above
  const cfg = getSettings();
  const pttMode = cfg.pttMode || 'momentary';

  if (e.code === 'Space') {
    e.preventDefault();
    if (pttMode === 'toggle') { if (!e.repeat) setPTT(!S.mox); }
    else setPTT(true);
    return;
  }

  if (e.key === '?') { e.preventDefault(); openModal('keysModal'); return; }

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    const multiplier = e.ctrlKey ? 10 : 1;
    const hz = Math.max(0, S.vfoA + dir * S.step * multiplier);
    setVfoDisp('A', hz);
    send('vfo:0,0,' + hz + ';');
    return;
  }

  if (!e.ctrlKey && !e.altKey) {
    if (e.key === 'm' || e.key === 'M') { memSave(); return; }
    if (e.key === 'd' || e.key === 'D') {
      showDigMarkers = !showDigMarkers;
      const cfgEl = el('cfgDigMarkers'); if (cfgEl) cfgEl.checked = showDigMarkers;
      return;
    }
    if (e.key === 'x' || e.key === 'X') { togDXCluster(); return; }
    if (e.key === 'p' || e.key === 'P') { togglePeakHold(); return; }
    if (e.key === 'F1') { e.preventDefault(); memRecall(0); return; }
    if (e.key === 'F2') { e.preventDefault(); memRecall(1); return; }
    if (e.key === 'F3') { e.preventDefault(); memRecall(2); return; }
    if (e.key === 'F4') { e.preventDefault(); memRecall(3); return; }
  }
});
document.addEventListener('keyup', e => {
  if (e.target.tagName==='INPUT' || e.target.tagName==='SELECT') return;
  const cfg = getSettings();
  if (e.code === 'Space' && (cfg.pttMode || 'momentary') === 'momentary') setPTT(false);
});

// ── STATE PERSISTENCE ──
const STORE_KEY = 'totw_v1';
let _saveTimer = 0;

function saveState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function() {
    const ab = document.querySelector('#filtG .f-btn.active');
    const afEl = el('afSlider'), sgEl = el('specGainSlider');
    const wsEl = el('wfSpeedSlider'), fsEl = el('fftSmoothSlider');
    try {
      const scEl = el('smCalSlider');
      localStorage.setItem(STORE_KEY, JSON.stringify({
        vfoA: S.vfoA,
        vfoB: S.vfoB,
        mode: S.mode,
        step: S.step,
        filterBw: ab ? parseInt(ab.dataset.bw) : null,
        filterLo: parseInt(el('flo')?.value) || 100,
        filterHi: parseInt(el('fhi')?.value) || 2900,
        afGain: afEl ? parseInt(afEl.value) : -10,
        specGain: sgEl ? parseInt(sgEl.value) : 20,
        wfSpeed: wsEl ? parseInt(wsEl.value) : 17,
        fftSmooth: fsEl ? parseInt(fsEl.value) : 90,
        smCal: scEl ? parseInt(scEl.value) : 20,
        peakHold: peakHoldEnabled,
        wfTheme: wfTheme,
        specHeight: document.getElementById('specWrap') ? document.getElementById('specWrap').offsetHeight : 300,
        wfHeight: document.getElementById('wfWrap') ? document.getElementById('wfWrap').offsetHeight : 200,
        wsUrl: el('hostInput').value,
        // Save which panels are in the center-bottom dock zone and in what order
        centerDockIds: Array.from(document.querySelectorAll('#centerDock > .dock-panel')).map(p => p.id),
      }));
    } catch(e) {}
  }, 400);
}

function loadState() {
  let p;
  try { p = JSON.parse(localStorage.getItem(STORE_KEY)); } catch(e) {}
  if (!p) return;
  if (p.vfoA) { S.vfoA = p.vfoA; setVfoDisp('A', p.vfoA); }
  if (p.vfoB) { S.vfoB = p.vfoB; setVfoDisp('B', p.vfoB); }
  if (p.mode) { S.mode = p.mode; updMode(); }
  if (p.step) {
    S.step = p.step;
    document.querySelectorAll('#stepRow .sbtn').forEach(b =>
      b.classList.toggle('active', parseInt(b.dataset.hz) === p.step));
  }
  if (p.filterBw != null) {
    document.querySelectorAll('#filtG .f-btn').forEach(b =>
      b.classList.toggle('active', parseInt(b.dataset.bw) === p.filterBw));
  }
  if (p.filterLo != null) el('flo').value =p.filterLo;
  if (p.filterHi != null) el('fhi').value =p.filterHi;
  const afEl = el('afSlider');
  if (afEl && p.afGain != null) { afEl.value = p.afGain; el('afV').textContent = p.afGain + ' dB'; }
  const sgEl = el('specGainSlider');
  if (sgEl && p.specGain != null) { specGain = p.specGain; sgEl.value = p.specGain; el('specGainV').textContent = (p.specGain >= 0 ? '+' : '') + p.specGain + 'dB'; }
  const wsEl = el('wfSpeedSlider');
  if (wsEl && p.wfSpeed != null) { wfSpeed = p.wfSpeed; wsEl.value = p.wfSpeed; el('wfSpeedV').textContent = p.wfSpeed; }
  const fsEl = el('fftSmoothSlider');
  if (fsEl && p.fftSmooth != null) { IQ.smooth = p.fftSmooth / 100; fsEl.value = p.fftSmooth; el('fftSpeedV').textContent = p.fftSmooth + '%'; }
  const scEl = el('smCalSlider');
  if (scEl && p.smCal != null) { smCal = p.smCal; scEl.value = p.smCal; el('smCalV').textContent = (p.smCal >= 0 ? '+' : '') + p.smCal + 'dB'; }
  if (p.peakHold != null) { peakHoldEnabled = p.peakHold; const btn = el('peakHoldBtn'); if (btn) btn.classList.toggle('active', peakHoldEnabled); }
  if (p.wfTheme != null) setWfTheme(p.wfTheme);
  const specWrapEl = document.getElementById('specWrap');
  if (specWrapEl && p.specHeight) specWrapEl.style.height = Math.max(80, Math.min(800, p.specHeight)) + 'px';
  const wfWrapEl = document.getElementById('wfWrap');
  if (wfWrapEl && p.wfHeight) wfWrapEl.style.height = Math.max(40, Math.min(500, p.wfHeight)) + 'px';
  if (p.wsUrl) el('hostInput').value = p.wsUrl;
  // Restore panels that were dragged to the center-bottom dock zone
  if (Array.isArray(p.centerDockIds) && p.centerDockIds.length) {
    const centerDock = el('centerDock');
    if (centerDock) {
      p.centerDockIds.forEach(id => {
        const panel = el(id);
        if (panel) centerDock.appendChild(panel);
      });
    }
  }
}

// ── VERSION CHECK ──
// Fetches the raw totw.html from GitHub once on load and compares the version string.
// Shows a badge in the top bar if a newer version is available.
(function checkForUpdate() {
  // Extract current version number from the page title string (e.g. "Beta v.0.50" → 39)
  const match = document.title.match(/Beta v\.0\.(\d+)/) ||
                (document.querySelector('.callsign') || {}).textContent?.match(/Beta v\.0\.(\d+)/);
  const currentNum = match ? parseInt(match[1]) : 0;
  if (!currentNum) return;

  const RAW_URL = 'https://raw.githubusercontent.com/n9bc/thetis-on-the-web/main/totw.html';

  fetch(RAW_URL, { cache: 'no-store' })
    .then(r => r.text())
    .then(html => {
      const m = html.match(/Beta v\.0\.(\d+)/);
      if (!m) return;
      const remoteNum = parseInt(m[1]);
      if (remoteNum > currentNum) {
        const badge = el('updateBadge');
        if (badge) {
          badge.title = 'Beta v.0.' + remoteNum + ' is available — click to open releases page';
          badge.textContent = '⬆ Beta v.0.' + remoteNum + ' available';
          badge.style.display = 'inline-block';
        }
        // Show the backup-settings reminder button alongside the update badge
        const backupBtn = el('exportBeforeUpdate');
        if (backupBtn) backupBtn.style.display = 'inline-block';
      }
    })
    .catch(() => {}); // silently ignore network errors
})();

// ── INIT ──
window.addEventListener('load', () => {
  // Keep canvas pixel dimensions in sync with container size on window resize
  const resizeCanvases = () => {
    const specWrap = el('specC') && el('specC').parentElement;
    const wfWrap   = el('wfC')  && el('wfC').parentElement;
    if (specWrap) { el('specC').width = specWrap.offsetWidth; el('specC').height = specWrap.offsetHeight; }
    if (wfWrap)   { el('wfC').width = wfWrap.offsetWidth; el('wfC').height = wfWrap.offsetHeight; wfImg = null; }
  };
  resizeCanvases();
  window.addEventListener('resize', resizeCanvases);
  // Also observe the body-grid in case panels are rearranged
  if (window.ResizeObserver) {
    new ResizeObserver(resizeCanvases).observe(document.querySelector('.body-grid') || document.body);
  }

  loadState();

  drawSpec(); drawWF(); drawSmeter();
  runStartupChecks();
  attachSpectrumHoverReadout();

  // ── Spectrum canvas interaction (drag-to-tune, click-to-tune, touch, zoom) ──
  (function() {
    const cv = el('specC');
    let dragging = false, dragStartX = 0, dragStartY = 0, dragMoved = false;
    let lastSendTime = 0;
    let touchStartTime = 0;
    let isVerticalSwipe = false;

    function visRangeAtClientX(clientX) {
      const rect = cv.getBoundingClientRect();
      const xFrac = (clientX - rect.left) / rect.width;
      const SR = S.iqSR || 192000;
      const vSR = SR / specZoom;
      const vLo = (specZoomCentre || S.iqCentre) - vSR / 2;
      return vLo + xFrac * vSR;
    }

    function isInPassband(clientX) {
      if (!S.iqOn || !IQ.fftReady) return false;
      const clickHz = visRangeAtClientX(clientX);
      const flo = parseInt(el('flo')?.value) || 100;
      const fhi = parseInt(el('fhi')?.value) || 2900;
      const filterLoHz = S.vfoA + Math.min(flo, fhi);
      const filterHiHz = S.vfoA + Math.max(flo, fhi);
      return clickHz >= filterLoHz && clickHz <= filterHiHz;
    }

    // ── Mouse: drag inside passband = tune; click outside = tune ──
    cv.addEventListener('mousedown', function(e) {
      if (!S.iqOn || !IQ.fftReady) return;
      if (!isInPassband(e.clientX)) return;
      dragging = true;
      dragMoved = false;
      dragStartX = e.clientX;
      bpDragHzOffset = 0;
      bpDraggingInProgress = true;
      cv.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      const rect = cv.getBoundingClientRect();
      const dx = e.clientX - dragStartX;
      if (Math.abs(dx) > 3) dragMoved = true;
      if (!dragMoved) return;
      const SR = S.iqSR || 192000;
      const hzPerPx = (SR / specZoom) / rect.width;
      bpDragHzOffset = Math.round(dx * hzPerPx);
      const previewHz = snapToStep(S.vfoA + bpDragHzOffset, S.step);
      previewVfoDisp('A', Math.max(0, previewHz));
      // Rate-limit sends (max 20/sec)
      const now = Date.now();
      if (now - lastSendTime > 50) {
        send('vfo:0,0,' + Math.max(0, previewHz) + ';');
        lastSendTime = now;
      }
      // Auto-recenter IQ stream if VFO drifts near edges
      const loHz = S.iqCentre - SR / 2;
      const hiHz = S.iqCentre + SR / 2;
      const margin = SR * 0.15;
      if (previewHz < loHz + margin || previewHz > hiHz - margin) {
        send('dds:0,' + previewHz + ';');
        S.iqCentre = previewHz;
      }
    });

    document.addEventListener('mouseup', function(e) {
      if (!dragging) return;
      dragging = false;
      bpDraggingInProgress = false;
      cv.style.cursor = 'crosshair';
      if (dragMoved && bpDragHzOffset !== 0) {
        const newVfo = window._previewHzA || Math.max(0, snapToStep(S.vfoA + bpDragHzOffset, S.step));
        S.vfoA = newVfo;
        setVfoDisp('A', newVfo);
        send('vfo:0,0,' + newVfo + ';');
        bpIgnoreVfoUpdateUntil = Date.now() + 1000;
      } else if (!dragMoved && S.iqOn && IQ.fftReady) {
        const hz = Math.round(visRangeAtClientX(e.clientX));
        if (hz > 0) { S.vfoA = hz; setVfoDisp('A', hz); send('vfo:0,0,' + hz + ';'); bpIgnoreVfoUpdateUntil = Date.now() + 1000; }
      }
      bpDragHzOffset = 0;
      window._previewHzA = null;
      setTimeout(() => { dragMoved = false; }, 50);
    });

    // Click outside passband = click-to-tune
    cv.addEventListener('click', function(e) {
      if (dragMoved) return;
      if (!S.iqOn || !IQ.fftReady) return;
      if (isInPassband(e.clientX)) return;
      const hz = Math.round(visRangeAtClientX(e.clientX));
      if (hz > 0) { S.vfoA = hz; setVfoDisp('A', hz); send('vfo:0,0,' + hz + ';'); bpIgnoreVfoUpdateUntil = Date.now() + 1000; }
    });

    cv.style.cursor = 'crosshair';
    cv.addEventListener('mousemove', function(e) {
      if (dragging) return;
      if (!S.iqOn || !IQ.fftReady) return;
      cv.style.cursor = isInPassband(e.clientX) ? 'grab' : 'crosshair';
    });

    // ── Touch: vertical swipe = step tune; horizontal swipe = drag tune; quick tap = click-to-tune ──
    cv.addEventListener('touchstart', function(e) {
      if (!S.iqOn) return;
      const touch = e.touches[0];
      dragStartX = touch.clientX;
      dragStartY = touch.clientY;
      dragMoved = false;
      bpDragHzOffset = 0;
      bpDraggingInProgress = true;
      isVerticalSwipe = false;
      touchStartTime = Date.now();
      e.preventDefault();
    }, { passive: false });

    // Track pinch state for two-finger zoom on the spectrum canvas
    let pinchStartDist = 0;
    let pinchStartZoom = 1;
    let isPinching = false;

    cv.addEventListener('touchmove', function(e) {
      if (!bpDraggingInProgress) return;
      e.preventDefault();

      // ── Two-finger pinch: zoom the panadapter in/out ──────────────────────
      // Mirrors the Ctrl+scroll zoom formula so the same zoom levels are used.
      if (e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        if (!isPinching) {
          // First frame of pinch — record baseline
          isPinching = true;
          pinchStartDist = dist;
          pinchStartZoom = specZoom;
          dragMoved = true; // suppress tap-to-tune on release
        }
        // Scale factor relative to when the pinch started
        const scale = dist / pinchStartDist;
        let newZoom = pinchStartZoom * scale;
        // Snap to nearest power-of-2 zoom level (1, 2, 4, 8, 16, 32)
        newZoom = Math.max(1, Math.min(32, newZoom));
        newZoom = Math.pow(2, Math.round(Math.log2(newZoom)));
        specZoom = newZoom;
        // Centre the zoomed view on VFO A frequency
        if (specZoom > 1) specZoomCentre = S.vfoA;
        else specZoomCentre = S.iqCentre;
        return; // don't process single-touch tune while pinching
      }

      // ── One-finger swipe: step tune (vertical) or drag tune (horizontal) ──
      isPinching = false; // reset pinch state when fingers reduce to one

      const touch = e.touches[0];
      const dx = touch.clientX - dragStartX;
      const dy = touch.clientY - dragStartY;
      const absDx = Math.abs(dx), absDy = Math.abs(dy);

      if (!dragMoved) {
        if (absDy > absDx && absDy > 10) { dragMoved = true; isVerticalSwipe = true; }
        else if (absDx > 3) { dragMoved = true; isVerticalSwipe = false; }
      }
      if (!dragMoved) return;

      if (isVerticalSwipe) {
        // Swipe up = frequency up, swipe down = frequency down
        const dir = dy > 0 ? -1 : 1;
        bpDragHzOffset += dir * S.step;
        bpDragHzOffset = snapToStep(bpDragHzOffset, S.step);
        previewVfoDisp('A', Math.max(0, snapToStep(S.vfoA + bpDragHzOffset, S.step)));
      } else {
        // Horizontal drag = continuous tune
        const SR = S.iqSR || 192000;
        const hzPerPx = (SR / specZoom) / cv.getBoundingClientRect().width;
        bpDragHzOffset = Math.round(dx * hzPerPx);
        previewVfoDisp('A', Math.max(0, snapToStep(S.vfoA + bpDragHzOffset, S.step)));
      }
    }, { passive: false });

    cv.addEventListener('touchend', function(e) {
      if (!bpDraggingInProgress) return;
      bpDraggingInProgress = false;
      isPinching = false; // always reset pinch state on lift

      if (dragMoved && bpDragHzOffset !== 0) {
        const newVfo = window._previewHzA || Math.max(0, snapToStep(S.vfoA + bpDragHzOffset, S.step));
        S.vfoA = newVfo;
        setVfoDisp('A', newVfo);
        send('vfo:0,0,' + newVfo + ';');
        bpIgnoreVfoUpdateUntil = Date.now() + 1000;
      } else if (!dragMoved && Date.now() - touchStartTime < 300) {
        // Quick tap = click-to-tune (outside passband only)
        const touch = e.changedTouches[0];
        if (!isInPassband(touch.clientX)) {
          const hz = Math.round(visRangeAtClientX(touch.clientX));
          if (hz > 0) { S.vfoA = hz; setVfoDisp('A', hz); send('vfo:0,0,' + hz + ';'); bpIgnoreVfoUpdateUntil = Date.now() + 1000; }
        }
      }

      bpDragHzOffset = 0;
      window._previewHzA = null;
      isVerticalSwipe = false;
      setTimeout(() => { dragMoved = false; }, 50);
    });
  })();

  // Click-to-tune on waterfall canvas
  el('wfC').addEventListener('click', function(e) {
    if (!S.iqOn || !IQ.fftReady) return;
    const rect = this.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    const SR = S.iqSR || 192000;
    const hz = Math.round(S.iqCentre - SR / 2 + xFrac * SR);
    if (hz > 0) { S.vfoA = hz; setVfoDisp('A', hz); send('vfo:0,0,' + hz + ';'); bpIgnoreVfoUpdateUntil = Date.now() + 1000; }
  });
  el('wfC').style.cursor = 'crosshair';

  // ── Scroll-to-tune (with debounce) / Ctrl+scroll-to-zoom on spectrum ──
  el('specC').addEventListener('wheel', function(e) {
    e.preventDefault();
    if (!S.iqOn || !IQ.fftReady) return;
    if (e.ctrlKey) {
      // Ctrl+wheel = zoom in/out centred on cursor
      const rect = this.getBoundingClientRect();
      const xFrac = (e.clientX - rect.left) / rect.width;
      const SR = S.iqSR || 192000;
      const vSR = SR / specZoom;
      const vLo = (specZoomCentre || S.iqCentre) - vSR / 2;
      const mouseHz = vLo + xFrac * vSR;
      const factor = e.deltaY < 0 ? 2 : 0.5;
      specZoom = Math.max(1, Math.min(32, specZoom * factor));
      specZoom = Math.pow(2, Math.round(Math.log2(specZoom)));
      if (specZoom > 1) specZoomCentre = mouseHz;
      else specZoomCentre = S.iqCentre;
    } else {
      // Plain wheel = step tune — commit VFO immediately (rate-limited) and pan spectrum
      const dir = e.deltaY < 0 ? 1 : -1;
      const newVfo = Math.max(0, snapToStep(S.vfoA + dir * S.step, S.step));
      S.vfoA = newVfo;
      setVfoDisp('A', newVfo);

      // Pan zoomed spectrum to follow VFO on every tick so the cursor never hits the edge
      if (specZoom > 1) specZoomCentre = newVfo;

      const now = Date.now();
      // Rate-limit TCI sends to ~20 per second to avoid flooding the radio
      if (now - _wheelLastSend >= 50) {
        send('vfo:0,0,' + newVfo + ';');
        bpIgnoreVfoUpdateUntil = now + 500;
        _wheelLastSend = now;
        if (_wheelCommitTimer) { clearTimeout(_wheelCommitTimer); _wheelCommitTimer = null; }
      } else {
        // Always queue a trailing send so the final resting frequency is committed
        if (_wheelCommitTimer) clearTimeout(_wheelCommitTimer);
        _wheelCommitTimer = setTimeout(() => {
          send('vfo:0,0,' + S.vfoA + ';');
          bpIgnoreVfoUpdateUntil = Date.now() + 500;
          _wheelCommitTimer = null; _wheelLastSend = Date.now();
        }, 120);
      }

      // Recenter IQ when VFO drifts within 25% of an edge — keeps IQ data fresh
      const SR = S.iqSR || 192000;
      const margin = SR * 0.25;
      if (newVfo < S.iqCentre - SR / 2 + margin || newVfo > S.iqCentre + SR / 2 - margin) {
        S.iqCentre = newVfo;
        if (specZoom > 1) specZoomCentre = newVfo;
      }
    }
  }, { passive: false });

  // Double-click spectrum to reset zoom
  el('specC').addEventListener('dblclick', function(e) {
    if (specZoom > 1) { specZoom = 1; specZoomCentre = S.iqCentre; e.preventDefault(); }
  });

  // Load memories and settings
  loadMemories();
  renderMemShort();
  applySettings();
  // Highlight the correct band button for the initial VFO frequency
  updBandButtons(S.vfoA);

  // Auto-connect if configured
  const cfg = getSettings();
  if (cfg.autoConn) { setTimeout(toggleConn, 800); }

  log('sys','Thetis On The Web — ready');
  log('sys','Press ? for keyboard shortcuts');
  log('sys','Enter ws://[pc-ip]:50001 above, then click CONNECT');
});

// ── DOCK PANEL SNAP SYSTEM ──
(function() {
  let dragPanel = null, clone = null, ox = 0, oy = 0;
  let dropTarget = null; // { parent, before } — where to insert on drop

  // All droppable columns (left/right side panels + center-bottom dock + freq dock)
  function getColumns() {
    return Array.from(document.querySelectorAll('.side-panel, .center-dock, .freq-dock'));
  }

  // Horizontal zones lay panels side by side — use x position for slot detection
  function isHorizZone(col) {
    return col.classList.contains('center-dock') || col.classList.contains('freq-dock');
  }

  // Get all drop slots in a column
  function getSlots(col) {
    const horiz = isHorizZone(col);
    const panels = Array.from(col.querySelectorAll(':scope > .dock-panel'));
    return panels.map(p => {
      const r = p.getBoundingClientRect();
      return { pos: horiz ? r.left + r.width / 2 : r.top + r.height / 2, before: p, parent: col };
    }).concat([{ pos: Infinity, before: null, parent: col }]);
  }

  // Show/hide drop indicator
  function clearIndicators() {
    document.querySelectorAll('.dock-drop-indicator').forEach(d => d.classList.remove('active'));
  }

  function showIndicator(parent, before) {
    clearIndicators();
    let ind;
    if (before) {
      ind = before.previousElementSibling;
      if (!ind || !ind.classList.contains('dock-drop-indicator')) {
        ind = before.parentElement.querySelector('.dock-drop-indicator[data-before="'+before.dataset.dockId+'"]');
      }
    } else {
      ind = parent.querySelector('.dock-drop-indicator[data-before="end"]');
    }
    if (ind) ind.classList.add('active');
  }

  function insertIndicators() {
    getColumns().forEach(col => {
      const panels = Array.from(col.querySelectorAll(':scope > .dock-panel'));
      // Remove old indicators
      col.querySelectorAll('.dock-drop-indicator').forEach(d => d.remove());
      // Add before each panel
      panels.forEach(p => {
        const ind = document.createElement('div');
        ind.className = 'dock-drop-indicator';
        ind.dataset.before = p.dataset.dockId;
        col.insertBefore(ind, p);
      });
      // Add at end
      const endInd = document.createElement('div');
      endInd.className = 'dock-drop-indicator';
      endInd.dataset.before = 'end';
      col.appendChild(endInd);
    });
  }

  function removeIndicators() {
    document.querySelectorAll('.dock-drop-indicator').forEach(d => d.remove());
  }

  function findDropTarget(cx, cy) {
    const cols = getColumns();
    // Use 2D distance so overlapping columns (freq-dock spans full width) resolve correctly
    let bestCol = null, bestDist = Infinity;
    cols.forEach(col => {
      const r = col.getBoundingClientRect();
      const dx = Math.max(0, r.left - cx, cx - r.right);
      const dy = Math.max(0, r.top - cy, cy - r.bottom);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) { bestDist = dist; bestCol = col; }
    });
    if (!bestCol) return null;

    // For horizontal zones use cursor x; vertical zones use cursor y
    const cursor = isHorizZone(bestCol) ? cx : cy;
    const slots = getSlots(bestCol);
    let best = slots[slots.length - 1];
    for (const slot of slots) {
      if (cursor < slot.pos) { best = slot; break; }
    }
    return best;
  }

  function initPanel(panel) {
    const handle = panel.querySelector('.dock-handle');
    const colBtn = panel.querySelector('.dock-collapse');
    if (!handle) return;

    // Collapse/expand on button click or double-click handle
    if (colBtn) colBtn.addEventListener('click', e => {
      e.stopPropagation();
      const arrow = panel.classList.toggle('collapsed') ? '▸' : '▾';
      colBtn.textContent = arrow;
    });
    handle.addEventListener('dblclick', () => {
      const arrow = panel.classList.toggle('collapsed') ? '▸' : '▾';
      if (colBtn) colBtn.textContent = arrow;
    });

    handle.addEventListener('mousedown', e => {
      if (e.target === colBtn) return;
      e.preventDefault();
      dragPanel = panel;

      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;

      // Create visual clone
      clone = panel.cloneNode(true);
      clone.id = 'dock-drag-clone';
      clone.style.width = r.width + 'px';
      clone.style.left  = r.left + 'px';
      clone.style.top   = r.top + 'px';
      document.body.appendChild(clone);

      // Ghost the original
      panel.classList.add('dragging-ghost');

      // Insert drop indicators
      insertIndicators();
    });
  }

  document.addEventListener('mousemove', e => {
    if (!dragPanel || !clone) return;
    clone.style.left = (e.clientX - ox) + 'px';
    clone.style.top  = (e.clientY - oy) + 'px';

    const target = findDropTarget(e.clientX, e.clientY);
    if (target) {
      dropTarget = target;
      // Highlight correct indicator
      clearIndicators();
      const beforeId = target.before ? target.before.dataset.dockId : 'end';
      const ind = target.parent.querySelector('.dock-drop-indicator[data-before="'+beforeId+'"]');
      if (ind) ind.classList.add('active');
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragPanel) return;

    // Remove clone and ghost
    if (clone) { clone.remove(); clone = null; }
    dragPanel.classList.remove('dragging-ghost');

    // Snap into drop position
    if (dropTarget) {
      const { parent, before } = dropTarget;
      parent.insertBefore(dragPanel, before || null);
      // Persist the new dock layout (including center-dock membership)
      saveState();
    }

    removeIndicators();
    dragPanel = null;
    dropTarget = null;
  });

  window.addEventListener('load', () => {
    document.querySelectorAll('.dock-panel').forEach((p, i) => {
      p.dataset.dockId = 'dp' + i;
      initPanel(p);
    });

    // Touch swipe on VFO display for tuning (swipe up = higher freq)
    let _tvY = null;
    ['vfoADisp','vfoBDisp'].forEach(id => {
      const e2 = document.getElementById(id);
      if (!e2) return;
      e2.addEventListener('touchstart', ev => { _tvY = ev.touches[0].clientY; ev.preventDefault(); }, { passive: false });
      e2.addEventListener('touchmove', ev => {
        if (_tvY === null) return;
        const dy = _tvY - ev.touches[0].clientY;
        if (Math.abs(dy) > 4) {
          const vfo = id === 'vfoADisp' ? 'A' : 'B';
          const hz = Math.max(0, (vfo==='A'?S.vfoA:S.vfoB) + Math.sign(dy) * S.step);
          setVfoDisp(vfo, hz);
          send('vfo:0,'+(vfo==='A'?'0':'1')+','+hz+';');
          _tvY = ev.touches[0].clientY;
        }
        ev.preventDefault();
      }, { passive: false });
      e2.addEventListener('touchend', () => { _tvY = null; });
    });
  });
})();

// ── SPECTRUM RESIZE HANDLE ──
(function() {
  const handle = document.getElementById('specResizeHandle');
  const specWrap = document.getElementById('specWrap');
  if (!handle || !specWrap) return;
  let dragging = false, startY = 0, startH = 0;

  handle.addEventListener('mousedown', function(e) {
    dragging = true;
    startY = e.clientY;
    startH = specWrap.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  handle.addEventListener('touchstart', function(e) {
    dragging = true;
    startY = e.touches[0].clientY;
    startH = specWrap.offsetHeight;
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    const newH = Math.max(80, Math.min(800, startH + (e.clientY - startY)));
    specWrap.style.height = newH + 'px';
    const specC = document.getElementById('specC');
    if (specC) { specC.width = specWrap.offsetWidth; specC.height = specWrap.offsetHeight; }
  });

  document.addEventListener('touchmove', function(e) {
    if (!dragging) return;
    const newH = Math.max(80, Math.min(800, startH + (e.touches[0].clientY - startY)));
    specWrap.style.height = newH + 'px';
    const specC = document.getElementById('specC');
    if (specC) { specC.width = specWrap.offsetWidth; specC.height = specWrap.offsetHeight; }
  }, { passive: true });

  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveState();
  }
  document.addEventListener('mouseup', stopDrag);
  document.addEventListener('touchend', stopDrag);
})();

// ── WATERFALL RESIZE HANDLE ──
(function() {
  const handle = document.getElementById('wfResizeHandle');
  const wfWrap = document.getElementById('wfWrap');
  if (!handle || !wfWrap) return;
  let dragging = false, startY = 0, startH = 0;

  handle.addEventListener('mousedown', function(e) {
    dragging = true;
    startY = e.clientY;
    startH = wfWrap.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  // Touch support
  handle.addEventListener('touchstart', function(e) {
    dragging = true;
    startY = e.touches[0].clientY;
    startH = wfWrap.offsetHeight;
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    const newH = Math.max(40, Math.min(500, startH + (e.clientY - startY)));
    wfWrap.style.height = newH + 'px';
    // Trigger canvas size sync — also clear wfImg so drawWF rebuilds at new dimensions
    const wfC = document.getElementById('wfC');
    if (wfC) { wfC.width = wfWrap.offsetWidth; wfC.height = wfWrap.offsetHeight; wfImg = null; }
  });

  document.addEventListener('touchmove', function(e) {
    if (!dragging) return;
    const newH = Math.max(40, Math.min(500, startH + (e.touches[0].clientY - startY)));
    wfWrap.style.height = newH + 'px';
    const wfC = document.getElementById('wfC');
    if (wfC) { wfC.width = wfWrap.offsetWidth; wfC.height = wfWrap.offsetHeight; wfImg = null; }
  }, { passive: true });

  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveState();
  }
  document.addEventListener('mouseup', stopDrag);
  document.addEventListener('touchend', stopDrag);
})();

// ── SLIDER WHEEL CONTROL ──
// Hovering any <input type="range"> and scrolling the mouse wheel nudges it
// by one step. We dispatch a synthetic 'input' event so existing oninput
// handlers (gain display updates, saveState, etc.) still fire normally.
document.addEventListener('wheel', function(e) {
  const t = e.target;
  if (t.tagName !== 'INPUT' || t.type !== 'range') return;
  e.preventDefault(); // stop the page from scrolling while adjusting a slider
  const step  = parseFloat(t.step)  || 1;
  const min   = parseFloat(t.min);
  const max   = parseFloat(t.max);
  // Scroll up (negative deltaY) = increase; scroll down = decrease
  const delta = e.deltaY < 0 ? step : -step;
  t.value = Math.min(max, Math.max(min, parseFloat(t.value) + delta));
  t.dispatchEvent(new Event('input', { bubbles: true }));
}, { passive: false });

// ── RAF CLEANUP ──
// Cancel all animation loops when the tab/window is closed so the browser
// doesn't keep running draw callbacks on an unloaded page.
// ── MOBILE TOUCH OPTIMIZATIONS ──────────────────────────────────────────────

// Detect touch-capable device and activate touch layout via CSS data attribute.
// Two-part test: device must report touch points AND have a narrow screen.
// This correctly activates on phones (≤480px) and tablets (≤1100px) while
// excluding Windows touchscreen laptops and monitors (typically ≥1200px wide).
if ((navigator.maxTouchPoints > 0 || ('ontouchstart' in window)) && window.innerWidth <= 1100) {
  document.documentElement.setAttribute('data-touch', '1');
  // Initialise VFO knob once DOM is ready (it may already be ready at this point)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVfoKnob);
  } else {
    initVfoKnob();
  }
}

// ── iOS AudioContext unlock ───────────────────────────────────────────────────
// iOS Safari (and some Android browsers) require AudioContext.resume() to be
// called synchronously inside a user-gesture event handler. The TCI audio path
// creates the AudioContext from a WebSocket callback — not a gesture — so it
// lands in 'suspended' state and can never be resumed automatically.
//
// Strategy:
//   1. On the very first touchstart, eagerly create an AudioContext and resume()
//      it while we're still inside the gesture. Store it in _preUnlockedAudioCtx.
//   2. startRx() checks for _preUnlockedAudioCtx first and reuses it, so the
//      context is already running by the time audio frames arrive.
//   3. On every subsequent touch, if S.audioCtx is suspended (e.g. after the
//      app was backgrounded), resume it — again while inside the gesture.
let _iosAudioUnlocked = false;
document.addEventListener('touchstart', function() {
  // Case A: audio already running but suspended (e.g. phone call / background)
  if (S.audioCtx && S.audioCtx.state === 'suspended') {
    S.audioCtx.resume().then(() => log('sys', 'AudioContext resumed via touch'));
    return;
  }
  // Case B: first touch before any connection — pre-unlock a context for startRx()
  if (!_iosAudioUnlocked && !S.audioCtx) {
    _iosAudioUnlocked = true;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      ctx.resume().then(() => {
        window._preUnlockedAudioCtx = ctx;
        log('sys', 'iOS: AudioContext pre-unlocked and ready');
      }).catch(() => {});
    } catch(e) {}
  }
}, { passive: true });

// ── toggleMobileDrawer ───────────────────────────────────────────────────────
// Opens/closes the slide-up controls drawer and syncs the menu button style.
function toggleMobileDrawer() {
  const drawer   = el('mobileDrawer');
  const backdrop = el('mobileDrawerBackdrop');
  const btn      = el('mobileMenuBtn');
  if (!drawer) return;
  const isOpen = drawer.classList.toggle('open');
  backdrop.classList.toggle('open', isOpen);
  btn.classList.toggle('open', isOpen);

  // When opening, sync the mobile AF slider to the current desktop slider value
  if (isOpen) {
    const desktopSlider = el('afSlider');
    const mobileSlider  = el('afSliderMobile');
    if (desktopSlider && mobileSlider) {
      mobileSlider.value = desktopSlider.value;
      el('afVMobile').textContent = desktopSlider.value + ' dB';
    }
  }
}

// ── updateMobileBar ──────────────────────────────────────────────────────────
// Keeps the mobile bar frequency and mode readouts in sync with VFO A.
// Called by setVfoDisp hook and mode-change events.
function updateMobileBar() {
  const freqEl = el('mobileBarFreq');
  const infoEl = el('mobileBarInfo');
  if (!freqEl) return;

  // Format: "14.225.00" — whole MHz . first 3 dec . last 2 dec
  const hz = S.vfoA || 0;
  const mhz = hz / 1e6;
  const whole = Math.floor(mhz).toString();
  const dec = mhz.toFixed(4).split('.')[1];          // "2250" for 14.2250 MHz
  freqEl.textContent = whole + '.' + dec.slice(0, 3) + '.' + dec.slice(3);

  // Mode and band info
  if (infoEl) {
    const bandEl = document.querySelector('.band-btn.active');
    const bandLabel = bandEl ? bandEl.dataset.band : '';
    infoEl.textContent = (S.mode || 'USB') + (bandLabel ? ' · ' + bandLabel : '');
  }
}

// ── initVfoKnob ──────────────────────────────────────────────────────────────
// Draws a canvas-based rotary knob and maps touch rotation to VFO frequency.
// Full revolution (2π rad) = 100 tune steps in the current step size.
function initVfoKnob() {
  const canvas = el('vfoKnob');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let knobAngle = -Math.PI / 2;  // 12 o'clock start position
  let lastTouchAngle = null;
  let knobTouchId = null;

  // Draw the knob face — called on every touch move to animate the notch
  function drawKnob(angle) {
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) / 2 - 3;

    ctx.clearRect(0, 0, W, H);

    // Outer bezel ring
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = '#21262d';
    ctx.fill();
    ctx.strokeStyle = '#388bfd';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner knob body
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.76, 0, Math.PI * 2);
    ctx.fillStyle = '#2d333b';
    ctx.fill();

    // Tick marks around the bezel (every 30°)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r1 = R * 0.88, r2 = R * 0.98;
      ctx.beginPath();
      ctx.moveTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
      ctx.lineTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a));
      ctx.strokeStyle = '#484f58';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Notch line — rotates with touch angle to show knob position
    const notchLen = R * 0.62;
    ctx.beginPath();
    ctx.moveTo(cx + 4 * Math.cos(angle), cy + 4 * Math.sin(angle));
    ctx.lineTo(cx + notchLen * Math.cos(angle), cy + notchLen * Math.sin(angle));
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#58a6ff';
    ctx.fill();
  }

  drawKnob(knobAngle);

  // Touch start — record the initial angle from canvas centre to finger
  canvas.addEventListener('touchstart', function(e) {
    e.preventDefault();
    const t = e.changedTouches[0];
    knobTouchId = t.identifier;
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    lastTouchAngle = Math.atan2(t.clientY - cy, t.clientX - cx);
  }, { passive: false });

  // Touch move — compute angle delta → tune step → send VFO
  canvas.addEventListener('touchmove', function(e) {
    e.preventDefault();
    if (lastTouchAngle === null) return;

    // Find our tracked finger in the changed touches list
    let t = null;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === knobTouchId) { t = e.changedTouches[i]; break; }
    }
    if (!t) return;

    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const curAngle = Math.atan2(t.clientY - cy, t.clientX - cx);

    // Angle delta with wrap-around correction (±π boundary)
    let delta = curAngle - lastTouchAngle;
    if (delta >  Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;

    lastTouchAngle = curAngle;
    knobAngle += delta;
    drawKnob(knobAngle);

    // Map: one full revolution = 100 tune steps (speed-sensitive)
    const stepsFloat = (delta / (2 * Math.PI)) * 100;
    const hzDelta = stepsFloat * (S.step || 500);
    const newVfo = Math.max(0, snapToStep(S.vfoA + hzDelta, S.step || 500));
    S.vfoA = newVfo;
    setVfoDisp('A', newVfo);

    // Rate-limit TCI sends to ~20/sec to avoid flooding the radio
    const now = Date.now();
    if (!window._knobLastSend || now - window._knobLastSend > 50) {
      send('vfo:0,0,' + newVfo + ';');
      bpIgnoreVfoUpdateUntil = now + 500;
      window._knobLastSend = now;
    }
  }, { passive: false });

  // Touch end — flush final frequency to radio
  canvas.addEventListener('touchend', function() {
    if (S.vfoA > 0) {
      send('vfo:0,0,' + S.vfoA + ';');
      bpIgnoreVfoUpdateUntil = Date.now() + 500;
    }
    lastTouchAngle = null;
    knobTouchId = null;
  });
}

// ── END MOBILE TOUCH OPTIMIZATIONS ──────────────────────────────────────────

window.addEventListener('unload', () => {
  cancelAnimationFrame(smRAF);
  cancelAnimationFrame(specRAF);
  cancelAnimationFrame(wfRAF);
});
