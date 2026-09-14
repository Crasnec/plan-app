import {
  createContext,
  type MutableRefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
export const SettingsContext = createContext<{
  guard: MutableRefObject<() => boolean>;
  setBusy: Dispatch<SetStateAction<boolean>>;
} | null>(null);
