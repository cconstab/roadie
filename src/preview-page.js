// This file runs in the browser, inside the previewed page. The preview proxy
// serves it as /__roadie/reload.js and adds one <script> tag for it to HTML pages.
//
// It does two things:
//   1. Tells Roadie which page is showing, and reloads the page when a file changes.
//   2. When "Edit on page" is switched on in Roadie: lets the owner click an
//      element to point the AI at it, and double-click text to change it.
//      A small toolbar on the clicked element offers the things that can be
//      done to it. The page only reports what was clicked or typed. Roadie
//      does the editing.
// It changes styles through script only (never markup), so a strict
// Content-Security-Policy on the site does not get in its way.
(function () {
  function say(message) { try { parent.postMessage(message, '*'); } catch (e) { /* no parent */ } }
  function page() { return location.pathname + location.search; }

  say({ roadie: 'page', path: location.pathname + location.search + location.hash });
  var es = new EventSource('/__roadie/events');
  es.addEventListener('reload', function () { location.reload(); });

  if (parent === window) return; // opened on its own, not inside Roadie

  var on = false;        // is "Edit on page" switched on?
  var box = null;        // the outline drawn round what the pointer is over
  var editing = null;    // { el, nodes, values, html, outline } while text is being changed
  var clickTimer = null;
  var chosen = null;     // the element last clicked, which the toolbar belongs to
  var chosenBox = null;  // the outline that stays round it
  var bar = null;        // the toolbar

  function squash(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

  // A short CSS path to the element, good enough for a person or the AI to find it.
  function selector(el) {
    var parts = [];
    for (var node = el; node && node.nodeType === 1 && node !== document.documentElement && parts.length < 5; node = node.parentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      var classes = String(node.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      var same = node.parentElement ? Array.prototype.filter.call(node.parentElement.children, function (c) { return c.tagName === node.tagName; }) : [];
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function describe(el) {
    var out = {
      page: page(),
      tag: el.tagName.toLowerCase(),
      selector: selector(el),
      text: squash(el.innerText || el.textContent).slice(0, 200),
      html: String(el.outerHTML || '').slice(0, 400),
    };
    var link = el.closest ? el.closest('a[href]') : null;
    if (link) out.link = String(link.getAttribute('href') || '').slice(0, 300);
    if (el.tagName === 'IMG') {
      out.image = { alt: el.getAttribute('alt') || '', attr: el.getAttribute('src') || '' };
      try { var u = new URL(el.currentSrc || el.src, location.href); if (u.origin === location.origin) out.image.path = u.pathname; } catch (e) { /* not a usable address */ }
    }
    return out;
  }

  function showBox(el) {
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('aria-hidden', 'true');
      var s = box.style;
      s.position = 'fixed'; s.pointerEvents = 'none'; s.zIndex = '2147483647'; s.boxSizing = 'border-box';
      s.border = '2px solid #1f5fd1'; s.background = 'rgba(31, 95, 209, 0.10)'; s.borderRadius = '2px'; s.margin = '0';
    }
    if (!el) { if (box.parentNode) box.parentNode.removeChild(box); return; }
    var r = el.getBoundingClientRect();
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    if (!box.parentNode) document.documentElement.appendChild(box);
  }

  // A piece of Roadie's own furniture on the page. Styled through script, starting
  // from nothing, so the site's stylesheet does not restyle it.
  function furniture(tag, styles) {
    var el = document.createElement(tag);
    el.style.all = 'initial';
    for (var key in styles) el.style[key] = styles[key];
    return el;
  }

  function canRetype(el) {
    var holder = withText(el);
    return !!holder && !/^(SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION)$/.test(holder.tagName);
  }

  function barButton(label, action, title) {
    var b = furniture('button', {
      font: '600 13px/1 system-ui, sans-serif', color: '#ffffff', background: 'transparent', cursor: 'pointer',
      padding: '7px 9px', borderRadius: '4px', whiteSpace: 'nowrap', display: 'inline-block',
    });
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('data-roadie-action', action);
    b.addEventListener('mouseenter', function () { b.style.background = 'rgba(255, 255, 255, 0.22)'; });
    b.addEventListener('mouseleave', function () { b.style.background = 'transparent'; });
    return b;
  }

  // Put the outline and the toolbar where the chosen element is now.
  function placeChosen() {
    if (!chosen) return;
    if (!chosen.isConnected) return choose(null);
    var r = chosen.getBoundingClientRect();
    var s = chosenBox.style;
    s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
    var w = bar.offsetWidth, h = bar.offsetHeight;
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    // Above the element when there is room, else below it, else just inside its top edge.
    var top = r.top - h - 6;
    if (top < 4) top = r.bottom + 6;
    if (top + h > vh - 4) top = Math.max(4, Math.min(r.top + 6, vh - h - 4));
    bar.style.top = top + 'px';
    bar.style.left = Math.max(4, Math.min(r.left, vw - w - 4)) + 'px';
  }

  // Mark an element as the one being pointed at and show its toolbar, or clear both.
  function choose(el) {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    if (chosenBox && chosenBox.parentNode) chosenBox.parentNode.removeChild(chosenBox);
    chosen = el;
    if (!el) return;
    chosenBox = furniture('div', {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483646', boxSizing: 'border-box',
      border: '2px solid #1f5fd1', borderRadius: '2px', display: 'block',
    });
    chosenBox.setAttribute('aria-hidden', 'true');
    bar = furniture('div', {
      position: 'fixed', zIndex: '2147483647', display: 'flex', gap: '2px', padding: '3px',
      background: '#1f5fd1', borderRadius: '6px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)', cursor: 'default',
    });
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Roadie: change this element');
    if (el.tagName === 'IMG') bar.appendChild(barButton('Replace image', 'replace', 'Choose another picture to take the place of this one'));
    if (canRetype(el)) bar.appendChild(barButton('Edit text', 'retype', 'Change these words (the same as a double-click)'));
    bar.appendChild(barButton(el.closest('a[href]') ? 'Change link' : 'Link', 'link', 'Choose a page for this to link to'));
    bar.appendChild(barButton('Ask AI', 'ask', 'Type what the AI should do with this'));
    bar.appendChild(barButton('Delete', 'delete', 'Ask the AI to remove this from the page'));
    document.documentElement.appendChild(chosenBox);
    document.documentElement.appendChild(bar);
    placeChosen();
  }

  function inBar(target) { return !!bar && !!target && bar.contains(target); }

  function barAction(target) {
    var button = target.closest ? target.closest('[data-roadie-action]') : null;
    var el = chosen;
    if (!button || !el) return;
    var action = button.getAttribute('data-roadie-action');
    if (action === 'retype') { choose(null); return startEditing(el, -1, -1); }
    say({ roadie: 'action', action: action, pick: describe(el) });
  }

  function textNodes(el) {
    var out = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  // The nearest element, from the one clicked upwards, that holds words of its own.
  function withText(el) {
    for (var node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      var own = Array.prototype.some.call(node.childNodes, function (c) { return c.nodeType === 3 && squash(c.data); });
      if (own) return node;
    }
    return null;
  }

  // Put the typing cursor where the pointer is, or at the end of the text.
  function placeCursor(el, x, y) {
    var range = null;
    try {
      if (document.caretPositionFromPoint) {
        var pos = document.caretPositionFromPoint(x, y);
        if (pos && el.contains(pos.offsetNode)) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
      } else if (document.caretRangeFromPoint) {
        var r = document.caretRangeFromPoint(x, y);
        if (r && el.contains(r.startContainer)) range = r;
      }
    } catch (e) { /* fall through to the end of the text */ }
    if (!range) { range = document.createRange(); range.selectNodeContents(el); range.collapse(false); }
    range.collapse(true);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function startEditing(target, x, y) {
    var el = withText(target);
    if (!el || /^(SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION)$/.test(el.tagName)) return say({ roadie: 'pick', pick: describe(target) });
    el.normalize();
    var nodes = textNodes(el);
    editing = {
      el: el, described: describe(el), html: el.innerHTML, outline: el.style.outline, offset: el.style.outlineOffset,
      nodes: nodes.map(function (n) {
        return { before: n.data, parent: n.parentElement.tagName.toLowerCase(), first: n.parentElement.firstChild === n, last: n.parentElement.lastChild === n };
      }),
      was: el.getAttribute('contenteditable'),
      kids: el.querySelectorAll('*').length,
    };
    showBox(null);
    choose(null);
    el.setAttribute('contenteditable', 'plaintext-only');
    if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true'); // older browsers
    el.style.outline = '2px solid #1f5fd1';
    el.style.outlineOffset = '2px';
    el.focus();
    placeCursor(el, x, y);
    say({ roadie: 'editing', on: true });
  }

  function stopEditing(keep) {
    var e = editing;
    if (!e) return;
    editing = null;
    var el = e.el;
    if (e.was === null) el.removeAttribute('contenteditable'); else el.setAttribute('contenteditable', e.was);
    el.style.outline = e.outline;
    el.style.outlineOffset = e.offset;
    say({ roadie: 'editing', on: false });
    if (!keep) { el.innerHTML = e.html; return; }
    el.normalize();
    var now = textNodes(el);
    var message = { roadie: 'text', where: e.described, beforeText: squash(e.nodes.map(function (n) { return n.before; }).join('')), afterText: squash(el.textContent), changes: null };
    if (message.beforeText === message.afterText) { el.innerHTML = e.html; return; }
    // The same pieces of text, some reworded: each can be found in the site's files.
    // Anything else (text joined across tags, a line break added) is left for the AI.
    if (now.length === e.nodes.length && el.querySelectorAll('*').length === e.kids) {
      message.changes = [];
      for (var i = 0; i < now.length; i++) {
        if (now[i].data !== e.nodes[i].before) message.changes.push({ before: e.nodes[i].before, after: now[i].data, parent: e.nodes[i].parent, first: e.nodes[i].first, last: e.nodes[i].last });
      }
    }
    say(message);
  }

  function inEditing(target) { return editing && editing.el.contains(target); }

  document.addEventListener('mousemove', function (e) {
    if (!on || editing) return;
    if (inBar(e.target)) return showBox(null);
    showBox(e.target && e.target.nodeType === 1 && e.target !== document.documentElement && e.target !== document.body ? e.target : null);
  }, true);
  document.addEventListener('mouseleave', function () { showBox(null); }, true);
  window.addEventListener('scroll', function () { showBox(null); placeChosen(); }, true);
  window.addEventListener('resize', placeChosen);
  // Keep the page's focus where it is when the toolbar is pressed.
  document.addEventListener('mousedown', function (e) { if (on && inBar(e.target)) e.preventDefault(); }, true);

  document.addEventListener('click', function (e) {
    if (!on) return;
    if (inEditing(e.target)) return; // placing the cursor in the text being changed
    e.preventDefault();
    e.stopPropagation();
    if (inBar(e.target)) return barAction(e.target);
    if (editing) return stopEditing(true); // a click elsewhere finishes the text
    var target = e.target;
    if (!target || target.nodeType !== 1 || target === document.documentElement) return;
    clearTimeout(clickTimer);
    // Wait a moment: this may be the first half of a double-click.
    clickTimer = setTimeout(function () { choose(target); say({ roadie: 'pick', pick: describe(target) }); }, 280);
  }, true);

  document.addEventListener('dblclick', function (e) {
    if (!on || inEditing(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (inBar(e.target)) return;
    clearTimeout(clickTimer);
    if (e.target && e.target.nodeType === 1) startEditing(e.target, e.clientX, e.clientY);
  }, true);

  document.addEventListener('keydown', function (e) {
    if (!editing && chosen && e.key === 'Escape') { choose(null); return say({ roadie: 'unpick' }); }
    if (!editing) return;
    if (e.key === 'Escape') { e.preventDefault(); stopEditing(false); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); stopEditing(true); }
  }, true);
  document.addEventListener('focusout', function (e) { if (editing && e.target === editing.el) stopEditing(true); }, true);
  // Forms are not sent while pointing: a click on a button is a click to point.
  document.addEventListener('submit', function (e) { if (on) { e.preventDefault(); e.stopPropagation(); } }, true);

  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.roadie === 'unpick') return choose(null); // Roadie stopped pointing at it
    if (e.data.roadie !== 'edit') return;
    on = !!e.data.on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) { stopEditing(true); showBox(null); choose(null); clearTimeout(clickTimer); }
  });
})();
