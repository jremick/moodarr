import { canonicalFacetTerm, claimFacetEvidence, extractDescriptionClaims, extractLiteralDescriptionClaims, isKnownClaimFacet, isSubjectFeelingClaim } from "./claims";
import type { EvidenceClaim, FacetEvidence, ReviewItem } from "./types";
import { experienceAspectTerms } from "./evidence";

// These roles concern what is depicted, independently of affect vocabulary
// membership. A felt grief theme need not imply a sad viewing experience.
const depictedRoles = new Map<string, "theme" | "setting" | "event">([
  ...["friendship", "family", "grief", "identity", "revenge", "discovery"].map(term => [term, "theme"] as const),
  ...experienceAspectTerms.setting.map(term => [term, "setting"] as const),
  ["violent", "event"]
]);

export interface ExplicitContentConstraintEvidence {
  term: string;
  kind: "depicted-content" | "viewing-experience";
  polarity: FacetEvidence["polarity"];
  source?: "description";
  claims: EvidenceClaim[];
}

/**
 * Explicit prohibitions may name content outside the affect ontology. Literal
 * support is confined to this channel: it cannot create positive mood evidence.
 * Mixed depicted content still contains an affirmative prohibited occurrence;
 * mixed viewing tone remains unresolved. A genre or title is never an assertion.
 */
export function explicitContentConstraintEvidence(item: Pick<ReviewItem, "id" | "summary" | "genres">, term: string): ExplicitContentConstraintEvidence {
  const canonical = canonicalFacetTerm(term);
  const known = isKnownClaimFacet(canonical);
  const role = depictedRoles.get(canonical);
  const kind = known && !role ? "viewing-experience" : "depicted-content";
  let claims: EvidenceClaim[];
  if (kind === "viewing-experience") {
    claims = claimFacetEvidence(item, canonical).claims.filter(claim => claim.provenance.field === "summary");
  } else {
    claims = (known ? extractDescriptionClaims(item, [canonical]) : extractLiteralDescriptionClaims(item, canonical))
      .filter(claim => role === "theme" || !isSubjectFeelingClaim(item, claim));
  }
  const polarities = new Set(claims.map(claim => claim.polarity));
  // Unknown plus absence supplies no affirmative occurrence. Keep that distinct
  // from mixed content containing presence, which remains an explicit conflict.
  const unresolvedWithoutPresence = kind === "depicted-content" && polarities.has("unknown")
    && !polarities.has("positive") && !polarities.has("mixed");
  const polarity = unresolvedWithoutPresence ? "unknown"
    : polarities.size > 1 || polarities.has("mixed") ? "mixed" : claims[0]?.polarity ?? "unknown";
  return { term: canonical, kind, polarity, source: claims.length ? "description" : undefined, claims };
}
