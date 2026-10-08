import { useEffect, useState } from "react";

type HealthState = "loading" | "connected" | "failed";

const healthCopy: Record<HealthState, string> = {
  loading: "Checking backend connection…",
  connected: "Backend connected",
  failed: "Backend unavailable",
};

function App() {
  const [healthState, setHealthState] = useState<HealthState>("loading");
  const [storageState, setStorageState] = useState<{ d1: HealthState; r2: HealthState }>({
    d1: "loading",
    r2: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);

    async function checkHealth() {
      try {
        const response = await fetch("/api/health", { signal });

        if (!response.ok) {
          throw new Error(`Health check returned ${response.status}`);
        }

        const body: unknown = await response.json();
        const isHealthy =
          typeof body === "object" &&
          body !== null &&
          "status" in body &&
          body.status === "ok";

        if (!isHealthy) {
          throw new Error("Health check returned an unexpected response");
        }

        if (!controller.signal.aborted) setHealthState("connected");
      } catch {
        if (!controller.signal.aborted) {
          setHealthState("failed");
        }
      }
    }

    async function checkStorage() {
      try {
        const response = await fetch("/api/storage/status", { signal });
        // A 503 still contains separate results, so one failed component does
        // not hide the other component's successful check.
        if (!response.ok && response.status !== 503) throw new Error("Storage check failed");
        const body: unknown = await response.json();
        const componentState = (name: "d1" | "r2"): HealthState => {
          if (typeof body !== "object" || body === null || !(name in body)) return "failed";
          const component = (body as Record<string, unknown>)[name];
          return typeof component === "object" && component !== null &&
            "status" in component && component.status === "ok"
            ? "connected"
            : "failed";
        };
        if (!controller.signal.aborted) {
          setStorageState({ d1: componentState("d1"), r2: componentState("r2") });
        }
      } catch {
        if (!controller.signal.aborted) setStorageState({ d1: "failed", r2: "failed" });
      }
    }

    void checkHealth();
    void checkStorage();

    return () => controller.abort();
  }, []);

  return (
    <main className="app-shell">
      <section className="welcome" aria-labelledby="app-title">
        <p className="eyebrow">Research workspace</p>
        <h1 id="app-title">AI Research Assistant</h1>
        <div className="statuses" role="status" aria-live="polite">
          <p className="status">
            <span className={`status-dot status-dot--${healthState}`} aria-hidden="true" />
            {healthCopy[healthState]}
          </p>
          {(["d1", "r2"] as const).map((name) => (
            <p className="status" key={name}>
              <span className={`status-dot status-dot--${storageState[name]}`} aria-hidden="true" />
              {name.toUpperCase()} {storageState[name] === "loading" ? "checking…" :
                storageState[name] === "connected" ? "connected" : "unavailable"}
            </p>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
