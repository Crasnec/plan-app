import {
  defaultPreferences,
  validPreferences,
  type Preferences,
} from "../shared/preferences.js";
import type { User } from "./store.js";
export function preferences(user: User): Preferences {
  try {
    const value: unknown = JSON.parse(user.preferences || "null");
    return validPreferences(value) ? value : { ...defaultPreferences };
  } catch {
    return { ...defaultPreferences };
  }
}
export function apiDefaults(user: User, input: unknown): unknown {
  const p = preferences(user);
  if (
    !p.applyToApi ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    return input;
  const fields = { ...input } as Record<string, unknown>;
  if (fields.public === undefined) fields.public = p.publicByDefault;
  if (
    fields.end === undefined &&
    fields.kind === "timed" &&
    typeof fields.start === "string"
  ) {
    const end = Date.parse(fields.start) + p.durationMinutes * 60000;
    if (Number.isFinite(end) && Math.abs(end) <= 8.64e15)
      fields.end = new Date(end).toISOString();
  }
  return fields;
}
