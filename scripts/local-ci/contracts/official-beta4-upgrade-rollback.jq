# Official contract for beta4-upgrade-rollback, copied verbatim from .github/workflows/validate-beta-candidate.yml
# (upgrade-rollback, "Validate direct beta.4 upgrade and cold rollback").
.schema == "moodarr-beta4-upgrade-v1"
and .passed == true and .releaseEligible == true
and .candidate.version == $version and .candidate.revision == $revision
and .candidate.image == $image
and .baseline.version == "0.1.0-beta.4"
and .baseline.revision == "b0d746260cbe89478e85f1225f109403512336d8"
and .baseline.image == "ghcr.io/jremick/moodarr@sha256:aa1f8a1b72344769f2ca649fa9ff44d6f1894237012781135f48ddf7cc618e51"
and .platform.native == true
and ([.sourceHashes[]] | length == 4 and all(.[]; test("^[0-9a-f]{64}$")))
and (.archiveSha256 | test("^[0-9a-f]{64}$"))
and (.checks | length) == 7 and (.checks | sort) == $expectedChecks
and .lifecycle.passed == true
and .lifecycle.failures == [] and .lifecycle.incomplete == []
and (.lifecycle.checkCodes | length) == 25
and (.lifecycle.checkCodes | unique | length) == 25
and (.lifecycle.checkCodes | sort) == $expectedLifecycleChecks
and .lifecycle.counts == {lifecycles: 3, plexItems: 2, seerrItems: 3, searchResults: 1, posterBytes: 68, stubCalls: 35}
and .incomplete == []
