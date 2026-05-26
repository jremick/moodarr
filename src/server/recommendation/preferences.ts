import type { WatchContext } from "../../shared/types";

export interface PreferenceProfile {
  context: WatchContext;
  label: string;
  weights: {
    query: number;
    taste: number;
    availability: number;
    quality: number;
  };
  maturityTolerance: "normal" | "shared-screen";
  runtimeSweetSpot: number;
}

export const preferenceProfiles: Record<WatchContext, PreferenceProfile> = {
  solo: {
    context: "solo",
    label: "For me",
    weights: {
      query: 0.46,
      taste: 0.22,
      availability: 0.14,
      quality: 0.18
    },
    maturityTolerance: "normal",
    runtimeSweetSpot: 150
  },
  group: {
    context: "group",
    label: "With someone",
    weights: {
      query: 0.4,
      taste: 0.24,
      availability: 0.2,
      quality: 0.16
    },
    maturityTolerance: "shared-screen",
    runtimeSweetSpot: 125
  }
};

export function getPreferenceProfile(context: WatchContext | undefined) {
  return preferenceProfiles[context ?? "solo"];
}
