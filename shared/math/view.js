/* Only app-generated escaped HTML reaches this local document. */
(function () {
  'use strict';
  var revision = 0, cache = new Map(), size = 0, fontsReady = false, units = [];
  function post(value) {
    if (window.webkit && window.webkit.messageHandlers.math) window.webkit.messageHandlers.math.postMessage(value);
    else if (window.OrbisMathBridge) window.OrbisMathBridge.postMessage(JSON.stringify(value));
  }
  function measure() {
    if (!fontsReady) return;
    var height = Math.ceil(document.getElementById('content').getBoundingClientRect().height);
    post(height > 32768 ? {type: 'failure'} : {type: 'size', revision: revision, height: height});
  }
  function prepareReveal(content) {
    var leaves = [], length = 0;
    function walk(node) {
      if (node.nodeType === 3) { leaves.push({node:node,offset:length}); length += node.textContent.length; }
      else if (node.nodeType === 1 && node.hasAttribute('data-raw')) {
        length += node.getAttribute('data-raw').length;
        leaves.push({node:node,offset:Math.max(0,length - 1),math:true});
      } else if (node.nodeName === 'BR') length++;
      else Array.from(node.childNodes).forEach(walk);
    }
    walk(content); units = [];
    var from = Math.max(0,length - 128);
    leaves.forEach(function (leaf) {
      if (leaf.math) { units.push({node:leaf.node,offset:leaf.offset}); return; }
      var text = leaf.node.textContent, start = Math.max(0, from - leaf.offset);
      if (start >= text.length) return;
      // A small trailing window preserves graphemes without creating a span for the whole history.
      if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start--;
      var fragment = document.createDocumentFragment();
      fragment.appendChild(document.createTextNode(text.slice(0,start)));
      var tail = text.slice(start), chunks = window.Intl && Intl.Segmenter
        ? Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(tail)).map(function (v) { return v.segment; })
        : Array.from(tail);
      chunks.forEach(function (chunk) {
        var span = document.createElement('span'); span.textContent = chunk;
        fragment.appendChild(span); units.push({node:span,offset:leaf.offset+start}); start += chunk.length;
      });
      leaf.node.replaceWith(fragment);
    });
  }
  function reveal(r) {
    units.forEach(function (unit) {
      if (unit.animation) { unit.animation.cancel(); unit.animation = null; }
      var at = unit.offset, node = unit.node;
      if (!r || at < r.from) { node.style.opacity = '1'; return; }
      if (at >= r.known) { node.style.opacity = '0'; return; }
      var delay = r.delays[at-r.from];
      if (delay == null || delay <= -120) { node.style.opacity = '1'; return; }
      node.style.opacity = '1';
      unit.animation = node.animate([{opacity:0,filter:'blur(6px)'},{opacity:1,filter:'blur(0px)'}],
        {duration:120,delay:delay,fill:'both',easing:'linear'});
    });
  }
  window.OrbisMathView = {update: function (p) {
    revision = p.revision;
    fontsReady = false;
    document.body.style.fontSize = p.fontSize + 'px';
    document.body.style.lineHeight = String(p.lineHeight || 1.5);
    document.body.style.fontWeight = p.bold ? '600' : '400';
    document.body.style.textAlign = p.align || 'left';
    document.body.style.setProperty('--ink', p.color);
    document.body.style.setProperty('--link', p.linkColor);
    document.body.className = p.selectable === false ? 'no-selection' : '';
    var content = document.getElementById('content');
    content.innerHTML = p.html;
    prepareReveal(content);
    content.querySelectorAll('.math-source').forEach(function (element) {
      var tex = element.getAttribute('data-tex'), display = element.classList.contains('display');
      var key = (display ? 'D' : 'I') + tex;
      try {
        if (tex.length > 16384 || /\\(?:href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData)\b/.test(tex)) throw Error('unsupported formula');
        var html = cache.get(key);
        if (!html) {
          html = katex.renderToString(tex, {displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20, output: 'htmlAndMathml', macros: {}});
          if (html.length < 262144) {
            cache.set(key, html); size += key.length + html.length;
            while (cache.size > 128 || size > 1048576) { var first = cache.keys().next().value; size -= first.length + cache.get(first).length; cache.delete(first); }
          }
        }
        element.innerHTML = html;
        if (element.getBoundingClientRect().height > 8192) throw Error('formula height');
      } catch (_) {
        element.textContent = element.getAttribute('data-raw');
        element.className = 'math-fallback';
      }
    });
    var current = revision;
    // Hidden first-layout hosts can suspend RAF. Font completion must report a size directly.
    document.fonts.ready.then(function () { if (current === revision) { fontsReady = true; measure(); } });
  }, reveal: reveal};
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a');
    if (link) { e.preventDefault(); post({type: 'link', value: link.getAttribute('href')}); }
  });
  document.addEventListener('copy', function (e) {
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount || !e.clipboardData) return;
    var range = selection.getRangeAt(0).cloneRange();
    function formula(node) { var element = node.nodeType === 1 ? node : node.parentElement; return element ? element.closest('[data-raw]') : null; }
    var first = formula(range.startContainer), last = formula(range.endContainer);
    // Partial glyph selections copy the complete expression, never duplicated HTML/MathML.
    if (first) range.setStartBefore(first);
    if (last) range.setEndAfter(last);
    var fragment = range.cloneContents();
    fragment.querySelectorAll('[data-raw]').forEach(function (el) { el.replaceWith(document.createTextNode(el.getAttribute('data-raw'))); });
    fragment.querySelectorAll('br').forEach(function (el) { el.replaceWith(document.createTextNode('\n')); });
    e.clipboardData.setData('text/plain', fragment.textContent); e.preventDefault();
  });
  if (window.ResizeObserver) new ResizeObserver(measure).observe(document.getElementById('content'));
  window.addEventListener('resize', measure);
  post({type: 'ready'});
})();
