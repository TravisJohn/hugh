import { describe, it, expect } from "vitest";
import {
  isProvisioned,
  PROVISIONING_COLUMN,
  PROVISIONING_COLUMNS,
  type ProvisionedSurface,
} from "./provisioning";

/**
 * These tests exist because this decides whether Hugh accepts a stranger's
 * résumé or screenshots at all. Every case below names the way it could fail
 * open, because failing open here means the privacy policy is wrong rather
 * than a feature being unavailable.
 */

describe("isProvisioned", () => {
  it("grants a surface only when its own flag is true", () => {
    const flags = { notes_enabled: true, monitor_docs_enabled: false, approved: true, is_blocked: false };

    expect(isProvisioned(flags, "notes")).toBe(true);
    // Two flags, not one: opening screenshots must not open résumés.
    expect(isProvisioned(flags, "monitorDocs")).toBe(false);
  });

  it("refuses when the profile is missing entirely", () => {
    // A dropped or absent profile read must not read as permission.
    expect(isProvisioned(null,      "notes")).toBe(false);
    expect(isProvisioned(undefined, "monitorDocs")).toBe(false);
  });

  it("refuses when the column is absent, which is the pre-migration case", () => {
    // Code can legitimately ship ahead of a hand-applied migration (050 is
    // forward-only, applied in the dashboard). Until then the column does not
    // exist and reads back undefined — that must mean "off", not "on".
    expect(isProvisioned({}, "notes")).toBe(false);
    expect(isProvisioned({}, "monitorDocs")).toBe(false);
  });

  it("refuses a null column rather than treating it as unset-and-allowed", () => {
    expect(isProvisioned({ notes_enabled: null, approved: true, is_blocked: false }, "notes")).toBe(false);
  });

  it("revokes both surfaces for a still-provisioned blocked session", () => {
    const flags = { notes_enabled: true, monitor_docs_enabled: true, approved: true, is_blocked: true };
    expect(isProvisioned(flags, "notes")).toBe(false);
    expect(isProvisioned(flags, "monitorDocs")).toBe(false);
  });

  it("refuses an unapproved account even when both flags remain on", () => {
    const flags = { notes_enabled: true, monitor_docs_enabled: true, approved: false, is_blocked: false };
    expect(isProvisioned(flags, "notes")).toBe(false);
    expect(isProvisioned(flags, "monitorDocs")).toBe(false);
  });

  it("does not special-case an admin, because the database does not either", () => {
    // Migration 050 backfills admins to true rather than adding a bypass to the
    // policies. If this layer bypassed and RLS did not, an admin would be shown
    // a surface the database then refuses — the worst of both.
    const adminWithoutFlags = { is_admin: true } as unknown as Parameters<typeof isProvisioned>[0];
    expect(isProvisioned(adminWithoutFlags, "notes")).toBe(false);
  });
});

describe("the surface→column mapping", () => {
  it("covers every surface, so a new one cannot silently read as false", () => {
    const surfaces: ProvisionedSurface[] = ["notes", "monitorDocs"];
    for (const s of surfaces) {
      expect(PROVISIONING_COLUMN[s]).toBeTruthy();
    }
  });

  it("selects exactly the columns it maps to", () => {
    // Guards the pairing that would otherwise drift: asking Supabase for one
    // set of columns while reading another yields a permanent, silent `false`.
    for (const column of Object.values(PROVISIONING_COLUMN)) {
      expect(PROVISIONING_COLUMNS).toContain(column);
    }
  });
});
