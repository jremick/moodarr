import type { WatchContext } from "../../shared/types";

export interface PreferenceProfile {
  context: WatchContext;
  label: string;
  weights: {
    query: number;
    semantic: number;
    taste: number;
    preference: number;
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
      query: 0.25,
      semantic: 0.23,
      taste: 0.14,
      preference: 0.08,
      feedback: 0.12,
      availability: 0.07,
      quality: 0.09,
      novelty: 0.02
    },
    maturityTolerance: "normal",
    runtimeSweetSpot: 150
  },
  group: {
    context: "group",
    label: "With someone",
    weights: {
      query: 0.22,
      semantic: 0.2,
      taste: 0.16,
      preference: 0.07,
      feedback: 0.1,
      availability: 0.13,
      quality: 0.08,
      novelty: 0.04
    },
    maturityTolerance: "shared-screen",
    runtimeSweetSpot: 125
  }
};

export function getPreferenceProfile(context: WatchContext | undefined) {
  return preferenceProfiles[context ?? "solo"];
}
