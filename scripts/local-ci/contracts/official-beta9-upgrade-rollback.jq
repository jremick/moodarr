# Official contract for beta9-upgrade-rollback, copied verbatim from .github/workflows/validate-beta-candidate.yml
# (upgrade-rollback, "Validate direct beta.9 upgrade and cold rollback").
.schema == "moodarr-beta9-upgrade-v1"
and .passed == true and .releaseEligible == true
and .candidate.version == $version and .candidate.revision == $revision
and .candidate.image == $image
and .baseline.version == "0.1.0-beta.9"
and .baseline.revision == "9d2ca6c40808b0b2c642d035e6020e20691233fd"
and .baseline.image == "ghcr.io/jremick/moodarr@sha256:096d366f43c225231fe85f5c4028984bf2153890dbfc076ce97a5ce74eb0ba23"
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
