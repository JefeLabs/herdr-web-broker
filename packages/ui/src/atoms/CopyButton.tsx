import { useState } from "react";

export function CopyButton({ text, title }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost small"
      title={title}
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
