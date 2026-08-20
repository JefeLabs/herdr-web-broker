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
