import type { WatchContext } from "../../shared/types";

export interface PreferenceProfile {
  context: WatchContext;
  label: string;
  weights: {
    query: number;
    semantic: number;
    mood: number;
    reference: number;
    taste: number;
    preference: number;
    feedback: number;
    availability: number;
    quality: number;
    friction: number;
    novelty: number;
    diversity: number;
  };
  maturityTolerance: "normal" | "shared-screen";
  runtimeSweetSpot: number;
}

export const preferenceProfiles: Record<WatchContext, PreferenceProfile> = {
  solo: {
    context: "solo",
    label: "For me",
    weights: {
      query: 0.2,
      semantic: 0.15,
      mood: 0.13,
      reference: 0.08,
      taste: 0.09,
      preference: 0.07,
      feedback: 0.09,
      availability: 0.06,
      quality: 0.06,
      friction: 0.04,
      novelty: 0.02,
      diversity: 0.01
    },
    maturityTolerance: "normal",
    runtimeSweetSpot: 150
  },
  group: {
    context: "group",
    label: "With someone",
    weights: {
      query: 0.16,
      semantic: 0.13,
      mood: 0.14,
      reference: 0.05,
      taste: 0.11,
      preference: 0.05,
      feedback: 0.08,
      availability: 0.11,
      quality: 0.05,
      friction: 0.07,
      novelty: 0.03,
      diversity: 0.02
    },
    maturityTolerance: "shared-screen",
    runtimeSweetSpot: 125
  }
};

export function getPreferenceProfile(context: WatchContext | undefined) {
  return preferenceProfiles[context ?? "solo"];
}
