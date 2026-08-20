/** Pretty-printed JSON with token coloring, built as React elements — no
 * raw HTML path, so response content can never inject markup. */
export function JsonView({ value }: { value: unknown }) {
  const text = (typeof value === "string" ? value : JSON.stringify(value, null, 2)) ?? "";
  const tokens: { cls: string; text: string }[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) tokens.push({ cls: "", text: text.slice(last, m.index) });
    if (m[1]) {
      tokens.push({ cls: m[2] ? "j-key" : "j-str", text: m[1] });
      if (m[2]) tokens.push({ cls: "", text: m[2] });
    } else if (m[0] === "true" || m[0] === "false" || m[0] === "null") {
      tokens.push({ cls: "j-lit", text: m[0] });
    } else {
      tokens.push({ cls: "j-num", text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ cls: "", text: text.slice(last) });
  return (
    <pre className="codeview">
      {tokens.map((t, i) =>
        t.cls ? (
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </pre>
  );
}
