# Rehearsal contract for beta3-upgrade-rollback, copied verbatim from .github/workflows/ci.yml
# (native-source-validation, "Run and validate release-ineligible native rehearsal").
.schema == "moodarr-beta3-upgrade-v1"
and .passed == true and .releaseEligible == false
and .candidate.version == $version and .candidate.revision == $revision
and .baseline.version == "0.1.0-beta.3"
and .baseline.revision == "85170c8b6359c006754516de347777ea44932c64"
and .baseline.image == "ghcr.io/jremick/moodarr@sha256:515a08bd074ba54eaca53c0a70d8bf23af051fa600d32fee6ddec2aacc6e7e38"
and .platform.native == true
and ([.sourceHashes[]] | length == 4 and all(.[]; test("^[0-9a-f]{64}$")))
and (.archiveSha256 | test("^[0-9a-f]{64}$"))
and (.checks | length) == 7 and (.checks | sort) == $expectedChecks
and .lifecycle.passed == true
and .lifecycle.failures == [] and .lifecycle.incomplete == []
and (.lifecycle.checkCodes | unique | length) == 25
and .lifecycle.counts == {lifecycles: 3, plexItems: 2, seerrItems: 3, searchResults: 1, posterBytes: 68, stubCalls: 35}
and .incomplete == ["local_image_rehearsal"]
