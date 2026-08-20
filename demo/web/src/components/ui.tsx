import { useState } from "react";

export function MethodChip({ method }: { method: string }) {
  return <span className={`chip ${method.toLowerCase()}`}>{method}</span>;
}

export function AuthBadge({ auth }: { auth: "bearer" | "admin" | "none" }) {
  if (auth === "none") return <span className="chip auth">open</span>;
  if (auth === "admin") return <span className="chip auth admin">admin · loopback</span>;
  return <span className="chip auth">bearer</span>;
}

export function PathTemplate({ template }: { template: string }) {
  const parts = template.split(/(\{[^}]+\})/g);
  return (
    <code className="mono-path">
      {parts.map((p, i) =>
        p.startsWith("{") ? (
          <span key={i} className="var">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </code>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

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

/** Unified-diff / porcelain-status text with per-line coloring. */
export function DiffView({ text }: { text: string }) {
  const cls = (line: string) => {
    if (line.startsWith("+")) return "d-add";
    if (line.startsWith("-")) return "d-del";
    if (line.startsWith("@@")) return "d-hunk";
    if (line.startsWith("diff ") || line.startsWith("index ")) return "d-meta";
    return "";
  };
  return (
    <pre className="codeview">
      {text.split("\n").map((line, i) => (
        <span key={i} className={cls(line)}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export function StatusPill({ status, ok, ms }: { status: number; ok: boolean; ms: number }) {
  return (
    <span className={`status-pill ${ok ? "ok" : "err"}`}>
      {ok ? "▮" : "▯"} {status} · {ms}ms
    </span>
  );
}
