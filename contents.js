// ─── PanoLearn v4.1 Content Script ───────────────────────────────────────────
// Caption-grounded AI study notes for Canvas + Panopto

(function () {
  'use strict';

  let panelInjected = false;
  let panolearnTranscriptCache = '';
  let panolearnSnifferInstalled = false;

  function isPanoptoUrl(url) {
    return typeof url === 'string' && (url.includes('panopto.com') || url.includes('/Panopto/'));
  }

  function extractVideoId(url) {
    if (!url) return null;
    const m =
      url.match(/[?&]id=([a-f0-9-]{36})/i) ||
      url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    return m ? m[1] : null;
  }

  function extractBaseUrl(url) {
    try { return new URL(url).origin; } catch { return null; }
  }

  function extractPanoptoUrl() {
    if (isPanoptoUrl(window.location.href)) return window.location.href;
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || f.getAttribute('data-src') || '';
      if (isPanoptoUrl(src)) return src;
    }
    const link = document.querySelector('a[href*="panopto"], a[href*="Panopto"]');
    if (link?.href) return link.href;
    return null;
  }

  function extractPageTitle() {
    return (
      document.querySelector('.assignment-title')?.textContent ||
      document.querySelector('h1.title')?.textContent ||
      document.querySelector('#assignment_title')?.value ||
      document.title ||
      'Panopto Recording'
    ).trim().replace(/[–|]\s*Canvas.*$/i, '').trim();
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function wordCount(text) {
    if (!text || !text.trim()) return 0;
    return text.trim().split(/\s+/).length;
  }

  function showError(panel, msg) {
    const el = panel.querySelector('#pl-error');
    if (!el) return;
    el.textContent = 'Warning: ' + msg;
    el.style.display = 'block';
  }

  function hideError(panel) {
    const el = panel.querySelector('#pl-error');
    if (!el) return;
    el.textContent = '';
    el.style.display = 'none';
  }

  function safeJsonParse(raw) {
    const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Model did not return valid JSON.');
    }
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  }

  function looksLikeTranscript(text) {
    const t = String(text || '');
    return (
      t.length > 150 && (
        /WEBVTT/.test(t) ||
        /\b\d{1,2}:\d{2}\b/.test(t) ||
        /Auto-generated captions/i.test(t) ||
        /"Caption"|(\bcaption\b)|(\btranscript\b)|(\bsubtitle\b)/i.test(t)
      )
    );
  }

  function normalizeTranscriptText(raw) {
    return String(raw || '')
      .replace(/WEBVTT[\s\S]*?\n\n/, '')
      .replace(/^\d+\s*\n/gm, '')
      .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/gm, '')
      .replace(/\d{1,2}:\d{2}:\d{2}\s*-->\s*\d{1,2}:\d{2}:\d{2}/gm, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/Auto-generated captions may contain errors\.?/gi, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+\n/g, '\n')
      .replace(/\n\s+/g, '\n')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 200000);
  }

  function parseTimestampToSeconds(ts) {
    const m = String(ts || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function installPanoptoNetworkSniffer() {
    if (panolearnSnifferInstalled) return;
    panolearnSnifferInstalled = true;

    window.addEventListener('message', event => {
      if (event.source !== window) return;
      if (!event.data || event.data.source !== 'PanoLearnSniffer') return;
      const body = String(event.data.body || '');
      if (!looksLikeTranscript(body)) return;
      const normalized = normalizeTranscriptText(body);
      if (normalized.length > panolearnTranscriptCache.length) {
        panolearnTranscriptCache = normalized;
        console.log('PanoLearn: transcript sniffed from network');
      }
    });

    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('sniffer.js');
      (document.head || document.documentElement).appendChild(script);
      script.onload = () => script.remove();
    } catch(e) {
      console.log('PanoLearn: sniffer inject failed', e);
    }
  }

  async function fetchCaptions(panoptoUrl, videoId) {
    installPanoptoNetworkSniffer();

    await tryClickCaptionTab();
    await new Promise(r => setTimeout(r, 2500));

    if (panolearnTranscriptCache && panolearnTranscriptCache.length > 200) {
      console.log('PanoLearn: using sniffed transcript');
      return panolearnTranscriptCache.slice(0, 20000);
    }

    const base = extractBaseUrl(panoptoUrl);
    if (base && videoId) {
      const candidates = [
        `${base}/Panopto/api/v1/sessions/${videoId}/captions`,
        `${base}/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${videoId}`,
        `${base}/Panopto/api/v1/sessions/${videoId}/transcript`,
        `${base}/Panopto/Pages/Viewer/Captions.ashx?id=${videoId}`
      ];
      for (const url of candidates) {
        try {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) continue;
          const text = await r.text();
          const normalized = normalizeTranscriptText(text);
          if (normalized.length > 200) {
            console.log('PanoLearn: using endpoint transcript', url);
            return normalized.slice(0, 20000);
          }
        } catch (e) {
          console.log('PanoLearn endpoint failed:', url, e);
        }
      }
    }

    try {
      const domText = await scrapeAllCaptionsByScrolling();
      if (domText && domText.length > 200) {
        console.log('PanoLearn: using DOM-scraped transcript');
        return domText.slice(0, 20000);
      }
    } catch (e) {
      console.log('PanoLearn DOM scrape error:', e);
    }

    return null;
  }

  async function scrapeAllCaptionsByScrolling() {
    const panel = document.getElementById('secondaryTab-captions') || findBestCaptionPanel();
    if (!panel) { console.error('PanoLearn: Could not locate the caption tab.'); return null; }

    const collected = new Map();
    const scrollContainer = panel.closest('.event-tab-pane') || panel;
    const totalHeight = Math.max(scrollContainer.scrollHeight, 1000);
    const step = 300;

    for (let y = 0; y <= totalHeight; y += step) {
      scrollContainer.scrollTop = y;
      await new Promise(r => setTimeout(r, 180));

      const rows = panel.querySelectorAll('.event-row, [class*="caption-row"]');
      rows.forEach(row => {
        const timeEl = row.querySelector('.event-time, .time');
        const textEl = row.querySelector('.event-text, .text');
        if (timeEl && textEl) {
          const seconds = parseTimestampToSeconds(timeEl.textContent.trim());
          if (seconds !== null) collected.set(seconds, textEl.textContent.trim());
        }
      });

      collectVisibleCaptionRows(panel, collected);
    }

    scrollContainer.scrollTop = 0;

    const finalTranscript = Array.from(collected.entries())
      .sort((a, b) => a[0] - b[0])
      .map(entry => entry[1])
      .join(' ');

    return finalTranscript.length > 100 ? finalTranscript : null;
  }

  function findBestCaptionPanel() {
    const allNodes = [...document.querySelectorAll('*')];
    const timeNodes = allNodes.filter(el => {
      const txt = (el.textContent || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(txt)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 10 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (!timeNodes.length) return null;

    const scoreMap = new Map();
    for (const timeEl of timeNodes) {
      let p = timeEl.parentElement;
      let depth = 0;
      while (p && depth < 7) {
        const rect = p.getBoundingClientRect();
        if (rect.height > 140 && rect.width > 180) scoreMap.set(p, (scoreMap.get(p) || 0) + 1);
        p = p.parentElement;
        depth++;
      }
    }

    let best = null, bestScore = 0;
    for (const [el, score] of scoreMap.entries()) {
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  }

  function collectVisibleCaptionRows(panel, outMap) {
    const timeNodes = [...panel.querySelectorAll('*')].filter(el => {
      const txt = (el.textContent || '').trim();
      return /^\d{1,2}:\d{2}$/.test(txt);
    });

    for (const timeEl of timeNodes) {
      const seconds = parseTimestampToSeconds((timeEl.textContent || '').trim());
      if (seconds == null) continue;
      const row = findCaptionRowContainer(timeEl, panel);
      if (!row) continue;
      const text = (row.innerText || row.textContent || '')
        .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
        .replace(/Auto-generated captions may contain errors\.?/gi, ' ')
        .replace(/\s+/g, ' ').trim();
      if (text.length < 8) continue;
      if (!outMap.has(seconds) || outMap.get(seconds).length < text.length) outMap.set(seconds, text);
    }
  }

  function findCaptionRowContainer(startEl, stopEl) {
    let el = startEl, depth = 0;
    while (el && el !== stopEl && depth < 7) {
      const txt = (el.innerText || el.textContent || '').trim();
      const rect = el.getBoundingClientRect();
      if (txt.length > 10 && txt.length < 700 && rect.width > 150 && rect.height > 18 && /\b\d{1,2}:\d{2}\b/.test(txt)) return el;
      el = el.parentElement;
      depth++;
    }
    return startEl.parentElement || null;
  }

  async function tryClickCaptionTab() {
    const tabSelectors = [
      '[aria-label="캡션"]', '[title="캡션"]',
      '[aria-label="Captions"]', '[title="Captions"]',
      '[data-tab="captions"]', '.tab-button[data-value="captions"]',
      'button[class*="caption"]', 'li[class*="caption"]',
    ];
    for (const sel of tabSelectors) {
      const el = document.querySelector(sel);
      if (!el || typeof el.click !== 'function') continue;
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim();
      if (sel.includes('caption') || label === '캡션' || label === 'Captions' || label === 'Caption') {
        el.click(); return;
      }
    }
    const allTabs = document.querySelectorAll('[role="tab"], .sidebar-tab, .tab-button, button[class*="tab"]');
    for (const tab of allTabs) {
      const text = (tab.textContent || '').trim();
      if (text === '캡션' || text === 'Captions' || text === 'Caption') { tab.click(); return; }
    }
  }

  function injectPanel(panoptoUrl, title) {
    if (panelInjected) return;
    panelInjected = true;

    const trigger = document.createElement('div');
    trigger.id = 'panolearn-trigger';
    trigger.innerHTML =
      '<div class="pl-trigger-icon">📖</div>' +
      '<div class="pl-trigger-label">Study</div>' +
      '<div class="pl-trigger-badge">AI</div>';
    document.body.appendChild(trigger);

    const panel = document.createElement('div');
    panel.id = 'panolearn-panel';
    panel.innerHTML = getPanelHTML(panoptoUrl, title);
    document.body.appendChild(panel);

    trigger.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      trigger.classList.toggle('active', open);
    });

    setTimeout(() => wirePanelEvents(panel, panoptoUrl, title), 100);
  }

  function getPanelHTML(url, title) {
    const shortUrl = url.length > 56 ? url.slice(0, 53) + '...' : url;
    return `<div class="pl-panel-inner">
      <div class="pl-header">
        <div class="pl-header-left">
          <div class="pl-logo">PL</div>
          <div>
            <div class="pl-title">PanoLearn <span class="pl-version">v4.1</span></div>
            <div class="pl-subtitle">Caption-Grounded Notes</div>
          </div>
        </div>
        <button class="pl-close" id="pl-close">x</button>
      </div>

      <div class="pl-detected">
        <div class="pl-detected-label">Recording Detected</div>
        <div class="pl-detected-title">${escapeHtml(title || 'Panopto Recording')}</div>
        <div class="pl-detected-url">${escapeHtml(shortUrl)}</div>
        <div class="pl-caption-status" id="pl-caption-status">
          <span class="pl-caption-dot"></span> Checking captions...
        </div>
      </div>

      <div class="pl-transcript-zone" id="pl-transcript-zone" style="display:none">
        <div class="pl-tz-label">📋 Paste transcript here</div>
        <div class="pl-tz-hint">Open the captions tab in Panopto, copy all text, and paste below.</div>
        <textarea class="pl-tz-input" id="pl-tz-input"></textarea>
        <div class="pl-tz-actions">
          <button class="pl-tz-save" id="pl-tz-save">Use This Transcript</button>
          <button class="pl-tz-cancel" id="pl-tz-cancel">Cancel</button>
        </div>
      </div>

      <div class="pl-modes-label">Select outputs:</div>
      <div class="pl-modes" id="pl-modes">
        <button class="pl-mode-btn active" data-mode="summary"><span>📋</span>Summary</button>
        <button class="pl-mode-btn active" data-mode="concepts"><span>📚</span>Concepts</button>
        <button class="pl-mode-btn active" data-mode="flashcards"><span>🃏</span>Flashcards</button>
        <button class="pl-mode-btn" data-mode="timeline"><span>⏱</span>Timeline</button>
        <button class="pl-mode-btn" data-mode="mindmap"><span>🗂</span>Concept Summary</button>
        <button class="pl-mode-btn" data-mode="exam"><span>🎯</span>Exam Qs</button>
      </div>

      <button class="pl-generate-btn" id="pl-generate">✦ Generate Study Notes</button>

      <div class="pl-progress" id="pl-progress" style="display:none">
        <div class="pl-prog-ring-wrap">
          <svg class="pl-prog-ring" viewBox="0 0 80 80">
            <circle class="pl-ring-track" cx="40" cy="40" r="34"/>
            <circle class="pl-ring-fill" id="pl-ring-fill" cx="40" cy="40" r="34"
              stroke-dasharray="213.6" stroke-dashoffset="213.6"/>
          </svg>
          <div class="pl-prog-pct-wrap">
            <span class="pl-prog-pct" id="pl-pct">0</span>
            <span class="pl-prog-pct-sign">%</span>
          </div>
        </div>
        <div class="pl-prog-msg" id="pl-msg">Starting...</div>
        <div class="pl-prog-dots"><span></span><span></span><span></span></div>
      </div>

      <div class="pl-error" id="pl-error" style="display:none"></div>
      <div class="pl-results" id="pl-results" style="display:none"></div>

      <div class="pl-save-row" id="pl-save-row" style="display:none">
        <button class="pl-save-btn" id="pl-save">⬇ Download Notes</button>
        <button class="pl-save-btn pl-latex-btn" id="pl-latex" style="display:none">∑ View Math</button>
        <button class="pl-reset-btn" id="pl-reset">↺ New</button>
      </div>

      <div class="pl-footer">PanoLearn v4.1 · Claude AI</div>
    </div>`;
  }

  function wirePanelEvents(panel, url, title) {
    const $ = id => panel.querySelector('#' + id);
    const videoId = extractVideoId(url);

    checkCaptionAvailability(panel, url, videoId);

    panel.querySelectorAll('.pl-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });

    $('pl-close')?.addEventListener('click', () => {
      panel.classList.remove('open');
      document.getElementById('panolearn-trigger')?.classList.remove('active');
    });

    $('pl-generate')?.addEventListener('click', () => {
      const activeModes = [...panel.querySelectorAll('.pl-mode-btn.active')].map(b => b.dataset.mode);
      if (!activeModes.length) { showError(panel, 'Select at least one output type.'); return; }
      runAnalysis(panel, url, title, videoId, activeModes);
    });

    $('pl-reset')?.addEventListener('click', () => {
      panel.dataset.transcript = '';
      panel.dataset.transcriptSource = '';
      $('pl-results').style.display = 'none';
      $('pl-save-row').style.display = 'none';
      $('pl-generate').style.display = 'flex';
      hideError(panel);
    });
  }

  async function checkCaptionAvailability(panel, url, videoId) {
    const el = panel.querySelector('#pl-caption-status');
    if (!el) return;
    if (!videoId) { el.innerHTML = '<span class="pl-caption-dot warn"></span> No video ID found'; return; }

    try {
      const transcript = await fetchCaptions(url, videoId);
      if (transcript && transcript.length > 200) {
        const words = wordCount(transcript);
        el.innerHTML = `<span class="pl-caption-dot ok"></span> Captions loaded (${words} words)`;
        panel.dataset.transcript = transcript;
        panel.dataset.transcriptSource = 'auto';
      } else {
        el.innerHTML = '<span class="pl-caption-dot warn"></span> Auto-read blocked — <button class="pl-paste-btn" id="pl-paste-trigger">paste transcript manually</button>';
        wirePasteZone(panel);
      }
    } catch {
      el.innerHTML = '<span class="pl-caption-dot warn"></span> Could not read captions — <button class="pl-paste-btn" id="pl-paste-trigger">paste manually</button>';
      wirePasteZone(panel);
    }
  }

  function wirePasteZone(panel) {
    const zone = panel.querySelector('#pl-transcript-zone');
    const trigger = panel.querySelector('#pl-paste-trigger');
    const saveBtn = panel.querySelector('#pl-tz-save');
    const cancelBtn = panel.querySelector('#pl-tz-cancel');
    const textarea = panel.querySelector('#pl-tz-input');
    const statusEl = panel.querySelector('#pl-caption-status');

    if (trigger && !trigger.dataset.bound) {
      trigger.dataset.bound = '1';
      trigger.addEventListener('click', () => { zone.style.display = 'block'; setTimeout(() => textarea.focus(), 100); });
    }
    if (cancelBtn && !cancelBtn.dataset.bound) {
      cancelBtn.dataset.bound = '1';
      cancelBtn.addEventListener('click', () => { zone.style.display = 'none'; });
    }
    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = '1';
      saveBtn.addEventListener('click', () => {
        const text = textarea.value.trim();
        if (text.length < 100) { textarea.style.borderColor = '#c84b1f'; return; }
        const cleaned = text.replace(/^\d{1,2}:\d{2}\s*/gm, '').replace(/\n{3,}/g, '\n').trim();
        const words = wordCount(cleaned);
        panel.dataset.transcript = cleaned;
        panel.dataset.transcriptSource = 'manual';
        statusEl.innerHTML = `<span class="pl-caption-dot ok"></span> Transcript pasted (${words} words) — ready to generate`;
        textarea.value = '';
        textarea.style.borderColor = '';
        zone.style.display = 'none';
      });
    }
  }

  async function runAnalysis(panel, url, title, videoId, modes) {
    const $ = id => panel.querySelector('#' + id);
    $('pl-generate').style.display = 'none';
    $('pl-results').style.display = 'none';
    $('pl-save-row').style.display = 'none';
    hideError(panel);

    const prog = $('pl-progress'), msg = $('pl-msg');
    const ringFill = $('pl-ring-fill'), pctEl = $('pl-pct');
    const CIRCUMFERENCE = 213.6;
    prog.style.display = 'block';

    // Smooth animated percentage — animates number and ring together
    let currentPct = 0;
    let targetPct  = 0;
    let animFrame  = null;

    function setProgress(pct, label) {
      targetPct = pct;
      if (label) msg.textContent = label;
      if (animFrame) return;
      function step() {
        if (currentPct < targetPct) {
          currentPct = Math.min(currentPct + 1, targetPct);
          pctEl.textContent = Math.round(currentPct);
          ringFill.style.strokeDashoffset = CIRCUMFERENCE * (1 - currentPct / 100);
          animFrame = requestAnimationFrame(step);
        } else {
          animFrame = null;
        }
      }
      animFrame = requestAnimationFrame(step);
    }

    const steps = [
      ['Extracting lecture captions...', 12],
      ['Reading transcript...', 25],
      ['Identifying topics...', 40],
      ['Building concept map...', 55],
      ['Generating study materials...', 70],
      ['Writing flashcards & exam questions...', 83],
      ['Formatting notes...', 92],
    ];
    let si = 0;
    setProgress(steps[si][1], steps[si][0]); si++;
    const ticker = setInterval(() => {
      if (si < steps.length) { setProgress(steps[si][1], steps[si][0]); si++; }
    }, 1400);

    try {
      let transcript = panel.dataset.transcript || '';
      if (!transcript) {
        transcript = await fetchCaptions(url, videoId);
        if (transcript) { panel.dataset.transcript = transcript; panel.dataset.transcriptSource = 'auto'; }
      }

      const result = await callClaude(url, title, modes, transcript);
      clearInterval(ticker);
      setProgress(100, 'Done! ✓');
      setTimeout(() => {
        prog.style.display = 'none';
        const ltype = result.lecture_type || detectLectureType(result);
        renderResults(panel, result, ltype);
        renderMathInPanel(panel);
        applyLectureTheme(panel, ltype);
        $('pl-save-row').style.display = 'flex';
        $('pl-save').onclick = () => downloadNotesAsPDF(result, title);
        // Adaptive buttons based on lecture type
        if (ltype === 'math') {
          $('pl-latex').style.display = 'inline-flex';
          $('pl-latex').onclick = () => openLatexTab(result, title);
        }
      }, 500);
    } catch (e) {
      clearInterval(ticker);
      if (animFrame) cancelAnimationFrame(animFrame);
      prog.style.display = 'none';
      showError(panel, e.message || 'Analysis failed.');
      $('pl-generate').style.display = 'flex';
    }
  }

  const BACKEND_URL = 'https://panolearn-real-production.up.railway.app';

  async function callClaude(url, title, modes, transcript) {
    const stored = await chrome.storage.local.get(['plToken', 'plModel']);
    const token  = stored.plToken;
    const model  = stored.plModel || 'claude-sonnet-4-20250514';
    if (!token) throw new Error('Please sign in to PanoLearn. Click the extension icon.');
    if (!transcript || !transcript.trim()) throw new Error('No lecture transcript was captured.');

    const wc = wordCount(transcript);
    if (wc < 120) throw new Error(`Transcript too short (${wc} words). Paste the full captions manually.`);

    const modeSchemas = {
      summary: `"summary": {
          "tldr": "2-3 sentence summary of what was actually taught",
          "main_topics": ["topic 1", "topic 2", "topic 3"],
          "what_to_remember": "most important thing to remember"
        }`,
      concepts: `"concepts_3step": [
          {
            "title": "Name of the concept",
            "step1_definition": "Definition and core properties",
            "step2_principle": "Underlying mechanism, formulas, or relationships",
            "step3_application": "How it is applied in examples or problems from the lecture"
          }
        ]`,
      flashcards: `"flashcards": [
          { "front": "term or question", "back": "answer", "category": "topic" }
        ]`,
      timeline: `"timeline": [
          { "segment": "0:00-4:00", "topic": "topic", "key_point": "specific point" }
        ]`,
      mindmap: `"concept_summary": {
          "sections": [
            {
              "heading": "Topic or formula group name",
              "items": [
                {
                  "label": "short label shown in collapsed row e.g. 'Substitution Method' or 'xe^(2x) series'",
                  "steps": [
                    {
                      "title": "Step title e.g. 'Set up', 'First part', 'Let', 'Evaluate', 'Final Answer'",
                      "prose": "Optional: one sentence of plain-language explanation e.g. 'Split it.' or 'Let u = r^2, so du = 2r dr'",
                      "equation": "The key formula or result for this step, written inline e.g. 'integral(2r dr) = r^2' or 'Sigma_{k=0}^{inf} (2^k/k!) x^(k+1)'. Leave empty string if no equation.",
                      "is_final": false
                    }
                  ]
                }
              ]
            }
          ]
        }`,
      exam: `"exam_questions": [
          {
            "type": "Computation | Proof | Conceptual | Application",
            "difficulty": "medium | hard",
            "question": "A rigorous exam-style question requiring actual work — e.g. compute a series, derive a formula, apply a method to a specific function from the lecture. Never ask trivial recall or 'which of these is hard' questions.",
            "answer": "Full worked solution with every step shown. Use the exact notation formats (Sigma_{k=0}^{inf}, frac{}{}, sqrt(), etc.)"
          }
        ]`
    };

    const requested = modes.map(m => modeSchemas[m]).filter(Boolean).join(',\n');

    const systemInstruction = `You are an expert lecture note extractor.
Rules:
1. Use ONLY the provided transcript — every term, example, and analogy must come directly from it.
2. Do NOT add outside facts, textbook definitions, or general knowledge not present in the transcript.
3. Be specific: use the exact examples the professor gave (e.g. Circle/Shape/Triangle classes, phone interface analogy, water bottle example, compareTo method).
4. Return ONLY valid JSON — no markdown, no preamble.
6. For exam_questions, follow these strict rules:
   - ONLY generate Computation, Proof, Application, or Derivation questions — the kind a professor puts on a midterm.
   - NEVER generate: trivia, "which of these is hard", definition recall, yes/no, or opinion questions.
   - Every question must require actual mathematical or technical WORK to answer.
   - difficulty must be "medium" or "hard" ONLY — no easy questions on an exam.
   - Each answer must show every step of the solution in full.
   - Questions must use specific functions/values/examples from the lecture (e.g. "Find the Taylor series for xe^{2x}" not "Find a Taylor series").
   - Aim for 5-6 questions covering different techniques taught in the lecture.
5. For math notation in ALL fields (especially "equation") use ONLY these formats:
   INTEGRALS:   int_{0}^{b}(expr dr)   iint_{R}(f dA)   oint_{C}(F·dr)
   SIGMA:       Sigma_{k=0}^{inf}(x^k/k!)   Sigma_{n=1}^{N}(a_n)
   PRODUCT:     Prod_{k=1}^{n}(k)
   LIMIT:       lim_{x->0}(sin(x)/x)
   FRACTIONS:   frac{numerator}{denominator}   or short: 1/2  (a+b)/(c+d)
   POWERS:      x^{2k+1}   e^{-x^2}   2^n
   SUBSCRIPTS:  a_{n}   x_{0}   v_{i}
   ROOTS:       sqrt(expr)   root{n}(expr)
   DERIVATIVES: d/dx(f)   partial/partial{x}(f)   f'(x)   f''(x)
   GREEK:       alpha beta gamma delta epsilon zeta eta theta lambda mu nu xi pi rho sigma tau phi chi psi omega (and capitals)
   VECTORS:     vec{v}   ||v||
   MATRIX:      mat{a,b;c,d}
   SETS:        in notin subset subseteq cup cap emptyset forall exists
   OPERATORS:   cdot times pm approx equiv leq geq neq
   COMPLEXITY:  O(n^2)  Theta(n log n)  Omega(n)
   ARROWS:      ->  <-  =>  <=>  |->
   TRIG:        sin cos tan arctan sinh cosh (written as words, renderer styles them)
   Never write "integral" as a plain word — always int_{} or int().`;

    const prompt = `Transcript of a single lecture session.
Title: "${title || 'Unknown'}"

TRANSCRIPT:
"""
${transcript}
"""

Return this JSON — every item must be traceable to something actually said in the transcript above:
{
  "lecture_title": "specific descriptive title based on what was actually taught",
  "scope_note": "list the specific topics covered e.g. Abstract data types, Java interfaces as contracts, implementing Shape/Polygon, Comparable and compareTo",
  ${requested}
}`;

    const res = await fetch(BACKEND_URL + '/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ transcript, title, modes, model, videoUrl: url })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error || 'Server error ' + res.status);
    }
    const data = await res.json();
    // Backend returns { result: {...}, meta: {...} }
    return data.result;
  }

  function renderResults(panel, result) {
    const el = panel.querySelector('#pl-results');
    const E = escapeHtml;

    // ── helpers ──────────────────────────────────────────────────────────
    function row(badge, cls, text) {
      return `<div class="pl-concept-step">
        <span class="pl-step-badge ${cls}">${badge}</span>
        <span>${mathHtml(text || '')}</span>
      </div>`;
    }

    function accordion(emoji, label, count, colorCls, bodyHtml, openByDefault) {
      const open = openByDefault ? 'open' : '';
      const cnt  = count != null ? `<span class="pl-acc-count">${count}</span>` : '';
      return `<div class="pl-acc-section ${open}">
        <button class="pl-acc-header ${colorCls}">
          <span class="pl-acc-left">
            <span class="pl-acc-emoji">${emoji}</span>
            <span class="pl-acc-label">${label}</span>
            ${cnt}
          </span>
          <span class="pl-acc-chevron">▸</span>
        </button>
        <div class="pl-acc-body">${bodyHtml}</div>
      </div>`;
    }

    let html = '';

    // scope_note intentionally hidden from panel view

    // ── Summary ───────────────────────────────────────────────────────────
    if (result.summary) {
      const s = result.summary;
      let body = `<div class="pl-sum-tldr">${mathHtml(s.tldr || '')}</div>`;
      if (s.main_topics?.length) {
        body += `<div class="pl-sum-chips">${s.main_topics.map(t => `<span class="pl-topic-chip">${E(t)}</span>`).join('')}</div>`;
      }
      if (s.what_to_remember) {
        body += `<div class="pl-takeaway"><strong>Key takeaway:</strong> ${mathHtml(s.what_to_remember || '')}</div>`;
      }
      html += accordion('📋', 'Summary', null, 'pl-acc-green', body, true);
    }

    // ── Concepts (each concept is its own nested accordion) ───────────────
    if (result.concepts_3step?.length) {
      const conceptsBody = result.concepts_3step.map((c, i) => {
        const detail = `<div class="pl-concept-box">
          ${row('DEF', 'pl-step-1', c.step1_definition)}
          ${row('WHY', 'pl-step-2', c.step2_principle)}
          ${row('USE', 'pl-step-3', c.step3_application)}
        </div>`;
        return `<div class="pl-ci">
          <button class="pl-ci-header">
            <span class="pl-ci-num">${String(i+1).padStart(2,'0')}</span>
            <span class="pl-ci-title">${E(c.title || '')}</span>
            <span class="pl-ci-chevron">▸</span>
          </button>
          <div class="pl-ci-body">${detail}</div>
        </div>`;
      }).join('');
      html += accordion('📚', 'Concepts', result.concepts_3step.length, 'pl-acc-red', conceptsBody, true);
    }

    // ── Flashcards ────────────────────────────────────────────────────────
    if (result.flashcards?.length) {
      const cards = result.flashcards;
      const cardHtml = cards.map((f, i) => `
        <div class="pl-flash-card ${i === 0 ? 'active' : ''}">
          <div class="pl-flash-inner">
            <div class="pl-flash-front">
              <div class="pl-flash-side-label">TERM</div>
              <div class="pl-flash-text">${mathHtml(f.front || '')}</div>
              ${f.category ? `<div class="pl-flash-cat">${E(f.category)}</div>` : ''}
              <div class="pl-flash-hint">tap to flip</div>
            </div>
            <div class="pl-flash-back">
              <div class="pl-flash-side-label">DEFINITION</div>
              <div class="pl-flash-text">${mathHtml(f.back || '')}</div>
            </div>
          </div>
        </div>`).join('');
      const deck = `<div class="pl-flash-deck">
        <div class="pl-flash-nav">
          <button class="pl-flash-prev pl-flash-btn">‹</button>
          <span class="pl-flash-counter">1 / ${cards.length}</span>
          <button class="pl-flash-next pl-flash-btn">›</button>
        </div>
        ${cardHtml}
      </div>`;
      html += accordion('🃏', 'Flashcards', `${cards.length} cards`, 'pl-acc-dark', deck, false);
    }

    // ── Timeline ──────────────────────────────────────────────────────────
    if (result.timeline?.length) {
      const body = result.timeline.map((seg, i) => `
        <div class="pl-tl-item">
          <div class="pl-tl-left">
            <div class="pl-tl-dot"></div>
            ${i < result.timeline.length - 1 ? '<div class="pl-tl-line"></div>' : ''}
          </div>
          <div class="pl-tl-content">
            <div class="pl-tl-time">${E(seg.segment || '')}</div>
            <div class="pl-tl-topic">${E(seg.topic || '')}</div>
            <div class="pl-tl-point">${E(seg.key_point || '')}</div>
          </div>
        </div>`).join('');
      html += accordion('⏱', 'Timeline', null, 'pl-acc-gold', `<div class="pl-timeline">${body}</div>`, false);
    }

    // ── Concept Summary ───────────────────────────────────────────────────
    if (result.concept_summary) {
      const cs = result.concept_summary;
      const sectionsHtml = (cs.sections || []).map(sec => {
        const itemsHtml = (sec.items || []).map(item => {
          const stepsHtml = (item.steps || []).map((step, si) => {
            const isFinal = !!step.is_final;
            const hasProse = step.prose && step.prose.trim();
            const hasEq    = step.equation && step.equation.trim();
            return `<div class="pl-sol-step${isFinal ? ' pl-sol-final' : ''}${si > 0 ? ' pl-sol-has-rule' : ''}">
              ${step.title ? `<div class="pl-sol-title${isFinal ? ' pl-sol-title-final' : ''}">${E(step.title)}</div>` : ''}
              ${hasProse   ? `<div class="pl-sol-prose">${E(step.prose)}</div>` : ''}
              ${hasEq      ? `<div class="pl-sol-eq${isFinal ? ' pl-sol-eq-final' : ''}">${mathHtml(step.equation||"")}</div>` : ''}
            </div>`;
          }).join('');
          return `<div class="pl-cs-item">
            <button class="pl-cs-label">
              <span class="pl-cs-label-text">${mathHtml(item.label||"")}</span>
              <span class="pl-cs-arrow">▸</span>
            </button>
            <div class="pl-cs-detail">
              <div class="pl-sol-sheet">${stepsHtml}</div>
            </div>
          </div>`;
        }).join('');
        return `<div class="pl-cs-section">
          <div class="pl-cs-heading">${E(sec.heading || '')}</div>
          ${itemsHtml}
        </div>`;
      }).join('');
      html += accordion('🗂', 'Concept Summary', null, 'pl-acc-purple', `<div class="pl-cs-root">${sectionsHtml}</div>`, false);
    }

    // ── Exam Questions ────────────────────────────────────────────────────
    if (result.exam_questions?.length) {
      const diffColor = { medium:'#d4a843', hard:'#c84b1f' };
      const typeColor = {
        'Computation':'#1a3a6b', 'Proof':'#6b1a3a',
        'Application':'#1a6b4a', 'Derivation':'#6b3fa0',
        'Conceptual':'#5a4a2a'
      };
      const body = result.exam_questions.map((q, i) => {
        const tc = typeColor[q.type] || '#333';
        const dc = diffColor[(q.difficulty||'').toLowerCase()] || '#888';
        return `<div class="pl-exam-item">
          <div class="pl-exam-meta">
            <span class="pl-exam-type" style="background:${tc}">${E(q.type||'')}</span>
            <span class="pl-exam-diff" style="color:${dc};font-weight:700">${E((q.difficulty||'').toUpperCase())}</span>
          </div>
          <div class="pl-exam-q"><strong>Q${i+1}.</strong> ${mathHtml(q.question||"")}</div>
          <button class="pl-reveal-btn">Show Answer</button>
          <div class="pl-exam-answer">${mathHtml(q.answer||"")}</div>
        </div>`;
      }).join('');
      html += accordion('🎯', 'Exam Qs', result.exam_questions.length, 'pl-acc-navy', body, false);
    }

    el.innerHTML = `<div class="pl-react-root">${html}</div>`;
    el.style.display = 'block';

    // ── Wire accordion toggles ────────────────────────────────────────────
    el.querySelectorAll('.pl-acc-section > .pl-acc-header').forEach(btn => {
      btn.addEventListener('click', () => {
        const sec = btn.parentElement;
        sec.classList.toggle('open');
      });
    });

    // ── Wire concept sub-accordions ───────────────────────────────────────
    el.querySelectorAll('.pl-ci-header').forEach(btn => {
      btn.addEventListener('click', () => btn.parentElement.classList.toggle('open'));
    });

    // ── Wire concept-summary items ────────────────────────────────────────
    el.querySelectorAll('.pl-cs-label').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.parentElement;
        item.classList.toggle('open');
        // animate max-height
        const detail = item.querySelector('.pl-cs-detail');
        if (item.classList.contains('open')) {
          detail.style.maxHeight = detail.scrollHeight + 'px';
        } else {
          detail.style.maxHeight = '0';
        }
      });
    });

    // ── Wire flashcards ───────────────────────────────────────────────────
    el.querySelectorAll('.pl-flash-deck').forEach(deck => {
      const cards   = deck.querySelectorAll('.pl-flash-card');
      const counter = deck.querySelector('.pl-flash-counter');
      let cur = 0;
      function go(dir) {
        cards[cur].classList.remove('active', 'flipped');
        cur = (cur + dir + cards.length) % cards.length;
        cards[cur].classList.add('active');
        counter.textContent = `${cur + 1} / ${cards.length}`;
      }
      deck.querySelector('.pl-flash-prev').addEventListener('click', e => { e.stopPropagation(); go(-1); });
      deck.querySelector('.pl-flash-next').addEventListener('click', e => { e.stopPropagation(); go(1); });
      cards.forEach(c => c.addEventListener('click', () => c.classList.toggle('flipped')));
    });

    // ── Wire exam reveal ──────────────────────────────────────────────────
    el.querySelectorAll('.pl-reveal-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.nextElementSibling.style.display = 'block';
        btn.style.display = 'none';
      });
    });
  }

  function downloadNotesAsPDF(result, title) {
    const e = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    let body = '';

    // Header
    body += `<div class="pdf-header">
      <div class="pdf-logo">PL</div>
      <div>
        <div class="pdf-title">${e(result.lecture_title || title || 'PanoLearn Notes')}</div>
        ${result.scope_note ? `<div class="pdf-scope">${e(result.scope_note)}</div>` : ''}
      </div>
    </div>`;

    // Summary
    if (result.summary) {
      const s = result.summary;
      body += `<div class="pdf-section">
        <div class="pdf-section-header pdf-h-summary">📋 Lecture Summary</div>
        <div class="pdf-tldr">${e(s.tldr || '')}</div>
        ${s.main_topics?.length ? `
          <div class="pdf-chips-label">Topics Covered</div>
          <div class="pdf-chips">${s.main_topics.map(t => `<span class="pdf-chip">${e(t)}</span>`).join('')}</div>` : ''}
        ${s.what_to_remember ? `<div class="pdf-takeaway"><strong>Key Takeaway:</strong> ${e(s.what_to_remember)}</div>` : ''}
      </div>`;
    }

    // 3-Step Concepts
    if (result.concepts_3step?.length) {
      body += `<div class="pdf-section">
        <div class="pdf-section-header pdf-h-concepts">📚 3-Step Concepts</div>`;
      result.concepts_3step.forEach((c, i) => {
        const um = s => upgradeMathNotation(s);
        body += `<div class="pdf-concept-box">
          <div class="pdf-concept-title"><span class="pdf-concept-num">${String(i+1).padStart(2,'0')}</span>${e(c.title || '')}</div>
          <div class="pdf-concept-row">
            <div class="pdf-step-badge pdf-step-def">DEF</div>
            <div class="pdf-step-text">${um(c.step1_definition || '')}</div>
          </div>
          <div class="pdf-concept-row">
            <div class="pdf-step-badge pdf-step-why">WHY</div>
            <div class="pdf-step-text">${um(c.step2_principle || '')}</div>
          </div>
          <div class="pdf-concept-row pdf-last-row">
            <div class="pdf-step-badge pdf-step-use">USE</div>
            <div class="pdf-step-text">${um(c.step3_application || '')}</div>
          </div>
        </div>`;
      });
      body += `</div>`;
    }

    // Flashcards (all visible in PDF, 2-column grid)
    if (result.flashcards?.length) {
      body += `<div class="pdf-section">
        <div class="pdf-section-header pdf-h-flash">🃏 Flashcards</div>
        <div class="pdf-flash-grid">`;
      result.flashcards.forEach((f, i) => {
        body += `<div class="pdf-flash-card">
          <div class="pdf-flash-num">Card ${i+1}${f.category ? ` · ${e(f.category)}` : ''}</div>
          <div class="pdf-flash-front">${e(f.front || '')}</div>
          <div class="pdf-flash-divider"></div>
          <div class="pdf-flash-back">${e(f.back || '')}</div>
        </div>`;
      });
      body += `</div></div>`;
    }

    // Timeline
    if (result.timeline?.length) {
      body += `<div class="pdf-section">
        <div class="pdf-section-header pdf-h-timeline">⏱ Lecture Timeline</div>`;
      result.timeline.forEach((seg, i) => {
        body += `<div class="pdf-timeline-item">
          <div class="pdf-tl-left">
            <div class="pdf-tl-dot"></div>
            ${i < result.timeline.length - 1 ? '<div class="pdf-tl-line"></div>' : ''}
          </div>
          <div class="pdf-tl-body">
            <div class="pdf-tl-time">${e(seg.segment || '')}</div>
            <div class="pdf-tl-topic">${e(seg.topic || '')}</div>
            <div class="pdf-tl-point">${e(seg.key_point || '')}</div>
          </div>
        </div>`;
      });
      body += `</div>`;
    }

    // Mind Map (text tree form in PDF)
    if (result.mindmap) {
      const m = result.mindmap;
      body += `<div class="pdf-section">
        <div class="pdf-section-header pdf-h-mindmap">🕸 Concept Map</div>
        <div class="pdf-mindmap">
          <div class="pdf-mm-center">${e(m.center || '')}</div>
          <div class="pdf-mm-branches">`;
      (m.branches || []).forEach(b => {
        const colors = { fire:'#c84b1f', forest:'#1a6b4a', gold:'#d4a843', ink:'#333' };
        const col = colors[b.color] || '#c84b1f';
        body += `<div class="pdf-mm-branch" style="border-left-color:${col}">
          <div class="pdf-mm-label" style="color:${col}">${e(b.label || '')}</div>
          ${(b.children || []).map(ch => `<div class="pdf-mm-child">• ${e(ch)}</div>`).join('')}
        </div>`;
      });
      body += `</div></div></div>`;
    }

    // Exam Questions
    if (result.exam_questions?.length) {
      const dc = { easy:'#1a6b4a', medium:'#d4a843', hard:'#c84b1f' };
      body += `<div class="pdf-section">
        <div class="pdf-section-header pdf-h-exam">🎯 Exam Questions</div>`;
      result.exam_questions.forEach((q, i) => {
        body += `<div class="pdf-exam-item">
          <div class="pdf-exam-meta">
            <span class="pdf-exam-type">${e(q.type || '')}</span>
            <span class="pdf-exam-diff" style="color:${dc[q.difficulty] || '#333'}">${e(q.difficulty || '')}</span>
          </div>
          <div class="pdf-exam-q"><strong>Q${i+1}.</strong> ${e(q.question || '')}</div>
          <div class="pdf-exam-a"><strong>Answer:</strong> ${e(q.answer || '')}</div>
        </div>`;
      });
      body += `</div>`;
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${e(result.lecture_title || title || 'PanoLearn Notes')}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; background: #fff; padding: 32px 40px; max-width: 860px; margin: 0 auto; }

  /* Header */
  .pdf-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 3px solid #0d0d0d; }
  .pdf-logo { width: 42px; height: 42px; background: #c84b1f; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; color: white; flex-shrink: 0; letter-spacing: -0.5px; }
  .pdf-title { font-size: 18pt; font-weight: 700; color: #0d0d0d; line-height: 1.2; margin-bottom: 5px; }
  .pdf-scope { font-size: 9pt; color: #6b6355; line-height: 1.5; }

  /* Sections */
  .pdf-section { margin-bottom: 24px; break-inside: avoid; }
  .pdf-section-header { font-size: 10pt; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; padding: 8px 14px; border-radius: 6px 6px 0 0; margin-bottom: 0; color: white; }
  .pdf-h-summary { background: #1a6b4a; }
  .pdf-h-concepts { background: #c84b1f; }
  .pdf-h-flash { background: #0d0d0d; }
  .pdf-h-timeline { background: #d4a843; color: #0d0d0d !important; }
  .pdf-h-mindmap { background: #6b3fa0; }
  .pdf-h-exam { background: #1a3a6b; }

  /* Summary */
  .pdf-tldr { padding: 12px 14px; background: #e8f4f0; border-left: 4px solid #1a6b4a; font-size: 10.5pt; line-height: 1.65; border-radius: 0 0 4px 4px; margin-bottom: 10px; }
  .pdf-chips-label { font-size: 8pt; letter-spacing: 1.5px; text-transform: uppercase; color: #6b6355; margin: 10px 0 6px; }
  .pdf-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .pdf-chip { font-size: 8.5pt; padding: 3px 10px; background: #0d0d0d; color: white; border-radius: 100px; }
  .pdf-takeaway { padding: 10px 14px; background: #fff8e8; border-left: 4px solid #d4a843; font-size: 10pt; line-height: 1.6; border-radius: 0 4px 4px 0; }

  /* 3-Step Concept Boxes */
  .pdf-concept-box { border: 2px solid #0d0d0d; border-radius: 0 0 8px 8px; margin-bottom: 12px; overflow: hidden; break-inside: avoid; box-shadow: 3px 3px 0 #0d0d0d; }
  .pdf-concept-title { background: #0d0d0d; color: #f5f0e8; padding: 9px 14px; font-size: 11pt; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .pdf-concept-num { font-family: 'JetBrains Mono', monospace; font-size: 8pt; color: #c84b1f; letter-spacing: 1px; }
  .pdf-concept-row { display: flex; align-items: flex-start; gap: 0; border-bottom: 1px solid #e8e0d0; }
  .pdf-last-row { border-bottom: none; }
  .pdf-step-badge { font-family: 'JetBrains Mono', monospace; font-size: 7.5pt; font-weight: 700; letter-spacing: 1.5px; padding: 10px 10px; min-width: 48px; text-align: center; flex-shrink: 0; align-self: stretch; display: flex; align-items: center; justify-content: center; }
  .pdf-step-def { background: #e8f4f0; color: #1a6b4a; border-right: 2px solid #1a6b4a; }
  .pdf-step-why { background: #fff3e0; color: #d4a843; border-right: 2px solid #d4a843; }
  .pdf-step-use { background: #fff0ec; color: #c84b1f; border-right: 2px solid #c84b1f; }
  .pdf-step-text { padding: 10px 12px; font-size: 10pt; line-height: 1.6; color: #1a1a1a; flex: 1; }

  /* Flashcards grid */
  .pdf-flash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px; background: #f5f5f5; border: 2px solid #0d0d0d; border-top: none; border-radius: 0 0 6px 6px; }
  .pdf-flash-card { background: #faf8f3; border: 1.5px solid #c8bfaa; border-radius: 8px; padding: 12px; break-inside: avoid; }
  .pdf-flash-num { font-size: 7.5pt; letter-spacing: 1px; text-transform: uppercase; color: #7a7060; margin-bottom: 6px; }
  .pdf-flash-front { font-size: 10pt; font-weight: 600; color: #0d0d0d; margin-bottom: 8px; line-height: 1.4; }
  .pdf-flash-divider { border-top: 1.5px dashed #c8bfaa; margin: 6px 0; }
  .pdf-flash-back { font-size: 9.5pt; color: #4a4a4a; line-height: 1.55; }

  /* Timeline */
  .pdf-timeline-item { display: flex; gap: 14px; margin: 0; }
  .pdf-tl-left { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; width: 16px; }
  .pdf-tl-dot { width: 13px; height: 13px; border-radius: 50%; background: #d4a843; border: 2px solid #0d0d0d; flex-shrink: 0; margin-top: 2px; }
  .pdf-tl-line { flex: 1; width: 2px; background: #e8e0d0; min-height: 20px; margin: 3px 0; }
  .pdf-tl-body { padding: 0 0 14px 0; flex: 1; }
  .pdf-tl-time { font-size: 8pt; letter-spacing: 1.5px; text-transform: uppercase; color: #d4a843; font-weight: 600; margin-bottom: 2px; }
  .pdf-tl-topic { font-size: 11pt; font-weight: 700; color: #0d0d0d; margin-bottom: 3px; }
  .pdf-tl-point { font-size: 9.5pt; line-height: 1.55; color: #555; }

  /* Mind map */
  .pdf-mindmap { padding: 14px; background: #faf8f3; border: 2px solid #0d0d0d; border-top: none; border-radius: 0 0 6px 6px; }
  .pdf-mm-center { background: #0d0d0d; color: #f5f0e8; font-weight: 700; font-size: 12pt; text-align: center; padding: 10px 16px; border-radius: 6px; margin-bottom: 14px; }
  .pdf-mm-branches { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .pdf-mm-branch { border-left: 4px solid #c84b1f; padding: 8px 10px; background: #f5f5f5; border-radius: 0 6px 6px 0; }
  .pdf-mm-label { font-size: 10pt; font-weight: 700; margin-bottom: 6px; }
  .pdf-mm-child { font-size: 9pt; color: #555; padding: 2px 0 2px 10px; line-height: 1.45; }

  /* Exam */
  .pdf-exam-item { padding: 12px 14px; border-bottom: 1px solid #e8e0d0; background: #faf8f3; }
  .pdf-exam-item:last-child { border-bottom: none; border-radius: 0 0 6px 6px; }
  .pdf-exam-meta { display: flex; gap: 8px; align-items: center; margin-bottom: 5px; }
  .pdf-exam-type { font-size: 8pt; letter-spacing: 1px; text-transform: uppercase; padding: 2px 8px; background: #1a3a6b; color: white; border-radius: 4px; }
  .pdf-exam-diff { font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .pdf-exam-q { font-size: 10.5pt; line-height: 1.6; margin-bottom: 6px; color: #0d0d0d; }
  .pdf-exam-a { font-size: 10pt; line-height: 1.6; padding: 8px 12px; background: #e8f4f0; border-left: 3px solid #1a6b4a; border-radius: 0 4px 4px 0; color: #1a1a1a; }

  /* Math styles */
  .pdf-fn { font-style: italic; font-family: Georgia, serif; color: #1a3a6b; }
  .pdf-frac { display: inline-flex; flex-direction: column; align-items: center;
    vertical-align: middle; margin: 0 2px; line-height: 1.2; font-size: 9pt; }
  .pdf-frac-n { border-bottom: 1.5px solid #0d0d0d; padding: 0 2px 1px; text-align: center; }
  .pdf-frac-d { padding: 1px 2px 0; text-align: center; }
  .pdf-step-text sup { font-size: 0.7em; vertical-align: super; line-height: 0; }
  .pdf-step-text sub { font-size: 0.7em; vertical-align: sub; line-height: 0; }
  .pl-math-body { font-style: italic; }
  .pdf-step-text { padding: 11px 14px 11px 18px; }

  /* Print rules */
  @media print {
    body { padding: 0; }
    .pdf-concept-box, .pdf-flash-card, .pdf-exam-item { break-inside: avoid; }
    .pdf-section { break-inside: avoid; }
    mjx-container { break-inside: avoid; }
  }
</style>
</head>
<body>
${body}
<div style="margin-top:32px; padding-top:12px; border-top:1px solid #e8e0d0; font-size:8pt; color:#aaa; text-align:center;">
  Generated by PanoLearn · ${new Date().toLocaleString()}
</div>
</body>
</html>`;

    // Open in new tab and trigger print dialog for Save as PDF
    const win = window.open('', '_blank');
    if (!win) {
      // Fallback: blob download as HTML if popup blocked
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      a.download = `panolearn-${Date.now()}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    win.document.write(html);
    win.document.close();
    win.addEventListener('load', () => {
      setTimeout(() => { win.focus(); win.print(); }, 600);
    });
  }

    // ── Math Rendering ────────────────────────────────────────────────────────

  /* ─────────────────────────────────────────────────────────────────────────
   * mathHtml — comprehensive college math renderer (no MathJax, pure HTML)
   *
   * Input notation the AI is instructed to use:
   *   Integrals    int_{a}^{b}(expr)   iint_{R}(expr)   oint_{C}(expr)
   *   Sigma        Sigma_{k=0}^{inf}(expr)
   *   Product      Pi_{k=1}^{n}(expr)          [capital Pi]
   *   Limit        lim_{x->0}(expr)
   *   Derivative   d/dx(expr)   partial/partial{x}(expr)   f'(x)   f''(x)
   *   Matrix       mat{a,b;c,d}
   *   Vector       vec{v}   ||v||
   *   Absolute     |expr|   abs(expr)
   *   Floor/Ceil   floor(expr)   ceil(expr)
   *   Fractions    a/b   (a+b)/(c+d)
   *   Powers       x^{2k+1}   e^{-x^2}
   *   Subscripts   a_{n}   x_1
   *   Roots        sqrt(expr)   root{n}(expr)
   *   Greek        alpha beta gamma delta epsilon zeta eta theta iota kappa
   *                lambda mu nu xi omicron rho sigma tau upsilon phi chi psi omega
   *                (capital: Alpha … Omega)
   *   Operators    cdot   times   div   pm   mp   oplus   otimes   circ
   *   Relations    ≤ ≥ ≠ ≈ ≡ ∝ ∈ ∉ ⊂ ⊃ ⊆ ⊇ ∅
   *   Arrows       ->  <-  <->  =>  <=>  |->
   *   Big ops      nabla   grad   div   curl   laplacian
   *   Sets/Logic   forall   exists   and   or   not   in   notin   subset
   * ───────────────────────────────────────────────────────────────────────── */
  // ── Render markdown code blocks to styled <pre><code> ──────────────────
  function renderCodeBlocks(text) {
    if (!text) return String(text || '');
    return text.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
      const escaped = code.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const langLabel = lang ? '<span class="pl-code-lang">' + lang + '</span>' : '';
      const copyBtn = '<button class="pl-code-copy" onclick="navigator.clipboard.writeText(this.closest(\'.pl-code-block\').querySelector(\'code\').textContent)">Copy</button>';
      return '<div class="pl-code-block"><div class="pl-code-header">' + langLabel + copyBtn + '</div><pre><code>' + escaped + '</code></pre></div>';
    });
  }

  function mathHtml(raw) {
    if (!raw) return '';

    // Handle code blocks first — return early, no math processing
    if (String(raw).includes('```')) return renderCodeBlocks(String(raw));

    // HTML-escape the raw string ONCE before any processing
    let t = String(raw)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Strip LaTeX delimiters (don't want $, \(, \[ etc. in panel output)
    t = t.split('\\(').join('').split('\\)').join('')
         .split('\\[').join('').split('\\]').join('')
         .split('$$').join('').split('$').join('');

    // ── 1. Greek letters ──────────────────────────────────────────────────
    const greek = {
      alpha:'α', beta:'β', gamma:'γ', delta:'δ', epsilon:'ε', varepsilon:'ε',
      zeta:'ζ', eta:'η', theta:'θ', vartheta:'ϑ', iota:'ι', kappa:'κ',
      lambda:'λ', mu:'μ', nu:'ν', xi:'ξ', omicron:'ο', rho:'ρ', varrho:'ϱ',
      sigma:'σ', varsigma:'ς', tau:'τ', upsilon:'υ', phi:'φ', varphi:'φ',
      chi:'χ', psi:'ψ', omega:'ω',
      // Capitals
      Alpha:'Α', Beta:'Β', Gamma:'Γ', Delta:'Δ', Epsilon:'Ε', Zeta:'Ζ',
      Eta:'Η', Theta:'Θ', Iota:'Ι', Kappa:'Κ', Lambda:'Λ', Mu:'Μ',
      Nu:'Ν', Xi:'Ξ', Pi:'Π', Rho:'Ρ', Sigma:'Σ', Tau:'Τ',
      Upsilon:'Υ', Phi:'Φ', Chi:'Χ', Psi:'Ψ', Omega:'Ω',
      // Common aliases
      pi:'π', infty:'∞', infinity:'∞', nabla:'∇', partial:'∂',
    };
    for (const [name, sym] of Object.entries(greek)) {
      t = t.replace(new RegExp(`\\\\${name}\\b|(?<![a-zA-Z])${name}(?![a-zA-Z])`, 'g'), sym);
    }

    // ── 2. Operators & relations ──────────────────────────────────────────
    t = t.replace(/\\cdot|\bcdot\b/g, '·');
    t = t.replace(/\\times|\btimes\b(?![a-z])/g, '×');
    t = t.replace(/\\div\b/g, '÷');
    t = t.replace(/\\pm\b|\bpm\b(?![a-z])/g, '±');
    t = t.replace(/\\mp\b/g, '∓');
    t = t.replace(/\\oplus\b/g, '⊕');
    t = t.replace(/\\otimes\b/g, '⊗');
    t = t.replace(/\\circ\b|\bcirc\b(?![a-z])/g, '∘');
    t = t.replace(/\\neq\b|!=(?!=)/g, '≠');
    t = t.replace(/\\approx\b|\bapprox\b/g, '≈');
    t = t.replace(/\\equiv\b|\bequiv\b(?![a-z])/g, '≡');
    t = t.replace(/\\propto\b|\bpropto\b/g, '∝');
    t = t.replace(/\\leq\b|<=(?!>)/g, '≤');
    t = t.replace(/\\geq\b|>=/g, '≥');
    t = t.replace(/\\ll\b/g, '≪');
    t = t.replace(/\\gg\b/g, '≫');
    t = t.replace(/\\in\b|\bin\b(?=\s)/g, '∈');
    t = t.replace(/\\notin\b|\bnotin\b/g, '∉');
    t = t.replace(/\\subset\b|\bsubset\b(?![e])/g, '⊂');
    t = t.replace(/\\supset\b|\bsupset\b/g, '⊃');
    t = t.replace(/\\subseteq\b|\bsubseteq\b/g, '⊆');
    t = t.replace(/\\supseteq\b|\bsupseteq\b/g, '⊇');
    t = t.replace(/\\emptyset\b|\bemptyset\b/g, '∅');
    t = t.replace(/\\cup\b|\bcup\b(?![a-z])/g, '∪');
    t = t.replace(/\\cap\b|\bcap\b(?![a-z])/g, '∩');
    t = t.replace(/\\forall\b|\bforall\b/g, '∀');
    t = t.replace(/\\exists\b|\bexists\b(?![a-z])/g, '∃');
    t = t.replace(/\\neg\b|\bnot\b(?=\s)/g, '¬');
    t = t.replace(/\\land\b|\band\b(?=\s)/g, '∧');
    t = t.replace(/\\lor\b|\bor\b(?=\s)/g, '∨');
    t = t.replace(/\\therefore\b|\btherefore\b/g, '∴');
    t = t.replace(/\\because\b|\bbecause\b(?=\s)/g, '∵');

    // ── 3. Arrows ─────────────────────────────────────────────────────────
    t = t.replace(/<==>/g, '⟺');
    t = t.replace(/==>/g, '⟹');
    t = t.replace(/<==(?!>)/g, '⟸');
    t = t.replace(/<=>/g, '⟺');
    t = t.replace(/=>/g, '⇒');
    t = t.replace(/\|->|\\mapsto\b/g, '↦');
    t = t.replace(/<->/g, '↔');
    t = t.replace(/->/g, '→');
    t = t.replace(/<-(?!>)/g, '←');
    t = t.replace(/\\uparrow\b/g, '↑');
    t = t.replace(/\\downarrow\b/g, '↓');

    // ── 4. Big operators with stacked limits ──────────────────────────────
    function bigop(sym, cls, top, bot, expr) {
      const tSpan = top  ? `<span class="pl-bigop-top">${top}</span>`  : '';
      const bSpan = bot  ? `<span class="pl-bigop-bot">${bot}</span>`  : '';
      const eSpan = expr ? `<span class="pl-bigop-expr">${expr}</span>` : '';
      return `<span class="pl-bigop ${cls}">${tSpan}<span class="pl-bigop-sym">${sym}</span>${bSpan}</span>${eSpan}`;
    }
    function bigopRegex(names) {
      return new RegExp(
        `(?:${names})\\s*_\\{([^}]*)\\}\\s*\\^\\{([^}]*)\\}\\s*(?:\\(([^)]{0,80})\\)|([^\\s<,]{1,60}))`,
        'gi'
      );
    }
    function bigopRegexNoExpr(names) {
      return new RegExp(`(?:${names})\\s*_\\{([^}]*)\\}\\s*\\^\\{([^}]*)\\}`, 'gi');
    }

    // ∑ Sigma / sum
    t = t.replace(bigopRegex('Σ|∑|[Ss]igma|[Ss]um'),
      (_, bot, top, e1, e2) => bigop('∑', 'pl-bigop-sum', top, bot, e1||e2||''));
    t = t.replace(bigopRegexNoExpr('Σ|∑|[Ss]igma|[Ss]um'),
      (_, bot, top) => bigop('∑', 'pl-bigop-sum', top, bot, ''));
    t = t.replace(/(?:Σ|∑|[Ss]igma)\(([^)]{0,80})\)/g,
      (_, e) => bigop('∑', 'pl-bigop-sum', '', '', `(${e})`));
    t = t.replace(/(?:Σ|∑)([^\s,.<&({]+)/g,
      (_, e) => bigop('∑', 'pl-bigop-sum', '', '', e));

    // ∏ Product / prod
    t = t.replace(bigopRegex('[Pp]rod|[Pp]roduct|∏'),
      (_, bot, top, e1, e2) => bigop('∏', 'pl-bigop-prod', top, bot, e1||e2||''));
    t = t.replace(bigopRegexNoExpr('[Pp]rod|[Pp]roduct|∏'),
      (_, bot, top) => bigop('∏', 'pl-bigop-prod', top, bot, ''));

    // ∫ Integrals — ordered longest-match first
    const intMap = [
      ['iiiint|ooiint',           '⨌', 'pl-bigop-int'],
      ['iiint|oiiint',            '∭', 'pl-bigop-int'],
      ['oiint|ooint|\\\\oiint',   '∯', 'pl-bigop-int'],
      ['oint|\\\\oint',           '∮', 'pl-bigop-int'],
      ['iint|\\\\iint',           '∬', 'pl-bigop-int'],
      ['integral|int|\\\\int',    '∫', 'pl-bigop-int'],
    ];
    for (const [names, sym, cls] of intMap) {
      t = t.replace(bigopRegex(names),
        (_, bot, top, e1, e2) => bigop(sym, cls, top, bot, e1||e2||''));
      t = t.replace(bigopRegexNoExpr(names),
        (_, bot, top) => bigop(sym, cls, top, bot, ''));
      t = t.replace(new RegExp(`(?:${names})\\s*\\(([^)]{0,80})\\)`, 'gi'),
        (_, e) => bigop(sym, cls, '', '', `(${e})`));
      t = t.replace(new RegExp(`\\b(?:${names})\\b(?!\\s*[_({])`, 'gi'),
        () => bigop(sym, cls, '', '', ''));
    }

    // lim_{x->a}
    t = t.replace(/\blim\s*_\{([^}]+)\}/g,
      (_, bot) => bigop('lim', 'pl-bigop-lim', '', bot.replace(/->/g, '→'), ''));

    // ── 5. Roots ──────────────────────────────────────────────────────────
    t = t.replace(/\\?sqrt\{([^}]{1,60})\}/g,
      (_, e) => `<span class="pl-sqrt">√<span class="pl-sqrt-body">${e}</span></span>`);
    t = t.replace(/\\?sqrt\(([^)]{1,60})\)/g,
      (_, e) => `<span class="pl-sqrt">√<span class="pl-sqrt-body">${e}</span></span>`);
    t = t.replace(/\\?root\{([^}]+)\}\{([^}]{1,60})\}/g,
      (_, n, e) => `<span class="pl-sqrt"><sup>${n}</sup>√<span class="pl-sqrt-body">${e}</span></span>`);
    t = t.replace(/\\?root\{([^}]+)\}\(([^)]{1,60})\)/g,
      (_, n, e) => `<span class="pl-sqrt"><sup>${n}</sup>√<span class="pl-sqrt-body">${e}</span></span>`);

    // ── 6. Fractions ──────────────────────────────────────────────────────
    t = t.replace(/\\?frac\{([^}]{1,40})\}\{([^}]{1,40})\}/g,
      (_, n, d) => `<span class="pl-frac"><span class="pl-frac-n">${n}</span><span class="pl-frac-d">${d}</span></span>`);
    t = t.replace(/\(([^)]{1,40})\)\/\(([^)]{1,40})\)/g,
      (_, n, d) => `<span class="pl-frac"><span class="pl-frac-n">${n}</span><span class="pl-frac-d">${d}</span></span>`);
    t = t.replace(/(?<![:/\w])([\w^]+)\/([\w^]+)(?![:/\w])/g, (m, n, d) => {
      if (m.includes('://')) return m;
      if (n.length + d.length > 20) return m;
      return `<span class="pl-frac"><span class="pl-frac-n">${n}</span><span class="pl-frac-d">${d}</span></span>`;
    });

    // ── 7. Derivatives ────────────────────────────────────────────────────
    t = t.replace(/\bd\/d([a-zA-Z])\s*\(([^)]{1,60})\)/g,
      (_, v, e) => `<span class="pl-frac"><span class="pl-frac-n">d</span><span class="pl-frac-d">d${v}</span></span>(${e})`);
    t = t.replace(/\bd\/d([a-zA-Z])\b/g,
      (_, v) => `<span class="pl-frac"><span class="pl-frac-n">d</span><span class="pl-frac-d">d${v}</span></span>`);
    t = t.replace(/\bd\^(\d+)\/d([a-zA-Z])\^(\d+)/g,
      (_, n, v, m) => `<span class="pl-frac"><span class="pl-frac-n">d<sup>${n}</sup></span><span class="pl-frac-d">d${v}<sup>${m}</sup></span></span>`);
    t = t.replace(/∂\/∂\{?([a-zA-Z])\}?/g,
      (_, v) => `<span class="pl-frac"><span class="pl-frac-n">∂</span><span class="pl-frac-d">∂${v}</span></span>`);
    t = t.replace(/\bpartial\/partial\{?([a-zA-Z])\}?/g,
      (_, v) => `<span class="pl-frac"><span class="pl-frac-n">∂</span><span class="pl-frac-d">∂${v}</span></span>`);
    // Prime notation
    t = t.replace(/([a-zA-Z])'''(?=[\s(]|$)/g, '$1‴');
    t = t.replace(/([a-zA-Z])''(?=[\s(]|$)/g,  '$1″');
    t = t.replace(/([a-zA-Z])'(?=[\s(]|$)/g,   '$1′');

    // ── 8. Superscripts & subscripts ──────────────────────────────────────
    t = t.replace(/([a-zA-Zα-ωΑ-Ω0-9∑∏∫])\^\{([^}]{1,40})\}/g, '$1<sup>$2</sup>');
    t = t.replace(/([a-zA-Zα-ωΑ-Ω0-9∑∏∫])\^\(([^)]{1,40})\)/g,  '$1<sup>$2</sup>');
    t = t.replace(/([a-zA-Zα-ωΑ-Ω0-9∑∏∫])\^(-?[a-zA-Z0-9]{1,6})\b/g, '$1<sup>$2</sup>');
    t = t.replace(/([a-zA-Zα-ωΑ-Ω])_\{([^}]{1,20})\}/g, '$1<sub>$2</sub>');
    t = t.replace(/([a-zA-Zα-ωΑ-Ω0-9])_([a-zA-Z0-9]{1,4})\b/g, '$1<sub>$2</sub>');
    t = t.replace(/([a-zA-Z])\{([^}]{1,12})\}/g, '$1<sub>$2</sub>'); // fallback braces as sub

    // ── 9. Vector / norm / abs ────────────────────────────────────────────
    t = t.replace(/\\?vec\{([^}]{1,20})\}/g,
      (_, v) => `<span class="pl-vec">${v}</span>`);
    t = t.replace(/\\\|([^|]{1,40})\\\|/g, (_, v) => `‖${v}‖`);
    t = t.replace(/\|\|([^|]{1,40})\|\|/g, (_, v) => `‖${v}‖`);
    t = t.replace(/\\?abs\(([^)]{1,40})\)/g, (_, v) => `|${v}|`);

    // ── 10. Floor / Ceiling ───────────────────────────────────────────────
    t = t.replace(/\\?floor\(([^)]{1,40})\)/g, (_, v) => `⌊${v}⌋`);
    t = t.replace(/\\?ceil\(([^)]{1,40})\)/g,  (_, v) => `⌈${v}⌉`);
    t = t.replace(/\\lfloor([^\\]{1,40})\\rfloor/g, (_, v) => `⌊${v}⌋`);
    t = t.replace(/\\lceil([^\\]{1,40})\\rceil/g,   (_, v) => `⌈${v}⌉`);

    // ── 11. Matrix / determinant ──────────────────────────────────────────
    t = t.replace(/\\?mat\{([^}]{1,120})\}/g, (_, inner) => {
      const rows = inner.split(';').map(row => {
        const cells = row.split(',').map(c => `<td>${c.trim()}</td>`).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      return `<span class="pl-mat"><span class="pl-mat-bracket">[</span><table class="pl-mat-table">${rows}</table><span class="pl-mat-bracket">]</span></span>`;
    });
    t = t.replace(/\bdet\b(?=\s*[({|])/g, '<span class="pl-fn">det</span>');

    // ── 12. Named functions (upright) ─────────────────────────────────────
    t = t.replace(/\b(arctan|arcsin|arccos|arccot|arcsec|arccsc|arctanh|arcsinh|arccosh|sinh|cosh|tanh|coth|sech|csch|sin|cos|tan|cot|sec|csc|ln|log(?:_\{[^}]+\})?|exp|lim|max|min|sup|inf|gcd|lcm|mod|deg|rank|dim|ker|im|span|tr|grad|div|curl)\b/g,
      '<span class="pl-fn">$1</span>');

    // ── 13. Special constants ─────────────────────────────────────────────
    t = t.replace(/\be\b(?=\^|\s*[=+\-*/])/g, '<em>e</em>');
    t = t.replace(/\bi\b(?=\s*[=+\-*/,)])/g,  '<em>i</em>');

    // ── 14. Big brackets ──────────────────────────────────────────────────
    t = t.replace(/\\left\(/g,  '<span class="pl-big-paren">(</span>');
    t = t.replace(/\\right\)/g, '<span class="pl-big-paren">)</span>');
    t = t.replace(/\\left\[/g,  '<span class="pl-big-paren">[</span>');
    t = t.replace(/\\right\]/g, '<span class="pl-big-paren">]</span>');

    // ── 15. Big O / complexity ────────────────────────────────────────────
    t = t.replace(/\bO\(([^)]{1,30})\)/g,  (_, e) => `<span class="pl-bigo">O</span>(${e})`);
    t = t.replace(/\bΘ\(([^)]{1,30})\)/g,  (_, e) => `<span class="pl-bigo">Θ</span>(${e})`);
    t = t.replace(/\bΩ\(([^)]{1,30})\)/g,  (_, e) => `<span class="pl-bigo">Ω</span>(${e})`);

    return t;
  }

  // keep upgradeMathNotation as alias for backward compat
  function upgradeMathNotation(t) { return mathHtml(t); }

  function renderMathInPanel(panel) {
    // Math rendering handled by openLatexTab() — panel shows clean readable text only
  }

  // ── Detect lecture type from content (fallback if AI did not return it) ────
  function detectLectureType(result) {
    const str = JSON.stringify(result).toLowerCase();
    if (str.includes('\\\\') || str.includes('$$') || str.includes('\\\\sum') || str.includes('theorem') || str.includes('lemma')) return 'math';
    if (str.includes('```') || str.includes('function ') || str.includes('algorithm') || str.includes('runtime') || str.includes('O(n')) return 'coding';
    if (str.includes('cell') || str.includes('molecule') || str.includes('reaction') || str.includes('organism') || str.includes('enzyme')) return 'science';
    return 'humanities';
  }

  // ── Apply visual theme based on lecture type ──────────────────────────────
  function applyLectureTheme(panel, ltype) {
    panel.setAttribute('data-lecture-type', ltype || 'default');
    const header = panel.querySelector('.pl-header-title');
    if (header && !header.querySelector('.pl-type-badge')) {
      const badges = {
        math:       { label: '\u03a3 Math',    color: '#a78bfa', bg: '#1e1b4b' },
        coding:     { label: '\u2328 Code',    color: '#34d399', bg: '#022c22' },
        science:    { label: '\U0001f52c Science', color: '#60a5fa', bg: '#0c1a3a' },
        humanities: { label: '\U0001f4d6 Arts',   color: '#f97316', bg: '#1c0a00' },
      };
      const b = badges[ltype] || badges.humanities;
      const badge = document.createElement('span');
      badge.className = 'pl-type-badge';
      badge.textContent = b.label;
      badge.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:20px;margin-left:8px;background:' + b.bg + ';color:' + b.color + ';border:1px solid ' + b.color + '40;letter-spacing:1px;vertical-align:middle;';
      header.appendChild(badge);
    }
    if (ltype === 'coding') {
      panel.querySelectorAll('pre, .pl-code-block').forEach(function(el) {
        el.style.cssText = 'background:#0d1117;color:#e6edf3;border-radius:8px;padding:12px;font-family:monospace;font-size:12px;overflow-x:auto;border:1px solid #30363d;';
      });
    }
  }

  // ── Detect if result contains math symbols ───────────────────────────────
  function hasMathContent(result) {
    const str = JSON.stringify(result);
    return /\\\\|\$\$|frac\{|Sigma_|int_/.test(str);
  }

  // ── Open new tab with KaTeX-rendered LaTeX notes ──────────────────────────
  function openLatexTab(result, title) {
    const sections = [];

    if (result.summary) {
      sections.push(`<h2>📋 Summary</h2>
        <p>${result.summary.tldr || ''}</p>
        <p><strong>Key Takeaway:</strong> ${result.summary.what_to_remember || ''}</p>`);
    }

    if (result.concepts_3step?.length) {
      sections.push(`<h2>📚 Concepts</h2>` + result.concepts_3step.map((c,i) => `
        <div class="concept">
          <div class="concept-title">${i+1}. ${c.title || ''}</div>
          <div class="concept-row"><span class="badge def">DEF</span><span>${c.step1_definition || ''}</span></div>
          <div class="concept-row"><span class="badge why">WHY</span><span>${c.step2_principle || ''}</span></div>
          <div class="concept-row"><span class="badge use">USE</span><span>${c.step3_application || ''}</span></div>
        </div>`).join(''));
    }

    if (result.exam_questions?.length) {
      sections.push(`<h2>🎯 Exam Questions</h2>` + result.exam_questions.map((q,i) => `
        <div class="exam-q">
          <div class="q-label"><span class="badge ${(q.type||'').toLowerCase()}">${q.type||'Q'}</span> <span class="difficulty">${q.difficulty||''}</span></div>
          <div class="q-text"><strong>Q${i+1}.</strong> ${q.question||''}</div>
          <details><summary>Show Answer</summary><div class="answer">${q.answer||''}</div></details>
        </div>`).join(''));
    }

    if (result.concept_summary?.sections?.length) {
      sections.push(`<h2>🗂 Concept Summary</h2>` + result.concept_summary.sections.map(sec => `
        <div class="cs-section">
          <div class="cs-heading">${sec.heading||''}</div>
          ${(sec.items||[]).map(item => `
            <div class="cs-item">
              <strong>${item.label||''}</strong>
              ${(item.steps||[]).map(s => `
                <div class="cs-step">
                  <em>${s.title||''}</em> — ${s.prose||''}
                  ${s.equation ? `<div class="eq">$$${s.equation}$$</div>` : ''}
                </div>`).join('')}
            </div>`).join('')}
        </div>`).join(''));
    }

    if (result.flashcards?.length) {
      sections.push(`<h2>🃏 Flashcards</h2>` + result.flashcards.map(f => `
        <div class="flashcard">
          <div class="fc-front">${f.front||''}</div>
          <div class="fc-back">${f.back||''}</div>
        </div>`).join(''));
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title || 'PanoLearn Notes'}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body, {
      delimiters: [
        {left: '$$', right: '$$', display: true},
        {left: '\\(', right: '\\)', display: false},
        {left: '$', right: '$', display: false}
      ]
    })"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Georgia', serif; background: #fafaf8; color: #1a1a1a; max-width: 860px; margin: 0 auto; padding: 40px 24px; }
    h1 { font-size: 26px; color: #c84b1f; margin-bottom: 8px; }
    .subtitle { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 40px; }
    h2 { font-size: 18px; margin: 40px 0 16px; padding-bottom: 8px; border-bottom: 2px solid #e8e0d0; }
    .concept { background: white; border: 1px solid #e0d8c8; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
    .concept-title { font-size: 15px; font-weight: bold; margin-bottom: 12px; }
    .concept-row { display: flex; gap: 12px; margin-bottom: 8px; align-items: flex-start; }
    .badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 3px 7px; border-radius: 4px; letter-spacing: 1px; white-space: nowrap; }
    .def { background: #d4edda; color: #155724; }
    .why { background: #fff3cd; color: #856404; }
    .use { background: #f8d7da; color: #721c24; }
    .computation { background: #d0e4ff; color: #1a3c6e; }
    .proof { background: #ffd0d0; color: #6e1a1a; }
    .application { background: #d0ffd8; color: #1a6e2a; }
    .derivation { background: #e8d0ff; color: #4a1a6e; }
    .exam-q { background: white; border: 1px solid #e0d8c8; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
    .q-label { margin-bottom: 8px; display: flex; gap: 8px; align-items: center; }
    .difficulty { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
    .q-text { font-size: 15px; margin-bottom: 10px; line-height: 1.6; }
    details summary { cursor: pointer; color: #c84b1f; font-size: 13px; margin-top: 8px; }
    .answer { margin-top: 12px; padding: 12px; background: #f5f0e8; border-radius: 8px; line-height: 1.8; }
    .eq { text-align: center; margin: 10px 0; }
    .cs-section { margin-bottom: 20px; }
    .cs-heading { font-size: 15px; font-weight: bold; color: #c84b1f; margin-bottom: 10px; }
    .cs-item { background: white; border: 1px solid #e0d8c8; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
    .cs-step { margin-top: 8px; color: #444; line-height: 1.6; }
    .flashcard { display: flex; gap: 0; border: 1px solid #e0d8c8; border-radius: 8px; overflow: hidden; margin-bottom: 10px; }
    .fc-front { flex: 1; padding: 12px; background: #0d0d0d; color: #f5f0e8; font-weight: bold; }
    .fc-back  { flex: 2; padding: 12px; background: white; }
    .katex-display { overflow-x: auto; }
  </style>
</head>
<body>
  <h1>${title || 'Lecture Notes'}</h1>
  <div class="subtitle">PanoLearn · AI Study Notes with LaTeX Math</div>
  ${sections.join('\n')}
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    window.open(url, '_blank');
  }

  function init() {
    installPanoptoNetworkSniffer();
    const found = extractPanoptoUrl();
    if (found) {
      injectPanel(found, extractPageTitle());
    } else {
      const obs = new MutationObserver(() => {
        const f = extractPanoptoUrl();
        if (f) { obs.disconnect(); injectPanel(f, extractPageTitle()); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 15000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
