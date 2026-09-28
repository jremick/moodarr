import { canonicalFacetTerm, claimFacetEvidence, extractDescriptionClaims, extractLiteralDescriptionClaims, isKnownClaimFacet, isSubjectFeelingClaim } from "./claims";
import type { EvidenceClaim, FacetEvidence, ReviewItem } from "./types";

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
  const kind = known && canonical !== "violent" ? "viewing-experience" : "depicted-content";
  let claims: EvidenceClaim[];
  if (kind === "viewing-experience") {
    claims = claimFacetEvidence(item, canonical).claims.filter(claim => claim.provenance.field === "summary");
  } else {
    claims = (known ? extractDescriptionClaims(item, [canonical]) : extractLiteralDescriptionClaims(item, canonical))
      .filter(claim => !isSubjectFeelingClaim(item, claim));
  }
  const polarities = new Set(claims.map(claim => claim.polarity));
  const polarity = polarities.size > 1 || polarities.has("mixed") ? "mixed" : claims[0]?.polarity ?? "unknown";
  return { term: canonical, kind, polarity, source: claims.length ? "description" : undefined, claims };
}
