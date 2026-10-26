# Rehearsal contract for beta7-upgrade-rollback, copied verbatim from .github/workflows/ci.yml
# (native-source-validation, "Run and validate release-ineligible native rehearsal").
.schema == "moodarr-beta7-upgrade-v1"
and .passed == true and .releaseEligible == false
and .candidate.version == $version and .candidate.revision == $revision
and .candidate.image == $image
and .baseline.version == "0.1.0-beta.7"
and .baseline.revision == "5bf5ff0588e8e2b577ae867aafcaec9fb3357115"
and .baseline.image == "ghcr.io/jremick/moodarr@sha256:bb11fe60eec6f24ee2243b6bb3b09b0a489c04ee5d971d6d072a8233912248c9"
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
and .incomplete == ["local_image_rehearsal"]
