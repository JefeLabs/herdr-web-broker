/** Unified-diff / status text with per-line coloring. */
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
