import type { WatchContext } from "../../shared/types";

export interface PreferenceProfile {
  context: WatchContext;
  label: string;
  weights: {
    query: number;
    semantic: number;
    taste: number;
    feedback: number;
    availability: number;
    quality: number;
    novelty: number;
  };
  maturityTolerance: "normal" | "shared-screen";
  runtimeSweetSpot: number;
}

export const preferenceProfiles: Record<WatchContext, PreferenceProfile> = {
  solo: {
    context: "solo",
    label: "For me",
    weights: {
      query: 0.28,
      semantic: 0.24,
      taste: 0.16,
      feedback: 0.12,
      availability: 0.08,
      quality: 0.1,
      novelty: 0.02
    },
    maturityTolerance: "normal",
    runtimeSweetSpot: 150
  },
  group: {
    context: "group",
    label: "With someone",
    weights: {
      query: 0.24,
      semantic: 0.2,
      taste: 0.18,
      feedback: 0.1,
      availability: 0.14,
      quality: 0.1,
      novelty: 0.04
    },
    maturityTolerance: "shared-screen",
    runtimeSweetSpot: 125
  }
};

export function getPreferenceProfile(context: WatchContext | undefined) {
  return preferenceProfiles[context ?? "solo"];
}
