# Rehearsal contract for beta2-upgrade-rollback, copied verbatim from .github/workflows/ci.yml
# (native-source-validation, "Run and validate release-ineligible native rehearsal").
.schema == "moodarr-beta2-upgrade-v1"
and .passed == true and .releaseEligible == false
and .candidate.version == $version and .candidate.revision == $revision
and .baseline.version == "0.1.0-beta.2"
and .baseline.revision == "4522fa3feb2af393dcf15893b94b961f212752d6"
and .baseline.image == "ghcr.io/jremick/moodarr@sha256:37419c5994a6e0b19cc398fa0bd8aa5a4faa151ae0eed1d10056913ee0d3e891"
and .platform.native == true
and ([.sourceHashes[]] | length == 4 and all(.[]; test("^[0-9a-f]{64}$")))
and (.archiveSha256 | test("^[0-9a-f]{64}$"))
and (.checks | length) == 7 and (.checks | sort) == $expectedChecks
and .lifecycle.passed == true
and .lifecycle.failures == [] and .lifecycle.incomplete == []
and (.lifecycle.checkCodes | unique | length) == 25
and .lifecycle.counts == {lifecycles: 3, plexItems: 2, seerrItems: 3, searchResults: 1, posterBytes: 68, stubCalls: 35}
and .incomplete == ["local_image_rehearsal"]
