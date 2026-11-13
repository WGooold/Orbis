/* MATH-01. ES5 for JavaScriptCore and Rhino; never evaluates message text. */
(function (root) {
  'use strict';
  var tick = String.fromCharCode(96);
  var environments = /^(equation|equation\*|align|align\*|alignat|alignat\*|gather|gather\*|displaymath|math)$/;
  function escaped(s, i) { var n = 0; while (i > 0 && s.charAt(--i) === '\\') n++; return n % 2 === 1; }
  function closeAt(s, end, start, limit) {
    var at = s.indexOf(end, start);
    while (at >= 0 && at < limit) {
      if (!escaped(s, at)) return at;
      at = s.indexOf(end, at + end.length);
    }
    return -1;
  }
  function protect(source) {
    function bypass() { return {text: source, prefix: '', tokens: [], bypass: true}; }
    if (source.length > 262144) return bypass();
    var prefix = '\uE000orbis-math-';
    while (source.indexOf(prefix) >= 0) prefix += '-';
    var tokens = [], output = [], cursor = 0, i = 0, count = 0, listIndent = -1;
    function save(start, finish, tex, display, pending) {
      var marker = prefix + tokens.length + '\uE001';
      // Strip Markdown quote prefixes only from the engine input; raw copy stays exact.
      var lineBefore = source.slice(source.lastIndexOf('\n', start - 1) + 1, start);
      if (/^ *(?:> ?)+/.test(lineBefore)) tex = tex.replace(/(^|\n) {0,3}(?:> ?)+/g, '$1');
      tokens.push({marker: marker, raw: source.slice(start, finish), tex: tex, display: display, pending: !!pending || !tex || tex.length > 16384 || count++ >= 128});
      output.push(source.slice(cursor, start), marker); cursor = finish; i = finish;
    }
    while (i < source.length) {
      if (tokens.length >= 512) return bypass();
      var lineStart = i === 0 || source.charAt(i - 1) === '\n';
      if (lineStart) {
        var nextLine = source.indexOf('\n', i); if (nextLine < 0) nextLine = source.length;
        var line = source.slice(i, nextLine);
        var list = /^(\s*)(?:[-+*]|\d+[.)]) +/.exec(line);
        if (list) listIndent = list[0].length;
        else if (line.trim() && !/^\s|^>/.test(line)) listIndent = -1;
        var prefixMatch = /^(?: {0,3}> ?)* {0,3}/.exec(line)[0];
        // Fences nested under a list still delimit code; four-space standalone code does not.
        if (list) prefixMatch = list[0];
        else if (listIndent >= 0) {
          var indentation = /^ */.exec(line)[0];
          if (indentation.length < listIndent + 4) prefixMatch = indentation;
        }
        var content = line.slice(prefixMatch.length);
        var fence = /^(~{3,}|`{3,})([^\n]*)$/.exec(content);
        if (fence) {
          var p = nextLine < source.length ? nextLine + 1 : nextLine, end = source.length, closed = false, bodyEnd = end;
          while (p < source.length) {
            var nl = source.indexOf('\n', p); if (nl < 0) nl = source.length;
            var candidate = source.slice(p, nl).replace(/^(?: {0,3}> ?)+/, '');
            var closingIndent = /^ */.exec(candidate)[0].length;
            if (closingIndent <= (listIndent >= 0 ? listIndent : 0) + 3) candidate = candidate.slice(closingIndent);
            var run = 0; while (candidate.charAt(run) === fence[1].charAt(0)) run++;
            if (run >= fence[1].length && /^\s*$/.test(candidate.slice(run))) { bodyEnd = p; end = nl; closed = true; break; }
            p = nl + 1;
          }
          if (fence[2].replace(/^\s+|\s+$/g, '') === 'math' && closed) {
            save(i + prefixMatch.length, end, source.slice(nextLine + 1, bodyEnd).replace(/\n$/, ''), true, false);
          } else { i = end; }
          continue;
        }
        // Four-space/tab blocks and reference destinations retain literal syntax.
        var unquoted = line.replace(/^(?: {0,3}> ?)+/, '');
        if ((/^(?: {4}|\t)/.test(unquoted) && !list && (listIndent < 0 || /^\s*/.exec(unquoted)[0].length >= listIndent + 4)) || /^ {0,3}\[[^\]]+\]:/.test(unquoted)) { i = nextLine + 1; continue; }
      }
      var c = source.charAt(i);
      if ((i === 0 || /[\s(<]/.test(source.charAt(i - 1))) && /^(?:https?:\/\/|mailto:)/i.test(source.slice(i, i + 8))) {
        var url = /^(?:https?:\/\/|mailto:)[^\s<>]+/i.exec(source.slice(i));
        if (url) { i += url[0].length; continue; }
      }
      if (c === tick) {
        var runEnd = i + 1; while (source.charAt(runEnd) === tick) runEnd++;
        var marks = source.slice(i, runEnd), closing = source.indexOf(marks, runEnd);
        while (closing >= 0 && (source.charAt(closing - 1) === tick || source.charAt(closing + marks.length) === tick)) closing = source.indexOf(marks, closing + marks.length);
        i = closing < 0 ? runEnd : closing + marks.length; continue;
      }
      if (c === ']' && source.charAt(i + 1) === '(') {
        var depth = 1; i += 2;
        while (i < source.length && depth) { if (source.slice(i, i + 2) === '\n\n') break; if (source.charAt(i) === '\\') { i += 2; continue; } if (source.charAt(i) === '(') depth++; if (source.charAt(i) === ')') depth--; i++; }
        continue;
      }
      if (c === '<') {
        if (source.slice(i, i + 4) === '<!--') {
          var commentEnd = source.indexOf('-->', i + 4);
          i = commentEnd < 0 ? source.length : commentEnd + 3; continue;
        }
        var tagEnd = source.indexOf('>', i + 1);
        if (tagEnd >= 0 && /^<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)|!--|https?:\/\/)/.test(source.slice(i, tagEnd + 1))) {
          var tag = /^<([A-Za-z][A-Za-z0-9-]*)[\s>]/.exec(source.slice(i, tagEnd + 1));
          var tagClose = tag ? source.toLowerCase().indexOf('</' + tag[1].toLowerCase() + '>', tagEnd + 1) : -1;
          if (tag && tagClose < 0 && /^(?:pre|script|style|textarea|div|table|section|article|details)$/i.test(tag[1])) {
            var htmlEnd = /^(?:pre|script|style|textarea)$/i.test(tag[1]) ? -1 : source.indexOf('\n\n', tagEnd);
            i = htmlEnd < 0 ? source.length : htmlEnd; continue;
          }
          i = tagClose >= 0 ? tagClose + tag[1].length + 3 : tagEnd + 1; continue;
        }
      }
      var begin = '', endMark = '', display = false, environment = null;
      if (c === '\\') {
        if (source.charAt(i + 1) === '(') { begin = '\\('; endMark = '\\)'; }
        else if (source.charAt(i + 1) === '[') { begin = '\\['; endMark = '\\]'; display = true; }
        else {
          environment = /^\\begin\{([^}]+)\}/.exec(source.slice(i));
          var before = source.slice(source.lastIndexOf('\n', i - 1) + 1, i);
          if (environment && environments.test(environment[1]) && /^(?:\s|>)*$/.test(before)) { begin = environment[0]; endMark = '\\end{' + environment[1] + '}'; display = true; }
          else { i += 2; continue; }
        }
      } else if (c === '$') {
        if (source.charAt(i + 1) === '$') { begin = '$$'; endMark = '$$'; display = true; }
        else if (source.charAt(i + 1) && !/\s/.test(source.charAt(i + 1))) { begin = '$'; endMark = '$'; }
      }
      if (!begin) { i++; continue; }
      var limit = source.length;
      if (!display) { var newline = source.indexOf('\n', i + begin.length); if (newline >= 0) limit = newline; }
      var endIndex = closeAt(source, endMark, i + begin.length, limit);
      if (endIndex >= 0 && begin === '$' && (/\s/.test(source.charAt(endIndex - 1)) || /[0-9]/.test(source.charAt(endIndex + 1)) || source.charAt(endIndex + 1) === '$')) { i++; continue; }
      if (endIndex >= 0) {
        var tex = source.slice(i + begin.length, endIndex);
        if (begin === '$' && (!tex || /^[+-]?[0-9][0-9,.]*(?:\s*(?:USD|EUR|RMB))?$/.test(tex))) { i = endIndex + endMark.length; continue; }
        var finish = endIndex + endMark.length;
        save(i, finish, environment ? source.slice(i, finish) : tex, display, false);
      } else if (begin !== '$') {
        // Preserve unfinished TeX without consuming later paragraphs.
        var paragraphEnd = source.indexOf('\n\n', i + begin.length);
        var pendingEnd = paragraphEnd >= 0 ? Math.min(limit, paragraphEnd) : limit;
        save(i, pendingEnd, source.slice(i, pendingEnd), display, true);
      } else { i++; }
    }
    output.push(source.slice(cursor));
    return {text: output.join(''), prefix: prefix, tokens: tokens};
  }
  function escapeHTML(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function visible(s) { return escapeHTML(s).replace(/\n/g, '<br>'); }
  function inlineHTML(runs, prepared) {
    var result = [], found = false;
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r], value = run.text, parts = [], at = 0, match;
      if (run.code) {
        for (var t = 0; t < prepared.tokens.length; t++) {
          var literal = prepared.tokens[t];
          value = value.split(literal.marker).join(literal.raw);
        }
      }
      while ((match = value.indexOf(prepared.prefix, at)) >= 0) {
        var close = value.indexOf('\uE001', match), index = Number(value.slice(match + prepared.prefix.length, close));
        var token = close >= 0 && prepared.tokens[index];
        if (!token || token.marker !== value.slice(match, close + 1)) break;
        parts.push(visible(value.slice(at, match)));
        if (token.pending) parts.push('<span class="math-fallback">' + visible(token.raw) + '</span>');
        else { found = true; parts.push('<span class="math-source' + (token.display ? ' display' : '') + '" data-tex="' + escapeHTML(token.tex) + '" data-raw="' + escapeHTML(token.raw) + '">' + visible(token.raw) + '</span>'); }
        at = close + 1;
      }
      parts.push(visible(value.slice(at))); var html = parts.join('');
      if (run.bold) html = '<strong>' + html + '</strong>';
      if (run.italic) html = '<em>' + html + '</em>';
      if (run.strike) html = '<s>' + html + '</s>';
      if (run.code) html = '<code>' + html + '</code>';
      if (run.link) html = '<a href="' + escapeHTML(run.link) + '">' + html + '</a>';
      result.push(html);
    }
    return {html: result.join(''), hasMath: found};
  }
  root.OrbisMath = {protect: protect, inlineHTML: inlineHTML};
})(this);
