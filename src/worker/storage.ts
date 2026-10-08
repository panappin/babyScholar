// Generated Env provides the real D1/R2 binding types. Partial allows the status
// endpoint to report missing bindings at runtime instead of throwing.
export type WorkerEnv = Omit<Partial<Env>, "OPENAI_MODEL"> & {
  LOCAL_STORAGE_PROBE?: string;
  LOCAL_INTEGRATION_PROBE?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  ASSETS?: Fetcher;
};

export type ComponentStatus = {
  status: "ok" | "error";
  error?: "binding_missing" | "operation_failed";
};

export interface ProbeRow {
  id: string;
  value: string;
}

export function requireDatabase(env: WorkerEnv): D1Database {
  if (!env.DB) throw new Error("DB binding is missing");
  return env.DB;
}

export function requireBucket(env: WorkerEnv): R2Bucket {
  if (!env.PAPER_BUCKET) throw new Error("PAPER_BUCKET binding is missing");
  return env.PAPER_BUCKET;
}

export async function databaseStatus(env: WorkerEnv): Promise<ComponentStatus> {
  if (!env.DB) return { status: "error", error: "binding_missing" };
  try {
    // A real table read also detects a migration that has not been applied.
    await env.DB.prepare("SELECT id FROM storage_probes LIMIT 1").all();
    return { status: "ok" };
  } catch {
    return { status: "error", error: "operation_failed" };
  }
}

export async function bucketStatus(env: WorkerEnv): Promise<ComponentStatus> {
  if (!env.PAPER_BUCKET) return { status: "error", error: "binding_missing" };
  try {
    await env.PAPER_BUCKET.list({ limit: 1 });
    return { status: "ok" };
  } catch {
    return { status: "error", error: "operation_failed" };
  }
}

export async function insertProbe(env: WorkerEnv, id: string, value: string) {
  await requireDatabase(env)
    .prepare("INSERT INTO storage_probes (id, value) VALUES (?, ?)")
    .bind(id, value)
    .run();
}

export function readProbe(env: WorkerEnv, id: string): Promise<ProbeRow | null> {
  return requireDatabase(env)
    .prepare("SELECT id, value FROM storage_probes WHERE id = ?")
    .bind(id)
    .first<ProbeRow>();
}

export async function deleteProbe(env: WorkerEnv, id: string) {
  await requireDatabase(env)
    .prepare("DELETE FROM storage_probes WHERE id = ?")
    .bind(id)
    .run();
}

export const probeObjectKey = (id: string) => `__storage_probes/${id}.bin`;

export async function putProbeObject(env: WorkerEnv, id: string, bytes: Uint8Array) {
  await requireBucket(env).put(probeObjectKey(id), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
}

export async function readProbeObject(env: WorkerEnv, id: string) {
  const object = await requireBucket(env).get(probeObjectKey(id));
  return object ? Array.from(new Uint8Array(await object.arrayBuffer())) : null;
}

export async function deleteProbeObject(env: WorkerEnv, id: string) {
  await requireBucket(env).delete(probeObjectKey(id));
}
