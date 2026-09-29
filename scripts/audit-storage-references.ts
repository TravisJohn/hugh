// Read-only S1 census. No object downloads, content, paths or user IDs are
// printed. Uses pagination so a large account cannot hide past the first page.
import { createClient } from "@supabase/supabase-js";
import { loadEnvLocal, requireEnv } from "./lib/env";
import { isOwnedStoragePath } from "../lib/storage/ownership";

loadEnvLocal();
const db = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  for (const [table, column] of [["note_images", "storage_path"], ["monitor_document_versions", "file_path"]] as const) {
    let checked = 0;
    let invalid = 0;
    let offset = 0;
    while (true) {
      const { data, error } = await db.from(table).select(`id, user_id, ${column}`)
        .order("id").range(offset, offset + 499);
      if (error) throw new Error(`Could not complete ${table} census: ${error.code}`);
      const rows = (data ?? []) as unknown as Array<{ user_id: string; storage_path?: unknown; file_path?: unknown }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const path = row[column];
        if (column === "file_path" && path === null) continue;
        checked++;
        if (!isOwnedStoragePath(row.user_id, path)) invalid++;
      }
      offset += rows.length;
    }
    console.log(JSON.stringify({ table, checked, invalid }));
    if (invalid > 0) process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Storage reference census failed");
  process.exitCode = 1;
});
