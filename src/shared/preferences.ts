export interface Preferences {
  durationMinutes: number;
  showCompleted: boolean;
  publicByDefault: boolean;
  applyToApi: boolean;
}
export const defaultPreferences: Preferences = {
  durationMinutes: 60,
  showCompleted: true,
  publicByDefault: false,
  applyToApi: false,
};
export function validPreferences(value: unknown): value is Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Preferences;
  return (
    Object.keys(p).length === 4 &&
    Number.isInteger(p.durationMinutes) &&
    p.durationMinutes >= 5 &&
    p.durationMinutes <= 1440 &&
    typeof p.showCompleted === "boolean" &&
    typeof p.publicByDefault === "boolean" &&
    typeof p.applyToApi === "boolean"
  );
}
