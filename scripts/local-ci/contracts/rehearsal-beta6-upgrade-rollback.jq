# Rehearsal contract for beta6-upgrade-rollback, copied verbatim from .github/workflows/ci.yml
# (native-source-validation, "Run and validate release-ineligible native rehearsal").
.schema == "moodarr-beta6-upgrade-v1"
and .passed == true and .releaseEligible == false
and .candidate.version == $version and .candidate.revision == $revision
and .candidate.image == $image
and .baseline.version == "0.1.0-beta.6"
and .baseline.revision == "b3bd90ddd47eac1f56700063cf98829696d35e75"
and .baseline.image == "ghcr.io/jremick/moodarr@sha256:04ebff94f39ce82f2ac9159d1d0349a61eb2c07b70eebf92dde6c8d60afb1455"
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
