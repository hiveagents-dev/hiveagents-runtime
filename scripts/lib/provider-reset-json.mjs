// Research input only. Duplicate keys and excessive nesting must not manufacture evidence.
export function parseCaptureJson(text) {
  let at = 0, nodes = 0;
  const fail = () => { throw new Error('Capture refused: invalid JSONL'); };
  const space = () => { while (/[\x20\t\r\n]/.test(text[at] ?? 'x')) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') at++;
      else if (c === '"') {
        try { return JSON.parse(text.slice(start, at)); } catch { fail(); }
      }
    }
    fail();
  }
  function value(depth) {
    if (++nodes > 16_384 || depth > 16) fail();
    space();
    const c = text[at];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      at++; space();
      const object = c === '{', result = object ? Object.create(null) : [], keys = new Set();
      const end = object ? '}' : ']';
      if (text[at] === end) { at++; return result; }
      while (at < text.length) {
        let key;
        if (object) {
          if (text[at] !== '"') fail();
          key = string(); if (keys.has(key)) fail(); keys.add(key); space();
          if (text[at++] !== ':') fail();
        }
        const item = value(depth + 1);
        if (object) result[key] = item; else result.push(item);
        space(); if (text[at] === end) { at++; return result; }
        if (text[at++] !== ',') fail(); space();
      }
      fail();
    }
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, at)) { at += word.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (!number) fail();
    at += number[0].length;
    const result = Number(number[0]); if (!Number.isFinite(result)) fail(); return result;
  }
  const result = value(1); space(); if (at !== text.length) fail(); return result;
}
