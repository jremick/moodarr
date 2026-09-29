# Rehearsal contract for beta5-upgrade-rollback, copied verbatim from .github/workflows/ci.yml
# (native-source-validation, "Run and validate release-ineligible native rehearsal").
.schema == "moodarr-beta5-upgrade-v1"
and .passed == true and .releaseEligible == false
and .candidate.version == $version and .candidate.revision == $revision
and .candidate.image == $image
and .baseline.version == "0.1.0-beta.5"
and .baseline.revision == "b88179b4290244f7d58bed60695ad4e1aa6032b3"
and .baseline.image == "ghcr.io/jremick/moodarr@sha256:eacfd7ee859810ecf1a9abc30fbe3c504de6d83f8e0dc3c28fcf9b9f164ec6d9"
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
