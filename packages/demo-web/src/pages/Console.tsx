import { useId, useState } from "react";
import { CATALOG, GROUPS } from "../api/catalog";
import { EndpointCard } from "../components/EndpointCard";
import { EventsPanel } from "@jefelabs/herdr-broker-ui";
import { ContextUploadCard } from "../components/ContextUploadCard";
import { useSettings } from "../settings";

const RAIL = [...GROUPS, "Live Events"];

export function Console() {
  const settings = useSettings();
  const [active, setActive] = useState<string>(RAIL[0]);

  return (
    <div className="page">
      <SettingsStrip />
      <div className="console-grid">
        <nav className="rail" aria-label="endpoint groups">
          {RAIL.map((g) => (
            <a
              key={g}
              href={`#/console`}
              className={g === active ? "active" : ""}
              onClick={(e) => {
                e.preventDefault();
                setActive(g);
                document.getElementById(`group-${g}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {g}
            </a>
          ))}
        </nav>
        <main>
          {GROUPS.map((g) => (
            <section key={g}>
              <h2 className="group-title" id={`group-${g}`}>
                {g}
              </h2>
              {g === "Context" && <ContextUploadCard />}
              {CATALOG.filter((s) => s.group === g).map((s) => (
                <EndpointCard key={s.id} spec={s} />
              ))}
            </section>
          ))}
          <section>
            <h2 className="group-title" id="group-Live Events">
              Live Events
            </h2>
            <EventsPanel broker={settings.broker} instance={settings.instance} session={settings.session} />
          </section>
          {settings.instances.length === 0 && (
            <p className="note">
              No instances loaded yet — check the token above, then hit refresh. The broker must be reachable at
              the proxy target.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}

function SettingsStrip() {
  const s = useSettings();
  return (
    <div className="settings-strip">
      <label className="field">
        <span>bearer token</span>
        <input value={s.bearer} onChange={(e) => s.set("bearer", e.target.value)} placeholder="demo-token" />
      </label>
      <label className="field">
        <span>admin token</span>
        <input value={s.admin} onChange={(e) => s.set("admin", e.target.value)} placeholder="state-dir admin token" />
      </label>
      <label className="field">
        <span>instance</span>
        <ComboInput value={s.instance} options={s.instances} onChange={(v) => s.set("instance", v)} />
      </label>
      <label className="field">
        <span>session</span>
        <ComboInput value={s.session} options={s.sessions} onChange={(v) => s.set("session", v)} />
      </label>
      <button className="btn ghost" onClick={() => void s.refresh().catch(() => undefined)}>
        refresh
      </button>
    </div>
  );
}

/** free-text input with datalist suggestions — pickers stay usable before
 * the first successful /parent fetch */
function ComboInput({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <>
      <input list={id} value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id={id}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}
