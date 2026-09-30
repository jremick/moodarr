# Official contract for beta2-upgrade-rollback. validate-beta-candidate.yml accepted this report on
# exit 0 alone; the local gate applies the same complete contract the workflow applies to beta.4 and beta.5.
.schema == "moodarr-beta2-upgrade-v1"
and .passed == true and .releaseEligible == true
and .candidate.version == $version and .candidate.revision == $revision
and .candidate.image == $image
and .baseline.version == "0.1.0-beta.2"
and .baseline.revision == "4522fa3feb2af393dcf15893b94b961f212752d6"
and .baseline.image == "ghcr.io/jremick/moodarr@sha256:37419c5994a6e0b19cc398fa0bd8aa5a4faa151ae0eed1d10056913ee0d3e891"
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
